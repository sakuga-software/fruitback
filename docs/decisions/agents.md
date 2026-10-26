# Agents: an AI agent reads the notes, replies and sets a status

FRU-110 asks that a team can hand its notes to an AI agent. This page is the framing, written before
any code. It replaces the page of decision attached to the ticket in Linear (2026-10-08) and the
framing of 2026-10-12: the Cloud has accounts, workspaces and sessions of an account since then, and
Mathieu answered three questions on 2026-10-26 (_The decisions_, at the end). Four questions stay
open (_What is still to decide_).

## Agents

### The rules, in short

- **The team starts the agent, never the reviewer and never a rule.** A reviewer is a client of the
  team: a note never leaves for an agent because somebody wrote it.
- **The agent pulls; the worker pushes nothing.** No webhook, no queue, no model called by
  Fruitback. Fruitback holds no key of a model provider and sends nothing by itself.
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
- **Off by default.** A workspace with no agent key has no `/mcp` for anybody: the route answers
  `404`, as a route that does not exist.

### What exists today

Read on `main` on 2026-10-26.

| Need of an agent                                             | Today                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The notes of a whole site, with their content                | **Missing.** `GET /session/notes` lists a whole site but never the text nor the replies (FRU-306, on purpose: the side panel). `GET /feedback` gives the whole note, but for one page. The console list (FRU-244) gives an excerpt of 64 characters. No read filters by date.                                                                                                                                                |
| An identity with no browser                                  | **Missing.** The console takes the cookie of better-auth only (FRU-202). A session of the extension comes from the connect flow (FRU-238), which a client with no `Origin` can start, but a person approves each one with a word, and its refresh dies after 30 days unused. better-auth refuses `bearer`, `jwt` and `device-authorization` (`REFUSED_PLUGINS` of `auth.ts`), and has no API key and no OAuth provider here. |
| A reply                                                      | `POST /feedback/<id>/replies` (FRU-257): a session of the workspace replies as a named member.                                                                                                                                                                                                                                                                                                                               |
| A status                                                     | `POST /feedback/<id>/status` (FRU-367): the author of the note, or a member with `manage-sites`; notes kept by the worker only.                                                                                                                                                                                                                                                                                              |
| The text of a page                                           | `feedbackAsText` (FRU-109), in the widget only: each line of a reviewer quoted with `>`.                                                                                                                                                                                                                                                                                                                                     |
| MCP, `docs/agents.md`, a model provider in `docs/privacy.md` | **None.**                                                                                                                                                                                                                                                                                                                                                                                                                    |

### The tools of the server

| Tool                                                            | Right | What it does                                                                       |
| --------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| `list_feedback({ site, stage?, status?, since?, q?, cursor? })` | read  | The notes of a site, newest first, each with its whole content. `since` is a date. |
| `get_feedback({ id })`                                          | read  | One note, its replies and its status.                                              |
| `feedback_as_text({ site, page? })`                             | read  | The text of FRU-109, for a site or one page.                                       |
| `reply_to_feedback({ id, body })`                               | write | A reply in the thread, said to be from an agent.                                   |
| `set_feedback_status({ id, status })`                           | write | A status of the site, for a note that the worker keeps.                            |

A key with the right `read` only gets the first three: a write tool is not listed to it, and is
refused if called.

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
- **A webhook from the worker.** Set aside for the same reason as for a status (FRU-87): one
  container, nothing that pushes.
- **Fruitback calling a model itself.** One more key to hold, a bill, and one more processor in the
  notice of every integrator.
- **A local MCP package in stdio, on the connect flow.** It reuses the session of a person, but a
  person approves each session with a word: no session can start elsewhere with nobody there.
- **Only the agent of the tracker.** It works today with Linear and GitHub, but a note that the worker
  keeps has no tracker, and a tracker does not give the note whole.

## The decisions

On 2026-10-26 Mathieu answered:

1. **Sessions started elsewhere.** « Je veux qu'on puisse lancer des sessions à distance » : a remote
   MCP server with an agent key, then OAuth. Not a local package on the connect flow.
2. **Replies and statuses from v1**, not read only.
3. **This page and the tickets first**, no code in FRU-110.

## What is still to decide

Each one has a recommendation; the tickets follow it until Mathieu says otherwise.

1. **Who makes a key.** Recommended: the owner and the admins of the workspace (`manage-workspace`).
   Not a member alone: a key reaches every note of its sites, past the person.
2. **How a reply of an agent shows.** Recommended: an optional field `by: 'agent'` on a reply
   (`noteCommentSchema`, `packages/shared`), which the widget draws as « Agent » beside the name of
   the key. Tolerant: a widget from before shows the name alone. The name of the member who made the
   key is not shown to the reviewer.
3. **`verified_only` by default on a site that reads `public`.** Recommended: yes. The cost: an
   agent on such a site sees no note of a visitor until the team turns it off, knowing it.
4. **How long a key lives.** Recommended: 90 days by default, a date chosen at creation, no key with
   no end, and the console warns 7 days before.

## The tickets

| Ticket                                                                                                                                                                                                 | Size |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| [Worker] An agent key of a workspace: table, migration, digest at rest, its sites and rights, its member read again at each request, made, listed and revoked by the API of the console; `SECURITY.md` | M    |
| [Console] « Agents » in the settings of a workspace: make a key (shown once), list, revoke, and the writes of each key; mockup first                                                                   | M    |
| [Worker] `/mcp`, Streamable HTTP: the three read tools, the notes of a site with their content and `since`, the fixed line, `verified_only`; a conformance case on each store                          | L    |
| [Worker][Shared] The write tools: a reply said to be from an agent (`by: 'agent'`, a changeset), a status, the limit per key, the writes written down                                                  | M    |
| [Widget] A reply of an agent shows as one                                                                                                                                                              | S    |
| [Docs] `docs/agents.md` (connect Claude Code and a cloud agent), `docs/privacy.md` and the notice, `SECURITY.md`                                                                                       | S    |
| v2 — [Worker] OAuth for MCP, for a connector of claude.ai                                                                                                                                              | L    |
