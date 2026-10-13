import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { CONSOLE, type Worker, cloudWorker, finished, served } from './cloud-worker.ts';

/**
 * An invited reviewer, from the message they received to their first note (FRU-104).
 *
 * Two people, two browsers: the owner makes a workspace and a site, and invites Paul by his address.
 * Paul opens the link of the message, signs in with that address, joins, and connects his browser.
 * The worker is a process of this spec on PGlite (`cloud-worker.ts`), and each message is read where
 * the worker was asked to send it.
 *
 * **The note is sent as the extension sends it**, with the session that the pairing code of the
 * console opens: this spec loads no extension. `extension.spec.ts` holds the extension itself, from
 * the pairing page to the note, against the worker of the playground.
 */

const SITE = 'https://staging.acme.dev';

/** The last message sent to `to`. */
async function lastTo(worker: Worker, to: string): Promise<string> {
  let found: string | undefined;
  await expect
    .poll(async () => {
      found = (await worker.mail()).filter((each) => each.to === to).at(-1)?.text;

      return found !== undefined;
    })
    .toBe(true);

  return found as string;
}

/** Signs `email` in by the link of the setup, in this browser. */
async function signIn(page: Page, worker: Worker, email: string, workspace?: string): Promise<void> {
  const before = (await worker.mail()).filter((each) => each.to === email).length;
  await page.goto(`${CONSOLE}/setup`);
  await page.getByRole('textbox', { name: 'Work email' }).fill(email);
  if (workspace !== undefined) await page.getByRole('textbox', { name: 'Workspace name' }).fill(workspace);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(async () => (await worker.mail()).filter((each) => each.to === email).length).toBe(before + 1);
  const link = /http:\/\/\S+\/sign-in#\S+/.exec(await lastTo(worker, email))?.[0];
  expect(link, 'no sign-in link in the message').toBeDefined();
  await page.goto(link as string);
}

test.describe('an invited reviewer (FRU-104)', () => {
  let worker: Worker;
  const contexts: BrowserContext[] = [];

  test.beforeEach(async () => {
    worker = await cloudWorker();
  });
  test.afterEach(async () => {
    for (const context of contexts.splice(0)) {
      await finished(context, undefined);
      await context.close();
    }
    await worker.close();
  });

  test('goes from the link of the message to their first note, and sees what a member sees', async ({ browser }) => {
    const owners = await browser.newContext({ locale: 'en-US' });
    const pauls = await browser.newContext({ locale: 'en-US' });
    contexts.push(owners, pauls);
    await served(owners, worker);
    await served(pauls, worker);
    const owner = await owners.newPage();
    const paul = await pauls.newPage();

    // The owner: a workspace, a site, and an invitation.
    await signIn(owner, worker, 'owner@acme.dev', 'Acme');
    await expect(owner.getByRole('heading', { name: 'Where should feedback go?' })).toBeVisible();
    await owner.goto(CONSOLE);
    await expect(owner).toHaveURL(/\/w\/ws_[0-9a-f]{20}\/sites$/);
    const workspace = /\/w\/(ws_[0-9a-f]{20})\//.exec(owner.url())?.[1] as string;
    await owner.getByRole('textbox', { name: 'Site address' }).fill(SITE);
    await owner.getByRole('button', { name: 'Add the site' }).click();
    await expect(owner.getByText('staging.acme.dev', { exact: true })).toBeVisible();

    await owner.goto(`${CONSOLE}/w/${workspace}/members`);
    await owner.getByRole('textbox', { name: 'Address of the person to invite' }).fill('paul@client.dev');
    await owner.getByRole('button', { name: 'Invite', exact: true }).click();
    const kept = owner.getByRole('status');
    await expect(kept).toContainText('Invitation sent to paul@client.dev.');
    // The link to send by hand is the one of the message: it names no invitation (FRU-107).
    await expect(kept).toContainText(`${CONSOLE}/invitations`);
    await expect(owner.getByText('paul@client.dev', { exact: true })).toBeVisible();
    await expect(owner.getByText('Invited', { exact: true })).toBeVisible();

    // Paul: the message names the workspace, and its link holds nothing to spend.
    const message = await lastTo(worker, 'paul@client.dev');
    // The names a person wrote hold a zero-width space after each `.` and `@`: no client links them.
    expect(message.replaceAll('\u200B', '')).toContain(
      'owner@acme.dev invites you to the workspace « Acme » on Fruitback, as a member.',
    );
    const link = /http:\/\/\S+/.exec(message)?.[0];
    expect(link).toBe(`${CONSOLE}/invitations`);

    await paul.goto(link as string);
    await expect(
      paul.getByText('Sign in with the address the invitation was sent to, and it shows here.'),
    ).toBeVisible();
    await paul.getByRole('link', { name: 'Sign in' }).click();
    await expect(paul).toHaveURL(`${CONSOLE}/sign-in`);
    // No workspace name: Paul comes to join one.
    await signIn(paul, worker, 'paul@client.dev');
    await expect(paul).toHaveURL(`${CONSOLE}/invitations`);
    await expect(paul.getByText('Acme', { exact: true })).toBeVisible();
    await paul.getByRole('button', { name: 'Join Acme' }).click();
    await expect(paul).toHaveURL(`${CONSOLE}/w/${workspace}/sites`);
    await expect(paul.getByText('staging.acme.dev', { exact: true })).toBeVisible();

    // The owner sees Paul as a member, and the invitation is gone.
    await owner.reload();
    await expect(owner.getByText('paul@client.dev', { exact: true })).toBeVisible();
    await expect(owner.getByText('Invited', { exact: true })).toHaveCount(0);

    // Paul connects his browser: the pairing page opens with a code after the `#`.
    await paul.getByRole('button', { name: 'Install' }).click();
    const opened = pauls.waitForEvent('page');
    await paul.getByRole('button', { name: 'Connect this browser' }).click();
    const pairing = await opened;
    await pairing.waitForURL(/\/pair#/);
    const code = new URL(pairing.url()).hash.slice(1);
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    // What the extension does with that code, then with its session: pair, list the sites, send a note.
    const paired = (await (
      await fetch(`${worker.origin}/session/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
    ).json()) as { accessToken: string; identity: { email?: string; workspace?: string } };
    expect(paired.identity).toMatchObject({ email: 'paul@client.dev', workspace });
    const bearer = { Authorization: `Bearer ${paired.accessToken}` };
    const sites = (await (await fetch(`${worker.origin}/session/sites`, { headers: bearer })).json()) as {
      sites: { id: string; origin: string }[];
    };
    const site = sites.sites.find((each) => each.origin === SITE);
    expect(site, 'Paul does not reach the site of the workspace').toBeDefined();

    const note = {
      kind: 'fruitback.seed',
      v: 2,
      id: 'sd_paul_first',
      createdAt: new Date().toISOString(),
      note: 'The button is too small on a phone.',
      page: { url: `${SITE}/pricing`, path: '/pricing' },
      viewport: { width: 1440, height: 900 },
      anchor: { selector: 'main > button', tag: 'button', bounds: { xPct: 40, yPct: 60, wPct: 12, hPct: 4 } },
      client: { id: site?.id },
    };
    const written = await fetch(`${worker.origin}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE, ...bearer },
      body: JSON.stringify(note),
    });
    expect(written.status, await written.clone().text()).toBe(201);

    // The note is Paul's, and the worker vouches for it.
    const read = (await (
      await fetch(`${worker.origin}/feedback?url=${encodeURIComponent(`${SITE}/pricing`)}&client=${site?.id}`, {
        headers: { Origin: SITE, ...bearer },
      })
    ).json()) as { issues?: { seed: { note: string; reporter?: { email?: string; verified?: boolean } } }[] };
    const mine = (read.issues ?? []).find((each) => each.seed.note === note.note);
    expect(mine?.seed.reporter).toMatchObject({ email: 'paul@client.dev', verified: true });
  });

  test('says that the fourth message did not go, and gives the link to send by hand (FRU-209)', async ({ browser }) => {
    const owners = await browser.newContext({ locale: 'en-US' });
    contexts.push(owners);
    await served(owners, worker);
    const owner = await owners.newPage();
    await signIn(owner, worker, 'owner@acme.dev', 'Acme');
    await expect(owner.getByRole('heading', { name: 'Where should feedback go?' })).toBeVisible();
    await owner.goto(CONSOLE);
    await expect(owner).toHaveURL(/\/w\/ws_[0-9a-f]{20}\/sites$/);
    const workspace = /\/w\/(ws_[0-9a-f]{20})\//.exec(owner.url())?.[1] as string;
    const toPaul = async (): Promise<number> =>
      (await worker.mail()).filter((each) => each.to === 'paul@client.dev').length;

    await owner.goto(`${CONSOLE}/w/${workspace}/members`);
    await owner.getByRole('textbox', { name: 'Address of the person to invite' }).fill('paul@client.dev');
    await owner.getByRole('button', { name: 'Invite', exact: true }).click();
    const notice = owner.getByRole('status');
    await expect(notice).toContainText('Invitation sent to paul@client.dev.');
    // Two more messages go: three in the window of this workspace for this address.
    for (const sent of [2, 3]) {
      await owner.getByRole('button', { name: 'Resend' }).click();
      await expect.poll(toPaul).toBe(sent);
      await expect(notice).toContainText('Invitation sent to paul@client.dev.');
    }

    // The fourth is kept and not sent: the worker answers `mailed: false`, and the console says so.
    await owner.getByRole('button', { name: 'Resend' }).click();
    await expect(notice).toContainText('Invitation kept for paul@client.dev, but no message was sent');
    await expect(notice).toContainText(`${CONSOLE}/invitations`);
    await expect(notice.getByRole('button', { name: 'Copy the link' })).toBeVisible();
    expect(await toPaul()).toBe(3);
    await expect(owner.getByText('Invited', { exact: true })).toBeVisible();
  });
});
