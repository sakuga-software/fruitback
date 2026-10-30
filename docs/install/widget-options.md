# Widget options

What `init` takes beside the address of the worker and the id of the site, and what the widget gives
back.

## What else `init` takes

| Option          | Why you would                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `label`         | the text on the floating button                                                                                                       |
| `locale`        | the language to show, as a tag like `fr` or `pt-BR` — the browser's by default                                                        |
| `messages`      | your own words for that language — see [Another language](../translating.md#another-language)                                         |
| `ignore`        | elements the pointer must skip — your own chrome, a support chat, a cookie banner                                                     |
| `identityToken` | a signed token, so a reporter is _verified_ — not on a site of the console yet, see [Identified reporters](identified-reporters.md)   |
| `includeEnv`    | `true` to send the reporter's user agent, language and platform — off by default                                                      |
| `transport`     | who carries the calls — the extension's, in [team mode](../install.md#team-mode-dormant-until-a-reviewer-arrives)                     |
| `showSelectors` | `true` to show the CSS selector of the element in the thread of a pin — off by default; the issue keeps it                            |
| `position`      | the corner of the dock: `bottom-right` (the default), `bottom-left`, `top-right` or `top-left` — `data-fruitback-position` on the tag |

**One part of the fragment is the widget's**: `fruitback-note=<id>`. A link like
`https://staging.acme.dev/pricing#fruitback-note=<id>` opens that note on its page, and the widget
then takes its part out of the address. The rest of the fragment is yours: `#pricing` is neither read
nor changed, and `#pricing&fruitback-note=<id>` leaves `#pricing`.

## The feedback of a page, as text

The settings panel has a button, **Copy the notes as text**. It puts the notes of the page in the
clipboard, as Markdown: one block per note, with its status, the element it points at, the component
and the file behind it when your build exposes them, who wrote it, and the team's replies.

```md
# Notes on https://staging.acme.dev/pricing

## 1. FB-12 — To do

- Element: button "Add to cart" · `[data-testid="card-latte"] .add`
- Component: Button · src/components/site.tsx:42
- By: Camille Durand · 2026-10-06

> The price is cut off on mobile

Reply from Léa · 2026-10-07

> Fixed in the next deploy.
```

- **It is what the reviewers wrote and where, and nothing else.** No instruction and no introduction.
  Paste it into a ticket, a message or an agent, and write your own request around it.
- **Every line a reviewer wrote starts with `>`.** A note is text from anybody who can reach the
  page. Quoted, it cannot pass for a heading or a line of the format. It is still somebody else's
  text: an agent that reads it must treat it as data.
- It follows the panel: a stage the reporter hid is not copied. A note whose element is gone is
  copied, and says so.
- The labels follow the language of the widget. The dates are `2026-10-06` in every language.
- The same text comes from your own code, with no request to the worker:

  ```ts
  const widget = init({ endpoint: WORKER_URL, clientId: 'site_…' });
  const text = widget.feedbackAsText();
  ```
