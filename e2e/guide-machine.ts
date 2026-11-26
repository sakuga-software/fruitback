import os from 'node:os';
import { chromium } from '@playwright/test';

/**
 * Before the captures of the guide (FRU-732): a calmer machine, and the full Chromium launched once.
 *
 * `release-extension.yml` takes the captures on a Mac of GitHub that booted two or three minutes
 * before: 3 CPUs, and a load of 15 to 40 when the job starts (Spotlight, Siri, the provisioning of
 * the image). Measured on 23 of them, for FRU-732:
 *
 * - The load of the last minute rarely falls under the number of CPUs in 300 s (1 Mac of 6), but the
 *   wait halves the load at the launch of the spec: 5 to 12, against 13 to 24 with no wait.
 * - The first launch of the full Chromium takes 5.5 to 11 s. In the spec, the extension then opened
 *   its welcome page up to 16 s after the launch, past the 10 s that `extension.ts` waits for it:
 *   the failure of v0.8.0. `warm-up.ts` launches the headless shell, another binary. Here the full
 *   one is launched once, and the spec then sees the welcome page 3 to 8 s after its launch.
 */

/** The longest wait for a calm machine. Past it, the captures start, with a warning. */
const CALM_WITHIN_MS = 300_000;

export default async function guideMachine(): Promise<void> {
  const cpus = os.availableParallelism();
  const start = Date.now();
  // The load of the last minute, under the number of CPUs. A calm machine waits nothing.
  while (os.loadavg()[0]! >= cpus && Date.now() - start < CALM_WITHIN_MS) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  const load = os.loadavg()[0]!.toFixed(1);
  const waited = Math.round((Date.now() - start) / 1000);
  if (os.loadavg()[0]! >= cpus) {
    console.warn(`[guide] the load is still ${load} on ${cpus} CPUs after ${waited} s: the captures start anyway`);
  } else {
    console.log(`[guide] load ${load} on ${cpus} CPUs, after ${waited} s`);
  }

  const launched = Date.now();
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    await (await browser.newPage()).goto('about:blank');
  } finally {
    await browser.close();
  }
  console.log(`[guide] the full Chromium launched once, in ${((Date.now() - launched) / 1000).toFixed(1)} s`);
}
