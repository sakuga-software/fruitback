/**
 * The short demonstration of the welcome page (FRU-531): a first note, from the site to its pin.
 *
 * `e2e/first-note.spec.ts` takes one capture per frame below, on the real path, and `e2e/demo.ts`
 * joins them into the video. A capture is kept in `docs/assets/video/` and written again only when its screen
 * changed, so a release whose screens did not change writes no new video. The extension serves the
 * files from `public/demo/`: the page reaches no network for them.
 */

/** A frame of the video: the name of its capture, and how long it stays on the screen. */
export type DemoFrame = { name: string; seconds: number };

/** The frames, in their order. Their seconds add up to the length of the video. */
export const DEMO_FRAMES: readonly DemoFrame[] = [
  { name: '01-site', seconds: 2.5 },
  { name: '02-pick', seconds: 2.5 },
  { name: '03-composer', seconds: 1.5 },
  { name: '04-typing-1', seconds: 0.6 },
  { name: '05-typing-2', seconds: 0.6 },
  { name: '06-typing-3', seconds: 0.6 },
  { name: '07-written', seconds: 2.5 },
  { name: '08-sent', seconds: 2.2 },
  { name: '09-pin', seconds: 5 },
];

/** The length of the video, in whole seconds. */
export const DEMO_SECONDS = Math.round(DEMO_FRAMES.reduce((sum, frame) => sum + frame.seconds, 0));

/** The files of the video, from the root of the extension. */
export const DEMO_FILES = {
  webm: '/demo/first-note.webm',
  mp4: '/demo/first-note.mp4',
  poster: '/demo/first-note.jpg',
} as const;

/** `0:18`: the length as a player writes it. */
export function demoLength(seconds: number = DEMO_SECONDS): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
