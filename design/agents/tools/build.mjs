// Builds design/agents/agents.html, the board of FRU-462 (the screen « Agents » of a workspace).
//
// Run from anywhere: `node design/agents/tools/build.mjs`. It needs no package. Every word goes
// through `t(en, fr)`, which also fills the table of the texts at the end of the board.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// --- words ------------------------------------------------------------------------------------------
const texts = new Map();
let lang = 'en';
const t = (en, fr, vars = {}) => {
  if (!texts.has(en)) texts.set(en, fr);
  let out = lang === 'fr' ? fr : en;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  return out;
};
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

// --- pieces -----------------------------------------------------------------------------------------
const icon = {
  warn: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5M12 18v.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  down: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  up: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ok: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const SITES = ['shop.acme.dev', 'blog.acme.dev', 'docs.acme.dev'];
const KEY = 'fbk_Q2xhdWRlIG9uIENJIG1hZGUgb24gMjggT2N0b2Jlcg9x';
const WORKER = 'https://api.fruitback.com';

function rail(width) {
  const nav = [
    t('Sites', 'Sites'),
    t('Notes', 'Notes'),
    t('Connectors', 'Connecteurs'),
    t('Members', 'Membres'),
    t('My account', 'Mon compte'),
  ]
    .map((w) => `<a href="#">${w}</a>`)
    .join('');
  return `<aside class="rail${width < 900 ? ' rail-row' : ''}">
    <a href="#" class="ws" aria-current="page"><span class="ws-i">A</span><span><b>Acme</b><small>${t('Cloud workspace', 'Workspace Cloud')}</small></span></a>
    <nav aria-label="${t('Workspace', 'Workspace')}">${nav}</nav>
  </aside>`;
}

function page(width, { body, head = true, button = true, disabled = false }) {
  return `<div class="app w${width}">
    ${rail(width)}
    <div class="main-wrap"><main>
      <nav class="crumbs" aria-label="${t('Breadcrumb', 'Fil d’Ariane')}"><a href="#">${t('Workspace settings', 'Réglages du workspace')}</a><span aria-hidden="true">›</span><span>${t('Agents', 'Agents')}</span></nav>
      ${
        head
          ? `<header class="pg-head">
        <div>
          <h1>${t('Agents', 'Agents')}</h1>
          <p class="lead">${t(
            'A key lets an AI agent of your team read the notes of some sites through the MCP server of Fruitback, and reply to them when you allow it. Fruitback calls no model: the agent is yours.',
            'Une clé permet à un agent IA de votre équipe de lire les notes de certains sites par le serveur MCP de Fruitback, et d’y répondre si vous l’autorisez. Fruitback n’appelle aucun modèle : l’agent est le vôtre.',
          )} <a href="#">${t('Connect an AI agent', 'Connecter un agent IA')}</a></p>
        </div>
        ${button ? `<button type="button" class="b-accent pill"${disabled ? ' aria-disabled="true"' : ''}>${t('New key', 'Nouvelle clé')}</button>` : ''}
      </header>`
          : `<header class="pg-head"><div><h1>${t('Agents', 'Agents')}</h1></div></header>`
      }
      ${body}
    </main></div>
  </div>`;
}

// --- the keys of the frames -------------------------------------------------------------------------
const KEYS = () => [
  {
    name: 'Claude on CI',
    made: t('28 Oct', '28 oct.'),
    sites: [SITES[0], SITES[1]],
    write: true,
    verifiedOnly: true,
    last: t('12 min ago', 'il y a 12 min'),
    ends: t('26 Jan 2027', '26 janv. 2027'),
    state: 'ok',
  },
  {
    name: 'Nightly triage',
    made: t('3 Aug', '3 août'),
    sites: [SITES[2]],
    write: false,
    verifiedOnly: false,
    last: t('Yesterday', 'Hier'),
    ends: t('2 Nov', '2 nov.'),
    state: 'soon',
    days: 5,
  },
  {
    name: 'Old reader',
    made: t('22 Jul', '22 juil.'),
    sites: [SITES[0]],
    write: false,
    verifiedOnly: true,
    last: null,
    ends: t('20 Oct', '20 oct.'),
    state: 'ended',
  },
];

const rights = (k) =>
  `${k.write ? t('Read, reply and set a status', 'Lire, répondre et changer un statut') : t('Read the notes', 'Lire les notes')}<small>${
    k.verifiedOnly
      ? t('Notes of known people only', 'Notes de personnes connues seulement')
      : t('Every note, a visitor’s too', 'Toutes les notes, celles des visiteurs aussi')
  }</small>`;

function ends(k) {
  if (k.state === 'soon')
    return `<span class="soon">${icon.warn}${t('Ends in {count} days', 'Prend fin dans {count} jours', { count: k.days })}</span><small>${k.ends}</small>`;
  if (k.state === 'ended')
    return `<span class="chip">${t('Ended', 'Terminée')}</span><small>${t('On {day}', 'Le {day}', { day: k.ends })}</small>`;
  return `${k.ends}`;
}

function row(k, { open = false, writes = '' } = {}) {
  return `<li class="k-row${open ? ' is-open' : ''}">
    <div class="c-name"><b>${esc(k.name)}</b><small>${t('Made on {day}', 'Créée le {day}', { day: k.made })}</small></div>
    <div class="c-sites"><span class="lbl-m">${t('Sites', 'Sites')}</span><span>${k.sites.map((s) => `<span class="host">${s}</span>`).join('')}</span></div>
    <div class="c-rights"><span class="lbl-m">${t('Can', 'Peut')}</span><span>${rights(k)}</span></div>
    <div class="c-last"><span class="lbl-m">${t('Last used', 'Dernier usage')}</span><span>${k.last ?? `<span class="muted">${t('Never used', 'Jamais utilisée')}</span>`}</span></div>
    <div class="c-ends"><span class="lbl-m">${t('Ends', 'Fin')}</span><span>${ends(k)}</span></div>
    <div class="c-actions">
      <button type="button" class="b-wide sm${open ? ' pressed' : ''}" aria-expanded="${open}">${t('Writes', 'Écritures')}${open ? icon.up : icon.down}</button>
      <button type="button" class="b-ghost sm danger">${t('Revoke', 'Révoquer')}</button>
    </div>
    ${open ? writes : ''}
  </li>`;
}

function list(keys, opts = {}) {
  return `<div class="k-head" aria-hidden="true"><span>${t('Key', 'Clé')}</span><span>${t('Sites', 'Sites')}</span><span>${t('Can', 'Peut')}</span><span>${t('Last used', 'Dernier usage')}</span><span>${t('Ends', 'Fin')}</span><span></span></div>
  <ul class="k-list" aria-label="${t('Agent keys', 'Clés d’agent')}">${keys.map((k, i) => row(k, opts[i] ?? {})).join('')}</ul>
  <p class="foot">${t('{count} of 20 keys.', '{count} clés sur 20.', { count: keys.length })}</p>`;
}

const soonNotice = () =>
  `<div class="callout warn" role="status">${icon.warn}<p>${t(
    '« Nightly triage » ends in 5 days. Its agent stops then: make a new key, give it to the agent, then revoke this one.',
    '« Nightly triage » prend fin dans 5 jours. Son agent s’arrête alors : créez une nouvelle clé, donnez-la à l’agent, puis révoquez celle-ci.',
  )}</p></div>`;

const writesPanel = (
  fullList = false,
) => `<div class="writes" role="region" aria-label="${t('Writes of {name}', 'Écritures de {name}', { name: 'Claude on CI' })}">
  <h3>${t('What this key wrote', 'Ce que cette clé a écrit')}</h3>
  <ol>
    <li><span class="w-what">${t('Replied to a note', 'A répondu à une note')}</span><span class="host">${SITES[0]}</span><code>sd_8f2k1x</code><span class="w-when">${t('12 min ago', 'il y a 12 min')}</span></li>
    <li><span class="w-what">${t('Set the status to « {status} »', 'A passé le statut à « {status} »', { status: t('Done', 'Terminé') })}</span><span class="host">${SITES[0]}</span><code>sd_8f2k1x</code><span class="w-when">${t('12 min ago', 'il y a 12 min')}</span></li>
    <li><span class="w-what">${t('Set the status to « {status} »', 'A passé le statut à « {status} »', { status: t('In progress', 'En cours') })}</span><span class="host">${SITES[1]}</span><code>sd_3jq90a</code><span class="w-when">${t('2 h ago', 'il y a 2 h')}</span></li>
    <li><span class="w-what">${t('Replied to a note', 'A répondu à une note')}</span><span class="host">${SITES[1]}</span><code>sd_3jq90a</code><span class="w-when">${t('Yesterday', 'Hier')}</span></li>
  </ol>
  <p class="hint">${
    fullList
      ? t('The last 100 writes are listed.', 'Les 100 dernières écritures sont listées.')
      : t(
          'A reply shows in the thread of its note as « Agent », beside the name of the key. A status can be set back on the page of the note.',
          'Une réponse apparaît dans le fil de sa note avec « Agent », à côté du nom de la clé. Un statut se remet sur la page de la note.',
        )
  }</p>
</div>`;

const noWrites =
  () => `<div class="writes" role="region" aria-label="${t('Writes of {name}', 'Écritures de {name}', { name: 'Nightly triage' })}">
  <h3>${t('What this key wrote', 'Ce que cette clé a écrit')}</h3>
  <p class="empty">${t('This key wrote nothing yet. A key that only reads never writes.', 'Cette clé n’a encore rien écrit. Une clé qui ne fait que lire n’écrit jamais.')}</p>
</div>`;

function form({ error = false } = {}) {
  const site = (s, checked) =>
    `<label class="check"><input type="checkbox"${checked ? ' checked' : ''}><span class="host">${s}</span><small>${s === SITES[2] ? t('Everyone reads its notes', 'Tout le monde lit ses notes') : t('Members read its notes', 'Les membres lisent ses notes')}</small></label>`;
  return `<section class="card form" aria-labelledby="new-key-title">
    <h2 id="new-key-title">${t('New agent key', 'Nouvelle clé d’agent')}</h2>
    <div class="field${error ? ' bad' : ''}">
      <label for="kn">${t('Name', 'Nom')}</label>
      <input id="kn" value="${error ? '' : 'Claude on CI'}" ${error ? 'aria-invalid="true" class="focus"' : ''}>
      ${
        error
          ? `<p class="err">${t('Give the key a name.', 'Donnez un nom à la clé.')}</p>`
          : `<p class="hint">${t('Its replies are signed with it, beside « Agent ».', 'Ses réponses sont signées de ce nom, à côté de « Agent ».')}</p>`
      }
    </div>
    <fieldset class="field${error ? ' bad' : ''}">
      <legend>${t('Sites', 'Sites')}</legend>
      <div class="checks">${site(SITES[0], !error)}${site(SITES[1], !error)}${site(SITES[2], false)}</div>
      ${
        error
          ? `<p class="err">${t('Choose at least one site.', 'Choisissez au moins un site.')}</p>`
          : `<p class="hint">${t('The key reads nothing of another site. 20 at most.', 'La clé ne lit rien d’un autre site. 20 au plus.')}</p>`
      }
    </fieldset>
    <fieldset class="field">
      <legend>${t('What the agent can do', 'Ce que l’agent peut faire')}</legend>
      <label class="radio"><input type="radio" name="r"><span><b>${t('Read the notes', 'Lire les notes')}</b><small>${t('Their text, page, element, component, file and line, picture, replies and status.', 'Leur texte, page, élément, composant, fichier et ligne, capture, réponses et statut.')}</small></span></label>
      <label class="radio"><input type="radio" name="r" checked><span><b>${t('Read, reply and set a status', 'Lire, répondre et changer un statut')}</b><small>${t('A reply says it is from an agent. A status is set only on a note that Fruitback keeps.', 'Une réponse dit qu’elle vient d’un agent. Un statut ne change que sur une note que garde Fruitback.')}</small></span></label>
    </fieldset>
    <div class="field days">
      <label for="kd">${t('Lives for', 'Dure')}</label>
      <span class="days-row"><input id="kd" inputmode="numeric" value="90"><span>${t('days', 'jours')}</span></span>
      <p class="hint">${t('Ends on {day}. From 1 to 365 days: no key lives with no end.', 'Prend fin le {day}. De 1 à 365 jours : aucune clé ne vit sans fin.', { day: t('26 Jan 2027', '26 janv. 2027') })}</p>
    </div>
    <label class="check strong"><input type="checkbox" checked><span><b>${t('Only the notes of known people', 'Seulement les notes de personnes connues')}</b><small>${t(
      'On a site that everyone reads, the agent does not see a note of a visitor: anybody can write one, and an agent can obey its text. Untick it only knowing that.',
      'Sur un site que tout le monde lit, l’agent ne voit pas la note d’un visiteur : n’importe qui peut en écrire une, et un agent peut obéir à son texte. Décochez-la en le sachant.',
    )}</small></span></label>
    <div class="actions"><button type="button" class="b-accent">${t('Make the key', 'Créer la clé')}</button><button type="button" class="b-ghost">${t('Cancel', 'Annuler')}</button></div>
  </section>`;
}

function shownOnce({ copied = false } = {}) {
  const line = `claude mcp add --transport http fruitback ${WORKER}/mcp \\\n  --header "Authorization: Bearer ${KEY}"`;
  return `<section class="card once" aria-labelledby="once-title">
    <h2 id="once-title">${icon.ok}${t('« {name} » is made', '« {name} » est créée', { name: 'Claude on CI' })}</h2>
    <p class="strong-p">${t('Copy the key now: Fruitback shows it only once, and keeps only its digest.', 'Copiez la clé maintenant : Fruitback ne la montre qu’une fois, et n’en garde que l’empreinte.')}</p>
    <div class="secret-row"><code class="secret">${KEY}</code><button type="button" class="b-wide">${copied ? `${icon.ok}${t('Copied', 'Copiée')}` : t('Copy the key', 'Copier la clé')}</button></div>
    <h3>${t('Connect Claude Code', 'Connecter Claude Code')}</h3>
    <p class="hint">${t('Run this line where Claude Code runs. It holds the key: paste it nowhere else.', 'Lancez cette ligne là où tourne Claude Code. Elle contient la clé : ne la collez nulle part ailleurs.')}</p>
    <pre class="snippet" tabindex="0">${esc(line)}</pre>
    <div class="actions"><button type="button" class="b-wide">${t('Copy the line', 'Copier la ligne')}</button><a href="#">${t('Another agent, in CI or in the cloud', 'Un autre agent, en CI ou dans le cloud')}</a></div>
    <div class="actions end"><button type="button" class="b-accent">${t('I kept it', 'Je l’ai gardée')}</button></div>
  </section>`;
}

const confirmDialog =
  () => `<div class="scrim"><div class="dialog" role="alertdialog" aria-labelledby="dt" aria-describedby="dd">
  <h2 id="dt">${t('Revoke « {name} »?', 'Révoquer « {name} » ?', { name: 'Claude on CI' })}</h2>
  <p id="dd">${t(
    'An agent that uses this key is refused from its next request, and the key never works again. What it wrote stays in the threads of the notes.',
    'Un agent qui utilise cette clé est refusé dès sa prochaine requête, et la clé ne marche plus jamais. Ce qu’elle a écrit reste dans les fils des notes.',
  )}</p>
  <div class="actions end"><button type="button" class="b-ghost">${t('Cancel', 'Annuler')}</button><button type="button" class="b-danger">${t('Revoke the key', 'Révoquer la clé')}</button></div>
</div></div>`;

const empty = () => `<div class="empty-card">
  <h2>${t('No agent key yet', 'Aucune clé d’agent')}</h2>
  <p>${t(
    'Make one for each agent: Claude Code on a laptop, a job of your CI, a cloud agent. Revoking one stops that agent alone.',
    'Créez-en une par agent : Claude Code sur un portable, un job de votre CI, un agent dans le cloud. En révoquer une n’arrête que cet agent.',
  )}</p>
  <button type="button" class="b-accent pill">${t('New key', 'Nouvelle clé')}</button>
</div>`;

const settingsSection = (manager) => `<div class="app w1440">
  ${rail(1440)}
  <div class="main-wrap"><main>
    <header class="pg-head"><div><h1>${t('Workspace settings', 'Réglages du workspace')}</h1><p class="lead">${t('Settings that every member of {name} sees.', 'Les réglages que voit chaque membre de {name}.', { name: 'Acme' })}</p></div></header>
    <section class="set-sec"><h2>${t('Name', 'Nom')}</h2><p class="muted">…</p></section>
    <section class="set-sec"><h2>${t('Logo', 'Logo')}</h2><p class="muted">…</p></section>
    <section class="set-sec"><h2>${t('Agents', 'Agents')}</h2>
      <p>${t('Keys that let an AI agent of your team read the notes of some sites, and reply to them.', 'Les clés qui permettent à un agent IA de votre équipe de lire les notes de certains sites, et d’y répondre.')}</p>
      ${
        manager
          ? `<p><a class="b-wide link" href="#">${t('Manage the agent keys', 'Gérer les clés d’agent')}</a> <span class="muted">${t('{count} keys', '{count} clés', { count: 3 })}</span></p>`
          : `<p class="muted">${t('Only an owner or an admin of the workspace manages its agent keys.', 'Seul un propriétaire ou un admin du workspace gère ses clés d’agent.')}</p>`
      }
    </section>
  </main></div>
</div>`;

// --- the frames -------------------------------------------------------------------------------------
const frames = [];
const frame = (id, width, title, notes, build) => frames.push({ id, width, title, notes, build });

frame('a', 1440, 'A · The list: a key in use, one that ends in 5 days, one that ended', [
  'The page is /w/:workspace/settings/agents, reached from the section « Agents » of the workspace settings (frame I). It is no entry of the rail: the rail holds the five sections of the mockup, and the keys are a matter of the owner and the admins.',
  'Each row: the name and the day it was made; its sites; what it can do and whether it reads only the notes of known people; its last use (ago() of the console, « Never used »); its end. Oldest first, as the worker answers.',
  '7 days or less before its end, the row says « Ends in N days » in the strong accent with a triangle, and one line above the list says what to do. An ended key stays listed (the worker keeps it) with the chip « Ended », until somebody revokes it.',
  'The foot says how many of the 20 keys of a workspace are made.',
]);
frame('b', 1440, 'B · « New key »: the form', [
  'The form opens above the list, in place of nothing: the list does not move under the pointer. « New key » takes focus to « Name ».',
  'Sites: a box per site of the workspace, with who reads its notes, so the switch below reads in context. Past 20 ticked, the others are disabled.',
  'Rights: two choices, read by default. Lives for: a number, 90 by default, and the day it ends, computed as it is typed.',
  '« Only the notes of known people » is ticked by default (decision 7 of agents.md). It is asked for every key: the sites of a key can change who reads them later.',
]);
frame('c', 1440, 'C · The form refused: no name, no site', [
  'A press with no name or no site sends nothing: each field says what it needs, and focus goes to the first one (the kit: Field with error, aria-invalid). Nothing typed is cleared.',
  'A refusal of the worker (400 unknown-site: a site went meanwhile; 409 too-many-keys; 409 workspace-suspended) is said under the form, with what typed kept.',
]);
frame('d', 1440, 'D · The key, shown once, with the line for Claude Code', [
  'The answer of POST is the one place the key is. It is shown in a card above the list, which already holds the new row, until « I kept it ». It is kept in no storage: leaving the page loses it, and the card says why it matters.',
  'The line to copy is the one of docs/agents.md, with the address of this worker and the key in it: one copy and Claude Code is connected. « Copy the key » and « Copy the line » say « Copied »; a browser that refuses the copy gets the sentence of the REST connector: select it by hand.',
  'The link leads to docs/agents.md, « Connect an agent that runs elsewhere ».',
]);
frame('e', 1440, 'E · The writes of a key', [
  '« Writes » unfolds what the key wrote under its row (aria-expanded), read when it opens: GET …/agent-keys/<id>/writes, newest first. Each write: what (a reply, or the status set), the site, the id of the note (what get_feedback takes), when.',
  'The console has no page for one note: the id is no link. At 100 writes (the bound of the worker) the foot says that only the last 100 are listed.',
  'A key that wrote nothing says so (frame E2, 390 px).',
]);
frame('f', 1440, 'F · Revoke, asked once more', [
  'The confirmation of the kit (confirm.tsx). Once revoked, the row goes, focus goes to « New key », and a status line says « « Claude on CI » is revoked. ».',
]);
frame('g', 1440, 'G · No key yet', [
  'The empty state of the kit. With no site in the workspace, « New key » is replaced by « Add a site first », a link to Sites.',
  'At 20 keys, « New key » is disabled and the foot says « A workspace holds 20 keys at most. Revoke one to make another. ».',
]);
frame('i', 1440, 'I · The section « Agents » of the workspace settings (owner, admin)', [
  'A member or a guest reads the section with « Only an owner or an admin of the workspace manages its agent keys. », and no link. The page itself says the same sentence to them, and asks nothing of the worker (which answers 403).',
]);
frame('j', 390, 'J · 390 px, French: the list', [
  'Each row becomes a card: the name, then each value under its label. Nothing scrolls sideways.',
]);
frame('k', 390, 'K · 390 px, French: the key shown once', [
  'The line breaks where it can; its box scrolls sideways alone, with focus.',
]);
frame('l', 390, 'L · 390 px, French: the form', []);
frame('m', 390, 'E2 · 390 px, French: a key that wrote nothing', []);

const builders = {
  a: () => page(1440, { body: soonNotice() + list(KEYS()) }),
  b: () => page(1440, { body: form() + list(KEYS()), button: true, disabled: true }),
  c: () => page(1440, { body: form({ error: true }) + list(KEYS()), disabled: true }),
  d: () => page(1440, { body: shownOnce({ copied: true }) + list(KEYS()), disabled: true }),
  e: () => page(1440, { body: list(KEYS(), { 0: { open: true, writes: writesPanel() } }) }),
  f: () => page(1440, { body: list(KEYS()) }) + confirmDialog(),
  g: () => page(1440, { body: empty(), button: false }),
  i: () => settingsSection(true),
  j: () => page(390, { body: soonNotice() + list(KEYS()) }),
  k: () => page(390, { body: shownOnce() + list(KEYS().slice(0, 1)), disabled: true }),
  l: () => page(390, { body: form(), disabled: true }),
  m: () => page(390, { body: list(KEYS().slice(1, 2), { 0: { open: true, writes: noWrites() } }) }),
};

const rendered = frames.map((f) => {
  lang = f.width < 900 ? 'fr' : 'en';
  const inner = builders[f.id]();
  lang = 'en';
  return `<section class="frame" id="${f.id}">
  <h2 class="f-title">${esc(f.title)}</h2>
  ${f.notes.length ? `<ul class="notes">${f.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  <div class="f-box" style="width:${f.width}px;position:relative">${inner}</div>
</section>`;
});

const table = [...texts.entries()].map(([en, fr]) => `<tr><td>${esc(en)}</td><td>${esc(fr)}</td></tr>`).join('');

const css = `
:root{--ink:#18181b;--ink-soft:#52525b;--muted:#6b6b74;--page:#fff;--subtle:#fafafa;--chip:#f4f4f5;--line:#e4e4e7;--control:#8a8a93;--accent:#dd2c27;--accent-strong:#b91c1c;--done:#15803d;--rail:#18181b;--rail-active:#27272a;--rail-text:#d4d4d8;--rail-muted:#a1a1aa}
*{box-sizing:border-box}
body{margin:0;background:#e9e9ec;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
button{white-space:nowrap;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
button svg{width:16px;height:16px}
.board-head{padding:40px 48px 8px;max-width:1200px}
.board-head h1{font-size:28px;margin:0 0 8px}
.board-head p{font-size:15px;line-height:1.5;color:var(--ink-soft);margin:0 0 8px}
.toc{display:flex;flex-wrap:wrap;gap:6px 14px;padding:0 48px 24px;font-size:14px}
.frame{padding:24px 48px 40px}
.f-title{font-size:18px;margin:0 0 8px}
.notes{margin:0 0 14px;padding-left:20px;max-width:1100px;font-size:14px;line-height:1.5;color:var(--ink-soft)}
.f-box{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.06);border-radius:4px;overflow:hidden}
code,.snippet,.secret{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.focus{outline:2px solid var(--accent);outline-offset:2px}
.muted{color:var(--muted)}
.app{display:flex;min-height:900px;background:#fff}
.rail{flex:0 0 248px;background:var(--rail);color:#fff;padding:16px 12px;display:flex;flex-direction:column;gap:20px}
.rail .ws{display:flex;gap:10px;align-items:center;padding:8px;border-radius:10px;color:#fff;text-decoration:none}
.rail .ws[aria-current]{background:var(--rail-active)}
.ws-i{width:32px;height:32px;border-radius:8px;background:#fff;color:var(--ink);display:grid;place-items:center;font-weight:700;font-size:14px;flex:none}
.ws b{display:block;font-size:15px}.ws small{display:block;font-size:12px;color:var(--rail-muted)}
.rail nav{display:flex;flex-direction:column;gap:2px}
.rail nav a{display:flex;align-items:center;min-height:40px;padding:0 12px;border-radius:10px;color:var(--rail-text);font-size:15px;text-decoration:none;white-space:nowrap}
.w390{flex-direction:column;min-height:0}
.w390 .rail{flex:none;padding:10px 12px;gap:6px}
.w390 .rail nav{flex-direction:row;overflow:hidden}
.main-wrap{flex:1;min-width:0}
main{padding:32px clamp(16px,4vw,48px) 72px}
.w390 main{padding:20px 16px 48px}
.crumbs{display:flex;gap:8px;align-items:center;font-size:14px;color:var(--muted);margin-bottom:10px;flex-wrap:wrap}
.crumbs a{color:var(--ink);font-weight:600;text-underline-offset:3px}
.pg-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px 24px;margin-bottom:24px}
.pg-head h1{margin:0 0 6px;font-size:28px;line-height:1.15;letter-spacing:-.02em}
.lead{margin:0;font-size:16px;line-height:1.5;color:var(--muted);max-width:760px}
.lead a,.actions a{color:var(--ink);font-weight:600;text-underline-offset:3px}
.b-accent{height:44px;padding:0 22px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:14px;font-weight:600}
.b-accent.pill{border-radius:999px}
.b-accent[aria-disabled]{opacity:.45;cursor:default}
.b-danger{height:44px;padding:0 18px;border:0;border-radius:6px;background:var(--accent-strong);color:#fff;font-size:14px;font-weight:600}
.b-wide{height:44px;padding:0 16px;border:1px solid var(--control);border-radius:6px;background:#fff;color:var(--ink);font-size:14px;font-weight:600;text-decoration:none}
.b-wide.sm,.b-ghost.sm{height:36px;padding:0 12px}
.b-wide.pressed{background:var(--chip)}
.b-wide.link{display:inline-flex;align-items:center}
.b-ghost{height:44px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--ink);font-size:14px;font-weight:600}
.b-ghost.danger{color:var(--accent-strong)}
.callout{display:flex;gap:10px;align-items:flex-start;padding:14px 18px;border:1px solid var(--line);border-radius:10px;background:var(--subtle);margin:0 0 20px;max-width:900px;font-size:15px;line-height:1.5}
.callout p{margin:0}
.callout svg{flex:none;width:20px;height:20px;margin-top:2px;color:var(--accent-strong)}
.k-head,.k-row{display:grid;grid-template-columns:minmax(180px,1.2fr) minmax(150px,1fr) minmax(200px,1.3fr) 130px 160px 190px;gap:12px;align-items:center}
.k-head{padding:0 20px 8px;font-size:13px;font-weight:600;color:var(--muted)}
.k-list{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:14px;overflow:hidden}
.k-row{padding:14px 20px;border-bottom:1px solid var(--line);font-size:14px;line-height:1.45}
.k-row:last-child{border-bottom:0}
.k-row small{display:block;font-size:13px;color:var(--muted)}
.k-row b{font-size:15px}
.host{display:block}
.c-actions{display:flex;justify-content:flex-end;gap:6px}
.lbl-m{display:none}
.soon{display:inline-flex;gap:6px;align-items:center;color:var(--accent-strong);font-weight:600}
.soon svg{width:16px;height:16px}
.chip{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--chip);color:var(--ink-soft);font-size:13px;font-weight:600}
.foot{font-size:13px;color:var(--muted);margin:10px 0 0}
.writes{grid-column:1/-1;margin:8px 0 2px;padding:16px 18px;border-radius:10px;background:var(--subtle);border:1px solid var(--line)}
.writes h3{margin:0 0 10px;font-size:15px}
.writes ol{list-style:none;margin:0;padding:0}
.writes li{display:grid;grid-template-columns:minmax(220px,1.4fr) minmax(140px,1fr) 120px 110px;gap:12px;padding:8px 0;border-top:1px solid var(--line);font-size:14px}
.writes li:first-child{border-top:0}
.w-when{color:var(--muted);text-align:right}
.writes .hint,.hint{font-size:13px;color:var(--muted);margin:10px 0 0;line-height:1.5}
.writes .empty{margin:0;font-size:14px;color:var(--muted)}
.card{border:1px solid var(--line);border-radius:14px;padding:24px 28px;margin:0 0 24px;max-width:760px}
.card h2{margin:0 0 16px;font-size:18px;display:flex;align-items:center;gap:8px}
.card h2 svg{width:20px;height:20px;color:var(--done)}
.card h3{margin:22px 0 4px;font-size:15px}
.field{border:0;padding:0;margin:0 0 18px}
.field label,.field legend{display:block;font-size:14px;font-weight:600;margin-bottom:6px;padding:0}
.field input:not([type]),.field input[inputmode]{height:44px;width:100%;max-width:420px;border:1px solid var(--control);border-radius:8px;padding:0 12px;font:inherit;font-size:15px}
.field.bad input:not([type]){border-color:var(--accent-strong)}
.err{margin:6px 0 0;font-size:13px;color:var(--accent-strong);font-weight:600}
.checks{display:flex;flex-direction:column;gap:2px}
.check,.radio{display:flex;gap:10px;align-items:flex-start;min-height:44px;padding:8px 0;font-size:15px;cursor:pointer}
.check input,.radio input{width:18px;height:18px;margin:2px 0 0;accent-color:var(--ink);flex:none}
.check .host{display:inline;font-weight:600;margin-right:8px}
.check small{color:var(--muted);font-size:13px}
.radio span,.check.strong span{display:block}
.radio small,.check.strong small{display:block;font-size:13px;color:var(--muted);line-height:1.5}
.check.strong{padding:14px 16px;border:1px solid var(--line);border-radius:10px;margin:0 0 18px;max-width:640px}
.days-row{display:flex;gap:10px;align-items:center}
.days-row input{max-width:96px!important}
.actions{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;margin-top:14px}
.actions.end{justify-content:flex-end}
.strong-p{font-size:15px;font-weight:600;margin:0 0 10px}
.secret-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.secret{flex:1 1 320px;padding:12px 14px;border-radius:6px;background:var(--chip);word-break:break-all;line-height:1.4}
.snippet{margin:8px 0 0;padding:14px 16px;border-radius:8px;background:var(--rail);color:#f4f4f5;overflow-x:auto;white-space:pre;line-height:1.5}
.scrim{position:absolute;inset:0;background:rgba(24,24,27,.45);display:grid;place-items:center}
.dialog{background:#fff;border-radius:14px;padding:24px 28px;max-width:480px;box-shadow:0 20px 50px rgba(0,0,0,.25)}
.dialog h2{margin:0 0 10px;font-size:18px}
.dialog p{margin:0 0 6px;font-size:15px;line-height:1.5;color:var(--ink-soft)}
.empty-card{border:1px dashed var(--control);border-radius:14px;padding:40px 32px;max-width:760px;background:var(--subtle)}
.empty-card h2{margin:0 0 6px;font-size:18px}.empty-card p{margin:0 0 18px;font-size:15px;line-height:1.5;color:var(--muted)}
.set-sec{max-width:640px;padding-top:24px}
.set-sec h2{font-size:18px;margin:0 0 10px}.set-sec p{font-size:15px;line-height:1.5;margin:0 0 10px}
.w390 .k-head{display:none}
.w390 .k-row{grid-template-columns:1fr;gap:6px;padding:16px}
.w390 .lbl-m{display:inline-block;width:110px;flex:none;font-size:13px;color:var(--muted)}
.w390 .c-sites,.w390 .c-rights,.w390 .c-last,.w390 .c-ends{display:flex}
.w390 .c-actions{justify-content:flex-start;margin-top:6px}
.w390 .c-actions .sm{height:44px}
.w390 .writes li{grid-template-columns:1fr;gap:2px}
.w390 .w-when{text-align:left}
.w390 .card{padding:18px 16px}
.w390 .pg-head .b-accent{width:100%;justify-content:center}
table.texts{border-collapse:collapse;font-size:14px;line-height:1.45;background:#fff;max-width:1200px}
table.texts td,table.texts th{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
.qa{max-width:1100px;font-size:15px;line-height:1.55}
.qa li{margin-bottom:10px}
`;

const toc = frames.map((f) => `<a href="#${f.id}">${esc(f.title)}</a>`).join('');

const out = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fruitback, the agents of a workspace (FRU-462)</title>
<style>${css}</style>
</head>
<body>
<header class="board-head">
  <h1>The agents of a workspace (FRU-462)</h1>
  <p>Board of the console screen where the owner and the admins of a workspace make an agent key (shown once, with the line for Claude Code), list the keys with their last use and their end, see what each key wrote, and revoke one. The routes are those of FRU-461, FRU-464 and the last use of FRU-462 (<code>/console/workspaces/&lt;id&gt;/agent-keys</code>). Drawn on the tokens of the console (design/README.md). Frames at 1440 px are in English, frames at 390 px in French; every sentence of both is in the table at the end.</p>
  <p>Generated by <code>tools/build.mjs</code>: edit the script, not this file. A frame is a picture: its buttons do nothing. The key on the board is made up.</p>
</header>
<nav class="toc" aria-label="Frames">${toc}<a href="#decisions">Decisions</a><a href="#texts">Texts, EN and FR</a></nav>
${rendered.join('\n')}
<section class="frame" id="decisions"><h2 class="f-title">Decisions of the board (fru-agents, 2026-10-28)</h2>
<p class="notes">The orchestrator asked the agent to decide the choices of the screen itself and to write them down. Each one can be changed by Mathieu.</p>
<ol class="qa">
<li><b>Where the screen lives.</b> A page of its own, <code>/w/:workspace/settings/agents</code>, with the crumbs « Workspace settings › Agents », reached from a section « Agents » of the settings. Not a section of the rail: the rail holds the five of the mockup, and only the owner and the admins may make a key (decision 5 of agents.md). A section inside the settings page would put a list, a form and a log under the logo.</li>
<li><b>The key is shown once, in a card above the list,</b> until « I kept it ». It is held in the state of the screen only, never in a storage of the browser. The card says it is the only time, as the REST connector says it of its secret.</li>
<li><b>The line for Claude Code holds the key and the address of this worker</b>, as docs/agents.md writes it: one copy connects. A second button copies the key alone, for a runner's secrets. The link goes to the part of the guide for an agent that runs elsewhere.</li>
<li><b>No edit of a key.</b> The worker has no route for it, and a key that changes what it reaches under a running agent is a surprise. To change its sites or its rights: make another, give it to the agent, revoke the first.</li>
<li><b>The end.</b> A number of days (90 by default, 1 to 365) and the day it gives, written as it is typed. No « never »: decision 8.</li>
<li><b>The warning 7 days before</b> is said in words in the row (« Ends in 5 days », the strong accent and a triangle: the colour is never alone) and in one line above the list, which says what to do. No new token: the console has no amber.</li>
<li><b>An ended key stays listed</b>, with « Ended » and its day, since the worker keeps it; « Revoke » removes it.</li>
<li><b>« Only the notes of known people » is asked for every key</b>, ticked, even when none of its sites is read by everyone today: who reads a site can change after the key is made.</li>
<li><b>The writes unfold under their row</b>, read when they open. This is a list of rows, not the grid of cards where FRU-433 refused a panel between two rows. The note is named by its id, with no link: the console has no page of one note, and the id is what <code>get_feedback</code> takes.</li>
<li><b>The last use</b> is the one the worker keeps to the minute (PR of the worker of FRU-462), shown with <code>ago()</code> of the console, and « Never used » for a key no agent used.</li>
<li><b>Who made a key is not shown.</b> The worker answers an account id; the name would need the members, a second read, for a column the owner and the admins rarely need. Left for later.</li>
<li><b>A member or a guest</b> reads the section of the settings with a sentence and no link; the page says the same sentence and asks nothing of the worker.</li>
</ol></section>
<section class="frame" id="texts"><h2 class="f-title">Texts, EN and FR</h2>
<p class="notes">Every sentence of the board. The English is the key of <code>t()</code>, the French goes to <code>messages.fr.ts</code>. A name the team typed is shown as typed.</p>
<table class="texts"><thead><tr><th>English</th><th>Français</th></tr></thead><tbody>${table}</tbody></table>
</section>
</body>
</html>
`;

writeFileSync(join(here, '..', 'agents.html'), out);
console.log(`agents.html: ${frames.length} frames, ${texts.size} texts`);
