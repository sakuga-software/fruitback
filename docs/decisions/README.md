# Decisions

Why the code is the way it is: the measurements, the first versions that failed, and the reviews
that caught them.

**[CLAUDE.md](../../CLAUDE.md) is loaded into every session; this directory is not.** That is the
split. `CLAUDE.md` holds what an agent has to know before it writes a line — the conventions, the
invariants, the traps that bite silently. Everything here is a lookup: read the page when you are
about to change the thing it describes, or when a rule in `CLAUDE.md` looks arbitrary and you are
about to reason your way past it.

| | |
| --- | --- |
| [project.md](project.md) | Project · Layout |
| [dev-loop.md](dev-loop.md) | The dev loop · The E2E suite |
| [packaging.md](packaging.md) | The published package · Licences |
| [image.md](image.md) | The published image |
| [widget.md](widget.md) | The widget · The host, and why everything lives in one Shadow root · The look, and the one thing a host may change · One prefix, and it is `fruitback` · The popover · Who carries the calls · The optional picture · The settings panel · Re-anchoring, and why a pin says how sure it is |
| [icons.md](icons.md) | No emoji, and what replaced them |
| [extension.md](extension.md) | The extension, and the two worlds |
| [worker.md](worker.md) | The worker · Who may read a pin · The team's replies · Where a seed is stored · Which store, and who validates it · SQLite, and what a second connector actually proved · The markdown codec, and the file that outlived its name · The extension's session |
| [contract.md](contract.md) | The seed contract |

[docs/install.md](../install.md) is the other kind of document: it is written for somebody deploying
Fruitback, not for somebody changing it.

## Adding to these pages

A paragraph belongs here when losing it costs an anecdote, and in `CLAUDE.md` when losing it means
somebody writes broken code. A conclusion that is load-bearing stays in `CLAUDE.md` as one line and
links here for the reasoning behind it (SKG-598).
