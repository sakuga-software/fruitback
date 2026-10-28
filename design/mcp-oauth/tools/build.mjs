// Builds design/mcp-oauth/mcp-oauth.html, the board of FRU-467 (an MCP client, as a connector of
// claude.ai, connects to /mcp with OAuth, and a person of the team approves it in the console).
//
// Run from anywhere: `node design/mcp-oauth/tools/build.mjs`. It needs no package. Every word goes
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
  down: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// --- the page of the console outside a workspace (EntryPage, « wide »: a column of 440 px) ----------
function entry(width, body) {
  return `<div class="entry w${width}">
    <header class="e-head"><span class="logo">fruitback</span></header>
    <main class="e-main"><div class="e-col">${body}</div></main>
  </div>`;
}

const HOST = 'claude.ai';
const SITES = () => [
  ['shop.acme.dev', t('Everyone reads its notes', 'Tout le monde lit ses notes')],
  ['staging.acme.dev', t('The team reads its notes', 'L’équipe lit ses notes')],
  ['docs.acme.dev', t('The team reads its notes', 'L’équipe lit ses notes')],
];

const who = () =>
  `<p class="who">${t('Signed in as {email}', 'Connecté en tant que {email}', { email: '<b>lea@acme.dev</b>' })} · <a href="#">${t('Not you?', 'Pas vous ?')}</a></p>`;

/** The head of the question: who asks, said by the address it goes back to, then the name it gave. */
const asker = () => `<div class="asker">
    <span class="a-host">${HOST}</span>
    <span class="a-name">${t('Calls itself « {name} »', 'Se nomme « {name} »', { name: 'Claude' })}</span>
  </div>
  <p class="e-lead">${t('{host} asks to read the notes of your sites through the MCP server of Fruitback, as an agent of your team.', '{host} demande à lire les notes de vos sites par le serveur MCP de Fruitback, comme un agent de votre équipe.', { host: `<b>${HOST}</b>` })}</p>`;

let radios = 0;
function consent({ write = true, error = '' } = {}) {
  radios += 1;
  const r = `r${radios}`;
  const site = ([host, how], checked) =>
    `<label class="check"><input type="checkbox"${checked ? ' checked' : ''}><span><span class="host">${host}</span><small>${how}</small></span></label>`;
  return `<h1 class="e-title">${t('Connect an agent', 'Connecter un agent')}</h1>
  ${asker()}
  ${who()}
  <div class="field"><label for="ws">${t('Workspace', 'Workspace')}</label>
    <span class="select" id="ws">Acme<span aria-hidden="true">▾</span></span>
    <p class="hint">${t('The workspaces where you are an owner or an admin. The agent reaches this one, never another.', 'Les workspaces où vous êtes propriétaire ou admin. L’agent atteint celui-ci, jamais un autre.')}</p></div>
  <fieldset class="field${error ? ' bad' : ''}"><legend>${t('Sites it reads', 'Sites qu’il lit')}</legend>
    <div class="checks">${SITES()
      .map((s, i) => site(s, error ? false : i < 2))
      .join('')}</div>
    ${error ? `<p class="err" role="alert">${error}</p>` : ''}</fieldset>
  <fieldset class="field"><legend>${t('What it can do', 'Ce qu’il peut faire')}</legend>
    <label class="radio"><input type="radio" name="${r}" checked><span><b>${t('Read', 'Lire')}</b><small>${t('The notes, their replies and their status.', 'Les notes, leurs réponses et leur statut.')}</small></span></label>
    ${write ? `<label class="radio"><input type="radio" name="${r}"><span><b>${t('Read and write', 'Lire et écrire')}</b><small>${t('It also replies in a thread, and sets a status. Its replies say « Agent ».', 'Il répond aussi dans un fil, et change un statut. Ses réponses disent « Agent ».')}</small></span></label>` : `<p class="hint">${t('{host} asked to read only.', '{host} a demandé à lire seulement.', { host: HOST })}</p>`}
  </fieldset>
  <div class="field"><label for="days">${t('Ends after', 'Prend fin après')}</label>
    <div class="days-row"><input id="days" inputmode="numeric" value="90"><span>${t('days, 365 at most', 'jours, 365 au plus')}</span></div></div>
  <label class="check strong"><input type="checkbox" checked><span><b>${t('Only the notes of a known person', 'Seulement les notes d’une personne connue')}</b><small>${t('On a site that everyone reads, the agent does not read the notes of visitors: anybody can write one.', 'Sur un site que tout le monde lit, l’agent ne lit pas les notes des visiteurs : n’importe qui peut en écrire une.')}</small></span></label>
  <p class="hint">${t('You can revoke it at any time in Workspace settings › Agents. It ends at once.', 'Vous pouvez le révoquer à tout moment dans Paramètres du workspace › Agents. Il s’arrête aussitôt.')}</p>
  <div class="actions stack"><button type="button" class="b-accent">${t('Allow {host}', 'Autoriser {host}', { host: HOST })}</button><button type="button" class="b-wide">${t('Deny', 'Refuser')}</button></div>
  <p class="foot">${t('You go back to {url}', 'Vous revenez à {url}', { url: '<code>https://claude.ai/api/mcp/auth_callback</code>' })}</p>`;
}

const plain = (title, lead, button) =>
  `<h1 class="e-title">${title}</h1><p class="e-lead">${lead}</p>${button ? `<div class="actions"><button type="button" class="b-wide">${button}</button></div>` : ''}`;

// --- the screen « Agents » (FRU-462), with a connection beside a key --------------------------------
function rail() {
  const nav = [
    t('Sites', 'Sites'),
    t('Notes', 'Notes'),
    t('Connectors', 'Connecteurs'),
    t('Members', 'Membres'),
    t('My account', 'Mon compte'),
  ]
    .map((w) => `<a href="#">${w}</a>`)
    .join('');
  return `<aside class="rail"><a href="#" class="ws"><span class="ws-i">A</span><span><b>Acme</b><small>${t('Cloud workspace', 'Workspace Cloud')}</small></span></a><nav>${nav}</nav></aside>`;
}

const ROWS = () => [
  {
    name: 'Claude',
    oauth: HOST,
    made: t('Oct 28', '28 oct.'),
    sites: ['shop.acme.dev', 'staging.acme.dev'],
    rights: t('Read and write', 'Lire et écrire'),
    last: t('2 min ago', 'il y a 2 min'),
    ends: t('Jan 26', '26 janv.'),
  },
  {
    name: 'CI of the website',
    made: t('Oct 12', '12 oct.'),
    sites: ['staging.acme.dev'],
    rights: t('Read', 'Lire'),
    last: t('Yesterday', 'Hier'),
    ends: t('Jan 10', '10 janv.'),
  },
];

function row(k, confirm) {
  const badge = k.oauth
    ? `<span class="chip">${t('OAuth · {host}', 'OAuth · {host}', { host: k.oauth })}</span>`
    : `<span class="chip">${t('Key', 'Clé')}</span>`;
  return `<li class="k-row">
    <div class="c-name"><b>${esc(k.name)}</b> ${badge}<small>${k.oauth ? t('Approved by {who} on {day}', 'Approuvé par {who} le {day}', { who: 'Léa', day: k.made }) : t('Made on {day}', 'Créée le {day}', { day: k.made })}</small></div>
    <div class="c-sites">${k.sites.map((s) => `<span class="host">${s}</span>`).join('')}</div>
    <div>${k.rights}</div>
    <div>${k.last}</div>
    <div>${k.ends}</div>
    <div class="c-actions"><button type="button" class="b-wide sm">${t('Writes', 'Écritures')}${icon.down}</button>${confirm ? '' : `<button type="button" class="b-ghost sm danger">${t('Revoke', 'Révoquer')}</button>`}</div>
    ${confirm ? `<div class="confirm"><p>${t('Revoke the connection of {host}? Its tokens stop at once; to connect again, the connector of {host} asks you again.', 'Révoquer la connexion de {host} ? Ses jetons s’arrêtent aussitôt ; pour se reconnecter, le connecteur de {host} vous redemande.', { host: k.oauth })}</p><div class="actions end"><button type="button" class="b-wide sm">${t('Cancel', 'Annuler')}</button><button type="button" class="b-danger">${t('Revoke', 'Révoquer')}</button></div></div>` : ''}
  </li>`;
}

function agents(confirm = false) {
  const rows = ROWS();
  return `<div class="app">${rail()}<div class="main-wrap"><main>
    <nav class="crumbs"><a href="#">${t('Workspace settings', 'Paramètres du workspace')}</a><span aria-hidden="true">›</span><span>${t('Agents', 'Agents')}</span></nav>
    <header class="pg-head"><div><h1>${t('Agents', 'Agents')}</h1><p class="lead">${t('The keys of your agents, and the apps you connected with OAuth, such as a connector of claude.ai. Each one reads only the sites it names.', 'Les clés de vos agents, et les applications connectées par OAuth, comme un connecteur de claude.ai. Chacune ne lit que les sites qu’elle nomme.')}</p></div><button type="button" class="b-accent">${t('New key', 'Nouvelle clé')}</button></header>
    <div class="k-head"><span>${t('Name', 'Nom')}</span><span>${t('Sites', 'Sites')}</span><span>${t('Can', 'Peut')}</span><span>${t('Last used', 'Dernier usage')}</span><span>${t('Ends', 'Fin')}</span><span></span></div>
    <ul class="k-list">${row(rows[0], confirm)}${row(rows[1], false)}</ul>
    <p class="foot">${t('An app connected with OAuth has no key to copy: it gets short tokens, which it renews. Revoke it here.', 'Une application connectée par OAuth n’a pas de clé à copier : elle reçoit des jetons courts, qu’elle renouvelle. Révoquez-la ici.')}</p>
  </main></div></div>`;
}

// --- the frames -------------------------------------------------------------------------------------
const frames = [];
const frame = (id, width, title, notes, build) => frames.push({ id, width, title, notes, build });
frame(
  'a',
  1440,
  'A · The question: an owner or an admin approves claude.ai',
  [
    'A page of the console outside a workspace, at /authorize/<request>, as « Connect this browser » (FRU-240): the worker sent the browser here from /oauth/authorize, once the client, its redirect_uri and its PKCE challenge were checked.',
    'Who asks is said by the host of its redirect_uri, in large: claude.ai. The name the client gave itself at its registration is drawn small and said to be its own words: anybody can register a client named « Claude ».',
    'The choices are those of a key (FRU-461): one workspace, its sites, Read or Read and write, the days, « Only the notes of a known person » on by default. The workspaces listed are those where the person is an owner or an admin (decision 5 of agents.md).',
    '« Allow » makes the connection: an agent key with no secret, tied to the client. The browser goes back to the redirect_uri with a code of one use, the state, and iss.',
  ],
  () => entry(1440, consent()),
);
frame(
  'b',
  1440,
  'B · The client asked to read only; no site ticked',
  [
    'A scope of read gives no « Read and write »: the consent never gives more than the client asked.',
    'No site ticked: « Allow » sends nothing, and the field says why.',
  ],
  () => entry(1440, consent({ write: false, error: t('Tick at least one site.', 'Cochez au moins un site.') })),
);
frame(
  'c',
  1440,
  'C · Signed out',
  ['The sign-in of the console, then back to the question, never to the answer: the same rule as /connect.'],
  () =>
    entry(
      1440,
      `<h1 class="e-title">${t('Connect an agent', 'Connecter un agent')}</h1><p class="e-lead">${t('Sign in to Fruitback to answer {host}.', 'Connectez-vous à Fruitback pour répondre à {host}.', { host: `<b>${HOST}</b>` })}</p>
      <div class="field"><label for="em">${t('Work email', 'E-mail professionnel')}</label><input id="em" inputmode="email" value=""></div>
      <div class="actions stack"><button type="button" class="b-accent">${t('Email me a link', 'Recevoir un lien')}</button><button type="button" class="b-wide">${t('Continue with Google', 'Continuer avec Google')}</button></div>`,
    ),
);
frame(
  'd',
  1440,
  'D · No workspace the person manages',
  [
    'A member or a guest cannot connect an agent: they read the sentence, and « Deny » sends the client back with access_denied.',
  ],
  () =>
    entry(
      1440,
      `<h1 class="e-title">${t('Connect an agent', 'Connecter un agent')}</h1>${asker()}${who()}<div class="callout">${icon.warn}<p>${t('Only an owner or an admin of a workspace can connect an agent. Ask one of them to connect it.', 'Seul un propriétaire ou un admin d’un workspace peut connecter un agent. Demandez-le à l’un d’eux.')}</p></div><div class="actions"><button type="button" class="b-wide">${t('Deny', 'Refuser')}</button></div>`,
    ),
);
frame(
  'e',
  1440,
  'E · A request that no longer works',
  ['A request lives 10 minutes and is answered once. Unknown, expired or answered: the same page.'],
  () =>
    entry(
      1440,
      plain(
        t('This request no longer works', 'Cette demande ne fonctionne plus'),
        t(
          'A request works for ten minutes, and is answered once. Start again from the app that asked.',
          'Une demande fonctionne dix minutes, et reçoit une seule réponse. Recommencez depuis l’application qui l’a faite.',
        ),
        t('Go to the console', 'Aller à la console'),
      ),
    ),
);
frame(
  'f',
  1440,
  'F · Allowed: back to the app',
  ['The page says where the browser goes, then goes. Nothing of the code is shown.'],
  () =>
    entry(
      1440,
      `<h1 class="e-title">${t('{host} is connected', '{host} est connecté', { host: HOST })}</h1><p class="e-lead">${t('Going back to {host}…', 'Retour à {host}…', { host: `<b>${HOST}</b>` })}</p><p class="hint">${t('It reads {sites} of Acme until {day}. Revoke it in Workspace settings › Agents.', 'Il lit {sites} d’Acme jusqu’au {day}. Révoquez-le dans Paramètres du workspace › Agents.', { sites: 'shop.acme.dev, staging.acme.dev', day: t('Jan 26', '26 janv.') })}</p>`,
    ),
);
frame(
  'g',
  1440,
  'G · « Agents »: a connection beside a key',
  [
    'A connection is a row of the same list (it is an agent key with no secret): a chip « OAuth · claude.ai » in place of « Key », who approved it, its sites, its rights, its last use and its end, its writes.',
    'It counts in the 20 keys of a workspace.',
  ],
  () => agents(),
);
frame(
  'h',
  1440,
  'H · Revoke a connection',
  [
    'Asked a second time in the row, as a key. Revoked, its access and refresh tokens are deleted with it, and /mcp answers 401 to its next request.',
  ],
  () => agents(true),
);
frame('i', 390, 'I · 390 px, French: the question', [], () => entry(390, consent()));
frame('j', 390, 'J · 390 px, French: the list', [], () => agents());

const rendered = frames.map((f) => {
  lang = f.width < 900 ? 'fr' : 'en';
  const inner = f.build();
  lang = 'en';
  return `<section class="frame" id="${f.id}">
  <h2 class="f-title">${esc(f.title)}</h2>
  ${f.notes.length ? `<ul class="notes">${f.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  <div class="f-box w${f.width}" style="width:${f.width}px;position:relative">${inner}</div>
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
.entry{background:#fff;min-height:900px}
.e-head{padding:20px 32px;border-bottom:1px solid var(--line)}
.logo{font-weight:700;font-size:18px;letter-spacing:-.01em}
.e-main{display:flex;justify-content:center;padding:48px 16px 72px}
.e-col{width:440px;max-width:100%}
.e-title{margin:0 0 10px;font-size:28px;line-height:1.15;letter-spacing:-.02em}
.e-lead{margin:0 0 16px;font-size:16px;line-height:1.5;color:var(--ink-soft)}
.asker{display:flex;flex-direction:column;gap:2px;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--subtle);margin:0 0 14px}
.a-host{font-size:18px;font-weight:700}
.a-name{font-size:13px;color:var(--muted)}
.who{font-size:14px;color:var(--ink-soft);margin:0 0 22px}
.who a{color:var(--ink);font-weight:600}
.select{display:flex;justify-content:space-between;align-items:center;height:44px;border:1px solid var(--control);border-radius:8px;padding:0 12px;font-size:15px}
.field input[inputmode="email"]{height:44px;width:100%;border:1px solid var(--control);border-radius:8px;padding:0 12px;font:inherit}
.field label.radio,.field label.check{display:flex;font-weight:400}
.actions.stack{flex-direction:column;align-items:stretch}
.actions.stack button{justify-content:center}
.foot code{font-size:12px}
.w390 .e-head{padding:14px 16px}.w390 .e-main{padding:24px 16px 48px}
.w390 .app{flex-direction:column}
.w390 .rail{flex:none;padding:10px 12px;gap:6px}
.w390 .rail nav{flex-direction:row;overflow:hidden}
.w390 main{padding:20px 16px 48px}
.w390 .k-head{display:none}
.w390 .k-row{grid-template-columns:1fr;gap:6px;padding:16px}
.w390 .c-actions{justify-content:flex-start}
.w390 .pg-head .b-accent{width:100%;justify-content:center}
.c-name .chip{margin-left:6px}
`;
const toc = frames.map((f) => `<a href="#${f.id}">${esc(f.title)}</a>`).join('');
const out = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fruitback, OAuth for MCP (FRU-467)</title>
<style>${css}${extra}</style>
</head>
<body>
<header class="board-head">
  <h1>An app connects to the MCP server with OAuth (FRU-467)</h1>
  <p>Board of the consent page of the console and of the connections in « Agents » (agents.md, v2). A connector of claude.ai finds the server of authorization of the worker, registers, sends the person here, and gets short tokens for <code>/mcp</code>. The person chooses the workspace, the sites and the rights, as for an agent key, and revokes the connection in « Agents ». Frames at 1440 px are in English, at 390 px in French; every sentence of both is in the table at the end.</p>
  <p>Generated by <code>tools/build.mjs</code>: edit the script, not this file. A frame is a picture: its buttons do nothing.</p>
</header>
<nav class="toc" aria-label="Frames">${toc}<a href="#decisions">Decisions</a><a href="#texts">Texts, EN and FR</a></nav>
${rendered.join('\n')}
<section class="frame" id="decisions"><h2 class="f-title">Decisions of the board (fru-mcp-oauth, 2026-10-28)</h2>
<p class="notes">The orchestrator asked the agent to decide the choices itself and to write them down. Each one can be changed by Mathieu. The decisions of the worker are in docs/decisions/agents.md and SECURITY.md.</p>
<ol class="qa">
<li><b>Where.</b> A page outside a workspace, <code>/authorize/&lt;request&gt;</code>, as <code>/connect/&lt;request&gt;</code>: the person may not have chosen a workspace yet, and the page chooses one.</li>
<li><b>Who asks is the host of its redirect_uri</b>, the one thing a client cannot choose freely: the code goes there. Its name is its own words, drawn small.</li>
<li><b>The choices of a key, with the same defaults</b>: 90 days, « Only the notes of a known person » on. One workspace per connection: to reach two, connect twice.</li>
<li><b>Never more than asked.</b> A client that asked <code>read</code> is not offered « Read and write ». A client that asked nothing is offered both, Read checked.</li>
<li><b>Who approves:</b> an owner or an admin (<code>manage-workspace</code>), as for a key. The others read why, and can deny.</li>
<li><b>In « Agents », a connection is a row of the list</b> with a chip, no secret, and the same « Writes » and « Revoke ». A new list would be a second place to look for what reads the notes.</li>
<li><b>Deny</b> sends the client back with <code>error=access_denied</code>; closing the tab leaves the request to end in 10 minutes.</li>
</ol></section>
<section class="frame" id="texts"><h2 class="f-title">Texts, EN and FR</h2>
<table class="texts"><thead><tr><th>English</th><th>Français</th></tr></thead><tbody>${table}</tbody></table>
</section>
</body>
</html>
`;
writeFileSync(join(here, '..', 'mcp-oauth.html'), out);
console.log(`mcp-oauth.html: ${frames.length} frames, ${texts.size} texts`);
