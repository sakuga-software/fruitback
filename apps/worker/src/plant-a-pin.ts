import type { Seed } from '@fruitback/shared';

/**
 * From a worker that has just started to a pin that a visitor planted, and read back (FRU-48, FRU-225).
 *
 * The CI image job runs this against `docker-compose.yml`, started from a directory that holds only
 * that file and a `.env`. Since FRU-225 a worker serves the sites of its database and nothing else,
 * so the first run does what a person does after `docker compose up`, with the API the console calls:
 *
 * 1. opens the sign-in link of the first administrator, which the worker wrote in its log;
 * 2. makes the first workspace, and a site at the address of `PIN_SEED`, that everyone reads;
 * 3. plants a pin there as a visitor: no account, no session, no token;
 * 4. reads it back, as a visitor.
 *
 * It prints the id of the site. Recreate the containers, then run it with `--read <site>`: the pin
 * must still be there, which proves the notes are in the database and not in a container.
 *
 *   node apps/worker/src/plant-a-pin.ts http://127.0.0.1:8080 --first-admin '<the link of the log>'
 *   node apps/worker/src/plant-a-pin.ts http://127.0.0.1:8080 --read <site>
 *
 * The only import is a type, which Node erases, so the script runs with no `pnpm install`.
 */
export const PIN_SEED: Seed = {
  kind: 'fruitback.seed',
  v: 2,
  id: 'sd_compose_smoke',
  createdAt: '2026-09-14T00:00:00.000Z',
  note: 'Planted by the compose smoke test',
  page: { url: 'https://staging.example.com/', path: '/' },
  viewport: { width: 1280, height: 800 },
  anchor: { selector: 'main > h1', tag: 'h1', bounds: { xPct: 0, yPct: 0, wPct: 100, hPct: 8 } },
};

/** The origin of the page of the pin: the site the administrator adds, and the `Origin` of the visitor. */
export const PIN_ORIGIN = new URL(PIN_SEED.page.url).origin;

/** The cookies of an answer, as a browser sends them back: `name=value`, with no attribute. */
export function cookiesOf(answer: Response): string {
  return answer.headers
    .getSetCookie()
    .map((each) => each.split(';')[0] ?? '')
    .filter((each) => each !== '')
    .join('; ');
}

async function expect(answer: Response, status: number, what: string): Promise<unknown> {
  const body = await answer.text();
  if (answer.status !== status) throw new Error(`${what} answered ${answer.status}: ${body}`);

  return body === '' ? undefined : (JSON.parse(body) as unknown);
}

/**
 * Signs the first administrator in with the link of the log, makes a workspace and a site that
 * everyone reads, and answers the id of the site.
 */
export async function makeASite(endpoint: string, link: string): Promise<string> {
  const hash = link.indexOf('#');
  if (hash < 0) throw new Error(`not a sign-in link of the console: ${link}`);
  // The console calls the worker from its own origin, and the worker answers that origin alone.
  const fromConsole = { Origin: new URL(link).origin, 'Content-Type': 'application/json' };

  const redeemed = await fetch(`${endpoint}/console/auth/email/redeem`, {
    method: 'POST',
    headers: fromConsole,
    body: JSON.stringify({ token: link.slice(hash + 1) }),
  });
  const cookie = cookiesOf(redeemed);
  await expect(redeemed, 200, 'the link of the first administrator');
  if (cookie === '') throw new Error('the link signed nobody in: no cookie came back');

  const signedIn = { ...fromConsole, Cookie: cookie };
  const workspace = (await expect(
    await fetch(`${endpoint}/console/workspaces`, {
      method: 'POST',
      headers: signedIn,
      body: JSON.stringify({ name: 'Compose' }),
    }),
    201,
    'POST /console/workspaces',
  )) as { id: string };
  const site = (await expect(
    await fetch(`${endpoint}/console/workspaces/${workspace.id}/sites`, {
      method: 'POST',
      headers: signedIn,
      body: JSON.stringify({ url: PIN_ORIGIN, visibility: 'everyone' }),
    }),
    201,
    'POST /console/workspaces/<id>/sites',
  )) as { id: string };

  return site.id;
}

/** Plants the pin on the site as a visitor, when asked, then reads it back as a visitor. */
export async function plantAPin(endpoint: string, site: string, options: { plant: boolean }): Promise<void> {
  const health = await fetch(`${endpoint}/health`);
  const status = await health.text();
  if (health.status !== 200) throw new Error(`/health answered ${health.status}: ${status}`);
  // A visitor: the page of the site, with nothing that names a person.
  const visitor = { Origin: PIN_ORIGIN };

  if (options.plant) {
    const posted = await fetch(`${endpoint}/feedback`, {
      method: 'POST',
      headers: { ...visitor, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...PIN_SEED, client: { id: site } }),
    });
    if (posted.status !== 201) throw new Error(`POST /feedback answered ${posted.status}: ${await posted.text()}`);
  }

  const read = await fetch(
    `${endpoint}/feedback?url=${encodeURIComponent(PIN_SEED.page.url)}&client=${encodeURIComponent(site)}`,
    { headers: visitor },
  );
  const body = await read.text();
  const issues =
    read.status === 200 ? ((JSON.parse(body) as { issues?: { seed?: { id?: string } }[] }).issues ?? []) : [];
  if (!issues.some((issue) => issue.seed?.id === PIN_SEED.id)) {
    throw new Error(`GET /feedback answered ${read.status} without the pin: ${body}`);
  }
}

if (import.meta.main) {
  const [endpoint, flag, value] = process.argv.slice(2);
  if (endpoint === undefined || value === undefined || (flag !== '--first-admin' && flag !== '--read')) {
    console.error('usage: node plant-a-pin.ts <endpoint> --first-admin <link> | --read <site>');
    process.exit(2);
  }

  try {
    if (flag === '--first-admin') {
      const site = await makeASite(endpoint, value);
      await plantAPin(endpoint, site, { plant: true });
      console.error(`planted a pin on the site ${site} and read it back`);
      console.log(site);
    } else {
      await plantAPin(endpoint, value, { plant: false });
      console.log('the pin is still there');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
