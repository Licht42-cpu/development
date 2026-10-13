import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const baseline = process.env.READINESS_BASELINE === '1';
const { auditBundle, syncMobile } = require('../scripts/sync-mobile.js');
const scratch = mkdtempSync(join(tmpdir(), 'nova-native-bundle-'));
const results = [];
function record(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, error: err.message }); }
}
const current = file => baseline ? execFileSync('git', ['show', `a8b573f:${file}`], { encoding: 'utf8' })
  : readFileSync(new URL('../' + file, import.meta.url), 'utf8');
try {
  let report;
  record('The synced admin/shared bundle resolves all literal local runtime references', () => {
    report = syncMobile(scratch);
    assert.ok(report.local.length > 70);
    assert.ok(report.local.some(item => item.resolved === 'admin/completion-report.html'));
    assert.ok(report.local.some(item => item.resolved === 'admin/manifest.webmanifest'));
  });
  record('Deleting a required shared module makes the audit fail', () => {
    const file = join(scratch, 'shared/dom.js'), body = readFileSync(file);
    rmSync(file);
    try { assert.throws(() => auditBundle(scratch), /shared\/dom.js/); } finally { writeFileSync(file, body); }
  });
  record('A literal dynamic import outside the bundle is rejected', () => {
    const file = join(scratch, 'admin/js/field.js'), body = readFileSync(file);
    writeFileSync(file, body + '\nimport("./missing-runtime.js");\n');
    try { assert.throws(() => auditBundle(scratch), /missing-runtime/); } finally { writeFileSync(file, body); }
  });
  record('New local HTML assets and CSS URLs cannot disappear silently', () => {
    const file = join(scratch, 'admin/field.html'), body = readFileSync(file);
    writeFileSync(file, body + '<img src="missing.png"><style>@import "missing-theme.css";.x{background:url(missing-bg.svg)}</style>');
    try { assert.throws(() => auditBundle(scratch), /missing.png[\s\S]*missing-bg.svg[\s\S]*missing-theme.css/); } finally { writeFileSync(file, body); }
  });
  record('The old sync silently copies a broken runtime import; the new sync refuses it', () => {
    const root = join(scratch, 'probe-repo');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    cpSync(join(scratch, 'admin'), join(root, 'admin'), { recursive: true });
    cpSync(join(scratch, 'shared'), join(root, 'shared'), { recursive: true });
    const file = join(root, 'admin/js/field.js');
    writeFileSync(file, readFileSync(file, 'utf8') + '\nimport("./missing-runtime.js");\n');
    symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'), 'dir');
    const script = join(root, 'scripts/sync-mobile.js');
    writeFileSync(script, execFileSync('git', ['show', 'a8b573f:scripts/sync-mobile.js']));
    assert.match(execFileSync(process.execPath, [script], { encoding: 'utf8' }), /Synced/);
    writeFileSync(script, readFileSync(new URL('../scripts/sync-mobile.js', import.meta.url)));
    assert.throws(() => execFileSync(process.execPath, [script], { stdio: 'pipe' }),
      error => String(error.stderr).includes('missing-runtime.js'));
    rmSync(root, { recursive: true, force: true });
  });
  record('Native quote preview cannot fall back to the excluded site directory', () => {
    assert.equal(report.excluded.length, 1);
    const file = join(scratch, 'admin/js/views/quote.js'), body = readFileSync(file, 'utf8');
    writeFileSync(file, body.includes('function customerQuoteBase()')
      ? body.replace('if (isNative()) return `${window.location.origin}/`;', '')
      : body.replace('isNative() ? publicUrl : quoteUrl', 'quoteUrl'));
    try { assert.throws(() => auditBundle(scratch), /Native quote link/); } finally { writeFileSync(file, body); }
  });
  record('Core, Supabase and all seven lazy plugins are local audited dependencies', () => {
    assert.equal(report.remote.filter(url => url.startsWith('https://cdn.jsdelivr.net/')).length, 0);
    assert.ok(report.local.some(item => item.resolved === 'shared/vendor/@capacitor/app/dist/esm/index.js'));
    assert.ok(report.local.some(item => item.resolved === 'shared/vendor/@supabase/supabase-js/dist/index.js'));
  });
  record('Android declares foreground coarse and fine location used by high-accuracy GPS', () => {
    const manifest = current('android/app/src/main/AndroidManifest.xml');
    for (const permission of ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION']) assert.match(manifest, new RegExp('android.permission.' + permission));
    assert.doesNotMatch(manifest, /ACCESS_BACKGROUND_LOCATION|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|android.permission.CAMERA/);
  });
  record('The generated Android plugin settings and dependencies include App for hardware Back', () => {
    assert.match(current('android/capacitor.settings.gradle'), /include ':capacitor-app'/);
    assert.match(current('android/app/capacitor.build.gradle'), /implementation project\(':capacitor-app'\)/);
  });
  record('HTTPS local scheme and cache sharing remain configured', () => {
    const config = JSON.parse(current('capacitor.config.json'));
    assert.equal(config.webDir, 'mobile/www'); assert.equal(config.server.androidScheme, 'https');
    assert.match(current('android/app/src/main/res/xml/file_paths.xml'), /cache-path/);
  });
} finally { rmSync(scratch, { recursive: true, force: true }); }
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.error ? '\n  ' + r.error : ''}`);
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`);
if (results.some(r => !r.ok)) process.exitCode = 1;
