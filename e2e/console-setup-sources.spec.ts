import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * Step 2 of the set-up, « Where should feedback go? » (FRU-166). It chooses nothing yet: Fruitback
 * keeps the notes. So it is a list to read, not a radio group whose radios take no focus, and a source
 * that the Connectors screen connects is not said to come « After the beta ».
 *
 * The worker is answered by stubs: a person signed in, with one workspace.
 */
const CONSOLE = 'http://localhost:5178';

async function stubWorker(page: Page): Promise<void> {
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana' },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
  };
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ json: body });
    if (pathname === '/console/me') return json(me);
    if (pathname === '/auth/providers') return json({});

    return route.fulfill({ status: 204 });
  });
}

const WORDS = {
  'en-US': {
    list: 'Sources',
    later: 'In Connectors, after the set-up',
    beta: 'After the beta',
    rest: 'REST API',
  },
  'fr-FR': {
    list: 'Sources',
    later: 'Dans Connecteurs, après la mise en place',
    beta: 'Après la bêta',
    rest: 'API REST',
  },
} as const;

for (const [locale, words] of Object.entries(WORDS)) {
  test(`step 2 says where each source connects, in ${locale}`, async ({ browser }) => {
    const context = await browser.newContext({ locale, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await stubWorker(page);
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.locator('ol [aria-current="step"]')).toContainText('2');

    // Nothing here is a choice, so nothing claims to be one.
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    await expect(page.getByRole('radio')).toHaveCount(0);

    const rows = page.getByRole('list', { name: words.list }).getByRole('listitem');
    const row = (name: string) => rows.filter({ hasText: name });
    await expect(rows).toHaveCount(4);
    // The sources the Connectors screen connects say where, and not « After the beta ».
    for (const name of ['Linear', words.rest]) {
      await expect(row(name)).toContainText(words.later);
      await expect(row(name)).not.toContainText(words.beta);
    }
    // A source that nothing connects yet still says so.
    await expect(row('GitHub Issues')).toContainText(words.beta);
    await context.close();
  });
}
