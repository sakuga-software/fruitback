// Builds design/task-bulk/task-bulk.html, the board of FRU-656 (several tasks chosen at once, and
// one change for all of them).
//
// Run from anywhere: `node design/task-bulk/tools/build.mjs`. It needs no package. Every word goes
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
const icon = {
  more: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>',
  open: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close:
    '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  down: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tick: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  dash: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 12h12" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  right:
    '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const STAGE = { progress: '#f3bb3d', todo: '#d9dbdf', new: '#bec2c8', done: '#5560c4' };

function rail(width) {
  const nav = [
    [t('Sites', 'Sites'), false],
    [t('Notes', 'Notes'), true],
    [t('Connectors', 'Connecteurs'), false],
    [t('Members', 'Membres'), false],
    [t('My account', 'Mon compte'), false],
  ]
    .map(([w, cur]) => `<a href="#"${cur ? ' aria-current="page"' : ''}>${w}</a>`)
    .join('');
  return `<aside class="rail${width < 900 ? ' rail-row' : ''}">
    <a href="#" class="ws"><span class="ws-i">A</span><span><b>Acme</b><small>${t('Cloud workspace', 'Workspace Cloud')}</small></span></a>
    <nav aria-label="${t('Workspace', 'Workspace')}">${nav}</nav>
  </aside>`;
}

const MARK = { on: icon.tick, some: icon.dash, off: '' };
const box = (state, extra = '') => `<span class="box ${state}${extra}" aria-hidden="true">${MARK[state]}</span>`;

const NOTES = () => [
  {
    text: t('The price of the yearly plan wraps on two lines', 'Le prix du plan annuel passe sur deux lignes'),
    stage: 'progress',
    site: 'acme.dev',
    who: 'Bob',
    when: t('2 h', '2 h'),
    marks: [t('High', 'Haute'), 'Bob'],
  },
  {
    text: t('The logo is blurred on a phone', 'Le logo est flou sur un téléphone'),
    stage: 'todo',
    site: 'acme.dev',
    who: 'Carol',
    when: t('3 h', '3 h'),
    marks: [t('Urgent', 'Urgente')],
  },
  {
    text: t('« Start your trial » goes to a 404', '« Commencer l’essai » mène à une 404'),
    stage: 'todo',
    site: 'acme.dev',
    who: 'Alice',
    when: t('5 h', '5 h'),
    marks: [],
  },
  {
    text: t('The footer links are too close together', 'Les liens du pied de page sont trop serrés'),
    stage: 'new',
    site: 'shop.acme.dev',
    who: 'Bob',
    when: t('1 d', '1 j'),
    marks: [t('Due tomorrow', 'Pour demain')],
  },
  {
    text: t('A typo in the second paragraph of About', 'Une coquille dans le deuxième paragraphe de À propos'),
    stage: 'new',
    site: 'shop.acme.dev',
    who: t('Visitor', 'Visiteur'),
    when: t('2 d', '2 j'),
    marks: [],
  },
];

function head(width) {
  return `<header class="pg-head"><div><h1>${t('Notes', 'Notes')}</h1><p class="lead">${t('Every note left on the sites of Acme, and where it went.', 'Toutes les notes laissées sur les sites d’Acme, et où elles sont allées.')}</p></div>
  <div class="view" role="group" aria-label="${t('View', 'Vue')}"><button type="button" class="${width < 900 ? '' : 'on'}">${t('Table', 'Liste')}</button><button type="button">${t('Board', 'Tableau')}</button></div></header>
  <div class="filters"><span class="chip on">${t('All', 'Toutes')} 12</span><span class="chip">Fruitback 12</span><span class="search">${t('Search the notes', 'Chercher dans les notes')}</span></div>`;
}

const groupName = {
  progress: () => t('In progress', 'En cours'),
  todo: () => t('To do', 'À faire'),
  new: () => t('New', 'Nouvelle'),
  done: () => t('Done', 'Terminée'),
};

function table(selected, { menuOn } = {}) {
  const notes = NOTES();
  const groups = ['progress', 'todo', 'new'];
  let i = -1;
  const rows = groups
    .map((stage) => {
      const inGroup = notes.map((n, index) => ({ ...n, index })).filter((n) => n.stage === stage);
      return `<tbody><tr class="group"><th colspan="6"><span class="dot" style="background:${STAGE[stage]}"></span>${groupName[stage]()} <span class="muted">${inGroup.length}</span></th></tr>${inGroup
        .map((n) => {
          i += 1;
          const on = selected.includes(n.index);
          return `<tr class="${on ? 'sel' : ''}"><td class="c-note"><span class="cell">${box(on ? 'on' : 'off', on || selected.length > 0 ? ' shown' : '')}<span class="dot big" style="background:${STAGE[n.stage]}"></span><span><a href="#" class="text">${n.text}</a>${n.marks.length ? `<span class="marks">${n.marks.map((m) => `<span class="mark">${m}</span>`).join('')}</span>` : ''}</span></span></td><td>${n.site}</td><td>${n.who}</td><td>Fruitback</td><td class="end muted">${n.when}</td><td class="end"><span class="icons"><span class="ib">${icon.open}</span><span class="ib${menuOn === n.index ? ' pressed' : ''}">${icon.more}</span></span></td></tr>`;
        })
        .join('')}</tbody>`;
    })
    .join('');
  let all = 'some';
  if (selected.length === 0) all = 'off';
  else if (selected.length === notes.length) all = 'on';
  return `<div class="table"><table><thead><tr><th><span class="cell">${box(all, ' shown')}${t('Note', 'Note')}</span></th><th>${t('Site', 'Site')}</th><th>${t('Left by', 'Laissée par')}</th><th>${t('Went to', 'Envoyée à')}</th><th class="end">${t('When', 'Quand')}</th><th></th></tr></thead>${rows}</table></div>`;
}

function stacked(selected) {
  return `<ol class="stack">${NOTES()
    .slice(0, 4)
    .map((n, index) => {
      const on = selected.includes(index);
      return `<li class="${on ? 'sel' : ''}"><span class="cell">${box(on ? 'on' : 'off', ' shown')}<span class="dot big" style="background:${STAGE[n.stage]}"></span><a href="#" class="text">${n.text}</a></span><span class="muted small">${n.site} · ${n.who} · ${n.when}</span></li>`;
    })
    .join('')}</ol>`;
}

function board(selected) {
  const notes = NOTES();
  const cols = ['progress', 'todo', 'new', 'done'];
  return `<div class="board">${cols
    .map((stage) => {
      const inCol = notes.map((n, index) => ({ ...n, index })).filter((n) => n.stage === stage);
      return `<section class="col"><h2><span class="dot" style="background:${STAGE[stage]}"></span>${groupName[stage]()} <span class="muted">${inCol.length}</span></h2>${
        inCol.length === 0
          ? `<p class="muted small">${t('No note here.', 'Aucune note ici.')}</p>`
          : `<ul>${inCol
              .map((n) => {
                const on = selected.includes(n.index);
                return `<li class="${on ? 'sel' : ''}"><span class="cell">${box(on ? 'on' : 'off', selected.length > 0 ? ' shown' : '')}<a href="#" class="text">${n.text}</a></span>${n.marks.length ? `<span class="marks">${n.marks.map((m) => `<span class="mark">${m}</span>`).join('')}</span>` : ''}<span class="foot"><span>${n.who}</span><span>${n.when}</span><span class="ib">${icon.open}</span><span class="ib">${icon.more}</span></span></li>`;
              })
              .join('')}</ul>`
      }</section>`;
    })
    .join('')}</div>`;
}

/** The bar at the foot of the screen. */
function bar({ count, page = 12, open, confirm, others = 0, problem, done, narrow = false }) {
  const selectedWords =
    count === 1
      ? t('1 note selected', '1 note sélectionnée')
      : t('{count} notes selected', '{count} notes sélectionnées', { count });
  const menu = (label, id) =>
    `<button type="button" class="b-bar${open === id ? ' pressed' : ''}" aria-haspopup="menu">${label}${icon.down}</button>`;
  const lines = [
    others > 0
      ? `<p class="bar-note">${
          others === 1
            ? t(
                '1 of them is not yours to change: it stays as it is.',
                '1 d’entre elles ne peut pas être changée par vous : elle reste telle quelle.',
              )
            : t(
                '{count} of them are not yours to change: they stay as they are.',
                '{count} d’entre elles ne peuvent pas être changées par vous : elles restent telles quelles.',
                { count: others },
              )
        }</p>`
      : '',
    problem ? `<p class="bar-problem">${problem}</p>` : '',
    done ? `<p class="bar-done" role="status">${done}</p>` : '',
  ].join('');
  const confirmBlock = confirm
    ? `<div class="bar-confirm" role="group"><p>${t('The {count} notes, their replies and their labels go for good. Nobody can bring them back.', 'Les {count} notes, leurs réponses et leurs labels partent pour de bon. Personne ne peut les faire revenir.', { count })}</p><button type="button" class="b-quiet focus">${t('Keep them', 'Les garder')}</button><button type="button" class="b-danger">${t('Delete {count} notes', 'Supprimer {count} notes', { count })}</button></div>`
    : '';
  return `<section class="bar${narrow ? ' narrow' : ''}" aria-label="${t('The selected notes', 'Les notes sélectionnées')}">
    <div class="bar-row">
      <span class="bar-count"><b>${selectedWords}</b>${count < page ? `<a href="#">${t('Select the {count} of this page', 'Sélectionner les {count} de cette page', { count: page })}</a>` : ''}</span>
      <span class="bar-actions">
        ${menu(t('Status', 'Statut'), 'status')}${menu(t('Assignee', 'Personne assignée'), 'assignee')}${menu(t('Priority', 'Priorité'), 'priority')}${menu(t('Labels', 'Labels'), 'labels')}${menu(t('Due day', 'Échéance'), 'due')}
        <button type="button" class="b-bar">${t('Archive', 'Archiver')}</button>
        <button type="button" class="b-bar danger${confirm ? ' pressed' : ''}">${t('Delete…', 'Supprimer…')}</button>
      </span>
      <button type="button" class="ib close" aria-label="${t('Clear the selection', 'Vider la sélection')}">${icon.close}</button>
    </div>
    ${lines}${confirmBlock}
  </section>`;
}

function labelsMenu() {
  const item = (name, color, state) =>
    `<li class="${state}"><span class="ind">${state === 'on' ? icon.tick : ''}</span><span class="sw" style="background:${color}"></span>${name}</li>`;
  return `<div class="popover" style="left:var(--x);bottom:84px"><ul class="menu" aria-label="${t('Labels', 'Labels')}">
    ${item(t('Bug', 'Bug'), '#dc2626', 'on')}${item(t('Design', 'Design'), '#2563eb', '')}${item(t('Copy', 'Texte'), '#9333ea', '')}
    <li class="sep"></li><li><span class="ind"></span>${t('New label…', 'Nouveau label…')}</li></ul></div>`;
}

function contextMenu() {
  const branch = (label, open) =>
    `<li class="${open ? 'hl' : ''}"><span class="ind"></span>${label}<span class="chev">${icon.right}</span></li>`;
  return `<div class="popover" style="right:68px;top:318px"><ul class="menu" aria-label="${t('Actions of the 3 selected notes', 'Actions des 3 notes sélectionnées')}">
    <li class="menu-head">${t('3 selected notes', '3 notes sélectionnées')}</li>
    ${branch(t('Status', 'Statut'), true)}${branch(t('Assignee', 'Personne assignée'))}${branch(t('Priority', 'Priorité'))}${branch(t('Due day', 'Échéance'))}${branch(t('Labels', 'Labels'))}
    <li><span class="ind"></span>${t('Archive', 'Archiver')}</li><li class="danger"><span class="ind"></span>${t('Delete…', 'Supprimer…')}</li></ul></div>
    <div class="popover" style="right:300px;top:350px"><ul class="menu" aria-label="${t('Status', 'Statut')}">
    <li><span class="ind"></span><span class="dot" style="background:${STAGE.new}"></span>${t('New', 'Nouvelle')}</li>
    <li><span class="ind"></span><span class="dot" style="background:${STAGE.todo}"></span>${t('To do', 'À faire')}</li>
    <li class="hl"><span class="ind"></span><span class="dot" style="background:${STAGE.progress}"></span>${t('In progress', 'En cours')}</li>
    <li><span class="ind"></span><span class="dot" style="background:${STAGE.done}"></span>${t('Done', 'Terminée')}</li></ul></div>`;
}

function page(width, body, overlay = '') {
  return `<div class="app w${width}">
    ${rail(width)}
    <div class="main-wrap"><main>${head(width)}${body}</main>${overlay}</div>
  </div>`;
}

// --- the frames -------------------------------------------------------------------------------------
const frames = [];
const frame = (id, width, title, notes, build) => frames.push({ id, width, title, notes, build });
frame(
  'a',
  1440,
  'A · The table: three tasks selected, the bar at the foot',
  [
    'Each row of a task Fruitback keeps starts with a box, before the drop of its status. A note of a tracker has no box: it changes in its tracker.',
    'The box of the head selects every task of the page, or none; it is half ticked when some are. The page is what the list shows: 25 notes at most, under the filters.',
    'A selected row is tinted with the chip colour. Shift and a click on a box, or on the row out of its links and buttons, selects every task between it and the box pressed before.',
    'The bar is under the list, and stays at the foot of the screen while the list is there, from the first selected task; it is drawn as a panel of the console (the surface, its line and its shadow). It says how many, offers the rest of the page, and holds the five fields of the menu of a task, then Archive and Delete…. The cross, and Escape, clear the selection.',
  ],
  () => page(1440, table([1, 2, 3]), bar({ count: 3, page: 5 })),
);
frame(
  'b',
  1440,
  'B · The board: two cards selected',
  [
    'A card shows its box at the start of its first line once the pointer is over it, the keyboard is in it, or a selection exists. On a touch screen it is always there.',
    'A selected card has an ink border. The bar is the same as on the table.',
  ],
  () => page(1440, board([1, 3]), bar({ count: 2, page: 5 })),
);
frame(
  'c',
  1440,
  'C · « Labels » of the bar: a label that every selected task has is ticked',
  [
    'Each button of the bar opens the submenu of the menu of a task (FRU-654), with its items and its checks. A value is checked when every selected task has it.',
    'A label ticked is taken off every selected task; a label not ticked goes on every one of them. The other labels of each task stay.',
    'The change is saved at once, for the whole selection, in one call: either every task changes, or none does.',
  ],
  () =>
    page(
      1440,
      table([1, 2, 3]),
      `<div style="--x:804px">${bar({ count: 3, page: 5, open: 'labels' })}${labelsMenu()}</div>`,
    ),
);
frame(
  'd',
  1440,
  'D · A right click on a selected task: the menu acts on the whole selection',
  [
    'The menu is the menu of FRU-654, from the same code: its first line says the count, and its button is named « Actions of the 3 selected notes ».',
    'Move up, Move down and Copy the link are for one note: they are not in the menu of a selection. A right click on a task out of the selection opens the menu of that task alone, and keeps the selection.',
  ],
  () => page(1440, table([1, 2, 3], { menuOn: 2 }), bar({ count: 3, page: 5 }) + contextMenu()),
);
frame(
  'e',
  1440,
  'E · Delete… asks again, in the bar',
  [
    'The words of « Delete… » of a task (FRU-665), with the count. « Keep them » has the focus, and Escape gives it back to « Delete… ».',
  ],
  () => page(1440, table([1, 2, 3]), bar({ count: 3, page: 5, confirm: true })),
);
frame(
  'f',
  1440,
  'F · Tasks the person cannot change, and a change refused',
  [
    'A member can change only the tasks they left; an owner or an admin, every task. The selection may hold the others: the bar says how many, and the change leaves them as they are.',
    'A refusal of the worker is said in the bar, in the words of the menu, and nothing changed: one call, one transaction.',
    'A change saved says so in the bar, and to a screen reader: « 3 notes changed. »',
  ],
  () =>
    page(
      1440,
      table([0, 1, 2, 3]),
      bar({
        count: 4,
        page: 5,
        others: 1,
        problem: t(
          'This label was removed since the list was read. Reload the page.',
          'Ce label a été supprimé depuis la lecture de la liste. Rechargez la page.',
        ),
      }),
    ),
);
frame(
  'g',
  390,
  'G · 390 px, French: the rows stacked, the bar on two lines',
  [
    'The bar takes the width of the screen less 16 px on each side, and its buttons go to the next line. The list keeps room under its last row for it.',
  ],
  () => page(390, stacked([0, 2]), bar({ count: 2, page: 4, narrow: true })),
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
const table_ = [...texts.entries()].map(([en, fr]) => `<tr><td>${esc(en)}</td><td>${esc(fr)}</td></tr>`).join('');
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
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.focus{outline:2px solid var(--accent);outline-offset:2px}
.muted{color:var(--muted)}.small{font-size:13px}
.app{display:flex;min-height:760px;background:#fff}
.rail{flex:0 0 248px;background:var(--rail);color:#fff;padding:16px 12px;display:flex;flex-direction:column;gap:20px}
.rail .ws{display:flex;gap:10px;align-items:center;padding:8px;border-radius:10px;color:#fff;text-decoration:none}
.ws-i{width:32px;height:32px;border-radius:8px;background:#fff;color:var(--ink);display:grid;place-items:center;font-weight:700;font-size:14px;flex:none}
.ws b{display:block;font-size:15px}.ws small{display:block;font-size:12px;color:var(--rail-muted)}
.rail nav{display:flex;flex-direction:column;gap:2px}
.rail nav a{display:flex;align-items:center;min-height:40px;padding:0 12px;border-radius:10px;color:var(--rail-text);font-size:15px;text-decoration:none;white-space:nowrap}
.rail nav a[aria-current]{background:var(--rail-active);color:#fff}
.w390{flex-direction:column;min-height:0}
.w390 .rail{flex:none;padding:10px 12px;gap:6px}
.w390 .rail nav{flex-direction:row;overflow:hidden}
.main-wrap{flex:1;min-width:0;position:relative}
main{padding:32px 48px 120px}
.w390 main{padding:20px 16px 150px}
.pg-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px 24px;margin-bottom:20px}
.pg-head h1{margin:0 0 6px;font-size:28px;line-height:1.15;letter-spacing:-.02em}
.lead{margin:0;font-size:16px;line-height:1.5;color:var(--muted);max-width:760px}
.view{display:inline-flex;border:1px solid var(--control);border-radius:8px;overflow:hidden}
.view button{height:36px;padding:0 14px;border:0;background:#fff;font-size:14px;font-weight:600}
.view button.on{background:var(--ink);color:#fff}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px}
.chip{display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:999px;background:var(--chip);font-size:14px;font-weight:600}
.chip.on{background:var(--ink);color:#fff}
.search{flex:0 1 280px;height:36px;border:1px solid var(--control);border-radius:8px;padding:0 12px;display:flex;align-items:center;font-size:14px;color:var(--muted)}
.table{border:1px solid var(--line);border-radius:14px;overflow:hidden}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
thead th{font-size:13px;color:var(--muted);font-weight:600;background:var(--subtle)}
.end{text-align:right}
tr.group th{background:var(--subtle);font-size:13px;font-weight:600;color:var(--ink)}
tr.sel td{background:var(--chip)}
.cell{display:flex;gap:8px;align-items:flex-start}
.text{color:var(--ink);text-decoration:none;font-size:15px;line-height:1.4}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:-1px;flex:none}
.dot.big{width:14px;height:14px;margin:3px 0 0;border:1px solid rgba(0,0,0,.08)}
.marks{display:flex;gap:6px;margin-top:6px}
.mark{font-size:12px;padding:1px 8px;border-radius:999px;background:var(--chip);color:var(--ink-soft);font-weight:600}
tr.sel .mark{background:#fff}
.box{flex:none;width:16px;height:16px;margin-top:3px;border:1px solid var(--control);border-radius:3px;background:#fff;display:grid;place-items:center;color:#fff;opacity:.0}
.box.shown{opacity:1}
.box.on,.box.some{background:var(--ink);border-color:var(--ink)}
.box svg{width:12px;height:12px}
.icons{display:inline-flex;gap:4px}
.ib{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:8px;color:var(--ink);border:0;background:transparent}
.ib svg{width:18px;height:18px}
.ib.pressed{background:var(--chip)}
.board{display:flex;gap:12px;align-items:flex-start}
.col{flex:none;width:272px;border:1px solid var(--line);border-radius:14px;background:var(--subtle);padding:12px}
.col h2{font-size:14px;margin:0 0 10px;display:flex;align-items:center}
.col h2 .muted{margin-left:auto;font-weight:400}
.col ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.col li{border:1px solid var(--line);border-radius:10px;background:#fff;padding:12px;font-size:14px}
.col li.sel{border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
.col .foot{display:flex;gap:12px;align-items:center;margin-top:8px;font-size:13px;color:var(--muted)}
.col .foot span:first-child{flex:1}
.stack{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:14px;overflow:hidden}
.stack li{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px}
.stack li.sel{background:var(--chip)}
.bar{position:absolute;left:48px;right:48px;bottom:24px;background:#fff;color:var(--ink);border:1px solid var(--line);border-radius:14px;padding:10px 10px 10px 14px;box-shadow:0 10px 30px rgba(24,24,27,.08)}
.bar.narrow{left:16px;right:16px;bottom:16px}
.bar-row{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.bar-count{display:flex;flex-direction:column;gap:2px;font-size:14px;margin-right:6px}
.bar-count a{color:var(--ink);font-size:13px;font-weight:600;text-underline-offset:3px}
.bar-actions{display:flex;flex-wrap:wrap;gap:6px}
.b-bar{height:32px;padding:0 14px;border:1px solid var(--control);border-radius:999px;background:#fff;color:var(--ink);font-size:13px;font-weight:600}
.b-bar.pressed{background:var(--chip)}
.b-bar.danger{color:var(--accent-strong)}
.bar .close{color:var(--muted);margin-left:auto}
.bar.narrow .bar-count{flex-basis:calc(100% - 48px)}
.bar-note,.bar-problem,.bar-done{margin:8px 0 2px;font-size:13px;line-height:1.45}
.bar-note{color:var(--muted)}.bar-problem{color:var(--accent-strong);font-weight:600}.bar-done{color:var(--done);font-weight:600}
.bar-confirm{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
.bar-confirm p{flex-basis:100%;margin:0 0 2px;font-size:14px}
.b-quiet{height:36px;padding:0 14px;border:0;border-radius:999px;background:var(--chip);color:var(--ink);font-size:14px;font-weight:600}
.b-danger{height:36px;padding:0 14px;border:0;border-radius:999px;background:var(--accent-strong);color:#fff;font-size:14px;font-weight:600}
.popover{position:absolute;z-index:3}
.menu{list-style:none;margin:0;padding:6px;min-width:220px;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.16);font-size:14px}
.menu li{display:flex;align-items:center;gap:8px;min-height:36px;padding:0 10px;border-radius:8px}
.menu li.hl{background:var(--chip)}
.menu li.danger{color:var(--accent-strong)}
.menu li.sep{min-height:0;height:1px;padding:0;margin:4px 0;background:var(--line)}
.menu-head{font-size:12px;font-weight:600;color:var(--muted);min-height:28px!important}
.menu .ind{width:16px;display:inline-grid;place-items:center}.menu .ind svg{width:14px;height:14px}
.menu .chev{margin-left:auto;display:inline-grid}.menu .chev svg{width:14px;height:14px}
.sw{width:12px;height:12px;border-radius:3px}
table.texts{border-collapse:collapse;font-size:14px;line-height:1.45;background:#fff;max-width:1200px;width:auto}
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
<title>Fruitback, several tasks at once (FRU-656)</title>
<style>${css}</style>
</head>
<body>
<header class="board-head">
  <h1>Several tasks at once (FRU-656)</h1>
  <p>Board of the selection of the screen « Notes » (console.md, the tasks of FRU-649): a box on each task Fruitback keeps, in the table and on the board, Shift and a click for a range, Cmd or Ctrl and A for the whole page, Escape to clear; a bar at the foot of the screen that changes the status, the assignee, the priority, the labels or the due day of every selected task at once, archives them and deletes them; and the menu of a task, on a selected task, for the whole selection. Frames at 1440 px are in English, at 390 px in French; every sentence of both is in the table at the end.</p>
  <p>Generated by <code>tools/build.mjs</code>: edit the script, not this file. A frame is a picture: its buttons do nothing.</p>
</header>
<nav class="toc" aria-label="Frames">${toc}<a href="#decisions">Decisions</a><a href="#texts">Texts, EN and FR</a></nav>
${rendered.join('\n')}
<section class="frame" id="decisions"><h2 class="f-title">Decisions of the board (fru-tasks-bulk, 2026-11-24)</h2>
<p class="notes">The orchestrator decides the open choices of the tasks module; the agent wrote these down, and each one can be changed by Mathieu.</p>
<ol class="qa">
<li><b>What can be selected.</b> A task Fruitback keeps: a note with the fields of a task. A note of a tracker changes in its tracker, and has no box.</li>
<li><b>The whole view is the page shown.</b> Cmd or Ctrl and A, and the box of the head, select the tasks the list shows: one page of 25 at most, under the filters. A selection of every page would need the worker to change notes the screen never read; the bar offers the rest of the page, not of the list.</li>
<li><b>The keys.</b> Cmd or Ctrl and A selects the page when the focus is not in a field of text, a menu or a dialog: there, the key keeps its own work. Escape clears the selection when no menu, dialog, panel or question of the screen takes it first.</li>
<li><b>A range.</b> Shift and a click on a box, or on the row or the card out of its links and buttons, gives every task between the box pressed before and this one, in the order of the screen (the groups of the table, the columns of the board), the state of the one pressed.</li>
<li><b>One change, one call, one transaction.</b> <code>POST …/tasks</code> takes the notes and the change; every note is checked with the rights of a change of one task, and one refusal changes nothing. Before, the console had no gesture for several notes: a change of 25 tasks was 25 calls and 25 reads of the list, one after the other.</li>
<li><b>Labels add and take off.</b> A label every selected task has is checked; choosing it takes it off all of them, choosing another puts it on all of them. The other labels of each task stay.</li>
<li><b>What a person cannot change stays in the selection.</b> The bar says how many such tasks it holds, and the change goes to the others only: FRU-658 copies a selection, and a copy needs no right to change.</li>
<li><b>The menu of FRU-654 on a selection</b> is the same code, with the values checked when every task has them. Move up, Move down and Copy the link are for one note.</li>
<li><b>The selection stays after a change</b>, as long as its tasks are on the screen: a task archived, deleted or filtered out leaves it.</li>
<li><b>Announced.</b> The count of the selection, and the end of a change, are said by a line of status of the bar.</li>
</ol></section>
<section class="frame" id="texts"><h2 class="f-title">Texts, EN and FR</h2>
<table class="texts"><thead><tr><th>English</th><th>Français</th></tr></thead><tbody>${table_}</tbody></table>
</section>
</body>
</html>
`;
writeFileSync(join(here, '..', 'task-bulk.html'), out);
console.log(`task-bulk.html: ${frames.length} frames, ${texts.size} texts`);
