import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import { RULES_FILE, exportSummary, shareRules } from './share-rules.ts';
import { type RuleRow, rulePanel, scopeOf, sitesTable } from './site-page.ts';

/**
 * « Share rules » of the page of the extension (FRU-290), read on happy-dom. The file picker, the
 * drop of a real file and the measures are `e2e/extension-page.spec.ts`'s.
 */

function page(): { window: HappyDomWindow; document: Document } {
  const window = new HappyDomWindow({ url: 'chrome-extension://fruitback/options.html' });

  return { window, document: window.document as unknown as Document };
}

const nothing = () => {};

afterEach(() => setLanguage('en'));

describe('« Share rules » (FRU-290)', () => {
  it('has an export card and an import card, with the words of the mock-up', () => {
    const { document } = page();
    const { section } = shareRules(document, { onDownload: nothing, onFile: nothing });

    assert.equal(section.querySelector('h2')?.textContent, 'Share rules');
    assert.equal(section.getAttribute('aria-labelledby'), section.querySelector('h2')?.id);
    assert.equal(
      section.querySelector('.share-intro')?.textContent,
      'Hand a reviewer a rules file instead of five fields to copy. Browser access never travels with it: they grant it on first use.',
    );
    const exportCard = section.querySelector('.share-export');
    assert.equal(exportCard?.querySelector('.share-title')?.textContent, 'Export');
    assert.equal(exportCard?.querySelector('button')?.textContent, 'Download');
    const importCard = section.querySelector('label.share-import');
    assert.equal(importCard?.querySelector('.share-title')?.textContent, 'Import a rules file');
    assert.equal(importCard?.querySelector('.share-hint')?.textContent, 'Drop it here, or choose one');
    assert.equal(importCard?.querySelector('.share-choose')?.textContent, 'Choose…');
  });

  it('keeps a file input in the card, named by the card and described by the result', () => {
    const { document } = page();
    const { section, result } = shareRules(document, { onDownload: nothing, onFile: nothing });
    const input = section.querySelector<HTMLInputElement>('input[type="file"]');

    assert.ok(input, 'no file input');
    assert.equal(input.accept, 'application/json,.json');
    assert.equal(input.tabIndex, 0, 'the input left the tab order');
    assert.equal(
      section.querySelector(`#${input.getAttribute('aria-labelledby') ?? ''}`)?.textContent,
      'Import a rules file',
    );
    assert.match(input.getAttribute('aria-describedby') ?? '', new RegExp(`\\b${result.id}\\b`));
    // The picture of the button is not read twice.
    assert.equal(section.querySelector('.share-choose')?.getAttribute('aria-hidden'), 'true');
    assert.equal(result.getAttribute('aria-live'), 'polite');
    assert.equal(result.getAttribute('role'), 'status');
  });

  it('says how many rules the file will hold, once the page has read them', () => {
    const { document } = page();
    const share = shareRules(document, { onDownload: nothing, onFile: nothing });
    const summary = () => share.section.querySelector('.share-export .share-hint')?.textContent;

    assert.equal(summary(), RULES_FILE);
    assert.equal(share.download.disabled, true, 'a download before the list is read holds no rules');
    share.setCount(5);
    assert.equal(summary(), '5 rules · fruitback-rules.json');
    share.setCount(1);
    assert.equal(summary(), '1 rule · fruitback-rules.json');
    assert.equal(exportSummary(0), '0 rules · fruitback-rules.json');
  });

  it('downloads at a click on « Download »', () => {
    const { document } = page();
    let downloads = 0;
    const share = shareRules(document, { onDownload: () => (downloads += 1), onFile: nothing });
    share.download.disabled = false;
    share.download.click();

    assert.equal(downloads, 1);
  });

  it('reads a file that is dropped on the import card, and marks the card while it is over it', () => {
    const { window, document } = page();
    const files: File[] = [];
    const { section } = shareRules(document, { onDownload: nothing, onFile: (file) => files.push(file) });
    const card = section.querySelector('label.share-import') as HTMLElement;
    const file = new window.File(['{}'], 'fruitback-rules.json', { type: 'application/json' }) as unknown as File;
    const transfer = { types: ['Files'], files: [file], dropEffect: 'none' };

    const over = new window.Event('dragover', { cancelable: true }) as unknown as DragEvent;
    Object.defineProperty(over, 'dataTransfer', { value: transfer });
    card.dispatchEvent(over);
    assert.equal(over.defaultPrevented, true, 'a drop is refused unless dragover is cancelled');
    assert.ok(card.classList.contains('dragging'));

    const drop = new window.Event('drop', { cancelable: true }) as unknown as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    card.dispatchEvent(drop);
    assert.equal(drop.defaultPrevented, true, 'the browser would open the file in the tab');
    assert.ok(!card.classList.contains('dragging'));
    assert.deepEqual(files, [file]);
  });

  it('does not take a drag that carries no file, such as a selected text', () => {
    const { window, document } = page();
    const { section } = shareRules(document, { onDownload: nothing, onFile: nothing });
    const card = section.querySelector('label.share-import') as HTMLElement;
    const over = new window.Event('dragover', { cancelable: true }) as unknown as DragEvent;
    Object.defineProperty(over, 'dataTransfer', { value: { types: ['text/plain'], files: [] } });
    card.dispatchEvent(over);

    assert.equal(over.defaultPrevented, false);
    assert.ok(!card.classList.contains('dragging'));
  });

  it('is in French for a French reader', () => {
    setLanguage('fr');
    const { document } = page();
    const share = shareRules(document, { onDownload: nothing, onFile: nothing });
    share.setCount(3);

    assert.equal(share.section.querySelector('h2')?.textContent, 'Partager les règles');
    assert.equal(share.download.textContent, 'Télécharger');
    assert.equal(
      share.section.querySelector('.share-export .share-hint')?.textContent,
      '3 règles · fruitback-rules.json',
    );
    assert.equal(
      share.section.querySelector('.share-import .share-title')?.textContent,
      'Importer un fichier de règles',
    );
  });
});

describe('a rule read from a rules file (FRU-290)', () => {
  const IMPORTED: RuleRow = {
    pattern: 'https://beta.legacy-shop.fr',
    site: { mode: 'private', endpoint: 'https://feedback.sakuga.dev', clientId: 'legacy', enabled: true },
    granted: false,
    imported: true,
  };

  it('says « imported » under its site, in the table and in its panel', () => {
    const { document } = page();
    const table = sitesTable(document, { rows: [IMPORTED], onSelect: nothing, onToggle: nothing });
    const panel = rulePanel(document, { row: IMPORTED, onGrant: nothing, onSave: nothing, onRemove: nothing });

    assert.equal(table.querySelector('.rule-scope')?.textContent, 'This origin · imported');
    assert.equal(panel.querySelector('.panel-scope')?.textContent, 'This origin · imported');
    assert.equal(scopeOf(IMPORTED.pattern), 'This origin', 'a rule typed in says nothing of a file');
  });

  it('says that access did not travel with the file, and offers « Grant access »', () => {
    const { document } = page();
    const panel = rulePanel(document, { row: IMPORTED, onGrant: nothing, onSave: nothing, onRemove: nothing });

    assert.equal(panel.querySelector('.panel-state-title')?.textContent, 'No access in this browser');
    assert.equal(
      panel.querySelector('.panel-state-text')?.textContent,
      'This rule came from a rules file, and access does not travel with it. Nothing is mounted until you grant it.',
    );
    assert.equal(panel.querySelector('.panel-state button')?.textContent, 'Grant access');
  });
});
