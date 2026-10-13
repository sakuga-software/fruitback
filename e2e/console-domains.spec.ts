import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The domains of a workspace, on the Sites screen (FRU-103), under the row of a site (FRU-243): the record to write, the check, the
 * site whose previews a proven domain covers, and a proof that is lost.
 *
 * The worker is answered by stubs, which decide what is proven: the console decides nothing.
 */
const CONSOLE = 'http://localhost:5178';
const BASE = '/console/workspaces/w1/domains';
const RECORD = { type: 'TXT', name: '_fruitback.preview.acme.dev', value: 'fruitback-domain-verification=0123abcd' };

type Domain = {
  id: string;
  domain: string;
  state: 'pending' | 'proven' | 'lost';
  record: typeof RECORD;
  previews: string;
  previewsSite?: string;
  lostAt?: string;
};

type Worker = {
  domains: Domain[];
  /** What the DNS says at the next check. */
  dns: 'found' | 'missing' | 'silent';
  /** Every body the console sent to `…/previews`. */
  covered: unknown[];
  role: 'owner' | 'member';
};

async function stubWorker(page: Page, locale: 'en' | 'fr', start: Partial<Worker> = {}): Promise<Worker> {
  const worker: Worker = { domains: [], dns: 'missing', covered: [], role: 'owner', ...start };
  const me = () => ({
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale },
    workspaces: [{ id: 'w1', name: 'Acme', role: worker.role }],
  });
  const sites = [
    { id: 's1', origin: 'https://acme.dev', visibility: 'members' },
    { id: 's2', origin: 'https://docs.acme.dev', visibility: 'everyone' },
  ];
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/console/session/refresh') return json({ accessToken: 'token' });
    if (pathname === '/console/me') return json(me());
    if (pathname === '/console/workspaces/w1/sites') return json({ sites });
    if (pathname === BASE) {
      if (request.method() === 'GET') return json({ domains: worker.domains });
      const { domain } = request.postDataJSON() as { domain: string };
      if (!domain.includes('.')) return json({ error: 'invalid-domain' }, 400);
      const added: Domain = {
        id: `d${worker.domains.length + 1}`,
        domain,
        state: 'pending',
        record: RECORD,
        previews: `https://*.${domain}`,
      };
      worker.domains.push(added);

      return json(added, 201);
    }
    const one = /^\/console\/workspaces\/w1\/domains\/(\w+)(\/check|\/previews)?$/.exec(pathname);
    const found = worker.domains.find((each) => each.id === one?.[1]);
    if (one === null || found === undefined) return route.fulfill({ status: 204 });
    if (one[2] === '/check') {
      if (worker.dns === 'found') found.state = 'proven';

      return json({ ...found, ...(worker.dns === 'silent' ? { unanswered: true } : {}) });
    }
    if (one[2] === '/previews') {
      const body = request.postDataJSON() as { site: string | null };
      worker.covered.push(body);
      if (body.site === null) delete found.previewsSite;
      else found.previewsSite = body.site;

      return json(found);
    }
    worker.domains = worker.domains.filter((each) => each !== found);

    return route.fulfill({ status: 204 });
  });

  return worker;
}

async function open(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/sites`);
  await expect(page.locator('main h1')).toBeVisible();
}

/** The proof of a domain is under the row of a site, behind « Preview builds » of its menu (FRU-243). */
async function openPreviews(page: Page, locale: 'en' | 'fr' = 'en'): Promise<void> {
  await open(page);
  await page.getByRole('button', { name: locale === 'en' ? 'More for acme.dev' : 'Plus pour acme.dev' }).click();
  await page.getByRole('menuitem', { name: locale === 'en' ? 'Preview builds' : 'Previews' }).click();
}

test('a domain is added, shows its record, is proven by the worker, and covers the previews of a site', async ({
  page,
}) => {
  const worker = await stubWorker(page, 'en');
  await openPreviews(page);
  const section = page.getByRole('region', { name: 'Preview deploys' });
  await expect(section.getByText('No domain yet. A site covers its own address only.')).toBeVisible();

  // What is not a domain keeps what was typed, and says why.
  const field = section.getByRole('textbox', { name: 'Domain' });
  await field.fill('nothing');
  await section.getByRole('button', { name: 'Add the domain' }).click();
  await expect(section.getByRole('alert')).toContainText('This is not a domain.');
  await expect(field).toHaveValue('nothing');

  await field.fill('preview.acme.dev');
  await section.getByRole('button', { name: 'Add the domain' }).click();
  const row = section.locator('[data-domain="preview.acme.dev"]');
  await expect(row.getByText('Not proven yet')).toBeVisible();
  await expect(row.getByText(RECORD.name, { exact: true })).toBeVisible();
  await expect(row.getByText(RECORD.value, { exact: true })).toBeVisible();
  await expect(field).toHaveValue('');
  // Not proven: no site to choose.
  await expect(row.getByRole('button', { name: /Site whose previews/ })).toHaveCount(0);

  // The DNS does not answer: nothing changed, and the screen says which of the two it was.
  worker.dns = 'silent';
  await row.getByRole('button', { name: 'Check the DNS' }).click();
  await expect(row.getByText('The DNS did not answer just now.')).toBeVisible();
  await expect(row.getByText('Not proven yet')).toBeVisible();

  worker.dns = 'found';
  await row.getByRole('button', { name: 'Check the DNS' }).click();
  await expect(row.getByText('Proven', { exact: true })).toBeVisible();
  await expect(row.getByText(RECORD.value, { exact: true })).toHaveCount(0);

  await row.getByRole('button', { name: /Site whose previews are \*\.preview\.acme\.dev/ }).click();
  await page.getByRole('option', { name: 'acme.dev', exact: true }).click();
  await expect.poll(() => worker.covered).toEqual([{ site: 's1' }]);
});

test('a proof that is lost says so, in French, and offers no site', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubWorker(page, 'fr', {
    domains: [
      {
        id: 'd1',
        domain: 'preview.acme.dev',
        state: 'lost',
        record: RECORD,
        previews: 'https://*.preview.acme.dev',
        previewsSite: 's1',
        lostAt: '2026-10-10T10:00:00.000Z',
      },
    ],
  });
  await openPreviews(page, 'fr');
  const row = page.locator('[data-domain="preview.acme.dev"]');

  await expect(row.getByText('Preuve perdue')).toBeVisible();
  await expect(row.getByRole('alert')).toContainText('L’enregistrement a disparu du DNS depuis');
  // The record is shown again, to put it back.
  await expect(row.getByText(RECORD.value, { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: /Site dont les previews/ })).toHaveCount(0);
  // Nothing scrolls sideways on a phone, whatever the length of the value.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
    0,
  );
});

test('a member who is no admin has no way to the domain section', async ({ page }) => {
  await stubWorker(page, 'en', { role: 'member' });
  await open(page);
  await expect(page.getByText('acme.dev', { exact: true })).toBeVisible();

  // The menu of a site has « Install » alone for a member: no way to the proof of a domain.
  await page.getByRole('button', { name: 'More for acme.dev' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Install']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Preview deploys' })).toHaveCount(0);
});
