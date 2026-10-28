import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, badgeFor } from './pin.ts';

/**
 * A reply of an AI agent in the thread of a note (FRU-465): the agent replies through `/mcp` with a
 * key of `POST /__dev/agent-key`, a member of the workspace replies with a session of the extension,
 * and the bubble says « Agent » beside the name of the key, and nothing of the kind beside the member.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';
const PLAYGROUND = 'http://localhost:5177';

async function mount(page: Page, locale: string): Promise<void> {
  await page.goto(`/?widget=off&case=agent-reply-${locale}-${test.info().retry}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ({ endpoint, locale }) => {
      const scope = globalThis as unknown as {
        Fruitback: { init(options: Record<string, unknown>): unknown };
        fruitbackWidget: unknown;
      };
      scope.fruitbackWidget = scope.Fruitback.init({ endpoint, clientId: 'playground', locale });
    },
    { endpoint: WORKER_ORIGIN, locale },
  );
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const answer = await fetch(`${WORKER_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await answer.text();
  if (!answer.ok) throw new Error(`${path} answered ${answer.status}: ${text}`);

  return text === '' ? undefined : JSON.parse(text);
}

/** A tool of `/mcp`, called with an agent key. */
async function tool(key: string, name: string, args: Record<string, unknown>): Promise<any> {
  const answer = await post(
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { Authorization: `Bearer ${key}` },
  );
  if (answer.result?.isError === true) throw new Error(`${name}: ${JSON.stringify(answer.result.content)}`);

  return answer.result.structuredContent;
}

/** The note with this text, written by the agent and by a member of the workspace. */
async function replyAsAgentAndMember(text: string): Promise<void> {
  const { secret } = await post('/__dev/agent-key', { write: true, verifiedOnly: false });
  const { notes } = await tool(secret, 'list_feedback', { site: 'playground', q: text });
  const note = notes.find((each: { note: { text: string } }) => each.note.text === text);
  await tool(secret, 'reply_to_feedback', { id: note.id, body: 'Fixed in the next deploy.' });

  const { code } = await post('/__dev/pair', { name: 'Ana Martin', endpoint: WORKER_ORIGIN });
  const paired = await post('/session/pair', { code });
  await post(
    `/feedback/${note.issueId}/replies?client=playground`,
    { url: note.note.page.url, body: 'Thank you.' },
    { Authorization: `Bearer ${paired.session?.accessToken ?? paired.accessToken}`, Origin: PLAYGROUND },
  );
}

async function plant(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await page.locator('[data-testid="card-espresso"] .add').click();
  await page.getByPlaceholder('What should change?').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 10_000 });
}

test('the bubble says « Agent » beside the name of the key, and not beside a member (FRU-465)', async ({ page }) => {
  await mount(page, 'en-US');
  // Unique in its first 20 characters, by which the badge of its pin is found.
  const text = `R${Date.now()} an agent replies here`;
  await plant(page, text);
  await replyAsAgentAndMember(text);

  // Read again from the worker: the widget asks for the page once more, and draws what it answers.
  await mount(page, 'en-US');
  await badgeFor(page, text).click();

  const replies = page.getByRole('list', { name: 'Replies' }).locator('.fruitback-thread-reply-who');
  await expect(replies).toHaveCount(2);
  // The name of the key, and the word of the reader: never the member who made the key.
  await expect(replies.nth(0)).toHaveText(/^Dev agent · Agent · /);
  // The member is named by their account, the owner of the workspace of the worker of development.
  await expect(replies.nth(1)).toHaveText(/^Dev · member of Playground · /);
  await expect(replies.nth(1)).not.toHaveText(/Agent/);
});
