#!/usr/bin/env python3
"""Inspect an already assembled debug APK without adb or a device.

Run after sync/build and outside concurrent asset-mutating packaging tests.
Signature verification is a separate apksigner check (see android-build.md).
"""
import argparse
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--evidence', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
apk = root / 'android/app/build/outputs/apk/debug/app-debug.apk'
staged = root / 'mobile/www'
copied = root / 'android/app/src/main/assets/public'
inventory = lambda path: {p.relative_to(path).as_posix(): p.read_bytes() for p in path.rglob('*') if p.is_file()}
source_files, copied_files = inventory(staged), inventory(copied)
assert source_files and 'bundle-manifest.json' in source_files, 'No staged bundle'
assert all(copied_files.get(name) == data for name, data in source_files.items()), 'Android staging differs'
generated = set(copied_files) - set(source_files)
assert generated == {'cordova.js', 'cordova_plugins.js'}, generated
assert all(copied_files[name] == b'' for name in generated), 'Unexpected Cordova stubs'
with zipfile.ZipFile(apk) as archive:
    packaged = {name.removeprefix('assets/public/'): archive.read(name)
                for name in archive.namelist() if name.startswith('assets/public/') and not name.endswith('/')}
    assert packaged == copied_files, 'Packaged public assets differ from Android copies'
    assert {'AndroidManifest.xml', 'resources.arsc', 'classes.dex'} <= set(archive.namelist())

merged = root / 'android/app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml'
manifest = ET.parse(merged).getroot()
ns = '{http://schemas.android.com/apk/res/android}'
assert manifest.get('package') == 'com.novashield.admin'
sdk = manifest.find('uses-sdk')
assert sdk.get(ns + 'minSdkVersion') == '24' and sdk.get(ns + 'targetSdkVersion') == '36'
permissions = sorted(node.get(ns + 'name') for node in manifest.findall('uses-permission'))
assert set(permissions) == {
    'android.permission.INTERNET', 'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACCESS_FINE_LOCATION', 'android.permission.VIBRATE',
    'android.permission.ACCESS_NETWORK_STATE',
    'com.novashield.admin.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
}, permissions
app = manifest.find('application')
main = next(node for node in app.findall('activity') if node.get(ns + 'name') == 'com.novashield.admin.MainActivity')
assert main.get(ns + 'exported') == 'true'
assert any(node.get(ns + 'name') == 'android.intent.action.MAIN' for node in main.iter('action'))
assert any(node.get(ns + 'name') == 'android.intent.category.LAUNCHER' for node in main.iter('category'))
provider = next(node for node in app.findall('provider') if node.get(ns + 'name') == 'androidx.core.content.FileProvider')
assert provider.get(ns + 'exported') == 'false' and provider.get(ns + 'grantUriPermissions') == 'true'
result = {
    'apk_sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
    'staged_files_compared': len(source_files), 'apk_public_files_compared': len(packaged),
    'native_generated_empty_stubs': sorted(generated), 'permissions': permissions,
    'min_sdk': 24, 'target_sdk': 36, 'launcher_exported': True,
    'file_provider_exported': False, 'file_provider_grants_uris': True,
    'device_checks': 'UNRUN: no device; emulator unavailable; no adb attempt',
    'release_signing': 'UNRUN: debug artifact only', 'status': 'PASS'
}
if args.evidence:
    args.evidence.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
