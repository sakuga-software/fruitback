import { type Page, type Route, expect, test } from '@playwright/test';
import { stubWorker } from './console-workspace.ts';

/**
 * The front door (`/`) reads the invitations of the person and the sites of their first workspace
 * side by side (FRU-492). One after the other, they were a third round trip before the first screen:
 * 160 ms on a phone with a latency of 150 ms. The worker is answered by stubs, each answer held
 * `HELD` ms, so a read that waits for the other one shows.
 */
const CONSOLE = 'http://localhost:5178';
const HELD = 600;

type Asked = { path: string; at: number; answered?: number };

/** Holds the answers of the invitations and of the sites, and keeps when each was asked and answered. */
async function frontDoor(page: Page, answers: { invitations: unknown[]; sites: unknown[] }): Promise<Asked[]> {
  const asked: Asked[] = [];
  const held = async (route: Route, path: string, body: unknown) => {
    const each: Asked = { path, at: Date.now() };
    asked.push(each);
    await new Promise((done) => setTimeout(done, HELD));
    each.answered = Date.now();
    await route.fulfill({ json: body });
  };
  await stubWorker(page, {
    answer: (pathname, route) => {
      if (pathname.endsWith('/list-user-invitations')) return held(route, 'invitations', answers.invitations);
      if (pathname === '/console/workspaces/w1/sites') return held(route, 'sites', { sites: answers.sites });

      return undefined;
    },
  });

  return asked;
}

const first = (asked: Asked[], path: string): Asked => {
  const found = asked.find((each) => each.path === path);
  expect(found, `the console did not read the ${path}`).toBeDefined();

  return found as Asked;
};

test('reads the invitations and the sites side by side, and opens the sites', async ({ page }) => {
  const asked = await frontDoor(page, {
    invitations: [],
    sites: [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }],
  });

  await page.goto(`${CONSOLE}/`);
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);

  // The sites were asked before the invitations were answered: the two reads overlapped.
  const invitations = first(asked, 'invitations');
  const sites = first(asked, 'sites');
  expect(sites.at).toBeLessThan(invitations.answered as number);
  expect(invitations.at).toBeLessThan(sites.answered as number);
});

test('opens the invitations when one waits, though the sites were read too', async ({ page }) => {
  const asked = await frontDoor(page, {
    invitations: [
      {
        id: 'i1',
        organizationId: 'w2',
        organizationName: 'Lumen Studio',
        email: 'ana@acme.dev',
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        inviterId: 'a2',
      },
    ],
    sites: [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }],
  });

  await page.goto(`${CONSOLE}/`);
  await expect(page).toHaveURL(`${CONSOLE}/invitations`);
  first(asked, 'sites');
});

test('goes back to the setup for a workspace with no site', async ({ page }) => {
  await frontDoor(page, { invitations: [], sites: [] });

  await page.goto(`${CONSOLE}/`);
  await expect(page).toHaveURL(`${CONSOLE}/setup`);
});
