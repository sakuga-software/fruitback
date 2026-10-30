import { createHash, randomBytes } from 'node:crypto';
import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { CONSOLE, type Worker, cloudWorker, finished, linkIn, served } from './cloud-worker.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * « Connect an agent » (FRU-467) from end to end: a client of OAuth plays the connector of claude.ai
 * (it registers, sends the browser to `/oauth/authorize`, takes the code at its address, and turns it
 * into tokens), the console page of this pull request asks the person, and a worker of the Cloud on
 * PGlite decides. No stub decides an answer: only the page of claude.ai that receives the code is a
 * page of the test.
 *
 * The sample data is of nobody: `acme.dev`, invented names.
 */

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/** Signs in to the console by a link: the workspace of the domain is made. */
async function signedIn(context: BrowserContext, worker: Worker, email: string): Promise<Page> {
  const page = await context.newPage();
  const before = (await worker.sent()).length;
  await page.goto(`${CONSOLE}/setup`);
  await page.getByRole('textbox', { name: 'Work email' }).fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect.poll(async () => (await worker.sent()).length).toBe(before + 1);
  await page.goto(await linkIn(worker));
  await expect(page.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();

  return page;
}

/** What the connector does on its server: no browser, no `Origin`. */
async function fromClient(worker: Worker, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${worker.origin}${path}`, { redirect: 'manual', ...init });
}

async function mcp(worker: Worker, token: string): Promise<number> {
  const answer = await fromClient(worker, '/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

  return answer.status;
}

test.describe('Connect an agent with OAuth, from a connector to /mcp (FRU-467)', () => {
  let worker: Worker | undefined;

  test.afterEach(async ({ context }) => finished(context, worker));

  test('the person reads the host, chooses a site and allows; the token reads /mcp until « Revoke »', async ({
    context,
  }) => {
    worker = await cloudWorker();
    await served(context, worker);
    const page = await signedIn(context, worker, 'ana@acme.dev');
    const workspace = await page.evaluate(async (origin) => {
      const me = await fetch(`${origin}/console/me`, { credentials: 'include' });
      const { workspaces } = (await me.json()) as { workspaces: { id: string }[] };
      const id = workspaces[0]?.id as string;
      for (const url of ['https://shop.acme.dev', 'https://docs.acme.dev']) {
        await fetch(`${origin}/console/workspaces/${id}/sites`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, visibility: 'members' }),
        });
      }

      return id;
    }, WORKER_ORIGIN);

    // The connector finds the server of authorization from a 401 of /mcp, as claude.ai does.
    const refused = await fromClient(worker, '/mcp', { method: 'POST', body: '{}' });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
    const registered = await fromClient(worker, '/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }),
    });
    expect(registered.status).toBe(201);
    const { client_id: client } = (await registered.json()) as { client_id: string };

    // The page of claude.ai that takes the code: the one page of the test.
    let back: URL | undefined;
    await context.route('https://claude.ai/**', async (route) => {
      back = new URL(route.request().url());
      await route.fulfill({ contentType: 'text/html', body: '<h1>claude.ai: connected</h1>' });
    });

    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URLSearchParams({
      response_type: 'code',
      client_id: client,
      redirect_uri: CALLBACK,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'state-of-claude',
      scope: 'read write',
      resource: `${WORKER_ORIGIN}/mcp`,
    });
    await page.goto(`${WORKER_ORIGIN}/oauth/authorize?${authorize.toString()}`);
    await expect(page).toHaveURL(new RegExp(`^${CONSOLE}/authorize/`));
    await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible();
    // Who asks: the host its code goes to, in large; the name it gave itself, small.
    await expect(page.locator('[data-client-host]')).toHaveText('claude.ai');
    await expect(page.getByText('Calls itself « Claude »')).toBeVisible();

    // No site ticked: nothing is sent, and the field says why.
    await page.getByRole('button', { name: 'Allow claude.ai' }).click();
    await expect(page.getByText('Tick at least one site.')).toBeVisible();
    await page.getByText('shop.acme.dev', { exact: true }).click();
    await page.getByRole('button', { name: 'Allow claude.ai' }).click();

    await expect(page.getByRole('heading', { name: 'claude.ai: connected' })).toBeVisible();
    expect(back?.searchParams.get('state')).toBe('state-of-claude');
    expect(back?.searchParams.get('iss')).toBe(WORKER_ORIGIN);
    const code = back?.searchParams.get('code') as string;
    expect(code).toMatch(/^fbc_/);

    const exchanged = await fromClient(worker, '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CALLBACK,
        client_id: client,
        code_verifier: verifier,
      }).toString(),
    });
    expect(exchanged.status).toBe(200);
    const tokens = (await exchanged.json()) as { access_token: string; scope: string };
    expect(tokens.scope).toBe('read');
    expect(await mcp(worker, tokens.access_token)).toBe(200);

    // The connection is a row of « Agents », with its chip, and « Revoke » ends its token.
    await page.goto(`${CONSOLE}/w/${workspace}/settings/agents`);
    const row = page.getByRole('listitem').filter({ hasText: 'OAuth · claude.ai' });
    await expect(row).toBeVisible();
    await expect(row.getByText('shop.acme.dev')).toBeVisible();
    await row.getByRole('button', { name: 'Revoke', exact: true }).click();
    await row.getByRole('button', { name: 'Revoke « Claude »' }).click();
    await expect(row).toHaveCount(0);
    expect(await mcp(worker, tokens.access_token)).toBe(401);
  });

  test('« Deny » sends the connector back with access_denied, and makes no connection', async ({ context }) => {
    worker = await cloudWorker();
    await served(context, worker);
    const page = await signedIn(context, worker, 'ana@acme.dev');
    const registered = await fromClient(worker, '/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }),
    });
    const { client_id: client } = (await registered.json()) as { client_id: string };
    let back: URL | undefined;
    await context.route('https://claude.ai/**', async (route) => {
      back = new URL(route.request().url());
      await route.fulfill({ contentType: 'text/html', body: '<h1>claude.ai: denied</h1>' });
    });
    const authorize = new URLSearchParams({
      response_type: 'code',
      client_id: client,
      redirect_uri: CALLBACK,
      code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
      code_challenge_method: 'S256',
      state: 's',
      scope: 'read',
    });
    await page.goto(`${WORKER_ORIGIN}/oauth/authorize?${authorize.toString()}`);
    // A client that asked to read only is offered no « Read and write ».
    await expect(
      page.getByText('claude.ai asked to read only: the notes, their replies and their status.'),
    ).toBeVisible();
    await expect(page.getByText('Read and write')).toHaveCount(0);
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect(page.getByRole('heading', { name: 'claude.ai: denied' })).toBeVisible();
    expect(back?.searchParams.get('error')).toBe('access_denied');
    expect(back?.searchParams.get('code')).toBeNull();
  });
});
