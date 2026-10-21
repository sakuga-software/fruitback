import { t } from './i18n.ts';

/**
 * The section « Share rules » of the page of the extension (FRU-290), as the mock-up of 2026-10-20
 * draws it: two cards side by side, « Export » and « Import a rules file ».
 *
 * The import card is a `label` around a file input. The input stays in the DOM, out of sight but in
 * the tab order, so the keyboard and a screen reader reach the native picker. The card also takes a
 * file that is dropped on it. No `browser` here: `entrypoints/options/main.ts` reads and writes the
 * rules, so `share-rules.test.ts` reads this part on happy-dom.
 */

/** The name of the file « Download » writes. The import reads any name: the file says what it is. */
export const RULES_FILE = 'fruitback-rules.json';

export type ShareOptions = {
  /** Downloads the rules. The page disables the button until it has read the rules once. */
  onDownload: () => void;
  /** Reads a file somebody chose or dropped. */
  onFile: (file: File) => void;
};

export type ShareSection = {
  section: HTMLElement;
  /** The « Download » button, for the page to enable once the rules are read. */
  download: HTMLButtonElement;
  /** Where the import says what it did, or why it did nothing. A live region. */
  result: HTMLElement;
  /** Writes the number of rules the export holds. `undefined` until the page has read them. */
  setCount: (count: number | undefined) => void;
};

function make<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== '') node.textContent = text;

  return node;
}

/** « 5 rules · fruitback-rules.json », or the name of the file alone before the rules are read. */
export function exportSummary(count: number | undefined): string {
  if (count === undefined) return RULES_FILE;
  const rules = count === 1 ? t('1 rule') : t('{count} rules', { count });

  return `${rules} · ${RULES_FILE}`;
}

/**
 * What « Download » says once the file is written (FRU-319): the download was silent, and a screen
 * reader heard nothing. Said in the result of the card, which is a polite status.
 */
export function downloadedSummary(count: number): string {
  return count === 1
    ? t('Downloaded {file}, with 1 rule.', { file: RULES_FILE })
    : t('Downloaded {file}, with {count} rules.', { file: RULES_FILE, count });
}

export function shareRules(document: Document, options: ShareOptions): ShareSection {
  const section = make(document, 'section', 'page-section');
  section.classList.add('share');
  // The anchor of « Share rules » in the menu of the page.
  section.id = 'share';
  const title = make(document, 'h2', '', t('Share rules'));
  title.id = 'share-title';
  section.setAttribute('aria-labelledby', title.id);
  const intro = make(
    document,
    'p',
    'share-intro',
    t(
      'Hand a reviewer a rules file instead of five fields to copy. Browser access never travels with it: they grant it on first use.',
    ),
  );

  // Export: what the file holds, and « Download ».
  const exportCard = make(document, 'div', 'share-card');
  exportCard.classList.add('share-export');
  const exportWords = make(document, 'div', 'share-words');
  const summary = make(document, 'span', 'share-hint', exportSummary(undefined));
  exportWords.append(make(document, 'span', 'share-title', t('Export')), summary);
  const download = make(document, 'button', 'share-button', t('Download'));
  download.type = 'button';
  download.disabled = true;
  download.setAttribute('aria-describedby', 'share-export-hint');
  summary.id = 'share-export-hint';
  download.addEventListener('click', options.onDownload);
  exportCard.append(exportWords, download);

  // Import: a label around the input, so a click anywhere on the card opens the picker.
  const importCard = make(document, 'label', 'share-card');
  importCard.classList.add('share-import');
  const importWords = make(document, 'span', 'share-words');
  const importTitle = make(document, 'span', 'share-title', t('Import a rules file'));
  importTitle.id = 'share-import-title';
  const importHint = make(document, 'span', 'share-hint', t('Drop it here, or choose one'));
  importHint.id = 'share-import-hint';
  importWords.append(importTitle, importHint);
  // A picture of a button: the input below is what the keyboard reaches and what a click opens.
  const choose = make(document, 'span', 'share-button', t('Choose…'));
  choose.classList.add('share-choose');
  choose.setAttribute('aria-hidden', 'true');
  const input = make(document, 'input', 'share-input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.setAttribute('aria-labelledby', importTitle.id);
  input.setAttribute('aria-describedby', `${importHint.id} share-result`);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    // Emptied at once, so the same file chosen again fires `change` again.
    input.value = '';
    if (file !== undefined) options.onFile(file);
  });
  importCard.append(importWords, choose, input);

  // A file dropped on the card is read like a file chosen. `dragover` must be cancelled for `drop`
  // to fire; the class shows the card is where the file goes.
  importCard.addEventListener('dragover', (event) => {
    // The type the browsers give a drag of files, compared without its case.
    const transfer = event.dataTransfer;
    if (transfer === null || ![...transfer.types].some((type) => type.toLowerCase() === 'files')) return;
    event.preventDefault();
    transfer.dropEffect = 'copy';
    importCard.classList.add('dragging');
  });
  importCard.addEventListener('dragleave', () => importCard.classList.remove('dragging'));
  importCard.addEventListener('drop', (event) => {
    event.preventDefault();
    importCard.classList.remove('dragging');
    const file = event.dataTransfer?.files[0];
    if (file !== undefined) options.onFile(file);
  });

  const cards = make(document, 'div', 'share-cards');
  cards.append(exportCard, importCard);
  const result = make(document, 'p', 'share-result');
  result.id = 'share-result';
  result.setAttribute('role', 'status');
  result.setAttribute('aria-live', 'polite');
  section.append(title, intro, cards, result);

  return {
    section,
    download,
    result,
    setCount: (count) => {
      summary.textContent = exportSummary(count);
    },
  };
}
