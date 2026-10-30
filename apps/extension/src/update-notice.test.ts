import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import { updateLine } from './kit.ts';
import {
  CHECK_EVERY_MS,
  type Checked,
  type UpdateDeps,
  availableUpdate,
  intoPopup,
  isNewer,
  keepInPopup,
  parseRelease,
  updatedByHand,
} from './update-notice.ts';

/** The line of a new release (FRU-519): who is asked, how often, and what the line says. */

const RELEASE = { tag_name: 'v0.6.0', html_url: 'https://github.com/sakuga-software/fruitback/releases/tag/v0.6.0' };
const NOW = Date.UTC(2026, 9, 30, 12);

function deps(overrides: Partial<UpdateDeps> & { stored?: unknown } = {}): {
  deps: UpdateDeps;
  calls: { fetches: number; written: Checked[] };
} {
  const calls = { fetches: 0, written: [] as Checked[] };
  const { stored, ...rest } = overrides;

  return {
    calls,
    deps: {
      installed: '0.5.0',
      installType: async () => 'development',
      read: async () => stored,
      write: async (checked) => {
        calls.written.push(checked);
      },
      fetchLatest: async () => {
        calls.fetches += 1;

        return RELEASE;
      },
      now: () => NOW,
      ...rest,
    },
  };
}

afterEach(() => setLanguage('en'));

describe('the line of a new release (FRU-519)', () => {
  it('tells an install loaded by hand that a newer release is out', async () => {
    const { deps: given, calls } = deps();

    assert.deepEqual(await availableUpdate(given), {
      version: '0.6.0',
      url: 'https://github.com/sakuga-software/fruitback/releases/tag/v0.6.0',
    });
    assert.equal(calls.fetches, 1);
    assert.deepEqual(calls.written, [{ checkedAt: NOW, release: { version: '0.6.0', url: RELEASE.html_url } }]);
  });

  it('asks nothing for an install that a store or a policy updates, nor when the browser does not say', async () => {
    for (const installType of ['normal', 'admin', undefined]) {
      const { deps: given, calls } = deps({ installType: async () => installType });

      assert.equal(await availableUpdate(given), undefined, String(installType));
      assert.equal(calls.fetches, 0, String(installType));
    }
    assert.equal(updatedByHand('sideload'), true);
    assert.equal(updatedByHand('other'), true);
  });

  it('says nothing when the extension is the last release, or newer', async () => {
    for (const installed of ['0.6.0', '0.7.0', '1.0']) {
      assert.equal(await availableUpdate(deps({ installed }).deps), undefined, installed);
    }
  });

  it('asks GitHub once a day, and reads what it kept in between', async () => {
    const kept = { checkedAt: NOW - CHECK_EVERY_MS + 1, release: { version: '0.6.0', url: RELEASE.html_url } };
    const fresh = deps({ stored: kept });
    assert.equal((await availableUpdate(fresh.deps))?.version, '0.6.0');
    assert.equal(fresh.calls.fetches, 0);

    const stale = deps({ stored: { ...kept, checkedAt: NOW - CHECK_EVERY_MS } });
    await availableUpdate(stale.deps);
    assert.equal(stale.calls.fetches, 1);
  });

  it('keeps what it knew when GitHub does not answer, and writes nothing', async () => {
    const kept = { checkedAt: 0, release: { version: '0.6.0', url: RELEASE.html_url } };
    const { deps: given, calls } = deps({
      stored: kept,
      fetchLatest: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    assert.equal((await availableUpdate(given))?.version, '0.6.0');
    assert.deepEqual(calls.written, []);
  });

  it('counts an answer it cannot read as a check, so it does not ask again within the day', async () => {
    const { deps: given, calls } = deps({ fetchLatest: async () => ({ message: 'Not Found' }) });

    assert.equal(await availableUpdate(given), undefined);
    assert.deepEqual(calls.written, [{ checkedAt: NOW }]);
  });

  it('takes a release only with a tag `v1.2.3` and a page of the releases of the repository', () => {
    assert.deepEqual(parseRelease(RELEASE), { version: '0.6.0', url: RELEASE.html_url });
    assert.equal(parseRelease({ ...RELEASE, tag_name: 'v0.6.0-beta.1' }), undefined);
    assert.equal(parseRelease({ ...RELEASE, html_url: 'https://evil.example/releases/tag/v0.6.0' }), undefined);
    assert.equal(
      parseRelease({ ...RELEASE, html_url: 'https://github.com/sakuga-software/fruitback-fork/releases/tag/v0.6.0' }),
      undefined,
    );
    assert.equal(parseRelease(null), undefined);
  });

  it('reads a kept link the same way: a page elsewhere is not shown', async () => {
    const kept = { checkedAt: NOW, release: { version: '0.6.0', url: 'javascript:alert(1)' } };

    assert.equal(await availableUpdate(deps({ stored: kept }).deps), undefined);
  });

  it('compares versions number by number, not as text', () => {
    assert.equal(isNewer('0.10.0', '0.9.0'), true);
    assert.equal(isNewer('0.9.0', '0.10.0'), false);
    assert.equal(isNewer('1.0', '0.99.99'), true);
    assert.equal(isNewer('0.5.0', '0.5'), false);
    assert.equal(isNewer('nightly', '0.5.0'), false);
  });

  it('draws one status line, the link to the release in a new tab, in both languages', () => {
    const document = new HappyDomWindow({ url: 'chrome-extension://fruitback/popup.html' })
      .document as unknown as Document;
    const line = updateLine(document, { version: '0.6.0', url: RELEASE.html_url });

    assert.equal(line.getAttribute('role'), 'status');
    assert.equal(line.textContent, 'Fruitback 0.6.0 is out. Update');
    const link = line.querySelector('a');
    assert.equal(link?.getAttribute('href'), RELEASE.html_url);
    assert.equal(link?.target, '_blank');
    assert.equal(link?.rel, 'noreferrer');

    setLanguage('fr');
    assert.equal(
      updateLine(document, { version: '0.6.0', url: RELEASE.html_url }).textContent,
      'Fruitback 0.6.0 est disponible. Mettre à jour',
    );
  });

  it('goes above the foot of a shell of the popup, once, and at its end when it has no foot', () => {
    const document = new HappyDomWindow({ url: 'chrome-extension://fruitback/popup.html' })
      .document as unknown as Document;
    const line = updateLine(document, { version: '0.6.0', url: RELEASE.html_url });
    const shell = (...parts: string[]): HTMLElement => {
      const root = document.createElement('div');
      for (const part of parts) root.append(Object.assign(document.createElement('div'), { className: part }));

      return root;
    };
    const screen = shell('popup-head', 'popup-body', 'popup-foot');

    intoPopup(screen, line);
    intoPopup(screen, line);
    assert.deepEqual(
      [...screen.children].map((child) => child.className),
      ['popup-head', 'popup-body', 'kit-update', 'popup-foot'],
    );

    const bare = shell('popup-head', 'popup-body');
    intoPopup(bare, line);
    assert.equal(bare.lastElementChild, line);
  });

  it('puts the line back after each draw of the popup, and does not wake itself (review of #731)', async () => {
    const window = new HappyDomWindow({ url: 'chrome-extension://fruitback/popup.html' });
    const document = window.document as unknown as Document;
    const app = document.createElement('main');
    document.body.append(app);
    const shell = (): HTMLElement => {
      const root = document.createElement('div');
      root.className = 'popup';
      for (const part of ['popup-head', 'popup-body', 'popup-foot']) {
        root.append(Object.assign(document.createElement('div'), { className: part }));
      }

      return root;
    };
    const line = updateLine(document, { version: '0.6.0', url: RELEASE.html_url });
    const settle = async (): Promise<void> => {
      await window.happyDOM.waitUntilComplete();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    // Every change of the children of `app`. The draws make them; placing the line must make none.
    const records: MutationRecord[] = [];
    new (window.MutationObserver as unknown as typeof MutationObserver)((seen) => {
      records.push(...seen);
    }).observe(app, { childList: true });

    app.replaceChildren(shell());
    const observer = keepInPopup(app, line);
    assert.equal(app.querySelector('.popup')?.contains(line), true);

    // The loading screen has no shell: no line, and nothing breaks.
    app.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Loading' }));
    await settle();
    assert.equal(line.isConnected, false);

    // Two draws, two shells: the line is in the last one, above its foot.
    app.replaceChildren(shell());
    await settle();
    app.replaceChildren(shell());
    await settle();
    assert.deepEqual(
      [...(app.querySelector('.popup')?.children ?? [])].map((child) => child.className),
      ['popup-head', 'popup-body', 'kit-update', 'popup-foot'],
    );
    // No loop: once settled, nothing more happens, and no record of `app` holds the line.
    const settled = records.length;
    await settle();
    await settle();
    assert.equal(records.length, settled);
    assert.equal(
      records.some((record) => [...record.addedNodes].includes(line)),
      false,
    );
    observer.disconnect();
  });

  it('shows what it knew when GitHub never answers, and aborts the request (review of #731)', async () => {
    const kept = { checkedAt: 0, release: { version: '0.6.0', url: RELEASE.html_url } };
    let aborted = false;
    const { deps: given, calls } = deps({
      stored: kept,
      timeoutMs: 20,
      // A request that never ends: no answer, no error.
      fetchLatest: (signal) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });

        return new Promise(() => undefined);
      },
    });

    assert.equal((await availableUpdate(given))?.version, '0.6.0');
    assert.equal(aborted, true);
    assert.deepEqual(calls.written, []);
  });
});
