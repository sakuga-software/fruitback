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
| 9   | console | click « Install the extension »: the store opens in a tab          | stays           |
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
FRU-484 made the pin a tip (19 actions). FRU-485 pressed « Leave a note » for the person at the
first activation (18 actions). The spec also measured that the setup goes on in its first tab after
the link, while the tab of the link says « You are signed in … You can close this one »
(`sign-in.tsx`, the choice P4 of the mockup).

The setup ends by itself at the first note (`setup-install.tsx`). The spec does not check it: the end
reads `lastNoteAt` of the site, which comes from the index of the notes (`notes-index-postgres.ts`),
and the worker of the tests has no index (its PostgreSQL is port 1, `cloud-worker.fixture.ts`).

### What FRU-610 changed, and what it did not

FRU-610 (board P6 of FRU-598) took the two questions of access out of step 2 of the setup, made one
way the recommended one at step 3, took « Connect this browser » away from beside « Install the
extension » on the Cloud, and shows the note that came at the end (`console.md`). Step 9 of the table
is now « Install the extension », with no « (beta) ».

**The table still counts 18 actions, measured.** The spec counts what the person clicks, types or
switches to, and it never answered the two questions: it took the values the form had chosen, as a
first user in a hurry does. So the questions were never rows of the table, and taking them away
removes no row. What the person no longer does is read two groups of choices and decide who sees
their notes before a single note exists: a decision, not a click, and the reason of the board P6.
The link that went from step 3 was not a row either: the path goes through the welcome page, which
the link competed with.

The ticket asked for fewer than 18. **No row of this table can go without a change of the sign-in or
of the tab of the link**, which FRU-610 does not make:

- **Step 13, « Connect Chrome » after the word.** The console of the Cloud could ask the extension of
  the same browser whether the request of the word is its own (the channel of FRU-487), and approve it
  with no press when it is: 17 actions. That changes who may connect a browser with no word and no
  press, so it is a decision on permissions, for a ticket of its own.
- **Step 6, the return to the tab of the setup.** The tab of the link could carry on the setup in place
  of the first one: 17 actions. The choice P4 of the mockup of 2026-10-13 is the opposite (the first
  tab goes on, the tab of the link says to close it), so it is not changed here.

### The path after the tickets

FRU-482 to FRU-485 gave **18 actions**, all done: steps 1 to 11, then on the welcome page « Sign in
with email » and « Connect Chrome » in the console tab that the extension opens and closes (FRU-482,
done), « Turn on <site> » on the welcome page (FRU-483, done), « Allow » in Chrome, and on the site
that opens the element, the text and « Send ». The 3 actions that only Chrome draws stay. One return
to a tab stays (step 6). No action leads to a dead end.

With question 1 answered yes (FRU-487), the console of the Cloud connects the extension of the same
browser in place, with no word to check and no tab to open: about **15 actions**.

A sign-in with Google or GitHub, where the instance offers it, can replace steps 2 to 6 with one click
and the consent of the provider. **Not measured**: the worker of the tests offers no provider. Since
FRU-635 the setup offers them first, above the e-mail.

**From the landing, with the address** (FRU-635, board S1): `/setup?site=<address>` adds the site once
the person is signed in, so « type the address » and « Add site » go. Measured by
`e2e/console-setup.spec.ts` up to step 3: **6 actions instead of 8** with an e-mail link. The board S2
estimates 13 actions to the first note with Google; the e-mail path from the landing is 16.

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
- **The Mac of the release is busy when the job starts, so the guide waits for it** (FRU-732,
  `e2e/guide-machine.ts`): up to 300 s for a load under the number of CPUs, then one launch of the
  full Chromium before the spec. On 23 Macs of GitHub, the first launch of Chromium took 5.5 to
  11 s, and the welcome page of the extension came up to 16 s after it: past the 10 s of
  `extension.ts`, which failed v0.8.0. The tab of a sign-in link waits for the tab of the setup by a
  Web Lock, not 400 ms ([console.md](console.md), FRU-235), which failed v0.7.0. With both: 12 runs
  of 12 on 6 Macs. Without them: 3 failures in 7 first runs on a fresh Mac (the releases v0.6.0 to
  v0.8.0, and 4 Macs measured).
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
with « Leave a note ». Folded, as the ticket proposed: the cards stay the first thing of the step,
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

## One sign-in, then the destination in the same move (FRU-664, a framing)

Mathieu asked on 2026-11-22 for fewer actions on the path of a person who installs the extension and
never writes a script tag, from the install to a note that arrives in the right place. He gave three
leads: one sign-in that creates the account and connects the destination, a default source and
destination for the first site, and a site turned on from the popup alone. This section is the
framing, written before any code. It counts what exists, says which leads hold, and lists the
tickets.

### The rules, in short

- **The team side is measured before anything is cut.** `first-note.spec.ts` stops at a note kept by
  Fruitback. A second walk, `e2e/first-destination.spec.ts`, counts the actions from a signed-in owner
  to a note that arrives in a tracker, against the stub of Linear of the tests. It writes its table here,
  as the first walk does. The count below is read from the code, and the spec replaces it.
- **No account is created by a connection of a tracker.** The token of Linear is an application
  (`actor=app`), and the user token of the GitHub App is used once and kept nowhere. Neither names a
  person, and neither says that an address is verified. An account still comes only from the e-mail
  link, Google or the sign-in with GitHub, which `databaseHooks.user.create` checks (`auth.ts`).
- **The setup offers the destination in the moment it is wanted.** Step 3 of the setup shows « Where
  the notes go »: « Keep them in Fruitback » (chosen), « Send to Linear » and « Send to GitHub ». A
  click on a tracker mints the ticket of the connector there, since the person is the owner of the
  workspace they just made, and opens the consent of the provider. The callback goes back to the setup
  (`?connected=<kind>`), not to « Connectors ».
- **A connection started from the setup becomes the destination of the site.** When the tracker answers
  one team, or one repository, the worker writes it as the place of the site at once. With several, step 3
  shows one list, and the choice writes it. A connection made from « Connectors » changes no site, as
  today.
- **The default destination stays Fruitback.** A first site with no choice keeps its notes in the
  worker (`place` null, FRU-651), and the first note arrives with no question. A worker that keeps no
  tasks (`FRUITBACK_TASKS=off`) shows the step with no « Keep them in Fruitback »: a destination is then
  required.
- **Two GitHub Apps stay two.** The sign-in is an OAuth App that reads a profile and an address. The
  connector is a GitHub App that writes issues in the repositories an organisation picks. One App for both
  would show the permissions of the issues to every person who only signs in. Changing the settings of
  the App of the Cloud is an action of Mathieu.
- **The extension creates the first workspace, through the console it already opens.** A sign-in from
  the extension goes through the page « Connect » of the console (FRU-482). An account with no workspace
  is sent from there to the setup today. Instead, the page makes the first workspace as the setup does
  (`firstWorkspace`, named from the address), then approves the browser. The popup then shows « Not in
  your sites yet » and « Turn on » (FRU-255, FRU-453): the person adds the site, chooses where its notes
  go and turns it on, and never sees the setup. No new route for the token of an extension.

### What exists today

Measured on `main` at `581d4f86`, read from the code.

- **Sign-in**: the e-mail link, Google and GitHub (`socialProviders` of `auth.ts`), each one when its
  variable is set. There is no sign-in with Linear: `/console/auth/start/linear` answers `404`
  (`auth-routes.test.ts`). The three buttons of the popup open the page « Connect » of the console,
  which signs in its own way.
- **GitHub has two Apps on the Cloud**: the OAuth App of the sign-in (`FRUITBACK_AUTH_GITHUB_OAUTH`,
  `read:user` and `user:email`) and the GitHub App of the connector (`FRUITBACK_GITHUB_CONNECTOR`, Issues
  in read and write, Metadata in read). A self-hosted worker can have a third, the App of its own store.
  [worker.md](worker.md) says why the sign-in has its own: « an App has one callback ».
- **A connection takes a ticket**, which `POST …/connectors/linear/oauth`, `…/github/start` and
  `…/<kind>/oauth` mint for `manage-workspace`, spent once in a minute (`oauth-flow.ts`). The callback
  checks the role again and goes back to `/w/<id>/connectors`.
- **The setup chooses no destination**: « The step « Source » is gone: a tracker is chosen in
  Connectors, after » ([console.md](console.md)). The end of step 3 says that the note « waits in the
  workspace », with a link « Connect Linear or GitHub ».
- **The popup already adds a site and chooses its place**: `POST /session/sites` (FRU-255), then
  `POST /session/sites/settings` with the lists of FRU-453, for an owner or an admin. It cannot make a
  workspace or connect a tracker.
- **The vocabulary.** A « source » of the console is a connector (Linear, GitHub, an address, a
  plugin), the same thing as a destination seen from a site. The widget and the extension are
  « modes » ([modes.md](../modes.md)). « A default source and destination » of the ticket is one thing:
  where the notes of the first site go.

### The team side, counted from the code

From an owner signed in, with a site and no destination, to a note in Linear. A list and not a table:
`first-note.spec.ts` reads every row of a table of this page that starts with a number as a row of
the path above.

1. In `console`: « Connect Linear or GitHub » at the end of the setup.
2. In `console`: « Connect » on the tile of Linear, in « Connectors ».
3. In `linear`: choose the workspace of Linear, then « Authorize ».
4. In `console`: open the site, then the tab « Destinations ».
5. In `console`: « Add a destination… ».
6. In `console`: choose the team.
7. In `console`: choose « Whole team » or a project.
8. In `site`: the element, the note, « Send »: 3 actions.

**About 10 actions after the first note, and two of the screens are found by the person.** With the
rules above: « Send to Linear » at step 3 of the setup, the consent of Linear, and the team chosen in
one list when there are several: **3 actions, or 2 with one team**, and the next note goes to Linear.
The extension path counts **18 actions** today ([The path](#the-path)). Making the workspace on the
page « Connect » takes the detour through the setup away for a person who starts from the extension.
It saves the setup's own steps for them, and the spec counts how many.

### The decisions

The orchestrator took the four recommendations on 2026-11-28.

1. **A sign-in with Linear creates no account.** GitHub already does, through its OAuth App. A
   Linear token of an application names no person, and a token of a person carries no verified
   address. To be looked at again if Linear offers OpenID Connect.
2. **The destination by default is Fruitback**, unless the person chose « Send to … » at step 3 of
   the setup. A sign-in with GitHub does not say that the team tracks its work in GitHub, and a note
   sent to a public repository is public.
3. **Two GitHub Apps stay two.** GitHub Apps take several callbacks now, so the reason of before is
   gone, but the permissions are not the same, and every person who signs in would read « write
   issues ». The cost of two is one more consent, only for whoever chooses « Send to GitHub ». Nothing
   here changes the settings of the App of the Cloud: that would be an action of Mathieu.
4. **The page « Connect » makes the first workspace** of an account that has none, as the setup does,
   and only on a sign-in started by the extension. The setup stays the way of a person who starts from
   the console or the landing.

### The tickets

| Ticket  | What                                                                                    | Critical |
| ------- | --------------------------------------------------------------------------------------- | -------- |
| FRU-752 | `e2e/first-destination.spec.ts` counts the team side, and replaces the table above      | no       |
| FRU-753 | Step 3 of the setup: « Where the notes go », and the connection becomes the destination | yes      |
| FRU-754 | The page « Connect » makes the first workspace on a sign-in started by the extension    | no       |

## The funnel, on the Cloud only (FRU-644, a framing)

Mathieu decided on 2026-11-19 (FRU-637) that a funnel measure is acceptable on Fruitback Cloud only,
and absent from a self-hosted instance. On 2026-11-28 he chose the tool and the consent: « ok pour
server et client sur la version cloud only, pas forcément anonyme, avec une bannière de cookie claire
sur le sujet ». This section is the framing, written before any code. The tickets are at the end of
this section.

### The rules, in short

- **The tool is PostHog, in its EU region**, with events from the server (the worker) and from the
  browser (the landing, the setup, the console). It is the only service of a third party the funnel
  uses, and Mathieu chose it.
- **On the Cloud only.** The worker sends an event only when two things hold: the key is set, and the
  host of `FRUITBACK_PUBLIC_URL` is the host of the Cloud, as `pairsByCode` reads it (`pair-page.ts`).
  A self-hosted instance that sets the key by mistake sends nothing, and the boot says so in one line.
  On a self-hosted instance the console loads no script of PostHog, draws no banner, and sends
  nothing.
- **The keys are variables that Mathieu sets**: `FRUITBACK_POSTHOG_KEY`, the project key, which is
  public; and `FRUITBACK_POSTHOG_HOST`, `https://eu.i.posthog.com` by default. The worker hands the
  key and the host to the browser in `GET /analytics`, on the Cloud only. Elsewhere that route answers
  `404`, and no build of the console or of the landing carries a key.
- **Nothing of PostHog runs in a browser before its consent**: no script, no cookie, no event. A banner
  asks first, on the landing, the setup and the console. « Accept » and « Refuse » are two buttons of
  the same size and weight, side by side, and the banner says what is measured, by whom, and links to
  `privacy.md`. The choice can be changed at any time: « Cookie settings » in the footer of the landing
  and in « My account ».
- **The choice is kept in a first-party cookie**, `fruitback_consent`, on `.fruitback.com`, so that
  the landing, the setup and the console share it. It holds `granted` or `denied` and the date, and
  lasts 6 months; the banner then asks again. It is the one cookie written before the consent, and it
  holds no identifier. A signed-in person's choice is also written on their account, so that the
  worker knows it.
- **Once consented, the events may name the person.** The `distinct_id` is the id of the account, and
  the workspace is a group (`$groups.workspace`). Never an e-mail, a name, the text of a note, an
  address of a page of a site, or anything of a visitor.
- **Before the consent, or after a refusal, the server sends no identifier.** An event of the worker
  then carries a random `distinct_id`, used once, and `$process_person_profile: false`, so PostHog
  builds no profile. It holds no account id, no workspace id, no address and no property but the step
  and its kind. The worker sends from its own address, so PostHog never sees the address of the
  person.
- **A send never slows a request and never fails one.** The worker sends after the answer, with a
  timeout of 2 s, and a failure is one line in the log. Nothing is queued or sent again.
- **The steps are all six**: `setup_opened`, `account_created`, `workspace_created`, `site_added`,
  `widget_first_seen` and `first_note`. Each one says where it is sent from, below.
- **A deleted account is deleted in PostHog too**, with the API of PostHog and a personal key that can
  delete persons only (`FRUITBACK_POSTHOG_PERSONAL_KEY`). Without that key the worker deletes nothing,
  and `privacy.md` says how long PostHog keeps the events.
- **`docs/privacy.md`, `SECURITY.md` and the CSP change with the code that sends**, never before: a
  page that says what the product does is written when it does it. The CSP of the console of the
  Cloud allows the host of PostHog in `connect-src`, and the script of PostHog is a chunk of the
  console, loaded after the consent, not a script of another host.

### The steps

| Step                | Sent from                                                                                              | When                                         | Properties                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- | --------------------------------------------- |
| `setup_opened`      | the browser, `setup.tsx`                                                                               | the setup opens, after the consent only      | `from`: `landing` (with `?site=`) or `direct` |
| `account_created`   | the worker, after `databaseHooks.user.create` (`auth.ts`)                                              | an account is made                           | `provider`: `email`, `google` or `github`     |
| `workspace_created` | the worker, `POST /console/workspaces`, and the page « Connect » of FRU-754                            | a workspace is made                          | none                                          |
| `site_added`        | the worker, `accounts.addSite` (`POST …/sites` of the console, `POST /session/sites` of the extension) | a site is added                              | `from`: `console` or `extension`              |
| `widget_first_seen` | the worker, `site-seen.ts` (FRU-721)                                                                   | the first date of a way is written on a site | `way`: `script` or `extension`                |
| `first_note`        | the worker, `index.record` (`feedback-routes.ts`)                                                      | the first note of a site is indexed          | `channel`: `script` or `extension`            |

- **The setup opened is an event of the browser only.** The page makes no call of its own when it
  opens (its first call, `GET /console/me`, is made by every page), and a call made only to count it,
  before the consent, would count a person who did not answer the banner. So the funnel sees the
  setups of the people who accepted, and PostHog's own count of the banner says how many those are.
- **The server events of a site** (`widget_first_seen`, `first_note`) are caused by a visitor of the
  site, not by the person of the account. They carry the group of the workspace, and the account of
  its owner as `distinct_id`, only when that owner consented. Otherwise they carry no identifier.
- **Who consented, on the server**: the choice of a signed-in person is written on their account
  (`user.analytics_consent`, `granted`, `denied` or empty, with its date) by the console, when the
  banner is answered or the choice changed. Empty is « no identifier ».

### What exists today

Measured on `main` at `581d4f86`.

- **No analytics, no `/metrics`, no telemetry of a third party.** better-auth's telemetry is forced
  off (`auth.ts`), and `BETTER_AUTH_TELEMETRY` is refused at boot (`env.ts`). The worker logs no
  request.
- **No cookie of Fruitback on the landing.** The console keeps the cookie of its session, on its own
  host.
- **Each step already has its place in the code** (the table above): `databaseHooks.user.create`,
  `createWorkspaceWithPlugin`, `accounts.addSite`, `markSiteSeen` (which writes a date only when the
  one before is an hour old, so the first date is known), and `index.record`.
- **The Cloud is a host, not a flag.** The worker knows it by the host of `FRUITBACK_PUBLIC_URL`
  (`pairsByCode`), the console by the host of its API (`instanceOf(api).cloud`). The same image runs
  on the Cloud and in a self-host.
- **The CSP of the console** is in `apps/console/nginx.conf.template`.

### Why

- **Why the consent before any script.** A banner that loads PostHog first and asks after has
  already set its cookie. The script is a chunk that the console imports after « Accept », so a
  refusal loads nothing.
- **Why anonymous server events without the consent.** The worker sees the steps that matter most
  (an account, a workspace, a site) whatever the browser chose. An event with a random id used once,
  no profile, no property that names anything, and the address of the worker, is a count and nothing
  more. Mathieu allowed events that name a person; the consent is what lets them.
- **Why the host of the Cloud and the key both.** The key alone would let a self-hosted instance
  that copied the variables of the Cloud send events. The host alone would need no key, and the
  events would have nowhere to go.
- **Why the key comes from the worker.** A build of the console or of the landing with a key in it
  would carry it into every self-hosted image built from `main`.

### The decisions

Decided by Mathieu and the orchestrator on 2026-11-28:

1. PostHog, EU region, server and browser events, on the Cloud only.
2. The events may name the person once they consented; never before.
3. A banner, with « Refuse » as easy as « Accept », and a choice that can be changed.
4. All six steps, « Setup opened » and « Account created » included.
5. The keys are variables that Mathieu sets.

The opt-in of the owner of a workspace, and the counts by weekly cohort that this section framed
first, are dropped: PostHog makes the cohorts, and the consent is the person's.

### The tickets

| Ticket  | What                                                                                                     | Critical |
| ------- | -------------------------------------------------------------------------------------------------------- | -------- |
| FRU-755 | The worker: the keys, `GET /analytics`, the consent on the account, the five server events, the deletion | yes      |
| FRU-758 | The banner of the cookies: the landing, the setup and the console, and « Cookie settings »               | yes      |
| FRU-756 | The browser: PostHog loaded after the consent, `setup_opened`, the CSP of the console of the Cloud       | yes      |

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
