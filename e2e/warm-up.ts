import { chromium } from '@playwright/test';

/**
 * Load the development server of the console once, before any spec runs, and throw the result away.
 *
 * Vite binds its port — and so answers Playwright's readiness probe — long before it has finished
 * optimizing dependencies, and it only discovers most of them when a browser actually asks for the
 * module graph. So the *first real navigation* is what triggers the re-optimization: in-flight
 * requests come back `504 (Outdated Optimize Dep)`, Vite reloads the page underneath whichever spec
 * happened to go first, and that spec plants its pin twice. On CI it was reliably the first one.
 *
 * The playground (FRU-488) and the console (FRU-473) are built before the suite and served as files,
 * so they have no optimizer to wait for. The one Vite server left is the console's, for `/kit`
 * alone: a build has no `/kit`.
 */
export default async function warmUp(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    // With several workers, the specs of the kit can start at the same moment (FRU-268). The reload,
    // if there is going to be one, comes after the modules have settled: wait past it.
    await page.goto('http://localhost:5179/kit', { waitUntil: 'networkidle', timeout: 90_000 });
    await page.waitForTimeout(1500);
  } finally {
    await browser.close();
  }
}
