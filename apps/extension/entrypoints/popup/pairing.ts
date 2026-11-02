import { browser } from 'wxt/browser';
import { isSecureWorkerEndpoint, workerOrigin } from '../../src/endpoint.ts';
import { type SiteConfig } from '../../src/sites.ts';
import { PAIR_UNAVAILABLE, type SessionIdentity, failedPairing } from '../../src/session.ts';
import { showProblem } from '../../src/problem-view.ts';
import { PAIRING_CODE_REQUIRED, PAIRING_NEEDS_HTTPS, PAIRING_PROBLEM } from '../../src/remedy.ts';
import { type PairLink } from '../../src/pair-link.ts';
import { msg, t } from '../../src/i18n.ts';
import { rememberLanguage } from '../../src/language-sync.ts';
import { requestWorkerAccess } from '../../src/connect-browser.ts';
import { linkButton, make } from '../../src/kit.ts';

import { cloudSeams, field, render, returnAccess, sessions } from './context.ts';

/** The session of a pairing with a worker (FRU-60, FRU-92): the link, the code, the row and its « Sign out » (FRU-560). */

/**
 * Ask for the worker's own origin, which is not the site's.
 *
 * A reviewer grants the **site** they are reviewing; the worker usually lives somewhere else
 * entirely, and nothing had asked for it. The session routes answer a `chrome-extension://` origin
 * with CORS headers that ought to make an unprivileged `fetch` enough — measured against a real
 * worker with a real preflight — but that was measured with `curl`, which does not enforce CORS, and
 * no browser runs on this machine to settle it. So the permission is asked for rather than relied
 * on: granted, the call is privileged and CORS never comes into it. Raised in review, and this is
 * the repository's recurring defect (FRU-25) — correct logic the real caller never reaches.
 *
 * Retained once granted, which is what lets the background refresh and the logout revoke later, with
 * no gesture to ask from.
 */
export function grantWorkerOrigin(endpoint: string): Promise<boolean> {
  return requestWorkerAccess(endpoint);
}

/**
 * The screen for a tab that is a pairing link (FRU-92): the worker it names, and one button.
 *
 * The worker is the page the link is on, so the reviewer reads here what they are about to trust.
 * The person the code was minted for is not known before the code is spent. The worker answers it,
 * and the row then says `Paired as …`: a name read from the link would be the word of whoever
 * wrote the link.
 */
export async function linked(link: PairLink): Promise<HTMLElement[]> {
  const held = (await sessions.list())[link.endpoint];
  if (held !== undefined) {
    // FRU-289: paired by this link, just now, is a success; « already paired » is only for a browser
    // that was paired before the link.
    const said = pairedNow.has(link.endpoint) ? LINK_PAIRED : LINK_ALREADY_PAIRED;

    return [pairedRow(link.endpoint, held.identity), make(document, 'p', 'state', t(said))];
  }

  const submit = make(document, 'button', '', t('Connect to this server'));
  const problem = make(document, 'p', 'problem');
  const wrapper = document.createElement('div');
  wrapper.className = 'session';
  wrapper.append(
    make(document, 'p', 'state', t('This page is a connection link for {worker}.', { worker: link.endpoint })),
    submit,
    problem,
  );

  if (!isSecureWorkerEndpoint(link.endpoint)) {
    submit.disabled = true;
    showProblem(problem, PAIRING_NEEDS_HTTPS);

    return [wrapper];
  }

  const attempt = pairing(link.endpoint, () => link.code, submit, problem, {});
  submit.addEventListener('click', attempt);
  // FRU-302: the same pairing, on the card of the worker in the page of the extension, code filled.
  const page = make(document, 'button', 'secondary', t('Connect in the page of the extension'));
  page.addEventListener('click', () => {
    const query = new URLSearchParams({ worker: link.endpoint, code: link.code });
    void browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}#workers?${query.toString()}` });
    window.close();
  });
  wrapper.append(page);

  return [wrapper];
}

export const LINK_ALREADY_PAIRED = msg('This browser is already connected to that server, so the link is not needed.');

export const LINK_PAIRED = msg('Connected. This browser reads and writes the notes of this server.');

/** The workers this popup paired with, while it is open: the screen after a pairing says it is done. */
export const pairedNow = new Set<string>();

/**
 * Who this browser is paired as with a worker, and the way out. With no name, « Paired » alone and
 * the e-mail under it, in the secondary text (FRU-289), as the card of the page of the extension.
 */
export function pairedRow(endpoint: string, identity: SessionIdentity): HTMLElement {
  const out = logOut(endpoint, make(document, 'button', '', t('Sign out')));

  const row = document.createElement('div');
  row.className = 'row';
  const name = identity.name?.trim();
  row.append(
    make(
      document,
      'span',
      'state',
      name === undefined || name === '' ? t('Connected') : t('Connected as {identity}', { identity: name }),
    ),
    out,
  );

  const wrapper = document.createElement('div');
  wrapper.className = 'session';
  wrapper.append(row);
  if ((name === undefined || name === '') && identity.email !== undefined) {
    const email = make(document, 'p', 'state', identity.email);
    email.classList.add('identity-email');
    wrapper.append(email);
  }

  return wrapper;
}

/**
 * The foot of screen 3 for a session of a pairing (FRU-319): who it is, once, and « Log out » as a
 * link. The person was written three times there (the head, a row « Paired as » and the foot), and
 * « Log out » was a filled pill of the weight of « Leave a note ».
 */
export function pairedFoot(endpoint: string, identity: SessionIdentity): HTMLElement {
  const foot = make(document, 'div', 'popup-foot');
  foot.classList.add('popup-foot-account');
  // The rule of the row (FRU-289): « Paired as » a name, never as an address. With no name, « Paired »
  // and the address beside it.
  const name = identity.name?.trim();
  const email = identity.email?.trim();
  let who = t('Connected');
  if (name !== undefined && name !== '') who = t('Connected as {identity}', { identity: name });
  else if (email !== undefined && email !== '') who = `${who} · ${email}`;
  foot.append(
    make(document, 'span', 'who', who),
    logOut(
      endpoint,
      linkButton(document, t('Sign out'), () => undefined),
    ),
  );

  return foot;
}

/** Logs out of the session of `endpoint` on a click of `out`, then draws the popup again. */
export function logOut<B extends HTMLButtonElement>(endpoint: string, out: B): B {
  out.addEventListener('click', () => {
    out.disabled = true;
    // `logout` revokes on the worker first and clears here whatever that answers. See its comment:
    // a screen that says signed out while this extension still holds a working credential is the
    // one outcome worth avoiding.
    void sessions
      .logout(endpoint)
      // Redrawn whatever it answered, because `logout` clears here whatever the revoke or the
      // epoch write did. Rendering only on success leaves the row saying paired over storage that
      // holds nothing, with a dead button. And a click is fire-and-forget, so a failure nobody
      // logs here is logged nowhere at all. Raised in review.
      .catch((error: unknown) => console.error('[fruitback] the log out did not finish', error))
      // FRU-115: the session was what the access to the worker was for. It stays when a site that is
      // switched on uses that worker, and when the log out left the session in storage.
      .then(() => returnAccess([workerOrigin(endpoint)]))
      .catch((error: unknown) => console.error('[fruitback] could not give back the access to the worker', error))
      .then(() => {
        // The account of that session spoke for the language. Ask who is left to speak for it.
        void rememberLanguage(browser.storage.local, cloudSeams()).catch(() => undefined);

        return render();
      });
  });

  return out;
}

/**
 * One attempt to pair, from the button or from the remedy under a failed one (FRU-90).
 *
 * Both are clicks, and that is the point: the attempt asks for a permission first, and a remedy
 * that ran outside a click would ask for it with no gesture and get no prompt.
 *
 * `change` opens the fields of the rule. A pairing link has no rule, so it passes none.
 */
export function pairing(
  endpoint: string,
  code: () => string,
  submit: HTMLButtonElement,
  problem: HTMLElement,
  { change }: { change?: () => void },
): () => void {
  const attempt = (): void => {
    const value = code().trim();
    showProblem(problem, value === '' ? PAIRING_CODE_REQUIRED : '');
    if (value === '') return;

    // A code is spendable once. A second click while the first is in flight would spend it, then be
    // told by the worker that it is spent — a success reported as a failure. Same rule as the
    // widget's send button.
    submit.disabled = true;

    void (async () => {
      // The permission request is first and nothing is awaited before it, because a host permission
      // may only be asked for while a user gesture is being handled. Same rule as `turnOn`, for the
      // same reason and the same trap: one storage read in front of it and no prompt ever appears.
      // A call that throws is a failure like the others (FRU-510): it must not leave the button off.
      const granted = await grantWorkerOrigin(endpoint).catch(failedPairing(false));
      const result = granted ? await sessions.pair(endpoint, value).catch(failedPairing(PAIR_UNAVAILABLE)) : undefined;
      if (result?.ok === true) {
        pairedNow.add(endpoint);
        void render();

        return;
      }

      submit.disabled = false;
      showProblem(problem, PAIRING_PROBLEM[result === undefined ? 'blocked' : result.reason], {
        retry: attempt,
        grant: attempt,
        ...(change === undefined ? {} : { change }),
      });
    })();
  };

  return attempt;
}

/**
 * Paste a code, see who you are, log out (FRU-60).
 *
 * Deliberately thin: everything it decides lives in `src/session.ts`, where `node --test` can reach
 * it. What is here is four elements and the two strings a person reads.
 */
export async function session(site: SiteConfig): Promise<HTMLElement[]> {
  const endpoint = site.endpoint;
  const held = (await sessions.list())[endpoint];
  // Private mode carries no session, so it offers no pairing (FRU-88). A session that this worker
  // already holds stays on the screen, with its log out.
  if (held === undefined && site.mode !== 'team') return [];
  if (held !== undefined) return [pairedRow(endpoint, held.identity)];

  const code = field(t('Connection code'), 'ABCD-EFGH-JKMN');
  const submit = make(document, 'button', '', t('Connect to this server'));
  const problem = make(document, 'p', 'problem');

  // The worker this rule names is what is wrong, so the way out is the fields of the rule.
  const change = (): void => void render(true);

  // Pairing spends a code and is handed a refresh token — thirty days of access — so it does not
  // happen over plain http. Loopback excepted: that is the dev loop. Raised in review.
  if (!isSecureWorkerEndpoint(endpoint)) {
    submit.disabled = true;
    showProblem(problem, PAIRING_NEEDS_HTTPS, { change });
  }

  submit.addEventListener(
    'click',
    pairing(endpoint, () => code.input.value, submit, problem, { change }),
  );

  // A link pairs with no code to copy (FRU-92), so the field is one step away: it is what a
  // reviewer uses when the link did not reach them, or when the operator read a code out.
  const typed = document.createElement('div');
  typed.hidden = isSecureWorkerEndpoint(endpoint);
  typed.append(code.label, submit, problem);

  const reveal = make(document, 'button', 'secondary', t('I have a code'));
  reveal.hidden = typed.hidden === false;
  reveal.setAttribute('aria-expanded', 'false');
  reveal.addEventListener('click', () => {
    typed.hidden = false;
    reveal.hidden = true;
    reveal.setAttribute('aria-expanded', 'true');
    code.input.focus();
  });

  const row = document.createElement('div');
  row.className = 'row';
  // Said plainly, because it is the difference between a page that shows this reviewer's pins and
  // one that shows nothing at all: the relay refuses a call it has no session for, rather than
  // making it without one.
  row.append(make(document, 'span', 'state', t('Not connected. This site cannot reach the server until you connect.')));

  const wrapper = document.createElement('div');
  wrapper.className = 'session';
  wrapper.append(row, make(document, 'p', 'state', t(HOW_TO_PAIR)), reveal, typed);

  return [wrapper];
}

export const HOW_TO_PAIR = msg('Open the connection link you were sent, then click this icon on that page.');
