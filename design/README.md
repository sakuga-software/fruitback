# The design reference

`fruitback-design-export.html` is the export of the Claude Design project « Application overlay
redesign » (2026-10-07). Open it in a browser: it is one self-contained file. It is the reference
for the Cloud, the console and the simplified extension (FRU-94 to FRU-106). **Build to it**: the
layout, the words and the tokens of a screen that has a board come from that board.

The export holds five boards. `boards/` holds a picture of each, rendered at 1600 px wide.

| Board                | What it shows                                                                 | Ticket                 |
| -------------------- | ----------------------------------------------------------------------------- | ---------------------- |
| `1-propositions.png` | The eight propositions (P1 to P8), the path to a first note, the two settings | FRU-95 to FRU-106      |
| `2-onboarding.png`   | « Create your workspace », the four steps of the setup                        | FRU-97, FRU-98, FRU-99 |
| `3-offers.png`       | « Two ways to run Fruitback »: Cloud and self-hosted, side by side            | FRU-105                |
| `4-connectors.png`   | The sources of a workspace, connected once                                    | FRU-102                |
| `5-workspace.png`    | Members and « My account »                                                    | FRU-96, FRU-104        |

**What has no board.** The name of the export says « overlay, sidebar, extension, landing », and that
is the name of the project, not a list of screens: there is no board for the sidebar, the popup or the
landing page. Those take the language of the boards above. The list of every note of the
page (FRU-129) was built that way, on the tokens of the widget.

## The tokens of the console (the mockup of 2026-10-13)

The console takes the tokens of the mockup « Fruitback, simpler flow » of 2026-10-13 (FRU-230,
FRU-232): a neutral grey on a white page, and five colours of status. Mathieu drew the mockup; the
orchestrator read it as his answer on the palette on 2026-10-13, and he may come back on it. So
every value is named once, in `apps/console/app/app.css`, and a screen writes the name:
`app/tokens.test.ts` fails on a colour written as a value in a screen or in the kit.

| Token                                                            | Value                                                           | What it is for                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `ink`, `ink-soft`, `muted`                                       | `#18181b`, `#52525b`, `#6b6b74`                                 | text, a value that is locked, a hint and a placeholder       |
| `page`, `surface`, `subtle`, `chip`                              | `#ffffff`, `#ffffff`, `#fafafa`, `#f4f4f5`                      | the page, a card, a panel or an empty state, a selection     |
| `line`, `control`                                                | `#e4e4e7`, `#8a8a93`                                            | a rule or a frame, the border of a field and of a control    |
| `accent`, `accent-strong`                                        | `#dd2c27`, `#b91c1c`                                            | the main button, the focus ring, an alert; under the pointer |
| `done`                                                           | `#15803d`                                                       | « Connected », a step that is done                           |
| `status-new`, `-todo`, `-progress`, `-done`, `-closed`           | `#dd2c27`, `#2563eb`, `#f59e0b`, `#15803d`, `#64748b`           | the status of a note                                         |
| `rail`, `rail-active`, `rail-text`, `rail-muted`, `rail-accent`  | `#18181b`, `#27272a`, `#d4d4d8`, `#a1a1aa`, `#ec5b57`           | the dark rail of a workspace (FRU-234)                       |
| `avatar`                                                         | `#3f3f46`                                                       | the round initial of a person                                |
| `text-title`, `-title-setup`, `-conclusion`                      | `28px/1.15`, `30px/1.15`, `22px/1.25`                           | a title, weight 700                                          |
| `text-section`, `-step`, `-lead`                                 | `18px`, `17px/26px`, `16px/1.5`                                 | a section, a step, the sentence under a title                |
| `text-body`, `-small`, `-table`, `-hint`, `-label`, `-tiny`      | `15px/1.5`, `14px/1.5`, `14px/1.45`, `13px/1.5`, `13px`, `12px` | text                                                         |
| `h-control`, `-control-panel`, `-control-chip`, `-control-small` | `44px`, `40px`, `36px`, `32px`                                  | the height of a control                                      |
| `rounded-button`, `-field`, `-box`, `-frame`                     | `6px`, `8px`, `10px`, `14px`                                    | a control, a field, an option card, a table or a panel       |
| `shadow-frame`, `-pin`, `-thumb`                                 | see `app.css`                                                   | the preview, a drop, the thumb of a switch                   |
| `ease-settle`, `--duration-fast`                                 | `cubic-bezier(.16, 1, .3, 1)`, `220ms`                          | the one movement of the console: a switch                    |
| Font                                                             | the system font (`-apple-system, BlinkMacSystemFont`)           | weights 400, 600 and 700 only                                |

**Measured, on the pairs the console draws** (`e2e/console-kit.spec.ts` measures every text of the
kit): muted on white 5.28:1, on `subtle` 5.05:1, on `chip` 4.80:1; white on the accent 4.70:1, and
6.47:1 under the pointer; `done` on white 5.02:1; the border of a control on white 3.42:1, over the
3:1 a border needs when it alone says where a control is (WCAG 1.4.11).

**Two things of the mockup the console does not copy.** The accent on `chip` is 4.28:1: an alert
that is a text alone is the accent on white, and `accent-strong` on `subtle` or `chip` (6.20:1 and
5.89:1). The amber of « In progress » is 2.15:1 on white: a status is never told by its colour alone,
and `StatusDot` and `StatusBar` are pictures with the words beside them.

**The console has no dark theme**: the mockup draws none.

## The tokens of the first boards (2026-10-07)

The boards of 2026-10-07 use the tokens the widget had then (`packages/widget/src/theme.ts`),
measured from the export. The console no longer uses them (FRU-232); they are kept here to read the
boards.

| Token        | Value                                                       |
| ------------ | ----------------------------------------------------------- |
| Text         | `#1c1917`, muted `#78716c`, faint `#a8a29e`                 |
| Lines        | `#e7e5e4`                                                   |
| Surfaces     | page `#faf9f5`, card `#ffffff`, setup page `#f6f4f1`        |
| Accent       | `#dd2c27`                                                   |
| Green (done) | `#56802e`                                                   |
| Font         | the system font (`-apple-system, BlinkMacSystemFont`)       |
| Radius       | 6 px controls, 8 to 10 px fields, 14 px cards, 999 px pills |

**A wide button is a control, 6 px; a field is 8 px, and flat.** The pill is for the action of a
step (FRU-168). The mockup of 2026-10-13 keeps all three.

**A required field has no mark.** The boards draw no asterisk after « Work email », and the screen
follows them: the field stays required for the browser and for a screen reader, and the step says
what is missing when it is sent empty. Arbitrated by the orchestrator on 2026-10-12, on delegation
from Mathieu (FRU-168): what the board shows.
