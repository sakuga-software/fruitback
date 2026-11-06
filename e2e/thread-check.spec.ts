import { type Page, expect } from '@playwright/test';
import { addRule, openBareSite, openPopup, test } from './extension.ts';
import { WORKER_ORIGIN, caseOf, hydrated, pinFor } from './pin.ts';
import { paired, plantOn } from './side-panel.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The verdict of the author in the thread of the pin (FRU-603), in the three modes.
 *
 * The worker decides who may give one (FRU-294): the author it can name by a session of the
 * workspace. The read says it with `mine`, and the thread asks that reader and nobody else.
 *
 * - **Team mode**, the only mode where a session reaches the worker: the author confirms one note
 *   and reopens another, on the worker with accounts of the suite, end to end.
 * - **Public mode and private mode**: no session, so the read says no `mine`, and the thread says
 *   who marked the note done and asks nothing. In public mode the control is the same thread when
 *   the read says `mine`: the widget asks then. Private mode mounts the widget with `replies: false`,
 *   so it never asks there. The store in memory of the first worker moves no note to done, so its
 *   read is changed in the browser, as `thread.spec.ts` does.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';

/** The thread of the note whose pin says `note`, opened by a click on its drop. */
async function openThread(page: Page, note: string) {
  await pinFor(page, note).getByRole('button').click();
  const thread = page.locator('.fruitback-thread');
  await expect(thread).toBeVisible();

  return thread;
}

/**
 * Every note of the first worker's read is done, with a reply of the team, and `mine` when asked.
 * `/check` answers as the worker does (FRU-294), so the control can press « Looks fixed ».
 */
async function doneInTheRead(page: Page, mine: boolean): Promise<{ checks: string[]; saidMine: unknown[] }> {
  const checks: string[] = [];
  // What the worker itself said of `mine`, before the read is changed here.
  const saidMine: unknown[] = [];
  await page.route(`${WORKER_ORIGIN}/feedback?**`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { issues: Record<string, unknown>[]; canReply?: boolean };
    for (const issue of body.issues) {
      saidMine.push(issue.mine);
      issue.stage = 'done';
      issue.stateName = 'Done';
      issue.comments = [
        { id: 'team-1', body: 'Fixed in the last build.', createdAt: new Date().toISOString(), author: 'Marc Petit' },
      ];
      if (mine) issue.mine = true;
      else delete issue.mine;
      delete issue.checked;
    }
    body.canReply = true;
    await route.fulfill({ response, json: body });
  });
  await page.route(`${WORKER_ORIGIN}/feedback/*/check?**`, async (route) => {
    const { verdict } = route.request().postDataJSON() as { verdict: string };
    checks.push(verdict);
    await route.fulfill({
      status: 201,
      json: {
        comment: {
          id: 'verdict-1',
          body: `**Camille** via Fruitback · not verified\n${verdict === 'fixed' ? 'Checked: looks fixed' : 'Reopened: still wrong'}`,
          createdAt: new Date().toISOString(),
          author: 'Fruitback',
        },
        stage: verdict === 'fixed' ? 'done' : 'new',
      },
    });
  });

  return { checks, saidMine };
}

/** The playground with the widget of the page, as a client installs it: public mode. */
async function publicPage(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await hydrated(page);
  await page.addScriptTag({ path: IIFE });
  await page.evaluate((endpoint) => {
    const scope = globalThis as unknown as { Fruitback: { init(options: Record<string, unknown>): unknown } };
    scope.Fruitback.init({ endpoint, clientId: 'playground', locale: 'en-US' });
  }, WORKER_ORIGIN);
}

async function plantPublic(page: Page, note: string): Promise<void> {
  await page.getByRole('button', { name: 'Leave a note' }).click();
  await page.locator('[data-testid="card-espresso"] .add').click();
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 10_000 });
}

test.describe('public mode (FRU-603)', () => {
  test('says who marked the note done and asks nothing, as the worker names no author', async ({ page }) => {
    await publicPage(page, 'thread-check-public');
    await plantPublic(page, 'Verdict in public mode');
    const { saidMine } = await doneInTheRead(page, false);
    await publicPage(page, 'thread-check-public');

    const thread = await openThread(page, 'Verdict in public mode');
    await expect(thread.locator('.fruitback-thread-done')).toHaveText('Marc Petit marked it done');
    await expect(thread.getByRole('button', { name: 'Looks fixed' })).toHaveCount(0);
    await expect(thread.getByText('Does it look right to you?')).toHaveCount(0);
    // The worker named no author: no session reaches it in public mode.
    expect(saidMine.length).toBeGreaterThan(0);
    expect(saidMine.every((each) => each === undefined)).toBe(true);
  });

  test('the control: when the read says the reader is the author, the thread asks, and « Looks fixed » is sent', async ({
    page,
  }) => {
    await publicPage(page, 'thread-check-public-mine');
    await plantPublic(page, 'Verdict of the author in public mode');
    const { checks } = await doneInTheRead(page, true);
    await publicPage(page, 'thread-check-public-mine');

    const thread = await openThread(page, 'Verdict of the author in public mode');
    await expect(thread.getByText('Does it look right to you?')).toBeVisible();
    await expect(thread.getByRole('group', { name: 'Does it look right to you?' }).getByRole('button')).toHaveText([
      'Looks fixed',
      'Still wrong',
    ]);
    // The field to reply waits: « Still wrong » is the way to say what is missing.
    await expect(thread.locator('.fruitback-thread-reply-field')).toHaveCount(0);
    await thread.getByRole('button', { name: 'Looks fixed' }).click();
    await expect(thread.getByRole('status').filter({ hasText: 'Thank you' })).toHaveText(
      'Thank you. The team knows it looks fixed.',
    );
    expect(checks).toEqual(['fixed']);
    await expect(thread.locator('.fruitback-thread-reply-body').last()).toHaveText('Checked: looks fixed');
  });
});

test.describe('private mode (FRU-603)', () => {
  test('says who marked the note done and asks nothing: the extension carries no session', async ({ extension }) => {
    await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
    const page = await extension.context.newPage();
    // The rule mounts the widget of the extension on the site: no popup to go through.
    await openBareSite(page, 'thread-check-private');
    await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
    await plantOn(page, '[data-testid="card-espresso"] .add', 'Verdict in private mode');
    const { saidMine } = await doneInTheRead(page, false);
    await page.reload();
    await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

    const thread = await openThread(page, 'Verdict in private mode');
    await expect(thread.locator('.fruitback-thread-done')).toHaveText('Marc Petit marked it done');
    await expect(thread.getByRole('button', { name: 'Looks fixed' })).toHaveCount(0);
    // The worker named no author: private mode carries no session.
    expect(saidMine.length).toBeGreaterThan(0);
    expect(saidMine.every((each) => each === undefined)).toBe(true);
    // The thread drawn is the one of a note done: the line above says it, so the absence of the
    // question is about who reads, not about a thread with no verdict to ask. Private mode mounts the
    // widget with `replies: false` too (`page.content.ts`): a verdict is a reply of the store.
  });
});

test.describe('team mode (FRU-603)', () => {
  test('the author confirms one note and reopens another, from the thread of its pin', async ({ extension }) => {
    test.slow();
    await paired(extension);
    const page = await extension.context.newPage();
    await openBareSite(page, 'thread-check-team');
    const popup = await openPopup(extension, page);
    await popup.getByRole('button', { name: /^(Turn on|Activer)$/ }).click();
    await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();

    await plantOn(page, '[data-testid="card-espresso"] .add', 'Verdict fixed');
    await plantOn(page, '[data-testid="card-latte"] .add', 'Verdict wrong');
    await expect(page.locator('[data-fruitback-pin]')).toHaveCount(2);
    // The team marks both done, as it would in its tracker: `POST /__dev/stage` of the worker of the suite.
    for (const note of ['Verdict fixed', 'Verdict wrong']) {
      const id = await pinFor(page, note).getAttribute('data-fruitback-pin');
      const moved = await fetch(`${AUTHENTICATED_WORKER_ORIGIN}/__dev/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: id, stage: 'done' }),
      });
      expect(moved.status, note).toBe(200);
    }
    // The widget reads the stages of now once the shared cache of the read (15 s) let go of the answer of before.
    await expect
      .poll(
        async () => {
          await page.reload();
          await expect(page.locator('[data-fruitback-pin]')).toHaveCount(2);

          return page.locator('[data-fruitback-pin][data-fruitback-stage="done"]').count();
        },
        { timeout: 40_000, intervals: [3_000] },
      )
      .toBe(2);

    // « Looks fixed »: the note stays done, confirmed, and the thread says so.
    let thread = await openThread(page, 'Verdict fixed');
    // No reply of the team: who marked it done is not known.
    await expect(thread.locator('.fruitback-thread-done')).toHaveText('Marked done');
    await thread.getByRole('button', { name: 'Looks fixed' }).click();
    await expect(thread.locator('.fruitback-thread-check-said')).toHaveText(
      'Thank you. The team knows it looks fixed.',
    );
    await expect(thread.locator('.fruitback-thread-reply-body').last()).toHaveText('Checked: looks fixed');
    await expect(thread.getByRole('button', { name: 'Looks fixed' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // « Still wrong »: the field says what is missing, and the note is open again.
    thread = await openThread(page, 'Verdict wrong');
    await thread.getByRole('button', { name: 'Still wrong' }).click();
    const field = thread.getByRole('textbox', { name: 'What is still wrong?' });
    await expect(field).toBeFocused();
    await field.fill('The latte is still at 4 €.');
    await thread.getByRole('button', { name: 'Send: still wrong' }).click();
    await expect(thread.locator('.fruitback-thread-check-said')).toHaveText('Sent. The note is open again.');
    await expect(thread.locator('.fruitback-thread-reply-body').last()).toHaveText(
      'Reopened: still wrong\nThe latte is still at 4 €.',
    );
    await expect(pinFor(page, 'Verdict wrong')).not.toHaveAttribute('data-fruitback-stage', 'done');

    // What the worker kept, read again from the store once the cache let go: one confirmed, one reopened.
    await expect
      .poll(
        async () => {
          await page.reload();
          await expect(page.locator('[data-fruitback-pin]')).toHaveCount(2);

          return [
            await pinFor(page, 'Verdict fixed').getAttribute('data-fruitback-stage'),
            await pinFor(page, 'Verdict wrong').getAttribute('data-fruitback-stage'),
          ];
        },
        { timeout: 40_000, intervals: [3_000] },
      )
      .toEqual(['done', 'new']);
    thread = await openThread(page, 'Verdict fixed');
    // Confirmed: the store says `checked`, and the thread asks nothing any more.
    await expect(thread.getByRole('button', { name: 'Looks fixed' })).toHaveCount(0);
    await expect(thread.locator('.fruitback-thread-done')).toHaveCount(0);
  });
});
