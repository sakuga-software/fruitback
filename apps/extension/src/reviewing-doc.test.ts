import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GUIDE, GUIDE_ANCHORS } from './guide.ts';
import { NOTES_NEED_SESSION, READ_NEEDS_SESSION, WORKER_NOT_FOUND } from './read-probe.ts';
import { PAIRING_NEEDS_HTTPS, PAIRING_PROBLEM, PROBLEMS, REMEDY_LABEL } from './remedy.ts';

/**
 * The popup's words, checked against the guide that quotes them (FRU-46).
 *
 * `docs/reviewing.md` is the reviewer's side of the three modes, and it walks somebody through a
 * screen by naming what is on it. A renamed button leaves that guide describing a popup nobody has,
 * and nothing else would say so: the strings are not imported anywhere, there is no Chromium on CI
 * to open the popup with, and prose does not fail a build.
 *
 * The failure messages are **imported from `remedy.ts`** and the mode labels are **read out of the
 * popup** rather than listed here, so a fifth message or a third mode is covered the day it is
 * written. The buttons are named, because they are built one by one at their call sites and a regex
 * over them would guard whichever ones it happened to match.
 *
 * Source text for the popup rather than an import: `popup/main.ts` binds `browser` at import, so
 * `node --test` cannot load it. The same reason `page-api.test.ts` reads `docs/install.md` as text.
 */
describe('the guide quotes the popup this extension renders', () => {
  const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  // The screens of the sign-in and the head of every screen are drawn in `popup-view.ts` (FRU-251).
  const popup = `${read('../entrypoints/popup/main.ts')}\n${read('./popup-view.ts')}\n${read('./kit.ts')}`;
  const optionsPage = `${read('../entrypoints/options/main.ts')}\n${read('./site-page.ts')}\n${read('./share-rules.ts')}`;
  const guide = read('../../../docs/reviewing.md');

  /** Every way a pairing fails. The popup draws them from this record, and the check below says so. */
  const problems = Object.values(PAIRING_PROBLEM);

  /**
   * Every mode label the popup offers, out of the block that builds the options.
   *
   * **Matched by the tuple's shape and not by the two keys that exist today.** Naming `private|team`
   * here left a third mode outside both this list and the count below, so the guide could omit its
   * label with the suite green — a detector that passes while guarding less than it says. Raised in
   * review.
   */
  const options = /function modeField[\s\S]*?\[([\s\S]*?)\]\) \{/.exec(popup)?.[1] ?? '';
  const modes = [...options.matchAll(/\['[a-z-]+', '([^']+)'\]/g)].map((match) => match[1] ?? '');

  /**
   * A guard over an empty extraction passes. Say so here rather than discover it after a rewrite —
   * this is the check the first version of `worlds.test.ts` did not have.
   */
  it('finds the strings it is written to guard', () => {
    assert.equal(problems.length, 4, `read ${problems.length} pairing failures`);
    assert.ok(popup.includes('PAIRING_PROBLEM['), 'the popup no longer draws its pairing failures from remedy.ts');
    assert.ok(options !== '', 'the options block of modeField was not found; this guard reads nothing');
    // Counted against the `SiteMode` union rather than against a number written here, so a third
    // mode raises the bar instead of slipping under it.
    const declared = (
      /export type SiteMode = ([^;]+);/.exec(
        readFileSync(fileURLToPath(new URL('./sites.ts', import.meta.url)), 'utf8'),
      )?.[1] ?? ''
    ).split('|').length;
    assert.equal(modes.length, declared, `the popup offers ${modes.length} of the ${declared} modes SiteMode declares`);
  });

  it('names every way pairing can fail', () => {
    for (const message of problems) {
      assert.ok(guide.includes(message), `docs/reviewing.md does not carry the pairing failure: ${message}`);
    }
  });

  it('names every mode the popup offers', () => {
    for (const label of modes) {
      assert.ok(guide.includes(label), `docs/reviewing.md does not carry the mode label: ${label}`);
    }
  });

  /**
   * What the guide tells somebody to click, and what it tells them they will read back. Each one is
   * a step of the walk-through: rename it in the popup and the step points at nothing.
   */
  it('names the controls it walks somebody through', () => {
    const controls = [
      'Turn on for this site',
      'Turn off here',
      'Change',
      'Pair with this worker',
      'I have a code',
      'Log out',
      'Worker endpoint',
      'Client id',
      'Not paired — this site cannot reach the worker until you do',
      "team mode · the site's own widget",
      'No rule covers this origin, so Fruitback does nothing here.',
      'Turn off for every site this rule covers',
      // The screens 1 and 4 of the mock-up of 2026-10-20 (FRU-297).
      'Account and settings',
      'Sign in with email',
      'Use your own Fruitback server',
      "Fruitback can't open this page",
      'Allow access again',
      'Turn off for this site',
      'Paused',
    ];

    for (const control of controls) {
      assert.ok(popup.includes(control), `the popup no longer renders: ${control}`);
      assert.ok(guide.includes(control), `docs/reviewing.md no longer names: ${control}`);
    }

    // Not in `PAIRING_PROBLEM`, and the one a reviewer on an http worker actually meets: the popup
    // disables the button before `sessions.pair` runs, so the record's own `insecure-endpoint`
    // never reaches that screen. Raised in review.
    assert.ok(popup.includes('PAIRING_NEEDS_HTTPS'), 'the popup no longer says that pairing needs https');
    assert.ok(guide.includes(PAIRING_NEEDS_HTTPS), 'docs/reviewing.md no longer quotes the https line');
  });

  /** The button beside a problem is a step of the walk-through too (FRU-90). */
  it('names the remedy of every problem it quotes', () => {
    const quoted = PROBLEMS.filter((problem) => guide.includes(problem.text));

    assert.ok(quoted.length >= 5, `the guide quotes ${quoted.length} problems: this check reads nothing`);
    for (const problem of quoted) {
      if (problem.remedy === null) continue;
      assert.ok(
        guide.includes(`**${REMEDY_LABEL[problem.remedy]}**`),
        `docs/reviewing.md quotes "${problem.text}" and does not name its button: ${REMEDY_LABEL[problem.remedy]}`,
      );
    }
  });

  /** The same walk-through, on the options page (FRU-43). */
  it('quotes the line the popup writes for a worker that wants a session (FRU-66)', () => {
    assert.ok(guide.includes(`\`${READ_NEEDS_SESSION}\``), 'the guide does not quote the line of the popup');
    assert.ok(popup.includes('READ_NEEDS_SESSION'), 'the popup no longer writes that line');
  });

  it('quotes the line the popup writes for a site whose notes are « Members only » (FRU-330)', () => {
    assert.ok(guide.includes(`\`${NOTES_NEED_SESSION}\``), 'the guide does not quote the line of the popup');
    assert.ok(popup.includes('NOTES_NEED_SESSION'), 'the popup no longer writes that line');
  });

  it('names the options page controls it walks somebody through', () => {
    const controls = ['Add rule', 'Grant access', 'No access in this browser', 'Download', 'Import a rules file'];

    for (const control of controls) {
      assert.ok(optionsPage.includes(control), `the options page no longer renders: ${control}`);
      assert.ok(guide.includes(control), `docs/reviewing.md no longer names: ${control}`);
    }
  });

  /**
   * « When Fruitback does not answer » and « Who can add a site to a workspace » (FRU-527). The help
   * buttons of the extension link these two headings, and each line they quote is a cause the code
   * draws: renamed there, the section would send a reviewer looking for words that no screen shows.
   */
  describe('the sections that the help buttons link (FRU-527)', () => {
    const widget = read('../../../packages/widget/src/messages.ts');
    const consoleConnect = read('../../console/app/routes/connect.tsx');
    const section = (heading: string): string => {
      const start = guide.indexOf(`\n## ${heading}\n`);
      assert.ok(start >= 0, `docs/reviewing.md has no heading « ${heading} »`);
      const end = guide.indexOf('\n## ', start + 1);

      return guide.slice(start, end < 0 ? undefined : end);
    };

    it('keeps the two headings, whose ids the extension links', () => {
      const ids = [...guide.matchAll(/^## (.+)$/gm)].map((match) =>
        (match[1] ?? '')
          .toLowerCase()
          .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
          .replaceAll(/\s/g, '-'),
      );

      assert.ok(ids.includes('when-fruitback-does-not-answer'), 'the id #when-fruitback-does-not-answer is gone');
      assert.ok(ids.includes('who-can-add-a-site-to-a-workspace'), 'the id #who-can-add-a-site-to-a-workspace is gone');
    });

    it('quotes only what the popup draws', () => {
      const troubleshooting = section('When Fruitback does not answer');
      const quotes = [
        'It was refused in the console.',
        'The tab was not approved in time.',
        'Check the connection, then try again.',
        'The browser did not give the extension access to Fruitback.',
        'Fruitback did not answer. The popup asks again.',
        'Your sign-in ended',
        "Fruitback can't reach",
        'Try again',
        "Fruitback can't open this page",
        'Allow access again',
        'Paused',
        'Another copy of Fruitback runs on this page',
        'Start again',
      ];

      for (const quote of quotes) {
        assert.ok(troubleshooting.includes(quote), `the section does not quote: ${quote}`);
        assert.ok(popup.includes(quote), `the popup no longer draws: ${quote}`);
      }
      // Drawn from their modules, which the popup imports.
      assert.ok(troubleshooting.includes(WORKER_NOT_FOUND), 'the section does not quote the worker that is not there');
      assert.ok(popup.includes('WORKER_NOT_FOUND'), 'the popup no longer says that the worker of a rule is not there');
      assert.ok(
        troubleshooting.includes(PAIRING_PROBLEM.unavailable),
        'the section does not quote the pairing with no answer',
      );
      assert.ok(
        consoleConnect.includes("t('Not now')"),
        'the console no longer has « Not now », which the section names',
      );
    });

    it('quotes only what the widget draws', () => {
      const troubleshooting = section('When Fruitback does not answer');

      for (const quote of [
        'Sign in to leave notes',
        'Did not go through',
        'Your text is kept. Try again, or copy it before closing the page.',
      ]) {
        assert.ok(troubleshooting.includes(quote), `the section does not quote: ${quote}`);
        assert.ok(widget.includes(`'${quote}'`), `the widget no longer draws: ${quote}`);
      }
    });

    it('says who can add a site as the popup and the worker decide it', () => {
      const who = section('Who can add a site to a workspace');
      const roles = read('../../worker/src/accounts.ts');
      const adds = read('../../worker/src/session-site-add.ts');

      for (const quote of [
        'Ask an admin of your workspace to add this site.',
        'Your role in this workspace does not let you add a site.',
        'Too many sites were added in the last hour. Try again later.',
      ]) {
        assert.ok(who.includes(quote), `the section does not quote: ${quote}`);
        assert.ok(popup.includes(quote), `the popup no longer draws: ${quote}`);
      }
      // Owner and admin: the two roles that hold `manage-sites`, the right that `POST /session/sites` asks.
      assert.match(roles, /owner: ACTIONS,/);
      assert.match(roles, /admin: \[[^\]]*'manage-sites'/);
      assert.doesNotMatch(roles, /(member|guest): \[[^\]]*'manage-sites'/);
      assert.ok(
        adds.includes("can(role, 'manage-sites')"),
        'the route that adds a site no longer asks for manage-sites',
      );
      assert.match(adds, /ADDS_PER_ACCOUNT = 10;/);
      assert.ok(who.includes('10 sites an hour'), 'the section does not give the limit of the route');
    });
  });

  /**
   * The buttons of the guide (FRU-528) open a section by its anchor. The site builds an anchor from a
   * heading as GitHub does: lower case, the punctuation dropped, a hyphen for each space.
   */
  it('has a heading for each anchor a button of the extension opens (FRU-528)', () => {
    const slug = (heading: string): string =>
      heading
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s/g, '-');
    const anchors = new Set([...guide.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) => slug(heading ?? '')));

    assert.ok(anchors.has('2-switch-a-site-on'), 'the slugs are not read as the site builds them');
    assert.equal(GUIDE, 'https://fruitback.com/reviewing.html');
    for (const anchor of Object.values(GUIDE_ANCHORS)) {
      assert.ok(anchors.has(anchor), `docs/reviewing.md has no heading for #${anchor}`);
    }
    // The control: an anchor nobody wrote is not found.
    assert.equal(anchors.has('when-fruitback-never-answers'), false);
  });
});
