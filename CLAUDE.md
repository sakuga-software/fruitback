# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

**This file is loaded into every session; `docs/` is not.** So it holds only what an agent must know
before it writes a line, and that no lint rule and no test catches. **Before you change an area, read
its page in [docs/decisions/](docs/decisions/)** — the table below says which. A new rule goes to a
lint rule or a guard test first, then to a decisions page, and here last, as one line:
`claude-md.test.ts` holds this file to its budget.

## Project

Fruitback is a visual feedback widget: a client clicks an element on their staging site, writes a
note, and it becomes an issue carrying the CSS selector, the React component and the source file.
Coming back to the page, they see their pins again, coloured by that issue's status.

- **Three products share one core** ([docs/modes.md](docs/modes.md)): **public** (the site embeds the
  widget), **private** (the extension mounts it for one reviewer), **team** (the site embeds a dormant
  widget the extension wakes and relays for). It is not a third code path: `packages/widget` does not
  know which mode it is in, and what differs lives in the assembly layer.
- **Status, threads, assignees and history belong to the store** (Linear, GitHub or SQLite, by
  `FRUITBACK_STORE`), never to a second model kept in step with it.
- **Deployment is one Docker container on a VPS, driven by Dokploy** — no Cloudflare, no serverless, no
  managed primitive. The runbook of Fruitback Cloud is `apps/worker/cloud/README.md`.

## Commands

Package manager is `pnpm@11.16.0` (pinned). Nx runs multi-project targets.

```bash
pnpm install
pnpm dev                                    # worker (in-memory Linear) + playground, see below
pnpm test                                   # nx run-many -t test → node --test
pnpm e2e                                    # playwright, starts both servers itself
pnpm typecheck
pnpm lint                                   # oxlint
pnpm format:fix                             # oxfmt

pnpm --filter @fruitback/shared test         # one package
pnpm --filter @fruitback/shared test:watch
node --test src/seed.test.ts                 # one file, from the package directory
```

## Layout

- `packages/shared` — the seed contract. Browser- and server-safe. Treat a change as breaking.
- `packages/widget` — the browser half, and the whole of it. `public.ts` is the published contract.
- `packages/fruitback`, `packages/element`, `packages/react` — the front door, the custom element and
  the React component. Each wraps or re-exports, and defines nothing of the contract.
- `apps/worker` — the Node service (`POST /feedback`, `GET /feedback?url=…`), and the home of the
  guard tests that read the root: docs, workflows, compose.
- `apps/extension` — the browser extension: the private and the team mode.
- `apps/console` — the console of the Cloud: a React Router SPA that holds no secret.
- `apps/playground` — the dev loop and the public demonstration. Scaffolding, not the product: grow a
  feature in `packages/widget`.
- `design/` — the reference mockups. Build a screen that has a board to its board.
- `e2e/` — Playwright, for what happy-dom cannot vouch for: a real selector engine and real layout.

## The dev loop

**`pnpm dev` starts both halves. The ports are fixed, and these are them:**

|                         |                                                  |
| ----------------------- | ------------------------------------------------ |
| `http://localhost:5177` | the playground page, the dev server `/tf` opens  |
| `http://localhost:8788` | the worker, on its in-memory Linear (not a mock) |
| `http://localhost:8789` | a second worker, during `pnpm e2e` only          |

`/tf` and `/tfp` read these numbers from here rather than probing. **Stop `pnpm dev` before
`pnpm e2e`**: the suite never reuses a worker already on its port.

## Before you touch an area, read its page

| You are about to change                                     | Read first                                                |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| what the project is, a package's role                       | [project.md](docs/decisions/project.md)                   |
| `packages/shared`, a field of the seed                      | [contract.md](docs/decisions/contract.md)                 |
| `packages/widget`                                           | [widget.md](docs/decisions/widget.md)                     |
| an icon, a glyph, anything that looks like an emoji         | [icons.md](docs/decisions/icons.md)                       |
| a `package.json` of a published package, a licence          | [packaging.md](docs/decisions/packaging.md)               |
| `apps/extension`                                            | [extension.md](docs/decisions/extension.md)               |
| `apps/worker`: a route, a store, identity, a session        | [worker.md](docs/decisions/worker.md)                     |
| `apps/console`                                              | [console.md](docs/decisions/console.md)                   |
| the Dockerfile, a workflow, `docker-compose.yml`, the guide | [image.md](docs/decisions/image.md)                       |
| `apps/playground`, a spec in `e2e/`                         | [dev-loop.md](docs/decisions/dev-loop.md)                 |
| Nx, formatting, a guard test, a document                    | [conventions.md](docs/decisions/conventions.md)           |
| a claim about what is protected                             | [SECURITY.md](SECURITY.md), [privacy.md](docs/privacy.md) |

Each page opens its sections with **the rules, in short**, then gives the reasons and the
measurements. A rule that looks arbitrary has its reason there: read it before you reason past it.

## What breaks in silence

No lint rule and no test catches these. Each is one line; the page above has the rest.

**Everywhere**

- **Measure, then write.** A claim about a browser, a proxy or a tracker that nobody measured is the
  repository's recurring defect. `curl` does not enforce CORS, and automation cannot answer a
  permission prompt or click the toolbar icon.
- **A statement of what is protected names its condition.** `clientId` is not authentication, `/health`
  is not proof the worker can serve, the team mode protects a read only on `read: 'authenticated'`,
  and rotation detects a copied token without capping its life. Each overclaim has shipped once.
- **A change to the threat model lands in [SECURITY.md](SECURITY.md) in the same commit**: a new
  route, a new thing stored in the clear, a guarantee tightened or dropped. Its numbers are tested;
  its properties are a hand edit.

**The widget**

- **Losing what someone just wrote is the one failure it cannot afford.** No error path clears the
  field. A second mount, a `render()` where a `resolve()` was enough, and a re-posted `mount` each
  close the composer.
- **It knows no worker, no mode and no extension.** Transport, identity and storage arrive through
  seams (`onSubmit`, `transport`, `NameMemory`, `captureScreenshot`).
- **`public.ts` is the contract.** What it names cannot change without a major version.
- **`:host { all: initial }` stops inheritance too.** A new element needs its own `display`, and the
  reset must keep excluding `svg`, or every icon is an empty box with nothing in the console.
- **The host sits at the document origin with no size**, and pins are in document coordinates.
- **One prefix, `fruitback`**, for tokens, classes and `data-` attributes. A rename that misses the
  camelCased `dataset.fruitbackPin` paints nothing and raises nothing: only `pnpm e2e` proves it.
- **A message, a note and a comment body are text**: `textContent` or an attribute, never `innerHTML`.
- **A new dependency is bundled, is a devDependency, and adds its notice** to
  `packages/widget/THIRD-PARTY-NOTICES.md`.

**The seed contract**

- **Bump `SEED_VERSION` when the payload shape changes.** No schema default, and no field the widget
  cannot rebuild from what is stored: the round trip must return exactly the seed.
- **It holds the vocabulary and nothing a human reads**: no label, no colour, no emoji.

**The worker**

- **Resist logic that belongs in the widget or in the store.** New behaviour goes in `app.ts`, which
  is transport-agnostic.
- **Both paths canonicalize the page URL.** A pin stored under another key is a pin nobody finds.
- **A store or a connector that cannot be used is a `502`, never a fall back to another store**: the
  note would be kept where its team never looks. A code the widget reads names a role, never a vendor.
- **The client IP is counted from the right of `X-Forwarded-For`** (`TRUSTED_PROXY_HOPS`).
- **A credential is stored as a digest or sealed, and no route answers it.** The identity token
  travels in `Authorization`, never in the seed, which anyone in the workspace can read.
- **After a merge, look at `release-image.yml` too.** A release that fails publishes nothing and says
  so only in the Actions tab.

**The extension**

- **A token is held by the background and the popup only.** Nothing secret crosses
  `window.postMessage`, which the page can forge on.
- **Every decision of the relay is made in the background**: the origin comes from `sender`, the
  endpoint from storage, the credential from the session — never from the message.
- **Ask for a permission before anything is awaited in a click handler.** A gesture is lost across an
  `await`, and the prompt never appears.
- **`chrome.storage` has no transaction.** One key per endpoint, never a shared record that two
  contexts read and replace. Only the background writes the sites map.
- **Logic lives in `src/*.ts` behind seams, never in an entrypoint**, which binds `browser` and
  `window` at import and so cannot be tested.

**Tests and specs**

- **Assert on what you measured, never on a second measurement**, and synchronise on the harness's
  status line rather than on a pin count.
- **An absence needs a control.** A spec that counts zero, and a guard that finds nothing, prove
  nothing alone: plant the violation and watch it fail.
- **Each spec captures on its own page URL** (`/?case=…`): there is no reset between specs.
- **Read the file after you edit a guard.** A clause was described twice while its edit had not applied.

## Conventions

- **Commit subjects and PR titles are Conventional Commits**: `type(scope): what changed (FRU-xxx)`.
  Types in use: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `style`, `ci`. The scope is the
  package — `worker`, `widget`, `shared`, `playground`, `extension` — and is omitted when the change
  spans them. A squash merge takes the PR title as the subject, so the **PR title** is the one that
  has to be well-formed. Do not infer it from the top of `git log`.
- **Tests run on `node:test` and `node:assert/strict`**, colocated as `*.test.ts`, with fixtures in
  `*.fixture.ts`. No runner, no transpiler: Node strips the types, so relative imports carry the `.ts`
  extension. Run them with `LC_ALL=en_US.UTF-8` when your shell has another locale.
- **A document that names a test marks it**: `test:` before the backticked name, `gone-test:` for one
  that is gone on purpose. `cited-tests.test.ts` checks both.
- **A link in `docs/` goes to the `.md` file**, never to the page it becomes.
- **A convention an outside contributor cannot guess goes in `CONTRIBUTING.md` too**, in one sentence.
- Comments explain _why_, not _what_.
- Work is tracked in Linear, team Fruitback, key `FRU`. The Linear MCP server is declared in
  `.mcp.json`; if its tools are missing, it needs `/mcp` in an interactive session, and
  cannot be authorized from a non-interactive one.
