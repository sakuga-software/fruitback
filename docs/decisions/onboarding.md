# Onboarding: from the install to the first note (FRU-481, a framing)

Mathieu asked on 2026-10-28 for fewer actions between the install of the extension and the first note,
for a first user above all, and for a guide on the setup page that stays true at each release of the
extension. This page is the framing: the path measured on `main` at `389ac285`, what each action
becomes, and the tickets. The table of the path follows each ticket that changes it.

## The path

### The rules, in short

- **The path is measured, not described.** `e2e/first-note.spec.ts` drives the real console, the real
  extension and the real widget against one worker of the Cloud, and writes each action of the person
  with the place it happens. A change to the path changes that list in the same pull request.
- **Three actions belong to Chrome, and no automation reaches them**: the button of the Chrome Web
  Store, the dialog « Add extension », and the prompt for the access to a site. The spec writes them
  down as `store` or `chrome` and counts them; it does not do them. The prompt stays: the extension
  asks for no host at install, on purpose (`extension.md`).
- **No step of the first path sends the person to a screen that cannot go on.** The welcome page of
  the extension said « click the icon, then Sign in with email », and the popup on that page offered
  no sign-in. Since FRU-482 the page signs in itself, and the popup offers the sign-in on any page.
- **The pin is a tip, not a step** (FRU-484). Nothing between the install and the first note needs it.
- **Firefox installs from addons.mozilla.org** (FRU-521 for the guide, FRU-536 for the console): its
  path is the Chrome path with AMO as the store. It is named here, and not measured.

### The path today

The path of a new person who signs in by e-mail, in the order the spec does it. The place is where
the action happens: `console`, `mail`, `tab` (going back to a tab that is already open), `store`,
`chrome`, `welcome` (the page of the extension that opens at install), `popup`, `site`.

| #   | Place   | Action                                                             | Becomes         |
| --- | ------- | ------------------------------------------------------------------ | --------------- |
| 1   | console | open fruitback.com, then « Set up »                                | stays           |
| 2   | console | type the e-mail address                                            | stays           |
| 3   | console | click « Email me a link »                                          | stays           |
| 4   | mail    | open the mailbox, then the message                                 | stays           |
| 5   | mail    | click the link: a new tab opens                                    | stays           |
| 6   | tab     | go back to the tab of the setup                                    | stays (SPEC P4) |
| 7   | console | type the address of the site                                       | stays           |
| 8   | console | click « Add site »                                                 | stays           |
| 9   | console | click « Install the extension (beta) »: the store opens in a tab   | stays           |
| 10  | store   | click « Add to Chrome »                                            | stays           |
| 11  | chrome  | click « Add extension » in the dialog of Chrome                    | stays           |
| 12  | welcome | click « Sign in with email »: the console opens in a tab           | stays           |
| 13  | console | click « Connect Chrome » after the word                            | stays           |
| 14  | welcome | click « Turn on <site> »: the site opens in a tab                  | stays           |
| 15  | chrome  | click « Allow » in the prompt of Chrome for the access to the site | stays           |
| 16  | site    | click the element of the page                                      | stays           |
| 17  | site    | type the note                                                      | stays           |
| 18  | site    | click « Send »                                                     | stays           |

**18 actions: 3 in the screens of Chrome and its store, 1 return to a tab that is already open, and
no dead end.** The welcome page signs in itself (FRU-482): it shows the word that the console shows,
claims the session, closes the tab of the console and says who signed in. It then lists the sites of
the workspaces of the account, and « Turn on <site> » asks Chrome for that site, writes the rule and
opens the site with its widget (FRU-483). The popup on a page that is not a site offers the sign-in
too. Pinning Fruitback (the puzzle menu, then the pin: 2 actions in Chrome) is a tip under the
sign-in, which no step of the path needs (FRU-484). The first activation of a site opens the choice
of an element by itself, once (FRU-485).

### What was measured first

On `main` at `389ac285` the path counted **27 actions**, with **1 dead end**: the welcome page said
« click the icon, then Sign in with email », and the popup on that page said only « Fruitback works
on http and https pages. » (`notAWebPage`). The person went back to the setup, opened the site,
signed in from the popup there, and went back to the site after the console. FRU-482 removed those
three actions and the dead end (24 actions). FRU-483 removed the return to the setup, its link to
the site and the two clicks on the icon, as « Turn on » moved to the welcome page (21 actions).
FRU-484 made the pin a tip (19 actions). FRU-485 pressed « Leave feedback » for the person at the
first activation (18 actions). The spec also measured that the setup goes on in its first tab after
the link, while the tab of the link says « You are signed in … You can close this one »
(`sign-in.tsx`, the choice P4 of the mockup).

The setup ends by itself at the first note (`setup-install.tsx`). The spec does not check it: the end
reads `lastNoteAt` of the site, which comes from the index of the notes (`notes-index-postgres.ts`),
and the worker of the tests has no index (its PostgreSQL is port 1, `cloud-worker.fixture.ts`).

### The path after the tickets

FRU-482 to FRU-485 gave **18 actions**, all done: steps 1 to 11, then on the welcome page « Sign in
with email » and « Connect Chrome » in the console tab that the extension opens and closes (FRU-482,
done), « Turn on <site> » on the welcome page (FRU-483, done), « Allow » in Chrome, and on the site
that opens the element, the text and « Send ». The 3 actions that only Chrome draws stay. One return
to a tab stays (step 6). No action leads to a dead end.

With question 1 answered yes (FRU-487), the console of the Cloud connects the extension of the same
browser in place, with no word to check and no tab to open: about **15 actions**.

A sign-in with Google or GitHub, where the instance offers it, can replace steps 2 to 6 with one click
and the consent of the provider. **Not measured**: the worker of the tests offers no provider.

### Why the welcome page carries the path

The welcome page is the tab that Chrome shows after the install: the person is there, and it is a
page of the extension. A click on it is a gesture of the person, so `permissions.request` for the
origin of a site works there, as in the popup. It can start the sign-in (`/session/connect`) and read
the sites of the account (`GET /session/sites`). It needs no new permission, no route of the worker,
and no change to who may connect: the request still starts in the extension, and the word is still
checked in the console.

The popup stays the way in for every later visit. The dead end of the popup on a page that is not a
site is fixed too (FRU-482): signed out, it offers the sign-in there as well.

## The guide

### The rules, in short

- **The captures of the guide come from a spec, never from a hand** (FRU-486). `first-note.spec.ts`
  walks the path above and captures each step on the way, under the name of the step:
  `docs/assets/guide/<step>.png`. No second walk: the guide shows the path that is measured, and CI
  pays no second run of it. `pnpm guide:captures` writes the captures that changed, and only those.
- **The captures are taken on a Mac**: their fonts are the fonts of the mockups, and of the machine of
  the person who reads the guide most. On another system the fonts differ, and so would the
  captures. The release takes them on `macos-latest` of GitHub, not on the `sakuga-mac` pool: this
  repository is public, and the self-hosted runners serve the private repositories only.
- **The release takes them again** (`release-extension.yml`): on a tag `v*`, after the checks of
  `ci.yml`, the job `guide` runs `pnpm guide:captures` on the tagged commit. It holds no secret and
  only reads: what changed, added, changed or removed, leaves it as a binary patch (the artifact
  `guide-captures`). When nothing changed, there is no patch and no pull request. The job
  `guide-pr` runs no code of the repository: it applies the patch to the tag, and a token of the App,
  minted there only, pushes `guide/<tag>` and opens « docs: the guide of <tag> » on `main`. The
  token of the App, and not the one of the run: GitHub starts no workflow for a pull request that
  the token of a run opened, and that pull request needs `ci.yml`. A run from a branch
  (`workflow_dispatch`) is the release of test: it stops at the artifact. The release does not wait
  for these jobs: a capture that fails publishes the extension all the same.
- **The video of the welcome page comes from the same walk** (FRU-531). From the site to the pin,
  `first-note.spec.ts` takes a frame at each step (`DEMO_FRAMES` of `apps/extension/src/demo-video.ts`,
  `docs/assets/video/<frame>.png`), in one box of 16/9 around the element, with a pointer drawn on
  the page. When a frame changed, `e2e/demo.ts` joins the frames with `ffmpeg` into
  `apps/extension/public/demo/first-note.{webm,mp4,jpg}`: each frame held for its seconds, one
  thread, `bitexact`. A recording of the browser would differ at each run by its timing, and a
  release would open a pull request for a video that shows the same thing; frames compared like the
  captures write nothing when the screens did not change. Measured on 2026-10-30: two joins of the
  same frames give the same bytes, and a second capture run wrote no frame and no video. The job
  `guide` installs `ffmpeg` where the runner has none, and `guide-pr` takes those paths too. The
  extension serves the files: the welcome page fetches nothing, and a capture of the guide pauses the
  video on its first frame.
- **One source for the words**: `apps/console/app/guide-steps.ts`. Step 3 of the setup shows it, in
  English and in French; `docs/reviewing.md` holds a copy of it in English, between
  `<!-- guide:start -->` and `<!-- guide:end -->`, that `guide-steps.test.ts` holds to the source.
- **A guard holds the names**: before each capture, the spec finds each control that the step names,
  by its role and its accessible name, on the built extension or the console. A renamed button fails
  the spec in every run of CI, where the captures go to the output of the test and not to the
  repository. `guide-steps.test.ts` checks the same names in the sources, and that the French of the
  guide is the French of the extension.

### What the guide is

**Five steps, folded under the two cards of step 3** (`setup-guide.tsx`), with the version of the
extension that took the captures: the welcome page and « Sign in with email », the word in the console
and « Connect Chrome », « Turn on <site> », the note on the site, and the popup on a site that is on
with « Leave feedback ». Folded, as the ticket proposed: the cards stay the first thing of the step,
and the guide is one click away for who wants it. Under the cards and not inside the card « Browser
extension »: the column of the setup is narrow, and a capture inside the card would be smaller still.
Measured at 1440 px: the column draws a capture 292 px wide, about half of its size, so a click on a
capture opens it whole in a tab. **On Fruitback Cloud only**: the guide walks the sign-in of the
Cloud, and a self-hosted console connects a browser by a pairing link.

**What varies is replaced before a capture**: the word of the sign-in (`PLUM 42`), the id of the site
in the script tag and its addresses (those of the Cloud, `app.` and `api.fruitback.com`, for the ones
of the test), and the text of the note. Each box is read until it stops moving: the composer opens
with a motion, and a box read in its middle cut the capture short in some runs. The composer still
sits a fraction of a pixel apart from a run to the next (x from 267.05 to 267.34 in four runs), so
the edges of a capture are rounded and its size is a multiple of 8 pixels. React's text nodes are
changed in place (`nodeValue`), never replaced, so a later render finds the nodes it made. A capture then changes only when a screen does. A
capture that differs by at most 0.2 % of its pixels is the same capture (`maxDiffPixelRatio` of
`toHaveScreenshot`).

**The console serves a copy of the captures**, `apps/console/public/guide/`, because its image is
built from `apps/` and `packages/` alone: a `COPY` of `docs/` would change its Dockerfile and the
paths that build the images in CI. `guide-steps.test.ts` holds the copy to the docs byte for byte. The
version is in their address, so a browser reads the captures of a new release.

**The captures in French**: none. The captures are of the extension in English, and the French guide
names the controls in French, as the extension draws them for a French browser.

Before FRU-486, `docs/reviewing.md` showed five captures made by hand for FRU-322 on 2026-10-20
(`docs/assets/guide-*.png`, removed), and step 3 of the setup showed no guide.

## The questions

1. **May the console talk to the extension of the same browser?** (FRU-487) `console.md` says that a
   content script on the console and `externally_connectable` are not wanted. With
   `externally_connectable` limited to the console of the Cloud, step 3 of the setup sees the
   extension and connects it in place. The cost: the extension trusts a page of the Cloud to ask for
   a session with no word. **Decided by Mathieu on 2026-10-28: yes**, for the console of the Cloud,
   after FRU-482 and FRU-483. Done in FRU-487: Chrome and Edge with the extension of the store, one
   click at step 3; Firefox, Safari and a self-hosted console keep the way of FRU-482. The path that
   « What was measured » counts is the way of FRU-482, which every browser has.
2. **Does the first activation open the choice of an element by itself?** (FRU-485) Yes, once per
   origin, when the welcome page turns a site on, never at a load of a page. The extension sends the
   command of the popup (`leave-feedback`): the widget knows no extension. The origins it opened on
   are kept in `chrome.storage.local` under `fruitback:first-pick`, a list of origins and nothing
   else. An origin is written before the choice is asked, so a second activation meanwhile does not ask
   again, and taken out if the widget did not answer: a widget that did not load within 10 s, or that
   was busy, gets the choice at the next activation. **Not from the popup**:
   there « Turn on » is the act of somebody who may come to read the notes first, and « Leave
   feedback » is one click away on the screen that follows. Measured: pressing it for them there
   broke fifteen specs that turn a site on from the popup and expect the widget at rest.
3. **Where does the guide show?** (FRU-486) Folded under the cards of step 3, not on a page of its
   own: see « What the guide is ».

## The tickets

| Ticket  | What                                                                         | State |
| ------- | ---------------------------------------------------------------------------- | ----- |
| FRU-482 | The welcome page signs in itself; the popup on a page that is not a site too | Done  |
| FRU-483 | The welcome page offers « Turn on <site> » and opens the site                | Done  |
| FRU-484 | The pin is a tip                                                             | Done  |
| FRU-485 | The first activation opens the choice of an element                          | Done  |
| FRU-486 | The guide on the setup page, its captures made again at each release         | Doing |
| FRU-487 | The console talks to the extension of the same browser                       | Done  |
