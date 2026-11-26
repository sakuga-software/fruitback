import { type Page, type Route, expect, test } from '@playwright/test';
import { noteFixture } from '../packages/shared/src/note.fixture.ts';
import { ACME, stubWorker } from './console-workspace.ts';

/**
 * The reply at the foot of the panel of a note (FRU-712): one line and « Send », written under the
 * note in the name of the person. The worker is answered by stubs at the shape of
 * `POST …/notes/<note>/replies`; its rights and its way to the tracker are measured by
 * `apps/worker/src/console-replies.test.ts`.
 */
const CONSOLE = 'http://localhost:5178';
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }];
const AT = '2026-11-20T10:00:00.000Z';
const NOTE = noteFixture({
  id: 'sd_1',
  text: 'The price of the yearly plan is cut off on a phone.',
  page: { url: 'https://staging.acme.dev/pricing', path: '/pricing' },
});

type Reply = { status: number; error?: string };

/**
 * Two notes in Linear, and one the worker keeps with no read of its replies (a site that hides them).
 * `replies` answers each `POST` in turn; with none left, the reply is written.
 */
async function worker(p: Page, replies: Reply[] = []): Promise<{ path: string; body: unknown }[]> {
  const sent: { path: string; body: unknown }[] = [];
  const thread: { id: string; body: string; createdAt: string; author: string }[] = [
    { id: 'c1', body: 'We see it too.', createdAt: AT, author: 'Ben Martin' },
  ];
  const row = (id: string, excerpt: string, ref: string) => ({
    id,
    excerpt,
    page: { url: NOTE.page.url, host: 'staging.acme.dev', path: '/pricing' },
    site: { id: 's1' },
    stage: 'new',
    author: { kind: 'member', name: 'Ben' },
    place: { kind: 'linear', connector: 'c1', label: 'Acme' },
    ref,
    createdAt: AT,
  });
  const read = (identifier: string, text: string, comments: unknown) => ({
    note: {
      id: identifier,
      identifier,
      title: '',
      stage: 'new',
      stateName: '',
      updatedAt: AT,
      note: { ...NOTE, text },
      ...(comments === undefined ? {} : { comments }),
    },
  });
  await stubWorker(p, {
    workspaces: [{ ...ACME, role: 'member' }],
    sites: SITES,
    answer: (pathname: string, route: Route) => {
      const request = route.request();
      if (pathname === '/console/workspaces/w1/notes') {
        return route.fulfill({
          json: {
            notes: [
              row('n1', 'The price of the yearly plan is cut off on a phone.', 'ACM-12'),
              row('n2', 'The returns policy says "recieve".', 'ACM-13'),
              { ...row('n3', 'The logo is blurry.', 'FB-3'), place: { kind: 'fruitback' }, ref: undefined },
            ],
            total: 3,
            counts: { all: 3 },
          },
        });
      }
      if (pathname === '/console/workspaces/w1/notes/n1') {
        return route.fulfill({ json: read('ACM-12', NOTE.text, thread) });
      }
      if (pathname === '/console/workspaces/w1/notes/n2') {
        return route.fulfill({ json: read('ACM-13', 'The returns policy says "recieve".', []) });
      }
      if (pathname === '/console/workspaces/w1/notes/n3') {
        // A site that hides its replies: the read has none, not even an empty list.
        return route.fulfill({ json: read('FB-3', 'The logo is blurry.', undefined) });
      }
      if (/^\/console\/workspaces\/w1\/notes\/n\d\/replies$/.test(pathname)) {
        const body = request.postDataJSON() as { body: string };
        sent.push({ path: pathname, body });
        const refused = replies.shift();
        if (refused !== undefined) return route.fulfill({ status: refused.status, json: { error: refused.error } });
        const comment = { id: `c${thread.length + 1}`, body: body.body, createdAt: AT, author: 'Ana' };
        thread.push(comment);

        return route.fulfill({ status: 201, json: { comment } });
      }

      return undefined;
    },
  });

  return sent;
}

test('a reply leaves from the foot of the panel, and a refusal keeps the text', async ({ page: p }) => {
  const sent = await worker(p, [{ status: 502, error: 'store-unavailable' }]);
  await p.goto(`${CONSOLE}/w/w1/notes?task=n1`);
  const panel = p.getByRole('dialog', { name: /The price of the yearly plan/ });
  const reply = panel.locator('[data-task-reply]');
  const field = reply.getByRole('textbox', { name: 'Reply to this note' });
  const send = reply.getByRole('button', { name: 'Send' });

  // One line, under the replies, and it names the tracker the reply goes to.
  await expect(field).toHaveAttribute('placeholder', 'Reply, it posts to Linear too');
  await expect(send).toBeDisabled();
  await field.fill('Fixed on staging, try again?');

  // The worker does not answer: the text stays, and the sentence says so.
  await send.click();
  await expect(reply.getByRole('alert')).toHaveText(
    'The reply did not leave. Your text is kept: try again in a moment.',
  );
  await expect(field).toHaveValue('Fixed on staging, try again?');
  await expect(panel.locator('[data-task-replies] li')).toHaveCount(1);

  // Enter sends it again: the reply is under the note, and the field is empty.
  await field.press('Enter');
  await expect(panel.locator('[data-task-replies] li')).toHaveCount(2);
  await expect(panel.locator('[data-task-replies] li').last()).toContainText('Fixed on staging, try again?');
  await expect(field).toHaveValue('');
  await expect(reply.getByRole('alert')).toHaveCount(0);
  expect(sent).toEqual([
    { path: '/console/workspaces/w1/notes/n1/replies', body: { body: 'Fixed on staging, try again?' } },
    { path: '/console/workspaces/w1/notes/n1/replies', body: { body: 'Fixed on staging, try again?' } },
  ]);
});

test('says why a reply was refused, and keeps the text of each note while the person moves', async ({ page: p }) => {
  await worker(p, [{ status: 403, error: 'replies-not-taken' }]);
  await p.goto(`${CONSOLE}/w/w1/notes?task=n1`);
  const panel = p.getByRole('dialog');
  const field = panel.locator('[data-task-reply]').getByRole('textbox', { name: 'Reply to this note' });
  await field.fill('A draft');
  await panel.locator('[data-task-reply]').getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByRole('alert')).toHaveText('This note takes no reply.');
  await expect(field).toHaveValue('A draft');

  // Escape in a reply that holds a text closes nothing: the text would be lost.
  await field.press('Escape');
  await expect(panel).toBeVisible();
  await expect(field).toHaveValue('A draft');

  // Another note has its own field; coming back finds the draft.
  await panel.getByRole('button', { name: 'Next note' }).click();
  await expect(panel.locator('[data-task-reference]')).toHaveText('ACM-13');
  await expect(field).toHaveValue('');
  await panel.getByRole('button', { name: 'Previous note' }).click();
  await expect(panel.locator('[data-task-reference]')).toHaveText('ACM-12');
  await expect(field).toHaveValue('A draft');

  // An empty reply lets Escape close the panel, as before.
  await field.fill('');
  await field.press('Escape');
  await expect(panel).toBeHidden();
});

test('a note whose read has no replies shows no field to write one', async ({ page: p }) => {
  await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes?task=n3`);
  const panel = p.getByRole('dialog', { name: /The logo is blurry/ });
  await expect(panel.locator('[data-task-reference]')).toHaveText('FB-3');
  await expect(panel.locator('[data-task-reply]')).toHaveCount(0);
});
