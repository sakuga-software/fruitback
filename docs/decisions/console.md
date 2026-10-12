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
  Tailwind on the tokens of `design/`, served as static files by nginx. **It holds no secret, and no
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
  one file that imports `@heroui/react`: `Button`, `Field`, `Choice` (a select), `Pick` (radios),
  `Chip` and `Problem`. A screen uses the kit, and `messages.test.ts` fails on a native control in a
  screen. **HeroUI takes the theme**: `app.css` gives its variables the tokens of `design/README.md`,
  and HeroUI names `--color-accent`, `--color-muted` and `--color-surface` from them, so those three
  are no longer in our `@theme`. **A state that HeroUI derives is measured, and given in `app.css` when
  it fails** (FRU-163): it lightens a hovered button, and white on that red was 3.9:1, so
  `--accent-hover` is the strong accent (6.47:1). It draws an alert as a white card with muted text, so
  `.alert--danger` puts the danger of the theme on the text and the border (5.84:1 on its tint).
  `e2e/console-kit.spec.ts` measures both. **A button takes no `title`**: a tooltip does not open on a disabled
  control, so the reason is written beside it. The overlays of React Aria position with inline
  styles, which the console's CSP allows (`style-src 'unsafe-inline'`); its scripts stay hashed.

## The session of the console (FRU-148)

### The rules, in short

- **The console holds no token.** Against a worker that serves better-auth (FRU-147), a call is a
  `fetch` with the cookie of the worker and no `Authorization`. The cookie is `HttpOnly`,
  `SameSite=Strict`, `Path=/console`: `document.cookie` does not show it, and nothing is in
  `localStorage` or `sessionStorage`. `e2e/console-cookie-session.spec.ts` reads all three, after it
  checked that the browser does hold the cookie.
- **No client of better-auth.** The console calls the routes of the worker with `fetch`
  (`/console/auth/email`, `/console/auth/email/redeem`, `/console/auth/sign-out`). The bundle and the
  policy of the image do not change: `csp.mjs`, hashed scripts, no `'unsafe-inline'` for a script.
- **The worker says which path it serves, in `GET /auth/providers`.** With `betterAuth` in the
  answer, the console takes the cookie, and the providers of `betterAuth`. With an answer that has
  none, it signs in as before: `session-of-before.ts` holds the access token and the one refresh in
  flight of FRU-99. The console and the worker are not deployed at the same instant.
  **FRU-150 removes `session-of-before.ts`**, and with it every token of the console.
- **A worker that refuses that question said nothing** (FRU-205). On a `429`, a `5xx` or no answer,
  no call leaves on either path: each one answers that refusal, a sign-out answers `false`, and the
  question is asked again at the next call, once for the calls of one moment. The console used to
  take the path of before then: against a worker that serves better-auth, it spent the refresh
  cookie of before and held an access token, for the session of whoever used the browser last. A
  link opened during a refusal is not spent, and its screen offers « Try again ».
- **A sign-in with a provider is a navigation of the whole page**, to
  `<worker>/console/auth/start/<provider>` (`providerStart`). Never a `fetch` of `/sign-in/social`:
  the cookie of the state would be set on the answer of a call, and WebKit did not send it back when
  the console and the worker are not one site (measured in FRU-147: `state_mismatch`).
- **The token of a link is read after the `#`, sent in the body of a `POST`, and taken out of the
  address bar** (`sign-in.tsx`), as before. It is in no address that the worker receives.
- **A code that a sign-in sends back has a sentence** (`PROVIDER_PROBLEMS` in `setup.tsx`), in French
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
  again. A change made in the moment the tab comes back waits for that question. A tab that comes
  back to a session that ended elsewhere stops the same way, with « Sign in ».
- **The screen of somebody whose own call was refused stays** (FRU-148, unchanged): they are there,
  typing, and « Continue » goes on, for the same account only.
- **What this does not hold**: a browser that tells the page nothing when a tab is shown again. The
  tab then learns the change at its next `/console/me`, and a change it sends before that leaves
  with the cookie of the other account. The worker could refuse it (the console would name the
  account it believes it is, and the worker would compare): not done.
- **« Sign out » ends the session on the worker** (`/console/auth/sign-out`): the cookie is refused
  at the next call, in every tab and for whoever copied it.
- **« Sign out » ends the session of before too** (`/console/session/logout`, FRU-204). A browser
  that signed in before the worker served better-auth still holds the refresh cookie of before, good
  for 30 days, and the worker takes it while it serves the path of before. Both calls are made,
  whatever the first one answers. A `404` on the second one is a worker with no path of before: it
  reads no refresh cookie, and that is an end. FRU-150 removes this call.
- **« Sign out » says when it failed.** `signOut` answers `false` unless the worker said that both
  sessions ended, and « My account » then stays, with « You are still signed in ». A screen that
  says « signed out » over a session that is still good leaves the browser open to the next person.
  better-auth 1.7.7 answers `200` to a sign-out with no session, with one that already ended, and
  with a cookie that is not one (measured, and held by a test of the worker): somebody who signs
  out in a second tab is not held on that sentence.

### The reasons, and the measurements

- **Why the path of before stays in the console, where the ticket says the token goes.** The ticket
  asks both that the token disappears and that this console works against a worker of before. The
  second one decides: a console that is deployed before its worker would sign nobody in. So the
  token of before is in one file that nothing calls once the worker says `betterAuth`, and
  `api.test.ts` holds that no call has an `Authorization` then.
- **An answer of `/auth/providers` with no body is a worker of before.** A stub of a spec answers
  `204` there. Read as better-auth, or read without a check, it broke every console spec (measured).
- **The spec starts its worker as a process** (`apps/worker/src/cloud-worker.fixture.ts`): Playwright
  compiles a spec as CommonJS and cannot import the worker, which is ES modules. The spec hands the
  process each request that the console sends to the address of the worker, and reads the mail from
  it: the link is read where the worker was asked to send it.
- **Measured in three engines, on `*.fruitback.localhost` over HTTPS** (2026-10-12, Playwright
  1.58.2): the pull request of FRU-148 has the table. Not measured: Safari itself.
