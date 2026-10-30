import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { DEMO_FILES, DEMO_FRAMES } from '../apps/extension/src/demo-video.ts';
import { CAPTURING } from './guide.ts';

/**
 * The video of the welcome page (FRU-531), taken by `first-note.spec.ts` along the path it walks.
 *
 * Each frame of `DEMO_FRAMES` is a capture of the site, as the guide takes its own (`guide.ts`):
 * - in every run of the suite, the capture goes to the output of the test;
 * - under `playwright.guide.config.ts`, `toHaveScreenshot` compares it with `docs/assets/video/<name>.png`,
 *   and writes it again only when its screen changed. When a frame changed, `recordDemo` joins the
 *   frames into the files of `apps/extension/public/demo/`. A release with the same screens writes
 *   no frame and no video.
 *
 * A video recorded by the browser would differ at each run by its timing, and a release would open a
 * pull request for a video that shows the same thing. Captures joined with fixed durations give the
 * same frames when the screens are the same.
 */

/**
 * Where the frames are, from the root of the repository, where Playwright runs: beside the captures
 * of the guide, as the configuration of the guide writes them.
 */
const FRAMES = 'docs/assets/video';
/** Where the extension serves the video from. */
const PUBLIC = 'apps/extension/public';
/** The size of the video: twice the width the welcome page draws it at. */
const SIZE = { width: 960, height: 540 };

/** The part of the page a frame shows: the same box for every frame, in 16/9. */
export type DemoBox = { x: number; y: number; width: number; height: number };

/**
 * The box of 16/9, `width` pixels wide, centred across on `x` and starting at `top`, kept inside the
 * viewport. Rounded, so that a part that moves by a fraction of a pixel gives the same box.
 */
export function demoBox(page: Page, { x: center, top }: { x: number; top: number }, width: number): DemoBox {
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  const height = Math.round((width * 9) / 16);
  const x = Math.min(Math.max(0, Math.round(center - width / 2)), viewport.width - width);
  const y = Math.min(Math.max(0, Math.round(top)), viewport.height - height);

  return { x, y, width, height };
}

/** A pointer drawn on the page for a frame: a screenshot does not show the one of the system. */
export async function showPointer(page: Page, at: { x: number; y: number } | undefined): Promise<void> {
  await page.evaluate((point) => {
    document.querySelector('[data-demo-pointer]')?.remove();
    if (point === undefined) return;
    const pointer = document.createElement('div');
    pointer.setAttribute('data-demo-pointer', '');
    pointer.style.cssText = `position:fixed;left:${point.x}px;top:${point.y}px;width:22px;height:30px;pointer-events:none;z-index:2147483647;`;
    // The arrow of a pointer, white with a dark edge, as a system draws it.
    pointer.innerHTML =
      '<svg width="22" height="30" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg"><path d="M2 2v22l6-6 4 10 4-2-4-10h8z" fill="#fff" stroke="#111" stroke-width="2" stroke-linejoin="round"/></svg>';
    document.documentElement.append(pointer);
  }, at);
}

/** Takes the frame `name` of the video: the part `box` of `page`. */
export async function demoFrame(page: Page, name: string, box: DemoBox): Promise<void> {
  if (!DEMO_FRAMES.some((frame) => frame.name === name)) throw new Error(`no frame of the video is named ${name}`);
  if (CAPTURING) {
    // The same threshold as the captures of the guide: an edge of a glyph one pixel off is the same frame.
    await expect(page).toHaveScreenshot(['video', `${name}.png`], { clip: box, maxDiffPixelRatio: 0.002 });
  } else {
    await page.screenshot({ clip: box, path: test.info().outputPath(`demo-${name}.png`) });
  }
}

/** The digest of each frame in the repository, to tell after a run whether one changed. */
export function framesNow(): Map<string, string> {
  return new Map(
    DEMO_FRAMES.map(({ name }) => {
      const file = path.join(FRAMES, `${name}.png`);

      return [name, fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : ''];
    }),
  );
}

/**
 * After a run in capture mode: when a frame changed, or a file of the video is missing, the frames
 * are joined into the WebM, the MP4 and the poster. Answers the files written.
 */
export function recordDemo(before: Map<string, string>): string[] {
  if (!CAPTURING) return [];
  const after = framesNow();
  const changed = DEMO_FRAMES.some(({ name }) => before.get(name) !== after.get(name));
  const missing = Object.values(DEMO_FILES).some((file) => !fs.existsSync(path.join(PUBLIC, file)));
  if (!changed && !missing) return [];

  return joinFrames(FRAMES, PUBLIC);
}

/**
 * Joins the frames of `frames` into the files of `DEMO_FILES` under `out`, with `ffmpeg`.
 *
 * One thread and the flags `bitexact`: the same frames and the same `ffmpeg` give the same bytes.
 */
export function joinFrames(frames: string, out: string): string[] {
  // Each frame is an input of its own, held for its seconds, and the filter `concat` joins them: the
  // demuxer of the same name drops or repeats the last duration, by the version of `ffmpeg`.
  const inputs = DEMO_FRAMES.flatMap(({ name, seconds }) => [
    '-loop',
    '1',
    '-framerate',
    '25',
    '-t',
    String(seconds),
    '-i',
    path.join(frames, `${name}.png`),
  ]);
  const joined = `${DEMO_FRAMES.map((_, index) => `[${index}:v]`).join('')}concat=n=${DEMO_FRAMES.length}:v=1:a=0`;
  const [webm, mp4, poster] = [DEMO_FILES.webm, DEMO_FILES.mp4, DEMO_FILES.poster].map((file) => path.join(out, file));
  fs.mkdirSync(path.dirname(webm as string), { recursive: true });
  const input = ['-hide_banner', '-loglevel', 'error', '-y', ...inputs];
  const scale = `${joined},scale=${SIZE.width}:${SIZE.height}:flags=lanczos,fps=25,format=yuv420p`;
  const exact = ['-an', '-threads', '1', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact'];
  execFileSync('ffmpeg', [
    ...input,
    '-filter_complex',
    scale,
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '0',
    '-crf',
    '42',
    '-row-mt',
    '0',
    '-deadline',
    'good',
    ...exact,
    webm as string,
  ]);
  execFileSync('ffmpeg', [
    ...input,
    '-filter_complex',
    scale,
    '-c:v',
    'libx264',
    '-preset',
    'veryslow',
    '-tune',
    'stillimage',
    '-crf',
    '30',
    '-profile:v',
    'high',
    '-movflags',
    '+faststart',
    ...exact,
    mp4 as string,
  ]);
  // The poster is the first frame: what the person sees before the video plays, or instead of it.
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    path.join(frames, `${DEMO_FRAMES[0]?.name}.png`),
    '-vf',
    `scale=${SIZE.width}:${SIZE.height}:flags=lanczos`,
    '-q:v',
    '4',
    ...exact.filter((flag) => flag !== '-an'),
    poster as string,
  ]);

  return [webm as string, mp4 as string, poster as string];
}
