import { execFileSync } from 'node:child_process';
import { fieldFixture, JOB_A, queueAction } from './field-resilience-fixture.mjs';
export { JOB_A, queueAction };

export async function readinessFixture(browser, options = {}) {
  const adapter = { newContext: async settings => {
    const context = await browser.newContext(settings);
    if (process.env.READINESS_BASELINE === '1') {
      for (const file of ['admin/js/field.js', 'admin/js/views/field-workspace.js',
        'admin/js/lib/measurement-entry.js', 'admin/css/admin.css']) {
        const body = execFileSync('git', ['show', `a8b573f:${file}`], { encoding: 'utf8' });
        await context.route(`http://localhost:8743/${file}`, route => route.fulfill({ status: 200,
          contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript', body }));
      }
    }
    return context;
  } };
  const fixture = await fieldFixture(adapter, { hash: '#/visit/' + JOB_A, ...options });
  if (!options.config?.__fail?.session) {
    await fixture.page.getByRole('heading', { name: 'Notes', exact: true }).waitFor();
    // Headings mount before the initial reads finish. Wait for those reads,
    // or a keyboard traversal can count an incomplete set of controls.
    await fixture.page.getByRole('button', { name: '+ Add photo', exact: true }).waitFor();
    if (options.config?.__fail?.listNotes) await fixture.page.getByText(/Could not load notes:/).waitFor();
    else await fixture.page.getByText('No notes on this job yet.', { exact: true }).waitFor();
    await fixture.page.waitForFunction(() => !document.querySelector('textarea[aria-label="Note"]').disabled);
  }
  return fixture;
}

export async function contrast(locator) {
  return locator.evaluate(node => {
    const rgb = css => css.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = color => {
      const values = color.map(v => {
        const n = Number(v) / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
      });
      return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
    };
    const style = getComputedStyle(node);
    function background(element) {
      while (element) {
        const color = getComputedStyle(element).backgroundColor;
        if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return rgb(color);
        element = element.parentElement;
      }
      return [255, 255, 255];
    }
    const beneath = background(node.parentElement), opacity = Number(style.opacity);
    const brightness = Number(style.filter.match(/brightness\(([\d.]+)\)/)?.[1] || 1);
    const composite = color => color.map((value, i) =>
      Math.min(255, value * brightness) * opacity + beneath[i] * (1 - opacity));
    const a = lum(composite(rgb(style.color))), b = lum(composite(background(node)));
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  });
}
