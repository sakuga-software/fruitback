# Decisions

Why the code is the way it is: the measurements, the first versions that failed, and the reviews
that caught them.

**[CLAUDE.md](../../CLAUDE.md) is loaded into every session; this directory is not.** That is the
split. `CLAUDE.md` holds what an agent has to know before it writes a line **and that no machine
catches**: the project in a few lines, the commands, the map, the ports, and the traps that bite in
silence, one line each. Everything here is a lookup: read the page when you are about to change the
thing it describes, or when a rule looks arbitrary and you are about to reason your way past it.

Each section of a page opens with **the rules, in short** — the text `CLAUDE.md` carried until it
reached 1,450 lines and no session read it whole — and then gives the reasons, the measurements and
the history.

|                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [project.md](project.md)         | Project · Layout                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [dev-loop.md](dev-loop.md)       | The dev loop · The E2E suite · The public demonstration                                                                                                                                                                                                                                                                                                                                                                                        |
| [packaging.md](packaging.md)     | The published package · Licences                                                                                                                                                                                                                                                                                                                                                                                                               |
| [image.md](image.md)             | The published image · The compose file · The self-hosting guide                                                                                                                                                                                                                                                                                                                                                                                |
| [widget.md](widget.md)           | The widget · The host, and why everything lives in one Shadow root · The look, and the one thing a host may change · One prefix, and it is `fruitback` · The popover · Who carries the calls · The optional picture · The settings panel · The feedback as text · The words, and the catalogs the bundle carries · The keyboard, the screen reader and the contrast · Re-anchoring, and why a pin says how sure it is · The list of every note |
| [icons.md](icons.md)             | No emoji, and what replaced them                                                                                                                                                                                                                                                                                                                                                                                                               |
| [extension.md](extension.md)     | The extension, and the two worlds                                                                                                                                                                                                                                                                                                                                                                                                              |
| [worker.md](worker.md)           | The worker · The rate limit and the cache, behind a Kv · Who may read a pin · The team's replies · Where a seed is stored · Which store, and who validates it · SQLite, and what a second connector actually proved · The conformance suite, and the matrix · The markdown codec, and the file that outlived its name · The extension's session · Several client sites                                                                         |
| [contract.md](contract.md)       | The seed contract                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [console.md](console.md)         | The console: its words, its kit, and what it shows of a connector                                                                                                                                                                                                                                                                                                                                                                              |
| [conventions.md](conventions.md) | Conventions: commits, Nx, formatting, tests, the documents and the guards that hold them                                                                                                                                                                                                                                                                                                                                                       |

Five documents one level up are the other kind: written for somebody using Fruitback rather than
changing it — [modes.md](../modes.md) (which of the three you want, and what each protects),
[install.md](../install.md) (the widget on a site), [reviewing.md](../reviewing.md) (the reviewer's
side: the extension, switching a site on, pairing), [self-hosting.md](../self-hosting.md) (the
worker) and [architecture.md](../architecture.md), which sits between the two kinds and holds the
design material the README used to carry.

## Adding to these pages

A rule has three possible homes, and they are tried in this order:

1. **A machine.** A lint rule in `.oxlintrc.json` when the rule is an import, a global or a syntax
   that must not appear; a guard test, in the style of `workflows.test.ts`, when it is anything else
   a program can read. Prove it on a planted violation: a guard that finds nothing proves nothing
   alone. The rule then needs no line in `CLAUDE.md`.
2. **A page here**, under _The rules, in short_ of its section, with its reason. That is the home of
   everything an agent needs only when it changes that area.
3. **`CLAUDE.md`, as one line**, only when the rule breaks in silence, no machine can hold it, and an
   agent would break it before it knew which page to open.

A paragraph belongs here when losing it costs an anecdote, and in `CLAUDE.md` when losing it means
somebody writes broken code that nothing reports (FRU-59). `claude-md.test.ts` holds `CLAUDE.md` to a
budget of lines and bytes, so a paragraph added there fails the suite until it has one of the homes
above. It also fails on a page that `CLAUDE.md` or this index does not name, and on a link to a
file or a heading that is not there.

### What the lint holds

|                                                                                                      |                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `typescript/parameter-properties`, everywhere                                                        | Node's type stripping refuses `constructor(readonly status: number)`, and `tsc` accepts it |
| `no-restricted-imports`: `happy-dom` outside `*.test.ts`, `*.fixture.ts`                             | shipped code runs in a real browser                                                        |
| `no-restricted-imports`: an app, from `packages/**`                                                  | a published package knows no app                                                           |
| `no-restricted-imports`: `node:*` and `@fruitback/*`, from `packages/shared/src`                     | the seed contract is browser- and server-safe                                              |
| `no-restricted-imports`: `@heroui/*` outside `apps/console/app/ui.tsx`                               | a screen uses the kit                                                                      |
| `no-restricted-imports`: `sqlite.ts`, from `session-sqlite.ts`                                       | that `connect` applies the seeds migrations                                                |
| `unicorn/no-instanceof-builtins`, in `packages/widget/src`                                           | `instanceof Element` reads a class off one realm; use `isElement` from `dom.ts`            |
| `no-restricted-globals`: `MutationObserver`, `ResizeObserver`, `navigator`, in `packages/widget/src` | take them off the document's own window, never off `globalThis`                            |
| `no-restricted-globals`: `fetch`, in `packages/widget/src` but `transport.ts`                        | every call goes through the transport                                                      |

A custom rule would need a JS plugin, which oxlint marks as alpha and outside semver. Until that
changes, what these rules cannot say is a guard test.
