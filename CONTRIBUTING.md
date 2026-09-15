# Contributing to Fruitback

This page is what you need before a first pull request: how to run the project, what must pass, and
the conventions a reviewer will hold you to. It is short on purpose. The full set of rules is in
[CLAUDE.md](CLAUDE.md) — written for coding agents, and just as binding for people — and the reasons
behind each rule are in [docs/decisions/](docs/decisions/). If this page and `CLAUDE.md` disagree,
`CLAUDE.md` is right and this page has a bug.

By taking part, you agree to the [code of conduct](CODE_OF_CONDUCT.md). To report a vulnerability,
read [SECURITY.md](SECURITY.md) first instead of opening an ordinary issue.

## Set up

- **Node 26**, the version in `.nvmrc` (`nvm use` reads it). The sources run with no build step,
  because Node strips the types itself.
- **pnpm 11.16.0**, the version `packageManager` pins in `package.json`. For example:
  `npm install --global pnpm@11.16.0`.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts two servers on fixed ports:

| | |
| --- | --- |
| `http://localhost:5177` | the playground: a deliberately hostile fake client site with the widget on it |
| `http://localhost:8788` | the worker, on an in-memory store |

The in-memory store needs no API key and writes to nobody's workspace. The playground is scaffolding
for trying the widget, not the product: build features in `packages/widget`.

## Where things are

| | |
| --- | --- |
| `packages/shared` | the seed contract, shared by the browser and the server |
| `packages/widget` | everything that runs in the browser |
| `packages/fruitback` | the package a client installs; it re-exports the two above and defines nothing |
| `apps/worker` | the Node service between the widget and the store |
| `apps/extension` | the browser extension |
| `apps/playground` | the dev loop, never shipped |

## Run the tests

Tests use `node:test` and `node:assert/strict`, with no test runner and no transpiler.

```bash
pnpm test                                    # every package that has a test script
pnpm --filter @fruitback/widget test         # one package
pnpm --filter @fruitback/widget test:watch   # one package, again after each change
cd packages/widget && node --test src/panel.test.ts   # one file
```

The end-to-end suite drives a real Chromium through Playwright, and starts both servers itself:

```bash
pnpm exec playwright install chromium   # once
pnpm e2e
```

## Before you open a pull request

CI runs each of these as its own check on every pull request to `main`. Run them first:

| Check | Locally |
| --- | --- |
| `lint` | `pnpm lint` |
| `format` | `pnpm format`, and `pnpm format:fix` to rewrite the files |
| `typecheck` | `pnpm typecheck` |
| `test` | `pnpm test` |
| `e2e` | `pnpm e2e` |
| `docker image` | builds the worker image and plants a pin through `docker-compose.yml`, see [docs/self-hosting.md](docs/self-hosting.md) |
| `zizmor` | `uvx zizmor==1.30.1 --offline .github/workflows`, the version CI runs, if you changed a workflow: it fails on an unpinned action or a permission a job does not need |

Then:

- **The title is a Conventional Commit**: `type(scope): what changed (SKG-xxx)`. The key at the end is the
  Linear ticket; leave it out when the change has none. The types are `feat`, `fix`,
  `refactor`, `chore`, `docs`, `test`, `style`, `ci`. The scope is the package — `worker`, `widget`,
  `shared`, `playground`, `extension` — and you leave it out when the change touches several. A squash
  merge keeps the title as the commit message, so the title is the part that has to be right.
- **Say what you tested, and what you could not.** "Not checked in a browser, because …" is a useful
  sentence. A silent gap is not.
- **A change to the threat model changes [SECURITY.md](SECURITY.md) in the same pull request**: a new
  route, something new stored in the clear, a guarantee added or removed.

## Conventions a reviewer will ask about

None of these can be guessed from the code, and most of them have broken something before.

- **Relative imports carry the `.ts` extension**: `import { x } from './x.ts'`. Node needs it to run the
  sources with no build step, and `tsc` accepts it.
- **Tests sit beside the code** as `*.test.ts`, and fixtures as `*.fixture.ts`. Doubles come from
  `mock` in `node:test`, restored in an `afterEach`. Mock `fetch` for anything that calls a service: no
  test writes to a real Linear workspace or GitHub repository.
- **`packages/shared` has `types: []` on purpose.** It is bundled into the widget, so code there that
  touches `process` or `Buffer` must fail to compile. Do not add `node` to its `tsconfig.json`; its
  tests type-check through `tsconfig.test.json`.
- **No backticks inside the CSS template literals of the widget** (`STYLES`, `THEME_STYLES`). A backtick
  in a comment there closes the string: the module stops parsing, or the stylesheet silently loses its
  end.
- **The widget draws no emoji of its own.** Its icons are SVG paths in `icons.ts`. A `label` the host passes is
  the host's text, and it can hold an emoji.
- **One prefix, `fruitback`**: CSS custom properties are `--fruitback-*`, classes `.fruitback-*`, and
  attributes `data-fruitback-*`.
- **Every word the widget shows has a key in `messages.ts`.** The English text is there and the French text is
  in `locale-fr.ts`: a new message needs both. [docs/translating.md](docs/translating.md) explains how to add a language.
- **Comments explain why, not what.** Formatting is oxfmt and linting is oxlint: 120 columns, single
  quotes, trailing commas.

## When a change touches the contract

`packages/shared` is the contract between the widget and the worker, and every published version of the
widget depends on it. Treat a change there as breaking until you have shown it is not.

- **A seed survives the round trip.** `parseSeedFromDescription(buildIssueDescription(seed))` returns
  exactly `seed`. So a schema has no default values, and a seed holds no field the widget cannot rebuild
  from what is stored.
- **If the shape of a seed changes, bump `SEED_VERSION`.** Readers accept older versions and refuse
  newer ones, instead of silently dropping the fields they do not know.
- **A field of the read answer is not a field of the seed.** `GET /feedback` adds `url` and `stages` to the
  answer, and `url` and `comments` to each issue. They are not stored in the seed, so they do not change
  `SEED_VERSION` — but an older widget must still work without them, and a newer one with an older worker.
  `seed.page.url` is not one of them: it is part of the seed.
- **The parsers never throw.** A seed is read back from an issue description a person can edit, so
  `parseSeed*` returns `{ ok: false, reason }`.

## Adding a connector

A connector puts seeds in a store. Linear, SQLite and GitHub Issues exist, and a new one is the
contribution we expect most often.

1. Implement `SeedStore` from [`apps/worker/src/store.ts`](apps/worker/src/store.ts). `findForPage` says
   what to return, not how: filter the way your store can, then compare `seed.page.url` exactly.
2. Declare it with `defineStore`, and add one entry to `STORE_SPECS` in `stores.ts`. Name your
   environment variables in `envNames`, so that a boot error names the variable an operator sets.
3. Add each variable to `docker-compose.yml`, `.env.example` and the variable table of
   `docs/self-hosting.md`. `compose.test.ts` compares all three with `envNames`: if it fails on your pull
   request, one of the three is missing a variable.
4. If your store cannot report all five stages, declare the ones it can in `stages`. The settings panel
   then offers only those.
5. When the service fails, throw `StoreError`: the worker answers `502 store-unavailable`, and the widget
   keeps the note. Parse every row the service returns; never trust it.
6. Add your store to `apps/worker/src/store-conformance.test.ts`, the suite every store passes: a seed
   read back unchanged, a page kept apart from the same page with a query string, one client kept from
   another, a client routed to the tenant its configuration names, an unknown state drawn as `seeded`,
   replies oldest first and capped, and an error, an unreadable answer or an unreachable provider
   answered as `502 store-unavailable`. A remote store runs against a double of the service that keeps
   what it receives.
7. Add a row to the two store tables of [docs/self-hosting.md](docs/self-hosting.md), and to the store
   table of [SECURITY.md](SECURITY.md): where a seed lands, and who can read it there.

[docs/decisions/worker.md](docs/decisions/worker.md) says what the SQLite and GitHub connectors changed
in the interface, and why.

## Licences

| | |
| --- | --- |
| `packages/fruitback` | MIT |
| `packages/shared` | MIT |
| `packages/widget` | MIT |
| `apps/worker` | AGPL-3.0-only |
| `apps/extension` | AGPL-3.0-only |
| `apps/playground` | not published, under the repository's MIT licence |

A contribution is made under the licence of the package it changes.
