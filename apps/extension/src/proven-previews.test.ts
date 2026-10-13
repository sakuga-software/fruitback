import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accessInUse } from './access-return.ts';
import { cloudEntry, offerFor, parseWorkspaceSites, refreshPreviews } from './cloud.ts';
import {
  type ListedPreviews,
  PREVIEWS_FRESH_MS,
  PREVIEWS_REFRESH_MS,
  type ProvenPreviews,
  freshPreviews,
  listedPreviews,
  parseProven,
  previewsKey,
  readPreviewPattern,
  touchesPreviews,
} from './proven-previews.ts';
import { complaint } from './site-form.ts';
import { lendsSession, resolveSite } from './site-patterns.ts';
import type { AccessResult } from './session.ts';
import type { SiteConfig } from './sites.ts';
import { importSites } from './site-transfer.ts';

/**
 * The one wildcard that serves team mode (FRU-103): the previews of a site, which the worker of the
 * session lists because its workspace proved the domain. Everything else of FRU-75 stays.
 */

const WORKER = 'https://api.fruitback.test';
const PREVIEWS = 'https://*.preview.acme.dev';
const NOW = 1_800_000_000_000;

/** The rule the one click stores for the previews of `site_1`. */
const RULE: SiteConfig = { mode: 'team', endpoint: WORKER, enabled: true, mount: { clientId: 'site_1' } };
/** What the worker listed, a minute ago. */
const LISTED: ProvenPreviews = { [WORKER]: { at: NOW - 60_000, previews: { [PREVIEWS]: 'site_1' } } };
const fresh = (proven: ProvenPreviews = LISTED, now = NOW) => freshPreviews(proven, now);

describe('a team wildcard that the worker lists (FRU-103)', () => {
  it('serves the pages under it, for the rule of that worker and of that site', () => {
    assert.equal(lendsSession(PREVIEWS, RULE, fresh()), false);
    assert.deepEqual(resolveSite({ [PREVIEWS]: RULE }, 'https://pr-12.preview.acme.dev', fresh()), {
      pattern: PREVIEWS,
      site: RULE,
    });
  });

  it('serves nothing with no list: every caller that gives none keeps the rule of FRU-75', () => {
    assert.ok(lendsSession(PREVIEWS, RULE));
    assert.ok(lendsSession(PREVIEWS, RULE, {}));
    assert.equal(resolveSite({ [PREVIEWS]: RULE }, 'https://pr-12.preview.acme.dev'), undefined);
  });

  it('serves nothing for another wildcard, another worker, another site, or a rule with no site', () => {
    const cases: [string, string, SiteConfig][] = [
      ['a wildcard the worker did not list', 'https://*.vercel.app', RULE],
      ['a wider wildcard than the one listed', 'https://*.acme.dev', RULE],
      ['a narrower wildcard than the one listed', 'https://*.pr.preview.acme.dev', RULE],
      ['the same wildcard in clear', 'http://*.preview.acme.dev', RULE],
      ['a rule of another worker', PREVIEWS, { ...RULE, endpoint: 'https://evil.test' }],
      ['a rule of another site of the workspace', PREVIEWS, { ...RULE, mount: { clientId: 'site_2' } }],
      ['a team rule that names no site', PREVIEWS, { mode: 'team', endpoint: WORKER, enabled: true }],
    ];
    for (const [name, pattern, rule] of cases) {
      assert.ok(lendsSession(pattern, rule, fresh()), name);
      assert.equal(resolveSite({ [pattern]: rule }, 'https://pr-12.preview.acme.dev', fresh()), undefined, name);
    }
  });

  it('covers no page outside the domain, and none in clear', () => {
    const sites = { [PREVIEWS]: RULE };
    for (const origin of [
      'https://preview.acme.dev.evil.test',
      'https://evilpreview.acme.dev',
      'https://acme.dev',
      'http://pr-12.preview.acme.dev',
      'https://pr-12.preview.acme.dev:8443',
    ]) {
      assert.equal(resolveSite(sites, origin, fresh()), undefined, origin);
    }
    // The domain itself is under its own wildcard, as in a match pattern: it is the workspace's too.
    assert.equal(resolveSite(sites, 'https://preview.acme.dev', fresh())?.pattern, PREVIEWS);
  });

  it('stops when the answer of the worker is too old, and when the worker lists it no more', () => {
    const sites = { [PREVIEWS]: RULE };
    const origin = 'https://pr-12.preview.acme.dev';

    assert.ok(resolveSite(sites, origin, fresh(LISTED, NOW - 60_000 + PREVIEWS_FRESH_MS)) !== undefined);
    assert.equal(resolveSite(sites, origin, fresh(LISTED, NOW - 60_000 + PREVIEWS_FRESH_MS + 1)), undefined);
    // A clock that moved back: an answer dated after now is no answer.
    assert.equal(resolveSite(sites, origin, fresh(LISTED, NOW - 120_000)), undefined);
    // The proof was lost: the next answer of the worker lists nothing.
    assert.equal(resolveSite(sites, origin, fresh({ [WORKER]: { at: NOW, previews: {} } })), undefined);
  });

  it('is never granted by a rule a person types or imports', () => {
    assert.notEqual(complaint({ mode: 'team', endpoint: WORKER, clientId: '' }, PREVIEWS), '');
    // A file that carries the rule as the one click stores it, and a forged list beside it.
    const file = JSON.stringify({
      format: 'fruitback-sites',
      version: 1,
      sites: { [PREVIEWS]: RULE, 'https://app.acme.dev': RULE },
      provenPreviews: LISTED,
    });
    const imported = importSites(file);
    assert.ok(imported.ok);
    // The control: the same rule under one origin is imported, so the file was read.
    assert.deepEqual(Object.keys(imported.sites), ['https://app.acme.dev']);
    assert.deepEqual(imported.skipped, [PREVIEWS]);
  });
});

describe('what storage holds of the previews', () => {
  it('reads a wildcard in the one spelling of a rule, https only', () => {
    assert.equal(readPreviewPattern(PREVIEWS), PREVIEWS);
    for (const value of [
      'http://*.preview.acme.dev',
      'https://preview.acme.dev',
      'https://*.Preview.acme.dev',
      'https://*.preview.acme.dev/',
      'https://*.dev',
      'https://*.*.acme.dev',
      '*.preview.acme.dev',
      42,
    ]) {
      assert.equal(readPreviewPattern(value), undefined, String(value));
    }
  });

  it('parses key by key and entry by entry: what is not a list grants nothing', () => {
    assert.deepEqual(parseProven(undefined), {});
    assert.deepEqual(parseProven('x'), {});
    assert.deepEqual(
      parseProven({
        [previewsKey(WORKER)]: {
          at: NOW,
          previews: { [PREVIEWS]: 'site_1', 'https://*.vercel.app/': 'x', 'http://*.a.dev': 'y', 'https://*.b.dev': 3 },
        },
        [previewsKey('https://no-date.test')]: { previews: { [PREVIEWS]: 'site_1' } },
        [previewsKey('https://no-list.test')]: { at: NOW },
        // The other keys of the extension are not lists, whatever they hold.
        sites: { [PREVIEWS]: { at: NOW, previews: { [PREVIEWS]: 'site_1' } } },
        provenPreviews: { [WORKER]: { at: NOW, previews: { 'https://*.vercel.app': 'site_1' } } },
      }),
      { [WORKER]: { at: NOW, previews: { [PREVIEWS]: 'site_1' } } },
    );
  });

  it('keeps what each worker listed under a key of its own, so two writers cannot undo each other', () => {
    assert.equal(previewsKey(WORKER), `provenPreviews:${WORKER}`);
    assert.notEqual(previewsKey(WORKER), previewsKey('https://other.test'));
    assert.ok(touchesPreviews([previewsKey(WORKER)]));
    assert.equal(touchesPreviews(['sites', 'provenPreviews', 'session:https://api.fruitback.test']), false);
  });

  it('keeps one site for a wildcard: the first the worker lists', () => {
    assert.deepEqual(
      listedPreviews(
        [
          { id: 'site_1', previews: [PREVIEWS] },
          { id: 'site_2', previews: [PREVIEWS, 'https://*.docs.acme.dev'] },
          { id: 'site_3' },
        ],
        NOW,
      ),
      { at: NOW, previews: { [PREVIEWS]: 'site_1', 'https://*.docs.acme.dev': 'site_2' } },
    );
  });
});

const GRANTED = { ok: true, grant: { accessToken: 'tok', expiresAt: NOW + 600_000 } } as AccessResult;

/** A worker that lists one site and its previews, to the right token. */
function workerThatLists(previews: unknown, status = 200) {
  const body = {
    workspace: { id: 'ws_1', name: 'Acme' },
    sites: [
      {
        id: 'site_1',
        origin: 'https://acme.dev',
        visibility: 'members',
        ...(previews === undefined ? {} : { previews }),
      },
    ],
  };

  return (async (_url: string, init?: RequestInit) =>
    (init?.headers as Record<string, string> | undefined)?.Authorization === 'Bearer tok'
      ? new Response(JSON.stringify(body), { status })
      : new Response('{}', { status: 401 })) as typeof fetch;
}

describe('the previews of a site, offered in one click (FRU-103)', () => {
  it('offers the wildcard for a page under a proven domain, and remembers what the worker listed', async () => {
    const remembered: [string, ListedPreviews | undefined][] = [];
    const offer = await offerFor('https://pr-12.preview.acme.dev', {
      endpoints: async () => [WORKER],
      ensureAccess: async () => GRANTED,
      fetcher: workerThatLists([PREVIEWS]),
      remember: async (endpoint, listed) => void remembered.push([endpoint, listed]),
      now: () => NOW,
    });

    assert.equal(offer?.pattern, PREVIEWS);
    assert.equal(offer?.site.id, 'site_1');
    assert.deepEqual(remembered, [[WORKER, { at: NOW, previews: { [PREVIEWS]: 'site_1' } }]]);
    // The rule of the click, with the list of the worker, serves the page.
    const rule = cloudEntry(offer as NonNullable<typeof offer>);
    const proven = freshPreviews({ [WORKER]: remembered[0]?.[1] as ListedPreviews }, NOW);
    assert.equal(resolveSite({ [PREVIEWS]: rule }, 'https://pr-12.preview.acme.dev', proven)?.site, rule);
  });

  // An answer is for the session that asked. A logout, or a pairing with another account, can land
  // while the worker answers: the background forgets the list then, and the answer must not put it back.
  describe('an answer that arrives after the session that asked is gone', () => {
    const PAGE = 'https://pr-12.preview.acme.dev';
    /** The seams of a browser whose session with the worker changes when `during` runs. */
    function seamsWhere(marks: (string | undefined)[]) {
      const remembered: [string, ListedPreviews | undefined][] = [];
      let read = 0;

      return {
        remembered,
        seams: {
          endpoints: async () => [WORKER],
          ensureAccess: async () => GRANTED,
          fetcher: workerThatLists([PREVIEWS]),
          remember: async (endpoint: string, listed: ListedPreviews | undefined) =>
            void remembered.push([endpoint, listed]),
          // One mark for each read, in order; the last one stays.
          sessionOf: async () => marks[Math.min(read++, marks.length - 1)],
          now: () => NOW,
        },
      };
    }

    it('keeps the answer of the session that is still there: the control', async () => {
      const { seams, remembered } = seamsWhere(['epoch.1']);

      assert.equal((await offerFor(PAGE, seams))?.pattern, PREVIEWS);
      assert.deepEqual(remembered, [[WORKER, { at: NOW, previews: { [PREVIEWS]: 'site_1' } }]]);
    });

    it('keeps nothing, and offers nothing, when a logout landed while the worker answered', async () => {
      const { seams, remembered } = seamsWhere(['epoch.1', undefined]);

      assert.equal(await offerFor(PAGE, seams), undefined);
      assert.deepEqual(remembered, []);
    });

    it('keeps nothing when another pairing took the place of the session that asked', async () => {
      const { seams, remembered } = seamsWhere(['epoch.1', 'epoch.2']);

      await refreshPreviews(seams);
      assert.deepEqual(remembered, []);
    });

    it('takes back what it wrote when the session ended between the read and the write', async () => {
      const { seams, remembered } = seamsWhere(['epoch.1', 'epoch.1', undefined]);

      assert.equal(await offerFor(PAGE, seams), undefined);
      assert.deepEqual(
        remembered.map(([, listed]) => listed === undefined),
        [false, true],
        'written, then forgotten',
      );
    });

    it('is given the epoch of the session by the background and by the popup, the two that ask', () => {
      const sources = {
        'background.ts': readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8'),
        'popup/main.ts': readFileSync(new URL('../entrypoints/popup/main.ts', import.meta.url), 'utf8'),
      };
      for (const [file, source] of Object.entries(sources)) {
        assert.match(
          source,
          /remember: rememberPreviews,[\s\S]{0,160}sessionOf: async \(endpoint\) => \{\s*const held = \(await sessions\.list\(\)\)\[endpoint\];\s*return held === undefined \? undefined : \(held\.epoch \?\? ''\);/,
          `${file} does not say which session asks`,
        );
      }
    });

    it('asks nothing of a worker this browser holds no session with', async () => {
      const { seams, remembered } = seamsWhere([undefined]);
      let asked = 0;

      await refreshPreviews({ ...seams, fetcher: (async () => ((asked += 1), new Response('{}'))) as typeof fetch });
      assert.equal(asked, 0);
      assert.deepEqual(remembered, []);
    });
  });

  it('offers the site itself for its own origin, and nothing for a page no proven domain covers', async () => {
    const seams = {
      endpoints: async () => [WORKER],
      ensureAccess: async () => GRANTED,
      fetcher: workerThatLists([PREVIEWS]),
    };

    assert.equal((await offerFor('https://acme.dev', seams))?.pattern, 'https://acme.dev');
    assert.equal(await offerFor('https://pr-12.staging.acme.dev', seams), undefined);
    assert.equal(await offerFor('https://somebody.vercel.app', seams), undefined);
  });

  it('drops a wildcard the worker spells in a way no rule is keyed on', () => {
    const parsed = parseWorkspaceSites({
      workspace: { id: 'ws_1' },
      sites: [{ id: 's', origin: 'https://acme.dev', previews: [PREVIEWS, 'http://*.acme.dev', 'https://*', 7] }],
    });

    assert.deepEqual(parsed?.sites[0]?.previews, [PREVIEWS]);
  });

  it('forgets what a worker listed when it lists nothing now, and keeps it when the worker does not answer', async () => {
    const remembered: [string, ListedPreviews | undefined][] = [];
    const seams = (fetcher: typeof fetch) => ({
      endpoints: async () => [WORKER],
      ensureAccess: async () => GRANTED,
      fetcher,
      remember: async (endpoint: string, listed: ListedPreviews | undefined) =>
        void remembered.push([endpoint, listed]),
      now: () => NOW,
    });

    // The proof is lost: the worker lists the site with no previews.
    await refreshPreviews(seams(workerThatLists(undefined)));
    assert.deepEqual(remembered, [[WORKER, { at: NOW, previews: {} }]]);

    // The worker is down: nothing is written, and what it listed before ages by itself.
    await refreshPreviews(seams(workerThatLists([PREVIEWS], 503)));
    assert.equal(remembered.length, 1);

    // A worker that keeps no accounts lists nothing at all.
    await refreshPreviews(seams(workerThatLists([PREVIEWS], 405)));
    assert.deepEqual(remembered[1], [WORKER, undefined]);
  });
});

describe('the access of the previews', () => {
  it('is kept while the worker does not list them, and given back like any other when the rule is off', () => {
    assert.ok(accessInUse({ [PREVIEWS]: RULE }, []).has(PREVIEWS));
    assert.equal(accessInUse({ [PREVIEWS]: { ...RULE, enabled: false } }, []).has(PREVIEWS), false);
    // A team wildcard of before FRU-75 names no site: it is not the previews of anything.
    assert.equal(
      accessInUse({ [PREVIEWS]: { mode: 'team', endpoint: WORKER, enabled: true } }, []).has(PREVIEWS),
      false,
    );
  });
});

describe('SECURITY.md, on the previews', () => {
  const SECURITY = readFileSync(new URL('../../../SECURITY.md', import.meta.url), 'utf8').replaceAll(/\s+/g, ' ');
  const words: Record<number, string> = { 2: 'two', 30: 'thirty' };

  it('quotes how long an answer of the worker grants, and how often the background asks', () => {
    assert.ok(
      SECURITY.includes(`older than ${words[PREVIEWS_FRESH_MS / 3_600_000]} hours it grants nothing`),
      'SECURITY.md does not say how long an answer grants',
    );
    assert.ok(
      SECURITY.includes(`asks again every ${words[PREVIEWS_REFRESH_MS / 60_000]} minutes`),
      'SECURITY.md does not say how often the background asks',
    );
    assert.ok(SECURITY.includes(`stops granting after ${words[PREVIEWS_FRESH_MS / 3_600_000]} hours`));
  });
});
