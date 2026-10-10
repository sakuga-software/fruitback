# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

**This file is loaded into every session; `docs/` is not.** It holds only what applies everywhere,
breaks in silence, and that no lint rule and no test catches. **Before you change an area, read its
page** — the table below says which. A new rule goes to a lint rule or a guard test first, then to its
page, and here last: `claude-md.test.ts` holds this file to its budget, and
[docs/decisions/README.md](docs/decisions/README.md) says how to choose.

Fruitback is a visual feedback widget: a client clicks an element on their staging site, writes a
note, and it becomes an issue carrying the CSS selector, the React component and the source file.
Coming back to the page, they see their pins again, coloured by that issue's status. It ships as
three modes over one core — public, private, team: [docs/modes.md](docs/modes.md).

## Commands

Package manager is `pnpm@11.16.0` (pinned). Nx runs multi-project targets.

```bash
pnpm install
pnpm dev                                    # worker (in-memory Linear) + playground, see below
LC_ALL=en_US.UTF-8 pnpm test                # nx run-many -t test → node --test
pnpm e2e                                    # playwright, starts both servers itself
pnpm typecheck
pnpm lint                                   # oxlint
pnpm format:fix                             # oxfmt

pnpm --filter @fruitback/shared test         # one package
node --test src/seed.test.ts                 # one file, from the package directory
```

**`pnpm dev` starts both halves. The ports are fixed, and these are them:**

|                         |                                                 |
| ----------------------- | ----------------------------------------------- |
| `http://localhost:5177` | the playground page, the dev server `/tf` opens |
| `http://localhost:8788` | the worker, on its in-memory Linear             |

`/tf` and `/tfp` read these numbers from here rather than probing.

## Before you touch an area, read its page

| You are about to change                                     | Read first                                                |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| what the project is, the role of a package                  | [project.md](docs/decisions/project.md)                   |
| `packages/shared`, a field of the seed                      | [contract.md](docs/decisions/contract.md)                 |
| `packages/widget`                                           | [widget.md](docs/decisions/widget.md)                     |
| an icon, a glyph, anything that looks like an emoji         | [icons.md](docs/decisions/icons.md)                       |
| a `package.json` of a published package, a licence          | [packaging.md](docs/decisions/packaging.md)               |
| `apps/extension`                                            | [extension.md](docs/decisions/extension.md)               |
| `apps/worker`: a route, a store, identity, a session        | [worker.md](docs/decisions/worker.md)                     |
| `apps/console`, a screen that has a board in `design/`      | [console.md](docs/decisions/console.md)                   |
| the Dockerfile, a workflow, `docker-compose.yml`, the guide | [image.md](docs/decisions/image.md)                       |
| `apps/playground`, a spec in `e2e/`                         | [dev-loop.md](docs/decisions/dev-loop.md)                 |
| Nx, formatting, a guard test, a document, the Linear MCP    | [conventions.md](docs/decisions/conventions.md)           |
| a claim about what is protected, a route, a thing stored    | [SECURITY.md](SECURITY.md), [privacy.md](docs/privacy.md) |

Each section of a page opens with **the rules, in short**, then gives the reasons and the
measurements. A rule that looks arbitrary has its reason there: read it before you reason past it.

## What breaks in silence, everywhere

- **Measure, then write.** A claim about a browser, a proxy or a tracker that nobody measured is the
  repository's recurring defect. `curl` does not enforce CORS, and automation cannot answer a
  permission prompt.
- **An absence needs a control.** A spec that counts zero, and a guard that finds nothing, prove
  nothing alone: plant the violation and watch it fail.
- **Losing what someone just wrote is the one failure the product cannot afford.** No error path
  clears a field, and nothing mounts the widget a second time while somebody types.
- **A feature of the widget grows in `packages/widget`**, which knows no worker, no mode and no
  extension: what differs arrives through a seam, never in the playground or the worker.
- **A change to what is protected lands in [SECURITY.md](SECURITY.md) in the same commit**, and a
  sentence that says something is protected names its condition. Its numbers are tested; its
  properties are a hand edit.

## Commits and pull requests

**Commit subjects and PR titles are Conventional Commits**: `type(scope): what changed (FRU-xxx)`.
Types in use: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `style`, `ci`. The scope is the
package — `worker`, `widget`, `shared`, `playground`, `extension` — and is omitted when the change
spans them. A squash merge takes the PR title as the subject, so the **PR title** is the one that has
to be well-formed. Do not infer it from the top of `git log`. `FRU-xxx` is the Linear ticket, team
Fruitback.
