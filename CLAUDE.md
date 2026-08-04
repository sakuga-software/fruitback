# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project

Fruitback is a visual feedback widget: a client clicks an element on their staging site, writes a
note, and it becomes a Linear issue carrying the CSS selector, the React component and the source
file. Coming back to the page, they see their pins again, coloured by Linear status.

**There is no Fruitback backend. Linear is the database.** The only server-side piece is a proxy
Worker that holds the Linear token. Anything that looks like it needs storage — status, threads,
assignees, history — belongs in Linear, not here. See [README.md](README.md) for the reasoning and
the alternatives that were dropped.

## Commands

Package manager is `pnpm@11.16.0` (pinned). Nx runs multi-project targets.

```bash
pnpm install
pnpm test                                   # nx run-many -t test
pnpm typecheck
pnpm lint                                   # oxlint
pnpm format:fix                             # oxfmt

pnpm --filter @fruitback/shared test         # one package
pnpm --filter @fruitback/shared test:watch
```

## Layout

- `packages/shared` (`@fruitback/shared`) — the seed contract. Browser- and Worker-safe: no Node
  API, no DOM API beyond `URL`.
- `packages/widget` — *not written yet.* Capture + overlay, on top of `react-grab/primitives`.
- `apps/worker` — *not written yet.* Cloudflare Worker proxying to the Linear API.

## The seed contract

`packages/shared` is the contract both ends depend on. Treat changes to it as breaking.

- A **seed** is one pin: `note`, `page`, `viewport`, `anchor`, plus optional `source` (react-grab),
  `client`, `reporter`, `env`, `screenshot`.
- **The round-trip is the invariant**: `parseSeedFromDescription(buildIssueDescription(seed))` must
  return exactly `seed`. Two rules protect it — **no schema default values**, and no field the
  widget cannot rebuild from what is stored. Adding a default is the easy way to break this
  silently; the test `adds no field the caller did not provide` is there to catch it.
- **Bump `SEED_VERSION`** when the payload shape changes. Readers accept older versions and refuse
  newer ones (`unsupported-version`) rather than silently dropping fields.
- **`parseSeed*` never throws.** It returns `{ ok: false, reason }` — the input is a Linear
  description a human may have edited.
- `canonicalizePageUrl` is the page identity: fragment and tracking params dropped, remaining params
  sorted. It must stay idempotent, and its output must appear verbatim in the description — that is
  what makes the Linear `description: { contains: … }` filter work.
- Pin colour comes from `stageForLinearState` (Linear workflow state type → fruit stage). The widget
  never stores a status of its own.

## Conventions

- Formatting and linting are oxfmt / oxlint (config at the root). 120 columns, single quotes,
  trailing commas.
- Tests are Vitest, colocated as `*.test.ts`, importing `describe/expect/it` explicitly (no
  globals). Fixtures live in `*.fixture.ts`.
- Comments explain *why*, not *what* — the tolerant parser and the redundant anchor both exist for
  reasons that are not obvious from the code.
- Work is tracked in Linear on the
  [Fruitback](https://linear.app/sakuga-software/project/fruitback-ed574263d8d6) project (team SKG).
  Reference tickets as `SKG-xxx` in commits.

## Linear MCP

The Linear MCP server is declared in [.mcp.json](.mcp.json) at the project scope. If its tools are
missing in a session, it needs to be approved and authorized (`/mcp` in an interactive session) —
it cannot be authorized from a non-interactive one.
