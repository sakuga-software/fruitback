import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The video of the welcome page in the gallery (FRU-581).
 *
 * The gallery is served under `/gallery/` (`gallery/nginx.conf`), and the welcome page asked for
 * `/demo/first-note.*` at the root of the domain: 404, on gallery.fruitback.com too. The spec builds
 * the gallery as its image does, serves the build under `/gallery/` and nothing else, and opens the
 * story.
 */

const DIST = path.resolve('apps/extension/gallery/dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

let server: Server;
let origin: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  // The command of the image (`gallery/Dockerfile`). It writes `gallery/dist/gallery`.
  execFileSync('pnpm', ['--filter', '@fruitback/extension', 'gallery:build'], { stdio: 'pipe' });
  // As nginx: the files of the build, at their path, and 404 for anything else.
  server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://gallery').pathname);
    const file = path.join(DIST, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
    if (!file.startsWith(`${DIST}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
});

test('the welcome page of the gallery loads its video under /gallery/', async ({ page }) => {
  const answers = new Map<string, number>();
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.includes('first-note.')) answers.set(url.pathname, response.status());
  });

  await page.goto(`${origin}/gallery/iframe.html?id=extension-welcome-page--signed-out&viewMode=story`);
  const video = page.locator('figure.welcome-demo video');
  await expect(video).toBeVisible();

  // The poster, and the first source that Chromium plays, come from the build.
  await expect.poll(() => video.evaluate((each: HTMLVideoElement) => each.readyState)).toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((each: HTMLVideoElement) => each.currentSrc)).toMatch(
    /\/gallery\/demo\/first-note\.webm$/,
  );
  await expect.poll(() => answers.get('/gallery/demo/first-note.jpg')).toBe(200);
  expect([...answers.values()].filter((status) => status !== 200)).toEqual([]);

  // Chromium stops at the WebM: the MP4, for Safari, is asked for by hand.
  const mp4 = await video.locator('source[type="video/mp4"]').evaluate((each: HTMLSourceElement) => each.src);
  expect(new URL(mp4).pathname).toBe('/gallery/demo/first-note.mp4');
  expect((await page.request.get(mp4)).status()).toBe(200);
});
