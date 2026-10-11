"""Explicit SDK/Gradle qualification suite, separate from mocked regression.

Requires scripts/android-build.py setup, npm ci and npm run cap:sync first.
Run alone: temporarily corrupts only generated staging, restores it in finally,
and invokes the real Android Gradle project (not a stand-in Exec task).
"""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
import zipfile

REPO = Path(__file__).resolve().parent.parent
EVIDENCE = Path(os.environ.get('ANDROID_BUILD_EVIDENCE',
                              str(REPO.parent / '.nova-shield/android-qualification/tests')))


def gradle(action, log_name, *tasks):
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    result = subprocess.run([sys.executable, 'scripts/android-build.py', action, *tasks],
                            cwd=REPO, capture_output=True, text=True)
    output = result.stdout + result.stderr
    (EVIDENCE / log_name).write_text(output)
    print(f'{log_name}: exit={result.returncode}; {time.monotonic() - start:.2f}s', flush=True)
    return result.returncode, output


class AndroidBuildQualification(unittest.TestCase):
    def test_01_real_prebuild_executes_guard(self):
        code, output = gradle('gradle', 'prebuild-fresh.txt', ':app:preBuild')
        self.assertEqual(code, 0, output)
        self.assertIn('> Task :app:verifyNovaAssets\n', output)
        self.assertRegex(output, r'Verified \d+ fresh assets, Android copy and resources')
        self.assertIn('BUILD SUCCESSFUL', output)

    def test_02_stale_staging_stops_assemble_at_guard(self):
        staged = REPO / 'mobile/www/admin/js/field.js'
        original = staged.read_bytes()
        try:
            staged.write_bytes(original + b'\n// deliberate Android qualification stale asset\n')
            code, output = gradle('build', 'assemble-stale-expected-failure.txt')
            self.assertNotEqual(code, 0, output)
            self.assertIn('> Task :app:verifyNovaAssets FAILED', output)
            self.assertIn('field.js', output)
            self.assertIn('Staged bundle:', output)
            self.assertIn("Execution failed for task ':app:verifyNovaAssets'", output)
            # The rejection must precede app compilation/packaging, not merely
            # happen to make a later task fail after bypassing the guard.
            for task in ['preBuild', 'compileDebugJavaWithJavac', 'packageDebug', 'assembleDebug']:
                self.assertNotIn('> Task :app:' + task, output)
        finally:
            staged.write_bytes(original)

    def test_03_restored_assemble_contains_current_assets(self):
        code, output = gradle('build', 'assemble-restored.txt')
        self.assertEqual(code, 0, output)
        self.assertIn('> Task :app:verifyNovaAssets\n', output)
        self.assertIn('BUILD SUCCESSFUL', output)
        apk = REPO / 'android/app/build/outputs/apk/debug/app-debug.apk'
        with zipfile.ZipFile(apk) as archive:
            for required in ['AndroidManifest.xml', 'classes.dex', 'resources.arsc']:
                self.assertGreater(len(archive.read(required)), 0)
            assets = [p for p in (REPO / 'mobile/www').rglob('*') if p.is_file()]
            self.assertGreater(len(assets), 100)
            for file in assets:
                name = 'assets/public/' + file.relative_to(REPO / 'mobile/www').as_posix()
                self.assertEqual(archive.read(name), file.read_bytes(), name)
        (EVIDENCE / 'apk.txt').write_text(
            f'Local debug artifact; not published or device-qualified\n'
            f'SHA256 {hashlib.sha256(apk.read_bytes()).hexdigest()}\n'
            f'Bytes {apk.stat().st_size}\nAssets matched {len(assets)}\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
