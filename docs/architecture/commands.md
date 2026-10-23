# Commands

The commands of a checkout of this repository, and what each test runner is for.

```bash
pnpm install
pnpm dev          # playground on :5177 + worker on :8788, no Linear key needed
pnpm test         # node --test across packages via Nx, vitest for the worker
pnpm e2e          # playwright, starts both servers itself
pnpm typecheck
pnpm lint         # oxlint
pnpm format:fix   # oxfmt

pnpm --filter @fruitback/shared test:watch
```

Tests run on Node's own runner (`node:test` + `node:assert/strict`) against the TypeScript sources —
no test framework, no transpiler, no loader in the dependency tree. Same reason relative imports carry
their `.ts` extension: Node's resolver wants it, and it buys `node --test` and `node --watch` for free.
The worker is the exception: its tests run on vitest, so that mutation testing follows each test
(FRU-346, [conventions.md](https://github.com/sakuga-software/fruitback/blob/main/docs/decisions/conventions.md)).

On top of that sits a small Playwright suite, for the two things a DOM emulator cannot vouch for and
that this product rests on: a real selector engine and real layout. `pnpm dev` opens the same page by
hand — a deliberately hostile fake client site, with a **Redéployer** button that rehashes classes and
shuffles the markup so re-anchoring can be watched rather than argued about. Both run against a
worker with a **PostgreSQL in its process** and an **in-memory Linear**, so neither needs a service or
an API key, nor touches a workspace.
