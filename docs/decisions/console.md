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
  `'unsafe-inline'`, and serves the widget's script at `/fruitback.iife.js` until it has a CDN.
- `design/` — the reference mockups of the Cloud and the simplified extension (a Claude Design
  export, 2026-10-07), with a picture of each board. **Build a screen that has a board to its board**:
  layout, words and tokens. `design/README.md` says which board belongs to which ticket.
- **The console connects an address, and shows the notes that did not arrive** (FRU-132). A source is
  drawn by its `kind`: a tracker has teams to choose, an address has none, so a site sends there or
  does not. **A secret that the worker made is on the screen once**, in the form that made the
  connector, and in no state after it. An address says « Connected », never « Working »: the list
  cannot know that its notes arrive. **No list of deliveries is not an empty list**: a worker that did
  not answer must not read as « every note arrived ». The same holds for the sites and the sources
  (FRU-162): `listed.ts` gives a read `loading`, `failed` or the list, only a list shows the empty
  state or a count, and a failed read says so with « Try again ».
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
  not on the setup that makes a workspace of their own. A worker of before has no member list: the
  screen draws the row of the person and says that invitations come later.
- **The address of a site is read by `site-address.ts`, on every screen that asks for one**
  (FRU-167). A host with no scheme is `https://`, as in the extension. The field is not `type="url"`:
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
  mockup draws no open menu), and
  for the setup `Steps` and `Step` (a drop with its number, the current step said to a screen reader),
  `Callout`, `OptionCard`, `AutoGrid` (side by side while there is room, with no width of a screen
  named), `Snippet` and `BrowserFrame` (the window of a browser, drawn). The tones `quiet` and `danger` of `Button` are of before the
  mockup: they stay as HeroUI draws them until their screens are drawn again.
- **`/kit` mounts each component once, on the development server only** (`kit-gallery.tsx`):
  `e2e/console-kit.spec.ts` reads there what the browser computes (colour, border, corner, height,
  type) against the mockup, each state under the pointer, under a press and with focus, 4.5:1 for
  every text on what is behind it, and axe. A build has no `/kit` (`kit-route.test.ts`).
- **The frame of a workspace is the rail of the mockup** (FRU-234, `routes/workspace.tsx`): the
  workspace, its sections as links with `aria-current="page"` on the one on screen, and the way to
  the documentation. **The rail shows a section only when its screen exists**: `SECTIONS` lists the
  five of the mockup in its order, each with `built` and the widest its screen is drawn, and
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
- **The Sites screen is the table of the mockup, with the columns the worker fills** (FRU-243,
  `routes/sites.tsx`): the site and who sees its notes, and where its notes go, to whoever sees the
  tracker. The count of notes, the way on the page and the last note wait for the summary of the
  sites (FRU-237), and the legend of the statuses comes with them: a column with nothing true to
  show is not drawn. **A row has one menu, and what it opens is under the row**: « Install », for
  every role; « Preview builds », which is the proof of a domain of FRU-103, and « Remove », for who
  manages the sites. One thing is open at a time, and what closes gives focus back to the button of
  the row. « Remove » asks twice: the menu is the first time, and `Confirmation` (`confirm.tsx`) the
  second. **No item changes who sees the notes of a site**: the worker has no route for it, and a
  button that does nothing is not drawn; so the form that adds a site asks it, in the card of a
  workspace with no site too, where the mockup draws the address alone. **The address of a site is
  no link** until a site has a page. **The table has no minimum width while it has three columns**:
  it fits a phone, so what opens under a row is on screen; the six columns of the mockup need
  860 px and a place for it outside the table. The card and the alert are sized by their content
  (`box-content`), as the mockup sizes them: 640 px and 760 px inside their padding.
  `e2e/console-sites.spec.ts` holds the three states, the form, the menu, the roles, 390 px and axe.
- **A box is compared to the mockup in the font of the mockup** (`e2e/console-workspace.ts`,
  `MOCKUP_FONT`): the mockup sizes its boxes by their text, and the Linux of CI has another font
  (52 px where the mockup has 49). `expectBox` compares on macOS; the computed styles are read
  everywhere, and they are what CI holds.
- **What the kit does not copy from the mockup.** The padding of a button is of its size, where the
  mockup writes 22, 24 or 26 px on the same pill. A switch changes colour in 200 ms everywhere,
  where the mockup does so in the popup only. A disabled switch dims its control and not its words.
  The frame of a table takes focus, so a keyboard scrolls a table wider than its screen.
- **Not measured**: what VoiceOver and NVDA say of the kit; the kit in Firefox and in Safari (the
  spec runs in Chromium).

## The session of the console (FRU-148)

### The rules, in short

- **The console holds no token.** A call is a `fetch` with the cookie of the worker and no
  `Authorization` (FRU-147, and no other way since FRU-150). The cookie is `HttpOnly`,
  `SameSite=Strict`, `Path=/console`: `document.cookie` does not show it, and nothing is in
  `localStorage` or `sessionStorage`. `e2e/console-cookie-session.spec.ts` reads all three, after it
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
