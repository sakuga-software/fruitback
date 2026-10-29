import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { GUIDE_EXTRA_CAPTURES, GUIDE_STEPS, type GuideControl } from '../apps/console/app/guide-steps.ts';

/**
 * The captures of the guide (FRU-486), taken by `first-note.spec.ts` along the path it walks.
 *
 * Two modes:
 * - **Guard**, in every run of the suite. Each control that a step names is found on the page of its
 *   capture, by its role and its accessible name: a renamed button fails the spec. The capture goes to
 *   the output of the test, never to the repository.
 * - **Capture**, under `playwright.guide.config.ts` (`pnpm guide:captures`). The same, then
 *   `toHaveScreenshot` against `docs/assets/guide/<name>.png`: a capture that differs from the one in
 *   the repository by more than the threshold is written again, and one that does not is left alone.
 *   So a release whose screens did not change writes nothing. The console serves a copy of them,
 *   `apps/console/public/guide/`, because its image is built from `apps/` and `packages/` alone.
 */

export const CAPTURING = process.env.FRUITBACK_GUIDE_CAPTURE === '1';
/** Where the captures are, from the root of the repository, where Playwright runs. */
const GUIDE_DOCS = 'docs/assets/guide';

/** Every capture the guides show, by its name. */
export const CAPTURE_NAMES = [...GUIDE_STEPS.map((step) => step.id), ...GUIDE_EXTRA_CAPTURES];
type CaptureName = (typeof CAPTURE_NAMES)[number];

/**
 * The accessible name of a control as a page draws it: each `{name}` is a value of the moment, such
 * as the address of the site.
 */
export function accessibleName(control: GuideControl): RegExp {
  const parts = control.name.split(/\{\w+\}/).map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  return new RegExp(`^${parts.join('.+')}$`);
}

/** The controls of a step, each found on `page`. The guard of FRU-486. */
export async function controlsOf(page: Page, id: string): Promise<void> {
  const step = GUIDE_STEPS.find((each) => each.id === id);
  if (step === undefined) throw new Error(`no step of the guide is named ${id}`);
  for (const [key, control] of Object.entries(step.controls)) {
    await expect(
      page.getByRole(control.role, { name: accessibleName(control) }),
      `the step « ${id} » of the guide names {${key}}, « ${control.name} », and this page does not draw it`,
    ).toBeVisible();
  }
}

/** The box around `parts`, `pad` pixels wider on each side, inside the viewport. */
async function around(page: Page, parts: Locator[], pad: number) {
  const boxes = await Promise.all(parts.map((part) => part.boundingBox()));
  const found = boxes.filter((box) => box !== null);
  if (found.length !== parts.length) throw new Error('a part of a capture of the guide is not on the page');
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  // A part can sit a fraction of a pixel apart from a run to the next, and a capture of another size
  // is another capture: the edges are rounded, and the size is a multiple of 8 pixels.
  const left = Math.max(0, Math.round(Math.min(...found.map((box) => box.x)) - pad));
  const top = Math.max(0, Math.round(Math.min(...found.map((box) => box.y)) - pad));
  const right = Math.max(...found.map((box) => box.x + box.width)) + pad;
  const bottom = Math.max(...found.map((box) => box.y + box.height)) + pad;
  const width = Math.min(viewport.width - left, Math.ceil((right - left) / 8) * 8);
  const height = Math.min(viewport.height - top, Math.ceil((bottom - top) / 8) * 8);

  return { x: left, y: top, width, height };
}

/**
 * Checks the controls of the step `name`, then takes its capture: the part of `page` around `parts`.
 *
 * The pointer leaves the page first: a button under it is drawn in its hover colour (`image.md`).
 */
export async function capture(page: Page, name: CaptureName, parts: Locator[], pad = 24): Promise<void> {
  if (GUIDE_STEPS.some((step) => step.id === name)) await controlsOf(page, name);
  await page.mouse.move(0, 0);
  // A part that is still moving gives another box at each read: the composer opens with a motion, and
  // a box read in its middle cut the capture 11 by 15 px short in some runs. The box is read until
  // two reads 100 ms apart agree.
  let clip = await around(page, parts, pad);
  await expect
    .poll(
      async () => {
        const before = JSON.stringify(clip);
        await page.waitForTimeout(100);
        clip = await around(page, parts, pad);

        return JSON.stringify(clip) === before;
      },
      { message: `the parts of the capture « ${name} » never stopped moving` },
    )
    .toBe(true);
  if (CAPTURING) {
    // A capture is the same when at most 0.2 % of its pixels differ by more than the default threshold:
    // an edge of a glyph drawn one pixel off is not a new screen.
    await expect(page).toHaveScreenshot(`${name}.png`, { clip, maxDiffPixelRatio: 0.002 });
  } else {
    await page.screenshot({ clip, path: test.info().outputPath(`guide-${name}.png`) });
  }
}

/** The digest of each capture in the repository, to tell after a run which changed. */
export function capturesNow(): Map<string, string> {
  return new Map(
    CAPTURE_NAMES.map((name) => {
      const file = path.join(GUIDE_DOCS, `${name}.png`);

      return [name, fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : ''];
    }),
  );
}

/**
 * After a run in capture mode: when a capture changed, the captures are copied to the console, and
 * the version of the extension that took them is written in `guide-captured.ts` and in the block of
 * `docs/reviewing.md`. When none changed, nothing is written, so a release with the same screens
 * leaves the repository as it was.
 */
export function recordCaptures(before: Map<string, string>, version: string): string[] {
  if (!CAPTURING) return [];
  const after = capturesNow();
  const changed = CAPTURE_NAMES.filter((name) => before.get(name) !== after.get(name));
  if (changed.length === 0) return [];
  execFileSync(process.execPath, ['apps/console/guide-docs.ts', '--captured', version], { stdio: 'inherit' });

  return changed;
}
