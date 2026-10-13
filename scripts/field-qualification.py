#!/usr/bin/env python3
"""Read-only qualification inventory and manual evidence validation.

Does not install APKs, start adb/emulators, merge branches or contact a backend.
Validation checks a record's consistency, not whether its operator is truthful.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
import zipfile
from pathlib import Path
import re
import subprocess
import sys

REPO = Path(__file__).resolve().parents[1]
REQUIRED_CODEX = 'a0b87cdbc949611dfa1597abbdecaa23f1b3a9b1'
REQUIRED_CLAUDE = 'b21d082'
SNAPSHOT_MANIFEST = 'codex-files/handoffs/integration-source.json'
SNAPSHOT_REQUIRED = {
    'admin/js/lib/api.js', 'admin/js/views/inventory.js',
    *('admin/js/components/' + name + '.js' for name in
      ['dispatch-day', 'property-access', 'customer-handover', 'load-plan', 'seasonal-sets', 'kit-sheets']),
    *('docs/' + name + '-contract-v1.md' for name in
      ['operations', 'seasonal-sets', 'daily-load', 'completion-evidence', 'dispatch', 'customer-handover', 'permanent-lighting-materials']),
}
CASES = {
    'single_crew_day': 'Base → Car A checked load → assigned work → accepted completion → day-end count',
    'two_car_scope': 'Separate Car A/B actors, scarce shared tools, unassigned work and denial retirement',
    'startup_recovery': 'Cold start, missing asset recovery and unsent-byte preservation',
    'back_keyboard': 'Hardware/gesture Back, keyboard, review cancellation and overlay focus',
    'cached_restart': 'Prepare work, offline process death/restart, expiry and reconnect',
    'camera_originals': 'Camera/cancel/actual permission prompts, original bytes and interrupted upload',
    'storage_pressure': 'Quota/eviction and unsupported store upgrade without silent loss',
    'share_uri': 'Real Android share sheet, cancelled handoff and private FileProvider URI access',
    'location_states': 'Denied/approximate/missing/stale location, explicit local arrival and unknown metadata',
    'talkback': 'Actual TalkBack traversal of loading, instructions, issues, photos and completion',
    'bad_cellular': 'Real transport delay/drop/lost response and original-key recovery',
    'offline_sync': 'Provisional finish, reconnect and one accepted receipt without double effects',
    'upgrade_replay': 'Existing outbox formats, downgrade refusal and payload/Blob retention',
    'account_separation': 'Sign-out/switch/revocation, private reads and original-account pending actions',
    'closing_accounting': 'Live usable basis, estimate/damaged/level semantics and no duplicate job debit',
    'frozen_history': 'Accepted completion/evidence and quote freeze; corrections remain attributable',
}
STATUSES = {'PASS', 'FAIL', 'SKIPPED', 'EXPECTED_FAILURE', 'UNRUN'}


def git(*args):
    return subprocess.check_output(['git', *args], cwd=REPO, text=True).strip()


def ancestor(before, after):
    return subprocess.run(['git', 'merge-base', '--is-ancestor', before, after],
                          cwd=REPO, capture_output=True).returncode == 0


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def claude_snapshot(sha):
    """Verify an approved copy without falsely requiring a forbidden merge.

    Only committed Git objects count. The manifest is provenance, not proof
    of functional integration, live migrations, or owner/device approval.
    The source commit must be locally available to verify its blobs.
    """
    try:
        exists = subprocess.run(['git', 'cat-file', '-e', sha + ':' + SNAPSHOT_MANIFEST],
                                cwd=REPO, capture_output=True)
        if exists.returncode:
            raise ValueError('No committed snapshot manifest')
        manifest = json.loads(git('show', sha + ':' + SNAPSHOT_MANIFEST))
        source = manifest['source_sha']
        if not re.fullmatch(r'[a-f0-9]{40}', source) or not ancestor(REQUIRED_CLAUDE, source):
            raise ValueError('Source track cannot be verified')
        files = manifest['files']
        paths = [row['path'] for row in files]
        if len(paths) != len(set(paths)) or not SNAPSHOT_REQUIRED.issubset(paths):
            raise ValueError('Required snapshot files missing or duplicated')
        for row in files:
            path = row['path']
            if Path(path).is_absolute() or '..' in Path(path).parts:
                raise ValueError('Unsupported source path')
            blob = git('rev-parse', source + ':' + path)
            if row['source_git_blob'] != blob or git('rev-parse', sha + ':' + path) != blob:
                raise ValueError('Snapshot blob changed')
            raw = subprocess.check_output(['git', 'show', sha + ':' + path], cwd=REPO, stderr=subprocess.DEVNULL)
            if hashlib.sha256(raw).hexdigest() != row['sha256']:
                raise ValueError('Snapshot checksum changed')
        migrations = git('ls-tree', '-r', '--name-only', source, 'supabase/migrations').splitlines()
        if not migrations or any(git('rev-parse', sha + ':' + path) != git('rev-parse', source + ':' + path)
                                 for path in migrations):
            raise ValueError('Migration snapshot incomplete or changed')
        return {'verified': True, 'source_sha': source, 'files_checked': len(files),
                'migration_files_checked': len(migrations), 'proof': 'committed_source_only'}
    except (KeyError, TypeError, ValueError, OSError, subprocess.CalledProcessError):
        return {'verified': False, 'reason': 'No complete unchanged committed Claude snapshot could be verified. Fetch the pinned source if its Git objects are absent.'}


def inventory(authorization_reference=None):
    sha = git('rev-parse', 'HEAD')
    snapshot = claude_snapshot(sha)
    doctor = subprocess.run([sys.executable, 'scripts/android-build.py', 'doctor'],
                            cwd=REPO, text=True, capture_output=True)
    try:
        setup = json.loads(doctor.stdout)
    except json.JSONDecodeError:
        setup = {'status': 'UNAVAILABLE', 'reason': 'Android doctor did not return a supported inventory.'}
    sdk = Path(setup.get('sdk_root', REPO.parent / '.nova-shield/android-sdk'))
    apk = REPO / 'android/app/build/outputs/apk/debug/app-debug.apk'
    binding = {'candidate_sha': sha, 'assets_match_commit': False, 'apk_matches_staging': False}
    try:
        staged = REPO / 'mobile/www'
        manifest = json.loads((staged / 'bundle-manifest.json').read_text())
        matches = []
        # Root index is generated by the sync script. Bind the generator
        # through inputs and the generated bytes through the APK comparison.
        committed = {**manifest['inputs'], **{name: value for name, value in manifest['files'].items() if name != 'index.html'}}
        for name, expected in committed.items():
            raw = subprocess.check_output(['git', 'show', sha + ':' + name], cwd=REPO, stderr=subprocess.DEVNULL)
            matches.append(hashlib.sha256(raw).hexdigest() == expected)
        binding['assets_match_commit'] = bool(matches) and all(matches) and setup.get('staged_assets_current') is True
        with zipfile.ZipFile(apk) as archive:
            files = [path for path in staged.rglob('*') if path.is_file()]
            binding['apk_matches_staging'] = bool(files) and all(
                archive.read('assets/public/' + path.relative_to(staged).as_posix()) == path.read_bytes() for path in files)
    except (OSError, KeyError, ValueError, subprocess.CalledProcessError, zipfile.BadZipFile):
        pass
    return {
        'schema_version': 1,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'candidate': {
            'sha': sha, 'branch': git('branch', '--show-current'),
            'tracked_changes': git('status', '--porcelain', '--untracked-files=no'),
            'contains_codex_12_2': ancestor(REQUIRED_CODEX, sha),
            'contains_claude_12_1': ancestor(REQUIRED_CLAUDE, sha),
            'claude_snapshot': snapshot,
            'authorization_reference': authorization_reference,
            'classification': 'authorized_integrated_candidate' if authorization_reference and
                ancestor(REQUIRED_CODEX, sha) and (snapshot['verified'] or ancestor(REQUIRED_CLAUDE, sha))
                else 'combined_source_candidate_unqualified' if snapshot['verified'] else 'isolated_codex_preparation',
        },
        'apk': {'sha256': digest(apk) if apk.is_file() else None, 'publication': 'none', 'asset_binding': binding},
        'environment': {'android_doctor': setup, 'doctor_exit': doctor.returncode,
                        'kvm_present': Path('/dev/kvm').exists(),
                        'usb_bus_present': Path('/dev/bus/usb').exists(),
                        'installed_system_images': sorted(p.parent.relative_to(sdk).as_posix()
                                                         for p in (sdk / 'system-images').glob('**/package.xml')),
                        'device_probe': 'UNRUN; no device supplied, no adb server started'},
        'target': {'kind': None, 'model': None, 'os_version': None, 'android_api': None,
                   'app_version': None, 'operator': None, 'tested_at': None},
        'cases': [{'id': key, 'purpose': purpose, 'status': 'UNRUN', 'steps_run': [],
                   'observed': None, 'evidence': [],
                   'reason': 'No Android target supplied; source/build evidence does not execute this device case.'}
                  for key, purpose in CASES.items()],
        'qualification': 'NOT_DEVICE_QUALIFIED',
    }


def record_errors(record, base):
    errors = []
    if record.get('schema_version') != 1:
        return ['Unsupported qualification record version.']
    if any(not isinstance(record.get(key), dict) for key in ['candidate','apk','target']):
        return ['Candidate, APK and target must be supported objects.']
    cases = record.get('cases')
    if not isinstance(cases, list):
        return ['Cases must be an explicit list.']
    identifiers = [row.get('id') for row in cases if isinstance(row, dict)]
    if len(identifiers) != len(cases) or len(set(identifiers)) != len(identifiers):
        errors.append('Invalid or duplicated case identities.')
    if set(identifiers) != set(CASES):
        errors.append('Required case set is incomplete or contains unknown cases.')
    for case in cases:
        if not isinstance(case, dict):
            continue
        key = case.get('id', 'unknown')
        status = case.get('status')
        if status not in STATUSES:
            errors.append(f'{key}: unsupported status.')
        if status in {'UNRUN', 'SKIPPED', 'EXPECTED_FAILURE'} and not case.get('reason'):
            errors.append(f'{key}: an explicit reason is required.')
        if status in {'PASS', 'FAIL'}:
            if not case.get('steps_run') or not case.get('observed') or not case.get('evidence'):
                errors.append(f'{key}: actual steps, observation and evidence are required.')
        evidence = case.get('evidence', [])
        if not isinstance(evidence, list):
            errors.append(f'{key}: evidence must be a list.')
            continue
        for item in evidence:
            if not isinstance(item, dict) or not isinstance(item.get('file'), str):
                errors.append(f'{key}: unsupported evidence reference.')
                continue
            path = Path(item['file'])
            resolved = (base / path).resolve()
            if path.is_absolute() or not resolved.is_relative_to(base.resolve()):
                errors.append(f'{key}: evidence must stay inside the record directory.')
            elif not resolved.is_file() or item.get('sha256') != digest(resolved):
                errors.append(f'{key}: evidence missing or hash mismatched.')
    return errors


def device_errors(record):
    errors = []
    candidate = record.get('candidate', {})
    sha = candidate.get('sha', '')
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        errors.append('Exact candidate Git SHA required.')
    elif not ancestor(REQUIRED_CODEX, sha) or not (ancestor(REQUIRED_CLAUDE, sha) or claude_snapshot(sha)['verified']):
        errors.append('Candidate does not contain both required tracks by ancestry or a verified unchanged snapshot; source inclusion still does not prove integration correctness.')
    if candidate.get('classification') != 'authorized_integrated_candidate' or not candidate.get('authorization_reference'):
        errors.append('An actual owner-authorized integrated candidate reference is required.')
    if candidate.get('tracked_changes'):
        errors.append('Candidate has uncommitted tracked changes; bind the tested APK to reviewed code first.')
    if not re.fullmatch(r'[a-f0-9]{64}', record.get('apk', {}).get('sha256') or ''):
        errors.append('APK SHA-256 required.')
    binding = record.get('apk', {}).get('asset_binding') or {}
    if binding.get('candidate_sha') != sha or binding.get('assets_match_commit') is not True or binding.get('apk_matches_staging') is not True:
        errors.append('Current APK/staging assets must match the recorded candidate commit.')
    target = record.get('target', {})
    if target.get('kind') != 'physical_android':
        errors.append('Emulator/browser/build outcomes are not physical Android qualification.')
    for key in ['model', 'os_version', 'app_version', 'operator']:
        if not isinstance(target.get(key), str) or not target[key].strip():
            errors.append(f'Actual target {key} required.')
    api = target.get('android_api')
    if type(api) is not int or api < 24:
        errors.append('Actual Android API level >= 24 required.')
    try:
        tested = datetime.fromisoformat(target.get('tested_at') or '')
        if tested.tzinfo is None or tested > datetime.now(timezone.utc):
            raise ValueError()
    except (TypeError, ValueError):
        errors.append('Actual test timestamp with timezone required; cannot be in the future.')
    if any(row.get('status') != 'PASS' for row in record.get('cases', []) if isinstance(row, dict)):
        errors.append('Every required device case must pass; UNRUN/SKIPPED/expected failures do not qualify it.')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prepare = sub.add_parser('prepare')
    prepare.add_argument('--output', type=Path, required=True)
    prepare.add_argument('--authorization-reference', help='Record an existing owner authorization; does not create permission or device evidence.')
    check = sub.add_parser('validate')
    check.add_argument('record', type=Path)
    check.add_argument('--require-device-pass', action='store_true')
    args = parser.parse_args()
    if args.command == 'prepare':
        if args.output.exists():
            parser.error('Output already exists; preserve prior observations and choose a new run file.')
        args.output.parent.mkdir(parents=True, exist_ok=True)
        record = inventory(args.authorization_reference)
        if args.authorization_reference and record['candidate']['classification'] != 'authorized_integrated_candidate':
            parser.error('Cannot bind this authorization to both source tracks. Verify the committed snapshot and fetch its pinned Git source first.')
        args.output.write_text(json.dumps(record, indent=2) + '\n')
        print(json.dumps({'record': str(args.output), 'status': 'PREPARATION_ONLY',
                          'device_qualification': record['qualification']}))
        return 0
    try:
        record = json.loads(args.record.read_text())
        if not isinstance(record, dict):
            raise ValueError('Record must be a JSON object.')
        errors = record_errors(record, args.record.parent)
        if args.require_device_pass and not errors:
            errors += device_errors(record)
    except (ValueError, OSError) as error:
        errors = [str(error)]
    print(json.dumps({'status': 'REJECTED' if errors else 'DEVICE_RECORD_CONSISTENT' if args.require_device_pass else 'RECORD_CONSISTENT',
                      'errors': errors, 'proof_limit': 'Checks record consistency, not the truth of manual observations.'}, indent=2))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
