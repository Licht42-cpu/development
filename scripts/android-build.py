#!/usr/bin/env python3
"""Linux Android qualification setup/build; preserves the configured proxy and TLS.

Setup requires explicit license acceptance. Build deliberately does NOT sync:
the existing preBuild guard must reject stale assets rather than repair them.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import subprocess
import sys
import tarfile
import time
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET
import zipfile

REPO = Path(__file__).resolve().parent.parent
TOOLS_ARCHIVE = 'commandlinetools-linux-13114758_latest.zip'
TOOLS_SHA1 = '5fdcc763663eefb86a5b8879697aa6088b041e70'
TOOLS_VERSION = '19.0'
PACKAGES = ['platforms;android-36', 'build-tools;35.0.0', 'platform-tools']
JDK_VERSION = '21.0.12.1+1'
JDK_ARCHIVE = 'OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz'
JDK_SHA256 = 'ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94'


def environment(state, sdk, java_home, truststore):
    env = os.environ.copy()
    env['ANDROID_HOME'] = str(sdk)
    env['ANDROID_SDK_ROOT'] = str(sdk)
    if java_home:
        env['JAVA_HOME'] = str(java_home)
        env['PATH'] = str(java_home / 'bin') + os.pathsep + env['PATH']
    env.setdefault('ANDROID_USER_HOME', str(state / 'android-user'))
    env.setdefault('GRADLE_USER_HOME', str(state / 'gradle-cache'))
    for name in ['ANDROID_USER_HOME', 'GRADLE_USER_HOME']:
        Path(env[name]).mkdir(parents=True, exist_ok=True)
    # Java does not automatically use the shell's HTTP(S)_PROXY. Route Java
    # through the same proxy; never unset it or weaken certificate validation.
    flags = []
    if truststore:
        if not truststore.is_file():
            raise ValueError('Java truststore does not exist.')
        flags.append(f'-Djavax.net.ssl.trustStore={truststore}')
    for protocol in ['http', 'https']:
        value = env.get(protocol.upper() + '_PROXY') or env.get(protocol + '_proxy')
        if value:
            proxy = urlsplit(value)
            if proxy.scheme != 'http' or not proxy.hostname or proxy.username or proxy.password:
                raise ValueError('Java setup supports a credential-free HTTP CONNECT proxy only; '
                                 'use your supported Java proxy configuration for other proxies.')
            flags.extend([f'-D{protocol}.proxyHost={proxy.hostname}',
                          f'-D{protocol}.proxyPort={proxy.port or 80}'])
    if flags:
        env['JAVA_TOOL_OPTIONS'] = (env.get('JAVA_TOOL_OPTIONS', '') + ' ' +
                                    ' '.join(shlex.quote(f) for f in flags)).strip()
    return env


def run(args, env, cwd=REPO, **kwargs):
    start = time.monotonic()
    result = subprocess.run(args, env=env, cwd=cwd, **kwargs)
    print(f'Completed {Path(args[0]).name}: exit {result.returncode}, '
          f'{time.monotonic() - start:.2f}s', flush=True)
    result.check_returncode()


def tool_version(command, env, pattern):
    try:
        result = subprocess.run(command, capture_output=True, text=True, env=env)
    except FileNotFoundError:
        return None
    match = re.search(pattern, result.stdout + result.stderr)
    return int(match[1]) if result.returncode == 0 and match else None


def diagnose(sdk, env):
    java = tool_version(['java', '-version'], env, r'version "(\d+)')
    compiler = tool_version(['javac', '-version'], env, r'javac (\d+)')
    selected_home = env.get('JAVA_HOME')
    home_has_compiler = not selected_home or (Path(selected_home) / 'bin/javac').is_file()
    required = ['platforms/android-36/android.jar', 'build-tools/35.0.0/aapt2',
                'platform-tools/adb', 'licenses/android-sdk-license']
    missing = [file for file in required if not (sdk / file).is_file()]
    # adb 37 ignores ANDROID_USER_HOME. Do not repurpose HOME or start its
    # server in a read-only home: even `adb version` otherwise aborts.
    adb_dir = Path.home() / '.android'
    adb_ready = adb_dir.is_dir() and os.access(adb_dir, os.W_OK)
    guard = subprocess.run(['node', 'scripts/verify-mobile.js', '--android'],
                           cwd=REPO, env=env, capture_output=True, text=True)
    report = {
        'java_major': java, 'javac_major': compiler,
        'selected_java_home': selected_home, 'java_home_has_compiler': home_has_compiler,
        'sdk_root': str(sdk), 'missing_sdk_files': missing,
        'staged_assets_current': guard.returncode == 0,
        'asset_guard_result': (guard.stdout + guard.stderr).strip(),
        'build_prerequisites_ready': bool(java and java >= 21 and compiler and
                                         compiler >= 21 and home_has_compiler and not missing and guard.returncode == 0),
        'adb_configuration_directory': str(adb_dir),
        'adb_configuration_writable': adb_ready,
        'adb_blocker': None if adb_ready else 'adb requires a writable .android directory in the real home; HOME is preserved',
        'emulator_available': (sdk / 'emulator/emulator').is_file(),
        'device_validation': 'unrun; diagnostics do not install or launch an app',
    }
    print(json.dumps(report, indent=2))
    return report


def setup(state, sdk, env):
    if platform.system() != 'Linux' or platform.machine() not in ['x86_64', 'amd64']:
        raise ValueError('This SDK bootstrap is qualified for Linux x86_64 only.')
    downloads = state / 'android-downloads'
    downloads.mkdir(parents=True, exist_ok=True)
    manager = sdk / 'cmdline-tools' / TOOLS_VERSION / 'bin' / 'sdkmanager'
    if not manager.exists():
        metadata = downloads / 'repository.xml'
        run(['curl', '--fail', '--location', '--silent', '--show-error', '--max-time', '180',
             'https://dl.google.com/android/repository/repository2-1.xml', '-o', str(metadata)], env)
        matches = []
        for package in ET.parse(metadata).getroot().iter('remotePackage'):
            if package.get('path') == f'cmdline-tools;{TOOLS_VERSION}':
                for archive in package.iter('archive'):
                    if archive.findtext('host-os') == 'linux' and archive.findtext('complete/url') == TOOLS_ARCHIVE:
                        matches.append(archive.findtext('complete/checksum'))
        if matches != [TOOLS_SHA1]:
            raise ValueError('Official SDK metadata does not match the pinned command-line tools checksum.')
        archive_path = downloads / TOOLS_ARCHIVE
        run(['curl', '--fail', '--location', '--silent', '--show-error', '--max-time', '180',
             'https://dl.google.com/android/repository/' + TOOLS_ARCHIVE, '-o', str(archive_path)], env)
        if hashlib.sha1(archive_path.read_bytes()).hexdigest() != TOOLS_SHA1:
            raise ValueError('SDK archive checksum mismatch; refusing to execute it.')
        destination = sdk / 'cmdline-tools' / TOOLS_VERSION
        with zipfile.ZipFile(archive_path) as archive:
            for entry in archive.infolist():
                path = Path(entry.filename)
                if path.is_absolute() or '..' in path.parts or path.parts[0] != 'cmdline-tools':
                    raise ValueError('Unexpected SDK archive path.')
                target = destination.joinpath(*path.parts[1:])
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(entry))
        for executable in (destination / 'bin').iterdir():
            executable.chmod(0o755)
    run([str(manager), f'--sdk_root={sdk}', '--licenses'], env, input='y\n' * 100, text=True)
    run([str(manager), f'--sdk_root={sdk}', *PACKAGES], env)
    # sdkmanager can print "all licenses accepted" after failing to fetch its
    # manifests. Verify actual installed packages instead of trusting that line.
    for required in ['platforms/android-36/android.jar', 'build-tools/35.0.0/aapt2',
                     'platform-tools/adb', 'licenses/android-sdk-license']:
        if not (sdk / required).is_file():
            raise ValueError('SDK setup incomplete: missing ' + required)
    run(['./gradlew', '--version'], env, REPO / 'android')


def bootstrap_jdk(state):
    if platform.system() != 'Linux' or platform.machine() not in ['x86_64', 'amd64']:
        raise ValueError('Pinned JDK bootstrap supports Linux x86_64 only.')
    downloads = state / 'android-downloads'
    downloads.mkdir(parents=True, exist_ok=True)
    archive = downloads / JDK_ARCHIVE
    url = ('https://github.com/adoptium/temurin21-binaries/releases/download/'
           'jdk-21.0.12.1%2B1/' + JDK_ARCHIVE)
    run(['curl', '--fail', '--location', '--silent', '--show-error', '--max-time', '180',
         url, '-o', str(archive)], os.environ.copy())
    if hashlib.sha256(archive.read_bytes()).hexdigest() != JDK_SHA256:
        raise ValueError('Pinned JDK SHA256 mismatch; refusing to execute it.')
    destination = state / 'jdk'
    with tarfile.open(archive) as tar:
        tar.extractall(destination, filter='data')
    return destination / ('jdk-' + JDK_VERSION)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['setup', 'build', 'gradle', 'doctor', 'adb'])
    parser.add_argument('--state-dir', type=Path, default=REPO.parent / '.nova-shield')
    parser.add_argument('--sdk-root', type=Path)
    parser.add_argument('--java-home', type=Path)
    parser.add_argument('--java-truststore', type=Path,
                        help='Existing trusted Java CA store; certificate verification stays enabled')
    parser.add_argument('--accept-licenses', action='store_true')
    parser.add_argument('--offline', action='store_true', help='Use only cached Gradle dependencies')
    parser.add_argument('tasks', nargs='*', help='Gradle tasks, or adb arguments after --')
    args = parser.parse_args()
    state = args.state_dir.resolve()
    sdk = (args.sdk_root or Path(os.environ.get('ANDROID_HOME') or
                                os.environ.get('ANDROID_SDK_ROOT') or
                                state / 'android-sdk')).resolve()
    if args.action == 'setup' and not args.accept_licenses:
        parser.error('setup requires --accept-licenses to accept the Android SDK licenses')
    cached_java = state / 'jdk' / ('jdk-' + JDK_VERSION)
    java_home = args.java_home or (Path(os.environ['JAVA_HOME']) if os.environ.get('JAVA_HOME')
                                  else cached_java if cached_java.exists() else None)
    # A Java runtime alone cannot compile Android. Setup installs the pinned
    # JDK when no compiler exists; build fails honestly instead of installing.
    if args.action == 'setup' and not args.java_home:
        candidate_env = os.environ.copy()
        if java_home:
            candidate_env['PATH'] = str(java_home / 'bin') + os.pathsep + candidate_env['PATH']
        major = (None if java_home and not (java_home / 'bin/javac').is_file() else
                 tool_version(['javac', '-version'], candidate_env, r'javac (\d+)'))
        if not major or major < 21:
            java_home = cached_java if (cached_java / 'bin/javac').is_file() else bootstrap_jdk(state)
    truststore = args.java_truststore
    system_store = Path('/etc/ssl/certs/java/cacerts')
    if truststore is None and java_home == cached_java and system_store.is_file():
        truststore = system_store
    env = environment(state, sdk, java_home, truststore)
    if args.action == 'doctor':
        report = diagnose(sdk, env)
        if not report['build_prerequisites_ready']:
            sys.exit(1)
        return
    if args.action == 'adb':
        adb = sdk / 'platform-tools/adb'
        if not adb.is_file():
            raise ValueError('Android platform-tools are missing; run setup first.')
        adb_dir = Path.home() / '.android'
        if not adb_dir.is_dir() or not os.access(adb_dir, os.W_OK):
            raise ValueError(f'adb requires writable {adb_dir}; this host may mount home read-only. '
                             'Provide that directory on a writable host. HOME will not be overridden.')
        run([str(adb), *(args.tasks or ['version'])], env)
        return
    if java_home and not all((java_home / 'bin' / tool).is_file() for tool in ['java', 'javac']):
        raise ValueError('Selected Java home is not a full JDK; supply --java-home with java and javac 21 or newer.')
    java = subprocess.run(['java', '-version'], capture_output=True, text=True, env=env)
    version = re.search(r'version "(\d+)', java.stderr)
    if java.returncode or not version or int(version[1]) < 21:
        raise ValueError('Java 21 or newer is required by the pinned Capacitor project.')
    try:
        compiler = subprocess.run(['javac', '-version'], capture_output=True, text=True, env=env)
    except FileNotFoundError:
        raise ValueError('Java is a runtime without javac; run setup or supply --java-home with a JDK.')
    compiler_version = re.search(r'javac (\d+)', compiler.stdout + compiler.stderr)
    if compiler.returncode or not compiler_version or int(compiler_version[1]) < 21:
        raise ValueError('A JDK with javac 21 or newer is required.')
    if args.action == 'setup':
        setup(state, sdk, env)
    else:
        if not (sdk / 'platforms/android-36/android.jar').exists():
            raise ValueError('Android API 36 is missing; run setup first.')
        tasks = [':app:assembleDebug'] if args.action == 'build' else args.tasks
        if not tasks:
            parser.error('gradle requires at least one task')
        run(['./gradlew', *tasks, *(['--offline'] if args.offline else []),
             '--no-daemon', '--console=plain', '--max-workers=2'],
            env, REPO / 'android')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
