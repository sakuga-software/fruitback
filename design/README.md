# The design reference

`fruitback-design-export.html` is the export of the Claude Design project « Application overlay
redesign » (2026-10-07). Open it in a browser: it is one self-contained file. It is the reference
for the Cloud, the console and the simplified extension (FRU-94 to FRU-106). **Build to it**: the
layout, the words and the tokens of a screen that has a board come from that board.

The export holds five boards. `boards/` holds a picture of each, rendered at 1600 px wide.

| Board                     | What it shows                                                                  | Ticket                 |
| ------------------------- | ------------------------------------------------------------------------------ | ---------------------- |
| `1-propositions.png`      | The eight propositions (P1 to P8), the path to a first note, the two settings | FRU-95 to FRU-106      |
| `2-onboarding.png`        | « Create your workspace », the four steps of the setup                        | FRU-97, FRU-98, FRU-99 |
| `3-offers.png`            | « Two ways to run Fruitback »: Cloud and self-hosted, side by side            | FRU-105                |
| `4-connectors.png`        | The sources of a workspace, connected once                                    | FRU-102                |
| `5-workspace.png`         | Members and « My account »                                                     | FRU-96, FRU-104        |

**What has no board.** The name of the export says « overlay, sidebar, extension, landing », and that
is the name of the project, not a list of screens: there is no board for the sidebar, the popup or the
landing page. Those take the language of the boards above.

## The tokens

The boards use the same tokens as the widget (`packages/widget/src/theme.ts`), measured from the
export:

| Token        | Value                                                    |
| ------------ | -------------------------------------------------------- |
| Text         | `#1c1917`, muted `#78716c`, faint `#a8a29e`              |
| Lines        | `#e7e5e4`                                                |
| Surfaces     | page `#faf9f5`, card `#ffffff`, setup page `#f6f4f1`     |
| Accent       | `#dd2c27`                                                |
| Green (done) | `#56802e`                                                |
| Font         | the system font (`-apple-system, BlinkMacSystemFont`)    |
| Radius       | 6 px controls, 8 to 10 px fields, 14 px cards, 999 px pills |
