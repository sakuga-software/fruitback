// Builds design/destination-settings/destination-settings.html, the board of FRU-739 (the settings of
// a destination: the status of arrival, the template, the assignee, the capture by default and the
// technical details). The framing is « The settings of a destination » in docs/decisions/worker.md.
//
// Run from anywhere: `node design/destination-settings/tools/build.mjs`. It needs no package. Every
// word goes through `t(en, fr)`, which also fills the table of the texts at the end of the board.
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
const icon = {
  warn: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5M12 18v.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  ok: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gear: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  close: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
const mark = (kind) => {
  const fill = { linear: '#5e6ad2', github: '#0f172a', slack: '#4a154b', jira: '#2563eb' }[kind];
  return `<span class="mark" style="background:${fill}" aria-hidden="true">${kind[0].toUpperCase()}</span>`;
};

// --- the frame of the console -----------------------------------------------------------------------
function sidebar(width) {
  const nav = [
    [t('Notes', 'Notes'), false],
    [t('Sites', 'Sites'), true],
    [t('Connectors', 'Connecteurs'), false],
    [t('Members', 'Membres'), false],
    [t('Settings', 'Réglages'), false],
  ]
    .map(([w, cur]) => `<a href="#"${cur ? ' aria-current="page"' : ''}>${w}</a>`)
    .join('');
  return `<aside class="side${width < 900 ? ' side-row' : ''}">
    <a href="#" class="ws"><span class="ws-i">A</span><b>Acme</b></a>
    <nav aria-label="${t('Workspace', 'Workspace')}">${nav}</nav>
  </aside>`;
}

/** The page of a site (FRU-689), on its tab « Destinations ». */
function page(width, body, overlay = '') {
  const tabs = [
    t('Overview', 'Aperçu'),
    t('Install', 'Installer'),
    t('Destinations', 'Destinations'),
    t('Statuses', 'Statuts'),
    t('Access', 'Accès'),
    t('Advanced', 'Avancé'),
  ]
    .map((w, i) => `<a href="#"${i === 2 ? ' aria-current="page"' : ''}>${w}</a>`)
    .join('');
  return `<div class="app w${width}${overlay ? ' tall' : ''}">
    ${sidebar(width)}
    <div class="main-wrap"><main>
      <nav class="crumbs" aria-label="${t('Breadcrumb', 'Fil d’Ariane')}"><a href="#">${t('Sites', 'Sites')}</a><span aria-hidden="true">›</span><span>shop.acme.dev</span></nav>
      <header class="pg-head"><h1>shop.acme.dev</h1></header>
      <nav class="tabs" aria-label="${t('Site', 'Site')}">${tabs}</nav>
      ${body}
    </main></div>
    ${overlay}
  </div>`;
}

// --- the tab « Destinations » -------------------------------------------------------------------------
const PLACES = [
  { kind: 'linear', name: 'Acme · Web', detail: () => t('Linear team, whole team', 'Équipe Linear, toute l’équipe'), set: 4 },
  { kind: 'github', name: 'acme/shop', detail: () => t('GitHub repository', 'Dépôt GitHub'), set: 0 },
  { kind: 'slack', name: '#qa-shop', detail: () => t('Slack channel', 'Canal Slack'), set: 1 },
];

function placeRow(place, index, attention) {
  let set = t('Default settings', 'Réglages par défaut');
  if (place.set === 1) set = t('1 setting', '1 réglage');
  else if (place.set > 1) set = t('{n} settings', '{n} réglages', { n: place.set });
  const warn = attention && index === 0;
  return `<li class="d-row${warn ? ' warn' : ''}">
    ${mark(place.kind)}
    <span class="d-name"><b>${place.name}</b><small>${place.detail()}${index === 0 ? ` · ${t('Default', 'Par défaut')}` : ''}</small></span>
    <span class="d-set">${warn ? `<span class="attn">${icon.warn}${t('Action required', 'Action requise')}</span>` : `<small>${set}</small>`}</span>
    <button type="button" class="b-wide sm">${icon.gear}${t('Settings', 'Réglages')}</button>
  </li>`;
}

const destinations = (attention = false) => `<section class="sec">
  <h2>${t('Where the notes go', 'Où vont les notes')}</h2>
  <p class="sec-lead">${t('A note goes to the first place unless the person chooses another. Each place has its settings: what an issue looks like when it arrives.', 'Une note va au premier lieu, sauf si la personne en choisit un autre. Chaque lieu a ses réglages : ce à quoi ressemble un ticket quand il arrive.')}</p>
  <ul class="d-list">${PLACES.map((p, i) => placeRow(p, i, attention)).join('')}</ul>
  <div class="actions"><button type="button" class="b-wide">${t('Add a destination…', 'Ajouter une destination…')}</button></div>
</section>`;

// --- the panel « Settings » ---------------------------------------------------------------------------
const select = (id, value, hint = '') =>
  `<span class="select" id="${id}"><span>${value}</span><span aria-hidden="true">▾</span></span>${hint ? `<p class="hint">${hint}</p>` : ''}`;
const check = (label, on, detail = '') =>
  `<label class="check"><input type="checkbox"${on ? ' checked' : ''}><span>${label}${detail ? `<small>${detail}</small>` : ''}</span></label>`;
const sw = (label, on, detail) =>
  `<label class="switch-row"><span><b>${label}</b><small>${detail}</small></span><span class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on}"><span></span></span></label>`;

const TITLE = '[{{site}}] {{note.first_line}}';
const BODY = `{{note}}

Page · {{page.url}}
Component · {{component}}
Reported by {{reporter}}`;

function preview() {
  return `<div class="preview" aria-label="${t('Preview', 'Aperçu')}">
    <p class="pv-label">${t('Preview, with a note of example', 'Aperçu, avec une note d’exemple')}</p>
    <p class="pv-title">[shop.acme.dev] ${t('The price wraps under the button', 'Le prix passe sous le bouton')}</p>
    <p>${t('The price wraps under the button on a narrow window.', 'Le prix passe sous le bouton sur une fenêtre étroite.')}</p>
    <p>Page · https://shop.acme.dev/cart<br>Component · CartTotal<br>${t('Reported by Ana (verified)', 'Signalé par Ana (vérifiée)')}</p>
    <p class="pv-block">${t('Then the block of the note, always: Fruitback reads the note back from it.', 'Puis le bloc de la note, toujours : Fruitback y relit la note.')}</p>
  </div>`;
}

function panel({ kind = 'linear', refused = false, badVar = false } = {}) {
  const place = PLACES.find((p) => p.kind === kind);
  const shared = `<p class="callout small">${icon.warn}<span>${t('Shared by every site that sends to {place}. A site that wants other settings sends to another team or project.', 'Partagés par tous les sites qui envoient à {place}. Un site qui veut d’autres réglages envoie à une autre équipe ou un autre projet.', { place: place.name })}</span></p>`;
  const refusedBox = refused
    ? `<div class="alert">${icon.warn}<p><b>${t('Linear refused the status « Triage »', 'Linear a refusé le statut « Triage »')}</b><br>${t('It was removed from the team. The last 3 issues arrived in the default state. Choose another status, then save.', 'Il a été retiré de l’équipe. Les 3 derniers tickets sont arrivés dans l’état par défaut. Choisissez un autre statut, puis enregistrez.')}</p></div>`
    : '';
  let arrival = '';
  if (kind === 'linear')
    arrival = `<div class="field"><label for="st">${t('Status of arrival', 'Statut d’arrivée')}</label>${select('st', refused ? t('Choose a status', 'Choisir un statut') : `<span class="dot" style="background:#bec2c8"></span>Triage <small class="stage">→ ${t('New', 'Nouvelle')}</small>`, t('A status of another stage moves the note at once: a note that arrives in « Todo » is « To do », and leaves the new notes.', 'Un statut d’une autre étape déplace la note tout de suite : une note qui arrive dans « Todo » est « À faire », et quitte les nouvelles notes.'))}</div>`;
  if (kind === 'github')
    arrival = `<p class="hint none">${t('GitHub has no status to arrive in: an issue opens. The stage follows its state.', 'GitHub n’a pas de statut d’arrivée : un ticket s’ouvre. L’étape suit son état.')}</p>`;
  const people =
    kind === 'slack'
      ? ''
      : `<div class="two">
      <div class="field"><label for="as">${t('Assignee', 'Assigné')}</label>${select('as', kind === 'linear' ? 'Ana Lopez' : t('Nobody', 'Personne'))}</div>
      <div class="field"><label for="lb">${t('Labels', 'Labels')}</label>${select('lb', kind === 'linear' ? 'Bug, Web' : t('None', 'Aucun'), t('Fruitback’s own labels stay beside them.', 'Les labels de Fruitback restent à côté.'))}</div>
      ${kind === 'linear' ? `<div class="field"><label for="pr">${t('Priority', 'Priorité')}</label>${select('pr', t('Medium', 'Moyenne'))}</div>` : ''}
      <div class="field"><label for="ms">${t('Milestone', 'Jalon')}</label>${select('ms', t('None', 'Aucun'))}</div>
    </div>`;
  const capture =
    kind === 'github'
      ? `<p class="hint none">${t('GitHub takes no file: no capture is sent there.', 'GitHub ne prend aucun fichier : aucune capture n’y part.')}</p>`
      : `${sw(t('Join a capture by default', 'Joindre une capture par défaut'), true, t('The person can still remove it, or add a file.', 'La personne peut toujours la retirer, ou ajouter un fichier.'))}
      <fieldset class="field seg-f"><legend>${t('What it shows', 'Ce qu’elle montre')}</legend><span class="seg"><span class="on">${t('The element', 'L’élément')}</span><span>${t('The visible window', 'La fenêtre visible')}</span></span></fieldset>`;
  const details = `<fieldset class="field"><legend>${t('Technical details in the description', 'Détails techniques dans la description')}</legend>
      <div class="checks">
        ${check(t('Element', 'Élément'), true, t('The selector and the tag', 'Le sélecteur et la balise'))}
        ${check(t('Component', 'Composant'), true, t('The component and its file, when the build gives them', 'Le composant et son fichier, quand le build les donne'))}
        ${check(t('Viewport', 'Fenêtre'), false, t('The size of the window', 'La taille de la fenêtre'))}
        ${check(t('Browser', 'Navigateur'), false, t('Only when the site sends it (includeEnv)', 'Seulement quand le site l’envoie (includeEnv)'))}
        ${check(t('Reported by', 'Signalé par'), true)}
      </div>
      <p class="hint">${t('An unticked box removes its line from the text your team reads. The block of the note keeps every field.', 'Une case décochée retire sa ligne du texte que lit votre équipe. Le bloc de la note garde tous les champs.')}</p>
    </fieldset>`;
  const template = `<div class="field"><label for="tt">${t('Title', 'Titre')}</label><span class="input mono" id="tt">${esc(TITLE)}</span></div>
    <div class="field${badVar ? ' bad' : ''}"><label for="tb">${kind === 'slack' ? t('Message', 'Message') : t('Description', 'Description')}</label><span class="input area mono" id="tb">${esc(badVar ? BODY.replace('{{component}}', '{{author}}') : BODY)}</span>
    ${badVar ? `<p class="err">${t('« {{author}} » is not a variable. Use {{reporter}}.', '« {{author}} » n’est pas une variable. Utilisez {{reporter}}.')}</p>` : ''}
    <p class="hint">${t('Variables: {{note}}, {{note.first_line}}, {{page.url}}, {{page.path}}, {{page.title}}, {{element}}, {{component}}, {{file}}, {{reporter}}, {{viewport}}, {{browser}}, {{site}}, {{client}}. An empty variable writes nothing, and a line left empty goes. Empty fields: the issue of today.', 'Variables : {{note}}, {{note.first_line}}, {{page.url}}, {{page.path}}, {{page.title}}, {{element}}, {{component}}, {{file}}, {{reporter}}, {{viewport}}, {{browser}}, {{site}}, {{client}}. Une variable vide n’écrit rien, et une ligne restée vide disparaît. Champs vides : le ticket d’aujourd’hui.')}</p></div>
    ${preview()}`;
  return `<div class="scrim"></div><aside class="drawer" aria-label="${t('Settings of {place}', 'Réglages de {place}', { place: place.name })}">
    <header class="dr-head">${mark(kind)}<div><h2>${place.name}</h2><p class="muted">${place.detail()}</p></div><button type="button" class="b-ghost icon" aria-label="${t('Close', 'Fermer')}">${icon.close}</button></header>
    <div class="dr-body">
      ${refusedBox}${shared}
      <h3>${t('When an issue arrives', 'Quand un ticket arrive')}</h3>
      ${arrival}${people}
      <h3>${t('Capture', 'Capture')}</h3>${capture}
      <h3>${t('Title and description', 'Titre et description')}</h3>${template}
      <h3>${t('Details', 'Détails')}</h3>${details}
      <p class="hint">${t('A change applies to the notes that come after it. The issues already sent do not change.', 'Un changement vaut pour les notes qui viennent après. Les tickets déjà envoyés ne changent pas.')}</p>
    </div>
    <footer class="dr-foot"><button type="button" class="b-ghost">${t('Cancel', 'Annuler')}</button><button type="button" class="b-accent"${badVar ? ' aria-disabled="true"' : ''}>${t('Save', 'Enregistrer')}</button></footer>
  </aside>`;
}

// --- the frames -------------------------------------------------------------------------------------
const frames = [];
const frame = (id, width, title, notes, build) => frames.push({ id, width, title, notes, build });
frame(
  'a',
  1440,
  'A · The tab « Destinations »: each place has its settings',
  [
    'Each row of a place gets « Settings », for an owner or an admin (manage-workspace). A member and a guest do not see the tab, as today.',
    'The row says how many settings differ from the default, or « Default settings ».',
  ],
  () => page(1440, destinations()),
);
frame(
  'b',
  1440,
  'B · The settings of a Linear team',
  [
    'A drawer on the right, over the tab. It first says that the settings are shared by every site that sends to this place (question 1).',
    '« Status of arrival » lists the states of the team, read from Linear, each with the stage it maps to. Empty: the default state of Linear, as today.',
    'Assignee, labels, priority and milestone are read from the tracker: the list the console offers is the list the worker accepts.',
    'The capture: on or off, the element or the visible window. A default of the composer of the extension (question 2).',
    'The template: a title and a description with variables in double braces, no logic. The preview fills them with a note of example, and says that the block of the note follows, always.',
    'The details: one box per line of the description of today. An unticked box removes the line, never the block.',
  ],
  () => page(1440, destinations(), panel({ kind: 'linear' })),
);
frame(
  'c',
  1440,
  'C · A GitHub repository: only what GitHub takes',
  [
    'No status of arrival: a GitHub issue opens, and its stage follows its state. No capture: GitHub takes no file (store.ts). Each one says so in one line, instead of a control that does nothing.',
    'No priority: GitHub has none. Assignee, labels and milestone stay.',
  ],
  () => page(1440, destinations(), panel({ kind: 'github' })),
);
frame(
  'd',
  1440,
  'D · Slack: the message, the capture and the details',
  [
    'Slack has no status, no assignee and no label: the section « When an issue arrives » is empty and not drawn. The template writes the message.',
    'An address of your own has no panel at all: it receives the whole note, which is its contract.',
  ],
  () => page(1440, destinations(), panel({ kind: 'slack' })),
);
frame(
  'e',
  1440,
  'E · A variable that does not exist is refused',
  ['The field says which variable, and which one to use. « Save » is disabled until it is fixed.'],
  () => page(1440, destinations(), panel({ kind: 'linear', badVar: true })),
);
frame(
  'f',
  1440,
  'F · A setting that Linear refused',
  [
    'The status was removed from the team. The issues arrive in the default state, the log says which setting failed, and the row of the place says « Action required » (question 5).',
    'The panel says why and what to do. It stays until a save of the settings.',
  ],
  () => page(1440, destinations(true), panel({ kind: 'linear', refused: true })),
);
frame('g', 390, 'G · 390 px, French: the settings of a Linear team', ['The drawer takes the whole width.'], () =>
  page(390, destinations(), panel({ kind: 'linear' })),
);

const rendered = frames.map((f) => {
  lang = f.width < 900 ? 'fr' : 'en';
  const inner = f.build();
  lang = 'en';
  return `<section class="frame" id="${f.id}">
  <h2 class="f-title">${esc(f.title)}</h2>
  ${f.notes.length ? `<ul class="notes">${f.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  <div class="f-box" style="width:${f.width}px;position:relative">${inner}</div>
</section>`;
});
const table = [...texts.entries()].map(([en, fr]) => `<tr><td>${esc(en)}</td><td>${esc(fr)}</td></tr>`).join('');

// The tokens of the console (slate, FRU-683, design/README.md).
const css = `
:root{--ink:#0f172a;--ink-soft:#334155;--muted:#5b6779;--page:#fff;--surface:#fff;--sidebar:#f1f4f8;--subtle:#f7f9fb;--hover:#e8edf3;--selected:#e2e8f0;--chip:#e8edf3;--line:#e3e8ef;--control:#7b8797;--accent:#dd2c27;--accent-strong:#b91c1c;--done:#166534}
*{box-sizing:border-box}
body{margin:0;background:#e9ecf1;color:var(--ink);font-family:Inter,-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:13px;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
button{white-space:nowrap;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
button svg{width:14px;height:14px}
.board-head{padding:40px 48px 8px;max-width:1200px}
.board-head h1{font-size:28px;margin:0 0 8px}
.board-head p{font-size:15px;line-height:1.5;color:var(--ink-soft);margin:0 0 8px}
.toc{display:flex;flex-wrap:wrap;gap:6px 14px;padding:0 48px 24px;font-size:14px}
.frame{padding:24px 48px 40px}
.f-title{font-size:18px;margin:0 0 8px}
.notes{margin:0 0 14px;padding-left:20px;max-width:1100px;font-size:14px;line-height:1.5;color:var(--ink-soft)}
.f-box{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.06);border-radius:4px;overflow:hidden}
code,.mono{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.muted{color:var(--muted)}
.app{display:flex;min-height:640px;background:var(--page);position:relative}
.app.tall{min-height:1720px}
.w390.tall{min-height:2480px}
.side{flex:0 0 220px;background:var(--sidebar);padding:12px 10px;display:flex;flex-direction:column;gap:14px;border-right:1px solid var(--line)}
.side .ws{display:flex;gap:8px;align-items:center;padding:6px;color:var(--ink);text-decoration:none;font-size:13px}
.ws-i{width:24px;height:24px;border-radius:6px;background:var(--ink);color:#fff;display:grid;place-items:center;font-weight:700;font-size:12px}
.side nav{display:flex;flex-direction:column;gap:1px}
.side nav a{display:flex;align-items:center;height:28px;padding:0 10px;border-radius:6px;color:var(--ink-soft);text-decoration:none}
.side nav a[aria-current]{background:var(--selected);color:var(--ink);font-weight:600}
.w390{flex-direction:column}
.w390 .side{flex:none;flex-direction:row;align-items:center;border-right:0;border-bottom:1px solid var(--line);overflow:hidden}
.w390 .side nav{flex-direction:row}
.main-wrap{flex:1;min-width:0}
main{padding:20px 32px 64px}
.w390 main{padding:16px}
.crumbs{display:flex;gap:6px;align-items:center;color:var(--muted);margin-bottom:6px}
.crumbs a{color:var(--ink-soft);text-decoration:none}
.pg-head h1{margin:0 0 12px;font-size:20px;line-height:1.25}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:20px;overflow:hidden}
.tabs a{height:44px;display:flex;align-items:center;padding:0 12px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent}
.tabs a[aria-current]{color:var(--ink);font-weight:600;border-color:var(--ink)}
.sec{max-width:760px}
.sec h2{font-size:15px;margin:0 0 4px}
.sec-lead{margin:0 0 14px;line-height:1.5;color:var(--muted);font-size:14px}
.d-list{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:8px}
.d-row{display:grid;grid-template-columns:24px 1fr auto auto;gap:12px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line)}
.d-row:last-child{border-bottom:0}
.d-row.warn{background:#fdf3f2}
.d-name b{display:block}.d-name small,.d-set small{color:var(--muted);font-size:12px}
.w390 .d-row{grid-template-columns:24px 1fr;}
.w390 .d-set,.w390 .d-row button{grid-column:2}
.mark{width:24px;height:24px;border-radius:6px;color:#fff;display:grid;place-items:center;font-weight:700;font-size:12px}
.attn{display:inline-flex;gap:4px;align-items:center;color:var(--accent-strong);font-weight:600;font-size:12px}
.attn svg{width:14px;height:14px}
.actions{display:flex;gap:10px;margin-top:12px}
.b-accent{height:32px;padding:0 14px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-weight:600}
.b-accent[aria-disabled]{opacity:.45}
.b-wide{height:28px;padding:0 10px;border:1px solid var(--control);border-radius:6px;background:#fff;color:var(--ink);font-weight:600}
.b-ghost{height:32px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--ink);font-weight:600}
.b-ghost.icon{padding:0 8px;margin-left:auto}
.scrim{position:absolute;inset:0;background:rgba(15,23,42,.28)}
.drawer{position:absolute;top:0;right:0;bottom:0;width:520px;background:var(--surface);box-shadow:-12px 0 32px rgba(15,23,42,.18);display:flex;flex-direction:column}
.w390 .drawer{width:100%}
.dr-head{display:flex;gap:10px;align-items:flex-start;padding:16px 20px;border-bottom:1px solid var(--line)}
.dr-head h2{margin:0;font-size:15px}.dr-head p{margin:2px 0 0;font-size:12px}
.dr-body{flex:1;overflow:hidden;padding:4px 20px 16px}
.dr-body h3{font-size:13px;margin:18px 0 8px;text-transform:none;color:var(--ink)}
.dr-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--line)}
.field{border:0;padding:0;margin:0 0 12px}
.field label,.field legend{display:block;font-weight:600;margin-bottom:4px;padding:0}
.two{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
.w390 .two{grid-template-columns:1fr}
.select,.input{display:flex;justify-content:space-between;align-items:center;gap:8px;min-height:28px;border:1px solid var(--control);border-radius:6px;padding:0 8px;background:#fff}
.select>span:first-child{display:flex;gap:6px;align-items:center}
.input.area{display:block;white-space:pre-wrap;padding:6px 8px;line-height:1.5}
.field.bad .input{border-color:var(--accent-strong)}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.stage{color:var(--muted)}
.hint{font-size:12px;color:var(--muted);margin:4px 0 0;line-height:1.45}
.hint.none{margin:0 0 12px}
.err{margin:4px 0 0;font-size:12px;color:var(--accent-strong);font-weight:600}
.checks{display:flex;flex-direction:column}
.field label.check,.check{display:flex;gap:8px;align-items:flex-start;padding:4px 0;margin:0;font-weight:400}
.check input{width:14px;height:14px;margin:2px 0 0;accent-color:var(--ink)}
.check small{display:block;font-size:12px;color:var(--muted)}
.switch-row{display:flex;justify-content:space-between;gap:12px;margin-bottom:10px}
.switch-row small{display:block;font-size:12px;color:var(--muted)}
.switch{flex:none;width:32px;height:18px;border-radius:999px;border:1px solid var(--control);background:#fff;position:relative}
.switch span{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--control)}
.switch.on{background:var(--ink);border-color:var(--ink)}.switch.on span{left:16px;background:#fff}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:6px;background:var(--subtle);padding:2px}
.seg span{padding:4px 10px;border-radius:4px;color:var(--muted)}
.seg .on{background:#fff;color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(15,23,42,.12)}
.callout{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--subtle);margin:14px 0 0;line-height:1.45}
.callout svg{flex:none;width:14px;height:14px;margin-top:2px;color:var(--muted)}
.alert{display:flex;gap:8px;padding:10px 12px;border:1px solid #f1c2c0;border-radius:8px;background:#fdf3f2;margin:14px 0 0;line-height:1.45}
.alert p{margin:0}.alert svg{flex:none;width:14px;height:14px;margin-top:2px;color:var(--accent-strong)}
.preview{margin:8px 0 0;padding:10px 12px;border-radius:8px;background:var(--subtle);border:1px dashed var(--control);line-height:1.5}
.preview p{margin:0 0 6px}.pv-label{font-size:12px;color:var(--muted)}.pv-title{font-weight:700}
.pv-block{font-size:12px;color:var(--muted)}
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
<title>Fruitback, the settings of a destination (FRU-739)</title>
<style>${css}</style>
</head>
<body>
<header class="board-head">
  <h1>The settings of a destination (FRU-739)</h1>
  <p>Board of the panel « Settings » of a place, opened from the tab « Destinations » of a site (worker.md, « The settings of a destination »): the status of arrival, the assignee and the labels, the capture by default, the title and the description with variables, and the technical details. Each tool shows only what it takes. Frames at 1440 px are in English, at 390 px in French; every sentence of both is in the table at the end.</p>
  <p>Generated by <code>tools/build.mjs</code>: edit the script, not this file. A frame is a picture: its buttons do nothing.</p>
</header>
<nav class="toc" aria-label="Frames">${toc}<a href="#decisions">Decisions</a><a href="#texts">Texts, EN and FR</a></nav>
${rendered.join('\n')}
<section class="frame" id="decisions"><h2 class="f-title">Decisions of the board (fru-specs, 2026-11-28)</h2>
<p class="notes">The orchestrator decided where the settings live and what a template touches. The questions of the framing are in worker.md, each with its recommendation.</p>
<ol class="qa">
<li><b>Where.</b> A drawer opened from the row of a place, in the tab « Destinations » of a site, and from the panel of the connector. The settings are of the place, in <code>connectors.settings</code>, so the drawer says that every site that sends there shares them.</li>
<li><b>Who.</b> An owner or an admin (<code>manage-workspace</code>), as the settings of a Linear connector today.</li>
<li><b>Only what the tool takes.</b> A setting the tool cannot take is one line that says so (GitHub: no status, no file), or nothing (Slack: no assignee). The worker refuses it on save.</li>
<li><b>The block of the note never changes.</b> The preview says it under the template, and the details say it under their boxes.</li>
<li><b>A variable that does not exist is refused on save</b>, with its name and the one to use. No logic in a template.</li>
<li><b>A refused setting does not lose the note.</b> The issue arrives without it, and the place says « Action required » until a save.</li>
<li><b>One « Save » for the drawer.</b> Everything of the place is written in one request; a change applies to the notes that come after it.</li>
</ol></section>
<section class="frame" id="texts"><h2 class="f-title">Texts, EN and FR</h2>
<table class="texts"><thead><tr><th>English</th><th>Français</th></tr></thead><tbody>${table}</tbody></table>
</section>
</body>
</html>
`;
writeFileSync(join(here, '..', 'destination-settings.html'), out);
console.log(`destination-settings.html: ${frames.length} frames, ${texts.size} texts`);
