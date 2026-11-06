# Agents: an AI agent reads the notes, replies and sets a status

FRU-110 asks that a team can hand its notes to an AI agent. This page is the framing, written before
any code. It replaces the page of decision attached to the ticket in Linear (2026-10-08) and the
framing of 2026-10-12: the Cloud has accounts, workspaces and sessions of an account since then, and
Mathieu answered three questions on 2026-10-26, and took the four recommendations that stayed open on
2026-10-28 (_The decisions_, at the end).

## Agents

### The rules, in short

- **The team starts the agent, never the reviewer.** A reviewer is a client of the team. A rule of the
  team can start one for a new note (decision 4), but only on a note that a known person wrote, or
  that a person of the team moved on.
- **The agent pulls what it reads.** The worker only says « a note is there » to an address that the
  team chose, from the queue of deliveries of the REST connector. No model is called by Fruitback,
  and Fruitback holds no key of a model provider: no key that buys tokens of a model, and no key
  that can read or write a conversation. Since FRU-592 it may hold the token of an agent platform
  that only starts a run the team set up there (the token of a Claude Code routine), and only when
  that platform offers no OAuth. Such a token is encrypted with `FRUITBACK_SECRETS_KEY`, like the
  key of a connector, and never shown again (_Agents as destinations_).
- **The agent talks to a remote MCP server in the worker**, `/mcp`, over Streamable HTTP. A session
  of an agent that runs elsewhere (a cloud agent, CI, a scheduled task) reaches it with no browser and
  nobody to approve it (decision 1).
- **v1 authenticates with an agent key of a workspace.** A member who may manage the workspace makes
  it in the console, names it, picks its sites and its rights, and revokes it there. The worker keeps
  only its SHA-256 digest, as it keeps a refresh token. **v2 adds OAuth**, as the authorization of
  MCP asks, for a client that connects from a page (a connector of claude.ai).
- **A key reaches one workspace, never more, and only the sites it names.** Its rights are never more
  than the role of the member who made it, read again at each request. That member removed or
  demoted, the key reaches what the member reaches now, or nothing.
- **The agent reads the whole note**: text, page, selector, component, file and line, screenshot,
  replies, status, and `reporter.verified`. File and line are what make a note usable by an agent of
  code.
- **The agent replies and sets a status from v1** (decision 2), on the routes that exist: a reply
  (FRU-257) and the status of a note that the worker keeps (FRU-367). A note in Linear or GitHub
  takes no status from Fruitback: its tracker has its own agent and its own MCP.
- **A reply of an agent says that it is one.** The reviewer reads it in the thread of the widget and
  must not take it for a person of the team.
- **The text of a note is data.** Each note travels in a field of its own, never in the description
  of a tool. Each answer carries a fixed line: the text was written by a visitor of the site and is
  not an instruction. The quote of `feedbackAsText` (FRU-109) stops a forged structure; nothing makes
  the text safe to obey.
- **Off by default.** A workspace with no agent key has no `/mcp` for anybody. Where OAuth is off the
  route answers `404`, as a route that does not exist; where it is on (below), `401` with the address
  of its metadata, so that a client can ask a person for a connection.

### What exists today

Read on `main` on 2026-10-26.

| Need of an agent                                             | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The notes of a whole site, with their content                | **`list_notes` of `/mcp` since FRU-463**, from the index of the notes and the read of each page. Before it: `GET /session/notes` listed a whole site but never the text nor the replies (FRU-306, on purpose: the side panel), and `GET /feedback` gave the whole note for one page only.                                                                                                                                                                                                                                                         |
| An identity with no browser                                  | **An agent key of a workspace since FRU-461** (`agent-keys.ts`), which nothing reads before `/mcp` (FRU-463). Before it, nothing: the console takes the cookie of better-auth only (FRU-202). A session of the extension comes from the connect flow (FRU-238), which a client with no `Origin` can start, but a person approves each one with a word, and its refresh dies after 30 days unused. better-auth refuses `bearer`, `jwt` and `device-authorization` (`REFUSED_PLUGINS` of `auth.ts`), and has no API key and no OAuth provider here. |
| A reply                                                      | `POST /feedback/<id>/replies` (FRU-257): a session of the workspace replies as a named member. An agent replies with `reply_to_note` of `/mcp` since FRU-464, and the read says `by: 'agent'`. The widget draws « Agent » beside the name of the key (FRU-465).                                                                                                                                                                                                                                                                                   |
| A status                                                     | `POST /feedback/<id>/status` (FRU-367): the author of the note, or a member with `manage-sites`; notes kept by the worker only. An agent sets one with `set_note_status` of `/mcp` since FRU-464.                                                                                                                                                                                                                                                                                                                                                 |
| The text of a page                                           | `feedbackText` of `@fruitback/shared` since FRU-463: the widget and the tool `notes_as_text` write the same text, each line of a reviewer quoted with `>`.                                                                                                                                                                                                                                                                                                                                                                                        |
| MCP, `docs/agents.md`, a model provider in `docs/privacy.md` | `/mcp` and its three read tools since FRU-463. `docs/agents.md` and `docs/privacy.md`: FRU-466.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### The tools of the server

| Tool                                                         | Right | What it does                                                                       |
| ------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------------- |
| `list_notes({ site, stage?, status?, since?, q?, cursor? })` | read  | The notes of a site, newest first, each with its whole content. `since` is a date. |
| `get_note({ id })`                                           | read  | One note, its replies and its status.                                              |
| `notes_as_text({ site, page? })`                             | read  | The text of FRU-109, for a site or one page.                                       |
| `reply_to_note({ id, body })`                                | write | A reply in the thread, said to be from an agent.                                   |
| `set_note_status({ id, status })`                            | write | A status of the site, for a note that the worker keeps.                            |

A key with the right `read` only gets the first three: a write tool is not listed to it, and is
refused if called.

A store that does not answer during a call, the accounts that read its site included, fails that
call only: the tool answers `isError: true` with « The store of the notes did not answer », and the
request stays `200` (FRU-524). An agent tries the call again; the other calls of its session stand.

### Injection, with write tools

A note is text that anybody writes on a site that reads `public`. An agent that obeys it can now write
back in Fruitback, and maybe in a repository. What the worker does:

- the fixed line and the field of its own, above;
- `reporter.verified` with each note, and a filter `verified_only`;
- the right `write` given per key, and the sites per key;
- a limit per key, as per address (`RATE_LIMIT_PER_MINUTE`);
- every write of an agent written down, with its key, and shown in the console beside the key;
- a reply that says it is from an agent, and a status that the team can set back.

What the worker cannot do, and `docs/agents.md` says plainly: stop an agent from obeying. The
advice: an agent that reads notes does not push code with no review by a person, and a key with
`write` on a site that reads `public` is a choice made knowing it.

### Privacy

A note of a client then goes to the provider of the team's model. `docs/privacy.md` says it, and the
template of the notice that an integrator publishes gains a sentence for it. The integrator decides:
with no key, nothing leaves.

### What was set aside

- **A button « send to the AI » in the widget.** It puts a key of a model, or the address of an
  agent, in the page of a client.
- **A webhook of its own for the agents.** The trigger reuses the queue of deliveries of the REST
  connector (FRU-132), which already signs, tries again and says what failed: no second queue.
- **Fruitback calling a model itself.** One more key to hold, a bill, and one more processor in the
  notice of every integrator.
- **A local MCP package in stdio, on the connect flow.** It reuses the session of a person, but a
  person approves each session with a word: no session can start elsewhere with nobody there.
- **Only the agent of the tracker.** It works today with Linear and GitHub, but a note that the worker
  keeps has no tracker, and a tracker does not give the note whole.

## Starting an agent on a note

### The rules, in short

- **A trigger of a site, made in the console, calls an address that the team gives** when a note
  arrives. The address starts the agent: a `repository_dispatch` of GitHub that runs Claude Code, a
  cloud agent, a receiver of the team. The agent then reads the note by `/mcp`, with its key.
- **The call is a delivery of the REST connector** (`docs/rest-connector.md`): signed, tried again,
  shown in the console when it fails. It carries the id of the note and its site, not its text: the
  agent reads the text by `/mcp`, so a key decides what it reads, and nothing leaves twice.
- **Guard 1, by default: a verified note only.** A note of a member or of a reviewer who signed in
  starts the agent. A note of a visitor on a site that reads `public` does not: anybody writes it. The
  other choice of the team is « when a person of the team moves the note to To do ».
- **Guard 2, written in `docs/agents.md`: the agent opens a pull request for review**, and never
  pushes to a branch that deploys. Fruitback cannot hold that rule: the agent and its rights are the
  team's. The worker can, and does, keep the key of the agent to the notes of its sites.
- **Off by default**, like a key: a site with no trigger calls nothing.

### What exists today

- **A trigger of a site since FRU-468** (`agent-triggers.ts`): off by default, set on the page of
  the site by the owner and the admins. It names a `rest` connector of the workspace and a moment
  (`verified-note` or `moved-to-todo`), and queues `agent.requested` with ids only on that
  connector's queue. The column `deliveries.event` keeps it apart from a note's own delivery: the
  list of the notes and the count of a site read `note.created` only. GitHub: the team's receiver
  calls `repository_dispatch` with its own token (`docs/agents.md`); Fruitback holds none.
- The REST connector (FRU-132) posts `note.created`, signed, with the whole note, to the address of a
  workspace. A receiver of the team can start an agent with it today, with no other change.
- The GitHub connector makes an issue of a note: a workflow `on: issues: opened` can run Claude Code
  on it today. The Linear connector makes a ticket that a team can give to an agent of Linear.

## OAuth for MCP (v2, FRU-467)

### The rules, in short

- **A client that connects from a page gets a token by OAuth 2.1**, as the authorization of MCP
  (2025-06-18) asks: a connector of claude.ai, or any MCP client that speaks it. An agent key stays
  the way for an agent with no browser, and keeps working beside it.
- **A connection is an agent key with no secret**, tied to its client (`agent_keys.client_id`). The
  person chooses on the consent page what a key names: one workspace, its sites, `read` or `write`,
  the days (90 by default, 365 at most), `verifiedOnly` on by default. The same member read again at
  each request, the same log of writes, the same limit of 20, the same « Revoke » in « Agents ». There
  is one model of rights, not two.
- **Our own server, in `oauth.ts`, and no plugin of better-auth.**
- **Discovery by the two documents of `/.well-known`**, and `401` with `WWW-Authenticate` at `/mcp`.
- **Open registration (RFC 7591), bounded**; no « Client ID Metadata Document ».
- **PKCE S256 always, a `redirect_uri` compared byte for byte, `iss` in every answer.**
- **Opaque tokens, kept as digests**: access one hour, refresh 30 days, spent once and replaced. A
  spent refresh token presented again revokes the connection.
- **Who approves: the owner and the admins**, as for a key (decision 5).
- **On when the worker has accounts, `FRUITBACK_PUBLIC_URL` with no path and
  `FRUITBACK_CONSOLE_URL`.** No variable of its own.

`SECURITY.md`, « OAuth for `/mcp` », holds the threats and the test of each.

### The choices, and why (fru-mcp-oauth, 2026-10-28)

The orchestrator asked the agent to decide the open choices, with the simplest one that is safe, and
to write each reason. Mathieu can change each.

1. **Our own server rather than better-auth.** better-auth 1.7.12 ships no `mcp` nor `oidc-provider`
   plugin any more; its `@better-auth/oauth-provider` is a package of its own, which signs its tokens
   with the `jwt` plugin, refused here (`REFUSED_PLUGINS`: a second way to verify a token). It also
   grants to an account, when `/mcp` reasons with a key of a workspace. The server here is one file of
   the worker, on the tables and the `Kv` it has, and turns a consent into a key.
2. **A connection is a key.** The rights, the sites, the end, the log and the revocation of a key
   were decided and tested in FRU-461 to FRU-464. A second kind of grant would have to repeat each,
   and the console would have two lists to read.
3. **Registration by RFC 7591, open.** claude.ai registers itself, and the version 2025-06-18 of MCP
   asks for it. The « Client ID Metadata Document » of 2025-11-25 has the worker fetch an address
   that a client names: a request forged on the server, for no gain while claude.ai registers.
4. **One host per client.** The consent page names a client by the host its codes go to; a client
   with two hosts would have two names.
5. **The three ways to authenticate a client** (`none`, `client_secret_post`, `client_secret_basic`):
   RFC 7591 makes `client_secret_basic` the default, and a client that asks for a secret expects one.
   PKCE holds for all three.
6. **The tokens are opaque, not JWT.** The worker is the one reader of its tokens, and a digest in a
   table is revoked by deleting a row; a JWT would need a key, a second check, and a list of the
   revoked ones.
7. **One hour, 30 days, rotation, and a replay that revokes**: the values of OAuth 2.1 for a public
   client. A connector that refreshes twice at once loses its connection, and asks the person again:
   the cost of telling a thief from a client.
8. **The consent page is a page of the console, `/authorize/<request>`**, outside a workspace, as
   « Connect this browser » (FRU-240): the person may not have chosen a workspace yet, and the page
   chooses one. Its board is `design/mcp-oauth/`.
9. **Never more than asked.** A client that asked the scope `read` is not offered `write`; one that
   asked none is offered both, with `read` chosen.
10. **The request waits in the `Kv`** (10 minutes), and so does the code (60 seconds): both are short,
    and the `Kv` is in the database, shared by the replicas. The connection is written at the
    approval, so that a refusal (a site gone, 20 keys) is said on the page, and not to the client.
11. **`401` in place of `404`.** A client of OAuth starts on a `401` that names the metadata; the
    metadata says that `/mcp` exists anyway. A key that is refused reads `401` too.

### What is not proved here

The real connector of claude.ai needs a worker that claude.ai reaches, in `https`, with its database
and its console: an environment of Mathieu. The tests play every step of the protocol through the
worker, and the board and the specs of the console play the page.

## Agents as destinations (FRU-592)

### The rules, in short

- **A recipe sends notes to an agent as a connector sends them to a tracker.** In « Add a
  destination » of the console, a recipe is a guided way to an agent of the market. With code, it
  is a connector whose delivery calls the API of the platform. Without code, it is a page that
  says how to chain a connector that exists to an agent of the team.
- **The flow.** A note arrives on a site whose trigger (FRU-468) names a recipe connector, at the
  moment the team chose (`verified-note` or `moved-to-todo`). The worker queues `agent.requested`
  on that connector's queue. The delivery is a call to the API of the platform: for a routine,
  `POST /fire`. The platform starts a run of the agent the team set up there. The agent reads the
  note by `/mcp`, with its own access: the MCP connector of claude.ai (OAuth, FRU-467) or an agent
  key the team put in the platform's settings. Then it replies, sets a status and opens a pull
  request for review (guard 2). Fruitback still calls no model.
- **The call carries identifiers only**: the ids of the notes, the site, and the address of `/mcp`.
  Never the text of a note. The text goes through `/mcp`, so the key decides what the agent reads,
  `verifiedOnly` applies, and each read is in the log.
- **One call for each send, not for each note.** A send of several notes together (FRU-124) starts
  one run, and its call lists their ids. `requestAgent` (FRU-468), which queues one delivery for
  each note today, changes with the first recipe.
- **A secret of a platform: OAuth when the platform offers it, an encrypted token otherwise.** The
  token is the fallback. It is kept as the keys of the connectors are, encrypted with
  `FRUITBACK_SECRETS_KEY`, sent only to the one host of its platform, and never returned to the
  console. A `401` from the platform puts the connector in « attention », as a refused key does.
- **No `/mcp` key is sent to a platform in v1.** The team sets the Fruitback MCP up on the side of
  the agent, as it does for a routine. For Cursor (v2), Mathieu chose a key for one run: the worker
  makes it at the call, keeps only its digest, limits it to the notes of the call and to one hour at
  most, and sends it in `mcpServers`. FRU-596 holds it, and `SECURITY.md` gains it with its code.
- **What the console shows after the call: the URL of the session** that the platform returns, on
  the row of the delivery (v1). The thread of the widget says « An agent is working on this note »
  to everybody, with the link for a member of the team only. The link opens a session of the team
  that a reviewer cannot open. FRU-594 holds it, and the member-only link is still to be confirmed.
- **The order of the recipes**: v1, the Claude Code routine with code, and Linear and GitHub Actions
  with no code; v2, Cursor; later, GitHub Copilot and Devin.

### The platforms (measured on 2026-11-06 against their documentation)

| Platform                               | Start                                                                                                                                                                                                       | What it gives                                                                                                                                                                                                                                                                                 | Limits                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code scheduled tasks (routines) | `POST https://api.anthropic.com/v1/claude_code/routines/<trig_id>/fire`, `Authorization: Bearer`, `anthropic-beta: experimental-cc-routine-2026-04-01`, `anthropic-version: 2023-06-01`, an optional `text` | The answer gives `claude_code_session_id` and `claude_code_session_url`. `text` arrives wrapped in `<routine-fire-payload>`, labelled as untrusted data, and is followed only if the saved prompt says so. The token starts that task only, is shown once, and can be regenerated or deleted. | Research preview. The beta header is dated; the two previous versions keep working. The API trigger is set at claude.ai/code/routines, and `/fire` is for claude.ai users only. Plans Pro, Max, Ultra, Team and Enterprise. 30 fires an hour per task (shared with « Run now »), 100 API fires an hour per account. |
| Cursor Cloud Agents                    | `POST https://api.cursor.com/v1/agents`, Basic or Bearer, with `prompt.text`, `repos[]` (`url`, `startingRef`), `autoCreatePR`, `mcpServers`                                                                | `mcpServers` takes up to 50 servers, a remote one with `url` and `headers` or OAuth `auth`.                                                                                                                                                                                                   | Public beta: the API may change before GA. No webhook at the end in v1 (« coming soon »): a run is read with `GET /v1/agents/{id}/runs/{runId}`, or its SSE stream.                                                                                                                                                 |
| GitHub Copilot cloud agent             | `POST /agents/repos/{owner}/{repo}/tasks`, with `prompt`, `base_ref`, `model`, `create_pull_request`                                                                                                        | The GitHub connector already makes the issue.                                                                                                                                                                                                                                                 | Public preview. User-to-server tokens only: a token of an installation of a GitHub App is refused, so a token of a person would be needed.                                                                                                                                                                          |
| Devin                                  | `POST https://api.devin.ai/v1/sessions`, Bearer (`apk_user_*` or `apk_*`), with `prompt`, `max_acu_limit`, `secret_ids`, and others                                                                         | A ceiling of cost per session.                                                                                                                                                                                                                                                                | Paid by use. The request takes no MCP server.                                                                                                                                                                                                                                                                       |
| Agents of Linear                       | Delegate the issue to an agent app: it becomes the `delegate`, not the `assignee`, and an Agent Session starts (`AgentSessionEvent` webhook)                                                                | Nothing to build: the Linear connector already made the ticket.                                                                                                                                                                                                                               | On the agent's side. The page read on 2026-11-06 does not state a stage; the ticket of 2026-11-05 said Developer Preview.                                                                                                                                                                                           |
| Codex cloud, Jules                     | No public API documented on 2026-11-05                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                             | Set aside, not measured again here.                                                                                                                                                                                                                                                                                 |

### Set aside

- **Fruitback calling a model, or holding a key that buys tokens of one.** Unchanged.
- **The text of a note in the call.** It would leave twice, past the key and past the log.
- **A `/mcp` key sent to a platform in v1** (above), and a key kept readable by the worker.
- **Polling the run of a platform with no webhook** (Cursor): the link of the run is enough.
- **Codex cloud and Jules** until they publish an API. **Copilot** until a token of a person is
  acceptable, **Devin** after Cursor.

### The decisions (2026-11-05 and 2026-11-06)

Mathieu answered on 2026-11-05, and the orchestrator took the five recommendations of the ticket on
2026-11-06 in his place:

1. **A secret of an agent platform in Fruitback: yes.** OAuth when the platform offers it. A token
   encrypted with `FRUITBACK_SECRETS_KEY` is the fallback, for a platform that offers nothing else,
   as the routine. The sentence of _Agents_ above says so.
2. **No `/mcp` key sent to a platform in v1.** For Cursor in v2: a key for one run (Mathieu's option
   C), as above.
3. **Identifiers only in the call.** The text goes through `/mcp`.
4. **The order:** v1 the routine (FRU-594), and Linear and GitHub Actions with no code (FRU-595);
   v2 Cursor (FRU-596); later Copilot (FRU-597) and Devin. The cards of the console: FRU-593.
5. **The URL of the session on the row of the delivery in v1**, and the line of the thread of the
   widget with FRU-594.

This section changes a rule of security of this page (decision 1): the PR that brings it is
critical, and Mathieu merges it.

## The decisions

On 2026-10-26 Mathieu answered:

1. **Sessions started elsewhere.** « Je veux qu'on puisse lancer des sessions à distance » : a remote
   MCP server with an agent key, then OAuth. Not a local package on the connect flow.
2. **Replies and statuses from v1**, not read only.
3. **This page and the tickets first**, no code in FRU-110.
4. **An agent can start when a note arrives** (« on pourra spawn un agent quand on fait une note ? » :
   yes), with the two guards of _Starting an agent on a note_.

On 2026-10-28 Mathieu took the four recommendations that this page left open:

5. **Who makes a key: the owner and the admins of the workspace** (`manage-workspace`). Not a member
   alone: a key reaches every note of its sites, past the person. FRU-461 holds it.
6. **A reply of an agent shows as one.** An optional field `by: 'agent'` on a reply
   (`noteCommentSchema`, `packages/shared`), which the widget draws as « Agent » beside the name of
   the key. Tolerant: a widget from before shows the name alone. The name of the member who made the
   key is not shown to the reviewer. FRU-464 and FRU-465.
7. **`verified_only` by default on a site that reads `public`.** The cost: an agent on such a site
   sees no note of a visitor until the team turns it off, knowing it. The switch is a field of the
   key (`verifiedOnly`, FRU-461), never an argument of a tool: the agent cannot turn it off. FRU-463
   applies it.
8. **A key lives 90 days by default.** Its creator chooses another number of days at its creation,
   365 at most, and no key lives with no end. The console warns 7 days before (FRU-462).

## The tickets

| Ticket                                                                                                                                                                                                 | Size |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| [Worker] An agent key of a workspace: table, migration, digest at rest, its sites and rights, its member read again at each request, made, listed and revoked by the API of the console; `SECURITY.md` | M    |
| [Console] « Agents » in the settings of a workspace: make a key (shown once), list, revoke, and the writes of each key; mockup first                                                                   | M    |
| [Worker] `/mcp`, Streamable HTTP: the three read tools, the notes of a site with their content and `since`, the fixed line, `verified_only`; a conformance case on each store                          | L    |
| [Worker][Shared] The write tools: a reply said to be from an agent (`by: 'agent'`, a changeset), a status, the limit per key, the writes written down                                                  | M    |
| [Widget] A reply of an agent shows as one                                                                                                                                                              | S    |
| [Docs] `docs/agents.md` (connect Claude Code and a cloud agent), `docs/privacy.md` and the notice, `SECURITY.md`                                                                                       | S    |
| [Worker][Console] A trigger of a site: on a verified note, or on « To do », a signed call to an address, on the queue of the REST connector; mockup first                                              | M    |
| v2 — [Worker] OAuth for MCP, for a connector of claude.ai                                                                                                                                              | L    |
