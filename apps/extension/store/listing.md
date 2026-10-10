# The store listing

What goes in the forms of the Chrome Web Store and of addons.mozilla.org (FRU-81). Each block is
text to paste. The source of every claim about data is [docs/privacy.md](../../../docs/privacy.md),
and the source of every claim about a permission is [wxt.config.ts](../wxt.config.ts). If one of
them changes, change this file and the listing.

This is what the code does. It is not legal advice.

## The listing

**Name**

```text
Fruitback
```

**Summary** (132 characters at most)

```text
Click an element on a site you review, write a note, and it becomes an issue in your team's own tracker.
```

**Category**: Developer Tools. **Language**: English.

**Description**

```text
Fruitback is a visual feedback tool for a site under review. Click an element on the page, write a note, and the note becomes an issue for the team that builds the site. Come back to the page later and your pins are still there, coloured by the state of each issue.

This extension is for the reviewer. It puts the Fruitback widget on a site that does not embed it, so nobody else who visits that site sees anything.

HOW IT WORKS
1. Open the page you review and click the Fruitback icon.
2. Enter the address of the Fruitback worker your team runs, and turn the site on. The browser asks you for access to that one site.
3. Click "Leave feedback", pick an element, write your note, send it.

WHAT IT ASKS FOR
Nothing at install. The extension can read no page until you turn a site on, and it asks then, for that site only. Turn the site off and the extension stops running there.

WHERE YOUR NOTES GO
To the worker address you entered, and nowhere else. Fruitback is open source and self-hosted: the publisher of this extension runs no server that receives your notes, and collects no analytics.

YOU NEED A WORKER
The extension is one half. The other half is a Fruitback worker, a small server your team runs with Docker. It stores the notes in Linear, in GitHub Issues, or in a SQLite file. The guide is at https://sakuga-software.github.io/fruitback/

TRY IT
A public sandbox runs at https://demo.fruitback.com/?widget=off with the worker https://api.demo.fruitback.com. Anybody can write there, and it is emptied every night.

Source code and licence (AGPL-3.0): https://github.com/sakuga-software/fruitback
```

**Screenshots** (1280 × 800, in this folder, taken on the sandbox)

| File                    | Caption                                           |
| ----------------------- | ------------------------------------------------- |
| `1-pick-an-element.png` | Pick the element your note is about.              |
| `2-write-a-note.png`    | Write the note. A name is optional.               |
| `3-the-pin-stays.png`   | The pin stays on the page, with the team's reply. |

The store also wants one picture of the popup. Take it by hand after you load the extension: an
automated browser cannot open the popup from the toolbar.

**Links**

| Field          | Value                                                      |
| -------------- | ---------------------------------------------------------- |
| Homepage       | `https://sakuga-software.github.io/fruitback/`             |
| Support        | `https://github.com/sakuga-software/fruitback/issues`      |
| Privacy policy | `https://sakuga-software.github.io/fruitback/privacy.html` |

## Privacy practices (Chrome Web Store)

**Single purpose**

```text
Fruitback lets a reviewer leave notes pinned to elements of a web page, and sends each note to the feedback server that the reviewer's own team runs.
```

**Permission justifications**

`storage`

```text
Stores the list of sites the user turned on, with the server address the user entered for each one. In team mode it also stores the session tokens the user's server issued. Everything stays in the extension's own storage, which no web page can read.
```

`scripting`

```text
Registers the extension's two content scripts at runtime, only for the sites the user turned on and granted. No content script is declared in the manifest, so the extension runs on no site by default. The scripts are files packaged in the extension.
```

`activeTab`

```text
Lets the popup read the address of the tab it was opened on, so it can name the site and offer to turn Fruitback on for it. Without it the popup cannot tell which site the user is on.
```

`alarms`

```text
In team mode, renews the short-lived access token before it expires. A Manifest V3 service worker can be stopped at any moment, so a timer inside it is not reliable.
```

Host permission (`optional_host_permissions: *://*/*`)

```text
The extension requests no host access at install. The pattern is optional and wide because the user chooses which site to review, and that can be any staging or production site. Access is requested for one origin at a time, when the user clicks "Turn on for this site". When the user turns a site off, the extension unregisters its scripts for that site, runs nothing there, and gives the access to that site back to the browser. In team mode the extension also asks for access to the address of the user's own feedback server, to send the notes to it.
```

**Remote code**: No.

```text
All JavaScript is packaged in the extension. It loads and evaluates no code from a server.
```

**Data usage**. Tick these three and no other:

| Category                            | Why                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Personally identifiable information | The optional name a reviewer types beside a note.                                                    |
| Authentication information          | In team mode, the session tokens of the user's own feedback server, kept in the extension's storage. |
| Website content                     | The note, the address of the page, and the selector and a short excerpt of the text of the element.  |

Do not tick « Web history »: the extension sends the address of a page only with a note the user
writes on that page, and it keeps no list of visited pages.

Then tick the three certifications. Each one is true:

- The data is not sold or transferred to third parties. It goes to the server the user entered.
- The data is not used for a purpose unrelated to the single purpose.
- The data is not used to determine creditworthiness or for lending.

## Notes for the reviewer (Chrome: « Test instructions », AMO: « Notes to reviewer »)

```text
Fruitback needs a server. A public sandbox is available for the review. It holds no account and needs no login. It is emptied every night at 02:00 UTC.

1. Open https://demo.fruitback.com/?widget=off
   (a demo shop page that does not embed Fruitback)
2. Click the Fruitback icon in the toolbar.
3. Keep the mode "Private · the extension mounts the widget".
   Worker endpoint: https://api.demo.fruitback.com
   Client id: demo
4. Click "Turn on for this site" and accept the permission prompt for demo.fruitback.com.
5. A "Leave feedback" button appears at the bottom right of the page. Click it, click any element of the page, type a note, click "Send".
6. A pin appears on the element. Reload the page: the pin is still there.

To stop it: click the icon, then "Turn off here". The extension then runs nothing on the site, and gives its access to the site back to the browser.

The second mode, "Team", needs a paired session with a private server and cannot be tried on the sandbox. It uses the same permissions.
```

## Mozilla (addons.mozilla.org)

- **Add-on id**: `fruitback@sakuga-software.com`, already in the manifest.
- **Licence**: GNU Affero General Public License v3.0 only.
- **Source code**: AMO asks for it because the file is built. Upload `fruitback-<version>-sources.zip`,
  which the release workflow builds beside the Firefox archive.
- **Build instructions**, for the same form:

  ```text
  Node 26 (see .nvmrc) and pnpm 11.16.0, on Linux or macOS.

  pnpm install --frozen-lockfile
  pnpm --filter @fruitback/extension build:firefox

  The result is apps/extension/.output/firefox-mv3/.
  ```

- **Data collection**: use the same three categories and the same sentences as above.
