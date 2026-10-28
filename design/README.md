# The design reference

Two mockups are here. **Build a screen to the newest one that draws it**: the simpler flow of
2026-10-13 for the twenty screens it draws, and the export of 2026-10-07 for a screen it does not.

## The simpler flow (2026-10-13)

`simpler-flow/` is the mockup « Fruitback, simpler flow » that Mathieu drew on 2026-10-13 (FRU-230,
FRU-231). `source/simpler-flow.html` is the file itself: open it in a browser. `SPEC.md` reads it
screen by screen and state by state, from its code and from measures in Chromium; the values it
gives are not estimated by eye. `SPEC-annexe-textes.md` holds every text of every state word for
word: a screen takes its English from there. `screens/` is the readable template of each screen,
`measures.json` the contrasts and the boxes measured, `shots/` a picture of each state (`INDEX.md`
lists them), and `tools/` the scripts that unpack the file and take the pictures again. Its tokens
are those of the console (below) and `SPEC.md` § 1 and § 3. The mockup is in English only, and
draws no dark theme.

| Screens                              | What they show                                          | Tickets                                     |
| ------------------------------------ | ------------------------------------------------------- | ------------------------------------------- |
| 01 Setup, one screen                 | « Your account », « Your site », « Put it on the site » | FRU-239, FRU-242                            |
| 02 Sign in                           | The sign-in page, the link on its way                   | FRU-235                                     |
| 03 Invitation                        | « Join », then « You are in »                           | FRU-241                                     |
| 04 Connect this browser              | The console approves the extension                      | FRU-240, FRU-238                            |
| 05 to 08 the popup                   | Signed out, a site of the workspace, on, a new site     | FRU-251, FRU-254, FRU-255                   |
| 09 Sites                             | The table of the sites, the menu of a row               | FRU-243, FRU-270                            |
| 10 Notes                             | Every note of the workspace, and where it went          | FRU-245, FRU-244                            |
| 11 Connectors                        | The sources, and the panel of a source                  | FRU-246                                     |
| 12 Members                           | The invitation on one line, the table of the people     | FRU-247                                     |
| 13 My account                        | The profile, the ways to sign in, the browsers          | FRU-248, FRU-249                            |
| 14 to 16 the widget                  | A note, leaving a note, every note of the page          | FRU-252, FRU-253, FRU-256, FRU-258, FRU-259 |
| 17 to 20 the instance of a self-host | Instance, workspaces, users, notes                      | FRU-260 to FRU-263                          |
| The frame of a workspace             | The dark rail, the workspace switcher                   | FRU-234                                     |

## The statuses of a site (FRU-371, 2026-10-21)

`site-statuses/site-statuses.html` is the board of the statuses screen of a site (FRU-352,
[statuses.md](../docs/decisions/statuses.md)): the list, adding, editing with the preview and the
contrast, ordering by keyboard, deleting an empty status and one that holds notes, a Linear site
with « Use Linear's colours », a GitHub site, and 390 px. Frames at 1440 px are in English, at
390 px in French, and the board ends with its open questions and every text in both languages.
It is drawn on the tokens of the console below, with the stage names of #486. `tools/build.mjs`
writes it (edit the script, not the HTML); `shots/` holds a picture of each frame.
The orchestrator validated it on 2026-10-21 with its eleven recommendations; the screen
(`apps/console/app/routes/site-statuses.tsx`) follows it, the Linear part (frames H and N) since
FRU-368, except the grip of frame A: the order is the two buttons alone.

## The agents of a workspace (FRU-462, 2026-10-28)

`agents/agents.html` is the board of the screen « Agents » of a workspace (FRU-462,
[agents.md](../docs/decisions/agents.md)): the list of the agent keys with their last use and their
end, the warning 7 days before, the form of a new key and its refusals, the key shown once with the
line for Claude Code, the writes of a key, the revocation, the empty state, the section of the
workspace settings that leads there, and 390 px. Frames at 1440 px are in English, at 390 px in
French, and the board ends with its decisions and every text in both languages. It is drawn on the
tokens of the console below. `tools/build.mjs` writes it (edit the script, not the HTML); `shots/`
holds a picture of each frame. The agent fru-agents decided its choices, as the orchestrator asked;
the screen (`apps/console/app/routes/agents.tsx`) follows it.
## A site starts an agent (FRU-468, 2026-10-28)

`agent-triggers/agent-triggers.html` is the board of the section « Start an agent » of the page of a
site (FRU-468, [agents.md](../docs/decisions/agents.md), « Starting an agent on a note »): off by
default; on, the address of the workspace that receives, the moment (a note of a known person, or a
note moved to To do by a person of the team), what the call carries; a workspace with no address,
the calls that did not arrive, the panel of the address, and 390 px in French. It ends with its
decisions and every text in both languages. `tools/build.mjs` writes it (edit the script, not the
HTML); `shots/` holds a picture of each frame. The agent fru-agents decided its choices, as the
orchestrator asked.

## Several notes sent together (FRU-474, 2026-10-28)

`batch-notes/batch-notes.html` is the board of the group « Kept for later, not sent yet » of the
widget (FRU-124), where the person who kept several notes chooses how they arrive in the tracker:
one issue for each note under one parent (what the worker does today, unsaid), or one issue that
holds every note. It draws the group of today, the choice on a Linear site, the second choice with a
title, sending and sent, the pins and the thread of a note in one issue, a place that cannot group,
a send that half worked, and 390 px. Frames at 1440 px are in English, at 390 px in French, and the
board ends with its decisions, what the build needs, its open questions and every text in both
languages. It is drawn on the tokens of the widget (`packages/widget/src/theme.ts`).
`tools/build.mjs` writes it (edit the script, not the HTML); `shots/` holds a picture of each frame.
The agent fru-notes-edit decided its choices, as the orchestrator asked. Nothing of it is built yet.

## The export of 2026-10-07

`fruitback-design-export.html` is the export of the Claude Design project « Application overlay
redesign » (2026-10-07). Open it in a browser: it is one self-contained file. It was the reference
for the Cloud, the console and the simplified extension (FRU-94 to FRU-106), and stays the
reference of a screen that the simpler flow does not draw.

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

| Token                                                            | Value                                                            | What it is for                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `ink`, `ink-soft`, `muted`                                       | `#18181b`, `#52525b`, `#6b6b74`                                  | text, a value that is locked, a hint and a placeholder       |
| `page`, `surface`, `subtle`, `chip`                              | `#ffffff`, `#ffffff`, `#fafafa`, `#f4f4f5`                       | the page, a card, a panel or an empty state, a selection     |
| `line`, `control`                                                | `#e4e4e7`, `#8a8a93`                                             | a rule or a frame, the border of a field and of a control    |
| `accent`, `accent-strong`                                        | `#dd2c27`, `#b91c1c`                                             | the main button, the focus ring, an alert; under the pointer |
| `done`                                                           | `#15803d`                                                        | « Connected », a step that is done                           |
| `status-new`, `-todo`, `-progress`, `-done`, `-closed`, `-edge`  | `#bec2c8`, `#d9dbdf`, `#f3bb3d`, `#5560c4`, `#a52a3a`, `#8a8a93` | the status of a note (FRU-334), and the edge of its drop     |
| `rail`, `rail-active`, `rail-text`, `rail-muted`, `rail-accent`  | `#18181b`, `#27272a`, `#d4d4d8`, `#a1a1aa`, `#ec5b57`            | the dark rail of a workspace (FRU-234)                       |
| `avatar`                                                         | `#3f3f46`                                                        | the round initial of a person                                |
| `text-title`, `-title-setup`, `-conclusion`                      | `28px/1.15`, `30px/1.15`, `22px/1.25`                            | a title, weight 700                                          |
| `text-section`, `-step`, `-lead`                                 | `18px`, `17px/26px`, `16px/1.5`                                  | a section, a step, the sentence under a title                |
| `text-body`, `-small`, `-table`, `-hint`, `-label`, `-tiny`      | `15px/1.5`, `14px/1.5`, `14px/1.45`, `13px/1.5`, `13px`, `12px`  | text                                                         |
| `h-control`, `-control-panel`, `-control-chip`, `-control-small` | `44px`, `40px`, `36px`, `32px`                                   | the height of a control                                      |
| `rounded-button`, `-field`, `-box`, `-frame`                     | `6px`, `8px`, `10px`, `14px`                                     | a control, a field, an option card, a table or a panel       |
| `shadow-frame`, `-pin`, `-thumb`                                 | see `app.css`                                                    | the preview, a drop, the thumb of a switch                   |
| `ease-settle`, `--duration-fast`                                 | `cubic-bezier(.16, 1, .3, 1)`, `220ms`                           | the one movement of the console: a switch                    |
| Font                                                             | the system font (`-apple-system, BlinkMacSystemFont`)            | weights 400, 600 and 700 only                                |

**Measured, on the pairs the console draws** (`e2e/console-kit.spec.ts` measures every text of the
kit): muted on white 5.28:1, on `subtle` 5.05:1, on `chip` 4.80:1; white on the accent 4.70:1, and
6.47:1 under the pointer; `done` on white 5.02:1; the border of a control on white 3.42:1, over the
3:1 a border needs when it alone says where a control is (WCAG 1.4.11).

**Two things of the mockup the console does not copy.** The accent on `chip` is 4.28:1: an alert
that is a text alone is the accent on white, and `accent-strong` on `subtle` or `chip` (6.20:1 and
5.89:1). The light statuses are under 3:1 on white (the grey of « To do » is 1.39:1): a status is
never told by its colour alone, and `StatusDot` and `StatusBar` are pictures with the words beside
them, drawn with an edge of `#8a8a93` (3.42:1).

**The statuses are those of the widget** (FRU-334, chosen by Mathieu on 2026-10-21): new `#bec2c8`,
to do `#d9dbdf`, in progress `#f3bb3d`, done `#5560c4`, closed `#a52a3a`. `packages/widget/src/theme.ts`
is their one source; the console and the extension copy them, and `app/tokens.test.ts` and
`apps/extension/src/design-tokens.test.ts` fail when a copy differs.

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
