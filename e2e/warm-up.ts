import { chromium } from '@playwright/test';

/**
 * Load the app once, before any spec runs, and throw the result away.
 *
 * Vite binds its port — and so answers Playwright's readiness probe — long before it has finished
 * optimizing dependencies, and it only discovers most of them when a browser actually asks for the
 * module graph. So the *first real navigation* is what triggers the re-optimization: in-flight
 * requests come back `504 (Outdated Optimize Dep)`, Vite reloads the page underneath whichever spec
 * happened to go first, and that spec plants its pin twice. On CI it was reliably the first one.
 *
 * `optimizeDeps.include` in `vite.config.ts` names the heavy dependencies so most of the work
 * happens at boot, but it is not a guarantee on its own — React Router optimizes its SSR
 * environment separately, and a route can always pull in something new. This is the guarantee:
 * nothing is measured until a browser has loaded the page end to end at least once.
 *
 * Deliberately not a production build. The suite runs against `dev` because `source` carries the
 * component name and the file it came from, and both come from React's dev-only fiber metadata.
 */
export default async function warmUp(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto('http://localhost:5177/', { waitUntil: 'networkidle', timeout: 90_000 });
    // The reload, if there is going to be one, comes after the modules have settled rather than with
    // them — so wait past it instead of racing it.
    await page.waitForTimeout(1500);
    await page.goto('http://localhost:5177/checkout', { waitUntil: 'networkidle', timeout: 60_000 });
  } finally {
    await browser.close();
  }
}
