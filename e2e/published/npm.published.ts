import { expect, type Page, test } from '@playwright/test';
import { WORKER_ORIGIN, storedNotes } from '../pin.ts';
import {
  PUBLISHED_ELEMENT,
  PUBLISHED_IIFE,
  PUBLISHED_IMPORT,
  openBareSite,
  plantOnTheLatteCard,
  publishedVersions,
} from './published.ts';

/**
 * The last published npm packages against the worker of this commit (FRU-460).
 *
 * The three ways of the README to put the widget on a site: the snippet, `import { init } from
 * 'fruitback'`, and the tag of `@fruitback/element`. Each one sends a note, and reads it back after a
 * reload. A change of the worker that breaks the sites that run the published widget fails here.
 */

/** Where the page loads the snippet from. The route below answers with the published file. */
const CDN = 'https://cdn.published.test';

const WAYS: { name: string; launch: RegExp; mount: (page: Page) => Promise<void> }[] = [
  {
    name: 'the snippet of the README',
    launch: /Leave feedback|Leave a note/,
    mount: async (page) => {
      // The snippet itself, with its `data-` attributes: `addScriptTag` cannot set them.
      await page.evaluate(
        ({ src, endpoint }) =>
          new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.dataset.fruitbackEndpoint = endpoint;
            script.dataset.fruitbackClient = 'playground';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`${src} did not load`));
            document.head.append(script);
          }),
        { src: `${CDN}/fruitback.iife.js`, endpoint: WORKER_ORIGIN },
      );
    },
  },
  {
    name: "import { init } from 'fruitback'",
    launch: /Leave feedback|Leave a note/,
    mount: async (page) => {
      await page.addScriptTag({ path: PUBLISHED_IMPORT });
      await page.evaluate((endpoint) => {
        const scope = globalThis as unknown as { FruitbackFromNpm: { init(options: Record<string, string>): unknown } };
        scope.FruitbackFromNpm.init({ endpoint, clientId: 'playground', locale: 'en-US' });
      }, WORKER_ORIGIN);
    },
  },
  {
    name: 'the tag of @fruitback/element',
    launch: /From a tag/,
    mount: async (page) => {
      await page.addScriptTag({ path: PUBLISHED_ELEMENT });
      await page.evaluate((endpoint) => {
        const element = document.createElement('fruitback-widget');
        element.setAttribute('endpoint', endpoint);
        element.setAttribute('client-id', 'playground');
        element.setAttribute('locale', 'en-US');
        element.setAttribute('label', 'From a tag');
        document.body.append(element);
      }, WORKER_ORIGIN);
    },
  },
];

for (const [index, way] of WAYS.entries()) {
  test(`npm ${publishedVersions().npm}, ${way.name}: a note goes to this worker and comes back`, async ({ page }) => {
    await page.route(`${CDN}/fruitback.iife.js`, (route) =>
      route.fulfill({ path: PUBLISHED_IIFE, contentType: 'text/javascript' }),
    );
    const text = `Publié, voie ${index + 1}`;
    await openBareSite(page, `published-npm-${index + 1}`);
    await way.mount(page);

    await plantOnTheLatteCard(page, way.launch, text);
    expect((await storedNotes(page)).map((note) => note.text)).toEqual([text]);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
    await way.mount(page);
    await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  });
}
