# Architecture, and the decisions under it

Written for somebody changing Fruitback, or deciding whether to. It is the design half of the old
README: the page a reader lands on answers *what is this*, and everything that answers *why is it
shaped like that* is here (SKG-519).

The per-ticket histories — the measurements, the first versions that failed, the reviews that caught
them — are one level down, in [decisions/](decisions/).

## Why this shape

Alternatives we looked at and dropped:

- **SitePing** — closest match, but Prisma.
- **Quackback** — no visual layer at all (a text form in a panel), AGPL-3.0, and oversized for the
  need: it brings boards, roadmap and changelog we do not want.
- **Full in-house** — rebuilding auth, dashboard, API, MCP and integrations to reach parity with
  something Linear already does.

So: build **only** the missing piece — the capture and restitution layer — on top of
[react-grab](https://github.com/aidenybai/react-grab) (MIT), and let the issue tracker absorb
everything else. The one thing it cannot do is redraw a pin on the page; that part we reconstruct
from the anchor we stored.

## Architecture

```
widget (client site)            worker (proxy)              Linear
──────────────────              ──────────────              ──────
react-grab picker      ──POST──▶ create issue      ──────▶  issue + labels
comment popover                  (server-side token)        description = seed
pin overlay            ◀──GET─── query by label+URL ◀─────  status, comments
```

- **widget** — `@fruitback/widget`, an embeddable script (Shadow DOM, so the client's CSS is never
  touched). Picks the element via `react-grab/primitives`, captures the anchor, and later re-plants
  the pins it reads back.
- **worker** — a small Node process in a container (Docker on a VPS, deployed by Dokploy from a
  GitHub push). Its only reason to exist: the Linear token cannot live in client-side JS on a public
  site. It also decides attribution (anonymous vs signed in).
- **shared** — `@fruitback/shared`, the _seed_ contract. Both ends depend on it.
- **extension** — `@fruitback/extension`, the same widget on a site that embeds **nothing** (SKG-534).
  The reviewer installs it, switches a site on, and the page they are reviewing is untouched — no
  tag, no package, no deploy, and nothing for an ordinary visitor to see. MV3 on Chromium and
  Firefox. It asks for **no host permission at install**: the content scripts are registered at
  runtime, per origin, when somebody turns that site on.

No database, no dashboard, no session store.

## The seed

A **seed** is one piece of feedback planted on an element. It is stored as a JSON block inside the
Linear issue description, under a human-readable summary.

Two decisions worth knowing:

**Why the description and not a Linear custom field** — it is portable (no workspace admin setup,
survives an export) and Linear can filter on it server-side with
`description: { contains: <canonical url> }`, which is how "the seeds of this page" is fetched
without walking every issue. The cost is that a human can corrupt the block, so the parser is
deliberately tolerant: it accepts any fenced block, with or without a language tag, backticks or
tildes, CRLF, even an unterminated fence, and finds ours by its `kind` field.

**Why the anchor is redundant** — a selector breaks the moment the site is redeployed. Every seed
therefore carries several independent ways to find the element again (`selector`, test id, text
excerpt, `domPath`, and bounds as a share of the document). When none of them resolve, the pin
becomes an _orphan_ — listed aside rather than dropped on the wrong element. That degradation is
what separates a demo from a tool people keep using.

Everything the widget draws lives in one Shadow root, mounted at the document origin. That is what
makes "no style conflicts" true in both directions on a site whose CSS nobody has read — and the
selection engine underneath it is `react-grab/primitives`, which hit-tests through shadow roots and
iframes and reads the component and source file straight off the React fiber.

Coming back, the pin has to find its element again. The claims are tried in order — selector, test
id, text, structural path, position — and the answer carries **how it was found**: the first three
identify an element, the last two only locate a spot. A pin placed by position is drawn dashed and
says so, because a neighbour that slid into a vacated slot has the same tag, the same text and the
same box, and a pin that looks certain is believed.

Picking the selector is the part that decides whether any of this survives a redeploy: a test id or
an author-written id is kept, a `useId` `:r7:` and a CSS-modules class are refused, and an element
that repeats is anchored under the nearest ancestor that *is* identifiable rather than pathed from
`<html>`.

See [`packages/shared/src/seed.ts`](../packages/shared/src/seed.ts),
[`packages/shared/src/markdown-description.ts`](../packages/shared/src/markdown-description.ts) and
[`packages/widget/src/selector.ts`](../packages/widget/src/selector.ts).

## Layout

```
packages/shared    the seed contract: schema, markdown codec, round-trip   ✅
apps/worker        Node service in Docker: write + read path to Linear     ✅
packages/widget    capture + overlay + Shadow DOM host + popover          ✅
apps/playground    hostile demo page + dev loop, on a fake Linear          ✅  dev only
```

## Commands

```bash
pnpm install
pnpm dev          # playground on :5177 + worker on :8788, no Linear key needed
pnpm test         # node --test, across packages via Nx
pnpm e2e          # playwright, starts both servers itself
pnpm typecheck
pnpm lint         # oxlint
pnpm format:fix   # oxfmt

pnpm --filter @fruitback/shared test:watch
```

Tests run on Node's own runner (`node:test` + `node:assert/strict`) against the TypeScript sources —
no test framework, no transpiler, no loader in the dependency tree. Same reason relative imports carry
their `.ts` extension: Node's resolver wants it, and it buys `node --test` and `node --watch` for free.

On top of that sits a small Playwright suite, for the two things a DOM emulator cannot vouch for and
that this product rests on: a real selector engine and real layout. `pnpm dev` opens the same page by
hand — a deliberately hostile fake client site, with a **Redéployer** button that rehashes classes and
shuffles the markup so re-anchoring can be watched rather than argued about. Both run against an
**in-memory Linear**, so neither needs an API key nor touches a workspace.
