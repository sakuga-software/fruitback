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
  loses what somebody typed and runs its effects twice. **A map is loaded with `import()`, when its
  language is asked for** (FRU-494): a static import of `messages.fr.ts` puts 112 kB back in the chunk
  of every page, and `catalog-chunk.test.ts` fails on it. `setLocale` changes the language once the map
  is there, and the root's `clientLoader` waits for it, so a French browser shows no English first.
  **`HydrateFallback` holds no word**: it is rendered when the console
  is built, and a word in another language is a hydration error in the browser.
- **`routes/` holds the routes, and only them** (FRU-614): a file there is named in `routes.ts`, and
  `routes-folder.test.ts` fails on any other. A part of a screen (a panel, a form, a section) is in
  `parts/`. Only `ui.tsx` imports HeroUI, wherever a file is (`.oxlintrc.json`).
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
  `writers-pick.tsx`, in the form of the Sites screen. Not in the setup any more (FRU-610, below). The
  page of a site sets it in its tab « Access » since FRU-703, below. « Members only » is chosen
  for a new site, and its detail says that extension mode carries no session. The form sends `writers`
  only with `visibility: 'members'`. A row and the summary of the setup say the exception, « Notes
  from anyone on the page », and nothing for « Members only » or for a worker of before.
  **A gesture that cannot be undone asks twice** (FRU-165): « Remove » a site and « Disconnect » a
  source go through `Confirm` (`confirm.tsx`), which says what the gesture costs, gives focus to
  « Keep it », and acts only on a second button that names the site or the source. « Keep it » and
  Escape give the row back, with focus on its first button. `e2e/console-confirm.spec.ts` measures it
  on both screens, at 1440 px in English and 390 px in French (FRU-191).
  **The places of a site are written whole, one write at a time** (FRU-123): a second gesture made
  before the first list is kept would start from the list of before and take the first change away,
  so the controls of the list are disabled while it is written. `e2e/console-site-places.spec.ts`
  holds a write open and tries the second gesture.
  **The settings of a connector open in a dialog, at every width** (FRU-690), where they were an
  accordion under its row (FRU-161, FRU-403, FRU-563). « … » at the end of the row opens them, and a
  press on the row too; the dialog is named after the connector, holds a region named after its kind
  and its account (`#source-panel`), keeps focus inside, and Escape or « Close » give focus back to
  « … ». A part of the settings that takes its own Escape (« Rename », `Confirmation`) stops it, and
  the dialog stays. Settings that open by themselves (a connector just added, a way back from Linear,
  GitHub or a plugin, `?connector=`) open the same dialog. `e2e/console-source-panel.spec.ts` holds
  it at 390, 768 and 1440 px. **Not measured: what VoiceOver and NVDA say**; the spec reads the
  role, the name and where focus is.
  **The console decides nothing about a domain** (FRU-103). The Sites screen shows, to an owner or an
  admin, the domains of the workspace (`domains.tsx`), in a section of the page of a site (FRU-433,
  `…/sites/<site>#previews`): the `TXT` record to write, « Check the DNS »,
  and for a domain the worker says is proven, the site whose previews it covers. `state` is the
  worker's word; a DNS that did not answer is said as such, never as « not found »; a proof that is
  lost shows since when, and its record again. `e2e/console-domains.spec.ts` holds it.
  **A refused call says its own cause** (FRU-164): `problemOf` (`problems.ts`) gives the sentence of
  the code of the worker, « Fruitback did not answer. Try again. » for no answer and a `5xx`, and a
  sentence of the screen that blames no field for the rest. No failure clears a field. A copy goes
  through `copyText`, and a copy the browser refuses says so: the text stays on screen to select.
- **The members and the invitations come from the worker's routes of the organization plugin**
  (FRU-104): `members.tsx` lists the members to whoever may read them, and the invitations that
  wait to an owner or an admin, who resends, cancels and changes a role there. A guest sees their own row only, as
  the worker answers them nothing more. **The front door looks for an invitation first**
  (`home.tsx`): somebody who signed in from the message of an invitation lands on `/invitations`,
  not on the setup that makes a workspace of their own.
  **The screen is the mockup « Membres » of the redesign** (FRU-691, `maquette-membres.html` attached
  to the ticket; before, screen 12 of the mockup of 2026-10-13, FRU-247). **The rules, in short:**
  - A screen of the bar, at `/w/<id>/members`, not a page of the shell of the settings: the mockup
    draws it so, and the entry « Members » of the shell leads here.
  - A head of 48 px from one edge of the screen to the other, « Members » at 14 px and « Invite » at its
    right (`MembersHead`, as the head of Notes). No sentence under the title.
  - Two tabs, « Members » and « Invitations », each with its count, and the search at the right (240
    px, « / » gives it the focus). A tab is a `LineTab` of the kit, a button that says whether it is
    pressed, as the tabs of Notes. A member and a guest have the tab « Members » alone.
  - One dense table a tab (`MembersList`), from one edge to the other, heads of 32 px, **rows of 36
    px, never on two lines**: what is longer is cut with « … ». The columns of the members are
    Name (the initial of 24 px, the name, « (you) »), Email, Role, Sites (« Every site » with the globe,
    or the tile and the host of the site of a guest), Last active, Joined and « … »; the ones of the
    invitations are Email, Role, Sites, Message (« Invitation sent » or « kept »), Invited, Expires and
    « … ». The table keeps 880 px and scrolls in its frame on a phone.
  - **The role is a list in its row** for an owner or an admin: « Member » and « Admin », the roles of
    `update-member-role` less « Owner », and « Guest » kept for a guest. An owner row and one's own row
    are words: the worker refuses an admin the change of an owner, and a workspace changes its owner
    from the administration of the instance (FRU-283). A guest made a member or an admin reads every
    site, so that change asks twice. A refusal is said under the row.
  - « … » holds « Remove from workspace » for a member, and « Resend invitation », « Copy invite link »
    (when no message left, FRU-269) and « Cancel invitation » for an invitation. A removal and a
    cancel ask twice under their row (`Confirmation`), and « Keep it » gives focus back to « … ».
  - **« Invite people »**, a dialog of 480 px (`Dialog` with `size="form"` and `framed`): « Emails »
    takes several addresses, cut at a comma, a semicolon, a space or a line (`invite-addresses.ts`);
    the role as three cards (`RadioCards`), each with what it does; « Sites », every site for a member
    or an admin, the list of the sites for a guest; in its foot « Copy invite link », « Cancel » and
    « Send N invites », which counts the valid addresses by the rule of the worker, each once. What is
    no address is said under the field and stays in it. The invitations go one after the other; the
    ones the worker refused stay in the field, each said with its cause, and the dialog closes when
    nothing is left. Focus is kept inside, Escape and the close button close it, and focus goes back
    to « Invite ».
  - **Not copied from the mockup**: a colour per person (the initial is on `avatar`, the one token of
    a person), « Now » and « 2 h ago » (the worker keeps a day, never an hour, FRU-249), a picture in
    the fields.

  Kept from before: **the form opens on « Member »**, where a guest needs the sites, which arrive after
  the screen; « Guest » is offered when the workspace has a site (« Add a site first » else), and a
  site the worker refuses (removed meanwhile) is said, and the list read again. **« Last active » is
  for an owner or an admin** (FRU-249, Q7): a day of UTC and never an hour (« Today », « Yesterday »,
  « 3 days ago », then the day; « Not seen yet » for who was not seen since it came), read beside the
  members: the table does not wait for it, its column is there from the start, and the days of a read
  made before, late, are dropped. A worker that refuses the days leaves the column empty. The block
  that gives the link of an invitation is under the tabs, one sentence an address. A worker with no
  mailer sent nothing, so its rows say « Invitation kept ». **A read made again keeps the rows that
  are shown** (FRU-271). No legend of the roles (FRU-437). `e2e/console-members.spec.ts` reads the
  values and the boxes of the mockup at 1440 px, 390 and 320 px, the keyboard, the contrasts and axe.
  **Two lists, in pages of 50, and a search** (FRU-496): « Members » and « Invitations », each in its
  tab with its count (FRU-691). The table stopped
  at a hundred members and a hundred invitations and said nothing: a 101ᵗʰ member could not be
  found nor removed. The worker gives the members a page at a time (`limit`, `offset`, `total`) and
  searches them (`q`, the name or the address); it gives every invitation that waits, which the
  screen cuts in pages and searches by address itself (`invitationsFound`, no case, no accent).
  « 1 to 50 of 501 », the arrows and the numbers of the pages are those of the Notes screen (`NotePages`), under a
  list longer than a page. The search is not in the address. A member removed is read again with
  its page: the next member moves into it. `e2e/console-members-many.spec.ts` holds it, on a
  workspace of 501 members and 300 invitations.

- **« Connect this browser » of a site leads to the sign-in of the popup, on the Cloud** (FRU-313).
  On a console of Fruitback Cloud (`connectsBySignIn` of `instance.ts`, the host of the worker) the
  button opens `/connect`, a page that says the three steps of the popup: the icon, « Sign in with
  email », the word. It mints no code, and the session is the one of the account, so the popup
  offers « Add to … and turn on » after it like after any sign-in. **`/connect` leaves for the
  console once a browser connects** (FRU-410, `connect-watch.ts`): it reads `GET /console/me/browsers`
  every ten seconds while its tab is shown (six of the twenty requests a minute that the worker takes
  from one address by default), nothing while it is hidden, and at once when it is shown
  again, since the person comes back from the tab where they pressed « Connect ». A browser counts
  when it was not in the first list read, or, signed out at first, when it connected after the page
  opened (two minutes of margin for the clocks). A `401` there ends no session: the person may sign
  in from the other tab. The console cannot tell that it is this browser, and cannot see that the
  extension is installed: that would take a content script on the console or `externally_connectable`
  in the manifest (`extension.md`). **Since FRU-487, the console of the Cloud does** (below); a
  self-hosted console still cannot. The worker's page
  `/pair` held a session of one workspace, in the words of a worker. **A self-hosted console keeps
  the pairing link** (`useConnect`): the extension of the store signs in to the Cloud alone
  (`WXT_FRUITBACK_CLOUD`), so it cannot sign in to that worker.
- **On the console of the Cloud, step 3 connects the extension of this browser in place** (FRU-487,
  decided by Mathieu on 2026-10-28). `useExtensionHere` (`extension-here.ts`) asks the extension of
  the store (`STORE_EXTENSION_ID`, or the ids of `/config.js`) with `chrome.runtime.sendMessage`,
  which Chrome gives to `https://app.fruitback.com` alone (`externally_connectable`, see
  `extension.md`). Installed and signed out: the card says « Fruitback is installed in this
  browser. » and « Connect this browser » connects it in this tab: the extension starts the request,
  the page reads its word from the worker and approves it, the extension claims. No `/connect` tab,
  no word to compare, no click on the icon. Installed and signed in: « Extension connected in this
  browser ». With another browser of the account connected already, the quiet link stays « Connect
  another browser » (FRU-441) and connects this one in place. No answer (another browser, Firefox,
  Safari, no extension, a self-hosted console): the
  card of before. A failure says « This browser was not connected. Try again. »; a session of the
  console that ended says « Your session ended. Sign in again, then connect this browser. »
  (`hereProblemOf`). Approved and not claimed after eight asks (44 s): « Approved. The extension
  finishes connecting within a minute, or press again to finish now. » The alarm of the extension
  claims it, and a new press takes the same request (`startConnect` gives it back) with no second
  approval.
- **Nothing offers to install or to connect the extension once a browser of the account is
  connected** (FRU-441, decided by Mathieu on 2026-10-24). `useConnectedExtension`
  (`extension-connected.ts`) reads `GET /console/me/browsers` once, and again when the tab is shown
  again. With at least one browser, the foot of both bars has « Extension » with a green dot and the
  browser used last at its right, and leads to connect another one (FRU-684); the card « Browser
  extension » of step 3 of the setup and « You are in » say « Extension connected · Chrome on macOS »,
  and « Connect another browser » is a quiet link: no « Install the extension », no « Connect
  this browser ». The card is not hidden: another computer, or a colleague, still needs a way in. A
  list that could not be read, or is empty, shows the offers of before. **`/connect`, opened in a
  browser that is already connected, says so** (« This browser is already connected ») and leads to
  the console, with « Connect another browser » to show the three steps. « This browser » is a
  browser of the extension whose label is the label of the session of the console in this tab
  (`current` of `GET /console/sessions`): the label is a family and a system, so another computer
  with the same browser and system reads the same, and the steps stay one press away. `/connect` says
  « Loading… » while it reads, two seconds at most, then decides once: an answer that comes after the
  steps are shown changes nothing, so they never turn into « already connected » while somebody reads
  them. When the tab is shown again and again, only the answer of the last read of the browsers counts. No route of
  the worker was added. The Sites screen (`install-options.tsx`) still offers « Connect this
  browser ». `e2e/console-extension-connected.spec.ts` holds each screen with a browser and with none.
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
- **What the setup adds to the mockup** (FRU-491, measured at 1440 and 390 px; the boxes of the mockup
  are unchanged). The preview is `sticky`: the last step is longer than a screen, and the site stays
  beside it. On a phone the header keeps « Self-hosting guide » beside the logo, and « Running your own
  server? » is for a screen reader only: on two lines the question sat on the rule of the header. With
  no site yet, the empty frame is 280 px high under 640 px, not 620. « Fruitback did not answer » is a
  `Problem`, as every other refusal of the setup, not grey text. While the step waits for the first
  note, a red drop beats in the gutter (still under `prefers-reduced-motion`), and « Open <site> » has
  its own line. A script in a `Snippet` breaks at any character (`word-break: break-all`): an indented
  address moved whole to the next line and left a blank line above it.
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
  nothing). At the first note the step is done by itself, and « Your first note is in » is said (`role="status"`, no move of the focus).
  « Open the console » stays under the cards while the step waits, for a person who sends no note now.
- **The setup asks no question of access** (FRU-610, board P6 of FRU-598). Step 2, « Your site », is
  the address alone, « Any page of it will do. », and one sentence that says what applies: « Members
  of {workspace} see and leave notes. You can open it to every visitor later, in Sites. » « Who sees
  the notes? » and « Who can leave a note? » are the Sites screen's and the page of a site's.
  - **A new site of the setup is `visibility: 'members'`, `writers: 'members'`**, sent by the console
    (`NEW_SITE` of `setup-stage.ts`), not left to the defaults of the worker, so that the sentence
    stays true on a worker that would default otherwise. These are the values the form chose by
    default before: **what a visitor of a new site sees did not change**, only the choice to open it
    there went.
  - **« Change » with the same address asks nothing of the worker.** An add of an address that exists
    changes that site (FRU-504), so a POST would write `members` over a site that somebody opened to
    every visitor in Sites since. Another address is a new site, with the values above.
  - **Step 3 recommends one way, after who sees the notes** (`recommendedWay`): a site of members gets
    « Browser extension » first, with the badge « Recommended for a members site » and a primary
    « Install the extension »; a site that every visitor sees (one opened in Sites) gets « Script
    tag » first, « Recommended for a public site », as a visitor has no extension. The other card is
    folded to its name under « Show », a button with `aria-expanded` and `aria-controls`.
  - **On the Cloud the card of the extension has no « Connect this browser »**: « Add it to your
    browser. The page that opens signs you in and turns on {site}. » is what happens, since the
    welcome page signs in and turns the site on (FRU-482, FRU-483). The link beside the install sent
    people to `/connect`, a page that waits for the popup, while the welcome page was already open. A
    self-hosted console keeps it, as it opens the pairing link of its worker (FRU-238). The states of
    the card when the extension is already here (FRU-441, FRU-487) are as they were.
  - **The end shows the note that came**: its text, its page, its selector and its component as the
    index keeps them (the first 64 characters, FRU-237; the element, FRU-613), « Show on the page »
    that opens the page on it (`#fruitback-note=`, only for a page of the site), then « Connect Linear
    or GitHub » (the Connectors screen) and « Open the console ». The console reads no store of the
    notes. A row from before FRU-613 has no element until a read of its page writes it: the note is
    shown without it. The first note is the one created first in a page of 8, read by its
    `createdAt`, and only when that page is the whole list (no `next`): otherwise it is not the first,
    and none is shown. A worker with no index answers `404` to the list, and the end is said without the
    note. The sentence says « a tracker or your own API »: GitHub is a
    source only where the worker has its App (FRU-361).
  - **Still waiting**: « Signs in with this account. No code to type. » (a browser is still connected
    from here until the popup asks, FRU-238, FRU-251). **The script keeps `data-fruitback-endpoint`**
    (inventory A24): the widget finds its worker by that attribute only.
- **The setup takes the address of a visit** (FRU-635, board S1 of the « état des lieux UX »). The
  landing sends `/setup?site=<address>`.
  - **Before the sign-in**, the lead names the site, step 2 says « Added as soon as you are signed
    in. » under it, and the preview frames it at once. `?site=` is read as a typed address
    (`siteAddress`); one that cannot be an address is ignored, and the setup is the one of before.
  - **It is kept in the tab for an hour** (`setup-address.ts`, in `sessionStorage`), as
    `connect-return.ts` keeps a request: a provider brings the browser back to the root, and the front
    door sends to `/setup` with no query. It is forgotten when a site is there.
  - **It is added once signed in, only to a workspace with no site**, with the values of `NEW_SITE`,
    by `siteStage`. A link of somebody else can name the address, so it is said before the sign-in,
    it adds nothing to a workspace that has sites, and its notes are seen by the members only. A
    refusal opens the form on the address, with the reason.
  - **The providers come before the e-mail** in step 1: they need no inbox and no return to this tab.
    The boxes of step 1 differ from the mockup of 2026-10-13 on that point only.
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
  **« Install the extension (beta) » (« Install the extension » at step 3 of the setup, FRU-610) leads Chrome and Edge on a computer to the Chrome Web Store,
  Firefox on a computer to addons.mozilla.org, and every other browser to the guide**
  (`extensionInstallFor` of `extension-store.ts`): the foot of both rails (FRU-406), `/connect`, the
  invitation and the step « Put it on your site » (FRU-409). The extension is on the Chrome Web Store
  since 0.3.0 and public on AMO (FRU-536, after FRU-521 for the guide and the landing): « Install it
  in Firefox (beta) » (FRU-318) leads to its AMO listing too. A phone keeps the guide. A guard of
  `extension-store.test.ts` reads each screen for it; `e2e/console-extension-store.spec.ts` holds the
  rail and `/connect` in Edge and Firefox.
- **The address of a site is read by `site-address.ts`, on every screen that asks for one**
  (FRU-167). A host with no scheme is `http://` when it is local (`localhost`, `*.localhost`,
  `*.local`, `127.0.0.0/8`, `[::1]`, `10/8`, `172.16/12`, `192.168/16`) and `https://` otherwise,
  as in the extension (FRU-314): the address kept is the one the person opens. **A site is written
  with its scheme on every screen** (`siteLabel`): two sites that differ by their scheme alone read
  as two, and « Open » opens the one that was added. **The Sites screen drops the scheme that the
  host typed alone would get** (`siteName`, FRU-408, Mathieu): `acme.dev` for `https://acme.dev`,
  `localhost:3000` for `http://localhost:3000`, and the other scheme is written (`http://acme.dev`),
  so two sites still read as two, and the name typed again is the same site. The field is not `type="url"`:
  the browser stopped the form with its own bubble, in its own language, and the sentence of the
  console never showed. The worker still decides what a site is.
- **The console draws its controls with HeroUI v3, through its own kit** (FRU-125). `ui.tsx` is the
  one file that imports `@heroui/react`. A screen uses the kit, and `messages.test.ts` fails on a
  native control in a screen. **A button takes no `title`**: a tooltip does not open on a disabled
  control, so the reason is written beside it. The overlays of React Aria position with inline
  styles, which the console's CSP allows (`style-src 'unsafe-inline'`); its scripts stay hashed.
- **The values are the slate theme's (FRU-683, 2026-11-25), named once**, on the shapes of the
  mockup of 2026-10-13 (FRU-232). `design/README.md` has the table. **A screen writes the name of a
  token and never a value**: `tokens.test.ts` fails on a colour written in a screen or in the kit,
  and on a colour of the palette of before anywhere in the console; `theme.test.ts` fails on a
  radius written as a value or as a step of Tailwind's scale, and on a height of a control of
  before. A token that a screen needs and that is not there is added in a pull request of the kit,
  not in the screen. **The Tailwind theme is shared** (FRU-677): `packages/shared/tailwind/theme.css`,
  one plain `@theme` block that the console, the extension, the widget and the docs import, every
  size in px. **The console's own tokens are in `app/theme.css`** (`@theme static`), which `app.css`
  imports after the shared theme: it sets the slate values again for the console alone, so the
  extension, the widget and the docs do not change. Each token is a CSS variable on `:root`, which
  a setting of the appearance (FRU-694) changes at once. `app.css` keeps the variables of HeroUI,
  which read the tokens. `shared-theme.test.ts` builds the shared theme without the preflight and
  holds its utilities to `var(--color-…)`, so the dark block of a surface repaints them.
- **One radius, three heights, Inter at 13 px** (FRU-683). A button, a field, a select, a search,
  a chip and a menu are `rounded-control` (6 px), a card `rounded-card` (8 px), a modal
  `rounded-modal` (10 px); HeroUI's scale (`rounded-md` to `rounded-4xl`) is the radius of a
  control. A control is `h-control-sm` (24 px), `-md` (28 px) or `-lg` (32 px). The text is Inter
  (`@fontsource-variable/inter`, served by the console, so the CSP does not change) at 13 px on the
  body; the root keeps 16 px, which a `rem` of Tailwind and of HeroUI measures from. A red word is
  `text-accent-strong`: the accent is under 4.5:1 on the slate tints.
- **HeroUI takes the theme, and the kit takes the shapes.** `app.css` gives the variables of HeroUI
  the tokens, so a button of HeroUI and `bg-accent` paint the same red. HeroUI writes its
  components in the cascade layer `components`; the rules of the kit (`.kit-*`) are in no layer, so
  they win whatever their selector, and each one is a measure read in the code of the mockup.
  **A state that HeroUI derives is measured** (FRU-163): it lightens a hovered button, moves it
  under a press, tints a hovered field and draws an alert as a white card with muted text. The kit
  gives each of these the value of the mockup, which changes a colour at once and moves nothing.
- **The kit, component by component** (`ui.tsx`):
  `Button` (`tone="primary"`: the action of a step, 32 px; `tone="outline"`: the
  rectangle of a control, at 32, 28 or 24 px with `size`; `to` or `href` makes it a link of
  the same box; `label` gives a longer name to a screen reader, « Connect Jira » over « Connect »,
  and starts with the words shown), `WideButton` (an outlined button over its column), `LinkButton` (underlined words;
  its padding is its target, 33 px at the least, where the mockup draws « Rename » at 21 px; in a row of a table it takes the line of the table),
  `IconButton` (28 px, named by `label`), `Field` and `Choice` (32 px, `compact` 28 px, `locked` for
  a value set elsewhere; the value of a `Choice` in the type of its button, so its words sit on the
  baseline of a field beside it (FRU-412: HeroUI writes it at 14 px on a line of 20); `status` on a `Choice` draws the drop of the chosen status in a list of 28 px), `Pick` (radio cards), `Toggle`, `FilterChip` (`aria-pressed`), `StatusDot`
  and `StatusBar`, `DataTable` (`stack`: under 640 px one card per row, its cells one under the other, FRU-505), `SidePanel` (named by its title, or by `label`; `panelId` for `aria-controls`; `flush` for an accordion under its row), `KeyValue`, `SuccessMark`, `Title`, `Lead`, `PageHead`,
  `Initial`, `Card`, `Chip`, `Disclosure` (sections folded under one line, a `<details>`: Enter and Space open it, a screen reader hears it expanded or collapsed, and its line is 44 px between two rules, FRU-538), `Problem`, `LoadFailed` (a read that failed: a title, a sentence that nothing is lost, and one « Try again », FRU-508), `Logo` (the name as outlines, in tokens: `logo.tsx`), `EntryPage`
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
  `prefers-reduced-motion`. The drop of the entry on screen that slid to the new entry (FRU-413) went
  with the dark rail (FRU-684): the entry on screen is a tint, which does not move. No colour
  transition on the bar: `e2e/console-frame.spec.ts` reads the colours of a hovered entry and would
  read them halfway. `e2e/console-moves.spec.ts` reads every frame of a move, with a control. **The
  room of a screen fills the height of the window** (FRU-564): the column beside the bar is a flex
  column and `Screen` grows in it; under 1024 px the frame is a column too, the folded bar at its own
  height and the screen under it. `e2e/console-frame.spec.ts` holds both widths.
- **The frame of a workspace is the compact bar of FRU-684** (option A of its mockup, « Barre
  latérale (3 options) », attached to the ticket; `routes/workspace.tsx`), in place of the dark rail
  of FRU-234. **The rules, in short:**
  - 232 px wide, on `sidebar`, a rule of `line` on its right. The head is 40 px: the workspace (a
    tile of 20 px, its name, a chevron) and the search. The entries are 28 px, 8 px in, an icon of
    16 px, one under the other with 1 px between; the one on screen has `aria-current="page"`, the
    tint `selected` and its words in 600; under the pointer an entry takes `hover`.
  - **The sections are Notes, Sites, Connectors, Members, Settings**, in that order. « My account »
    is no section: **the menu of the person**, at the bottom of the foot, opens it, with « Sign
    out ». `SECTIONS` lists them with `built`, and `frame.test.ts` holds `built` to the routes of a
    build, and « My account » (`ACCOUNT`) to the menu, so no entry leads nowhere and every screen has
    a way in.
  - **The counts at the right of the entries are props of the bar** (`counts`, `failing`): a red dot
    and the number on « Connectors » when sends failed. **The frame reads them once** (FRU-711,
    `GET …/rail`, `railCounts` of `api.ts`), when it mounts and at each change of workspace, never
    for a screen: « Notes » counts the notes that are not done nor closed, « Sites » the sites the
    person reads, « Connectors » the sends that did not arrive, and each view its filter. Counting
    the notes of every site on every screen was taken away for its cost (FRU-497): this read is one
    statement over the notes, measured in `worker.md`. **A screen that reads a count again says the
    newer one**: the Connectors screen the sends (FRU-690), the Notes screen the count of a view
    (FRU-697); the answer of the bar does not write over what a screen said meanwhile. A read that
    fails, and a count the worker does not give (no `failing` to a guest), show no count, never a
    zero. `/kit/frame`, a page of the development server, mounts the bar with the counts of the
    mockup.
  - **The views are under the sections** (FRU-697, « Views » of the same mockup): a view is a filter
    of the Notes screen with a name, and its entry is a link to the address of that filter
    (`saved-views.ts`, which has its own test). « Views » is 600 11px in `muted` and names the
    navigation; an entry is one of the bar, its first one 31 px under « Settings ». **The views are the
    three of the mockup** (FRU-722): « New this week » (`created=week`: the notes left since midnight
    of the day of the person six days ago, which the Notes screen asks the worker as `since`, an
    instant; a circle of dashes), « Assigned to me » (`assignee=me`, the initial of the person on
    `avatar` in 16 px) and « Not delivered » (`undelivered=1`, red braces, and its count red when it is
    more than zero, with no dot: the dot says a failure of a connector). Each filter is in « Filter »
    too (« Left », « Delivery »), with its chip. A view exists only for a filter the worker reads: a
    view it did not filter would show a list it did not filter. A guest has « New this week » alone:
    a task is never given to a guest (FRU-673), and a guest does not see where a note went. **The
    Notes screen with the filters of a view, and no other, is that view**: its entry is the one on
    screen, not « Notes »; the page, the board and a task opened are no filter. **The count of a
    view is the one of the read of the bar (FRU-711), then the `total` of the last read of the Notes
    screen with exactly its filter**, kept by the frame for this workspace as the red count of
    « Connectors »: no screen asks the worker for a view more than before (`e2e/console-views.spec.ts`
    counts the reads). A read again, after a
    write (a status, a task, « Send again »), drops the counts of the views when it starts, as the
    write can change them and its answer can be dropped: a count that may be wrong is not shown, and
    a view read again says its new count. A view a person makes
    from the bar of filters needs the worker to keep it (FRU-723): the console keeps none.
  - **The fixed foot**: « What's new » (the releases on GitHub, with a dot until this browser opened
    it with this version of the console, `whats-new.ts`), the extension (« Install the extension
    (beta) », or « Extension » with a green dot and the browser connected), « Help and docs », a
    rule, and the person (initial, name, address). Each link that leaves the console opens in
    another tab, so a screen keeps what is typed in it. The bar of the instance has the same foot,
    with « Self-hosting guide » in place of the help.
  - **The search of the head opens Notes with « Search notes » in focus** (`state.search` of the
    move, read by `NotesFilters`): no screen searches the whole workspace.
  - **Under 1024 px the bar is folded** above the screen: its head, and « Menu » (`aria-expanded`,
    `aria-controls`), which unfolds the entries and the foot under it. Escape folds it and gives
    focus back to the button, and a move to another screen folds it. The page never scrolls
    sideways.
  - The focus ring is the one of the page: the red of the accent is at 3:1 and more on the bar and on
    the tint of the entry on screen.
  - `e2e/console-frame.spec.ts` reads the values and the boxes of the mockup at 1440 px, the counts,
    the foot, the menus, the keyboard, axe, and the folded bar at 1023 and 390 px.

  What stays of FRU-234 and after: **each entry has an icon** (FRU-477, `rail-icons.tsx`), inline on
  a grid of 24, a stroke of 2 in `currentColor`, `aria-hidden`; « My workspaces » of the bar of the
  instance has an arrow to the start of the line (FRU-476). **The name of the workspace opens a menu
  only when the person has several workspaces**: with one it is a link to `/w/<id>/settings`
  (FRU-414), `aria-current` there when the bar has no « Settings », and draws no chevron; with
  several, the menu of the workspaces ends with « Workspace settings », in a group of its own under
  a rule that chooses nothing (`after` of `Menu`). Each workspace of that menu has its tile before
  its name, as the name of the bar has (FRU-661, `mark` of `MenuItem`): its logo, or its initial; the
  tile is a picture, so the name of the item stays its name and its role. The screen renames the workspace for an owner or
  an admin (FRU-236), and the bar shows the new name at once; another role reads the name, locked.
  **The logo** (FRU-428): `WorkspaceMark` draws it at 20 px in the bar and 40 px on the settings
  (`object-contain`, the worker resizes nothing), and the initial of the name when there is none or
  it does not load. An owner or an admin sends it (`FilePick` of the kit), replaces it and removes it
  in one press, with no confirmation: it is sent again as easily. The console refuses a type that is
  not PNG, JPEG or WebP, and a file over 512 KB, before it sends anything (`workspace-logo.ts`), and
  says each refusal of the worker. `e2e/console-workspace-logo.spec.ts` holds it. **The settings are
  « Settings » in the bar, last, for an owner or an admin** (FRU-503, `sectionsFor`): a member and a
  guest have no entry and read the settings from the name. On the settings the entry is the one on
  screen, and the name is not a second one. **« General » is two cards** (FRU-693, the mockup
  « Réglages General »): « Identity », a row each for the logo, the name and the address of the
  workspace in this console (`<host>/w/<id>`, read only: the worker keeps no other name for it),
  each box 320 px wide at the end of its row and under the words below 640 px; then **« Danger
  zone »**, a light red border (`danger-line`), for the owner alone. The name leaves by « Save » in
  the head of the page, disabled while the name typed, trimmed, is the one kept, or by Enter in its
  field; the logo leaves as soon as it is chosen, as before. **« Delete… » opens a dialog** that says
  what goes and deletes only once the name of the workspace is typed in it, case and all (spaces
  around do not count): `DELETE /console/workspaces/<id>`, which the worker refuses to anybody but
  the owner (`delete-workspace`). A refusal is said in the dialog, which keeps what was typed; « Keep
  it » and Escape close it and send nothing. The control of the zone is the tone `danger-outline` of
  `Button`, and the button of the dialog `danger`: a deletion stays red whatever the accent (FRU-694).
  « My account » keeps what is about the person. **The
  section « Agents » shows the whole way of an agent** (FRU-503): its key, an address that receives
  (Connectors), then the trigger of each site, a link to `#agent` on the page of the site; anybody
  but an owner or an admin reads one sentence, and the page asks nothing. **The settings are pages
  of a shell** (FRU-692, `routes/settings-shell.tsx`; before, FRU-544 put « General » and « AI » in
  two links of `SubNav`): a bar of 48 px that says « Settings », a navigation of 220 px with an icon
  on each entry, in two groups, and the page beside it, with a head of its own (`SettingsHead`: a
  title of 20 px, its sentence, its actions at the right). « Account »: Profile (`/account`) and
  Sessions (`/account/sessions`), Appearance (`/account/appearance`). « Workspace »: General (`/settings`), AI (`/settings/ai`), Agents
  (`/settings/agents`, no crumbs any more), and Members and Connectors, which lead to the screens of
  the bar. The addresses did not change, so no redirection. **The navigation shows an entry only for
  a page that exists**: `ACCOUNT_PAGES` and `WORKSPACE_PAGES` hold « Sign-in and addresses »
  and « Notifications » with `built: false`, and `settings-shell.test.ts`
  holds `built` to the routes of a build. Under 768 px the navigation is one row above the page,
  which scrolls in its frame. The shell takes back the padding of `Screen` with the same values, so
  its bar and its navigation reach the edges of the column.
  **Settings › Appearance** (FRU-694, `routes/account-appearance.tsx`, the mockup « Apparence »):
  a card « Theme », five themes drawn in small (Slate, the default, Snow, Zinc, Midnight, Graphite;
  no beige), and a card « Customize », one row per setting: the mode (Light, Dark, System), the
  tint of the sidebar (from the page to ink), the accent (six), the density (rows of 32, 36 or
  40 px), the radius (0, 4, 6, 8) and the size of the text (12, 13, 14), with « Reset ». **The
  appearance only sets tokens** (`app/appearance.ts`): it writes the variables of `theme.css` and
  `app.css` on `<html>`, inline, and adds no style. A theme is light or dark; the mode chooses the
  light one or the dark one, and « System » follows `prefers-color-scheme` while the page is open.
  **The sidebar has its own copy of the colours** (`app/sidebar.css`): in `.kit-rail` each token
  reads `--sidebar-<token>`, which is the token of the page unless a tint sets it, so an ink sidebar
  on a light page writes its words light and keeps a ring that shows. A red word and a deletion
  stay red whatever the accent. **Every theme, tint and accent holds AA** (`app/appearance.test.ts`
  computes each pair: 4.5:1 for a text, 3:1 for the border of a control and the ring). **No flash**:
  the choice and the variables of its two themes are kept in `localStorage`, and
  `public/appearance.js`, a script of the page before the bundle, writes them on `<html>` before the
  first paint; it knows no theme. **The account keeps the choice** (FRU-716): each choice goes to
  `POST /console/me/appearance` (`keepWithAccount`, one request at a time, then only the last
  choice made meanwhile), and each answer of `/console/me` writes the choice of the account in this
  browser (`adoptAppearance`), or takes the copy away when the account holds none, so the choice of
  one account never stays for another one. A sign-out takes it away too (`forgetAppearance`). A
  choice on its way wins over an answer of `/console/me` read before it. A choice the account did
  not take shows in the tab, and the page says so. `app/appearance-account.test.ts` holds the
  values of the worker and of the console together. The density is `--spacing-row`, which the
  table of the notes reads; a table that is drawn again reads it too.
  `e2e/console-workspace-settings.spec.ts` holds the entry by role, the section, « Save » disabled
  with no change, and the deletion typed in its dialog.

- **The bar is as high as the window, and only the screen scrolls** (FRU-402, FRU-398). `Frame`
  of `routes/workspace.tsx` is the frame of a workspace and of the instance: from 1024 px the bar
  is `sticky` at the top and `h-dvh`, so its foot stays at the bottom of the window, and a window
  lower than the bar scrolls the bar itself. **The document scrolls, not the column**: a column that
  scrolls takes the keys of the keyboard only once it has focus, and `scrollIntoView` and the specs
  read the document. Under 1024 px the folded bar is above the screen and scrolls away with it. **A
  screen is as wide as its column** (`Screen`): the mockup capped each one, from 820 to 1240 px,
  which left an empty band at the right of a wide window, and Mathieu asked for the whole width on
  2026-10-23. `e2e/console-frame.spec.ts` holds the bar after a scroll at 1440 px and at 390 px,
  and the right edge of each screen.
- **The Sites screen is a dense table, one line of 36 px per site** (FRU-688, the mockup of the
  redesign of 2026-11-25, in place of the grid of cards of FRU-408 and FRU-432, `routes/sites.tsx`).
  **The head of the screen** is 48 px, « Sites » and « Add a site » (28 px), as the head of Notes
  (FRU-686); the sentence under the large title went with it. « Add a site » opens with a plus of
  14 px, 6 px from its words and 10 px in, as the mockup draws it (FRU-650): `inset` and `gap` of
  `Button`, and the `add` of `settings-icons.tsx`, the plus of « Add » on the addresses. **The bar under it** is 44 px: the
  search by address (240 px, « / » gives it the focus, `useSlashKey` of `notes-filters.tsx`), then
  **the colours of the statuses** at the right, the drop and the name of each stage (in place of « no
  legend » of FRU-400: the ticket asks for it); under 720 px the colours go, and the name of each bar
  still says its counts. **The table** goes from one edge of the screen to the other, a head of 32 px,
  then per site: the site (its icon in 20 px, its host, the site itself in a new tab), its notes (a bar
  whose name says the counts, and how many) or « Waiting for the first note », its new notes (« 3 new »
  in red after a dot, a link to the Notes screen with the site and « New » chosen, FRU-570), where they
  go (to whoever sees the tracker), who sees them, the last one, and the menu. **No cell goes on a
  second line**: what is longer is cut with « … ». **The columns go by the width of the table**, a
  container query as in the Notes table (FRU-685): who sees the notes under 1100 px, where they go under
  800, the notes under 600, the last note under 440; at 390 px a row keeps the site, its new notes and
  its menu, and nothing scrolls sideways. A column that has no room is 0 px wide, its head said to a
  screen reader only. **A press anywhere on a row opens the page of the site**; the host is the link a
  keyboard and a screen reader reach, and a press on a control of the row (a link, the menu, a
  tooltip) is the control's. Cmd or Ctrl and a press open the page in a new tab.
  **Where the notes go** is the logo of each tracker (FRU-541, the mark of the Notes table, read from
  the first word of the label of the worker: « Linear », « GitHub », « REST API »; a word it does not
  know has no mark, and its name before the place), then the places on one line: « Team Acme web » for
  one place of a Linear, « Acme web, Support » for several. The labels of the worker are whole in a
  tooltip. The team of one Linear place is a link to its page at Linear (FRU-574). Notes an address did
  not take yet add **the icon of a retry in red**. To an owner or an admin it is **a button that sends
  them all again** (FRU-717, `POST …/sites/<site>/retry`): disabled while it asks, so two presses ask
  once, and its answer under the row, « 4 notes of this site are on their way again. », « Press again
  to send the 20 others. » past 100, or a refusal as a problem. Its count stays the one of the list: it
  goes down when the notes arrive, at the next read. To a member it is a link to the notes of the
  site, where each one shows where it went. A disabled button of HeroUI lets a press through to its
  row, so its wrapper is one of the controls a press on the row leaves alone (`[data-resend]`). A site with no tracker says « Kept in Fruitback » after the drop, and **a band in
  dashes under the table** names the sites of the page that keep their notes in Fruitback, with
  « Connect a tracker » (the dialog « Add a connector » of the Connectors screen, FRU-571). **Who sees
  the notes** is « Members only » or « Everyone who visits » after its icon, and names no workspace
  (FRU-583); where anyone on the page writes a note on a site that its members read (FRU-330), a
  pencil follows, its words in a tooltip and to a screen reader. **The last note** is short to the eye
  (`agoShort`: « 2h », « 40m »), whole under the pointer and to a screen reader (`ago`: « 2 h ago »).
  **A problem of a site is a line of its own under its row**, the only line taller than 36 px: a public
  repository (FRU-382) and a place that the tracker refuses (FRU-640). The counts are the summary of
  the sites (FRU-237), in the answer that lists them: **nothing of a row comes after the row**, so
  nothing moves under a press, and a test holds the read to prove it. A value with nothing to say
  draws « · » for the eye and says « None yet » to a screen reader; a worker that sends no summary
  gets that, and no bar.
  **The icon of a site is its `/favicon.ico`** (`site-icon.tsx`, shared with the preview of the
  setup), asked by the browser of the person with no referrer, and its first letter when it does
  not load or the site is on `http`: the policy of the image allows `img-src https:` only. No other
  service is asked for it. Measured on 2026-10-23: under Playwright a route never sees a request to
  `/favicon.ico` (Chromium and Chrome), so the specs see the letter, and read the attributes of the
  image when there is one.
  **The worker answers the search and the pages** (FRU-497): the search keeps the sites whose address
  holds what is typed, is written in the address (`q`) 300 ms after the last key (`useTypedSearch`),
  and goes back to the first page. A page is 25 rows, with the pages of the
  Notes page (`NotePages`), and lives in the address (`page`); a page past the last shows the last.
  A search that keeps nothing says so, with « Clear the search ». A new site is the last one: its
  page is shown, with no search.
  **The table unfolds nothing under a row** (FRU-433, Mathieu). **A site has a page of its own**,
  `/w/<workspace>/sites/<site>` (`routes/site.tsx`), reached from its row, its host and its menu:
  « Open its page » and « See the notes », for every role; « Statuses » and « Remove », for who manages
  the sites. « Remove » leads to the tab « Advanced » of the page (`/advanced#remove`). A new site
  opens its page at its tab « Install » (FRU-689). « Remove » asks twice: the menu is the first time, and `Confirmation` (`confirm.tsx`) on
  the page the second; once the site is gone, the table comes back with focus on its search, or on
  the field of the card when it was the last one. **No item changes who sees the notes of a site, nor
  who writes them** from the table: the form that adds a site asks it, in the card of a workspace with
  no site too, and the page of the site holds the rest. **A host is on one line, cut with « … »**
  (FRU-585, Mathieu): `CutLink` of the kit, in a `span` in the head of its row, whole in the page for a
  screen reader, and whole in a tooltip **only when it is cut**, measured on the link
  (`scrollWidth > clientWidth`, again on a resize and once the fonts load). The tooltip opens under the
  pointer, with the focus of the keyboard (Escape closes it), and on a long press of a finger (500 ms,
  and the `contextmenu` of Android), which then does not follow the link; the next press anywhere
  closes it. The card of a workspace with no site and the alert of a read that failed are sized by
  their content (`box-content`): 640 px and 760 px inside their padding, 24 px under the head.
  **« Add a site » opens a dialog** (FRU-558, `Dialog` of `ui.tsx` on HeroUI's Modal): named by its
  title, focus in its field and kept inside, Escape or its close button close it, and focus goes back
  to the button. A press outside does not: it would hide the form and its refusal. What is typed stays
  when it closes. Once the field holds an address and nobody typed for 600 ms, the dialog shows the
  icon and the domain of the site, then its page in the sandboxed frame of the setup (`SitePreview`).
  The browser of the person asks the site, under the `img-src https:` and `frame-src` the console
  already has; **the worker fetches no typed address**, and no policy changed. The card of a workspace
  with no site keeps the form in place. `e2e/console-sites.spec.ts` holds the three states, the head,
  the bar, the rows of 36 px and their columns, a press on a row, the search, the pages, the form and
  its dialog, the menu, the roles, 390 px and axe; `e2e/console-table-heads.spec.ts` holds every head
  and every text of a row on one line, in French, at four widths.
- **The page of a site is in tabs** (FRU-433, then FRU-689 and the mockup « Un site »). One frame,
  `routes/site-frame.tsx`, reads the site once (`GET …/sites/<id>`, FRU-497) and draws, for every
  tab: the head of 48 px of the redesign (the crumbs « Sites › site », the site as the title,
  « Open site » in a new tab and « See its N notes »), then the row of the tabs (`parts/site-tabs.tsx`,
  44 px, an icon and the words of each). **Each tab is a route**, so the tab on screen is in the
  address, a reload and the way back keep it, and a move between tabs asks the worker nothing:
  « Overview » (`…/sites/<site>`), « Install » (`/install`), « Destinations » (`/destinations`, an
  owner or an admin who sees the tracker), « Statuses » (`/statuses`, an owner or an admin),
  « Access » (`/access`, every role, FRU-703) and « Advanced » (`/advanced`, an owner or an admin:
  « Start an agent », the preview builds and « Remove this site »). A member and a guest have no tab
  of an owner; reached by its address, one says why in a sentence and asks the worker nothing. A tab
  that changes the site hands the frame what the worker kept, so « Overview » shows it at once. A
  hash of the page of before (`#install`, `#destinations`, `#statuses`, `#advanced`, `#agent`,
  `#previews`, `#remove`) opens its tab, and a section inside a tab keeps its hash and is scrolled to.
  A site that is not in the workspace says so, and a read that failed is the alert with « Try again ».
  **« Overview »** draws, on the left, three figures, the card « Site » and where the notes go; on
  the right, from 1100 px, the card « Install » in a column of 420 px. **No figure the worker does not
  give**: « Notes » with the bar of its statuses, « Open » (the new notes, and the age of the oldest
  open one, « oldest 5 days », FRU-721), and « Delivered » for whoever sees the tracker: the share of
  the notes of the last 30 days that arrived, « last 30 days » under it, or a link to the ones that
  did not (`?site=&undelivered=1`, FRU-722). From a worker of before FRU-721, « Open » says how many
  are to do or in progress and « Delivered » the share of every note (`undelivered`, FRU-122).
  The card « Site » is a row of 44 px for each setting (an icon, its name, its value), with
  « Change » to the tab that changes it, for an owner or an admin: « Access » for who reads, who
  writes and the e-mail of FRU-604; « Install » for how the notes came, for every role. Where the
  notes go is a row of 48 px for each place, the logo of its tracker, « Default » on the first, and a
  menu: « Make it the default », « Remove ». « Add » leads to « Destinations ». The card « Install »
  has the script and the extension in a segment; the script is on ink (`Snippet` of the kit, tone
  `ink`: the page and the ink swapped, so a dark theme draws it light), with the address of this
  console, which is the instance's in production, and « Copy ». **« Installed » once the worker saw
  the widget on the site** (FRU-721: `seen` of the read of one site, written from the read of the pins
  of a page, an hour apart at most), with « Seen on the site 2 h ago » under the script and « Seen
  with the extension … » under the extension. Before the worker saw it, « Notes came » once a note
  came by the script or the extension, with when the last note came, and « Not seen yet » before. `e2e/console-site-page.spec.ts` holds the head, the tabs in the address, the figures, the
  rows, the menu of a place, the card « Install », the roles, the hashes of before, the two failures,
  390 px in English and in French, and axe.
  **The address of the site is a link to it** (FRU-575, Mathieu), in a new tab with no referrer, so
  the console stays where it is; a screen reader hears « (opens in a new tab) ». **Where the notes go
  reads top down** (FRU-576, Mathieu): the title is « Where the notes go », as « Install » names no
  site (the region keeps the name of the site); the sentence under it says what the default does, or
  that the notes stay in Fruitback; the places are the rows of one frame, the mark, the name and
  « Default » at the left and their actions on the same line; and « Add a destination » is written
  above the search and the list that add one, and names them as a group.
  `e2e/console-site-places.spec.ts` holds the frame and the line of a place.
- **The agent keys of a workspace have a page of their own** (FRU-462, `routes/agents.tsx`, the
  board `design/agents/`), `/w/<workspace>/settings/agents`, with the crumbs « Workspace settings ›
  Agents », reached from the section « Agents » of the settings. It is no section of the rail, and
  « Settings » is the entry on screen there: only
  the owner and the admins make a key (decision 5 of [agents.md](agents.md)), and anybody else reads
  one sentence there, and on the page, which then asks the worker nothing. **The key is shown once**,
  in a card above the list, held in the state of the screen and in no storage of the browser, with
  the line that connects Claude Code (`claudeLine` of `agent-keys.ts`, the line of `docs/agents.md`
  with the address of this worker and the key) and a button to copy each; « I kept it » takes it off
  the screen. **The list** says, for each key, its sites, its rights and whether it reads only the
  notes of known people, its last use (`lastUsedAt` of the worker, to the minute, with `ago()`), and
  its end; 7 days or less before it, « Ends in N days » in the strong accent and one line above the
  list that says what to do (`keyEnd`); an ended key stays until it is revoked. « Writes » unfolds
  what the key wrote under its row (`aria-expanded`), read when it opens; the note is named by its
  id, with no link: the console has no page of one note. « Revoke » asks a second time (`Confirm`).
  **No edit of a key**: the worker has no route, and a key that changes under a running agent is a
  surprise. Two things of the kit came with it: `Checks`, a group of boxes with its hint or its error
  (the sites of a key), and `expanded` and `controls` of `Button`. `e2e/console-agents.spec.ts` holds
  the way from the settings, the list and its warning, a key made, shown once, copied and gone, the
  refusals, the writes, the revocation, a member, and 390 px in French, with axe.
- **« Start an agent » is a section of the page of a site** (FRU-468, `parts/site-agent.tsx`, the
  board `design/agent-triggers/`), first in the tab « Advanced » (FRU-689), for an owner or an admin; a member and a guest
  do not see it, and the page asks them nothing of the trigger. Off by default: the switch alone.
  On: « Call », an address that receives of the workspace (a `rest` connector; a tracker is not
  offered), « When » (a note of a known person, or a note moved to To do by a person), and what the
  call carries, drawn from the site and the moment: ids, never the text. One « Save » writes the
  three; a refusal keeps what was chosen. With no address that receives, a callout leads to
  Connectors. Calls that did not arrive are counted there, with a link to the address, whose panel
  lists them with « Call of an agent » beside the notes. `e2e/console-agent-trigger.spec.ts` holds it,
  with axe and 390 px in French.
- **The statuses of a site have a page of their own** (FRU-371, `routes/site-statuses.tsx`), reached
  from « Statuses » in the menu of a row and from its tab on the page of a site (FRU-689), for an
  owner or an admin. It is the board
  `design/site-statuses/`; [statuses.md](statuses.md) says what it does and why. Since FRU-689 it is a
  tab of the page of the site, under its head of 48 px. Elsewhere, **the title of every page of a frame is at one place** (FRU-405): 40 px
  under the top of the screen, at the left of its padding, 28 px. `e2e/console-titles.spec.ts` reads
  it on the eleven pages of a workspace and of the administration, at 1440, 1492 and 390 px. Two things of the kit
  came with it: `Field` takes `error` (the sentence a field is described by, `aria-invalid`) and
  `inputRef`, so a refused press gives focus to the field it names; and `.kit-pin`,
  `.kit-status-chip` and `.kit-swatch` in `app.css` draw a status as the widget does. Its colours
  are data of the site, given in a style; the colours of the stages are read from the tokens, so no
  value is written twice. `e2e/console-statuses.spec.ts` holds it at 1440 px in English and 390 px in
  French, with axe.
- **The Notes page lists the index of the notes, never their text** (FRU-245, `routes/notes.tsx`,
  read from the route of FRU-244). A note is its first 64 characters (Q6: all that Fruitback keeps
  of the text), on one line since FRU-685. **A row is short words beside the note** (FRU-546, 547, 552, 553,
  Mathieu on 2026-10-30): « Site » is the domain and its extension (`domainOf`, `fruitback.com` for
  `app.fruitback.com`); « Left by » is the icon of the role and the name cut to its room, both whole
  in a tooltip that the keyboard reaches too; « Went to » is the mark of the place and the reference
  on one line, the name of the tracker said to a screen reader only; the last column is an icon that
  opens the page (`<page>#fruitback-note=<id>`, the link of the widget, FRU-253) in a new tab, its
  address in the tooltip. The tooltips are `Tip` and `IconLink` of the kit (HeroUI's).
  **The table is grouped by status, as Linear groups its issues** (FRU-551, Mathieu on 2026-10-30):
  in progress, to do, new, closed, then done, each group under a head with its drop, its name and the
  notes of the whole list in it (`counts.byStage`). There is no column « Status »: the status is its
  drop before the note, a bare list of the statuses (`Choice` with `bare`) for whoever may change it,
  and a refusal is said under the note. **The worker reads the table by status** (`order=status` of
  `GET …/notes`, the route of the console only; `/mcp` and the extension read by date), so a group
  goes on from one page to the next and the cursor holds the rank of the stage. A cursor of one order
  is refused in the other, and « Table » and « Board » start again from their first notes. The board
  reads by date: its columns are those of the notes read. **A note whose status changes while the list
  is read is where its status is when its chunk is read**: the key of the order changes with it, as no
  cursor on a status can avoid. Moved to a group already read, it is not in the chunks still to come;
  moved from a group already read to one still to come, it is read again there, and the screen keeps
  the later read only (`appended` of `notes-chunks.ts`): one note is one row. Every note whose status
  does not change is in one chunk, and one only (`notes-list.test.ts`, every role and filter crossed).
  The console reads the list again after a status it saves, as many notes as it shows, so the person
  sees the note in its new group and stays where they were. The chips are every note and each place that has notes, in the order
  of the sources of the workspace. **« Not delivered » is no chip of the places**: it is a
  filter of « Filter » (« Delivery », FRU-722), with its chip under the bar, and a view of the bar;
  each of those notes says « Not delivered yet » on its row. The search searches the 64 characters, the page and the reference, and not « the author » of the
  mockup; since FRU-686 its field says « Search notes », in 220 px. A guest
  gets no chip, no reference and no « Send again », as the worker sends a guest none of them. **The
  filters live in the address** (`place`, `site`, `stage`, `mine`, `q`, and the fields of the tasks):
  a reload keeps the view, the search reads 300 ms after the last key, and a filter starts the list
  again from its first notes. **A search field takes the address only on a navigation** (`app/typed-search.ts`,
  FRU-279): a key can come after the field writes the address and before the screen draws it, and
  a field that took every new address lost that key. The three search fields of the console, here,
  on Notes of the instance and on the lists of the administration, use it. **The notes of a workspace scroll with no end** (FRU-724, Mathieu on 2026-11-26), in place of
  the pages: the next 25 notes are read by the cursor of the last answer when the end of the list
  comes within 720 px of the bottom of the window (an `IntersectionObserver`), and again while it stays
  there. « Load more » under the list reads them too, for the keyboard, a screen reader, and a browser
  whose observer does not fire; a screen reader hears « 25 more notes. 50 of 263 shown. » (`role="status"`).
  The total stays in the bar of the filters, and « 50 of 263 » under the list. One read of the next
  notes at a time: a press or the observer while it is on its way asks nothing. A filter, the search, a
  view, the table or the board, or another workspace is a new list: it is read from its first notes and
  drawn from its top, and the answer of a read of the list of before, the next notes included, is
  dropped. A read of the next notes that failed says so under the list with « Try again », and leaves
  the notes above it on the screen (FRU-682). Only the chunks after the first are read with
  `counts=none` (FRU-502). The address holds no cursor: a reload, or a link, starts the list again, and
  opening a task and closing its panel reads nothing, so the list and its scroll stay where they were.
  **The screen keeps 500 notes at most** (`NOTES_KEPT`): past them it says that a filter or the search
  finds the others. A read again, after a write, reads back the notes shown, in reads of 50 (the most
  the worker reads at once), so 10 reads at most. The state of the read of the next notes (« Loading… », what a screen reader hears) is kept apart from the list (`moreStore` of `parts/notes-more.tsx`), so that it draws the end of the list and not every row: at 450 rows a draw of the list was 140 ms of script (measured, FRU-724), and a press of « Load more » made two. The days of the rows are written with one `Intl.DateTimeFormat` for each language and options (`ago.ts`), which made a quarter of that script. `e2e/console-notes-pages.spec.ts` holds it, with
  the races. **A read again keeps the rows on the screen**
  until its answer replaces them: only the first read says « Loading… », and nothing a pointer can
  reach moves meanwhile. A workspace with no note says so, a filter that keeps nothing says so with
  « Clear the filters », and a read that failed is the alert of the Sites screen, never « No note
  yet ». **Where the list is narrow, it drops columns** (FRU-685, in place of the cards of FRU-505 and
  FRU-586): see the bullet of FRU-685 below. **The notes scroll under their filters** (FRU-586, Mathieu
  on 2026-11-03): the chips, the search and the lists stay at the top of the window in the table and
  in the board, at every width; in the list, the head of a group stays under them while a note of
  that group is on screen (under `--kit-pinned-top`, the height of the filters). The document scrolls, not the table (FRU-402):
  a frame that scrolls would hold its heads, not the window, so a pinned frame clips and never
  scrolls sideways, which the cards make possible. What takes focus is scrolled to under the heads
  (`scroll-margin-top`), never behind them. `e2e/console-notes-pinned.spec.ts` reads the heads at
  each depth of the list at 1440, 1280, 1024 and 390 px, the keyboard, and the board.
  **The pages are icon buttons and numbers** (FRU-587, Mathieu): « Previous page » and « Next page »
  are small icon buttons (`IconButton`), and between them the numbers of the first page, the last,
  and the pages beside the one shown (`pageWindow` of `page-window.ts`, which has its own test), the
  one shown in ink and `aria-current`; a press on a number keeps the focus on it. `NotePages` is the
  same on the sites, the members, the invitations and the Notes of the instance, which keep
  « Previous » and « Next » only (they are read by a cursor). Since FRU-724 the notes of a workspace
  have no pages: see their bullet above. A jump to any page would take an offset in the index of the
  worker, which the walk by cursor was chosen against (FRU-551: a note is in one read and one only).
  `e2e/console-notes-pages.spec.ts` holds the pages of the sites. `e2e/console-notes.spec.ts` holds the values, every filter, the pages, « Send again », the
  states, the roles, 390 px and axe.
- **The Notes list is one line of 36 px per note, as Linear draws its issues** (FRU-685, the
  mockup « Notes après » of 2026-11-25): fourteen notes at 1440 × 900, where the rows of one to three
  lines showed six (measured with a list of 14). `parts/notes-table.tsx`; `e2e/console-notes.spec.ts` holds the values.
  - **A line**: the box of the task and the status (the drop, or the select of FRU-551), the text at
    500 on one line cut with « … » and never underlined (a press opens the panel of FRU-653 and FRU-687), the
    marks of a task after it on the same line, the path of the page, the site (a tile and its host),
    where the note went, who left it, its age, then the page and the menu, shown under the pointer and
    the keyboard. A refusal, or « Delete… » asked again, is said under the line: only then is a row
    taller.
  - **The status keeps the drop of Fruitback**, the picture of the widget, the extension and the
    board (FRU-334), and not the circles of Linear that the mockup draws: a status of a team has its
    colour (FRU-385), and the select of a row draws the drop of each status.
  - **The round is who left the note**, as the « Left by » it replaces: the initial of a person, a
    dashed round for a visitor with no account (the people the mockup draws there are the authors of
    the list before). Who does a task is in its marks, after the text.
  - **Where it went**: the mark and the reference at 500, the host of an address, the name of a
    place. A note an address did not take reads « Failed » in red, the sentence of FRU-122 whole
    under the pointer and to a screen reader, and « Send again » is an arrow of 20 px beside it.
  - **The age is short**: « 40m », « 3h », « 2d », « 1w », then the day (`agoShort`); `ago` says it
    whole under the pointer and to a screen reader.
  - **No head of columns to the eye**: the heads are for a screen reader, and give each column its
    width (`table-layout: fixed`). « Select every task of this page » went with them: each group
    selects its own tasks from a box in its head, as Linear does; Cmd or Ctrl and A still selects
    the page (FRU-656).
  - **The groups are in the order the worker reads them** (in progress, to do, new, closed, done):
    the mockup puts « Done » before « Closed », but a group goes on from one page to the next only
    in the order of `order=status` (FRU-551). Changing it is a change of the worker.
  - **A group folds from its head**, and stays folded for this person in this browser
    (`localStorage`, by account and workspace): the worker keeps no setting of a list, and a route
    for one would be a change of the worker. « + » in the head writes a new task in that status
    (FRU-657).
  - **No cell goes on a second line, at any width**: a narrow list drops a column (a container
    query on the width of the list, not of the window): the path under 960 px, the site under 800,
    where it went under 600, who left it under 440. A column dropped keeps its place in the table at
    0 px, so the head of a group still spans the list. The list goes from one edge of the screen to
    the other.
  - **j and k** give the focus to the text of the next note and of the one before; Enter opens it.
    A field, a menu and a dialog keep their keys.
- **The head and the bar of the notes are Linear's** (FRU-686, the mockup « Notes après » of
  2026-11-25), from one edge of the screen to the other. `parts/notes-filters.tsx`.
  - **The head, 48 px**: « Notes » at 14 px, a tab per place the notes went with its mark and its
    count (`ViewTab` of the kit, the rule of FRU-548: no tabs with one place), then « New task ». No
    lead under the title. The title is not at the place of the others (`console-titles.spec.ts`
    leaves Notes out). No bell: the console has no notification to show.
  - **A tab is a place, not a kind.** The mockup draws « Webhook and REST »; the filter `place` of
    the worker reads one connector, so two connectors of one kind are two tabs, as the chips were.
  - **The bar, 44 px**: « Filter » opens a menu by field (Status, Site, Left by, then Assignee,
    Priority, Label and Due day once the list holds a task Fruitback keeps), each a choice that shows
    the value of the address. Each filter on is a chip, « field value » with a cross
    (`FilterTag`), and « Clear » takes them all off with the search. The chips are read from the
    address the list is read from, so they say exactly what the list shows. « Only my notes » is
    « Left by: Me ». **No chip « Created · Last 30 days »**: the worker reads no date of creation, and
    a filter it does not read would show a list it did not filter.
  - **At the end**: the count of the notes of the whole filter, the search of 220 px (« Search
    notes »; « / » gives it the focus, unless a field, a menu or a dialog has the key) and
    « Display », whose menu shows the table or the board. Grouping and order stay those of FRU-551 and
    FRU-436: the table is read by status, the board by date, and another order is a change of the
    worker.
  - **Controls of 28 px**, the token `h-control-md` of FRU-683, where the mockup draws 26: no token is
    26 px. Under 640 px the bar goes on two lines, and a submenu opens under its item.
- **The notes are a table or a board, and the address says which** (FRU-436, decided by Mathieu on
  2026-10-24). « Table » and « Board », two pressed buttons at the right of the head, write
  `?view=board` (the table writes nothing); the filters, the search and the page are the same, and the
  board draws the notes of the page that is shown. **A column is a status of the site in view, in
  the order of its statuses** (`board-columns.ts`, which has its own test): the site of the filter
  « Site », or the only site of the workspace. A hidden status has a column only while a note is in
  it, and takes no note. A note of a tracker has a stage only: it is in the built-in status of its
  stage (`own:<stage>`), or the first shown status of that stage. **With several sites in view, or
  no status read for the site, a column is a stage**: the statuses of two sites do not line up.
  **A note moves by a drag, and by the select of its card**: the console already changes the status
  of a note it keeps (`POST …/notes/<note>/status`, FRU-384), for its author or an owner or an
  admin, so the drag adds no right; the keyboard moves it with the same select as the table. A drag
  is offered only where a column is a status. The card moves once the worker saved it (the list is
  read again); a refusal is said above the board, and the card stays. **A card writes no status and
  no address** (FRU-589, FRU-588, Mathieu on 2026-11-03): its column says the status, and whoever may
  change it gets the drop of the table at the right of the note, the select of the keyboard, its words for a
  screen reader only; a refusal of that select is said on the card. The page opens from the icon at
  the foot of the card, its address in the tooltip, as in the table. **At 390 px the board scrolls
  in its frame** (columns of 272 px; the frame takes focus, and is `relative` so that what is placed
  absolutely in a card, the hidden select of HeroUI, does not widen the page). « Send again » stays
  in the table. `e2e/console-notes-board.spec.ts` holds the view in the address, the columns, the
  filters, the drag, the refusal, the keyboard, the stages, 1440 and 390 px, axe and French.
- **The Connectors screen is a table of health and a catalogue** (FRU-690, the mockup « Maquette HTML
  · Connecteurs » attached to the ticket): `routes/connectors.tsx` (the table, the catalogue, the
  dialog of the settings), `connector-add.tsx` (the forms), `connector-linear.tsx`,
  `connector-rest.tsx` and the others (the settings), `connector-parts.tsx` (what they share),
  `connector-logos.tsx` (the logos). **The rules, in short:**
  - **« Your connectors » is a table** (`DataTable`, a card for each row under 680 px): the
    connector with its logo and its name (FRU-404), its account (one line, cut at its end, the whole
    in its tooltip, FRU-321), « Used by » (the sites that send there, from the read of the sites,
    and the notes that went there: « 2 sites · 31 notes »; none for a routine), its health, « Last
    delivery », and at its end « Retry » and « … ».
  - **On a tablet and a phone** (FRU-727, the mockups at 834 and 390 px attached to the ticket). The
    columns follow the width of the table, a container query as on Sites: under 900 px « Used by » is
    0 px wide and its head is said to a screen reader only, so « Retry » and « … » stay in the frame
    at 834 px. Under 680 px a row is a card, drawn on the `data-stacked` of `DataTable` (its values are
    `!important`, since the kit names the frame in its selectors): the logo of 32 px at its left, the
    name with « … » at its top right, the account, then the health, the sites and the last delivery
    on one line (« 2 sites · 31 notes · 12 min ago »; the dot ends the sites, so a line that goes on
    starts with the time), and « Retry » on a line of its own at the right. With a finger
    (`pointer: coarse`) « … », « Retry » and the buttons of a tile take a press 10 px around their 24
    px, so 44 px, and « Retry » and « … » stand 20 px apart. The frame of the console (the bar folded
    under 1024 px) is not this screen's: the header of the mockups (the path « Acme / Connectors »
    on a tablet, 56 px and « New connector » as an icon on a phone) is a change of every screen.
  - **The health says only what the worker says.** Since FRU-714 the worker says it with the list:
    `health` of each connector, `{ failing, notes?, lastDeliveredAt? }`. « Needs attention » when the
    tracker refuses the connector (FRU-102) or a place of a site (FRU-640); « N notes not delivered »
    and « N calls not delivered » for a connector that receives (an address, a routine, a plugin with
    `receives`, Slack), from `GET …/connectors/<id>/deliveries`, which is read **only for a connector
    whose `failing` is above 0**, of any kind (the ids of « Retry », and notes apart from calls); « Healthy » for
    one whose `failing` is 0, and for a tracker whose health the worker said: a tracker takes a note
    in the request or refuses it there, so nothing of it waits. « Last delivery » is `ago` of
    `lastDeliveredAt`, « None yet » without it. A worker that says no `health` (one of before, or
    deliveries that did not answer) gets the screen of before: every list of an address read, «
    Connected » for a tracker, no count of notes and an empty « Last delivery ». « Not read » when the
    list of an address was not read, with a line above the table and « Try again »; « N sends not
    delivered » instead when the worker said that N wait, as the bar counts them, with no « Retry ». **Never «
    Healthy » for what was not read.** A red word is `accent-strong`, on a tint of the accent; a green
    one is `done`, on a tint of `done`.
  - **A routine whose `/fire` answered `404` is « Needs attention »** (`routine-gone`, FRU-627): its
    panel says that claude.ai says the routine or its API trigger is gone, since when, and to connect
    a new trigger and disconnect this one; the box « Start an agent » of a site that calls it says the same in place of « Fruitback
    tries again », which a call given up makes false. The panels of a tracker read only the refusals of
    a tracker (`trackerTrouble` of `api.ts`).
  - **« Retry »** is on a row whose sends wait, for an owner or an admin: it asks each of them again
    (`POST …/deliveries/<id>/retry`, the route of « Try now » in the settings), then reads the health
    again. **The red count of « Connectors » in the bar** is the sum of the sends that wait, as this
    screen last read them (`failingRead` of the frame): `failing` of each connector, or the list
    read for one whose health the worker did not say; on another screen it stays until a read says
    another number; before it, the bar shows the count of its own read (FRU-711).
  - **« Add a connector » is a catalogue on the page, under the table**, with or without a
    connector: a search (`folded`: no case, no accent) and the groups All kinds, Trackers, Agents
    and Developers. Its tiles are 64 px, never narrower than 260 px (FRU-727: a button no longer
    squeezes their words), four in a row at 1440 px, two at 834 px, one at 390 px. The head goes on a
    second line where it has no room, and its search grows up to 220 px; under 560 px the search
    takes the whole width, 44 px high in 16 px (iOS zooms on a smaller font), and the groups stay on
    one line that scrolls sideways. A tile: the logo in a box
    of 36 px, the name, one line of what a note becomes there (cut at its end; the long sentence is
    its tooltip), and its state: « Add » for a kind already connected, « Connect », « Soon » (no connector of this
    kind on this worker), or « Not set up » (the worker has the kind, and its operator did not set
    it up: the line then says so). The routine says « New » beside its name. **A kind is connected
    more than once** (FRU-727): two workspaces of Linear, two addresses. The worker already gives one
    entry of `GET …/connectors` for each connection, with its account (its `label`), so the table has
    a row for each, and the account tells them apart. The tile of a connected kind counts them in a
    green disc of 16 px on the top right corner of its logo (`aria-hidden`), and offers « Add » in
    place of « Connected » and « + »: it does what « Connect » does (the consent of Linear again, the
    form of an address), and a screen reader hears « Add another Linear (2 connected) ». A person
    who cannot add one (a member, a worker that cannot keep a key) reads « Connected », and hears the
    count in words. Where a tracker
    connects two ways (the consent, a key or a token), « Connect » is the consent and a menu beside
    it offers the other. **The form of a source opens in its tile, which then takes the whole row**,
    and so does the sentence of a way back that went wrong (`LINEAR_RETURNS`, `GITHUB_RETURNS`,
    `PLUGIN_RETURNS`). A source added opens its settings; an address whose secret Fruitback made
    shows it in its tile once, and its settings open after « I kept it ».
  - **The catalogue waits for the list to be read** (FRU-271): only that read says what « Connect
    Linear » does, the consent at Linear or a key. After a read that failed there is « Try again »
    and no tile. A person who cannot add a connector (a member, a worker that cannot keep a key)
    reads the catalogue with no button, and a line above it says why; « New connector », which
    leads to the search of the catalogue, is not there for them, and `?new` (« Connect a tracker » of
    the Sites screen) puts focus in the search only for a person who can add one.
  - **The logos are SVG files the console serves itself** (`public/logos/<kind>.svg`, `img-src
    'self'`, no request to a third party): simple-icons 15.0.0 (CC0-1.0) for the trackers, in the
    colour simple-icons gives each brand, the icons `webhook` and `terminal` of Lucide (ISC), and
    the braces of an address drawn for Fruitback. Each file names its source and its licence in a
    comment; `connector-logos.test.ts` holds one file for each kind, nothing in them that reaches
    another address, and the comment. A logo is decorative: the name beside it says the kind.
    Elsewhere (Notes, the places of a site) a source keeps its mark of `connector-marks.tsx`, in the
    colour of the text.
  - **The settings keep what they held**: « Sites sending here », the sites that send there and their
    places, read only, with a link to the Sites screen (FRU-399) and « Statuses » on the row of each
    site of a Linear (FRU-478); the notes that did not arrive; « Use an API key ». « Connect » is
    written many times, so each button also holds the name of its source for a screen reader.
    `e2e/console-connectors-table.spec.ts` and `console-connectors-catalogue.spec.ts` hold the values, the states, the roles, 390 px and axe; `console-connectors-narrow.spec.ts` the tablet, the cards of a phone and the presses of a finger (FRU-727).
    **A source can have a name** (FRU-404): several sources can reach one tracker, so an owner or an
    admin names one at the top of its panel (`connector-name.tsx`, « Rename » in place, as for a
    workspace), and an empty name gives it back the name of its kind. `connectorName` of
    `connector-parts.tsx` is how every screen names a source: its row, where the kind then goes first
    on the line under it, the chips and the places of Notes, and the lists of a site's statuses
    (`placeLabel`: « Clients · Design » for « Linear · Design »). A worker of before sends no `name`,
    and every source is named by its kind, as before.
- **A place that the tracker refuses says « Needs attention »** (FRU-640): the worker keeps
  `attention` on the destination when a note did not reach its place, and clears it when a note
  arrives. The row of the place in « Where the notes go » says « Needs attention » and, under it,
  since when and what to do: add the right place, make it the default, remove this one. The card of
  the site in the Sites list says it too, to whoever sees the tracker. A worker of before sends no
  `attention`, and the row reads as it did.
- **GitHub connects with its App, where the worker has one** (FRU-361, routes of FRU-359 and
  FRU-360): `connectors.tsx` (the tile), `connector-github.tsx` (the settings). The tile « GitHub
  Issues » is always in « Add a connector », after Jira (FRU-690). With `githubApp: true`,
  « Connect » asks `POST …/connectors/github/start` and goes to the `url` it answers, as « Connect
  Linear » does with OAuth. Without it, « Not set up » and a line that names the
  operator: there is no other way to connect GitHub. **Each word of the way back has its
  sentence under the tile** (`GITHUB_RETURNS`), and leaves the address after it is read;
  `connected` opens the panel of the last GitHub connector, not of the last row, because an
  installation again keeps its connector. **An installation from github.com comes back with no
  `state`**: the worker sends it to `/?github=unstarted`, and the front door forwards the word to
  the Connectors screen of the first workspace that the person manages. A person who manages none
  reads on the front door that nothing was connected, and « Continue » takes the front door as
  usual. **A row names the account**
  (« Installed on acme », from `GitHub App · acme`), and its state is the one of FRU-102. **A panel
  that needs repair links to `https://github.com/apps/fruitback-app`**: the console does not know
  the id of the installation, which the worker keeps sealed. **A site chooses a repository** on the
  Sites screen (FRU-399), from `GET …/connectors/<id>/repositories`, private ones first, then the
  public ones under « GitHub, public repositories of {account}: their issues are public »; the
  place is sent as `{ connector, repository }` and read back from `teamId`. **A place in a public
  repository says, under it, that each note becomes an
  issue that anybody can read, from the worker's word on the destination** (FRU-382): `private`
  comes with each destination of `GET …/sites`, so the warning shows on the card of the site and in
  the panel of the source as they open, while the list is read, when it failed, and to a member, who
  reads no list. Once the list names the
  repository, it wins either way: it is GitHub's word now, and the worker's can be older. A destination with no word (a worker of before, a
  GitHub that did not answer) warns only from the list. **`setPlaces` takes the sources of the
  workspace**: the whole list of a site is sent, and a GitHub place sent as a team makes the worker
  refuse that list. `e2e/console-github.spec.ts` holds the card, every word, the panel, 390 px and
  axe; `e2e/console-site-places.spec.ts` the places and the bodies sent.
  **The team of a Linear place links to its page at Linear** (FRU-574): `url` comes with each Linear
  destination of `GET …/sites`. The worker builds it, `https://linear.app/<urlKey>/team/<KEY>/all`, from
  the keys that Linear answers in the same read that names the place (`linearTeamUrl`, plain keys
  only), and never takes it from a request. The worker reads back only an address of
  `https://linear.app/`, and the console links only to one. A destination written before migration
  0041 has no `url` until its places are written again. Its card then shows the team as words.
  A write of the places keeps the `url` that Linear's answer gives now, and never the stored one,
  as for the label: a team key can be renamed at Linear. With no key in the answer, there is no link
  until the next write.
- **A site chooses where its notes go on its page** (FRU-399, Mathieu; FRU-433), and no longer in the
  panel of a source: a section of the page of the site, for an owner or an admin
  (`site-places.tsx`). It lists the places of the site in their order, with « Make it the default »
  and « Remove », and « Add a destination… » offers what every source of the workspace has: the
  teams and projects of each Linear, the repositories of each GitHub, each address. The sources are
  read once with the page, their teams and repositories once both the site and the sources are read; a read that failed
  says which source and offers « Try again ». **No list is written before the sources are read**: a
  list is sent with the kind of each source, and with none a GitHub place would go as a team, which
  the worker refuses. The panel of a GitHub on the Connectors screen reads its repositories too, for
  who manages the sources, so the list wins there as here (FRU-382). The answer of a write is the
  list the worker keeps:
  the page takes it at once, and the sites are not read again. No route of the worker is new.
  **« Add a destination… » has a search, and pages** (FRU-438, Mathieu; `SearchChoice` in `ui.tsx`):
  a search field above the list, as the one of the grid of the Sites screen, keeps the places whose
  name holds what is typed, with no case and no accent (« equipe » finds « Équipe Web »), and drops
  the sources with nothing left; a cross in the field empties it and gives it focus back; a search
  that keeps nothing says so in the list, which offers nothing. The list shows 50 places, then a
  last option « Show 50 more (70 left) », which chooses nothing. The search and the pages are the
  console's, on the lists the worker answered whole: no route of the worker is new. The teams of a
  Linear have since come a page at a time (FRU-501, below). **It is not a
  combo box**, which typed in the list itself: measured on 2026-10-25, the combo box of HeroUI
  (react-aria 3.53) throws « childNodes is not supported » under React 19.3 in development when its
  options change while it is open, and its list then stops following what is typed. A `Select`
  changes its options only while it is closed. `e2e/console-site-places.spec.ts` holds the search,
  the cross, the pages and the place sent.
  **A team of Linear, then one of its projects, in two lists** (FRU-458, Mathieu). The first list
  offers each team, never a project: « Web (WEB) · 4 projects · private ». A team adds nothing; it
  opens a second list under « Team Web », with its own search and pages: the whole team first, then
  its projects under the kind of their status in Linear (Started, Planned, Backlog, Paused, Completed,
  Canceled, then those with no status), each with the name its workspace gave the status
  (« Site · In Progress »). « Choose another team » goes back. A team is offered while one of its
  places is free. The worker reads every page of the teams (50 at a time) and of the projects of each
  team (`listLinearTeams`, at most 20 pages of each list): before, a project after the 50th of its
  team was neither offered nor accepted in a list. A page of 50 teams and not 100: Linear prices a
  query by the nodes it may return, and the status of each project doubles them. The answer of
  `GET …/connectors/<id>/teams` gains `private` and `status`, both optional: a console of before
  ignores them.
  **The teams of a Linear come a page at a time, and a search asks Linear** (FRU-501). `GET
  …/connectors/<id>/teams` answers one page of 50 teams, each with all its projects, and `next`
  while Linear has more; `?after=<next>` reads the next page, and `?q=<words>` (100 characters at
  most) only the teams whose name holds them, as Linear compares them with no case
  (`containsIgnoreCase`). The list of each Linear is one state, `team-list.ts`: its teams, the
  cursor of the next page (`null` once Linear says there is no other), the search, and the one
  request it waits for. Each answer carries the id of its request, and any other answer is dropped:
  a slow page that a search replaced, or a page of a list that « Try again » read again. A search
  filters what the console holds, and, 300 ms after the last key, asks the worker for its words
  once, only while the list is not complete. « More teams of <source>… », after every other option,
  never paged and never searched (`tail` of `SearchChoice`), shows while there is a next page, no
  search and no page on its way. `team-list.test.ts` crosses the shapes of a list, the moments of a
  search, « Try again » after an error, and a slow answer. The popup of the extension still reads
  every team (`GET /session/sites/places`, `listLinearTeams`). **A place is labelled from its own
  team and project**, read by their ids in one call for each connector (`readLinearPlaces`), never
  from the list of the teams; a new connector reads only who the key belongs to
  (`readLinearViewer`). These reads, and the states, give up after 10 s (`READ_TIMEOUT_MS`), as the
  calls of `linear-oauth.ts`: a Linear that hangs is then a Linear that is down. The write of a note
  has no such limit, as a write Linear finishes after the worker gave up would be written twice when
  the widget tries again. Measured with a fake Linear of 300 teams of 60 projects, 40 ms a call: see
  the description of the pull request of FRU-501.
  **Each place shows the mark of its source, and a place of Linear its colour** (FRU-459, Mathieu):
  the `ConnectorMark` of FRU-435 before its name, then a dot in the colour Linear gives its project,
  else its team (`color` of the teams answer, `#rrggbb` only: anything else would reach a style, and
  the worker drops it). The colour is known once the teams of its source are read; GitHub and an
  address have none. Both are `aria-hidden`: the name says the source. **Linear's `icon` is not
  shown**: Linear documents it as « an emoji or a decorative icon type », and the icon types are
  names of Linear's own glyphs (`Rocket`…), with no public set to draw them from; an emoji is the
  system's font, which `icons.md` turned away.
- **My account is the page « Profile » of the shell of the settings** (FRU-692, the mockup « Mon
  compte (Profil) » of the ticket): four cards, in two columns from 1280 px and one column under it,
  the profile and where the person is signed in, then the addresses and how the person signs in.
  Each card is a region named by its title, with an icon; each row of a card has an icon in a box of
  24 px. **The rare actions are in the menu of a row or in a dialog, never underlined words**:
  « Make primary » and « Remove » of an address (« Remove » asks the second time under its row),
  « Disconnect » of a browser, « Add » an address (a dialog, which keeps what was typed when it
  closes), « Sign out everywhere » (a dialog, on « Sessions »). « Unlink » is a button whose second
  time is under its row; a second time that the worker refused stays, so the person tries again in
  one press. « Sign out » is the action of the head of the profile. The card of the browsers shows the
  last three, a short line under each (« Used 2 h ago »), and « See all » to « Sessions », which lists
  every browser with when it signed in. The worker keeps no photo of a person: the profile shows the
  initial of the name.
- **My account shows the sessions of the console, and ends them, with the routes of FRU-181**
  (FRU-248, `routes/account.tsx`). `GET /console/sessions` lists them by id, with no token: this
  browser first, then the others, each with « Disconnect » (`DELETE /console/sessions/<id>`, one
  press: a session ended by mistake is a sign-in away). « Sign out everywhere » is
  `/console/auth/revoke-sessions`, asks twice, and ends this browser too. **A way out that the
  worker did not confirm says so and stays** (FRU-204), for the three of them. **A list that was
  not read is no list.** **The list keeps the room of one row while it is read, and when it could
  not be**: it arrived above « Sign out » until FRU-692, and a press that starts before a button
  moves and ends after is lost, with no request and no message (measured: 53 px, `main` red on
  30c62f8). « Sign out » is in the head now, and the card under the list still moves by one row less.
  A second browser still adds its row. **A browser is named as the worker names it** (FRU-249, Q7): « Console
  · Chrome on macOS », a short label of its user agent; one it could not name reads « Console · this
  browser » or « Console · another browser ». **The name on the notes is changed here**
  (`POST /console/me/name`), kept when the field is left or by Enter, as the mockup draws no button; a
  refusal says why and keeps what was typed. **A provider is linked by a form** that `POST`s to the
  worker (`/console/auth/link/<provider>`, FRU-415: the worker starts no link on a `GET`), which comes
  back with `?confirm=`, `?linked=` or `?error=`, said once and taken from the address. **`?confirm=`
  asks before anything is linked** (FRU-415): « Link the Google account x@y to your Fruitback
  account? », with the address the worker read at the provider (`GET /console/me/sign-in/pending`),
  « Link this account » and « Cancel ». It is asked on the way back and not before the provider:
  only the provider knows which of its accounts the person chooses. A link that is no longer there
  (expired, or answered in another tab) says so, and a refusal at the confirmation is said as one on
  the way back. **A refused link names the provider and the address of the account, then
  says what to do** (FRU-416): the worker adds `?provider=`, read in the closed list `LINKABLE`, and
  the address is the one of `/console/me`, never one of the address bar; a provider that is not in
  the list, or none, gives « The account was not linked. », and « Try again » is said for a failure on
  the way only, never for a refusal. The sentence stays until « Unlink ». better-auth 1.7.7 writes
  `email_does_not_match`, which the console read as an unknown code until FRU-416, and
  `unable_to_link_account` for an address that the provider did not verify and for a write that
  failed: its sentence names both. « Unlink » asks twice, and the last way to sign in stays and says why
  (`409 last-sign-in`, `403 sign-in-again`). The three rows of « How you sign in » are drawn before
  the worker answers, so nothing under them moves. The worker keeps no login of a provider: « Linked »,
  not « Linked as ». **The browsers of the extension are rows of the same list** (`GET
  /console/me/browsers`, FRU-238): « Extension · Chrome on macOS », « Connected 12 Oct · used 2 h ago »,
  among the browsers of the console, the one used last first, this browser before all (FRU-692: the
  mockup mixes them). The two lists are read together and drawn once, so nothing under
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
  `GET /console/admin/workspaces` and writes nothing. « Version », first, says the version of the
  worker and a newer release (FRU-520, `docs/decisions/worker.md`). **The banner of a release**
  (`release-banner.tsx`) is at the top of the frame of a workspace and of the administration, for the
  administrator of the instance only, and not on « Instance », which says it itself. « Dismiss » keeps
  the version in `localStorage` (`release-notice.ts`): the next release shows again. **Each setting comes from the environment**,
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
  `routes/admin-users.tsx` share `parts/admin-list.tsx`. Opening a screen is an explicit read, so it
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
  before. **A tab that waits holds a Web Lock** (`fruitback:sign-in-waiting`, shared, FRU-732), and
  the tab of the link reads it before it speaks: when a tab holds it, « heard » gets 5 s, the time of
  a call, and a link opened alone still costs 400 ms. Measured on a busy Mac of GitHub (3 CPUs, a load
  of 10 to 20): the browser delivered « signed-in » to the tab that waited 0.43 s, 1.6 s and 2.8 s
  after it was said, and with 400 ms the tab of the link had become the console. The browser frees
  the lock of a tab that closes; a browser with no `navigator.locks` keeps the 400 ms. The cost,
  accepted: a tab that the browser froze still holds the lock and cannot answer, so a link opened
  then waits 5 s before it is the console. **A message is
  a hint, never a proof**: it carries no token and no account, and a tab goes
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

## « Offer visitors an e-mail when their note is done » (FRU-604)

### The rules, in short

- **A switch of the site, off by default** (Mathieu, 2026-11-06), in the form « Who sees the
  notes » of the page of a site, under « Who can leave a note? ». It is shown, and sent as
  `notifyDone`, only when anybody may leave a note there (everyone reads it, or « Anyone on the
  page »). Hidden, it is not sent: the worker keeps the value, and it does nothing there.
- **The summary of the site says it** (« E-mail when a note is done »: « Offered to visitors » or
  « Off ») on the same condition, and says nothing of it on a site of members only.
- The worker answers `notifyDone` in each site it lists, and takes it on `POST …/sites` (a boolean,
  else `400 invalid-notify-done`). Absent, a new site is off and a site that exists keeps its value.
- `e2e/console-site-page.spec.ts` holds the three cases: hidden for members only, shown and sent on,
  and the summary.

## The menu of a task (FRU-654)

### The rules, in short

- **A row of the table and a card of the board end with « Actions of this note »**, a button that
  opens `MenuTree` of the kit (`ui.tsx`): the dropdown of HeroUI, with submenus. A right click on the
  row or the card opens it too (`contextmenu`, which a long press of Android sends), and so do the
  key of the menu and Shift+F10. A right click on a link keeps the menu of the browser.
- **A note the worker keeps, that this person may change (`canSetStatus`), offers its status, its
  assignee, its priority, its day and its labels**, each a submenu with its value checked. A change
  is saved at once with `POST …/notes/<note>/task` or `…/status`, then the list is read again; a
  refusal is said under the note. Every note offers « Copy the link to the note ».
- **The assignee is a member of the workspace**, read with `list-members`; a guest is not offered.
  **The members are read a page of 100 at a time, to the last one** (FRU-673,
  `assignable-people.ts`): 100 is `MEMBERS_PAGE` of the worker, which refuses a larger page with a
  `400`. The menu asked for 200 in one page, and listed nobody. **A read that failed is said**, in
  the menu and under the field of the page of a task, with « Try again »: never a menu with nobody
  in it. `assignable-people.test.ts` reads `MEMBERS_PAGE` in the worker, so a smaller page there
  fails it; the stub of `list-members` in `e2e/console-task-menu.spec.ts` keeps the rule of the
  worker.
  **The day is today, tomorrow or in a week**, in the calendar of the browser; a day of a calendar
  comes with the page of a task (FRU-653).
- **« New label… » is for an owner or an admin** (`manage-sites`, as the worker says). It opens a
  dialog, a name and one of eight colours (`label-colors.ts`: data the worker keeps, not tokens),
  and the label goes on the task it was asked from. The menu closes before the dialog opens.
- **The labels of the workspace are read as the members are** (FRU-675): `labelsRead` and
  `readLabels` in the seam. **A read that failed is said**, in the menu and under the fields of the
  page of a task, with « Try again »: never « No label yet », which said to a member that the
  workspace had none. « New label… » waits for the read too: a new label could take the name of one
  that is not shown. `listed.test.ts` finds a list that starts as `[]` and that a refused answer
  leaves so (`if (!answer.ok) return;` before its setter, or `if (answer.ok) setX(…)`).
- **Not here yet**: the order of a task in its column, and to archive or delete a task. The worker
  has no route for them.

## The place, the archive and the deletion of a task (FRU-665)

### The rules, in short

- **A drag inside a column of the board puts a task between two others**: a line of the ink says
  where, over the upper half of a card before it, over the lower half after it. The board draws each
  column by `rankOf` (`notes-model.ts`). **« Move up » and « Move down » of the menu do the same
  from the keyboard**, on the board only, and not past the end of the column.
- **« Archive » and « Bring back » are items of the menu.** « Archived » is the last choice of the
  filter of the status: a choice, not one more box, so the row of the filters stays the mockup's.
- **« Delete… » asks again under the note** (`Confirmation` of `confirm.tsx`): « Keep it » has the
  focus, and only « Delete this note » deletes.

## The notes not resolved yet (FRU-667)

### The rules, in short

- **« Unresolved » is a choice of the filter of the status**, the second, after « Any status »: every
  note but the ones done or closed. A choice, not one more box, as « Archived » (FRU-665), so the row
  of the filters stays the mockup's, and a stage and « Unresolved » are never asked together.
- **Resolved means `RESOLVED_STAGES` of `@fruitback/shared`**: done, and closed. The widget hides the
  same two with « Hide resolved notes », so a note gone from the pins is gone from this list too.
- **It is in the address**, `unresolved=1`, and the worker filters it in the index: the pages, the
  counts and the heads of the groups are those of the list. The worker refuses `unresolved` with
  `stage` (`invalid-unresolved`).
- **The board keeps its columns.** As under a filter on one stage, Done and Closed stay, empty, and
  a card dropped in one leaves the list at the next read.
- `task-filters.test.ts` reads the list on a real PostgreSQL, in both directions: a note done or
  closed leaves it, and a note set back to do comes back. `console-task-filters.spec.ts` holds the
  address and the read the console asks.

## The filters on the fields of a task (FRU-655)

### The rules, in short

- **A row of four filters under the others**: assignee, priority, label, due day. It is drawn once
  the list holds a task Fruitback keeps, or once one of them is set: the first row stays the
  mockup's, and a workspace whose notes all go to a tracker sees no filter that finds nothing.
- **Each filter is in the address** (`assignee`, `priority`, `label`, `due`), as the others. The day
  filters send `today`, the day of the browser.

## The page of a task (FRU-653)

### The rules, in short

- **A panel beside the list, 440 px at the right edge** (FRU-687, the mockup « Détail d'une note » of
  2026-11-25, in place of the drawer of 560 px over the list of FRU-653). Not modal (`role=dialog`,
  `aria-modal=false`): the list stays in view and drops the columns it has no room for (its
  container query), the row of the note is marked as a selected one, and a press on another note
  opens it in the same panel. From 1024 px the screen keeps the room of the panel; under it the panel
  takes the whole width. The text of a note opens it, and its address is `?task=<id>`: a link opens
  it. Escape (from a field of the panel too) and its close button close it, and the focus goes back
  to the row of the note; the arrows up and down, and the chevrons of its head, open the note above
  and under it in the list.
- **Its order**: a head of 44 px (the mark of the place and the reference, the issue in a new tab,
  the chevrons, a menu with the three copies of FRU-658, Close); the title at 18 px and the rest of
  the text; the fields as lines of 32 px (Status, Sent to, Assignee, Priority, Due day, Left by,
  Page), the labels under them; the page in a picture (the capture with the element framed when the
  note has one that loads, else a frame that says there is none, with the address, never the
  selector), and « Open on the page »; the replies, under their initials, with « Synced with
  <place> » for a tracker; and **« Technical details » folded at the end**: the element, the
  component, the file, the screen and the browser (`browser-name.ts`), its summary the screen and the
  browser. So no selector is a press away from the list.
- **It reads the note whole** (`GET …/notes/<note>`). A task Fruitback keeps, that this person may
  change, shows its fields as controls that save at once, as the menu does, the day as a field of
  the calendar of the browser. Any other note shows them disabled, or not at all.
- **Not here yet**: to write a reply (FRU-712: the field of the mockup needs a route of the worker,
  which a screen PR does not add), to edit the text, the files of a note.

## Several tasks at once (FRU-656)

### The rules, in short

- **The screen follows its board**, `design/task-bulk/` (FRU-656): a box on each task Fruitback
  keeps, in the table and on the board, none on a note of a tracker. Out of a selection a box shows
  under the pointer, under the keyboard, and always on a touch screen. The box of the head of the
  table selects the page. `task-selection.tsx` holds the selection, and `TaskSelectionContext` gives
  it to what acts on it: the bar, the menu of a task, and a copy (FRU-658).
- **The keys.** Shift and a click on a box, or on a row or a card out of its links and buttons,
  selects every task between it and the box pressed before, in the order of the screen. Cmd or Ctrl
  and A selects every task of the page, unless the focus is in a field, a menu or a dialog, which
  keep the key. Escape clears the selection, unless something of the screen took it first.
- **The whole view is the page shown**, 25 notes at most under the filters: a selection of every
  page would change notes the screen never read. A task that leaves the screen leaves the selection.
- **The bar is under the list, and stays at the foot of the screen** while the list is there
  (`sticky`). It says how many tasks are selected, offers the rest of the page, and holds the five
  submenus of the menu of a task as buttons (`BranchMenu` of the kit), « Archive » and « Delete… »,
  which asks again. A value is checked when every selected task has it; a label checked is taken off
  every task, another one put on every task, and their other labels stay.
- **One change is one call**, `POST …/tasks` or `POST …/tasks/delete`: the worker changes every task
  or none, and a refusal is said in the bar. A task this person may not change stays selected, the
  bar says how many, and the change leaves it out.
- **The menu of a task on a selection of several acts on all of it**: the same code (`branchesOf`),
  its button named « Actions of the N selected notes », without the items of one note (its place,
  its link). A task out of the selection keeps its own menu.
- **Said to a screen reader**: a line of status, always in the page, says the count of the selection
  and the end of a change (« 3 notes changed. »). A selection emptied with the focus in the bar gives
  the focus to the list. `e2e/console-task-bulk.spec.ts` holds it, at 1440 px and at 390 px in French.

## A task written by hand (FRU-657)

### The rules, in short

- **« New task » is at the head of the list, beside the view, and at the head of each column of the
  board**, as a « + » named « New task in <column> ». The key « C » opens it too, as in Linear: alone,
  out of a field, and when no dialog, menu or list is open. The button writes the key beside its
  words, so the key is found.
- **A dialog of the kit** (`Dialog`, `md`): the title first and required, a text of several lines
  (`TextBox`, the text area of HeroUI), the site when the workspace has more than one, then the
  status, the assignee, the priority and the day, and the labels. The site is the one of the filter,
  or the only one; a column gives its status. No board in `design/`: the dialog is made of controls of
  the kit, in the order of the panel of a task.
- **What is typed stays until the task is written.** A refusal is said in the dialog over the
  buttons, and Escape or « Cancel » keep the draft for the next « New task ». Once written, the list
  is read again and the task opens in its panel (`?task=<id>`).
- **A task has no page**: its row and its card draw no link to a page, its menu no « Copy the link to
  the note », and its panel says « Written by hand: no page and no pin. » in place of the page and the
  element.

## Copy a task (FRU-658)

### The rules, in short

- **Three copies, for a note of a page and a task written by hand alike**: the link of the note in the
  console (`/w/<workspace>/notes?task=<id>`, which opens its panel), its ID (`FB-12`, or the
  reference of its tracker), and the note as Markdown for an agent, in the format of `notes_as_text`
  (`feedbackText`, `tasksText`). The Markdown reads the note whole (`GET …/notes/<note>`): the list
  keeps 64 characters of it.
- **From the menu of a task** (« Copy the link », « Copy the ID », « Copy as Markdown »; « Copy the
  link to its page » for a note of a page), **from its panel** (three buttons under its reference),
  and **from the keyboard**: Cmd or Ctrl, Shift and C for the link, Cmd or Ctrl, Shift and the full
  stop for the ID, on the row or the card that holds the focus, else on the task of the panel. The
  keys are read by their place (`code`), and never in a field.
- **No ID for a guest**: the list gives a guest no reference, so the menu offers none, and the panel
  offers one only when its read names a reference.
- **A status line says what was copied**, for a person and a screen reader (`role="status"`), and
  says it when the browser refused the clipboard. The Markdown is written as a `ClipboardItem` of the
  read still on its way, so that Safari, which wants the write in the gesture, takes it.
- **From a selection** (FRU-656): the menu « Copy » of its bar, and the copy items of the menu of a
  selected task, copy every selected note in the order of the screen, those this person may not
  change too: the links and the IDs one per line, the Markdown grouped by page, then the tasks
  written by hand.

## The shortcuts of the keyboard, and the fields (FRU-726)

### The rules, in short

- **One guard for every shortcut of the console, `keys.ts`**: « C » (New task), « / » (the search of
  the notes, the sites and the members), j and k (the rows), Cmd or Ctrl and A, and Escape (the
  selection), the copies (Cmd or Ctrl, Shift and C or the full stop), and the arrows and Escape of
  the panel of a task. A new shortcut goes through it.
- **A shortcut reads `composedPath()`, never `event.target` alone.** The target of a key typed in a
  Shadow root is its host element, which is no field. The Fruitback widget on the console is one: each
  « c » of a note opened « New task » and was missing from the note, and the button read
  « New taskC ».
- **A field keeps its keys**: a text input, a `textarea`, a `select`, an element you can edit, and a
  `textbox` or `searchbox`, wherever they are in the path. A box, a radio, a button, and a button that
  says `combobox` are no field: Cmd or Ctrl and A on the box of a row still selects every task. A
  dialog (the panel of a task included, as since FRU-656), a menu and a list of options keep their
  keys too, in a Shadow root as well.
- **A shortcut of one key (« C », « / », j, k) takes no Cmd, Ctrl or Alt**, no key that a handler took
  already, and no key while an IME composes a word (`isComposing`, or the key 229 of Safari).
- `keys.test.ts` tests the guard on the path of a key typed in a Shadow root.
  `e2e/console-shortcut-fields.spec.ts` types « c » and « / » in a field of a Shadow root and in the
  widget mounted on the console, and presses them out of a field as its control.

### The reasons, and the history

- The widget keeps the keys of its fields from the page since FRU-726 (`docs/decisions/widget.md`),
  for every site. The console has its own guard all the same: another component with a Shadow root,
  or a widget older than the fix, takes the same path.

## The tab « Access » of a site (FRU-703)

### The rules, in short

- **« Access » is a tab of the page of a site** (`parts/site-tabs.tsx`; FRU-689 gave the page its
  other tabs, above). Its form « Change » of who sees the notes went to the tab, and « Change » on
  the rows of « Overview » leads there for an owner or an admin. The route is
  `…/sites/<site>/access`; the frame of the page reads the site, and « Save » hands it what the worker
  kept.
- **The tab follows the mockup « Onglet Access »** of FRU-699: « Public access » (four levels),
  « What a visitor can do » (a table of seven actions in two columns), « How a visitor is
  recognised », and « What a visitor sees » on the right from 1100 px, with « Safeguards » under it
  (FRU-704). **Drawn and not chosen**: the level « Collaborate » (FRU-707), and the
  e-mail and the signed token among the ways to recognise a visitor (FRU-705, FRU-706).
- **A list is a setting of the worker, and only that.** `access-policy.ts` holds the four values the
  worker stores: who reads (`visibility`, the list « See notes » of others), who writes (`writers`,
  « Leave a note »), and what a visitor does to a note of their own (`visitorEdit`, `visitorDelete`,
  Never / While open). The mockup's « Allowed » is not offered: a visitor acts on their own notes
  that are still open, and on nothing else (the decision for FRU-699). Every other cell is written in words, from what the worker does:
  « Reply » is allowed where everyone reads and anybody writes, as `replyAuthorFor` decides;
  « See the tracker and assignee » follows « See notes », as the read of a visitor carries the issue
  (the mockup draws « Hidden »: that needs the worker first).
- **A level fills the table, and a table that is no level says « Custom »** and checks no card.
  Where only members write, the rights of a visitor are not read: no list, « Never », and the level
  is « Closed » or « Read only ».
- **« Save » sends the whole access in one `POST …/sites`** of the address of the site, as the form
  of the page did (FRU-504): who reads, who writes and the rights of a visitor always (« Never »
  where only members write, as the table shows), and the e-mail only where anybody writes. Nothing changed: nothing is asked. A refusal says its cause and keeps what was chosen.
- **« Safeguards » grows one line by safeguard, each with its pull request (FRU-704).** « Notes per
  visitor » first: a list of « No limit », 5, 10, 20 and 50 « / hour », the values `POST …/sites`
  takes (`visitorNotesPerHour`). Sent where anybody writes, as the e-mail; « n/a » and kept where only
  members write. A level does not change it. A worker that answers without it did not keep it: « Save »
  says the access did not change. A worker of before sends nothing, read as « No limit », what it did.
- **« Hold new visitor notes » is the second line of « Safeguards » (FRU-704)**, a switch, sent where
  anybody writes, « n/a » elsewhere. Its notes wait in the screen « To approve » (`/w/<id>/approve`),
  an entry of « Views » in the bar for a role that sees the tracker, shown while notes wait or while
  it is on screen: the bar reads `…/held/count` once by workspace, and the screen tells it each new
  count. A note shows its site, its page, its author and its age; « Approve » and « Reject » answer
  it, and a refusal says why, with the note still there.
- **The e-mail of a note done (FRU-604) is the card « After a note »**, which the mockup does not
  draw, shown where anybody writes.
- **A role that does not change a site reads the tab with every control disabled**, and no « Save ».
- `e2e/console-site-access.spec.ts` holds it; `access-policy.test.ts` holds the table.
