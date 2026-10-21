// Builds design/site-statuses/site-statuses.html, the board of FRU-371 (the statuses of a site).
//
// Run from anywhere: `node design/site-statuses/tools/build.mjs`. It needs no package: the contrast
// below is a copy of packages/shared/src/contrast.ts (FRU-365), so every ratio on the board is the one
// the worker and the console will compute. Every word goes through `t(en, fr)`, which also fills the
// table of the texts at the end of the board.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// --- contrast.ts, copied (WCAG 2.2) -----------------------------------------------------------------
const INK = '#18181b';
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [l, d] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l + 0.05) / (d + 0.05);
};
const readable = (bg) => {
  const onInk = ratio(bg, INK);
  const onWhite = ratio(bg, '#ffffff');
  if (Math.max(onInk, onWhite) >= 4.5) return onInk > onWhite ? INK : '#ffffff';
  return '#000000';
};

// --- words ------------------------------------------------------------------------------------------
const texts = new Map();
let lang = 'en';
const t = (en, fr, vars = {}) => {
  if (!texts.has(en)) texts.set(en, fr);
  let out = lang === 'fr' ? fr : en;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  return out;
};
const num = (x) => (lang === 'fr' ? x.toFixed(2).replace('.', ',') : x.toFixed(2)) + ':1';
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

// --- the stages (names of #486: new, todo, progress, done, closed) and their colours (FRU-334) ------
const STAGES = {
  new: { color: '#bec2c8', en: 'New', fr: 'Nouveau' },
  todo: { color: '#d9dbdf', en: 'To do', fr: 'À faire' },
  progress: { color: '#f3bb3d', en: 'In progress', fr: 'En cours' },
  done: { color: '#5560c4', en: 'Done', fr: 'Terminé' },
  closed: { color: '#a52a3a', en: 'Closed', fr: 'Fermé' },
};
const stageWord = (s) => t(STAGES[s].en, STAGES[s].fr);

// A status as the screen holds it: the row of the worker (FRU-366) and what the tracker says.
// `color`: null is the stage colour; `tracker`: the colour the tracker gives (Linear), used when the
// site's switch is on.
const bgOf = (s, useTracker = false) =>
  s.color ?? (useTracker && s.trackerColor ? s.trackerColor : STAGES[s.stage].color);
const textOf = (s, useTracker) => s.textColor ?? readable(bgOf(s, useTracker));

// --- pieces -----------------------------------------------------------------------------------------
const icon = {
  up: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  grip: '<svg aria-hidden="true" viewBox="0 0 24 24"><g fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g></svg>',
  ok: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5M12 18v.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  more: '<svg aria-hidden="true" viewBox="0 0 24 24"><g fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></g></svg>',
};

const pin = (bg, fg, n = 3) =>
  `<span class="pin" style="--bg:${bg};--fg:${fg}" aria-hidden="true"><span>${n}</span></span>`;
const chip = (name, bg, fg) => `<span class="chip" style="background:${bg};color:${fg}">${esc(name)}</span>`;
const dot = (stage) => `<span class="dot" style="background:${STAGES[stage].color}" aria-hidden="true"></span>`;
const nameOf = (s) => s.name ?? s.trackerName ?? stageWord(s.stage);

function contrastLine(bg, fg, auto) {
  const r = ratio(bg, fg);
  if (r >= 4.5) {
    return `<span class="ok">${icon.ok}${auto ? t('Auto', 'Auto') + ' · ' : ''}${num(r)}</span>`;
  }
  return `<span class="bad">${icon.warn}${num(r)}</span>`;
}

function sourceLine(s, kind) {
  if (kind === 'own') return s.builtIn ? t('Built in', 'Intégré') : t('Added by your team', 'Ajouté par votre équipe');
  if (kind === 'linear') return t('In Linear: {name}', 'Dans Linear : {name}', { name: esc(s.trackerName) });
  return t('In GitHub: {name}', 'Dans GitHub : {name}', { name: esc(s.trackerName) });
}

function colourCell(s, kind, useTracker) {
  if (s.color) return `<span class="sw" style="background:${s.color}"></span><code>${s.color}</code>`;
  if (useTracker && s.trackerColor)
    return `<span class="sw" style="background:${s.trackerColor}"></span>${t("Linear's colour", 'Couleur de Linear')}`;
  return `<span class="sw" style="background:${STAGES[s.stage].color}"></span>${t('Colour of the stage', 'Couleur de l’étape')}`;
}

// One row of the list. `opts.open`: what is open under the row (an editor, a confirmation).
// « Delete » for a status the team added, « Reset » for any other one that differs, else nothing.
function secondAction(s, kind, name) {
  const label = `<span class="sr"> ${esc(name)}</span>`;
  if (kind === 'own' && !s.builtIn)
    return `<button type="button" class="b-ghost sm danger">${t('Delete', 'Supprimer')}${label}</button>`;
  if (s.name || s.color || s.textColor || s.restaged)
    return `<button type="button" class="b-ghost sm">${t('Reset', 'Rétablir')}${label}</button>`;
  return '';
}

function row(s, i, total, kind, opts = {}) {
  const useTracker = opts.useTracker;
  const bg = bgOf(s, useTracker);
  const fg = textOf(s, useTracker);
  const name = nameOf(s);
  const focusUp = opts.focus === 'up' ? ' focus' : '';
  const focusDown = opts.focus === 'down' ? ' focus' : '';
  const actions = [
    `<button type="button" class="b-wide sm${opts.open ? ' pressed' : ''}" aria-expanded="${opts.open ? 'true' : 'false'}">${t('Edit', 'Modifier')}<span class="sr"> ${esc(name)}</span></button>`,
    secondAction(s, kind, name),
  ].join('');
  return `
  <li class="st-row${opts.moved ? ' moved' : ''}${opts.open ? ' is-open' : ''}">
    <div class="c-order">
      <span class="grip" title="${t('Drag to move', 'Glisser pour déplacer')}">${icon.grip}</span>
      <button type="button" class="b-icon${focusUp}" ${i === 0 ? 'aria-disabled="true"' : ''} aria-label="${t('Move {name} up', 'Monter {name}', { name: esc(name) })}">${icon.up}</button>
      <button type="button" class="b-icon${focusDown}" ${i === total - 1 ? 'aria-disabled="true"' : ''} aria-label="${t('Move {name} down', 'Descendre {name}', { name: esc(name) })}">${icon.down}</button>
    </div>
    <div class="c-status">
      ${pin(bg, fg)}
      <span class="c-name">
        <span class="name">${chip(name, bg, fg)}</span>
        <span class="from">${sourceLine(s, kind)}</span>
      </span>
    </div>
    <div class="c-stage"><span class="lbl-m">${t('Stage', 'Phase')}</span>${dot(s.stage)}${stageWord(s.stage)}</div>
    <div class="c-colour"><span class="lbl-m">${t('Colour', 'Couleur')}</span>${colourCell(s, kind, useTracker)}</div>
    <div class="c-text"><span class="lbl-m">${t('Text', 'Texte')}</span>${contrastLine(bg, fg, !s.textColor)}</div>
    <div class="c-actions">${actions}</div>
    ${opts.open ?? ''}
  </li>`;
}

function listHead() {
  return `<div class="st-head" aria-hidden="true">
    <span>${t('Order', 'Ordre')}</span><span>${t('Status', 'Statut')}</span><span>${t('Stage', 'Phase')}</span><span>${t('Colour', 'Couleur')}</span><span>${t('Text', 'Texte')}</span><span></span>
  </div>`;
}

function list(statuses, kind, opts = {}) {
  const rows = statuses
    .map((s, i) => row(s, i, statuses.length, kind, { useTracker: opts.useTracker, ...(opts.rows?.[i] ?? {}) }))
    .join('');
  return `${listHead()}<ol class="st-list" aria-label="${t('Statuses of {site}', 'Statuts de {site}', { site: opts.site })}">${rows}</ol>`;
}

// What an empty name gives, said under the field.
function hintOf(s, kind) {
  if (kind === 'linear')
    return t('Empty: the name in Linear, « {name} ».', 'Vide : le nom dans Linear, « {name} ».', {
      name: esc(s.trackerName),
    });
  if (kind === 'github')
    return t('Empty: the name in GitHub, « {name} ».', 'Vide : le nom dans GitHub, « {name} ».', {
      name: esc(s.trackerName),
    });
  if (s.builtIn)
    return t('Empty: « {name} », in the language of each person.', 'Vide : « {name} », dans la langue de chacun.', {
      name: stageWord(s.stage),
    });
  return '';
}

// The editor, under its row. `v`: what the fields hold.
function editor(s, kind, v) {
  const name = nameOf(s);
  const bg = v.bg;
  const fg = v.text ?? readable(bg);
  const r = ratio(bg, fg);
  const bad = r < 4.5;
  const stageSelect = Object.keys(STAGES)
    .map((k) => `<option${k === v.stage ? ' selected' : ''}>${stageWord(k)}</option>`)
    .join('');
  const builtInStage = kind === 'own' && s.builtIn;
  const trackerHint = hintOf(s, kind);
  const radio = (label, checked, extra = '') =>
    `<label class="radio"><input type="radio" ${checked ? 'checked' : ''}><span>${label}</span>${extra}</label>`;
  const hexField = (id, value, invalid) =>
    `<span class="hex"><input type="color" value="${value}" aria-label="${t('Pick a colour', 'Choisir une couleur')}"><input id="${id}" type="text" value="${value}" spellcheck="false" aria-label="${t('Hex code', 'Code hexadécimal')}" ${invalid ? 'aria-invalid="true" aria-describedby="' + id + '-msg"' : ''}></span>`;
  const title = v.adding
    ? t('Add a status', 'Ajouter un statut')
    : t('Edit {name}', 'Modifier {name}', { name: esc(name) });
  return `
  <section class="editor" aria-label="${title}">
    <h3>${title}</h3>
    <div class="ed-grid">
      <div class="ed-fields">
        <label class="field">${t('Name', 'Nom')}
          <input type="text" value="${esc(v.name ?? '')}" placeholder="${esc(v.placeholder ?? '')}" ${v.nameMissing ? 'aria-invalid="true"' : ''}>
          ${trackerHint ? `<span class="hint">${trackerHint}</span>` : ''}
          ${v.nameMissing ? `<span class="err">${icon.warn}${t('Give the status a name.', 'Donnez un nom au statut.')}</span>` : ''}
        </label>
        <label class="field">${t('Stage', 'Phase')}
          <select ${builtInStage ? 'disabled' : ''}>${stageSelect}</select>
          <span class="hint">${
            builtInStage
              ? t(
                  'A built-in status keeps its stage: the notes with no status of their own are in it.',
                  'Un statut intégré garde sa phase : les notes sans statut à elles y sont.',
                )
              : t(
                  'The stage decides the filters, the counts, and when a note looks fixed.',
                  'La phase décide des filtres, des comptes, et du moment où une note semble réglée.',
                )
          }</span>
        </label>
        <fieldset class="field">
          <legend>${t('Colour', 'Couleur')}</legend>
          ${radio(t('Colour of the stage', 'Couleur de l’étape'), v.bgMode === 'stage', `<span class="sw" style="background:${STAGES[v.stage].color}"></span>`)}
          ${kind === 'linear' ? radio(t("Linear's colour", 'Couleur de Linear'), v.bgMode === 'tracker', `<span class="sw" style="background:${s.trackerColor}"></span>`) : ''}
          ${radio(t('Your colour', 'Votre couleur'), v.bgMode === 'own')}
          ${v.bgMode === 'own' ? hexField('bg-' + (s.key ?? 'new'), bg, false) : ''}
        </fieldset>
        <fieldset class="field">
          <legend>${t('Text', 'Texte')}</legend>
          ${radio(t('Auto: dark or white, whichever reads better', 'Auto : foncé ou blanc, selon ce qui se lit le mieux'), v.text === undefined)}
          ${radio(t('Your colour', 'Votre couleur'), v.text !== undefined)}
          ${v.text !== undefined ? hexField('fg-' + (s.key ?? 'new'), v.text, bad) : ''}
        </fieldset>
      </div>
      <div class="ed-preview">
        <span class="lbl">${t('Preview', 'Aperçu')}</span>
        <div class="pv-light">
          <span class="pv-cap">${t('On a light page', 'Sur une page claire')}</span>
          <div class="pv-row">${pin(bg, fg)}${chip(v.name || v.placeholder || '…', bg, fg)}</div>
          <div class="pv-item"><span class="pv-n">3</span><span class="pv-txt">${t('The button is too close to the edge', 'Le bouton est trop près du bord')}</span>${chip(v.name || v.placeholder || '…', bg, fg)}</div>
        </div>
        <div class="pv-dark">
          <span class="pv-cap">${t('On a dark page', 'Sur une page sombre')}</span>
          <div class="pv-row">${pin(bg, fg)}${chip(v.name || v.placeholder || '…', bg, fg)}</div>
        </div>
        <p class="${bad ? 'ratio bad' : 'ratio ok'}" ${bad ? `id="fg-${s.key ?? 'new'}-msg"` : ''} aria-live="polite">${bad ? icon.warn : icon.ok}<span>${
          bad
            ? t(
                'Text on this colour: {ratio}. Text needs 4.5:1 at least: choose Auto, or a darker or lighter text.',
                'Texte sur cette couleur : {ratio}. Il faut 4,5:1 au moins : choisissez Auto, ou un texte plus foncé ou plus clair.',
                { ratio: num(r) },
              )
            : t('Text on this colour: {ratio}. It reads well.', 'Texte sur cette couleur : {ratio}. Il se lit bien.', {
                ratio: num(r),
              })
        }</span></p>
      </div>
    </div>
    ${v.failed ? `<p class="alert" role="alert">${icon.warn}${t('This status did not change. Try again.', 'Ce statut n’a pas changé. Réessayez.')}</p>` : ''}
    <div class="ed-actions">
      <button type="button" class="b-accent">${v.adding ? t('Add the status', 'Ajouter le statut') : t('Save', 'Enregistrer')}</button>
      <button type="button" class="b-wide">${t('Cancel', 'Annuler')}</button>
    </div>
  </section>`;
}

function confirmEmpty(name) {
  return `
  <section class="confirm" role="group" aria-label="${t('Delete {name}', 'Supprimer {name}', { name: esc(name) })}">
    <p><strong>${t('Delete « {name} »?', 'Supprimer « {name} » ?', { name: esc(name) })}</strong> ${t(
      'No note is in it. You can add it again later.',
      'Aucune note n’y est. Vous pourrez l’ajouter de nouveau plus tard.',
    )}</p>
    <div class="ed-actions">
      <button type="button" class="b-wide focus">${t('Keep it', 'Le garder')}</button>
      <button type="button" class="b-danger">${t('Delete {name}', 'Supprimer {name}', { name: esc(name) })}</button>
    </div>
  </section>`;
}

let moveGroup = 0;
function confirmWithNotes(name, count, targets) {
  moveGroup += 1;
  const opts = targets
    .map(
      (s, i) =>
        `<label class="radio"><input type="radio" name="move-${moveGroup}" ${i === 0 ? 'checked' : ''}>${chip(nameOf(s), bgOf(s), textOf(s))}<span class="muted">${stageWord(s.stage)}${i === 0 ? ' · ' + t('same stage', 'même phase') : ''}</span></label>`,
    )
    .join('');
  return `
  <section class="confirm" role="group" aria-label="${t('Delete {name}', 'Supprimer {name}', { name: esc(name) })}">
    <p><strong>${t('{count} notes are in « {name} ».', '{count} notes sont dans « {name} ».', { count, name: esc(name) })}</strong> ${t(
      'Choose where they go, then it is deleted. They take the stage of their new status.',
      'Choisissez où elles vont, puis il est supprimé. Elles prennent la phase de leur nouveau statut.',
    )}</p>
    <fieldset class="field"><legend>${t('Move them to', 'Les déplacer vers')}</legend>${opts}</fieldset>
    <div class="ed-actions">
      <button type="button" class="b-wide focus">${t('Keep it', 'Le garder')}</button>
      <button type="button" class="b-danger">${t('Move {count} notes and delete', 'Déplacer {count} notes et supprimer', { count })}</button>
    </div>
  </section>`;
}

function linearSwitch(on) {
  return `
  <div class="switch-row">
    <button type="button" role="switch" aria-checked="${on}" class="switch${on ? ' on' : ''}" aria-describedby="sw-desc"><span></span></button>
    <div>
      <span class="sw-label">${t("Use Linear's colours", 'Utiliser les couleurs de Linear')}</span>
      <span id="sw-desc" class="hint">${t(
        'A status with no colour of yours takes its colour in Linear. Off: the colours of Fruitback.',
        'Un statut sans couleur choisie ici prend sa couleur dans Linear. Désactivé : les couleurs de Fruitback.',
      )}</span>
    </div>
  </div>`;
}

// --- the page around it -----------------------------------------------------------------------------
function rail(width) {
  const nav = [
    [t('Sites', 'Sites'), true],
    [t('Notes', 'Notes'), false],
    [t('Connectors', 'Connecteurs'), false],
    [t('Members', 'Membres'), false],
    [t('My account', 'Mon compte'), false],
  ]
    .map(([w, cur]) => `<a href="#"${cur ? ' aria-current="page"' : ''}>${w}</a>`)
    .join('');
  return `<aside class="rail${width < 900 ? ' rail-row' : ''}">
    <div class="ws"><span class="ws-i">A</span><span><b>Acme</b><small>${t('Cloud workspace', 'Workspace Cloud')}</small></span></div>
    <nav aria-label="${t('Workspace', 'Workspace')}">${nav}</nav>
  </aside>`;
}

function page(width, { site, lead, body, addButton, live }) {
  return `<div class="app w${width}">
    ${rail(width)}
    <div class="main-wrap"><main>
      <nav class="crumbs" aria-label="${t('Breadcrumb', 'Fil d’Ariane')}"><a href="#">${t('Sites', 'Sites')}</a><span aria-hidden="true">›</span><span class="host">${site}</span></nav>
      <header class="pg-head">
        <div>
          <h1>${t('Statuses', 'Statuts')}</h1>
          <p class="lead">${lead}</p>
        </div>
        ${addButton ? `<button type="button" class="b-accent pill">${t('Add a status', 'Ajouter un statut')}</button>` : ''}
      </header>
      ${body}
      <p class="sr-live" aria-live="polite">${live ?? ''}</p>
    </main></div>
  </div>`;
}

// --- the data of the frames -------------------------------------------------------------------------
const OWN = () => [
  { key: 'new', builtIn: true, stage: 'new' },
  { key: 'todo', builtIn: true, stage: 'todo' },
  { key: 'waiting', name: t('Waiting for client', 'En attente du client'), stage: 'todo', color: '#7dd3fc' },
  { key: 'progress', builtIn: true, stage: 'progress' },
  {
    key: 'legal',
    name: t(
      "Waiting for the client's legal team to approve the new wording",
      'En attente de la validation du nouveau texte par le service juridique du client',
    ),
    stage: 'progress',
    color: '#8b5cf6',
  },
  { key: 'done', builtIn: true, stage: 'done' },
  { key: 'closed', builtIn: true, stage: 'closed', name: t('Won’t fix', 'Ne sera pas corrigé') },
];
const LINEAR = () => [
  { key: 'b1', trackerName: 'Backlog', stage: 'new', trackerColor: '#bec2c8' },
  { key: 't1', trackerName: 'Todo', name: t('To do', 'À faire'), stage: 'todo', trackerColor: '#e2e2e2' },
  { key: 'p1', trackerName: 'In Progress', stage: 'progress', trackerColor: '#f2c94c' },
  { key: 'r1', trackerName: 'In Review', stage: 'progress', trackerColor: '#0f783c', restaged: true },
  { key: 'd1', trackerName: 'Done', stage: 'done', trackerColor: '#5e6ad2' },
  { key: 'c1', trackerName: 'Canceled', stage: 'closed', trackerColor: '#95a2b3' },
  { key: 'u1', trackerName: 'Duplicate', stage: 'closed', trackerColor: '#95a2b3' },
];
const GITHUB = () => [
  { key: 'open', trackerName: 'Open', stage: 'new' },
  {
    key: 'closed:completed',
    trackerName: 'Closed as completed',
    name: t('Fixed', 'Corrigé'),
    stage: 'done',
    color: '#15803d',
  },
  { key: 'closed:not_planned', trackerName: 'Closed as not planned', stage: 'closed' },
  { key: 'closed:duplicate', trackerName: 'Closed as duplicate', stage: 'closed' },
];

const leadOwn = () =>
  t(
    'The notes of this site stay in Fruitback. Each status belongs to a stage, which decides the filters and the counts.',
    'Les notes de ce site restent dans Fruitback. Chaque statut appartient à une phase, qui décide des filtres et des comptes.',
  );
const leadLinear = () =>
  t(
    'The states of the Linear team this site sends to, Acme web. Rename them, recolour them, or change their stage. A state added in Linear appears here.',
    'Les états de l’équipe Linear où ce site envoie ses notes, Acme web. Renommez-les, changez leur couleur ou leur phase. Un état ajouté dans Linear apparaît ici.',
  );
const leadGithub = () =>
  t(
    'A GitHub issue has four states, and Fruitback reads those, in acme/website. Rename them, recolour them, or change their stage.',
    'Une issue GitHub a quatre états, et Fruitback lit ceux-là, dans acme/website. Renommez-les, changez leur couleur ou leur phase.',
  );

// --- the frames -------------------------------------------------------------------------------------
const frames = [];
const frame = (id, width, title, notes, build) => frames.push({ id, width, title, notes, build });

const ownSite = 'preview.lumen.studio';
const ownFrame = (width, extra = {}) => {
  const s = OWN();
  // E: « Waiting for client » was moved down one place.
  if (extra.swap) [s[2], s[3]] = [s[3], s[2]];
  return page(width, {
    site: ownSite,
    kind: 'own',
    lead: leadOwn(),
    addButton: true,
    body: list(s, 'own', { site: ownSite, rows: extra.rows?.(s) }) + (extra.after ? extra.after(s) : ''),
    live: extra.live?.(s),
  });
};

frame(
  'a-list',
  1440,
  'A. List, notes kept in Fruitback (EN, 1440)',
  [
    'Reached from the menu of a site row in Sites: a new item « Statuses », for `manage-sites` only, between « Install » and « Preview builds ». Its own address: `/w/:workspace/sites/:site/statuses`.',
    'Five built-in statuses (one per stage, keys `new` … `closed` after #486), and the ones the team added. A built-in is renamed or recoloured, never deleted: « Reset » appears once it differs.',
    'Each row: the pin and the chip as the widget draws them (28 px drop, white ring, edge `#8a8a93`), the name, where it comes from, the stage (dot + word, never the colour alone), the colour, and the contrast of the text measured with `readableTextColor`.',
    'A long name wraps anywhere (FRU-350, `overflow-wrap: anywhere`); a button never breaks.',
    'Order: drag by the grip, or the two buttons. The grip is for a pointer only (`aria-hidden`).',
  ],
  () => ownFrame(1440),
);

frame(
  'b-edit-ok',
  1440,
  'B. Edit, with the preview and a contrast that passes (EN, 1440)',
  [
    'The editor opens under its row (the rule of the Sites screen: what a row opens is under it), takes focus on its heading, and Escape closes it with focus back on « Edit ».',
    'One status is written at a time: `POST …/statuses` with the whole row. No global « Save »: the API writes one status, and a list half-written is the failure FRU-123 removed.',
    'Preview on a light and on a dark page: the pin on a host page is a non-text mark, and its edge is what keeps it at 3:1 (statuses.md, « The colours »).',
    'The ratio is read live (`aria-live="polite"`), said in words and with an icon, never by colour alone.',
  ],
  () =>
    ownFrame(1440, {
      rows: (s) => ({
        2: { open: editor(s[2], 'own', { name: nameOf(s[2]), stage: 'todo', bgMode: 'own', bg: '#7dd3fc' }) },
      }),
    }),
);

frame(
  'c-edit-bad',
  1440,
  'C. Edit, text under 4.5:1 (EN, 1440)',
  [
    'The team chose white text on `#0ea5e9`: 2.77:1. The message says the ratio, the rule, and the two ways out. The field carries `aria-invalid` and `aria-describedby` to the message.',
    '« Save » stays enabled: a press sends nothing, and moves focus to the text field. The worker refuses it anyway (`400 invalid-status`, `text-under-contrast`): the console never relies on that alone.',
    'The ratio of the board is computed with a copy of `contrast.ts`, the function the worker and the console share.',
  ],
  () =>
    ownFrame(1440, {
      rows: (s) => ({
        2: {
          open: editor(s[2], 'own', {
            name: nameOf(s[2]),
            stage: 'todo',
            bgMode: 'own',
            bg: '#0ea5e9',
            text: '#ffffff',
          }),
        },
      }),
    }),
);

frame(
  'd-add',
  1440,
  'D. Add a status (EN, 1440)',
  [
    'Only where the notes stay in Fruitback (a site with no destination, or a REST destination): a Linear or GitHub state is added at the tracker.',
    'The form opens at the end of the list, focus in « Name ». The key is a slug of the name, made by the console (`[A-Za-z0-9_:-]{1,64}`), unique in the site; the stage is chosen, To do by default.',
    'Name empty: « Give the status a name. », on the field. 200 statuses per site at most (`409 too-many-statuses`): the button stays and says it when pressed.',
  ],
  () =>
    ownFrame(1440, {
      after: () =>
        editor({ key: 'new-status', stage: 'todo', name: '' }, 'own', {
          adding: true,
          name: '',
          placeholder: '',
          stage: 'todo',
          bgMode: 'stage',
          bg: STAGES.todo.color,
          nameMissing: true,
        }),
    }),
);

frame(
  'e-reorder',
  1440,
  'E. Move with the keyboard (EN, 1440)',
  [
    '« Move Waiting for client down » was pressed: the row moved, focus stays on the same button of the same row, and the live region says « Waiting for client is now 4 of 7. ».',
    'Each move writes the whole order (`POST …/statuses/order`). The buttons of the list are disabled while it is written (FRU-123), and a failure puts the row back and says « The order did not change. Try again. ».',
    'The first row has no « up », the last no « down »: `aria-disabled`, kept in the tab order so focus does not jump.',
    'Drag and drop: pointer only, same request on drop.',
  ],
  () =>
    ownFrame(1440, {
      swap: true,
      rows: () => ({ 3: { moved: true, focus: 'down' } }),
      live: (s) =>
        t('{name} is now {n} of {total}.', '{name} est maintenant en position {n} sur {total}.', {
          name: nameOf(s[3]),
          n: 4,
          total: 7,
        }),
    }).replace('class="sr-live"', 'class="sr-live shown"'),
);

frame(
  'f-delete-empty',
  1440,
  'F. Delete a status with no note (EN, 1440)',
  [
    'Only a status the team added has « Delete ». It asks twice (FRU-165, `confirm.tsx`): focus on « Keep it », and the second button names the status.',
    '`DELETE …/statuses/own/<key>` with no `moveTo`. The worker answers `200` when no note is in it.',
  ],
  () => ownFrame(1440, { rows: (s) => ({ 4: { open: confirmEmpty(nameOf(s[4])) } }) }),
);

frame(
  'g-delete-notes',
  1440,
  'G. Delete a status that holds notes (EN, 1440)',
  [
    'The count comes from the worker: today only from `409 status-in-use` with `notes` (the GET carries no count, see the open questions). With the count known, the confirmation asks where the notes go.',
    'The targets are the other statuses of the worker store; the first is the built-in of the same stage, chosen. The notes take the stage of their new status, which the sentence says.',
    '`DELETE …/statuses/own/waiting?moveTo=todo`. « Keep it » and Escape give the row back, focus on « Delete ».',
  ],
  () =>
    ownFrame(1440, {
      rows: (s) => ({
        2: {
          open: confirmWithNotes(nameOf(s[2]), 12, [s[1], s[0], s[3], s[4], s[5], s[6]]),
        },
      }),
    }),
);

const linearSite = 'staging.acme.dev';
frame(
  'h-linear',
  1440,
  'H. A site that sends to Linear, the switch on (EN, 1440)',
  [
    'The states of the team the site sends to, read from Linear (`GET /connectors/<id>/states`, with `color` added by FRU-368), merged with the rows of the site. No « Add a status », no « Delete »: « Reset » removes the row and gives back what Linear says.',
    "« Use Linear's colours », off by default (decision 3). On: every status with no colour of the team takes Linear's, and the text is computed again (Done `#5e6ad2` takes white, 4.70:1). A colour the team chose wins.",
    'The switch writes at once, like the switches of the console (no « Save »). It has no route yet: FRU-368.',
    'This screen takes over the table of FRU-102 on the page of the Linear connector, which then links here for each site.',
    'A site with two destinations (FRU-123) shows one section per destination, each with its own heading and switch.',
  ],
  () =>
    page(1440, {
      site: linearSite,
      kind: 'linear',
      lead: leadLinear(),
      body: linearSwitch(true) + list(LINEAR(), 'linear', { site: linearSite, useTracker: true }),
    }),
);

const ghSite = 'acme.dev';
frame(
  'i-github',
  1440,
  'I. A site that sends to GitHub (EN, 1440)',
  [
    'Four fixed statuses (FRU-369): `open`, `closed:completed`, `closed:not_planned`, `closed:duplicate`. Renamed, recoloured, moved to another stage, reordered; never added or deleted.',
    'No switch: GitHub gives an issue no colour (decision 4, no labels).',
  ],
  () =>
    page(1440, {
      site: ghSite,
      kind: 'github',
      lead: leadGithub(),
      body: list(GITHUB(), 'github', { site: ghSite }),
    }),
);

frame(
  'j-states',
  1440,
  'J. Loading, a read that failed, Linear that did not answer (EN, 1440)',
  [
    'First read: « Loading… » in place of the list. A read again keeps the rows (FRU-271).',
    'A failed read is the alert of the Sites screen, with « Try again », never an empty list.',
    'Linear did not answer: the rows the team set are still shown, and the sentence that FRU-102 already says.',
  ],
  () =>
    page(1440, {
      site: linearSite,
      kind: 'linear',
      lead: leadLinear(),
      body: `<p class="loading">${t('Loading…', 'Chargement…')}</p>
      <div class="alert-card" role="alert"><div><h2>${t('The statuses did not load', 'Les statuts n’ont pas été chargés')}</h2><p>${t(
        'Fruitback did not answer. Your statuses are safe.',
        'Fruitback n’a pas répondu. Vos statuts ne sont pas perdus.',
      )}</p></div><button type="button" class="b-wide">${t('Try again', 'Réessayer')}</button></div>
      <p class="alert" role="alert">${icon.warn}${t(
        'Fruitback could not read the states of Linear. The statuses you set are not lost.',
        'Fruitback n’a pas pu lire les états de Linear. Les statuts que vous avez réglés ne sont pas perdus.',
      )}</p>`,
    }),
);

// 390 px, in French.
frame(
  'k-390-list',
  390,
  'K. Liste à 390 px (FR)',
  [
    'Each row becomes a card: the order buttons on the left, the status, then stage, colour and text on labelled lines, then the actions. No sideways scroll.',
    'Targets 44 px high (`h-control`).',
  ],
  () => ownFrame(390),
);
frame(
  'l-390-edit',
  390,
  'L. Modifier à 390 px, contraste insuffisant (FR)',
  [
    'The editor is one column, the preview under the fields. The French ratio uses a comma: « 2,77:1 » (`Intl.NumberFormat`).',
  ],
  () =>
    ownFrame(390, {
      rows: (s) => ({
        2: {
          open: editor(s[2], 'own', {
            name: nameOf(s[2]),
            stage: 'todo',
            bgMode: 'own',
            bg: '#0ea5e9',
            text: '#ffffff',
          }),
        },
      }),
    }),
);
frame('m-390-delete', 390, 'M. Supprimer un statut qui a des notes, à 390 px (FR)', [], () =>
  ownFrame(390, {
    rows: (s) => ({ 2: { open: confirmWithNotes(nameOf(s[2]), 12, [s[1], s[0], s[3], s[4], s[5], s[6]]) } }),
  }),
);
frame('n-390-linear', 390, 'N. Linear à 390 px, l’interrupteur activé (FR)', [], () =>
  page(390, {
    site: linearSite,
    kind: 'linear',
    lead: leadLinear(),
    body: linearSwitch(true) + list(LINEAR(), 'linear', { site: linearSite, useTracker: true }),
  }),
);
frame('o-390-github', 390, 'O. GitHub à 390 px (FR)', [], () =>
  page(390, { site: ghSite, kind: 'github', lead: leadGithub(), body: list(GITHUB(), 'github', { site: ghSite }) }),
);

// --- the board --------------------------------------------------------------------------------------
const rendered = frames.map((f) => {
  lang = f.width === 390 ? 'fr' : 'en';
  const html = f.build();
  lang = 'en';
  const notes = f.notes.length
    ? `<ul class="notes">${f.notes.map((n) => `<li>${esc(n).replace(/`([^`]+)`/g, '<code>$1</code>')}</li>`).join('')}</ul>`
    : '';
  return `<section class="frame" id="${f.id}"><h2 class="f-title">${esc(f.title)}</h2>${notes}<div class="f-box" style="width:${f.width}px">${html}</div></section>`;
});
// Build every frame in French once more, so the table holds every sentence.
lang = 'fr';
for (const f of frames) f.build();
lang = 'en';

const table = [...texts.entries()].map(([en, fr]) => `<tr><td>${esc(en)}</td><td>${esc(fr)}</td></tr>`).join('');

const css = `
:root{--ink:#18181b;--ink-soft:#52525b;--muted:#6b6b74;--page:#fff;--subtle:#fafafa;--chip:#f4f4f5;--line:#e4e4e7;--control:#8a8a93;--accent:#dd2c27;--accent-strong:#b91c1c;--done:#15803d;--rail:#18181b;--rail-active:#27272a;--rail-text:#d4d4d8;--rail-muted:#a1a1aa}
*{box-sizing:border-box}
body{margin:0;background:#e9e9ec;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
button,[role=switch]{white-space:nowrap;font:inherit;cursor:pointer}
.board-head{padding:40px 48px 8px;max-width:1200px}
.board-head h1{font-size:28px;margin:0 0 8px}
.board-head p{font-size:15px;line-height:1.5;color:var(--ink-soft);margin:0 0 8px}
.toc{display:flex;flex-wrap:wrap;gap:6px 14px;padding:0 48px 24px;font-size:14px}
.frame{padding:24px 48px 40px}
.f-title{font-size:18px;margin:0 0 8px}
.notes{margin:0 0 14px;padding-left:20px;max-width:1100px;font-size:14px;line-height:1.5;color:var(--ink-soft)}
.f-box{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.06);border-radius:4px;overflow:hidden}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
:focus-visible,.focus{outline:2px solid var(--accent);outline-offset:2px}
/* frame of a workspace */
.app{display:flex;min-height:900px;background:#fff}
.rail{flex:0 0 248px;background:var(--rail);color:#fff;padding:16px 12px;display:flex;flex-direction:column;gap:20px}
.rail .ws{display:flex;gap:10px;align-items:center;padding:8px}
.ws-i{width:32px;height:32px;border-radius:8px;background:#fff;color:var(--ink);display:grid;place-items:center;font-weight:700;font-size:14px;flex:none}
.ws b{display:block;font-size:15px}.ws small{display:block;font-size:12px;color:var(--rail-muted)}
.rail nav{display:flex;flex-direction:column;gap:2px}
.rail nav a{display:flex;align-items:center;min-height:40px;padding:0 12px;border-radius:10px;color:var(--rail-text);font-size:15px;text-decoration:none;white-space:nowrap}
.rail nav a[aria-current]{background:var(--rail-active);color:#fff;font-weight:600}
.w390{flex-direction:column;min-height:0}
.w390 .rail{flex:none;padding:10px 12px;gap:6px}
.w390 .rail nav{flex-direction:row;overflow:hidden}
.main-wrap{flex:1;min-width:0}
main{max-width:1120px;padding:32px clamp(16px,4vw,48px) 72px}
.w390 main{padding:20px 16px 48px}
.crumbs{display:flex;gap:8px;align-items:center;font-size:14px;color:var(--muted);margin-bottom:10px;flex-wrap:wrap}
.crumbs a{color:var(--ink);font-weight:600;text-underline-offset:3px}
.pg-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px 24px;margin-bottom:24px}
.pg-head h1{margin:0 0 6px;font-size:28px;line-height:1.15;letter-spacing:-.02em}
.lead{margin:0;font-size:16px;line-height:1.5;color:var(--muted);max-width:720px}
/* buttons of the kit */
.b-accent{height:44px;padding:0 22px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:14px;font-weight:600}
.b-accent.pill{border-radius:999px}
.b-danger{height:44px;padding:0 18px;border:0;border-radius:6px;background:var(--accent-strong);color:#fff;font-size:14px;font-weight:600}
.b-wide{height:44px;padding:0 18px;border:1px solid var(--control);border-radius:6px;background:#fff;color:var(--ink);font-size:14px;font-weight:600}
.b-wide.sm,.b-ghost.sm{height:36px;padding:0 12px}
.b-wide.pressed{background:var(--chip)}
.b-ghost{height:36px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--ink);font-size:14px;font-weight:600}
.b-ghost.danger{color:var(--accent-strong)}
.b-icon{width:32px;height:32px;border:0;border-radius:6px;background:transparent;color:var(--ink-soft);display:inline-grid;place-items:center;padding:0}
.b-icon svg{width:18px;height:18px}
.b-icon[aria-disabled]{color:#c4c4cc;cursor:default}
/* the list */
.st-head,.st-row{display:grid;grid-template-columns:96px minmax(220px,1.6fr) 140px 190px 120px 170px;gap:12px;align-items:center}
.st-head{padding:0 20px 8px;font-size:13px;font-weight:600;color:var(--muted)}
.st-list{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:14px;overflow:hidden}
.st-row{padding:12px 20px;border-bottom:1px solid var(--line);font-size:14px;line-height:1.45}
.st-row:last-child{border-bottom:0}
.st-row.moved{background:var(--subtle);box-shadow:inset 3px 0 0 var(--ink)}
.st-row.is-open{background:var(--subtle)}
.c-order{display:flex;align-items:center;gap:2px}
.grip{width:18px;height:28px;color:var(--control);cursor:grab;display:grid;place-items:center}
.grip svg{width:16px;height:16px}
.c-status{display:flex;align-items:center;gap:14px;min-width:0}
.c-name{display:flex;flex-direction:column;gap:3px;min-width:0}
.from{font-size:13px;color:var(--muted)}
.chip{display:inline-block;padding:2px 9px;border-radius:12px;font-size:13px;font-weight:600;line-height:1.45;box-shadow:0 0 0 1px var(--control);max-width:100%}
.pin{flex:none;width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:var(--bg);color:var(--fg);border:2px solid #fff;box-shadow:0 0 0 1px var(--control),0 1px 2px rgba(0,0,0,.2);display:grid;place-items:center;font:700 12px/1 -apple-system,system-ui,sans-serif}
.pin span{transform:rotate(45deg)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:7px;box-shadow:0 0 0 1px var(--control);vertical-align:-1px}
.sw{display:inline-block;width:18px;height:18px;border-radius:5px;box-shadow:0 0 0 1px var(--control);margin-right:8px;vertical-align:-4px;flex:none}
.c-colour,.c-stage,.c-text{display:flex;align-items:center;min-width:0}
.ok,.bad{display:inline-flex;align-items:center;gap:5px;font-variant-numeric:tabular-nums}
.ok svg,.bad svg,.ratio svg,.err svg,.alert svg{width:16px;height:16px;flex:none}
.ok{color:var(--done)}
.bad{color:var(--accent-strong);font-weight:600}
.c-actions{display:flex;gap:6px;justify-content:flex-end}
.lbl-m{display:none}
/* editor and confirmations, under a row */
.editor,.confirm{grid-column:1/-1;margin-top:12px;padding:20px;border:1px solid var(--line);border-radius:14px;background:#fff}
.editor h3{margin:0 0 14px;font-size:17px}
.ed-grid{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:24px}
.ed-fields{display:flex;flex-direction:column;gap:16px}
.field{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;border:0;margin:0;padding:0;min-width:0}
.field legend{padding:0;margin-bottom:6px}
.field input[type=text],.field select{height:44px;border:1px solid var(--control);border-radius:8px;padding:0 14px;font:inherit;font-size:15px;font-weight:400;color:var(--ink);background:#fff;max-width:420px;width:100%}
.field select:disabled{background:var(--chip);color:var(--ink-soft)}
.field input[aria-invalid=true]{border-color:var(--accent-strong);box-shadow:0 0 0 1px var(--accent-strong)}
.hint{display:block;font-size:13px;font-weight:400;color:var(--muted);line-height:1.5}
.err{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--accent-strong)}
.radio{display:flex;align-items:center;gap:8px;min-height:36px;font-size:14px;font-weight:400}
.radio input{width:18px;height:18px;accent-color:var(--ink);margin:0}
.muted{color:var(--muted)}
.radio .muted{flex:none;white-space:nowrap}
.radio .chip{flex:0 1 auto;min-width:0}
.hex{display:flex;gap:8px;align-items:center;margin-left:26px}
.hex input[type=color]{width:44px;height:44px;border:1px solid var(--control);border-radius:8px;padding:3px;background:#fff}
.hex input[type=text]{width:130px;font-family:ui-monospace,Menlo,monospace}
.ed-preview{display:flex;flex-direction:column;gap:10px}
.lbl{font-size:13px;font-weight:600}
.pv-light,.pv-dark{border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}
.pv-light{background:var(--subtle);border:1px solid var(--line)}
.pv-dark{background:#27272a}
.pv-cap{font-size:12px;color:var(--muted)}
.pv-dark .pv-cap{color:#d4d4d8}
.pv-row{display:flex;align-items:center;gap:14px;padding-left:4px}
.pv-item{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:13px}
.pv-n{font-weight:700;font-variant-numeric:tabular-nums}
.pv-txt{flex:1;min-width:0}
.ratio{display:flex;gap:8px;align-items:flex-start;margin:0;font-size:14px;line-height:1.5;padding:10px 12px;border-radius:8px}
.ratio.ok{background:#f0fdf4;color:var(--done)}
.ratio.ok span{color:var(--ink)}
.ratio.bad{background:#fff;border:1px solid var(--accent-strong);color:var(--accent-strong);font-weight:400}
.ratio.bad span{color:var(--ink)}
.ratio svg{margin-top:3px}
.ed-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.alert{display:flex;gap:8px;align-items:center;margin:14px 0 0;font-size:14px;color:var(--accent-strong)}
.confirm p{margin:0 0 12px;font-size:15px;line-height:1.5}
.confirm .field{margin-top:4px}
.switch-row{display:flex;gap:14px;align-items:flex-start;padding:16px 20px;border:1px solid var(--line);border-radius:14px;margin-bottom:20px;max-width:760px}
.switch{flex:none;width:44px;height:26px;border-radius:999px;border:1px solid var(--control);background:#fff;position:relative;padding:0;margin-top:2px}
.switch span{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--control);transition:left .22s cubic-bezier(.16,1,.3,1)}
.switch.on{background:var(--ink);border-color:var(--ink)}
.switch.on span{left:20px;background:#fff}
.sw-label{display:block;font-size:15px;font-weight:600}
.sr-live{margin:12px 0 0;font-size:13px;color:var(--muted);min-height:1px}
.sr-live:not(.shown){position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.sr-live.shown{display:inline-block;padding:6px 10px;border:1px dashed var(--control);border-radius:6px}
.sr-live.shown::before{content:"aria-live: ";font-family:ui-monospace,Menlo,monospace}
.loading{font-size:15px;color:var(--muted)}
.alert-card{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;padding:28px 32px;border:1px solid var(--control);border-radius:14px;max-width:760px;margin:16px 0}
.alert-card h2{margin:0 0 4px;font-size:17px}.alert-card p{margin:0;font-size:15px;color:var(--muted)}
/* 390: the row becomes a card */
.w390 .st-head{display:none}
.w390 .pg-head h1{font-size:28px}
.w390 .st-row{grid-template-columns:40px minmax(0,1fr);grid-template-areas:"o s" "o g" "o c" "o t" "o a";gap:6px 10px;padding:14px 14px 14px 8px}
.w390 .c-order{grid-area:o;flex-direction:column;align-self:start;gap:0}
.w390 .grip{display:none}
.w390 .b-icon{width:40px;height:44px}
.w390 .c-status{grid-area:s;margin-bottom:4px}
.w390 .c-stage{grid-area:g}.w390 .c-colour{grid-area:c}.w390 .c-text{grid-area:t}
.w390 .c-actions{grid-area:a;justify-content:flex-start;margin-top:4px}
.w390 .c-actions .sm{height:44px}
.w390 .lbl-m{display:inline-block;width:70px;flex:none;font-size:13px;color:var(--muted)}
.w390 .editor,.w390 .confirm{grid-column:1/-1;grid-row:auto;margin-left:-0px;padding:16px}
.w390 .st-row.is-open{grid-template-areas:"o s" "o g" "o c" "o t" "o a" "e e"}
.w390 .ed-grid{grid-template-columns:1fr}
.w390 .hex{margin-left:0}
.w390 .switch-row{padding:14px}
.w390 .ed-actions button{flex:1 1 auto}
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
<title>Fruitback, the statuses of a site (FRU-371)</title>
<style>${css}</style>
</head>
<body>
<header class="board-head">
  <h1>The statuses of a site (FRU-371)</h1>
  <p>Board of the console screen that lists, adds, edits, orders and deletes the statuses of one site (FRU-352, docs/decisions/statuses.md). Drawn on the tokens of the console (design/README.md) and the five status colours of FRU-334, with the stage names of #486 (new, todo, progress, done, closed). Frames at 1440 px are in English, frames at 390 px in French; every sentence of both is in the table at the end.</p>
  <p>Generated by <code>tools/build.mjs</code>: edit the script, not this file. The ratios are computed with a copy of <code>packages/shared/src/contrast.ts</code>. A frame is a picture: its buttons do nothing.</p>
</header>
<nav class="toc" aria-label="Frames">${toc}<a href="#questions">Open questions</a><a href="#texts">Texts, EN and FR</a></nav>
${rendered.join('\n')}
<section class="frame" id="questions"><h2 class="f-title">Open questions, with the recommendation of the board</h2>
<ol class="qa">
<li><b>Where the screen lives.</b> Recommended: its own page, <code>/w/:workspace/sites/:site/statuses</code>, from a new item « Statuses » of the menu of a site row (owner and admin, <code>manage-sites</code>). A panel under the row would sit in a table of 860 px at the least, too narrow for an editor and its preview.</li>
<li><b>One write per status, or one « Save » for the page</b> (the sketch of statuses.md draws one). Recommended: one per status, as the API writes one (<code>POST …/statuses</code>); the order and the switch write at once. A page-wide « Save » would be several writes that can half fail.</li>
<li><b>How many notes a status holds.</b> <code>GET …/statuses</code> gives no count; only <code>409 status-in-use</code> does. Recommended for the first version: « Delete » sends no <code>moveTo</code>; a <code>200</code> was an empty status, a <code>409</code> opens the step « Move them to » with its count (frame G), so frame F and G are the two answers of one press. A count in the GET (a « Notes » column) is a later addition to the API.</li>
<li><b>The word for a stage.</b> The console never showed one: it called a stage « Status ». Recommended: « Stage » in English, « Phase » in French (« Étape » is already the step of the setup).</li>
<li><b>« Hidden »</b> (the column <code>hidden</code>): it only changes what the status select of a note offers (FRU-367). Recommended: not drawn on this screen until that select exists.</li>
<li><b>« Use Linear's colours » has no route yet</b> (FRU-368), and <code>GET /connectors/&lt;id&gt;/states</code> does not read <code>color</code>. Recommended: the Linear part of the screen ships after FRU-368; the own store and GitHub parts do not wait for it.</li>
<li><b>A text under 4.5:1.</b> Recommended: « Save » stays enabled, a press sends nothing and moves focus to the text field, which points to the message (frame C). A disabled button says nothing to a screen reader.</li>
<li><b>The table of FRU-102</b> on the page of the Linear connector. Recommended: removed in the same PR, replaced by a link to the statuses of each site that sends there: two places to set one stage is one too many.</li>
<li><b>The status select in the list of notes</b>, which statuses.md gives to FRU-371 too. Recommended: its own PR after FRU-367 (the route that changes the status of a note), not in this screen.</li>
<li><b>« Reset » asks nothing.</b> Recommended: no confirmation; what it removes is a name and a colour, typed again in seconds, and the notes do not move.</li>
<li><b>« Colour » or « Color ».</b> The console has no word of either yet; the ticket and statuses.md write « colour ». Recommended: « colour ».</li>
</ol></section>
<section class="frame" id="texts"><h2 class="f-title">Texts, EN and FR</h2>
<p class="notes">Every sentence of the board. The English is the key of <code>t()</code>, the French goes to <code>messages.fr.ts</code>. A name the team typed is shown as typed. « Stage » is « Phase » in French, not « Étape », which the setup already uses for its steps.</p>
<table class="texts"><thead><tr><th>English</th><th>Français</th></tr></thead><tbody>${table}</tbody></table>
</section>
</body>
</html>
`;

writeFileSync(join(here, '..', 'site-statuses.html'), out);
console.log(`site-statuses.html: ${frames.length} frames, ${texts.size} texts`);
