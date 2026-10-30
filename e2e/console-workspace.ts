import { type Locator, type Page, type Route, expect } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * What the specs of the screens of a workspace share (FRU-234): the worker answered by stubs, a
 * colour as the browser paints it, and the contrast of two colours. Layout and colours are what
 * these specs measure, and none of that needs a worker with accounts.
 *
 * The sample data is of nobody: `acme.dev`, `client.fr`, invented names.
 */
export type Role = 'owner' | 'admin' | 'member' | 'guest';
/** A suspended one says so as the worker does (FRU-282): `suspendedAt`, and `reason` when one was given. */
export type StubbedWorkspace = {
  id: string;
  name: string;
  role: Role;
  suspended?: boolean;
  suspendedAt?: string;
  reason?: string;
};

export const ACME: StubbedWorkspace = { id: 'w1', name: 'Acme', role: 'owner' };
export const LUMEN: StubbedWorkspace = { id: 'w2', name: 'Lumen Studio', role: 'member' };

type Stub = {
  locale?: 'en' | 'fr';
  workspaces?: readonly StubbedWorkspace[];
  sites?: readonly unknown[];
  /** Answers a call before the stubs below do. `undefined`: the stubs below answer. */
  answer?: (pathname: string, route: Route) => Promise<void> | undefined;
};

/** A site as a stub answers it: what the reads of FRU-497 need of it. */
type StubbedSite = { id: string; origin: string; visibility?: string };

/**
 * What the worker answers to a read of the sites of a workspace (FRU-497), from the whole list a
 * spec gives: the list, a page of it with its total, the sites to choose from by address, or one
 * site (`undefined` for one that is not in the list: a 404). `false`: the address is no read of
 * the sites, and the spec answers it.
 */
export function sitesRead(url: URL, list: readonly unknown[]): unknown | undefined | false {
  const sites = list as readonly StubbedSite[];
  const read = /^\/console\/workspaces\/[^/]+\/sites(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname);
  if (read === null) return false;
  const host = (site: StubbedSite) => site.origin.split('://')[1] ?? site.origin;
  const q = url.searchParams.get('q')?.trim().toLowerCase() ?? '';
  const found = sites.filter((site) => host(site).toLowerCase().includes(q));
  if (read[1] === 'choices') {
    return {
      sites: [...found]
        .sort((a, b) => a.origin.localeCompare(b.origin))
        .map(({ id, origin, visibility }) => ({ id, origin, visibility })),
    };
  }
  if (read[1] !== undefined) return sites.find((site) => site.id === read[1]);
  if (!url.searchParams.has('limit')) return { sites };
  const offset = Number(url.searchParams.get('offset') ?? 0);

  return { sites: found.slice(offset, offset + Number(url.searchParams.get('limit'))), total: found.length };
}

/** Answers a read of the sites from the whole list (FRU-497); `false` when `route` asks for something else. */
export function fulfillSites(route: Route, list: readonly unknown[]): Promise<void> | false {
  const url = new URL(route.request().url());
  if (route.request().method() !== 'GET') return false;
  const body = sitesRead(url, list);
  if (body === false) return false;

  return body === undefined
    ? route.fulfill({ status: 404, json: { error: 'not-found' } })
    : route.fulfill({ json: body });
}

/** A signed-in person, their workspaces, and the lists every screen of a workspace reads. */
export async function stubWorker(page: Page, stub: Stub = {}): Promise<void> {
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale: stub.locale ?? 'en' },
    workspaces: stub.workspaces ?? [ACME, LUMEN],
  };
  const sites = stub.sites ?? [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }];
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ json: body });
    const answered = stub.answer?.(pathname, route);
    if (answered !== undefined) return answered;
    if (pathname === '/console/me') return json(me);
    if (/^\/console\/workspaces\/w\d\/domains$/.test(pathname)) return json({ domains: [] });
    const read = /^\/console\/workspaces\/w\d\//.test(pathname) ? fulfillSites(route, sites) : false;
    if (read !== false) return read;
    if (/^\/console\/workspaces\/w\d\/connectors$/.test(pathname)) return json({ connectors: [], available: true });
    // Nobody invited the person elsewhere: the front door opens their first workspace.
    if (pathname.endsWith('/list-user-invitations')) return json([]);
    // A worker that signs people in by a link: one that says nothing there shows no form (FRU-217).
    if (pathname === '/auth/providers') return json({ betterAuth: { email: true, github: false, google: false } });

    return route.fulfill({ status: 204 });
  });
}

/** How far the document scrolls sideways. A screen that fits: 0. */
export const sideScroll = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

type Painted = 'color' | 'backgroundColor' | 'outlineColor' | 'borderTopColor' | 'fill';

/** A computed colour as the browser paints it on white, whatever notation `getComputedStyle` answers in. */
export function painted(locator: Locator, property: Painted): Promise<number[]> {
  return locator.evaluate((element, name) => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(element)[name];
    context.fillRect(0, 0, 1, 1);

    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, property);
}

/** `#rrggbb` as the three numbers `painted` answers. */
export function rgb(hex: string): number[] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

/** The contrast ratio of WCAG 2.2. */
export function contrast(one: number[], other: number[]): number {
  const luminance = (colour: number[]) => {
    const [red = 0, green = 0, blue = 0] = colour.map((channel) => {
      const value = channel / 255;

      return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });

    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a) as [number, number];

  return (light + 0.05) / (dark + 0.05);
}

/** Some computed styles of an element, by their names in CSS. */
export function styles(locator: Locator, names: readonly string[]): Promise<Record<string, string>> {
  return locator.evaluate((element, list) => {
    const computed = getComputedStyle(element);

    return Object.fromEntries(list.map((name) => [name, computed.getPropertyValue(name)]));
  }, names);
}

/**
 * What a field tells the fill of the browser and the password managers (FRU-540). A field that asks
 * for the address of another person reads `NO_PASSWORD_MANAGER`: LastPass draws nothing in it.
 */
export function fillMarks(field: Locator): Promise<Record<string, string | null>> {
  return field.evaluate((element) =>
    Object.fromEntries(
      ['autocomplete', 'data-lpignore', 'data-1p-ignore', 'data-bwignore'].map((name) => [
        name,
        element.getAttribute(name),
      ]),
    ),
  );
}

export const NO_PASSWORD_MANAGER = {
  autocomplete: 'off',
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
};

export type Box = { x: number; y: number; width: number; height: number };

export async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  if (found === null) throw new Error('the element has no box');

  return found;
}

/**
 * Whether this browser draws text with the font the mockup was measured in: the system font of
 * macOS. The mockup writes `line-height: normal` and sizes most boxes by their text, so the same
 * styles give other boxes with another font: on the Linux of CI the name of a workspace is 52 px
 * high where the mockup has 49, and every box under it is 3 px lower (measured, 2026-10-13).
 */
export const MOCKUP_FONT = process.platform === 'darwin';

/**
 * Each side of a box against the mockup, within a tolerance in pixels.
 *
 * WARNING: it compares only where the font is the one of the mockup (`MOCKUP_FONT`). Elsewhere a
 * spec holds the screen to the mockup by its computed styles, which no font changes.
 */
export function expectBox(found: Box, mockup: Partial<Box>, tolerance: number, name: string): void {
  if (!MOCKUP_FONT) return;
  for (const [side, value] of Object.entries(mockup) as [keyof Box, number][]) {
    expect
      .soft(Math.abs(found[side] - value), `${name}: ${side} is ${found[side]}, the mockup has ${value}`)
      .toBeLessThanOrEqual(tolerance);
  }
}

/**
 * Types `first` in `field`, then types `then` at the instant React Router writes the search in the
 * address (FRU-279). A person who types on does that: the search writes 300 ms after a key, and a
 * key can come before the screen draws the new address.
 */
export async function typeDuringTheWrite(field: Locator, first: string, then: string): Promise<void> {
  await field.evaluate((input: HTMLInputElement, more: string) => {
    const replace = history.replaceState.bind(history);
    history.replaceState = (...args: Parameters<History['replaceState']>) => {
      history.replaceState = replace;
      replace(...args);
      const write = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      write?.call(input, input.value + more);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
  }, then);
  await field.pressSequentially(first);
}
