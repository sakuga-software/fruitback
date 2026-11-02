/**
 * Which frames of a tab hold the widget (FRU-578).
 *
 * The scripts run in every frame of an origin that is on. A page that puts the screens it shows in a
 * frame, as Storybook does, declares it with `<meta name="fruitback" content="frames">` in its top
 * frame. Then the widget goes into the frames of that page, and the top frame holds none:
 *
 * - `page`: the top frame of a page with no declaration. It holds the widget, as before.
 * - `host`: the top frame of a page with the declaration. It holds no widget.
 * - `framed`: a frame directly under a `host`, of the same origin. It holds the widget.
 * - `none`: any other frame. It holds no widget.
 *
 * A frame under a top frame of another origin is always `none`: a site that frames a site somebody
 * turned on cannot make the widget appear under its own content. The browser refuses to read the
 * `location` of a top frame of another origin, and that refusal is the test.
 */

export type FrameRole = 'page' | 'host' | 'framed' | 'none';

export const FRAMES_META = 'meta[name="fruitback"][content="frames"]';

/** The part of `Window` that `frameRole` reads. */
export type FrameView = {
  location: { origin: string };
  document: { querySelector(selector: string): unknown };
  top: FrameView | null;
  parent: FrameView | null;
};

export function frameRole(view: FrameView): FrameRole {
  const top = view.top;
  if (top === null || top === view) return hostsFrames(view) ? 'host' : 'page';
  if (view.parent !== top) return 'none';
  try {
    if (top.location.origin !== view.location.origin) return 'none';

    return hostsFrames(top) ? 'framed' : 'none';
  } catch {
    return 'none';
  }
}

export function holdsWidget(role: FrameRole): boolean {
  return role === 'page' || role === 'framed';
}

function hostsFrames(view: FrameView): boolean {
  return view.document.querySelector(FRAMES_META) !== null;
}

export type Area = { left: number; top: number; width: number; height: number; scale: number };

/** The box of a frame in the viewport of its parent: the part of `HTMLIFrameElement` this file reads. */
export type FrameBox = {
  getBoundingClientRect(): { left: number; top: number };
  clientLeft: number;
  clientTop: number;
  clientWidth: number;
  clientHeight: number;
};

/**
 * The browser captures the visible part of the tab, so an area of a frame must be in the viewport
 * of the tab. A capture of the whole page, from a frame, is the area of that frame: the person
 * notes a screen of the frame, not the page around it.
 */
export function areaInTab(area: Area | undefined, frame: FrameBox | null, scale: number): Area | undefined {
  if (frame === null) return area;
  const box = frame.getBoundingClientRect();
  const left = box.left + frame.clientLeft;
  const top = box.top + frame.clientTop;
  if (area === undefined) return { left, top, width: frame.clientWidth, height: frame.clientHeight, scale };

  return { ...area, left: area.left + left, top: area.top + top };
}
