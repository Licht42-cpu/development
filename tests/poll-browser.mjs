import { setTimeout as delay } from 'node:timers/promises';

// Playwright waitForFunction treats an async predicate's Promise as truthy
// before its eventual boolean. Await storage/lock predicates in Node instead.
export async function pollBrowser(page, predicate, arg, { timeoutMs = 7000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let timer;
    try {
      const value = await Promise.race([
        page.evaluate(predicate, arg),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser predicate did not finish.')), Math.max(1, deadline - Date.now())); })
      ]);
      if (value) return value;
    } finally { clearTimeout(timer); }
    await delay(25);
  }
  throw new Error('Browser predicate never became true.');
}
