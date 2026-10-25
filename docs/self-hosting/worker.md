# Worker responses

A plain Node HTTP process — `node:http` adapted onto a web-standard handler, no framework.

| Route                            | Status                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /feedback`                 | plants a note in the configured store, answers `201` with the issue: `id`, `identifier`, and `url` when the store has a page to open |
| `GET /feedback?url=…[&client=…]` | the notes of that page: anchor, note, state, stage                                                                                   |
| `OPTIONS /feedback`              | CORS preflight, never reaches the store                                                                                              |
| `GET /health`                    | `200` when the configuration is valid, `503` naming what is wrong when it is not                                                     |

The four below are the browser extension's session (FRU-42), and they are **exempt from
`ALLOWED_ORIGINS`**: an extension's origin
carries an id that differs between an unpacked build and a store build, so an operator cannot put it
on a list. The rate limiter is what protects them, which is why it runs above the path dispatch.

| Route                   | Status                                                      |
| ----------------------- | ----------------------------------------------------------- |
| `POST /session/pair`    | spends a pairing code, opens a session                      |
| `POST /session/refresh` | a refresh token for a fresh access token                    |
| `POST /session/revoke`  | ends the session; `204` whether or not there was one to end |
| `GET /pair`             | the page a pairing link opens: static, no script            |

**A reviewer connects the extension from the console**: « Connect this browser », on « Put it on the
site » or on « Sites », opens the pairing link of your worker (on Fruitback Cloud the same button
leads to the sign-in of the popup instead, FRU-313, and its worker answers `404` on the pairing routes, FRU-325). An operator can also mint a pairing code on the container, never over HTTP,
for one workspace and one of its members (FRU-277). The workspace id is in the address of the console,
`/w/<id>/sites`, and the workspace must have a site. `--subject` is the id of the member's account,
which the database gives from their address:

```bash
docker compose exec -T postgres psql -U fruitback -d fruitback -Atc \
  "SELECT id FROM \"user\" WHERE email = 'alice@acme.dev'"
docker compose exec worker node server.mjs pair --subject <account id> --name "Alice Martin" --workspace <id>
```

With a [dedicated schema](database.md#in-a-database-you-already-run), add `SET search_path TO <schema>;` before the
`SELECT`. The command refuses, and prints no code, when the workspace is missing, when it has no site,
and when the account is not a member of it: the route would end such a session at once (FRU-149).

Add `--endpoint https://api.feedback.example.com`, the address reviewers reach this worker at, and the
command also prints a link, `https://api.feedback.example.com/pair#<code>`. The reviewer opens it and
clicks the extension: nothing to copy. The code is after the `#`, so it reaches no server and no access
log, yours included. An `http://` address is refused unless it is `localhost`. Measured: the command
writes a code valid 15 minutes. Not measured for this page: a session of that code reading a site.

**The two paragraphs below describe the `linear` store.** A worker on another store does the same job
by its own means — see `apps/worker/src/store.ts`, where `findForPage` states the intention and never
the method.

Labels are created on demand, so a new client site needs no manual Linear setup. A label that cannot
be created is dropped and the feedback still goes through — losing a label is a triage annoyance,
losing the client's note is a bug.

The read path is one Linear query, narrowed server-side by the `fruitback` label, the per-client
label and `description contains <canonical url>`. `contains` being a substring match, the note's own
`page.url` is re-checked exactly, or `/pricing` would return the pins of `/pricing?tab=annual`.
Answers are cached for 15 s: the same page opened by a room full of reviewers costs one call against
the Linear quota, and a failed call is never cached.
