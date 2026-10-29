import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type Page, expect } from '@playwright/test';
import { type LoadedExtension, mintPairing, openPopup } from './extension.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * What the specs of the side panel share (FRU-296, FRU-480): the pairing, the calls into the panel,
 * its words in each language, and what it lists. The specs are in two files, so the two halves run
 * on two workers of CI: in one file they took 165 s on one worker, the longest file of the suite.
 *
 * Playwright does not hand the panel over as a `Page`: measured, `context.pages()` does not list it.
 * The service worker sees it in `runtime.getContexts`, and the protocol of the browser reaches it as
 * a target: `inPanel()` evaluates in it through `Target.sendMessageToTarget`.
 */

export const NAME = 'Camille Durand';

/** A session of the workspace of the suite's second worker, through a pairing link. */
export async function paired(extension: LoadedExtension): Promise<void> {
  const { link } = await mintPairing(NAME);
  const worker = await extension.context.newPage();
  await worker.goto(link);
  const popup = await openPopup(extension, worker, AUTHENTICATED_WORKER_ORIGIN);
  await popup.getByRole('button', { name: /^(Pair with this worker|Appairer avec ce worker)$/ }).click();
  await expect(popup.getByText(NAME, { exact: false })).toBeVisible();
  await popup.close();
  await worker.close();
}

/** Runs `expression` in the side panel, and answers its value. */
export async function inPanel<T>(page: Page, expression: string): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfos } = (await cdp.send('Target.getTargets')) as {
      targetInfos: { targetId: string; url: string }[];
    };
    const target = targetInfos.find((info) => info.url.endsWith('/sidepanel.html'));
    if (target === undefined) throw new Error('no side panel among the targets');
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })) as {
      sessionId: string;
    };
    const answer = new Promise<T>((resolve, reject) => {
      cdp.on('Target.receivedMessageFromTarget', (event: { sessionId: string; message: string }) => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message) as {
          id?: number;
          result?: { result: { value: T }; exceptionDetails?: unknown };
        };
        if (message.id !== 1) return;
        if (message.result?.exceptionDetails !== undefined) reject(new Error(JSON.stringify(message.result)));
        else resolve(message.result?.result.value as T);
      });
    });
    await cdp.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        // A promise is awaited: axe answers one (FRU-307).
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    });
    const value = await answer;
    await cdp.send('Target.detachFromTarget', { sessionId });

    return value;
  } finally {
    await cdp.detach();
  }
}

/**
 * The words of the panel in each language. The account of the suite may read French, and the panel
 * speaks the language of the account, as the popup does: the spec reads which one it speaks.
 */
export const WORDS = {
  en: {
    title: 'Notes on this page',
    close: 'Close the sidebar',
    notOn: ['Fruitback is not on for this page.', 'Turn it on from the Fruitback button in the toolbar.'],
    open: 'Open',
    done: 'Done',
    show: 'Show on the page',
    reply: 'Reply',
    ready: 'Ready to check',
    fixed: 'Looks fixed',
    wrong: 'Still wrong',
    markedDone: 'Marked done',
    doneStage: 'Done',
    newStage: 'New',
    checkedByYou: 'Checked by you',
    reopenedByYou: 'Reopened by you',
    justNow: 'just now',
  },
  fr: {
    title: 'Notes de cette page',
    close: 'Fermer le panneau',
    notOn: [
      'Fruitback n’est pas activé sur cette page.',
      'Activez-le depuis le bouton Fruitback de la barre d’outils.',
    ],
    open: 'Ouvertes',
    done: 'Terminées',
    show: 'Voir sur la page',
    reply: 'Répondre',
    ready: 'À vérifier',
    fixed: 'C’est corrigé',
    wrong: 'Toujours pas',
    markedDone: 'Marquée terminée',
    doneStage: 'Terminé',
    newStage: 'Nouveau',
    checkedByYou: 'Vérifiée par vous',
    reopenedByYou: 'Rouverte par vous',
    justNow: 'à l’instant',
  },
} as const;

/** The words of the language the panel speaks now. */
export async function words(page: Page): Promise<(typeof WORDS)[keyof typeof WORDS]> {
  return (await inPanel<string>(page, 'document.documentElement.lang')).startsWith('fr') ? WORDS.fr : WORDS.en;
}

/** What the panel shows: the title, the site it names, and the lines it says. */
export function panelWords(page: Page) {
  return inPanel<{ title: string; site: string | null; lines: string[]; close: string | null }>(
    page,
    `({
      title: document.querySelector('h2')?.textContent ?? '',
      site: document.querySelector('.panel-where')?.textContent?.split(' · ')[0] ?? null,
      lines: [...document.querySelectorAll('.panel-state p')].map((line) => line.textContent),
      close: document.querySelector('button.panel-close')?.getAttribute('aria-label') ?? null,
    })`,
  );
}

/** A note on `selector`, with the widget the extension mounted on a site of the workspace. */
export async function plantOn(page: Page, selector: string, note: string): Promise<void> {
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator(selector).click();
  await page.locator('[data-fruitback-note]:visible').fill(note);
  await page.locator('[data-fruitback-send]').click();
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });
}

/** What the panel lists: each row with the number of its drop, its note, and whether it is open. */
export function panelRows(page: Page) {
  return inPanel<{ tabs: string[]; rows: { number: string; note: string; open: boolean }[] }>(
    page,
    `({
      tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
      rows: [...document.querySelectorAll('li[data-note]')].map((row) => ({
        number: row.querySelector('.kit-drop-number')?.textContent ?? '',
        note: row.querySelector('.panel-row-note')?.textContent ?? '',
        open: row.querySelector('.panel-row-head')?.getAttribute('aria-expanded') === 'true',
      })),
    })`,
  );
}

/** A click in the panel, on the button of a row with these words; `row` opens the row. */
export function clickInRow(page: Page, note: string, label: string): Promise<unknown> {
  return inPanel(
    page,
    `(() => {
      const row = [...document.querySelectorAll('li[data-note]')].find((each) => each.querySelector('.panel-row-note')?.textContent === ${JSON.stringify(note)});
      if (${JSON.stringify(label)} === 'row') {
        const head = row?.querySelector('.panel-row-head');
        // Opened, never closed: a row may be open already, from a click on its pin.
        if (head?.getAttribute('aria-expanded') !== 'true') head?.click();
        return head !== undefined;
      }
      const button = [...(row?.querySelectorAll('button') ?? [])].find((each) => each.textContent === ${JSON.stringify(label)});
      button?.click();
      return button !== undefined;
    })()`,
  );
}

/** What « Ready to check » shows: its title, and each note with the line of who fixed it. */
export function readyBlock(page: Page) {
  return inPanel<{ title: string | null; items: { note: string; meta: string }[]; problem: string | null }>(
    page,
    `({
      title: document.querySelector('section.ready h3')?.textContent ?? null,
      items: [...document.querySelectorAll('.ready-item')].map((item) => ({
        note: item.querySelector('.ready-note')?.textContent ?? '',
        meta: item.querySelector('.ready-meta')?.textContent ?? '',
      })),
      problem: document.querySelector('.ready-problem')?.textContent ?? null,
    })`,
  );
}

/** A click on « Looks fixed » or « Still wrong » of the note with these words. */
export function verdict(page: Page, note: string, label: string): Promise<boolean> {
  return inPanel<boolean>(
    page,
    `(() => {
      const item = [...document.querySelectorAll('.ready-item')].find((each) => each.querySelector('.ready-note')?.textContent === ${JSON.stringify(note)});
      const button = [...(item?.querySelectorAll('button') ?? [])].find((each) => each.textContent.trim() === ${JSON.stringify(label)});
      button?.click();
      return button !== undefined;
    })()`,
  );
}

/** The meta line of the row of a note, in the list of the panel. */
export function rowMeta(page: Page, note: string): Promise<string | null> {
  return inPanel<string | null>(
    page,
    `[...document.querySelectorAll('li[data-note]')].find((row) => row.querySelector('.panel-row-note')?.textContent === ${JSON.stringify(note)})?.querySelector('.panel-row-meta')?.textContent ?? null`,
  );
}

/** The source of axe, run in the panel: Playwright hands the panel over as no `Page` for `AxeBuilder`. */
export function axeSource(): string {
  // From the root of the repository, where Playwright runs: a spec has no `import.meta.url`.
  const playwrightAxe = createRequire(`${process.cwd()}/package.json`).resolve('@axe-core/playwright');

  return readFileSync(createRequire(playwrightAxe).resolve('axe-core/axe.min.js'), 'utf8');
}

/** The rows the panel lists now: the words of each, and the path of a row of the whole site. */
export function searchRows(page: Page) {
  return inPanel<{ note: string; meta: string; hollow: boolean }[]>(
    page,
    `[...document.querySelectorAll('.panel-notes li[data-note]')].map((row) => ({
      note: row.querySelector('.panel-row-note')?.textContent ?? '',
      meta: row.querySelector('.panel-row-meta')?.textContent ?? '',
      hollow: row.querySelector('.kit-drop')?.getAttribute('data-hollow') === 'true',
    }))`,
  );
}

/** Types in the search of the panel, as a person does: the value, then an `input` event. */
export function search(page: Page, words: string): Promise<unknown> {
  return inPanel(
    page,
    `(() => {
      const field = document.querySelector('.search-input');
      field.value = ${JSON.stringify(words)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );
}

/** A click on the first element of the panel that `selector` finds, with these words if given. */
export function clickPanel(page: Page, selector: string, text?: RegExp): Promise<boolean> {
  return inPanel<boolean>(
    page,
    `(() => {
      const pattern = ${text === undefined ? 'null' : `new RegExp(${JSON.stringify(text.source)})`};
      const found = [...document.querySelectorAll(${JSON.stringify(selector)})].find((each) => pattern === null || pattern.test(each.textContent));
      found?.click();
      return found !== undefined;
    })()`,
  );
}

/** A click on « Show on the page » of the row of the whole site whose note matches `text` (FRU-434). */
export function clickShowOnPage(page: Page, text: RegExp): Promise<{ tag: string; href: string | null } | null> {
  return inPanel(
    page,
    `(() => {
      const pattern = new RegExp(${JSON.stringify(text.source)});
      const row = [...document.querySelectorAll('.site-row')].find((each) => pattern.test(each.querySelector('.panel-row-note')?.textContent ?? ''));
      const link = [...(row?.querySelectorAll('.site-row-ref') ?? [])].find((each) => /^(Show on the page|Voir sur la page)$/.test(each.textContent));
      if (link === undefined) return null;
      const said = { tag: link.tagName, href: link.getAttribute('href') };
      link.click();
      return said;
    })()`,
  );
}
