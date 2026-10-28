// Builds design/agent-triggers/agent-triggers.html, the board of FRU-468 (a site starts an agent when
// a note arrives).
//
// Run from anywhere: `node design/agent-triggers/tools/build.mjs`. It needs no package. Every word goes
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
  warn: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5M12 18v.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  ok: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

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
    <a href="#" class="ws"><span class="ws-i">A</span><span><b>Acme</b><small>${t('Cloud workspace', 'Workspace Cloud')}</small></span></a>
    <nav aria-label="${t('Workspace', 'Workspace')}">${nav}</nav>
  </aside>`;
}

/** The page of a site (FRU-433), cut to its last sections: the new one sits after « Statuses ». */
function page(width, body) {
  return `<div class="app w${width}">
    ${rail(width)}
    <div class="main-wrap"><main>
      <nav class="crumbs" aria-label="${t('Breadcrumb', 'Fil d’Ariane')}"><a href="#">${t('Sites', 'Sites')}</a><span aria-hidden="true">›</span><span>shop.acme.dev</span></nav>
      <header class="pg-head"><div><h1>shop.acme.dev</h1><p class="lead">${t('Its address, where its notes go, and how to install Fruitback on it.', 'Son adresse, où vont ses notes, et comment y installer Fruitback.')}</p></div></header>
      <p class="muted elided">${t('… Site, Install, Where its notes go, Statuses …', '… Site, Installer, Où vont ses notes, Statuts …')}</p>
      ${body}
    </main></div>
  </div>`;
}

const RECEIVERS = ['hooks.acme.dev', 'agents.acme.dev'];

const lead = () =>
  t(
    'When a note arrives, Fruitback can call an address of your team, which starts your agent: a receiver that dispatches a workflow of GitHub that runs Claude Code, or a cloud agent. The call carries the id of the note, never its text: the agent reads it through the MCP server, with its agent key.',
    'Quand une note arrive, Fruitback peut appeler une adresse de votre équipe, qui lance votre agent : un récepteur qui déclenche un workflow GitHub où tourne Claude Code, ou un agent dans le cloud. L’appel porte l’id de la note, jamais son texte : l’agent la lit par le serveur MCP, avec sa clé d’agent.',
  );

const switchRow = (on) =>
  `<label class="check strong switch-row"><span><b>${t('Start an agent when a note arrives', 'Lancer un agent quand une note arrive')}</b><small>${on ? t('On. A call waits in the queue of the address when it fails, and is tried again.', 'Activé. Un appel qui échoue attend dans la file de l’adresse, et est réessayé.') : t('Off. Nothing is called.', 'Désactivé. Rien n’est appelé.')}</small></span><span class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on}"><span></span></span></label>`;

const PAYLOAD = `{
  "version": 2,
  "event": "agent.requested",
  "reason": "verified-note",
  "workspace": "ws_3f9a…",
  "site": { "id": "site_81c2…", "origin": "https://shop.acme.dev" },
  "identifier": "FB-12",
  "note": { "id": "WyJzaXRlXzgxYzIi…" }
}`;

let group = 0;
function settings({ mode = 'verified', saved = false, receivers = RECEIVERS } = {}) {
  group += 1;
  const radio = (value, label, detail) =>
    `<label class="radio"><input type="radio" name="m${group}"${mode === value ? ' checked' : ''}><span><b>${label}</b><small>${detail}</small></span></label>`;
  return `<div class="field">
      <label for="rc">${t('Call', 'Appeler')}</label>
      <span class="select" id="rc">${receivers[0]}<span aria-hidden="true">▾</span></span>
      <p class="hint">${t('An address of the workspace that receives (Connectors). Fruitback signs each call with its secret.', 'Une adresse du workspace qui reçoit (Connecteurs). Fruitback signe chaque appel avec son secret.')}</p>
    </div>
    <fieldset class="field">
      <legend>${t('When', 'Quand')}</legend>
      ${radio('verified', t('A note of a known person arrives', 'Une note d’une personne connue arrive'), t('A member, or a reviewer your site identified. A note of a visitor starts nothing: anybody can write one.', 'Un membre, ou un relecteur que votre site a identifié. La note d’un visiteur ne lance rien : n’importe qui peut en écrire une.'))}
      ${radio('todo', t('A person of the team moves a note to To do', 'Une personne de l’équipe passe une note en À faire'), t('Only a note that Fruitback keeps: a note in a tracker takes its status there. An agent that sets a status starts nothing.', 'Seulement une note que garde Fruitback : une note dans un tracker y prend son statut. Un agent qui change un statut ne lance rien.'))}
    </fieldset>
    <details class="payload" open><summary>${t('What the call carries', 'Ce que porte l’appel')}</summary><pre class="snippet">${esc(PAYLOAD)}</pre></details>
    <p class="hint">${t('Your agent opens a pull request for review, and never pushes to a branch that deploys: the guide says how.', 'Votre agent ouvre une pull request à relire, et ne pousse jamais sur une branche qui déploie : le guide dit comment.')} <a href="#">${t('Start an agent on a note', 'Lancer un agent sur une note')}</a></p>
    <div class="actions"><button type="button" class="b-wide">${t('Save', 'Enregistrer')}</button>${saved ? `<span class="saved">${icon.ok}${t('Saved.', 'Enregistré.')}</span>` : ''}</div>`;
}

const section = (inner) =>
  `<section class="sec" aria-labelledby="ag-title"><h2 id="ag-title">${t('Start an agent', 'Lancer un agent')}</h2><p class="sec-lead">${lead()}</p>${inner}</section>`;

const noReceiver = () =>
  `<div class="callout">${icon.warn}<p>${t('The workspace has no address that receives yet. Connect one, then come back here.', 'Le workspace n’a encore aucune adresse qui reçoit. Connectez-en une, puis revenez ici.')} <a href="#">${t('Connect an address', 'Connecter une adresse')}</a></p></div>`;

const failed = () =>
  `<div class="callout">${icon.warn}<p>${t('2 calls did not arrive at hooks.acme.dev. Fruitback tries again; you can try now from the address.', '2 appels ne sont pas arrivés à hooks.acme.dev. Fruitback réessaie ; vous pouvez réessayer depuis l’adresse.')} <a href="#">${t('See the calls', 'Voir les appels')}</a></p></div>`;

const restPanel = () => `<div class="panel">
  <h2>${t('An address that receives', 'Une adresse qui reçoit')}</h2>
  <p class="muted">${t('Sends to {host}', 'Envoie à {host}', { host: 'hooks.acme.dev' })}</p>
  <h3>${t('Notes that did not arrive', 'Notes non arrivées')}</h3>
  <ul class="dl">
    <li><b>${t('Your receiver answered {status}', 'Votre récepteur a répondu {status}', { status: 401 })}</b><small>${t('Call of an agent · FB-12 · written 2 h ago · 3 attempts', 'Appel d’un agent · FB-12 · écrit il y a 2 h · 3 tentatives')}</small><small>${t('Next attempt in 25 min', 'Prochaine tentative dans 25 min')}</small><button type="button" class="b-wide sm">${t('Try now', 'Réessayer maintenant')}</button></li>
    <li><b>${t('No answer: {error}', 'Pas de réponse : {error}', { error: 'timeout' })}</b><small>${t('Note FB-11 · written 3 h ago · 4 attempts', 'Note FB-11 · écrite il y a 3 h · 4 tentatives')}</small><small>${t('Next attempt in 1 h', 'Prochaine tentative dans 1 h')}</small><button type="button" class="b-wide sm">${t('Try now', 'Réessayer maintenant')}</button></li>
  </ul>
</div>`;

// --- the frames -------------------------------------------------------------------------------------
const frames = [];
const frame = (id, width, title, notes, build) => frames.push({ id, width, title, notes, build });
frame(
  'a',
  1440,
  'A · Off, as every site starts',
  [
    'A section « Start an agent » on the page of a site, after « Statuses », for an owner or an admin (manage-workspace, as the agent keys: the call starts something of the team). A member and a guest do not see it.',
    'Off by default: the switch alone, and the lead that says what a call is and what it carries.',
  ],
  () => page(1440, section(switchRow(false))),
);
frame(
  'b',
  1440,
  'B · On: the address, the moment, what the call carries',
  [
    'The address is one of the workspace that receives (the REST connector, FRU-132): signed with its secret, tried again, its failures in its panel. No new address field, no second queue (agents.md: what was set aside).',
    'Two moments, one at a time: a note of a known person (default, decision 4), or a person of the team who moves a note to To do. The second reads only the notes that Fruitback keeps, and an agent key never starts it, so an agent cannot start itself.',
    '« What the call carries » shows the body: ids, never the text nor the files. The agent reads the note through /mcp with its key.',
    'One « Save » for the section: the switch, the address and the moment are one setting of the site, written in one request.',
  ],
  () => page(1440, section(switchRow(true) + settings({ saved: true }))),
);
frame(
  'c',
  1440,
  'C · No address that receives in the workspace',
  ['The switch cannot be turned on: a callout says why, and leads to Connectors.'],
  () => page(1440, section(switchRow(false) + noReceiver())),
);
frame(
  'd',
  1440,
  'D · Calls that did not arrive',
  ['The section says how many calls of this site wait in the queue of the address, and leads to its panel.'],
  () => page(1440, section(failed() + switchRow(true) + settings({ mode: 'todo' }))),
);
frame(
  'e',
  1440,
  'E · The panel of the address: a call of an agent beside a note',
  [
    'The panel of the REST connector lists the calls with the notes, each with its kind (« Call of an agent ») and « Try now », as today.',
  ],
  () => `<div class="app w1440">${rail(1440)}<div class="main-wrap"><main>${restPanel()}</main></div></div>`,
);
frame('f', 390, 'F · 390 px, French: on', [], () => page(390, section(switchRow(true) + settings())));

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
.switch-row{justify-content:space-between;gap:16px}
.switch{flex:none;width:44px;height:26px;border-radius:999px;border:1px solid var(--control);background:#fff;position:relative;margin-top:2px}
.switch span{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--control)}
.switch.on{background:var(--ink);border-color:var(--ink)}
.switch.on span{left:20px;background:#fff}
.confirm{grid-column:1/-1;margin:8px 0 2px;padding:14px 18px;border-radius:10px;border:1px solid var(--line);background:var(--subtle)}
.confirm p{margin:0;font-size:15px;line-height:1.5}
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
const extra = `
.field label.radio{display:flex;font-weight:400}
.elided{font-size:14px;margin:0 0 24px}
.sec{max-width:760px;display:flex;flex-direction:column;gap:14px}
.sec h2{margin:0;font-size:18px}
.sec-lead{margin:0;font-size:15px;line-height:1.5;color:var(--ink-soft)}
.select{display:flex;justify-content:space-between;align-items:center;height:44px;max-width:420px;border:1px solid var(--control);border-radius:8px;padding:0 12px;font-size:15px}
.payload summary{cursor:pointer;font-size:14px;font-weight:600}
.saved{display:inline-flex;gap:6px;align-items:center;color:var(--done);font-size:14px;font-weight:600}
.saved svg{width:16px;height:16px}
.panel{max-width:420px;border:1px solid var(--line);border-radius:14px;padding:20px 22px}
.panel h2{margin:0 0 4px;font-size:18px}.panel h3{margin:18px 0 6px;font-size:14px}
.dl{list-style:none;margin:0;padding:0}.dl li{border-bottom:1px solid var(--line);padding:8px 0;font-size:14px}
.dl small{display:block;font-size:13px;color:var(--muted)}.dl button{margin-top:8px}
`;
const toc = frames.map((f) => `<a href="#${f.id}">${esc(f.title)}</a>`).join('');
const out = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fruitback, a site starts an agent (FRU-468)</title>
<style>${css}${extra}</style>
</head>
<body>
<header class="board-head">
  <h1>A site starts an agent when a note arrives (FRU-468)</h1>
  <p>Board of the section « Start an agent » of the page of a site (agents.md, « Starting an agent on a note »): off by default; on, it calls an address of the workspace that receives (the REST connector, FRU-132) when a note of a known person arrives, or when a person of the team moves a note to To do. The call carries ids, never the text. Frames at 1440 px are in English, at 390 px in French; every sentence of both is in the table at the end.</p>
  <p>Generated by <code>tools/build.mjs</code>: edit the script, not this file. A frame is a picture: its buttons do nothing.</p>
</header>
<nav class="toc" aria-label="Frames">${toc}<a href="#decisions">Decisions</a><a href="#texts">Texts, EN and FR</a></nav>
${rendered.join('\n')}
<section class="frame" id="decisions"><h2 class="f-title">Decisions of the board (fru-agents, 2026-10-28)</h2>
<p class="notes">The orchestrator asked the agent to decide the choices itself and to write them down. Each one can be changed by Mathieu.</p>
<ol class="qa">
<li><b>Where.</b> A section of the page of a site, « Start an agent », after « Statuses ». A trigger is of a site (agents.md); a page of its own would be one more place for one setting.</li>
<li><b>Who.</b> The owner and the admins (<code>manage-workspace</code>), as for the agent keys: the call starts a process of the team, with its rights.</li>
<li><b>The address is a REST connector of the workspace.</b> It is already signed, tried again, guarded against a private address at each attempt, and its failures are in its panel with « Try now ». The section chooses one; with none, it leads to Connectors. A site that also sends its notes to the same address gets two calls for a note: <code>note.created</code> and <code>agent.requested</code>, told apart by <code>event</code>.</li>
<li><b>The body:</b> <code>version</code> 2, <code>event: "agent.requested"</code>, <code>reason</code> (<code>verified-note</code> or <code>moved-to-todo</code>), the workspace, the site, the identifier and <code>note.id</code>, the id that <code>get_feedback</code> takes. No text, no file, so nothing of the note leaves twice.</li>
<li><b>GitHub.</b> Fruitback holds no token of GitHub: <code>repository_dispatch</code> needs one. The team's receiver checks the signature and calls <code>repository_dispatch</code> with its own token; docs/agents.md gives one, short. The other ways (a token of the team kept by Fruitback, or the right <code>contents: write</code> on the GitHub App) are a new secret or a new permission of the manifest: not taken.</li>
<li><b>The two moments, one at a time.</b> A verified note (a member, or a reviewer the site's identity verified), or « moved to To do » by a person with a session of the console or the extension, on a note that Fruitback keeps. An agent key that sets a status never starts a call: an agent cannot start itself.</li>
<li><b>One call per note and moment.</b> A note moved to To do twice calls twice only if it left To do between; a note of a known person calls once.</li>
<li><b>One « Save ».</b> The switch, the address and the moment are written together.</li>
<li><b>The real trial</b> (a <code>repository_dispatch</code> that runs a workflow reading the note by <code>/mcp</code>) needs a worker reachable from GitHub and a receiver deployed: an environment of Mathieu, not of an agent.</li>
</ol></section>
<section class="frame" id="texts"><h2 class="f-title">Texts, EN and FR</h2>
<table class="texts"><thead><tr><th>English</th><th>Français</th></tr></thead><tbody>${table}</tbody></table>
</section>
</body>
</html>
`;
writeFileSync(join(here, '..', 'agent-triggers.html'), out);
console.log(`agent-triggers.html: ${frames.length} frames, ${texts.size} texts`);
