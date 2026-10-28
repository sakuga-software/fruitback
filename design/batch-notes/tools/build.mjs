// Builds design/batch-notes/batch-notes.html, the board of FRU-474 (several notes sent together: one
// issue for each under a parent, or one issue with every note).
//
// Run from anywhere: `node design/batch-notes/tools/build.mjs`. It needs no package. Every word goes
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

// --- the notes of the frames ------------------------------------------------------------------------
const DRAFTS = () => [
  { n: 1, text: t('The price of the Pro plan is wrong', 'Le prix de la formule Pro est faux'), page: '/pricing' },
  { n: 2, text: t('« Monthly » and « Yearly » overlap on a phone', '« Mensuel » et « Annuel » se chevauchent sur mobile'), page: '/pricing' },
  { n: 3, text: t('The FAQ link goes to a 404', 'Le lien de la FAQ mène à une 404'), page: '/pricing' },
];

// --- pieces -----------------------------------------------------------------------------------------
const drop = (n, cls = 'draft') => `<span class="drop ${cls}" aria-hidden="true"><b>${n}</b></span>`;

/** The page of the site, behind the widget: the cards of the playground, with the pins on them. */
function site(width, pins) {
  const cards = ['Espresso', 'Latte', 'Mocha']
    .map(
      (name, i) => `<div class="card"><h3>${name}</h3><p class="price">${[19, 24, 29][i]} €</p><span class="add">${t('Add', 'Ajouter')}</span>${
        pins[i] === undefined ? '' : `<span class="pin">${pins[i]}</span>`
      }</div>`,
    )
    .join('');
  return `<div class="site${width < 900 ? ' narrow' : ''}"><header class="site-head"><b>Acme</b><span>${t('Plans', 'Formules')}</span></header>
    <h2>${t('Our plans', 'Nos formules')}</h2><div class="cards">${cards}</div></div>`;
}

/** The list of every note of the page (FRU-129), as the widget draws it, with what goes inside. */
function sidebar(inner, { count = 3 } = {}) {
  return `<aside class="sidebar" aria-label="${t('Notes on this page', 'Notes de cette page')}">
    <div class="sb-head"><b>${t('Notes', 'Notes')}</b><span class="x" aria-hidden="true">×</span></div>
    <div class="sb-scope"><span class="tab on">${t('This page · {count}', 'Cette page · {count}', { count })}</span><span class="tab">${t('All pages', 'Toutes les pages')}</span></div>
    ${inner}
  </aside>`;
}

function draftRows() {
  return `<ol class="rows">${DRAFTS()
    .map((d) => `<li class="row">${drop(d.n)}<span><span class="r-note">${d.text}</span><small>${d.page} · ${t('Not sent yet', 'Pas encore envoyée')}</small></span></li>`)
    .join('')}</ol>`;
}

/** The group of the notes kept for later (FRU-124), with the choice of this ticket when it has one. */
function group({ choice = 'parent', chooser = true, state = 'idle', title = '', tracker = 'Linear' } = {}) {
  const options = [
    {
      id: 'parent',
      title: t('One issue for each note, under one parent', 'Une issue par note, sous un parent'),
      hint: t(
        'Each note keeps its own status and its own pin colour. The parent only groups them.',
        'Chaque note garde son statut et la couleur de son pin. Le parent ne fait que les regrouper.',
      ),
    },
    {
      id: 'one',
      title: t('One issue with every note', 'Une seule issue avec toutes les notes'),
      hint: t(
        'The team handles them together: one status for the three pins.',
        'L’équipe les traite ensemble : un seul statut pour les trois pins.',
      ),
    },
  ];
  const fieldset = chooser
    ? `<fieldset class="choice"><legend>${t('In {tracker}', 'Dans {tracker}', { tracker })}</legend>
      ${options
        .map(
          (o) => `<label class="opt${o.id === choice ? ' on' : ''}"><span class="radio${o.id === choice ? ' on' : ''}" aria-hidden="true"></span><span><b>${o.title}</b><small>${o.hint}</small></span></label>`,
        )
        .join('')}
      <label class="title-field"><span>${choice === 'one' ? t('Title of the issue', 'Titre de l’issue') : t('Title of the parent', 'Titre du parent')}</span>
        <input value="${esc(title)}" placeholder="${esc(t('3 notes on /pricing', '3 notes sur /pricing'))}"></label>
    </fieldset>`
    : '';
  const button =
    state === 'sending'
      ? `<button class="send" aria-disabled="true">${t('Sending…', 'Envoi…')}</button>`
      : `<button class="send">${t('Send the {count} notes', 'Envoyer les {count} notes', { count: 3 })}</button>`;
  const status =
    state === 'sending'
      ? `<p class="status">${t('Sending…', 'Envoi…')}</p>`
      : '';
  return `<section class="group"><h3>${t('Kept for later, not sent yet', 'Gardées pour plus tard, pas encore envoyées')}</h3>
    ${draftRows()}${fieldset}<div class="g-foot">${button}</div>${status}</section>`;
}

function sentRows(mode) {
  const ids = mode === 'one' ? ['ENG-143', 'ENG-143', 'ENG-143'] : ['ENG-143', 'ENG-144', 'ENG-145'];
  return `<ol class="rows">${DRAFTS()
    .map(
      (d, i) => `<li class="row">${drop(d.n, 'new')}<span><span class="r-note">${d.text}</span><small>${t('New', 'Nouveau')} · ${ids[i]} · ${t('just now', 'à l’instant')}</small></span></li>`,
    )
    .join('')}</ol>`;
}

/** A thread of a pin (FRU-256), as the widget draws it. */
function thread({ n, text, identifier, extra = '', stage = t('New', 'Nouveau') }) {
  return `<div class="thread" role="dialog" aria-label="${t('Note {n}', 'Note {n}', { n })}">
    <div class="th-head"><span class="th-stage"><span class="mini" aria-hidden="true"></span>${stage}</span><span class="th-link">${identifier} →</span><span class="x" aria-hidden="true">×</span></div>
    <div class="th-body"><p class="th-note">${text}</p>${extra}<p class="th-meta">Camille Durand · ${t('just now', 'à l’instant')}</p></div>
  </div>`;
}

// --- frames -----------------------------------------------------------------------------------------
const frames = [];
const frame = (id, width, title, notes, build) => frames.push({ id, width, title, notes, build });

frame('a', 1440, 'A · Today: three notes kept for later, one button', [
  'What FRU-124 shipped, drawn here because no board drew it: « Keep for later » in the composer, a neutral pin for each draft, and the group « Kept for later, not sent yet » at the top of the list of the page, with one button.',
  'On a Linear site the worker writes a parent issue and one sub-issue for each note (`createBatch`). The person is never told: this ticket makes that choice visible, and adds the second one.',
], () => `<div class="stage">${site(1440, [drop(1), drop(2), drop(3)])}${sidebar(group({ chooser: false }))}</div>`);

frame('b', 1440, 'B · The choice, on a site that sends to Linear: one issue for each, under one parent (the default)', [
  'Shown only when two notes or more are kept, and only for a place that can group them (decision 3). One note alone keeps the plain button of frame A.',
  'Two choices, never a third: the one of today first and ticked, so a person who sends without reading does what FRU-124 does.',
  'The title is optional: empty, the worker writes « 3 notes on /pricing » (the page, or « 3 notes on 2 pages »). It is the title of the parent here.',
  'The choice is remembered for the tab, next to the drafts: it is a way of working, not a property of one note.',
], () => `<div class="stage">${site(1440, [drop(1), drop(2), drop(3)])}${sidebar(group({ choice: 'parent' }))}</div>`);

frame('c', 1440, 'C · The second choice: one issue with every note, with a title the person typed', [
  'One issue whose description holds the three notes in order, each with its element, its page and its picture, then one JSON block per note: the round trip of contract.md holds note by note.',
  'The label of the field follows the choice: « Title of the issue ».',
], () =>
  `<div class="stage">${site(1440, [drop(1), drop(2), drop(3)])}${sidebar(group({ choice: 'one', title: t('Pricing page, before Friday', 'Page des prix, avant vendredi') }))}</div>`,
);

frame('d', 1440, 'D · Sending, then sent: the group goes, the three pins take their colour', [
  'While it sends, the choice and the button are read-only, and the drafts stay (« nothing lost », FRU-124).',
  'Sent: the group leaves the list; the live region says « 3 notes sent, in ENG-142 » with the parent (or the issue) for a member who sees the tracker; a guest reads « 3 notes sent ».',
], () =>
  `<div class="stage two">${sidebar(group({ choice: 'parent', state: 'sending' }))}${sidebar(
    `<p class="live">${t('3 notes sent, in ENG-142', '3 notes envoyées, dans ENG-142')}</p>${sentRows('parent')}`,
  )}</div>`,
);

frame('e', 1440, 'E · After « One issue with every note »: three pins, one issue, one status', [
  'Each note keeps its pin on its element. The thread says which issue holds it and its place in it: « Note 2 of 3 in ENG-143 ».',
  'The stage is the one of the issue: the three pins move together. A verdict « Still wrong » (FRU-294) on one of them reopens the issue, so the three: the thread says it under the buttons.',
  'Reply from a thread: written under the one issue, quoted with the number of the note, so the team knows which.',
], () =>
  `<div class="stage">${site(1440, [drop(1, 'new'), drop(2, 'new'), drop(3, 'new')])}<div class="float">${thread({
    n: 2,
    text: DRAFTS()[1].text,
    identifier: 'ENG-143',
    extra: `<p class="in-issue">${t('Note {n} of {count} in {identifier}', 'Note {n} sur {count} dans {identifier}', { n: 2, count: 3, identifier: 'ENG-143' })}</p>`,
  })}</div></div>`,
);

frame('f', 1440, 'F · A place that cannot group: the button alone, and why', [
  'Notes kept in Fruitback, sent to an address (REST), or to GitHub: one note for each, no parent. The group shows no choice, and one line says why, so the person does not look for it.',
  'GitHub has sub-issues now; the connector does not write them (FRU-359). When it does, this frame becomes frame B with « In GitHub ».',
], () =>
  `<div class="stage">${site(1440, [drop(1), drop(2), drop(3)])}${sidebar(
    group({ chooser: false }).replace(
      '<div class="g-foot">',
      `<p class="why">${t('Each note arrives on its own: this place does not group notes.', 'Chaque note arrive seule : cette destination ne regroupe pas les notes.')}</p><div class="g-foot">`,
    ),
  )}</div>`,
);

frame('g', 1440, 'G · A send that half worked (207), and the one issue that cannot', [
  'Under a parent: the notes that went leave; the others stay in the group, under the same parent next time (FRU-195), and the line says both: « 2 notes sent, in ENG-142. 1 stays: Linear did not answer. »',
  'One issue with every note is one write: all the notes, or none. Nothing is half sent, and the line of a failure is the one of the composer.',
], () =>
  `<div class="stage two">${sidebar(
    `<p class="live warn">${t('2 notes sent, in ENG-142. 1 stays: Linear did not answer. Try again.', '2 notes envoyées, dans ENG-142. 1 reste : Linear n’a pas répondu. Réessayez.')}</p>
    <section class="group"><h3>${t('Kept for later, not sent yet', 'Gardées pour plus tard, pas encore envoyées')}</h3><ol class="rows"><li class="row">${drop(3)}<span><span class="r-note">${DRAFTS()[2].text}</span><small>/pricing · ${t('Not sent yet', 'Pas encore envoyée')}</small></span></li></ol><div class="g-foot"><button class="send">${t('Send 1 note', 'Envoyer 1 note')}</button></div></section>`,
    { count: 3 },
  )}${sidebar(
    `<p class="live warn">${t('Not sent: Linear did not answer. Your notes are kept, try again.', 'Pas envoyées : Linear n’a pas répondu. Vos notes sont gardées, réessayez.')}</p>${group({ choice: 'one' })}`,
  )}</div>`,
);

frame('h', 390, 'H · 390 px, French: the choice', [
  'On a phone the list is a sheet at the bottom (sidebar.ts). The two choices stack, each a target of 44 px or more.',
], () => `<div class="stage narrow">${sidebar(group({ choice: 'parent' }))}</div>`);

frame('i', 390, 'I · 390 px, French: a thread of a note in one issue', [], () =>
  `<div class="stage narrow"><div class="float">${thread({
    n: 2,
    text: DRAFTS()[1].text,
    identifier: 'ENG-143',
    extra: `<p class="in-issue">${t('Note {n} of {count} in {identifier}', 'Note {n} sur {count} dans {identifier}', { n: 2, count: 3, identifier: 'ENG-143' })}</p>`,
  })}</div></div>`,
);

const rendered = frames.map((f) => {
  lang = f.width < 900 ? 'fr' : 'en';
  const inner = f.build();
  lang = 'en';
  return `<section class="frame" id="${f.id}">
  <h2 class="f-title">${esc(f.title)}</h2>
  ${f.notes.length ? `<ul class="notes">${f.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  <div class="f-box" style="width:${f.width}px">${inner}</div>
</section>`;
});

const table = [...texts.entries()].map(([en, fr]) => `<tr><td>${esc(en)}</td><td>${esc(fr)}</td></tr>`).join('');

// The tokens of the widget (packages/widget/src/theme.ts), light scheme.
const css = `
:root{--text:#18181b;--muted:#6b6b74;--subtle:#52525b;--surface:#fff;--raised:#fafafa;--sunken:#f4f4f5;--border:#e4e4e7;--border-strong:#8a8a93;--accent:#dd2c27;--accent-strong:#b91c1c;--success:#15803d;--warning:#b45309;--stage-new:#bec2c8;--edge:#8a8a93}
*{box-sizing:border-box}
body{margin:0;background:#ececee;color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.board-head{padding:32px 40px 8px;max-width:1200px}.board-head h1{margin:0 0 8px;font-size:28px}.board-head p{margin:0 0 8px;color:var(--subtle)}
.toc{display:flex;flex-wrap:wrap;gap:8px 14px;padding:8px 40px 24px}.toc a{color:var(--text);font-size:14px}
.frame{padding:24px 40px 40px}.f-title{margin:0 0 8px;font-size:20px}
.notes{margin:0 0 16px;padding-left:20px;max-width:1100px;color:var(--subtle);font-size:14px}
.f-box{background:#fafaf9;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.stage{position:relative;min-height:760px;display:flex}
.stage.two{justify-content:flex-end;gap:24px;padding:0 24px;background:#f4f4f5}
.stage.two .sidebar{position:relative;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.stage.narrow{min-height:780px;flex-direction:column;justify-content:flex-end}
.site{flex:1;padding:24px 56px}.site.narrow{padding:16px}
.site-head{display:flex;justify-content:space-between;align-items:center;padding:8px 0 16px;border-bottom:1px solid var(--border);font-size:15px}.site-head b{font-size:26px}
.site h2{font-size:22px;margin:28px 0 16px}
.cards{display:flex;gap:20px}
.card{position:relative;flex:1;max-width:280px;background:#fff;border-radius:14px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.card h3{margin:0 0 6px;font-size:17px}.price{margin:0 0 12px;font-size:26px;font-weight:700}
.add{display:inline-block;padding:8px 16px;border-radius:999px;background:var(--accent);color:#fff;font-weight:600;font-size:14px}
.pin{position:absolute;right:16px;top:14px}
.drop{display:inline-grid;place-items:center;flex:none;width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:1.5px solid var(--edge);font-size:12px}
.drop b{transform:rotate(45deg)}
.drop.draft{background:#fff;border-style:dashed;color:var(--muted)}
.drop.new{background:var(--stage-new);color:var(--text)}
.sidebar{position:relative;margin-left:auto;width:392px;background:var(--surface);border-left:1px solid var(--border);box-shadow:-10px 0 30px rgba(0,0,0,.06);font-size:14px;line-height:1.45;align-self:stretch}
.narrow .sidebar{width:390px;margin:0;border-left:0;border-top:1px solid var(--border);border-radius:14px 14px 0 0;align-self:auto}
.sb-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--border)}.sb-head b{font-size:16px}
.x{width:32px;height:32px;display:grid;place-items:center;color:var(--muted)}
.sb-scope{display:flex;gap:6px;padding:10px 16px}.tab{padding:5px 10px;border-radius:999px;font-size:13px;color:var(--subtle);border:1px solid var(--border)}.tab.on{background:var(--text);color:#fff;border-color:var(--text)}
.group{margin:6px 12px 12px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--raised)}
.group h3{margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.rows{list-style:none;margin:0;padding:0}.row{display:flex;gap:10px;align-items:flex-start;padding:8px 4px}
.r-note{display:block}.row small{display:block;color:var(--muted);font-size:12px}
.sidebar > .rows{padding:0 12px}
.choice{border:0;margin:10px 0 0;padding:10px 0 0;border-top:1px solid var(--border)}
.choice legend{padding:0;font-size:13px;font-weight:600;margin-bottom:6px}
.opt{display:flex;gap:10px;align-items:flex-start;min-height:44px;padding:10px;border:1px solid var(--border);border-radius:8px;background:#fff;margin-bottom:6px}
.opt.on{border-color:var(--text);box-shadow:inset 0 0 0 1px var(--text)}
.opt b{display:block;font-weight:600}.opt small{display:block;color:var(--muted);font-size:12px}
.radio{flex:none;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--border-strong);margin-top:1px;background:#fff}
.radio.on{border:5px solid var(--text)}
.title-field{display:block;margin-top:8px}.title-field span{display:block;font-size:13px;font-weight:600;margin-bottom:4px}
.title-field input{width:100%;height:36px;border:1px solid var(--border-strong);border-radius:8px;padding:0 10px;font:inherit;background:#fff}
.g-foot{display:flex;justify-content:flex-end;margin-top:10px}
.send{height:36px;padding:0 16px;border:0;border-radius:999px;background:var(--accent);color:#fff;font:600 13px/1 inherit;font-family:inherit}
.send[aria-disabled]{opacity:.55}
.status{margin:6px 0 0;font-size:12px;color:var(--muted);text-align:right}
.why{margin:10px 0 0;font-size:12px;color:var(--muted)}
.live{margin:6px 12px 10px;padding:10px 12px;border-radius:8px;background:#f0fdf4;color:var(--success);font-weight:600;font-size:13px}
.live.warn{background:#fffbeb;color:var(--warning)}
.float{position:absolute;left:240px;top:330px}.narrow .float{position:static;margin:16px}
.thread{width:342px;background:#fff;border:1px solid var(--border);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.12)}
.th-head{display:flex;align-items:center;gap:10px;padding:10px 12px 10px 16px;border-bottom:1px solid var(--border)}
.th-stage{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px}.mini{width:10px;height:10px;border-radius:50%;background:var(--stage-new);border:1px solid var(--edge)}
.th-link{margin-left:auto;font-size:12px;padding:3px 8px;border:1px solid var(--border);border-radius:999px}
.th-body{padding:14px 16px}.th-note{margin:0 0 6px;font-size:14px}.th-meta{margin:6px 0 0;font-size:12px;color:var(--muted)}
.in-issue{margin:0;font-size:12px;font-weight:600;color:var(--subtle)}
table.texts{border-collapse:collapse;font-size:14px;line-height:1.45;background:#fff;max-width:1200px}
table.texts td,table.texts th{border:1px solid var(--border);padding:6px 10px;text-align:left;vertical-align:top}
.qa{max-width:1100px;font-size:15px;line-height:1.55}.qa li{margin-bottom:10px}
`;

const toc = frames.map((f) => `<a href="#${f.id}">${esc(f.title)}</a>`).join('');

const out = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fruitback, several notes sent together (FRU-474)</title>
<style>${css}</style>
</head>
<body>
<header class="board-head">
  <h1>Several notes sent together: one issue each, or one issue (FRU-474)</h1>
  <p>Board of the group « Kept for later, not sent yet » of the widget (FRU-124), where the person who kept several notes chooses how they arrive in the tracker: one issue for each note under one parent (what the worker does today, unsaid), or one issue that holds every note. Drawn on the tokens of the widget (packages/widget/src/theme.ts), light scheme. Frames at 1440 px are in English, frames at 390 px in French; every sentence of both is in the table at the end.</p>
  <p>Generated by <code>tools/build.mjs</code>: edit the script, not this file. A frame is a picture: its buttons do nothing. This is a design only: nothing of it is built.</p>
</header>
<nav class="toc" aria-label="Frames">${toc}<a href="#decisions">Decisions</a><a href="#later">For the build</a><a href="#texts">Texts, EN and FR</a></nav>
${rendered.join('\n')}
<section class="frame" id="decisions"><h2 class="f-title">Decisions of the board (fru-notes-edit, 2026-10-28)</h2>
<p class="notes">The ticket gave a title and no text. The agent decided each choice, the simplest and the safest, as the orchestrator asked. Each one can be changed by Mathieu.</p>
<ol class="qa">
<li><b>The choice is made when the notes are sent, in the group of the list, not in the composer.</b> A note is kept one at a time; how several arrive is a question about all of them, asked once, at the one button that sends them. The composer keeps its two actions of FRU-124.</li>
<li><b>Two choices, and today's is the default.</b> « One issue for each note, under one parent » is what <code>createBatch</code> of Linear writes now: a person who does not read the choice gets what they got before. A third choice (one issue each, no parent) is left out: it is the plain « Send » of each note.</li>
<li><b>Only where the place can group the notes.</b> Linear today. Kept in Fruitback, an address, GitHub: no choice, and one line says why (frame F). The worker says it in the read, beside <code>batch</code>: <code>batch: { max, maxBytes, groups: ['parent', 'one'] }</code>; a worker of before says nothing and the widget shows frame A.</li>
<li><b>An optional title</b>, for the parent or for the one issue. Empty: the worker writes « N notes on /page ». It is typed by a person and goes to the tracker as text.</li>
<li><b>One issue with every note keeps a pin for each note.</b> Each note keeps its element; the pins share the stage of the issue. The thread says « Note 2 of 3 in ENG-143 ». A verdict, a reply or an edit acts on the issue, and the thread says so.</li>
<li><b>One issue is all or nothing.</b> It is one write; there is no half-sent case. Under a parent, the 207 of today stays (frame G).</li>
<li><b>The choice is remembered for the tab</b>, next to the drafts (<code>sessionStorage</code>), never for the account: it is a way of working on a page today.</li>
<li><b>No picker of an existing issue</b> (« add these notes to ENG-120 »). It would need a search of the tracker from the page, a new read with its own rights. Left as an open question below.</li>
</ol></section>
<section class="frame" id="later"><h2 class="f-title">For the build, and the open questions</h2>
<ol class="qa">
<li><b>Contract.</b> One issue with several notes needs the description to hold several JSON blocks, and <code>parseNoteFromDescription</code> to answer several notes for one issue. The read then answers one issue for each note, with the same <code>id</code> and <code>identifier</code>, and a new optional field <code>group: { index, count }</code> for the thread. <code>NOTE_VERSION</code> does not move if the block of each note is unchanged.</li>
<li><b>Worker.</b> <code>POST /feedback</code> with an array takes <code>?group=one|parent&amp;title=…</code> (a query, as <code>?destination=</code>, because the relay of the extension carries no other header). <code>createBatch</code> of Linear gets the mode. The memory of a batch (FRU-195) keys the one issue as it keys a parent.</li>
<li><b>Widget.</b> The group of the list (sidebar.ts) gets the fieldset; <code>sendDrafts</code> passes the mode; <code>cutIntoRequests</code> must keep the notes of one issue in one request, so « one issue » is offered only up to <code>batch.max</code> notes.</li>
<li><b>Open: a note added later to the same issue</b> (« same issue » for a note sent alone, from the composer). Not drawn: it needs to name an issue from the page.</li>
<li><b>Open: GitHub sub-issues.</b> The connector could write them (FRU-359 uses the App); then frame B applies to GitHub too.</li>
</ol></section>
<section class="frame" id="texts"><h2 class="f-title">Texts, EN and FR</h2>
<p class="notes">Every sentence of the board. The English is the key of <code>t()</code>, the French goes to <code>locale-fr.ts</code>. A text the person typed is shown as typed.</p>
<table class="texts"><thead><tr><th>English</th><th>Français</th></tr></thead><tbody>${table}</tbody></table>
</section>
</body>
</html>
`;

writeFileSync(join(here, '..', 'batch-notes.html'), out);
console.log(`batch-notes.html: ${frames.length} frames, ${texts.size} texts`);
