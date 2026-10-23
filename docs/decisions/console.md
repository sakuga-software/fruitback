# The console

The console of the Cloud, `apps/console`: its words, its kit, and what it shows of a connector.

## The console

### The rules, in short

- **The console speaks the language of its person** (FRU-120). `apps/console/app/i18n.ts`: the
  English sentence is the key (`t('Create your workspace')`), and `messages.fr.ts` maps it to French.
  A sentence in a table is marked with `msg` and translated where it is shown. `messages.test.ts`
  reads the screens: every sentence has French, the map holds no sentence no screen shows, and no text
  is shown that did not go through `t`. The language is the account's, then this browser's last
  choice, then the browser's own. **Every component that calls `t` calls `useLocale()` first**, and
  the guard fails on one that does not: `t` reads the language at render, so a component with no
  subscription keeps the old words. The root holds no `key` on the language: a screen mounted again
  loses what somebody typed and runs its effects twice. **`HydrateFallback` holds no word**: it is rendered when the console
  is built, and a word in another language is a hydration error in the browser.
- `apps/console` (`@fruitback/console`) — the console of the Cloud (FRU-99): React Router in SPA mode,
  Tailwind on the tokens of `design/README.md`, served as static files by nginx. **It holds no secret, and no
  token at all** (FRU-148): the session is a cookie of the worker that no script reads, and
  `transport.ts` sends it with every call (`credentials: 'include'`). There is nothing to refresh.
  See _The session of the console_ below for the worker of before, the `401` and the providers.
  The image hashes the inline scripts of `index.html` into its policy (`csp.mjs`), never
  `'unsafe-inline'`, and serves the widget's script (FRU-106) at `/v/<version>/fruitback.iife.js`,
  cached one year and `immutable`, which the snippet gives. The version is the version of the package
  and 12 hex characters of the sha256 of the file (`widget-version.ts`): the file at one address never
  changes. The address of before, `/fruitback.iife.js`, stays, cached five minutes, and the version of
  another image answers `302` to this one's. No third-party CDN: it would see the address of every
  visitor of every site.
  **The address of the worker is read when the page loads, not when it is built** (FRU-222):
  `/config.js`, which the container writes, sets `globalThis.__FRUITBACK__` before the bundle, and
  `apiFrom` of `instance.ts` reads it once. The file of the repository sets nothing, so `pnpm dev`
  and a console built with `VITE_FRUITBACK_API` keep the address of their build. The script tag is
  in `<head>` with neither `async` nor `defer`: a module starts after it. Nothing secret goes in
  that file. See [image.md](image.md).
- `design/` — the reference mockups of the Cloud and the simplified extension: the simpler flow of
  2026-10-13 (`design/simpler-flow/`, its `SPEC.md` and the texts of every state word for word) and
  the Claude Design export of 2026-10-07. **Build a screen that has a board to its board**: layout,
  words and tokens, and **the simpler flow wins** for each screen it draws. `design/README.md` says
  which screen belongs to which ticket.
- **The console connects an address, and shows the notes that did not arrive** (FRU-132). A source is
  drawn by its `kind`: a tracker has teams to choose, an address has none, so a site sends there or
  does not. **A secret that the worker made is on the screen once**, in the form that made the
  connector, and in no state after it. An address says « Connected », never « Working »: the list
  cannot know that its notes arrive. **No list of deliveries is not an empty list**: a worker that did
  not answer must not read as « every note arrived ». The same holds for the sites and the sources
  (FRU-162): `listed.ts` gives a read `loading`, `failed` or the list, only a list shows the empty
  state or a count, and a failed read says so with « Try again ».
  **« Who can leave a note? » is asked for a site that its members read, and only there** (FRU-330):
  `writers-pick.tsx`, in the form of the Sites screen and in the setup. « Members only » is chosen
  for a new site, and its detail says that private mode carries no session. The form sends `writers`
  only with `visibility: 'members'`. A row and the summary of the setup say the exception, « Notes
  from anyone on the page », and nothing for « Members only » or for a worker of before.
  **A gesture that cannot be undone asks twice** (FRU-165): « Remove » a site and « Disconnect » a
  source go through `Confirm` (`confirm.tsx`), which says what the gesture costs, gives focus to
  « Keep it », and acts only on a second button that names the site or the source. « Keep it » and
  Escape give the row back, with focus on its first button. `e2e/console-confirm.spec.ts` measures it
  on both screens, at 1440 px in English and 390 px in French (FRU-191).
  **A panel writes the whole list of a site, one write at a time** (FRU-123): a second gesture made
  before the first list is kept would start from the list of before and take the first change away,
  so the controls of the list are disabled while it is written. `e2e/console-destinations.spec.ts`
  holds a write open and tries the second gesture, on the panel of a Linear and of an address.
  **The panel of a source opens where it is seen** (FRU-161): from 1280 px in its column beside the
  list, as on the board; under 1280 px right under its row, which names it in `aria-controls`, and
  the page scrolls as far as the panel needs. `e2e/console-source-panel.spec.ts` measures it at 390,
  768 and 1440 px.
  **A panel that a person opens takes focus** (FRU-197): it is a region named after its source, focus
  goes to it when a press of its row opened it, and Escape closes it and gives focus back to the
  row. A panel that appears by itself takes none: the one a change of width mounts again. The same
  spec holds both. **Not measured: what VoiceOver and NVDA say**; the spec reads the role, the name
  and where focus is.
  **The console decides nothing about a domain** (FRU-103). The Sites screen shows, to an owner or an
  admin, the domains of the workspace (`domains.tsx`), under the row of a site, behind « Preview
  builds » of its menu (FRU-243): the `TXT` record to write, « Check the DNS »,
  and for a domain the worker says is proven, the site whose previews it covers. `state` is the
  worker's word; a DNS that did not answer is said as such, never as « not found »; a proof that is
  lost shows since when, and its record again. `e2e/console-domains.spec.ts` holds it.
  **A refused call says its own cause** (FRU-164): `problemOf` (`problems.ts`) gives the sentence of
  the code of the worker, « Fruitback did not answer. Try again. » for no answer and a `5xx`, and a
  sentence of the screen that blames no field for the rest. No failure clears a field. A copy goes
  through `copyText`, and a copy the browser refuses says so: the text stays on screen to select.
- **The members and the invitations come from the worker's routes of the organization plugin**
  (FRU-104): `members.tsx` lists the members to whoever may read them, and the invitations that
  wait to an owner or an admin, with « Resend » and « Cancel ». A guest sees their own row only, as
  the worker answers them nothing more. **The front door looks for an invitation first**
  (`home.tsx`): somebody who signed in from the message of an invitation lands on `/invitations`,
  not on the setup that makes a workspace of their own.
  **The screen is screen 12 of the mockup of 2026-10-13, with what the worker of today says**
  (FRU-247): the invitation on one line, a form named « Invite someone » with each field under its
  label, the table of the people (760 px at the least, which scrolls in its frame on a phone), and
  what each role does. **« Last seen » is for an owner or an admin** (FRU-249, Q7): a day of UTC and
  never an hour (« Today », « Yesterday », « 3 days ago », then the day; « Not seen yet » for who
  was not seen since it came), read beside the members: the table does not wait for it, and a day
  that arrives moves nothing of a row (the room of « Not seen yet » is kept), and the days of a read
  made before, late, are dropped. Who
  else reads the screen, or a worker that refuses the days, gets the day somebody joined (« Joined »).
  **The guest of one site** (FRU-250, Q3): « Guest, one site » is the first role of the form when
  the workspace has a site, and the list « Site » (the hosts of its sites) shows for that role only;
  the invitation sends `sites: [id]`, and a « Resend » the sites of the invitation. « Sites » names
  the site of a guest and of an invitation of a guest, « Every site » for the other roles. **The form
  opens on « Member »**, where the mockup draws « Guest, one site » chosen: the list of the sites
  arrives after the screen, and a form that opened on a guest would grow a field under a press, and
  would send a role nobody chose. A site the worker refuses (removed meanwhile) is said, and the list
  is read again. **Not copied from the mockup**: « Now » and « 1 h ago » (the worker keeps no hour).
  What a guest does is in the legend when a guest is on the screen, or can be invited. **Kept, though the mockup
  draws none of it**: « (you) », « Remove » and « Cancel », which ask twice under their row
  (`Confirmation`), the day an invitation ends, the block that gives the link of an invitation, and
  every sentence of a refusal. A worker with no mailer sent nothing, so its rows say « Invitation
  kept ». What is asked under a row stays in what is seen of a table that scrolls. **A read made
  again keeps the rows that are shown** (FRU-271): « Loading… » in their place took the table away
  for the time of the read, so what is under it jumped and no action of a row was there to press.
  `e2e/console-members.spec.ts` reads the values and the boxes of the mockup at 1440 and 390 px,
  the keyboard, the contrasts and axe.
- **« Connect this browser » of a site leads to the sign-in of the popup, on the Cloud** (FRU-313).
  On a console of Fruitback Cloud (`connectsBySignIn` of `instance.ts`, the host of the worker) the
  button opens `/connect`, a page that says the three steps of the popup: the icon, « Sign in with
  email », the word. It mints no code and reads nothing, and the session is the one of the account,
  so the popup offers « Add to … and turn on » after it like after any sign-in. The worker's page
  `/pair` held a session of one workspace, in the words of a worker. **A self-hosted console keeps
  the pairing link** (`useConnect`): the extension of the store signs in to the Cloud alone
  (`WXT_FRUITBACK_CLOUD`), so it cannot sign in to that worker.
- **« Connect this browser » answers the extension, and only on a press** (FRU-240, screen 04 of the
  mockup of 2026-10-13, routes of FRU-238). The extension opens `/connect/<request>`; the page reads
  `GET /console/connect/<request>` and shows the word, the browser, the account and its workspaces
  as the worker says them, never as the address says them. « Connect » sends the word and the
  account it showed (`POST …/approve`), « Not now » refuses (`POST …/refuse`). A sign-in on the page,
  by a link (`useCarryOn`) or a provider (`connect-return.ts`), leads back to the question, never to
  the answer: the mockup says « it connects in the same move », and the page says « Sign in, then
  check the word and connect it ». A request that expired, is unknown, or was answered by another
  account says « This request no longer works »; one answered in another tab is read again. An
  account with no workspace can connect: its browser reads nothing until it has one, and the page
  sends it to the setup. « Use another address » under the question signs out, for a browser that
  holds the session of somebody else. `e2e/console-connect.spec.ts` holds each state on a worker of
  stubs; `e2e/console-connect-worker.spec.ts` the whole path on a worker with accounts.
- **The setup is one screen, and resumes where the worker says the person is** (FRU-239, screen 01 of
  the mockup of 2026-10-13). `setup.tsx` shows three steps together (step 1 in `setup-account.tsx`,
  step 2 in `setup-site.tsx`, step 3 in `setup-install.tsx`; where the person is, decided from the answers of the worker, in
  `setup-stage.ts`, which knows no React and no network and has its own `setup-stage.test.ts`): « Your account », « Your site »,
  « Put it on the site ». The step is read from the worker at each visit: nobody signed in, no
  workspace, no site, a site. So a visit goes on anywhere, and the address has no `?step=`. **The
  front door sends a workspace with no site back to the setup**, for who adds a site (an owner, an
  admin); a list of sites that could not be read is not an empty list, there as everywhere. The step
  « Source » is gone: a tracker is chosen in Connectors, after.
- **Nobody names a workspace** (FRU-239). The first one of a person takes its name from their
  address (`workspace-name.ts`: the label of the domain that names its owner, or what is before the
  `@` for a public mailbox), and « Rename » changes it in place (`POST /console/workspaces/<id>`,
  FRU-236). Nothing is kept in `localStorage` any more. **One workspace is made, in whatever tab**:
  the tab that waited for the link and the tab of the link can both arrive at the setup in the same
  second. `firstWorkspace` takes a lock of the browser (`navigator.locks`), and the tab that gets it
  second reads `/console/me` again and finds the workspace of the first. **The lock needs a secure context**: a
  console served over `http` on a host other than `localhost` has no `navigator.locks`, and there two
  tabs that arrive in the same second can each make a workspace. The worker does not refuse a second
  one: that would be a rule of the worker (one first workspace per account), not of the console.
  `e2e/console-setup.spec.ts` holds the first request open and lets a second tab arrive: without the
  lock the worker is asked twice (planted). **Somebody who was invited gets no workspace made behind
  their back**: with an invitation that waits, the setup sends to `/invitations`, and while the
  invitations cannot be read it makes nothing and offers « Try again » (a worker that has no
  invitations at all answers 404, and the setup goes on).
- **« Change » never removes a site that may hold notes.** The worker has no route that changes a
  site, and a site that is removed takes its notes with it. « Change » adds the site again with the
  new values; it removes the one it replaces only when that one was added in this visit of the
  setup. A site of a visit before stays, the summary says so, and the Sites screen removes it with
  its two presses (FRU-165).
- **What the setup does not say, on purpose.** The hint of « Site address » stops at « Any page of it
  will do. »: the mockup goes on with a pattern for the previews, which a domain that is proven
  covers (FRU-103, decided on 2026-10-13), and the worker takes no pattern as an address. So what is
  under the hint is 19.5 px higher than on the mockup.
- **The last step is two cards, and the preview is the site itself** (FRU-242, FRU-354). « Browser
  extension » and « Script tag » share the logic of the Sites screen (`useCopy`, `useConnect` in
  `install-options.tsx`). **The preview frames the site the person added, in their browser**
  (`site-preview.tsx`, decided on 2026-10-21 in place of the fixed illustration of 2026-10-13): the
  origin, sandboxed with no `allow-top-navigation` and no referrer, laid out at 1280 px and scaled
  down in a wide frame, at the width of the frame under 600 px. **No server request goes to the
  site**, so the console cannot read a refusal: measured on 2026-10-21 in Chromium, Firefox and
  WebKit, a frame refused by `X-Frame-Options` or `frame-ancestors` fires `load` like one that
  shows, and its `location`, `origin`, `length` and resource timing read the same. So the caption
  says what a blank frame means, and « Show its address instead » gives the domain, the icon of the
  site (`/favicon.ico`, https only, a letter when it fails) and why; the choice is kept for that
  origin in `localStorage`. From there « Show an example » shows the example page of before
  (`preview-scene.tsx`, asked by Mathieu on 2026-10-21), `aria-hidden` and `inert`, captioned « An
  example page »; it is not kept. **Its colours are the example site's, in `preview-scene.css`, and
  are no tokens**: nothing of the console takes them. What the two addresses alone tell is shown with no frame
  (`frame-refusal.ts`): an `http` site in an `https` console (mixed content, except a host of this
  machine), and the console itself. The policy of the image allows it: `frame-src https: http:` and
  `img-src https:` (SECURITY.md).
  **The setup ends at the first note on the site** (FRU-237 counts them): while the step waits it
  says « Waiting for your first note. », and reads the site again every five seconds while the tab
  is shown (`useFirstNote` in `setup.tsx`; a hidden tab asks nothing, a read that fails changes
  nothing). At the first note the step is done by itself, and « Your first note is in » is said (`role="status"`, no move of the focus) with « Open the
  console » and « Connect a tracker ». The sentence says « a tracker or your own API »: GitHub is
  a source only where the worker has its App (FRU-361), and the setup does not ask which. « Open the console » stays under the cards while the step
  waits, for a person who sends no note now. **Still waiting**: « Signs in with this account. No
  code to type. » (a browser is still connected from here until the popup asks, FRU-238, FRU-251). **The script keeps `data-fruitback-endpoint`** (inventory A24): the widget finds
  its worker by that attribute only.
- **An invitation has a screen, and joining says what comes next** (FRU-241, screen 03 of the mockup
  of 2026-10-13). `/invitations` shows the most recent invitation of the address that is signed in:
  the workspace that invites, the role and what it lets its person do, « Join », and « Decline »
  beside it. Others that wait are listed under it. Joined, the screen stays (« You are in »), names
  the first site of the workspace when it has one, and leads to the console. **The link of an
  invitation still signs nobody in** (`SECURITY.md`), so the line under the button is « Not
  {email}? Use another address », which ends the session and leads to the sign-in; the mockup's
  « The link in the invitation signed you in. » is not said. **The guest of one site** (FRU-250): « Review {site} with {workspace} », its sentence, and the
  row « Site »; joined, « Open {site} » is the site the worker lists to the guest. **Two things the
  mockup has and this screen does not, each for a decision that is open** (FRU-230): the name of who
  invites (the worker lists the workspace of an invitation, not its sender: the line says
  « {workspace} invited you »); « It signs in with this account. » about the extension, which a
  browser still joins with a code from the console (Q8).
  **The extension is in no store yet** (FRU-130): « Install the extension (beta) » and « Install it
  in Firefox (beta) » (FRU-318) lead to the page of the documentation that says how to install the
  archive of the release, step by step. « Add to Chrome » comes back the day it is published.
- **The address of a site is read by `site-address.ts`, on every screen that asks for one**
  (FRU-167). A host with no scheme is `http://` when it is local (`localhost`, `*.localhost`,
  `*.local`, `127.0.0.0/8`, `[::1]`, `10/8`, `172.16/12`, `192.168/16`) and `https://` otherwise,
  as in the extension (FRU-314): the address kept is the one the person opens. **A site is written
  with its scheme on every screen** (`siteLabel`): two sites that differ by their scheme alone read
  as two, and « Open » opens the one that was added. The field is not `type="url"`:
  the browser stopped the form with its own bubble, in its own language, and the sentence of the
  console never showed. The worker still decides what a site is.
- **The console draws its controls with HeroUI v3, through its own kit** (FRU-125). `ui.tsx` is the
  one file that imports `@heroui/react`. A screen uses the kit, and `messages.test.ts` fails on a
  native control in a screen. **A button takes no `title`**: a tooltip does not open on a disabled
  control, so the reason is written beside it. The overlays of React Aria position with inline
  styles, which the console's CSP allows (`style-src 'unsafe-inline'`); its scripts stay hashed.
- **The values are the mockup's of 2026-10-13, named once in `app.css`** (FRU-232, on the palette:
  read as Mathieu's answer by the orchestrator on 2026-10-13, and he may come back on it).
  `design/README.md` has the table. **A screen writes the name of a token and never a value**:
  `tokens.test.ts` fails on a colour written in a screen or in the kit, and on a colour of the
  palette of before anywhere in the console. A token that a screen needs and that is not there is
  added to `app.css` in a pull request of the kit, not in the screen.
- **HeroUI takes the theme, and the kit takes the shapes.** `app.css` gives the variables of HeroUI
  the tokens, so a button of HeroUI and `bg-accent` paint the same red. HeroUI writes its
  components in the cascade layer `components`; the rules of the kit (`.kit-*`) are in no layer, so
  they win whatever their selector, and each one is a measure read in the code of the mockup.
  **A state that HeroUI derives is measured** (FRU-163): it lightens a hovered button, moves it
  under a press, tints a hovered field and draws an alert as a white card with muted text. The kit
  gives each of these the value of the mockup, which changes a colour at once and moves nothing.
- **The kit, component by component** (`ui.tsx`):
  `Button` (`tone="primary"`: the pill of the action of a step, 44 px; `tone="outline"`: the
  rectangle of a control, 6 px, at 44, 40 or 32 px with `size`; `to` or `href` makes it a link of
  the same box; `label` gives a longer name to a screen reader, « Connect Jira » over « Connect »,
  and starts with the words shown), `WideButton` (an outlined button over its column), `LinkButton` (underlined words;
  its padding is its target, 33 px at the least, where the mockup draws « Rename » at 21 px; in a row of a table it takes the line of the table),
  `IconButton` (36 px, named by `label`), `Field` and `Choice` (44 px, `compact` 40 px, `locked` for
  a value set elsewhere; `status` on a `Choice` draws the drop of the chosen status in a list of 38 px), `Pick` (radio cards), `Toggle`, `FilterChip` (`aria-pressed`), `StatusDot`
  and `StatusBar`, `DataTable`, `SidePanel` (named by its title, or by `label`; `panelId` for `aria-controls`), `KeyValue`, `SuccessMark`, `Title`, `Lead`, `PageHead`,
  `Initial`, `Card`, `Chip`, `Problem`, `Logo` (the name as outlines, in tokens: `logo.tsx`), `EntryPage`
  (the header and the column of a page outside a workspace; `/kit/entry` mounts it), `Divider`, `Menu`
  (a button that opens a menu, on the dropdown of HeroUI: the menu is named after its button, a
  `chosen` item makes it a choice of radios, and it is drawn as a page wherever its button is; the
  mockup draws no open menu; the menu of a picture, which closes a row, ends at the right edge of its
  button and stays over the table, FRU-407, `e2e/console-menu.spec.ts`), and
  for the setup `Steps` and `Step` (a drop with its number, the current step said to a screen reader),
  `Callout`, `OptionCard`, `AutoGrid` (side by side while there is room, with no width of a screen
  named), `Snippet` and `BrowserFrame` (the window of a browser, drawn). The tones `quiet` and `danger` of `Button` are of before the
  mockup: they stay as HeroUI draws them until their screens are drawn again.
- **`/kit` mounts each component once, on the development server only** (`kit-gallery.tsx`):
  `e2e/console-kit.spec.ts` reads there what the browser computes (colour, border, corner, height,
  type) against the mockup, each state under the pointer, under a press and with focus, 4.5:1 for
  every text on what is behind it, and axe. A build has no `/kit` (`kit-route.test.ts`).
- **A move between frames keeps the rail on screen** (FRU-356). Each frame (`routes/workspace.tsx`,
  `routes/admin.tsx`) asked `/console/me` when it mounted and drew « Loading… » with no rail until
  the worker answered: measured at 250 ms of latency, 37 frames of the page with no rail on the way to
  the administration, 115 on the way back, which went through the front door and its three questions.
  Now `knownMe()` in `api.ts` holds the last answer of the tab, in memory: a frame draws it at once and
  asks again. It is forgotten at any `401`, at a sign-out, and when the tab stops (FRU-210); a change
  of workspace draws the new one from it, never the one before. « My workspaces » leads to the first
  workspace itself. Rail entries and the change of workspace use view transitions: the rail holds
  still, the screen cross-fades (120 ms out, 220 ms in from 4 px lower), nothing moves with
  `prefers-reduced-motion`. No colour transition on the rail: `e2e/console-frame.spec.ts` reads the
  colours of a hovered entry and would read them halfway. `e2e/console-moves.spec.ts` reads every
  frame of a move, with a control.
- **The frame of a workspace is the rail of the mockup** (FRU-234, `routes/workspace.tsx`): the
  workspace, its sections as links with `aria-current="page"` on the one on screen, and the way to
  the documentation. **The rail shows a section only when its screen exists**: `SECTIONS` lists the
  five of the mockup in its order, each with `built`, and
  `frame.test.ts` holds `built` to the routes of a build, so no entry leads nowhere. « Notes » is
  there with `built: false`; `/kit/frame`, a page of the development server, mounts the rail with
  the five. **The name of the workspace opens a menu only when the person has several workspaces**:
  with one it is no button, and draws no chevrons. **At 900 px and under the sections are one row
  that scrolls in the rail, and the page never scrolls sideways**: the mockup does at 390 px (its
  document is 547 px wide). An edge of the row that hides a section fades, and the section on
  screen or with focus is scrolled into view: measured in Chromium, focus alone does not scroll a
  row to a link that is half hidden. `e2e/console-frame.spec.ts` reads the values and the boxes of
  the mockup, at 1440 and 390 px, the menu, the keyboard and axe. **Not copied from the mockup**:
  a link of the rail under the pointer is white, where the mockup turns every link `#b91c1c`
  (2.6:1 on the rail); « Help and docs » opens in another tab, so a screen keeps what is typed in it.
- **The rail is as high as the window, and only the screen scrolls** (FRU-402, FRU-398). `Frame`
  of `routes/workspace.tsx` is the frame of a workspace and of the instance: from 888 px the rail is
  `sticky` at the top and `h-dvh`, so its foot stays at the bottom of the window, and a window lower
  than the rail scrolls the rail itself. **The document scrolls, not the column**: a column that
  scrolls takes the keys of the keyboard only once it has focus, and `scrollIntoView` and the specs
  read the document. Under 888 px the rail is above the screen and scrolls away with it. **A screen
  is as wide as its column** (`Screen`): the mockup capped each one, from 820 to 1240 px, which left
  an empty band at the right of a wide window, and Mathieu asked for the whole width on 2026-10-23.
  `e2e/console-frame.spec.ts` holds the rail after a scroll at 1440 px and at 390 px, and the right
  edge of each screen.
- **The Sites screen is the table of the mockup, with its six columns** (FRU-243, FRU-270,
  `routes/sites.tsx`): the site and who sees its notes, its notes by status (a count and a bar whose
  name says the counts again), how they came (the script or the extension), where they go, to
  whoever sees the tracker, and the last one (`ago.ts`: « 12 min ago », « Yesterday », then the day).
  The counts are the summary of the sites (FRU-237), in the answer that lists them: **nothing of a row
  comes after the row**, so nothing moves under a press, and a test holds the read to prove it. A
  cell with nothing to say draws « · » for the eye and says « None yet » to a screen reader; a worker
  that sends no summary gets that, and no bar. The legend of the statuses is above the table. **A row
  has one menu, and what it opens is under the row**: « Install », for every role; « Preview builds »,
  which is the proof of a domain of FRU-103, and « Remove », for who manages the sites. One thing is
  open at a time, and what closes gives focus back to the button of the row. « Remove » asks twice:
  the menu is the first time, and `Confirmation` (`confirm.tsx`) the second. **No item changes who
  sees the notes of a site**: the worker has no route for it, and a button that does nothing is not
  drawn; so the form that adds a site asks it, in the card of a workspace with no site too, where the
  mockup draws the address alone. **The address of a site is no link** until a site has a page. **The
  table is 860 px at the least**, as the mockup draws it: on a phone it scrolls in its frame, and what
  opens under a row stays at the left of what is seen (`sticky`), as wide as the frame. A host breaks
  after its dots first (`<wbr>`). The hidden words of a cell are anchored to the cell: with no anchor,
  they widen the page at 390 px. The card and the alert are sized by their content (`box-content`),
  as the mockup sizes them: 640 px and 760 px inside their padding. `e2e/console-sites.spec.ts` holds
  the three states, the counts, the form, the menu, the roles, 390 px and axe.
- **The statuses of a site have a page of their own** (FRU-371, `routes/site-statuses.tsx`), reached
  from « Statuses » in the menu of a site row, for an owner or an admin. It is the board
  `design/site-statuses/`; [statuses.md](statuses.md) says what it does and why. Two things of the kit
  came with it: `Field` takes `error` (the sentence a field is described by, `aria-invalid`) and
  `inputRef`, so a refused press gives focus to the field it names; and `.kit-pin`,
  `.kit-status-chip` and `.kit-swatch` in `app.css` draw a status as the widget does. Its colours
  are data of the site, given in a style; the colours of the stages are read from the tokens, so no
  value is written twice. `e2e/console-statuses.spec.ts` holds it at 1440 px in English and 390 px in
  French, with axe.
- **The Notes page lists the index of the notes, never their text** (FRU-245, `routes/notes.tsx`,
  read from the route of FRU-244). A note is its first 64 characters (Q6: all that Fruitback keeps
  of the text), cut to two lines, with its page and « Show on the page » (`<page>#fruitback-note=<id>`,
  the link of the widget, FRU-253). The chips are every note and each place that has notes, in the order
  of the sources of the workspace. **No chip « Not delivered »**, which the mockup draws: the route
  counts those notes and does not filter them, and a chip that chooses nothing is not drawn; each of
  them says « Not delivered yet » on its row. The search says what the index searches (the 64
  characters, the page, the reference), and not « the author » of the mockup. A guest
  gets no chip, no reference and no « Send again », as the worker sends a guest none of them. **The
  filters live in the address** (`place`, `site`, `stage`, `mine`, `q`, `cursor`, `from`): a reload
  keeps the view, the search reads 300 ms after the last key, and a filter goes back to the first
  page. **A search field takes the address only on a navigation** (`app/typed-search.ts`,
  FRU-279): a key can come after the field writes the address and before the screen draws it, and
  a field that took every new address lost that key. The three search fields of the console, here,
  on Notes of the instance and on the lists of the administration, use it. The route pages by a cursor: the screen keeps the cursors of the pages before for
  « Previous », and a reload starts that list again. **A read again keeps the rows on the screen**
  until its answer replaces them: only the first read says « Loading… », and nothing a pointer can
  reach moves meanwhile. A workspace with no note says so, a filter that keeps nothing says so with
  « Clear the filters », and a read that failed is the alert of the Sites screen, never « No note
  yet ». The reference in a tracker is a link at 400, where a link of the kit is at 600 for an
  action. `e2e/console-notes.spec.ts` holds the values, every filter, the pages, « Send again », the
  states, the roles, 390 px and axe.
- **The Connectors screen is the one of the mockup, with the sources that exist** (FRU-246):
  `routes/connectors.tsx` (the list and « Add a source »), `connector-add.tsx` (the two forms),
  `connector-linear.tsx` and `connector-rest.tsx` (the panels), `connector-parts.tsx` (what they
  share). **A source that does not exist connects nothing**: Jira, GitLab, Trello,
  Notion and Webhook are listed with the sentence of the mockup and a disabled « After the beta »,
  where the mockup draws « Connect ». Linear and an address stay in « Add a source » when one is
  connected: a workspace can connect a second one. **« Add a source » waits for the list to be read**
  (FRU-271; after a read that failed there is « Try again » and no source to add): the list arrives above it and its buttons went down by the height of the
  list (45 px for one source, 110 for two, measured), so a press that started before and ended
  after was lost; and the same read says what « Connect Linear » does, the consent at Linear or a
  key. **A row says « Connected », « Needs attention »,
  or how many notes did not reach an address**; the count is read with the list, and an address
  whose count was not read says « Connected » and no number. On the chosen row the red is the
  strong accent: the accent is 4.28:1 on its tint. **The panel keeps what the mockup does not
  draw**: the places of each site (FRU-123), under « Sites sending here » for the sites that send
  there and under « Other sites » for the others; the notes that did not arrive; « Use an API
  key ». It does not show « Attach a picture of the element » (FRU-198), a count of notes by site
  nor « Last issue created » (FRU-237). **The drop of a status is beside its list**, where the
  mockup draws it inside: the list of the kit has no place for it. « Connect » is written seven
  times, so each button also holds the name of its source for a screen reader.
  `e2e/console-connectors.spec.ts` holds the values, the states, the roles, 390 px and axe.
- **GitHub connects with its App, where the worker has one** (FRU-361, routes of FRU-359 and
  FRU-360): `connectors.tsx` (the card), `connector-github.tsx` (the panel). The card « GitHub
  Issues » is always in « Add a source », between Linear and the REST API. With `githubApp: true`,
  « Connect » asks `POST …/connectors/github/start` and goes to the `url` it answers, as « Connect
  Linear » does with OAuth. Without it, a disabled « Not on this Fruitback » and a line that names
  the operator: there is no other way to connect GitHub. **Each word of the way back has its
  sentence under the card** (`GITHUB_RETURNS`), and leaves the address after it is read;
  `connected` opens the panel of the last GitHub connector, not of the last row, because an
  installation again keeps its connector. **An installation from github.com comes back with no
  `state`**: the worker sends it to `/?github=unstarted`, and the front door forwards the word to
  the Connectors screen of the first workspace that the person manages. A person who manages none
  reads on the front door that nothing was connected, and « Continue » takes the front door as
  usual. **A row names the account**
  (« Installed on acme », from `GitHub App · acme`), and its state is the one of FRU-102. **A panel
  that needs repair links to `https://github.com/apps/fruitback-app`**: the console does not know
  the id of the installation, which the worker keeps sealed. **A site chooses a repository** from
  `GET …/connectors/<id>/repositories`, private ones first, then the public ones under « Public
  repositories: their issues are public »; the place is sent as `{ connector, repository }` and
  read back from `teamId`. **A place in a public repository says, under it, that each note becomes an
  issue that anybody can read, from the worker's word on the destination** (FRU-382): `private`
  comes with each destination of `GET …/sites`, so the warning shows as the panel opens, while the
  list is read, when it failed, and to a member, who reads no list. Once the list names the
  repository, it wins either way: it is GitHub's word now, and the worker's can be older. A destination with no word (a worker of before, a
  GitHub that did not answer) warns only from the list. **`setPlaces` takes the sources of the workspace**: each panel sends
  the whole list of a site, and a GitHub place sent as a team makes the worker refuse that list.
  `e2e/console-github.spec.ts` holds the card, every word, the panel, the bodies sent, 390 px and axe.
- **My account shows the sessions of the console, and ends them, with the routes of FRU-181**
  (FRU-248, `routes/account.tsx`). `GET /console/sessions` lists them by id, with no token: this
  browser first, then the others, each with « Disconnect » (`DELETE /console/sessions/<id>`, one
  press: a session ended by mistake is a sign-in away). « Sign out everywhere » is
  `/console/auth/revoke-sessions`, asks twice, and ends this browser too. **A way out that the
  worker did not confirm says so and stays** (FRU-204), for the three of them. **A list that was
  not read is no list.** **The list keeps the room of one row while it is read, and when it could
  not be**: it arrives above « Sign out », and a press that starts before a button moves and ends
  after is lost, with no request and no message (measured: 53 px, `main` red on 30c62f8). A second
  browser still adds its row. **A browser is named as the worker names it** (FRU-249, Q7): « Console
  · Chrome on macOS », a short label of its user agent; one it could not name reads « Console · this
  browser » or « Console · another browser ». **The name on the notes is changed here**
  (`POST /console/me/name`), kept when the field is left or by Enter, as the mockup draws no button; a
  refusal says why and keeps what was typed. **A provider is linked by a navigation** to the worker
  (`/console/auth/link/<provider>`), which comes back with `?linked=` or `?error=`, said once and
  taken from the address; « Unlink » asks twice, and the last way to sign in stays and says why
  (`409 last-sign-in`, `403 sign-in-again`). The three rows of « How you sign in » are drawn before
  the worker answers, so nothing under them moves. The worker keeps no login of a provider: « Linked »,
  not « Linked as ». **The browsers of the extension are rows of the same list** (`GET
/console/me/browsers`, FRU-238): « Extension · Chrome on macOS », « Connected 12 Oct · used 2 h ago »,
  after the browsers of the console. The two lists are read together and drawn once, so nothing under
  them moves when the second answer comes. A list of the console that could not be read is no list; a
  list of the extension that could not be read leaves the browsers of the console and their
  « Disconnect », with a line that says what is missing and « Try again ».
  « Disconnect » of an extension asks twice (it reconnects only with an approval here), and ends its
  session on the worker (`DELETE /console/me/browsers/<id>`): its next refresh is refused. The deletion of the
  workspace stays at the bottom, for its owner: the mockup does not draw it, and it is nowhere else.
  `e2e/console-account.spec.ts` holds the screen on stubs, and the sessions on a worker with accounts: one browser disconnects the other,
  which learns it at its next call, and « Sign out everywhere » ends every one.
- **The administration of the instance is a frame of its own** (FRU-262, screen 17 of
  the mockup of 2026-10-13, routes of FRU-261). `routes/admin.tsx` is the frame: the rail of a
  workspace and the rail of the instance are one `RailFrame` with two sets of entries
  (`routes/workspace.tsx`). Only `instanceAdmin: true` of `/console/me` opens it; any other account
  goes to the front door, and sees no way to it. The worker answers `404` to them on every route of
  the administration: the redirect of the console protects nothing alone. The rail of a workspace
  shows « Administration » to the administrator only, in a second `nav` « Instance »: the mockup
  draws no way in. **The rail names the host of the worker the console calls**, and « Fruitback
  Cloud » when it is `api.fruitback.com` (`instanceOf` of `instance.ts`), else « Self-hosted
  instance »: the build holds no flag of the Cloud, and the host is known before any read.
  `routes/admin-instance.tsx` (`/admin`) reads `GET /console/admin/instance` and
  `GET /console/admin/workspaces` and writes nothing. **Each setting comes from the environment**,
  so each one says « Set by {variables} in the environment. », and the locked field and the radios
  are described by that sentence. **The workspaces are read on a click only** (« Show the workspaces »,
  Mathieu, 2026-10-19): the read leaves a trace in each workspace that the administrator is not a
  member of (FRU-261), and a visit to see the health of the server must not tell its owners that
  their workspace was read. The screen says so above the button. **Not copied from the
  mockup**: the switches, « Edit keys », the form of Google and « Turn on Google », « New workspace »,
  the policy « Anyone with an address at … » that the worker does not have, « Backed up 4 h ago »
  (no witness of a backup: « Not reported »), and the lead, which says that a setting is set in the
  environment and not here. « Workspaces », « Users » and « Notes » of the rail come with their
  screens. `e2e/console-admin.spec.ts` holds the screen, the other accounts, the absence of any
  write, the states, French, 390 px and axe.
- **The notes of the instance are the table of the Notes page, with their workspace** (FRU-273,
  screen 20 of the mockup of 2026-10-13, route of FRU-272). `routes/admin-notes.tsx`
  (`/admin/notes`) reads `GET /console/admin/notes` when it opens: to open « Notes » is to ask for
  them. Each read leaves a trace in each workspace of the page that the administrator is not a member
  of, and the screen says so under its lead. **A note that Fruitback keeps shows its text**, on two
  lines; **a note that went to a tracker shows its 64 characters** (`excerptOf`, « … » when cut) and
  « Kept in {tool}. Fruitback keeps the first 64 characters. »: the worker sends no text for it, and
  the screen invents none. `?workspace=<id>` chooses the workspace, for the Workspaces screen.
  **The filter « Workspace » lists the workspaces the answers named**, and the one of the address:
  `GET /console/admin/workspaces` would leave a trace in every workspace of the instance. The
  search, the status, the pages and the four states are those of the Notes page (`NotePages`,
  `NotesFailed`, `Reference` of `notes.tsx`). **Not copied from the mockup**: the chips (the answer
  counts no place), « Send again » (read-only), the names of the authors (the worker sends a kind),
  and « page · workspace » under a note, which is a column « Workspace » here.
  `e2e/console-admin-notes.spec.ts` holds both kinds of note, the address, the other accounts, the
  absence of any write, the states, French, 390 px and axe.
- **« Workspaces » and « Users » of the administration read only what is asked**
  (FRU-263, screens 18 and 19, routes of FRU-261). `routes/admin-workspaces.tsx` and
  `routes/admin-users.tsx` share `routes/admin-list.tsx`. Opening a screen is an explicit read, so it
  reads its list when it opens; each read leaves a trace with the owners of the workspaces it names,
  so **the search reads 300 ms after the last key**, and once only when the screen mounts, also
  under the `StrictMode` of development. The search, the filter and the chosen row live in the
  address (`q`, `show`, `open`). The panel of a row follows the rules of FRU-161 and FRU-197: beside
  the table from 1280 px, under its row below, focus on a press, Escape back to the row. The panel
  of a workspace shows `GET /console/admin/workspaces/<id>`, which the page reads once for each
  workspace while the screen is open: the panel moves at 1280 px, and a move or a second opening
  is no new trace. The panel of a person is its row, as the worker has no route for one person.
  Both screens say under their lead that the owners see the read. **The filters are the worker's** (`attention`, `empty`,
  `suspended` since FRU-328; `admins`, `alone`), with no count on an option: the worker counts the filter it answers only.
  « Manage in Users » searches the address of the first owner: the search of the people does not
  match a workspace. « Last seen » is a day, as on Members. **Not copied from the mockup**: every
  action (« New workspace », « Invite someone », « Send them again », « Suspend » of a workspace,
  « Delete », « Add to a workspace », the role lists) until FRU-274; the filters « Suspended » and
  « Invited », which the worker does not have (`USER_FILTERS` is `all`, `admins`, `alone`); the counts of the
  options; « Active now » and « 2 h ago » (no hour); « The address answered 503 at … » and
  « Browsers signed in » (no data); a row for somebody invited who has no account (the worker lists
  accounts). `e2e/console-admin-lists.spec.ts` holds both screens, the debounce, the filters, the
  panels, the other accounts, the absence of any write, the states, French, 390 px and axe.
- **The switch « Instance admin » of a person names and removes an administrator, after a
  confirmation** (FRU-280, route of FRU-280). A press asks: the confirmation says what the role gives
  (« sees this admin and every workspace, and can name and remove admins ») and that every
  administrator reads the change, and only its button sends. Removing asks the same way. **The
  switch shows the role of the list, never the role asked**: a `200` changes the row in place, and a
  refusal leaves it as it was. The list is not read again, because each read leaves a trace in each
  of its workspaces. During the call the switch is disabled, and a second press of the button sends
  nothing. After the answer, focus goes back to the switch. **The switch is held, with a line that
  says why, on yourself** (`/console/me`), **and on the last administrator**, counted only from a
  list that holds them all: no search, the filter « All people » or « Instance admins », and `total`
  equal to its rows. On any other list the console does not guess, and the worker answers
  `409 last-admin`. The list does not say who is banned, so the worker can count fewer. **Each
  refusal is said in the panel**: `self-removal` and `last-admin` in their words, a `5xx` as
  « Fruitback did not answer », anything else as « The role did not change ». **Not done**: a list
  of the recent actions (`GET /console/admin/actions`) on « Instance ». The switch of the kit takes
  a press on its track since FRU-280: before, only its words turned it.
  `e2e/console-admin-lists.spec.ts` holds the request, the confirmation and « Keep it », the two
  holds, each refusal, the busy switch, French, 390 px and axe.
- **« Suspend » and « Restore access » of a person suspend and restore the account, after a
  confirmation** (FRU-281, route of FRU-281). They follow the switch of FRU-280: a press asks, only
  the button of the confirmation sends, « Keep it » and Escape send nothing, the button is disabled
  during the call and a second press sends nothing, a `200` changes the row in place and a refusal
  leaves it as it was. The confirmation of a suspension says that the person signs in by no way,
  that their sessions of the console and of the extension end, that their notes stay, and that the
  owners of each of their workspaces see it. The one of a restoration says that they sign in again
  and that their old sessions stay ended. **A suspended account reads « Suspended »** in its row and
  at the top of its panel, with « Restore access », as screen 19 draws it; an active one has
  « Suspend » in the foot of its panel, as screen 18 draws it for a workspace. The red of the mockup
  (`accent`) is 4.28:1 on the tint of the chosen row, so the chosen row and the panel take
  `accent-strong` (#b91c1c), over 4.5:1 on each. After the answer, focus goes to the button that says
  the state now. **« Suspend » is held on yourself and on the last administrator**, with the rule of
  FRU-280: counted from a list that holds them all, and **a suspended administrator is no
  administrator**, as the worker counts. **The switch « Instance admin » is held on a suspended
  account** (« Restore access first »): the worker answers `instanceAdmin: false` for it whatever its
  role, so a change of the role would not show. For the same reason, after the restoration of an
  account that the read answered as suspended, its role is unknown, and the console no longer counts
  the administrators until the next read: the worker answers. **Each refusal is said in the panel**:
  `self-suspension` and `last-admin` in their words, a `5xx` as « Fruitback did not answer », anything
  else as « Nothing changed ». **Not copied from the mockup**: the filter « Suspended » (the worker has
  none), and « on 30 Sep by Nadia Benali » (the list says neither). `e2e/console-admin-lists.spec.ts`
  holds the status and its contrast, the request, both confirmations, « Keep it » and Escape, the
  holds, each refusal, the busy button, French, 390 px and axe.
- **« Suspend » and « Restore » of a workspace suspend and restore it, after a confirmation**
  (FRU-323, routes of FRU-282). They are writes of an administrator (`AdminWrite`): a press asks,
  only the button of the confirmation sends, « Keep it » and Escape send nothing and empty the reason,
  a refusal is said and keeps the reason. A suspension takes an **optional reason**, one line of 200
  characters at most (`SUSPENSION_REASON_LENGTH` of the worker; the field holds no more, and the
  console sends it trimmed, with its spaces made one). The confirmation says what a suspended
  workspace does: its sites answer as unknown, every change is refused, its notes wait, its members
  still read it, nothing is deleted, and its owners see it. **A suspended workspace reads « Suspended
  since {day} »** under its name, in its row of Workspaces and of Instance, in the red of the person
  of FRU-281 (`accent`, `accent-strong` on the chosen row), and at the top of its panel with the day,
  what it does, the reason or « No reason was given. », and « Restore »; an active one has « Suspend »
  in the foot, above « Delete the workspace », as screen 18 draws it. **The row and the panel change
  in place** after a `200`, from its answer: each read leaves a trace with the owners. After the
  answer, focus goes to the button that says the state now. `e2e/console-admin-lists.spec.ts` holds
  the row, the panel and Instance, both confirmations, the request with and without a reason, « Keep
  it » and Escape, each refusal, the busy button, French, 390 px and axe.
- **A member of a suspended workspace reads a banner at the top of its console** (FRU-328), above
  every section, in the column of the section and not in the rail: « This workspace has been
  suspended since {day}. », what still works (they read it, nothing changes, its sites take no notes),
  and to contact the administrator of the instance. **No reason**: it is a note of the administrator,
  which only their panel shows, and the worker answers it to nobody else. **A write that
  the worker refuses with `409 workspace-suspended`** says « This workspace is suspended, so nothing
  in it can change. Contact the administrator of this instance. » where the screen says its refusals,
  in place of « Try again », and keeps what was typed: `problemOf` knows the code for every screen,
  and `writeProblemOf` for the screens that name their own sentences. The same refusal shows the
  banner (`onWorkspaceSuspended` of `api.ts`), with the day of the `409`, when the suspension came
  after `/console/me` was read, and only for the workspace that the write named (`workspaceOfWrite`:
  its path, or `organizationId`): a write of another workspace answered after a change of workspace
  shows nothing. The filter « Suspended » of Workspaces is the one of the mockup, and
  asks the worker `show=suspended`: a workspace restored under that filter stays in the list until it
  is read again, as each read leaves a trace. `e2e/console-suspended.spec.ts` holds the banner on each
  section, its day or no day, no reason, its contrast, the refusal of a site and of an invitation, the
  control of another `409`, French, 390 px and axe; `e2e/console-admin-lists.spec.ts` holds the filter.
- **A box is compared to the mockup in the font of the mockup** (`e2e/console-workspace.ts`,
  `MOCKUP_FONT`): the mockup sizes its boxes by their text, and the Linux of CI has another font
  (52 px where the mockup has 49). `expectBox` compares on macOS; the computed styles are read
  everywhere, and they are what CI holds.
- **What the kit does not copy from the mockup.** The padding of a button is of its size, where the
  mockup writes 22, 24 or 26 px on the same pill. A switch changes colour in 200 ms everywhere,
  where the mockup does so in the popup only. A disabled switch dims its control and not its words.
  The frame of a table takes focus, so a keyboard scrolls a table wider than its screen.
  **A head of a table is one line** (FRU-401, `white-space: nowrap` on `.kit-table th`): a column
  narrower than its head broke « Sur la page avec » on two lines; the table scrolls in its frame
  instead. `e2e/console-table-heads.spec.ts` counts the lines of each head of Sites in French.
- **Not measured**: what VoiceOver and NVDA say of the kit; the kit in Firefox and in Safari (the
  spec runs in Chromium).

## The session of the console (FRU-148)

### The rules, in short

- **The console holds no token.** A call is a `fetch` with the cookie of the worker and no
  `Authorization` (FRU-147, and no other way since FRU-150). The cookie is `HttpOnly`,
  `SameSite=Strict`, `Path=/console`: `document.cookie` does not show it, and no token is in
  `localStorage` or `sessionStorage` (the one thing there is the id of a request of the extension,
  `connect-return.ts`, FRU-240). `e2e/console-cookie-session.spec.ts` reads all three, after it
  checked that the browser does hold the cookie.
- **No client of better-auth.** The console calls the routes of the worker with `fetch`
  (`/console/auth/email`, `/console/auth/email/redeem`, `/console/auth/sign-out`). The bundle and the
  policy of the image do not change: `csp.mjs`, hashed scripts, no `'unsafe-inline'` for a script.
- **The worker says what it offers, in `GET /auth/providers`**: the providers of `betterAuth`, and
  whether it sends mail. A worker that says no `betterAuth` signs nobody in, and the console offers
  nothing (test:`signs nobody in: no provider, no token, and no route of the sign-in of before`). Until FRU-150 the console signed
  in as before against such a worker, with an access token in `session-of-before.ts`; that file is
  gone, and with it every token of the console. **So this console is deployed after its worker says
  `betterAuth`**, and not before.
- **A worker that refuses `GET /auth/providers` said nothing, and that costs nothing any more**
  (FRU-205, then FRU-150). While the console had two paths, it took the path of before on a `429`
  or a `5xx`, spent the refresh cookie of before and held a token; FRU-205 made every call wait
  for the answer. There is one path now: a call needs no answer of that route, and goes with the
  cookie. A refusal there still shows no provider as « not set up »: `signInProviders` answers
  `undefined`.
- **A sign-in with a provider is a navigation of the whole page**, to
  `<worker>/console/auth/start/<provider>` (`providerStart`). Never a `fetch` of `/sign-in/social`:
  the cookie of the state would be set on the answer of a call, and WebKit did not send it back when
  the console and the worker are not one site (measured in FRU-147: `state_mismatch`).
- **The token of a link is read after the `#`, sent in the body of a `POST`, and taken out of the
  address bar** (`sign-in.tsx`), as before. It is in no address that the worker receives.
- **Signing in has its own page, `/sign-in`** (FRU-235, screen 02 of the mockup of 2026-10-13): the
  form, « Check your inbox », « You are signed in » and « This link no longer works ». A screen that
  finds nobody signed in sends there (the frame of a workspace, the banner of a session that ended,
  the tab that stopped, the invitations); `/setup` stays the way in of somebody new. The ways to sign
  in are in one module, `sign-in-form.tsx`, for this page, the setup and the screens to come: the
  form of a link, the providers the worker offers (**a provider it does not offer has no button**,
  and with none there is no « or »), the sentences of a refusal, and « Send again », which waits a
  minute in the console (the ceiling of the worker, 3 links per address per quarter of an hour, and
  its sentence stay). **The main button is not dimmed for an empty field**, as on the mockup: the
  form is `noValidate`, and says « That is not an e-mail address » itself, in its language.
- **The tab that asked for the link goes on by itself** (FRU-235). The tab of the link, once the
  token is spent, says « signed-in » on a `BroadcastChannel` (`tab-signal.ts`). A tab that waits says
  « heard » at once, asks `GET /console/me`, and on a session says « carried-on » and goes on: the
  sign-in page to the front door, the setup to its next step. The tab of the link then shows « You
  are signed in »; with no « heard » in 400 ms, or no « carried-on » in 5 s, it is the console, as
  before. **A message is a hint, never a proof**: it carries no token and no account, and a tab goes
  on only on the answer of the worker. A browser that tells a tab nothing: the tab asks the worker
  when it comes back to the front. **A link opened in the tab that asked for it changes the part
  after the `#` only**, so the page is not loaded again: `sign-in.tsx` reads the code on
  `hashchange` too (measured: without it the tab stayed on « Check your inbox » with the token in its
  address bar). **The code is read once**: in development an effect runs twice, and the second run
  must not take the page for a visit with no link.
- **Not measured**: two tabs in Firefox and in Safari (the spec runs in Chromium), and a link that
  the mail application opens in another browser profile, where no tab can hear it: the tab of the
  link is then the console, and the first tab learns it when it comes back to the front.
- **A code that a sign-in sends back has a sentence** (`PROVIDER_PROBLEMS` in `sign-in-form.tsx`), in French
  too. better-auth names no provider in its code, so the sentences name none. A code this build does
  not know says that the sign-in did not finish: no code shows as a blank screen.
- **A `401` keeps what the person typed.** `call` tells `onSignedOut`, and the root says so above
  the screen, which stays mounted: « Sign in » opens the sign-in in another tab, « Continue » asks
  the worker again. A screen that draws nothing without `/console/me` asks with `quiet` and goes to
  the sign-in itself: it has nothing typed to keep.
- **A tab is of one account, and stops when the browser is of another** (FRU-210, decided for
  Mathieu on 2026-10-12). The cookie of a session is of the browser: somebody who signs in in
  another tab changes who every tab speaks for. `api.ts` keeps the id of the first account that
  `/console/me` answered in the tab. When `/console/me` answers another one (on « Continue », or
  when the tab comes back: `focus` and `visibilitychange` ask it), the tab stops: `call` answers
  `409 tab-left` with no request, the root takes the screen away with everything it showed, and
  shows what was typed in its text fields, read-only, to copy. The one way on loads the console
  again. A call made in the moment the tab comes back waits for that question: a change would be made in the name of the other account, and a read would bring its data to this screen. A tab that comes
  back to a session that ended elsewhere stops the same way, with « Sign in ».
- **The screen of somebody whose own call was refused stays** (FRU-148, unchanged): they are there,
  typing, and « Continue » goes on, for the same account only.
- **What this does not hold**: a browser that tells the page nothing when a tab is shown again. The
  tab then learns the change at its next `/console/me`, and a change it sends before that leaves
  with the cookie of the other account. The worker could refuse it (the console would name the
  account it believes it is, and the worker would compare): not done.
- **« Sign out » ends the session on the worker** (`/console/auth/sign-out`): the cookie is refused
  at the next call, in every tab and for whoever copied it.
- **« Sign out » says when it failed.** `signOut` answers `false` unless the worker said that the
  session ended (FRU-204), and « My account » then stays, with « You are still signed in ». A screen that
  says « signed out » over a session that is still good leaves the browser open to the next person.
  better-auth 1.7.7 answers `200` to a sign-out with no session, with one that already ended, and
  with a cookie that is not one (measured, and held by a test of the worker): somebody who signs
  out in a second tab is not held on that sentence.

### The reasons, and the measurements

- **Why the path of before stayed in the console until FRU-150, where FRU-148 said the token goes.**
  FRU-148 asked both that the token disappears and that the console works against a worker of
  before. The second one decided: a console that is deployed before its worker would sign nobody
  in. So the token of before was in one file that nothing called once the worker said `betterAuth`.
  FRU-150 removed the file, after the switch of the production.
- **An answer of `/auth/providers` with no body offers nothing.** A stub of a spec answers `204`
  there. Read without a check, it broke every console spec (measured).
- **The spec starts its worker as a process** (`apps/worker/src/cloud-worker.fixture.ts`): Playwright
  compiles a spec as CommonJS and cannot import the worker, which is ES modules. The spec hands the
  process each request that the console sends to the address of the worker, and reads the mail from
  it: the link is read where the worker was asked to send it.
- **Measured in three engines, on `*.fruitback.localhost` over HTTPS** (2026-10-12, Playwright
  1.58.2): the pull request of FRU-148 has the table. Not measured: Safari itself.
