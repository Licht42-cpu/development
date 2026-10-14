#!/usr/bin/env python3
"""Audit a local debug APK against committed source. Never installs or publishes."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def audit():
    checks = []
    def require(name, condition):
        checks.append({'name': name, 'status': 'PASS' if condition else 'FAIL'})
    package = json.loads((ROOT / 'package.json').read_text())
    lock = json.loads((ROOT / 'package-lock.json').read_text())
    versions = {}
    for kind in ['dependencies', 'devDependencies']:
        require(kind + ' match lock root', package[kind] == lock['packages'][''].get(kind))
        for name, version in package[kind].items():
            installed = json.loads((ROOT / 'node_modules' / name / 'package.json').read_text())['version']
            locked = lock['packages']['node_modules/' + name]['version']
            versions[name] = {'declared': version, 'locked': locked, 'installed': installed}
            require(name + ' exact version', bool(re.fullmatch(r'\d+\.\d+\.\d+', version)) and version == locked == installed)
    spec = importlib.util.spec_from_file_location('qualification', ROOT / 'scripts/field-qualification.py')
    q = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(q)
    inventory = q.inventory('Owner Batch 15.2 assignment; local qualification only')
    require('committed unchanged Claude snapshot', inventory['candidate']['claude_snapshot']['verified'])
    require('staged inputs bound to candidate commit', inventory['apk']['asset_binding']['assets_match_commit'])
    require('APK bytes match every staged file', inventory['apk']['asset_binding']['apk_matches_staging'])
    sdk = Path(inventory['environment']['android_doctor']['sdk_root'])
    apk = ROOT / 'android/app/build/outputs/apk/debug/app-debug.apk'
    result = subprocess.run([str(sdk / 'build-tools/35.0.0/aapt'), 'dump', 'badging', str(apk)], capture_output=True, text=True)
    require('compiled manifest inspection', result.returncode == 0)
    text = result.stdout
    identity = re.search(r"package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", text)
    config = json.loads((ROOT / 'capacitor.config.json').read_text())
    gradle = (ROOT / 'android/app/build.gradle').read_text()
    version_code = re.search(r'versionCode\s+(\d+)', gradle)[1]
    version_name = re.search(r'versionName\s+"([^"]+)"', gradle)[1]
    require('packaged app ID and version match project', identity is not None and identity.groups() == (config['appId'], version_code, version_name))
    permissions = sorted(set(re.findall(r"uses-permission(?:-sdk-\d+)?: name='([^']+)'", text)))
    approved = sorted('android.permission.' + name for name in ['INTERNET', 'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'VIBRATE'])
    require('compiled permission set matches reviewed foreground-only set', permissions == approved)
    with zipfile.ZipFile(apk) as archive:
        staged = {p.relative_to(ROOT / 'mobile/www').as_posix() for p in (ROOT / 'mobile/www').rglob('*') if p.is_file()}
        packaged = {p.removeprefix('assets/public/') for p in archive.namelist() if p.startswith('assets/public/') and not p.endswith('/')}
        extras = packaged - staged
        require('only known Cordova compatibility files added', extras == {'cordova.js', 'cordova_plugins.js'})
        require('compiled native artifacts present', all(len(archive.read(n)) > 0 for n in ['AndroidManifest.xml', 'classes.dex', 'resources.arsc']))
    return {'proof': 'Local debug artifact audit, not installation, delivery, authorization or physical-device proof.',
            'candidate': inventory['candidate'], 'checks': checks, 'dependency_versions': versions,
            'version': {'application_id': config['appId'], 'version_code': version_code, 'version_name': version_name,
                        'npm_version': package['version'], 'min_sdk': re.findall(r"sdkVersion:'([^']+)'", text), 'target_sdk': re.findall(r"targetSdkVersion:'([^']+)'", text)},
            'permissions': permissions, 'staged_file_count': len(staged), 'packaged_web_file_count': len(packaged),
            'apk_sha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'apk_bytes': apk.stat().st_size,
            'asset_binding': inventory['apk']['asset_binding'], 'publication': 'none'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    report = audit()
    body = json.dumps(report, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(body)
    print(body)
    raise SystemExit(1 if any(c['status'] == 'FAIL' for c in report['checks']) else 0)
