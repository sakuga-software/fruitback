import { type Frame, type Page, expect } from '@playwright/test';
import { PLAYGROUND_ORIGIN, addRule, mintPairing, notesOn, openBareSite, pairFromPopup, test } from './extension.ts';
import { caseOf, hydrated, WORKER_ORIGIN } from './pin.ts';

/**
 * The widget in the frames of a page that declares them (FRU-578), as Storybook shows its stories.
 * The host page is made here, on the origin of the playground; its frame is the bare playground.
 */

declare const chrome: {
  scripting: {
    executeScript(injection: {
      target: { tabId: number; allFrames: boolean };
      files: string[];
      world: 'MAIN' | 'ISOLATED';
    }): Promise<unknown>;
  };
  tabs: {
    query(filter: { url?: string; active?: boolean; lastFocusedWindow?: boolean }): Promise<{ id?: number }[]>;
    sendMessage(tab: number, message: unknown): Promise<unknown>;
  };
};

const HOST_PATH = '/frames-host.html';

async function openHost(site: Page, declares: boolean, testCase: string): Promise<Frame> {
  const framed = `${PLAYGROUND_ORIGIN}/?case=${caseOf(testCase)}&widget=off`;
  await site.route(`${PLAYGROUND_ORIGIN}${HOST_PATH}`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>Host</title>${
        declares ? '<meta name="fruitback" content="frames">' : ''
      }</head><body style="margin:0"><h1>Host</h1><iframe title="story" src="${framed}" style="position:absolute;left:120px;top:80px;width:900px;height:700px;border:0"></iframe></body></html>`,
    }),
  );
  await site.goto(`${PLAYGROUND_ORIGIN}${HOST_PATH}`);
  const found = () => site.frame({ url: (url) => url.href.startsWith(`${PLAYGROUND_ORIGIN}/?case=`) });
  await expect.poll(() => found() !== null).toBe(true);
  const frame = found()!;
  await expect(frame.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await hydrated(frame as unknown as Page);

  return frame;
}

const PRIVATE_RULE = { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN } as const;

test('a page that declares its frames holds no widget, and its frame takes the note and the commands of the popup', async ({
  extension,
}) => {
  await addRule(extension, PRIVATE_RULE);
  const site = await extension.context.newPage();
  const frame = await openHost(site, true, 'ext-frames-host');

  await expect(frame.getByRole('button', { name: /Leave a note/ })).toBeVisible();
  await expect(site.locator('[data-fruitback-host]')).toHaveCount(0);

  // The command of the popup reaches every frame. Only the frame that holds the widget answers.
  const answer = await extension.worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.tabs.sendMessage(tab!.id!, { type: 'fruitback-tab-command', command: 'leave-feedback' });
  }, `${PLAYGROUND_ORIGIN}${HOST_PATH}`);
  expect(answer).toMatchObject({ done: true });

  await frame.locator('[data-testid="card-latte"] .add').click();
  await frame.getByPlaceholder('What should change?').fill('Posée dans le cadre');
  await frame.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(frame.locator('[data-fruitback-pin]')).toHaveCount(1);

  // The note belongs to the page of the frame, which is the page of the story opened alone.
  const notes = await notesOn({ url: () => frame.url() } as Page);
  expect(notes.map((note) => note.text)).toEqual(['Posée dans le cadre']);

  // After a reload, the pin is found again in the document of the frame.
  await site.reload();
  await expect(site.frameLocator('iframe[title="story"]').locator('[data-fruitback-pin]')).toHaveCount(1);
  await expect(site.locator('[data-fruitback-host]')).toHaveCount(0);
});

test('a page that declares nothing keeps the widget in its top frame and none in its frame', async ({ extension }) => {
  await addRule(extension, PRIVATE_RULE);
  const site = await extension.context.newPage();
  const frame = await openHost(site, false, 'ext-frames-none');

  await expect(site.getByRole('button', { name: /Leave a note/ })).toBeVisible();
  await expect(site.locator('[data-fruitback-host]')).toHaveCount(1);
  await site.waitForTimeout(1_500);
  await expect(frame.locator('[data-fruitback-host]')).toHaveCount(0);
});

test('a page of another origin that frames the site and declares its frames gets no widget in that frame', async ({
  extension,
}) => {
  await addRule(extension, PRIVATE_RULE);
  const site = await extension.context.newPage();
  // Both pages are made here: the playground server does not answer a frame under `127.0.0.1`, which
  // is another origin than `localhost` for the browser.
  const foreign = 'http://127.0.0.1:5177/frames-host.html';
  const framed = `${PLAYGROUND_ORIGIN}/frames-story.html`;
  await site.route(framed, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Story</title><h1>Story</h1>' }),
  );
  await site.route(foreign, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta name="fruitback" content="frames"><title>Host</title><iframe title="story" src="${framed}"></iframe>`,
    }),
  );
  // The control: the same page of the site, opened in the top frame, holds the widget.
  await site.goto(framed);
  await expect(site.locator('[data-fruitback-host]')).toHaveCount(1);

  await site.goto(foreign);
  const story = site.frameLocator('iframe[title="story"]');
  await expect(story.getByRole('heading', { name: 'Story' })).toBeVisible();
  // The scripts run at `document_idle`, so the frame is given time to mount a widget it must not mount.
  await site.waitForTimeout(1_500);
  await expect(story.locator('[data-fruitback-host]')).toHaveCount(0);
  await expect(site.locator('[data-fruitback-host]')).toHaveCount(0);
  // No frame of the tab listens to the popup: the browser says at once that nothing received it.
  // The extension holds no access to the origin of the top frame, so it finds the tab as the active one.
  await site.bringToFront();
  const heard = await extension.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return chrome.tabs.sendMessage(tab!.id!, { type: 'fruitback-tab-command', command: 'leave-feedback' }).then(
      () => 'answered',
      () => 'nobody',
    );
  });
  expect(heard).toBe('nobody');
});

test('the scripts put into an open tab in every frame reach the top frame, beside a frame the extension cannot reach', async ({
  extension,
}) => {
  const site = await extension.context.newPage();
  const foreign = 'http://127.0.0.1:5177/frames-foreign.html';
  await site.route(foreign, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Foreign</title><h1>Foreign</h1>' }),
  );
  await site.route(`${PLAYGROUND_ORIGIN}${HOST_PATH}`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Host</title><h1>Host</h1><iframe title="foreign" src="${foreign}"></iframe>`,
    }),
  );
  await site.goto(`${PLAYGROUND_ORIGIN}${HOST_PATH}`);
  await expect(site.frameLocator('iframe[title="foreign"]').getByRole('heading', { name: 'Foreign' })).toBeVisible();
  await expect(site.locator('[data-fruitback-host]')).toHaveCount(0);

  await addRule(extension, PRIVATE_RULE);
  // The call of `src/tab-scripting-browser.ts`, made here: the options page that makes it closes in
  // `addRule` before the call ends. Chromium skips the frame it cannot reach, and throws nothing.
  const thrown = await extension.worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    try {
      for (const [file, world] of [
        ['/content-scripts/page.js', 'MAIN'],
        ['/content-scripts/bridge.js', 'ISOLATED'],
      ] as const) {
        await chrome.scripting.executeScript({ target: { tabId: tab!.id!, allFrames: true }, files: [file], world });
      }

      return undefined;
    } catch (error) {
      return String(error);
    }
  }, `${PLAYGROUND_ORIGIN}${HOST_PATH}`);

  expect(thrown).toBeUndefined();
  await expect(site.locator('[data-fruitback-host]')).toHaveCount(1);
});

/**
 * A capture asked from a frame (FRU-578). The browser captures the tab, so the area of a frame is
 * moved by the place of the frame in the tab, and a capture of the page is the frame alone.
 *
 * The top frame is red. The frame is green, with a blue box at 10, 10 in the frame. A capture in the
 * wrong place shows red. `<all_urls>` is for `captureVisibleTab`, as in `extension-capture.spec.ts`.
 */
test.describe('a capture from a frame', () => {
  test.use({ extraPermissions: ['<all_urls>'] });
  const FRAME = { left: 120, top: 80, width: 600, height: 400 };

  test('a capture from a frame is the area of that frame, in the place of the frame in the tab', async ({
    extension,
  }) => {
    await addRule(extension, { mode: 'team', endpoint: WORKER_ORIGIN });
    const site = await extension.context.newPage();
    // A capture is taken only for a reviewer with a session.
    await openBareSite(site, 'ext-frames-capture');
    await pairFromPopup(extension, site, (await mintPairing('E2E Frames', WORKER_ORIGIN)).code, 'E2E Frames');
    await site.bringToFront();
    await site.route(`${PLAYGROUND_ORIGIN}/capture-story.html`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Story</title><body style="margin:0;background:#00ff00"><div style="position:absolute;left:10px;top:10px;width:100px;height:50px;background:#0000ff"></div></body>',
      }),
    );
    await site.route(`${PLAYGROUND_ORIGIN}/capture-host.html`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta name="fruitback" content="frames"><title>Host</title><body style="margin:0;background:#ff0000"><iframe title="story" src="/capture-story.html" style="position:absolute;left:${FRAME.left}px;top:${FRAME.top}px;width:${FRAME.width}px;height:${FRAME.height}px;border:0"></iframe></body>`,
      }),
    );
    await site.goto(`${PLAYGROUND_ORIGIN}/capture-host.html`);
    const found = () => site.frame({ url: (url) => url.pathname === '/capture-story.html' });
    await expect.poll(() => found() !== null).toBe(true);
    const frame = found()!;
    // Team mode: the frame is given the page API, which the site's widget calls for a capture.
    await expect.poll(() => frame.evaluate(() => 'fruitbackExtension' in window)).toBe(true);
    expect(await site.evaluate(() => 'fruitbackExtension' in window)).toBe(false);

    const measure = (area?: { left: number; top: number; width: number; height: number }) =>
      frame.evaluate(async (asked) => {
        const api = (
          window as unknown as {
            fruitbackExtension: {
              captureVisible(area?: object): Promise<{ base64: string } | undefined>;
            };
          }
        ).fruitbackExtension;
        const picture = await api.captureVisible(
          asked === undefined ? undefined : { ...asked, scale: window.devicePixelRatio },
        );
        if (picture === undefined) return undefined;
        const bytes = Uint8Array.from(atob(picture.base64), (char) => char.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes]));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        const at = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)].join(',');

        return {
          width: bitmap.width / window.devicePixelRatio,
          height: bitmap.height / window.devicePixelRatio,
          corner: at(2, 2),
          middle: at(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2)),
        };
      }, area);

    const box = await measure({ left: 10, top: 10, width: 100, height: 50 });
    expect(box).toEqual({ width: 100, height: 50, corner: '0,0,255', middle: '0,0,255' });

    const page = await measure();
    expect(page).toMatchObject({ width: FRAME.width, height: FRAME.height, middle: '0,255,0' });
    expect(page?.corner).not.toBe('255,0,0');
  });
});
