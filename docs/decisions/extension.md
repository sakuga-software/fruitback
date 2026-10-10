# The extension, and the two worlds

**This describes the private mode**, where the client's site embeds nothing and the extension
injects the widget. FRU-46 since named three modes — public, private and team — and the team mode
turns the extension into a relay rather than an injector. Nothing below was rewritten for that; it
is the private mode as FRU-41 built it. What each mode does and does not protect is
[../modes.md](../modes.md); the one thing to carry here is that **this mode holds no credential**, so
it changes who is shown the feedback and never who may fetch it.

## The extension, and the two worlds

### The rules, in short

- **The private-mode widget carries no credential**, and nothing about the mode is access control.
  `page.content.ts` mounts it with no `transport`, so it calls the worker through `fetchTransport`
  from the page, exactly as a public-mode site does. Two consequences to state rather than discover:
  its reporter is self-declared like any other, and a worker on `read: 'authenticated'` answers its
  reads `401`. The page shows no pin and no reason, so the popup asks the same read and says so
  (`read-probe.ts`, FRU-66): only a `401` is a statement, and a worker that is down or slow gets no
  line. The probe was measured from an extension page with **no** host permission on the worker,
  because the E2E copy holds one and its fetch skips CORS. **A client keeps its own `read`** since
  FRU-95: a worker holding sessions can serve several clients, grouped in workspaces, so a
  private-mode client can stay `public` beside a team-mode one.
- **The popup offers pairing in team mode only** (FRU-88). A session changes nothing in private mode,
  and a form that does nothing reads as the fix for a page with no pins. A session the extension
  already holds with that worker stays on the screen with its log out: a credential is never hidden.
- **The popup and the options page speak English and French** (FRU-131). `i18n.ts` keys a sentence
  by its English text, like the console. **A constant keeps its English sentence, and `t` runs where
  the text goes on the screen**: `remedyFor` finds a problem by its English text, and the guide is
  checked against the English words of the popup. A problem translated before `showProblem` loses its
  button with nothing to see. `messages.test.ts` reads the two pages and fails on a word outside the
  catalog, on a sentence with no French and on a French entry no page shows.
- **The language is the account's, then the browser's.** `GET /session/sites` answers `locale`, and
  `rememberLanguage` keeps it under `language` in `chrome.storage.local`. It is a tag and no
  credential, so the bridge reads it and `mount` carries it to the widget. **A worker that does not
  answer changes nothing; no session left removes it.** The popup learns it without a draw, because
  a draw loses what somebody types: the next popup shows it. A change of language builds the mounted
  widget again, like a change of worker.
- **The guide's words are guarded against the popup's** (`reviewing-doc.test.ts`). `docs/reviewing.md`
  walks somebody through a screen by naming what is on it, and a renamed button leaves it describing
  a popup nobody has. The mode labels are read **out of** `popup/main.ts` and the pairing failures are imported from
  `remedy.ts`, so a fifth message is covered the day it is written; the buttons are named one by one, because a
  regex over them would guard whichever ones it happened to match.
- **`world: 'MAIN'` is the ticket, not a preference.** A content script in the isolated world shares
  the DOM and **not** the properties page scripts put on it: `__reactFiber$` and
  `__REACT_DEVTOOLS_GLOBAL_HOOK__` are both absent there, so the widget would mount, work, and quietly
  never say which component a note is about.
- **The extension carries its licence into the build** (FRU-82). It is `AGPL-3.0-only`, and what a
  store hands somebody is the archive rather than this repository, so a `build:publicAssets` hook
  copies `apps/extension/LICENSE` beside the manifest. A hook and not a copy in `public/`, so the
  text has one home. `license.test.ts` checks the field, the text, and that the copy is declared —
  the same rule as the published packages: a file that exists says nothing about what is in it.
- **The icon is one SVG, rendered to a PNG for each size and committed** (FRU-78).
  `assets/icon.svg` holds the widget's own pin — a circle plus the corner that stayed sharp, which is
  what `border-radius: 50% 50% 50% 0` draws — and `pnpm icons:build` renders it. **Each size is
  rendered from the vector, never resized from the big one**, or the 16px icon is a smudge. The sizes
  live in `src/icon-sizes.ts`, which the manifest, the renderer and `icons.test.ts` all read. Nothing
  in the build generates them, so the guard is what keeps the committed files honest: it fails on a
  missing size, on a file of another size, and on a canvas that holds no drawing.
- **The archives a store takes are built by `release-extension.yml`, on a `v*` tag** (FRU-77).
  `wxt zip` for Chrome, `wxt zip -b firefox` for Firefox — the second writes a **sources** archive
  beside it, which AMO asks for whenever the submitted file was built. The tag and
  `apps/extension/package.json` must name the same version, and the job fails when they do not: a
  store refuses an upload whose version is not higher than the last, so a tag that says something
  else publishes a number nobody chose. **This workflow restores no cache.** A cache entry is
  writable by any run of the repository, and what this job builds is shipped — `zizmor` fails on the
  pair, and `ci.yml` keeps its cache because it ships nothing.
  **The archives are under `.output`, and `upload-artifact` leaves out a hidden directory** unless
  `include-hidden-files` says otherwise. The first tag, `v0.1.0`, built both archives and uploaded
  none. `workflows.test.ts` fails on an upload through a dot directory that does not ask for it.
- **The bridge is `window.postMessage`, and the page can forge on it.** `parseBridgeMessage` refuses
  a _malformed_ message and cannot refuse a **well-formed** one the page wrote. That is inherent to
  the main world and no handoff closes it — it is stated rather than defended, because a reviewer
  grants an origin precisely because they trust that origin's code. **Nothing secret travels there,
  and an identity token is not sent at all.** `worlds.test.ts` is what keeps that true, and
  `protocol.test.ts` pins that a parsed message carries only the fields it declares: four, and since
  FRU-131 the language of the reviewer, a locale tag of 35 characters at most.
- **`createApply` takes a generation token before its `await`.** Three things call it, two can be in
  flight, and the older read can post last. The `posted` signature alone made that **stick rather
  than heal**: the stale run writes its own signature and the correction is then suppressed as
  unchanged. The decision lives in `src/bridge.ts` and not in the entrypoint, because an entrypoint
  binds `browser` and `window` at import and neither guard could be run at all.
- **A site that embeds the widget _and_ a reviewer who has the extension get two docks.** Known,
  harmless, and not solved here. It is the private mode's defect only: in team mode there is one
  widget and it is the site's.
- **A rule that is switched off gives its access back** (FRU-115), with `permissions.remove`, from the
  background after it stores the change. The access to a worker goes with its last site that is on,
  and not while a session needs it. Only the accesses of the rule that changed are candidates: a sweep
  of what the browser holds would take back a grant that a prompt has just given (FRU-118). Not
  verified in a browser. See `docs/decisions/extension.md`.

### The reasons, and the history

- **The client's site embeds nothing** (FRU-41). No tag, no npm package, no deployment — which is
  also the end of the integration friction: today, getting a page reviewed needs a deploy. Ordinary
  visitors see nothing because there is nothing in their page to see.
- **`world: 'MAIN'` is the ticket, not a preference, and it was measured before it was written.** A
  content script in the isolated world shares the DOM and **not** the properties page scripts put on
  it. Probed in Chromium on the playground, on the same `<button>`:

  |                                  | isolated    | main     |
  | -------------------------------- | ----------- | -------- |
  | `__reactFiber$`                  | absent      | present  |
  | `__reactProps$`                  | absent      | present  |
  | `__REACT_DEVTOOLS_GLOBAL_HOOK__` | `undefined` | `object` |
  | own properties                   | **0**       | 2        |

- **Both halves of `source` are blind from the isolated world, not one.** `readReactSource` finds the
  fiber under `__reactFiber$…`; react-grab scans `__reactContainer$` / `__reactInternalInstance$` and
  installs _itself_ as `globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__`, which in the isolated world is a
  global React never reads. So the widget would mount, work, and quietly never say which component a
  note is about — the worst shape of failure, because nothing errors.
- **Registered as a content script rather than injected as a `<script>` tag.** A tag pointing at an
  extension URL is evaluated in the page and **the page's CSP can refuse it**. A main-world content
  script — whether it is declared in the manifest or registered through `scripting` — is not subject
  to it. That is the CSP trap the ticket names, avoided rather than worked around. This paragraph
  said _declared in the manifest_ until review pointed at it: true of the first draft, and false from
  the moment the manifest stopped declaring anything.
- **`packages/widget` is unchanged by this app, which is the ticket's own test.** The widget runs
  where it always ran — in the page — so the extension is a fourth assembler beside `global.ts` and
  nothing extension-shaped leaks into the widget. `createCaptureHost` does take an `engine` seam that
  would have allowed a narrower bridge; it was not needed, and not using it is what keeps this app
  off FRU-37's branch.
- **No host permission at install.** The obvious build declares its content scripts on `<all_urls>`,
  which asks a reviewer to let a tool read every page they will ever visit. `background.ts` registers
  the two scripts at runtime for the origins somebody turned on and granted, and unregisters them on
  the way out. The first draft of `wxt.config.ts` had a comment claiming this while the manifest said
  `<all_urls>` — a comment describing a decision the code had not taken.
- **`syncRegistration` unregisters on an empty set rather than updating.** `updateContentScripts`
  refuses an empty `matches`, so an implementation that updated there would throw and leave the
  previous origins registered — the extension would keep running on a site just switched off. That is
  the test worth reading in `registration.test.ts`.
- **The bridge is `window.postMessage`, and the page can forge on it.** `parseBridgeMessage` refuses
  a _malformed_ message; it cannot refuse a **well-formed** one the page wrote, because the two are
  identical. A page can post its own `mount` and point the widget at its own worker, or post
  `unmount` and take it away. The first version of this paragraph claimed the parse defended against
  that. It does not, and claiming it was worse than the gap.
- **That is inherent to the main world, not a flaw in the bridge, and no handoff closes it.** The
  main world _is_ the page's realm: a hostile page can patch `fetch`, `JSON.stringify` or the
  widget's own methods however the config arrived, and a nonce would have to travel on the channel
  the page reads. So it is stated rather than defended — **a reviewer grants an origin precisely
  because they trust that origin's code**, and the extension runs on no other. What is reduced is
  what is at stake: nothing secret travels there, the endpoint and client id are already in the
  client's own DOM in tag mode, and an identity token is **not sent at all**. FRU-42 keeps the token
  in the isolated world behind a relay, which is what has to keep being true.
- **`registerContentScripts` reaches the _next_ page load, never the open one.** So the popup injects
  both files into the current tab after the grant, or the reviewer switches a site on and looks at a
  page with no dock while the popup says it is on. The browser run that first _proved_ the no-reload
  flow had seeded storage **before** the page loaded — which is not what a person does, so it was a
  green check on a path nobody walks. Raised in review.
- **An unchanged decision is never re-posted, and that is what protects a half-written note.**
  `writeSite` stores the whole map under one key, so any change fires `storage.onChanged` in **every**
  tab of every enabled origin — turning site B on from the popup reaches the tab open on site A. A
  re-posted `mount` makes the page world destroy and rebuild the widget, which closes the composer
  and loses what the reviewer was typing. That is the one failure this widget cannot afford, so the
  bridge compares against what it last sent. The `ready` handshake forces past the comparison,
  because the page world may have missed that same message. Raised in review.
- **The first browser check of that guard proved nothing, and the mutation is what said so.** It
  marked `[data-fruitback-host]` at index 1 and called it the extension's — but the playground mounts
  its own and the order is not promised, so it may have been watching a host that never rebuilds. It
  marks **every** host now and counts the ones that come back unmarked. Measured both ways: 0 rebuilt
  with the guard, 1 without.
- **`init` takes a `configKey`, and that is the one widget change this app forced.** The config store
  reads `fruitback:config` from the page's `localStorage` and lets it _override_ what `init` was
  passed — correct for one widget, wrong the moment there are two. A site that embeds the widget,
  opened by a reviewer whose extension mounts its own, shares that key: one instance silently takes
  the other's `endpoint` and `clientId`, and the notes go to a worker nobody chose. The seam is not
  extension-shaped — any second instance needs it — which is why it passes the ticket's own test.
- **A second key was half the answer, and the half that was missing is the page can write _ours_.**
  The store restores its key from the page's own `localStorage`, so a page that wrote
  `fruitback:config:extension` before the widget mounted chose where the notes went. The same gap
  faces the other way with nobody hostile at all: a stored `endpoint` beats the new default for ever,
  so changing it in the popup would never take effect on a site the reporter had already set a
  preference on. `createConfigStore({ pinned })` is the fix — `endpoint` and `clientId` are the
  caller's word and are not restorable — and a mount that names its own key pins them. Raised in
  review, mutation-tested. **Since FRU-89 the store holds neither field**, so there is nothing to
  pin: see _The settings panel_ in [widget.md](widget.md).
- **`apply` awaits in the middle, and three things call it**: the first run, the `ready` handshake,
  and every storage change. Two can be in flight, and the older read can post last — a site switched
  off that stays mounted. The `posted` signature made that **stick rather than heal**: the stale run
  writes its own signature, so the correction is then suppressed as unchanged. A generation token
  taken before the await is what discards it. That is also why the decision moved to `src/bridge.ts`:
  an entrypoint binds `browser` and `window` at import, and neither guard could be run at all.
- **The background sync logs the whole body, not the registration call.** `serialize` swallows a
  rejection to keep the queue moving and every caller is fire-and-forget, so a throw that is not
  logged there is logged nowhere: the scripts stay unregistered, no page mounts anything, and the
  popup still says the site is on. The first version wrapped `syncRegistration` alone and left a
  failing `readAll` perfectly silent. The reviewer's own fix — returning the caller's rejection —
  was **not** taken: every call site is `void sync()`, so it would turn a silent failure into an
  unhandled rejection in the service worker rather than into a message.
- **The endpoint is normalized before it is stored, and a path survives it.** `embed.ts` interpolates
  — `${endpoint}/feedback?url=…` — so `https://worker.test?tenant=a` asks for `/` with a parameter
  whose value ends in `/feedback`: the site reads as **On** and no pin ever appears. Query and
  fragment go, a trailing slash goes, and the path **stays**, because a worker behind
  `https://example.com/fruitback` is an ordinary Traefik deployment that an origin-only rule breaks.
- **Nothing orders the two content scripts against each other**, so the main world announces itself
  with `ready` and the isolated one applies its decision again. `postMessage` delivers that back to
  the sender too, which the main world has to ignore explicitly — the type checker found that one.
- **A site that embeds the widget _and_ a reviewer who has the extension get two docks.** Measured on
  the playground, which mounts its own: switching the extension on took the host count from 1 to 2.
  Harmless, visibly silly, and not solved here — the extension cannot tell its own host from theirs
  without the widget advertising itself, which is a widget change.
- Verified in a real Chromium against the playground: switching the site on mounts a second host
  **with no reload**, the fiber owner chain reads `SiteHeader < Pricing < …` from the page world, and
  switching it off destroys it live. The permission prompt itself is a native dialog no automation
  can drive, which is why that path is unit-tested and the browser run uses a build with the scripts
  declared statically.

## A problem, and the one thing to do about it (FRU-90)

### The rules, in short

- **A problem is shown with the one thing to do about it** (FRU-90). `remedy.ts` lists every problem
  the popup and the options page can say, each with a remedy or with the reason it has none, and
  `showProblem` draws the button from that list on both pages. `remedy.test.ts` fails on a problem
  constant that is in no entry, and on a page that writes a problem by hand. **A remedy runs in its
  own click**, so it can ask for a permission: the pairing attempt and the turn-on are functions the
  button calls again, never a promise that already ran.

### The reasons, and the history

The popup and the options page stated a problem and stopped: « The worker did not answer. Try
again. » with nothing to press. The options page already had the right shape in one place, « No
access in this browser » with **Grant access** beside it.

- **`remedy.ts` is the inventory, and the pages draw from it.** Fifteen problems. Seven have a
  remedy; eight have a reason for none, which is a field beside the message or a file only another
  file replaces.

  | The page says                               | Beside it             |
  | ------------------------------------------- | --------------------- |
  | a code that is spent or expired             | **How to get a code** |
  | a worker that did not answer                | **Try again**         |
  | a refused permission on the worker          | **Grant access**      |
  | a worker on plain http, from either message | **Change the worker** |
  | a refused permission on the site            | **Grant access**      |
  | a change that was not confirmed             | **Check the list**    |

- **One function draws them, `showProblem`.** Two pages that each build a button drift: the popup
  would say « Retry » where the options page says « Try again ». `remedy.test.ts` fails on a page
  that writes a problem by hand, and on a problem constant of `site-editor.ts` or `site-form.ts`
  that is in no entry of the list.
- **A remedy is a click, and that is what makes « Grant access » possible.** A host permission can
  only be asked for while a gesture is handled. So the pairing attempt and the turn-on became
  functions, and the remedy calls the function again: the request is the first thing it does. A
  remedy that held the promise of the first attempt could only say that it failed.
- **« Try again » is offered only where the same try can succeed.** A worker that did not answer
  left the code unspent. A code the worker refused is spent, so the popup links to the guide and
  offers no second try: the E2E spec asserts that absence, and the other half of the same spec is
  its control.
- **« Check the list » and not « Retry » for a change that was not confirmed.** The change can be
  stored although its answer was lost (FRU-73), so doing it again is the wrong advice. On the popup
  the button opens the options page; on the options page it reads the list again from storage.
- **The pairing failures moved out of `popup/main.ts`**, into a module `node --test` can import. The
  guide's guard read them out of the popup source with a regular expression; it imports them now.

## A pairing code that arrives as a link (FRU-92)

### The rules, in short

- **A pairing link is `<worker>/pair#<code>`, and the popup reads it from the address of the tab**
  (FRU-92). `parsePairLink` takes the worker from **where the page is**, never from a value in the
  address: any page can have an address of that shape, so a page can offer a pairing with itself
  and with no other worker. The popup names the worker and pairs on a click. `GET /pair` takes no
  request and runs no script, so the worker cannot read a code and the page cannot either. The
  person is not named before the code is spent: a name in a link is the word of its writer.
  **A click on the toolbar icon cannot be automated**, so the E2E spec proves the flow with a host
  permission on the worker; the `activeTab` grant of a real click is the one step checked by hand.

### The reasons, and the history

A reviewer was handed `ABCD-EFGH-JKMN`, opened the popup on the right site and copied it in. The
ticket asked for a link, and left the path to be measured. Four were on the table.

| Path                                                           | What stops it                                                                                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A content script on the worker's page                          | It needs a host permission on the worker, and the first pairing is where that permission is asked for.                                  |
| `externally_connectable`                                       | The origins are declared in the manifest. A self-hosted worker is not known at build time, and Firefox has no such key.                 |
| A page of the extension, `chrome-extension://<id>/pair.html#…` | The worker cannot know the id, which differs between an unpacked build and a store build. A web page cannot link to that scheme either. |
| **The popup reads the address of the tab**                     | Nothing. No new permission, the same on Firefox, and any self-hosted worker.                                                            |

- **Measured, in Chromium 1234, on the built extension.** A tab on
  `http://localhost:<port>/fruitback/pair#ABCD-EFGH-JKMN`, then `tabs.query({ active: true })`:

  | The extension                                | `tab.url`                                                |
  | -------------------------------------------- | -------------------------------------------------------- |
  | unmodified, no permission on that origin     | withheld (`undefined`)                                   |
  | a copy with a host permission on that origin | the whole address, with the path prefix and the fragment |

  So the address carries the fragment whenever the extension may see the tab. **What automation
  cannot do is the click on the toolbar icon**, which is what grants `activeTab` on the unmodified
  build: `chrome.action.openPopup()` opened no popup in headless Chromium. The popup already
  depends on that grant to read the origin of the tab (FRU-41), so the mechanism is in use; the
  fragment under a real click is the one step checked by hand.

- **The worker is the page the link is on.** `parsePairLink` reads no worker from the query or the
  fragment. A link is forgeable, and the only thing a forged one can do is offer a pairing with the
  page that forged it. The path before `/pair` is kept: the session is stored under the endpoint,
  and a rule names `https://example.com/fruitback` with its path.
- **`pair --endpoint`, and no environment variable.** The container does not know its public
  address. A variable for it would be one more line in every `.env`, checked by three guards, for
  one printed line. The flag refuses plain `http://` outside localhost, so a link is never minted
  for an address a code must not cross.
- **The page is static and the module takes no request.** `pairPage()` has no parameter, so a code
  put in the query by mistake cannot be read, echoed or logged by this code. A test asks for
  `/pair?code=…` and compares the bytes with `/pair`.
- **The popup shows the link screen in place of the site screen.** On a worker's own page the form
  that switches a site on is the wrong question. The field for a code moved behind **I have a
  code**: it is the way in when a link did not arrive.
- **A page of a site can have an address of that shape**: `https://example.com/docs/pair#AAAA-BBBB-CCCC`.
  The popup would show the link screen there and hide the form that switches the site on. Raised in
  review. No rule on the address tells the two apart, so the link screen carries a button, **This is
  a site to review**, that opens the site's own screen.
- **No name before the pairing.** The first design put the name in the fragment so the popup could
  say who the code was for. That name is the word of whoever wrote the link, which is the claim
  FRU-9 refuses from a browser. The worker says who, after the code is spent.

## The session, and the token that never goes down (FRU-60)

### The rules, in short

- **The refresh token lives in `chrome.storage.local` and the access token in
  `chrome.storage.session`.** One survives the browser closing and the other must not. Both in
  `session` would make a reviewer pair again every morning, and somebody who does that keeps their
  pairing code in a text file — a worse place than the one the split protects.
- **Nothing calls `setAccessLevel` on the session area.** Its default excludes content scripts, which
  is the boundary this whole batch exists to hold. A token is held only by the extension's **trusted
  contexts** — the background, which refreshes, and the popup, which pairs and logs out. The isolated
  script never reads one; it asks the background to make the call, the seam FRU-57's relay needs.
- **Pairing asks for a host permission on the worker's origin**, which is not the site's. The session
  routes answer a `chrome-extension://` origin with CORS headers that ought to make an unprivileged
  `fetch` enough — but that was measured with `curl`, which does not enforce CORS. It is the
  repository's recurring defect (FRU-25) waiting to happen, so the permission is asked for rather
  than relied on. **It must be requested before anything is awaited in the click handler**, like
  `turnOn`: a gesture is lost across an await and the prompt never appears.
- **A refresh writes nothing back once the refresh token in storage is no longer the one it spent**
  (`keepIfCurrent`), and no write means no grant either. The popup and the background are separate
  contexts sharing only storage, so a logout can land while an alarm is awaiting `/session/refresh`,
  and the answer used to put a working access token back under a screen saying signed out. The token
  is its own generation marker for that compare.
- **A logout mints a new epoch for the endpoint before it clears anything** (FRU-64), and a session
  stamped with the one before it is refused by every reader (`stillOpen`). The compare and the write
  in `keepIfCurrent` are **not** one operation and cannot be — `chrome.storage` has no transaction —
  so what covers the gap is what the write **carries**: the epoch of the very read the compare was
  made on. A logout landing anywhere around those lines leaves the endpoint logged out. Nothing
  refuses the write itself. The entry lands, unreadable, under the key of its own run, and removes
  that key after it lands (FRU-65).
  **The stamp must come from that read and from no fresher one**, which is why `keepIfCurrent` reads
  the session itself and why the `epochs` seam has `put` and no `read` — a writer that could read the
  epoch could stamp with the logout's own.
- **A pairing mints one too, and writes it before the session it stamps.** A logout leaves an epoch
  behind on an endpoint holding nothing, so an endpoint paired again would otherwise read as signed
  out for ever. Absent on both sides compares equal, the same rule the generation follows.
- **The guard is an allowlist**: `worlds.test.ts` _discovers_ every `*.content.ts` declaring
  `world: 'MAIN'`, follows its relative imports, and refuses a `session*` module or the name
  `refreshToken` / `accessToken` anywhere in that closure. A main-world file added later is covered
  the day it is written. **It detects the world on the code, not on the file** — the docstring of
  `page.content.ts` quotes `world: 'MAIN'`, so the first version guarded a file that had stopped
  reaching the page and reported a pass.
- **No credential crosses plain `http://`** (FRU-57). `isSecureWorkerEndpoint` requires https or
  loopback, and `pair`, `refresh` and the revoke in `logout` all ask it — in `session.ts`, not only
  in the popup that warns first, so a session stored before the rule cannot keep spending its token
  over the wire. `isWorkerEndpoint` is **not** tightened: it gates the private mode's mount, which
  carries no credential.
- **`postJson` bounds its own request.** `refreshOnce` holds the in-flight promise so a second
  caller joins it rather than spending the token twice, so a worker that accepts a connection and
  never answers leaves that endpoint unable to refresh for the life of the service worker. Found by
  looking for the other half of a review finding about the relay's fetch. Until FRU-63 one queue
  chained every storage write, and the same hang stopped **every** worker.
- **Log out revokes, then clears — and clears whatever the revoke answered.** A failed revoke leaves
  the token live on the worker until it expires; a screen saying signed out over a working credential
  would be worse.
- `src/session.ts` is the logic behind seams and `src/session-browser.ts` binds the real
  `browser.storage` and `fetch`, the same split `bridge.ts` made. **Refreshing runs on an alarm, not
  a timer** — an MV3 service worker is stopped whenever the browser feels like it.
- **`nextWakeAt` never returns a moment in the past**, missing token included. It did, and the alarm
  was then clamped to a minute: a worker that stayed down woke the service worker to fail every
  minute, for ever. `isFresh` is the single freshness rule the three callers share so they cannot
  drift apart.

### The reasons, and the history

FRU-42 built the worker half — pairing codes, access and refresh tokens, revocation, three routes
exempt from the origin allowlist. This is the other half, and it carries the constraint that shaped
both: an access token the host site's JavaScript can read is the worst outcome of this batch.

- **Two storage areas, and the split is the decision.** The refresh token goes in
  `chrome.storage.local`, which survives the browser closing; the access token goes in
  `chrome.storage.session`, which does not. Both in `session` would look tidier and be worse: a
  reviewer who pairs again every morning keeps their pairing code in a text file, which is a worse
  place than the one the split was protecting. FRU-42's "when the lifetime suits it" is what allows
  this.
- **Nothing calls `setAccessLevel` on the session area, on purpose.** Its default excludes content
  scripts, which is exactly the boundary this ticket holds. Widening it to
  `TRUSTED_AND_UNTRUSTED_CONTEXTS` so the isolated script could read the token directly would put the
  token one `postMessage` mistake away from the page — the isolated script asks the background to
  make the call instead, which is the same seam FRU-57's relay needs. What _does_ hold a token is
  every trusted context: the background refreshes and the popup pairs and logs out, which is what
  `TRUSTED_CONTEXTS` means and what the documentation now says. Raised in review, where the first
  wording claimed the background was the only one.
- **Pairing asks for a host permission on the worker's origin, and that is a hedge rather than a
  proof.** `turnOn` only ever requested the _site_; a worker normally lives somewhere else entirely,
  so nothing had asked for it. The session routes answer a `chrome-extension://` origin with CORS
  headers that ought to make an unprivileged `fetch` enough — and that was measured against a real
  worker with a real preflight, **with `curl`, which does not enforce CORS**. No browser runs on this
  machine to settle it, and the failure mode if it is wrong is total: pairing simply never works,
  with the request never arriving. So the permission is requested, and granted it makes the call
  privileged and CORS irrelevant. Raised in review; the reviewer's stated reason was wrong (CORS is
  precisely what would grant it) and the recommendation was right anyway.
- **A refresh writes nothing back once the token in storage is no longer the one it spent.** The
  popup and the background are separate contexts with separate `Sessions`, sharing only storage: a
  reviewer can click log out — revoking, then clearing — while an alarm is already awaiting
  `/session/refresh`. Writing the grant afterwards put a working access token back under a screen
  saying signed out, and revocation does not reach an access token already minted. The refresh token
  is its own generation marker, which is what makes the check work across contexts with nothing to
  keep in step. `chrome.storage` has no transaction, so the window is narrowed from a network round
  trip to two storage operations rather than closed. Raised in review.
  - The first test for it passed for the wrong reason: it mutated storage before the refresh had
    read it, so the early `not-paired` answered and the guard never ran. Synchronised on the request
    being _entered_ instead, then mutated — and removing the guard now fails both cases.
  - **Narrowed again by FRU-61**, because rotation made this path run on _every_ refresh rather than
    on the rare answer that carried a new token. The compare and the write were separate — a read, a
    read, a write — so a logout landing across any of the three was enough. `keepIfCurrent` does both
    on one read and reports whether it wrote; nothing mints a grant when it did not. Still not
    closed then, and it could not be closed by a tighter gap: `chrome.storage` has no transaction.
    **FRU-64 closed it from the other side**, by what the write carries rather than when it lands.
    Raised in review.
- **One refresh in flight per endpoint, and the race is not the one above** (FRU-61, raised in
  review). Rotation turned a duplicated refresh from a wasted request into a lockout: two callers
  spend the same token, the worker reads the second as a retry inside the grace and revokes the
  first successor, and whichever answer lands last decides what the extension holds. If it is the
  first, the extension holds a token the worker revoked; the next refresh answers `401`, the session
  ends, and only an operator minting a new pairing code brings the reviewer back.
  - The spent token stays good only **until its successor is used, or `ROTATION_GRACE_SECONDS`
    passes** — whichever comes first. A retry inside the ceiling lands on its feet; one after it is
    refused and takes the chain with it. Raised in review, because this record described the first
    half as if it had no second.
  - **What hid it was that half of the path was already serialised.** `background.ts` wraps
    `refreshDue` in `serialize`, so the alarm cannot overlap itself. The relay calls `ensureAccess`
    directly and goes nowhere near it — and the widget has a read and a write in flight in the
    ordinary case, so two concurrent refreshes are the normal state of team mode, not a rare one.
  - I had checked the _other_ half and concluded there was no race: the popup calls `list`, `pair`
    and `logout` only, so it never refreshes. True, and it answered a question nobody needed
    answering. The PR body said so before the review corrected it.
  - `refreshOnce` holds an endpoint-to-promise map with **no `await` between the `get` and the
    `set`**. `ensureAccess` awaits `grants.read()` before deciding, so two callers can both find the
    grant stale; the map is the only thing between them and it only works if that pair is
    synchronous. The test starts both calls before awaiting either — `await ensureAccess()` twice
    passes with or without the lock, which is the shape of test this one exists not to be.
  - It lives in `session.ts` rather than the entrypoint for the reason `bridge.ts` gives: an
    entrypoint binds `browser` at import, and no test could reach the guard there.
  - **And it is not enough, because the lock is per endpoint and the storage is not.** Both areas
    hold every endpoint under one key, and a write replaces that key whole; two workers refreshing at
    once each read the record and each replace it, so the later write restores the earlier one's
    spent token. Under rotation that token is a replay, and its next use revokes the chain.
    test:`lets two workers refresh at the same time` — a test written to prove the lock was correctly
    scoped — is what makes it reachable. The fix at the time was one queue over both areas, inside
    one context. FRU-63 replaced it with one key per endpoint, which reaches the popup too, and the
    queue is gone. Raised in review.
  - The first test for it **deadlocked the moment the fix landed**: it gated on two writes being in
    flight at once, which is precisely what the fix prevents. A test that cannot pass against correct
    code is not a test. It yields a few microtasks in the write instead — unserialised, both reads
    land before either write; serialised, the yielding changes nothing.
- **A `200` from `/session/refresh` carrying no `refreshToken` is a failure, not a success**
  (FRU-61, raised in review). Every refresh rotates, so an answer without a successor means the
  worker spent the stored token and the replacement did not arrive — a truncated body, a route that
  stopped naming the field. Accepting it stored a spent token under a working access token, and the
  session died at the end of the grace with nothing to explain it. It answers `unavailable`, so the
  retry runs while the predecessor is still good. `parseIssued` stays tolerant and both call sites
  require the field: the rule belongs beside the failure it prevents, and a later route issuing only
  an access token would otherwise have to work around it.
- **The guard is an allowlist, not a denylist** (`src/worlds.test.ts`). Naming the files that must
  stay clean passes a main-world entrypoint added next year. So the entrypoints are _discovered_ —
  every `*.content.ts` declaring `world: 'MAIN'` — their transitive relative imports are computed,
  and none of those may be a `session*` module or name `refreshToken` / `accessToken` in code.
  - **The detection reads the code, not the file.** `page.content.ts` opens with a paragraph about
    why `world: 'MAIN'` is the ticket, so the first version kept the file in the list after the
    declaration itself had changed — it then guarded a file that no longer reached the page and
    reported three passes. Found by mutating the declaration and watching nothing fail.
  - **All three import spellings, not only `from`.** A side-effect `import './x.ts'` and a lazy
    `await import('./x.ts')` reach the page exactly as well, and following only one of them would
    have made the "fails by default" promise quietly false. Raised in review; each spelling was then
    mutated in and watched to fail.
  - The built bundles say the same thing, which is the version that cannot be argued with:
    `refreshToken`, `accessToken`, `/session/` and `storage.session` each appear **once in
    `background.js` and zero times in `page.js` and `bridge.js`**.
- **Only a `401` ends a session.** An outage, a `502` from a store nobody mounted, a laptop on a
  train: all of those keep the refresh token. Throwing it away on a network blip logs a reviewer out
  of a session the worker still considers open, and the only way back is an operator minting a new
  pairing code on the container.
- **A busy worker is not a bad code.** A `429`, a `502` or a `503` on `/session/pair` answers `unavailable`
  and not `code-spent-or-expired`, because the second sends a reviewer for a replacement code while
  the one in their hand is still good.
- **Log out revokes, then clears — and clears whatever the revoke answered.** The other order cannot
  work: the token the call needs is the one the clear has just thrown away. A revoke that never
  arrived leaves the token live on the worker until it expires, which is what the 30-day limit is
  for, and that is the honest trade rather than a screen saying signed out over a working credential.
- **An alarm, not a timer.** An MV3 service worker is stopped whenever the browser feels like it, so
  a `setTimeout` dies with it. It is set at the next due moment rather than on a period: one session
  with a ten-minute token and a two-minute margin wakes the worker every eight minutes.
- **A failed refresh backs off, and the first version did not.** A refresh that could not reach the
  worker leaves the grant stale, `nextWakeAt` then asked for a moment already past, the alarm was
  clamped to a minute — and the service worker woke to fail again every minute for as long as a
  staging endpoint stayed down. `RETRY_DELAY_MS` is the floor for any due time in the past, missing
  token included. Nothing is lost by waiting: a browser restart, a pairing and a logout each refresh
  directly rather than through the alarm, and the first token after a restart comes from the service
  worker's own start-up call. Raised in review — both halves were tested and their composition was
  not.
- **Rotation was half-built on purpose, and FRU-61 built the other half.** A rotated refresh token
  is stored when one arrives, and since FRU-61 one arrives on every **successful** refresh — an
  answer without it is refused here rather than taken, because the worker has spent the stored token
  by then. The lost-answer case is handled on the worker rather than here: the spent token stays
  usable until its successor is used **or `ROTATION_GRACE_SECONDS` passes**, whichever comes first,
  and nothing on this side ends that window. Raised in review, twice: this sentence carried both the
  missing ceiling and the "on every refresh" overstatement. This side needs nothing but the store it
  already had.
- Verified over the real transport rather than against the handler, which is this repo's recurring
  defect (FRU-25): a real `OPTIONS` preflight from `chrome-extension://…` for
  `Content-Type: application/json`, then pair → refresh → revoke → refresh, answering
  `204 / 200 / 200 / 204 / 401`. What is **not** verified here is `chrome.storage` itself and the
  real world boundary — that is FRU-45, and no browser runs on this machine.

## One storage key per endpoint (FRU-63)

FRU-61's review found a refresh for one worker restoring another's **spent** token. The fix then was
a queue in `session.ts`: one read-modify-write on storage at a time. That held it inside the
background. It did not reach the popup, which builds its own `createSessions` over the same two
areas, and the queue could not be made to — `chrome.storage` has no lock and the contexts share
nothing else.

The shape was the problem, not the ordering. Both areas kept **every endpoint under one key**, so
every write replaced a record holding every worker. Three failures follow from that one fact:

- a background refresh for worker A writes B's entry back, spent, and B's next refresh is a replay;
- a logout in the popup is written away by a refresh that started before it — **a logout that does
  not stick**, over a credential the worker still honours;
- a pairing is lost the same way, while the reviewer is told it succeeded.

`Area` now has `put(endpoint, value)` and `drop(endpoint)` instead of `write(everything)`, and each
endpoint owns `fruitback:session:<endpoint>` or `fruitback:grant:<endpoint>`. `storage.set` on one
key is atomic on its own, so a write for A cannot reach B from any context. The queue is deleted
rather than scoped per endpoint: `refreshOnce` already orders a refresh's two writes within one
context, and a second lock guarding what the first guards is a question for whoever reads it next.

### What the shape does not fix, and what still does

The compare in `keepIfCurrent` and the write after it are still two operations, and `forget` is still
two drops. At the time of this ticket the **generation** marker covered one of the two logouts that
can land there — a grant minted for a session storage no longer holds is refused on the next read —
and the other was left open and named: FRU-64, below. The whole-record write only looked atomic
across the two areas; it was two `set` calls as well.

### The upgrade, and the one interleaving it does not close

`splitLegacyRecord` takes one `get(null)` snapshot, writes the endpoints with no key of their own,
then removes the legacy key. The order is the guarantee: a failure between the two leaves the
credentials readable by the next attempt rather than gone, and the way back from gone is an operator
minting a new pairing code.

**A failure keeps the gate shut.** The first version swallowed it, which released every operation
against storage still holding the legacy record: a read then says the reviewer is paired with nobody
while a live credential sits under the old key, and a `drop` removes a key that was never written.
That is the quiet half of the failure. Rejecting is the loud half — the popup shows the site row with
no session block — and the next time the context starts it tries again. Raised by the advisor.

Both contexts run it at startup, which is why an endpoint that already has its own key is skipped —
the other context may have finished first and had a refresh land since. What stays open: the other
context can hold a snapshot, a logout can remove the new key, and the upgrade can then write the
session back. It needs a log out inside the one storage round trip between that read and that write,
on the first run after the upgrade only. Narrowed and stated, like everything else here — **and
closed by FRU-64**, below, which reached it for free: a legacy record predates the epoch, so what
the upgrade writes back carries none while the logout minted one, and no reader answers with it.
test:`refuses the session an upgrade still in flight writes back after a logout` is the case. What that
window still cost was a pairing made inside it, which the upgrade put the older entry back over. The
endpoint then read as signed out. FRU-65, below, closes that too.

**`storage.session` is migrated too**, though the browser usually empties it before anybody notices.
An extension updated while the browser stays open still holds the legacy grants record, and a grant
under a key nothing reads costs one needless refresh per worker with nothing anywhere to say why.

### Where the code went, and what the tests reach

`session-storage.ts` holds the key rules, the `Area` factory and the upgrade, over a `StorageArea`
seam; `session-browser.ts` is left binding `browser` and `fetch` and nothing else. That is what lets
`node --test` drive the upgrade, the ordering and the three `await ready` gates — all three mutate to
a failing test, and the one that guards a **spent** token needed the interleaving arranged deliberately
before it discriminated.

test:`does not restore a spent token when another endpoint refreshes at the same time` survives, and it
passes for a structural reason now rather than a serialised one. It still discriminates: restoring
the whole-record write inside `keepIfCurrent` makes it fail. Its docstring says which, because a test
whose reason has changed reads as stale to whoever greps for the defect next.

`sites.ts` keeps the whole-record write it always had. Only the popup calls `writeSite`, and there is
one popup.

## A logout that lands inside a refresh (FRU-64)

FRU-63 gave every endpoint its own key, which makes a write atomic **per endpoint**. It does not
order two writers, and one interleaving was left open and named:

```
background: read storage        → refreshToken === spent ✓
popup:      logout              → revoke on the worker, drop the session, drop the grant
background: put(session, gen.N) ← the session is back
background: put(grant,   gen.N) ← and the grant agrees with it
```

Both writes carry the same new generation, so `matches` accepts the grant: FRU-61's marker catches a
logout landing _between_ the two writes and cannot catch one landing _before_ them. The refresh token
put back is revoked on the worker — logging out revokes the chain — so the next refresh answers
`401`. That does not reach the access token already minted, which stays good for its remaining ten
minutes. A reviewer who clicked log out keeps reading pins.

### The write cannot be stopped, so it is made unreadable

`chrome.storage` has no transaction and no compare-and-set. Nothing in the background can refuse a
write at the moment it lands, and a tighter gap only makes the window smaller. What can be decided is
**what the write carries**.

Each endpoint gets an epoch: `fruitback:epoch:<endpoint>`, an opaque id in `local` beside the session
it dates. A logout mints a new one **before** it clears anything, a pairing mints one before it writes
the session, and `keepIfCurrent` stamps what it writes with the epoch of the very read its comparison
was made on. `stillOpen` then refuses any session that disagrees with its endpoint's epoch, so the
three places a logout can land are all covered by one rule:

- before the read — the session is gone, and the comparison already refused.
- between the read and the write — the stamp names a run that is over; the entry lands and no reader
  answers with it. The grant beside it has no session to match.
- between the session write and the grant write — the same, and `matches` refuses the orphan grant
  as well. Two refusals where FRU-61 left one.

The check moved from write time, where there is no ordering, to read time, where there is no race.

Three things make it hold, and each is a way it could have been got wrong:

- **The stamp comes from that read and no fresher one.** A stamp read after the logout agrees with
  storage and puts the session back. So `keepIfCurrent` reads the session itself rather than being
  handed one, its parameter is `Omit<StoredSession, 'generation' | 'epoch'>` so a caller cannot
  supply a stamp, and the `epochs` seam is `Pick<Area<string>, 'put'>` — a writer that could read the
  epoch could stamp with the logout's own.
- **The epoch is minted before the clear, not after.** The other order leaves a gap where the keys
  are gone and the run is not yet over, and a refresh landing in it writes a session that agrees with
  what it read.

Absent on both sides compares equal, which is the rule `matches` already follows: a session stored
before this marker existed is kept rather than signing the reviewer out on an update.

What this did not do is remove the entry. A refresh that lost the race still wrote its key, and it
stayed in storage, unreadable, until the next pairing wrote over it. FRU-65 removes it, and says why
that removal is safe where a write from a read is not.

### Two `Sessions` over one storage

The case could not be written against the fake `Area`s the rest of `session.test.ts` uses: the popup
and the background are two `createSessions` over **one** storage, and two fakes cannot reach each
other. So `createStoredSessions` is now the single assembly — which key holds what, the upgrade, the
areas — and `session-browser.ts` is left binding `browser.storage` and `fetch` to it. A test drives
the wiring that ships.

That is what found the first defect in this ticket. `parseStoredSession` did not carry the epoch
through, so every session read back from real storage was stamped with nothing and refused. A fake
`Area` answers with what a test put into it and never parses, so the whole suite stayed green while
nothing worked: pairing, on real storage, signed the reviewer straight back out.

**A fake that answers more than the real thing validates whatever is written against it next.** The
storage fixture returned the whole area for a keyed `get` as well as for `get(null)`. Nothing reads
by key — a key per endpoint leaves no one key to ask for — so it hid nothing yet, and the first
keyed reader written against it would have passed whatever key it asked for. It answers by key now,
and a test pins that. Raised in review, and it is the same lesson as the paragraph above.

The interleavings are arranged by holding one storage write open — the only place the two contexts
can be ordered against each other, since they share nothing else. Thirteen mutations were run and
each fails a test: the ten rules this ticket adds, including the two that only say _when_ something
happens — minting the epoch after the clear, and reading the epoch in a second round trip instead of
from the snapshot the session came from — plus `matches`, which still refuses a grant and a session
that drifted apart inside one run, and the two directions of the `finally` below.

### What a logout can still lose, and what it cannot

**Minting the epoch must not be able to keep the credentials.** The first version returned when
`epochs.put` rejected, so a quota or a transient storage failure left both credentials in place after
the worker had already been told to revoke — a fresh grant, still readable, under a popup saying
signed out. The drops are in a `finally` and the rejection still reaches the caller; that logout is
then back to what it was before this ticket, which is the side to degrade to. Raised in review.

**A pairing made inside a refresh's window was still lost**, and this ticket did not close it. A
refresh reads, the reviewer logs out and pairs again, and the refresh's write lands over the new
pairing stamped with the run before it — so `stillOpen` hid an endpoint somebody had just paired.
Before this ticket the same write put a **spent** token back and the endpoint read as paired until
the next refresh answered `401`; after it, the endpoint read as signed out at once. Closing it meant
versioning the key rather than stamping the value: **FRU-65**, below. Raised in review.

## A key per run of a session (FRU-65)

FRU-64 stamps what a refresh writes with the run it read, so a write that loses the race to a logout
is refused. That covered the credential and not the key. A logout and a new pairing inside the
refresh's window put the new session under the one key the endpoint had, and the refresh then wrote
its refused entry over it.

### The key names the run

A session key is now `fruitback:session-run:<epoch>:<endpoint>`. `put` writes the run its value's
epoch names, so a refresh writes the run it read. A pairing made since has its own epoch and its own
key, and the refresh's write lands beside it.

- **The epoch is encoded with `encodeURIComponent`**, which never writes a colon, so the first colon
  after the prefix ends it. The endpoint is the rest of the key, colons included. The epoch minted in
  production is hex and holds no colon, but the key does not depend on that.
- **A session with no epoch has an empty segment.** That is every session stored before FRU-64, and
  absent still compares equal to absent.
- **A value whose epoch is not the one its key names is dropped.** Nothing here writes one.

The grant keeps one key per endpoint. A refresh that lost the race still writes its grant over the
pairing's grant, and `matches` refuses it: the generation is the refresh's, not the pairing's. That
costs the pairing one refresh, and
test:`keeps a pairing made while a refresh is in the air` asserts that refresh.

### What a write removes, and why that removal is safe

A key per run leaves the key of every run that is over in storage, and each holds a refresh token.
Nothing wrote over it any more, so **`put` removes the runs of its endpoint that are over, after it
writes.** The snapshot it measures against is taken after its own write. A refresh that lost the race
therefore sees the epoch the logout minted, and removes its own key.

FRU-64 said a removal from a read is the defect this batch is about. A write from a read puts back a
value the read took before something changed. This removal takes away a run that its snapshot already
shows as over, and two facts make that safe:

- **An epoch never comes back.** Each one is minted fresh, so a run that is over in one snapshot is
  over in every later one, and no reader answers with it.
- **A run written after the snapshot is not in it.** The removal names keys, and a pairing made since
  has a key the snapshot does not hold.

A logout's `drop` removes every run of the endpoint. The upgrade removes nothing but the keys it moves,
so an entry it writes back to a run that is over stays until the next write for that endpoint.

### A refused refresh ends only what it spent

Found by looking for the other half of the ticket. A refresh that answers `401` called `forget`, which
mints an epoch. The logout that revoked its token is usually the reason for that `401`, and a pairing
made after the logout was then ended by the epoch, as surely as by the write the ticket names.

`endSpent` mints nothing. `SessionArea.end` removes the run the refresh read, and only while that run
still holds the token it spent: a rotation in the other context writes the same run with a new token,
and that session is not the one the worker refused. The grant goes unless it belongs to a session
storage still holds. A mint here would refuse a later write from a refresh of the same chain, and the
worker has already refused that chain, so whatever such a write holds answers `401` on the next
refresh.

### The upgrade

`upgradeSessions` runs the FRU-63 split, then `moveToRunKeys`: each `fruitback:session:<endpoint>`
entry moves to the run its own epoch names, the writes land before the removals, and a run that
already has its key is left alone. The window it leaves is the one `migrationOf` states, on the first
run after the upgrade only. A pairing made inside the FRU-63 window is kept now as well, because the
entry the split writes back names the run with no epoch:
test:`keeps a pairing made while an upgrade in flight writes back`.

### What the tests reach

The three windows are driven with two `Sessions` over one storage: a refresh that writes, a refresh the
worker refuses, and an upgrade that writes back. Twelve mutants each fail a test: an epoch left out of
the key, a `401` that mints an epoch, an `end` that ignores the token, a `put` that removes nothing or
removes against its own epoch, a `drop` that keeps other runs, a move that overwrites a run or removes
before it writes, no second upgrade, a grant always or never dropped, and a key epoch left unchecked.
The first of them stops the helper that holds a write open, so its tests fail on the timeout of the
test rather than on an assertion.

## The options page, and what a wildcard covers (FRU-43)

### The rules, in short

Three modes: **public** (the site embeds the widget, everyone sees the pins), **private** (the site
embeds nothing and the extension injects the widget) and **team** (the site embeds a dormant widget
the extension activates and relays for). Private is FRU-41, team is FRU-57, and FRU-46 is where
they were named for a reader — [docs/modes.md](../modes.md) and
[docs/reviewing.md](../reviewing.md). Which one an origin is in is one field on its entry, and **an
entry with no `mode` reads as private** — that is every entry a reviewer's browser already holds.

- **An entry's key is a pattern, and `resolveSite` is the only lookup** (FRU-43). A key is an exact
  origin or `https://*.host`; every key written before is an exact origin, so nothing is upgraded. The
  exact origin wins, then the longest wildcard. The bridge and the relay reach it through `readSite`,
  and the popup through `findSite`, which is the same lookup and also answers the pattern the entry is
  stored under — the popup names that pattern on screen. `sites-storage.test.ts` proves `readSite`
  resolves a wildcard. A reader that indexed the map by origin would mount the widget and then have
  the relay refuse its calls.
- **A wildcard covers the default port only**, and its base host too, as a match pattern does. The
  grant and the registration (`https://*.host/*`) cover every port; the pattern carries no port because
  whether each browser accepts one was not measured, and one refused pattern stops every site. It needs
  a base of at least two labels and no IP address: every pattern is registered in one call, so a pattern
  that the browser refuses would stop the scripts on every site. If a browser registers the scripts on
  another port, the bridge unmounts there. The opposite error shows a site as on where nothing runs.
- **Only the background writes the sites map.** The popup and the options page send the change as a
  runtime message; `createSiteOwner` applies one at a time, because each change reads the whole map and
  replaces it, and the two pages share no lock. `isExtensionPage` refuses the message from a content
  script, whose URL is the page's. One key per pattern was not taken: a reader would have to list the
  whole `local` area, and the bridge, a content script, must not read the refresh token stored there.
- **A write the background did not confirm can still be stored** (FRU-73), because only the answer
  was lost. `activateStored` reads it back and injects the scripts into the tabs already open on the
  patterns of that change that are stored switched on. Without it the rule is On and those tabs hold
  no widget until their next load. **A client id made of spaces is an absent id**: `complaint` refuses
  it and `siteFrom` stores the id trimmed, so a rules file cannot store one that the worker then
  answers `client-required` for.
- **A rules file holds no credential and no grant.** An imported entry runs nowhere until the options
  page's **Grant access** is pressed, and `permissions.onAdded` is what re-syncs the registration,
  because a grant writes no storage. The worker's `origins` stays an exact list, but it applies to
  private mode only: the relay calls from the extension origin, which the worker exempts.
- **A wildcard in team mode covers nothing** (FRU-75). `https://*.vercel.app` is a valid pattern, and
  in team mode it would lend the reviewer's session to the sites of other people. `lendsSession` is
  the one predicate: `resolveSite` skips such an entry, so the bridge, the relay and the popup all
  refuse it, `complaint` takes the pattern and refuses it in the form and in the import, and the
  background does not register it. A wildcard stays valid in private mode, which carries no token.
- **A site asked for is remembered before the browser asks for access** (FRU-118). The permission
  prompt can close the popup, and the code after `permissions.request` then never runs: the grant
  exists and no entry does. `pending-site.ts` writes the intent first, **not awaited** (an await loses
  the gesture). The background finishes it on `permissions.onAdded`, and the popup when it opens
  again. A refused prompt leaves it as a draft, and the form shows the values again (FRU-117). It is
  ten minutes old at most: an old intent must not turn a site on by surprise. Automation cannot answer
  a prompt, so the E2E copy never met this: the wiring is asserted on the sources.
- **A site of the reviewer's workspace is turned on in one click** (FRU-101). The popup asks
  `GET /session/sites` of each session it holds and offers a tab whose origin is listed. The entry is
  team mode with a `mount` field: the extension mounts the widget, `relay: true` on the bridge, and the
  page's widget calls through the relay. **`mount` is a field of its own**, never a client id beside the
  mode: a stray client id on a team entry was always dropped. `mount.workspace` is for the popup only:
  a `label` would replace the text of the launch button (measured).
- **The rules stay in `chrome.storage.local`.** The ticket asked for `sync`; a host permission does
  not travel with a synced rule, and moving the key is a storage-shape change. That is FRU-72.

### The reasons, and the history

The popup edits the entry for its own tab. The options page lists every entry, adds one for a pattern,
grants access, and reads and writes a rules file.

### A pattern as the key, not a second store

An entry's key was an exact origin. It is now a pattern: that origin, or `https://*.host`. The other
design was a second store of rules that resolve _to_ an entry. It was not taken, because two stores
answer one question and a reader has to ask both in the right order. With one store, every key written
before FRU-43 is already a valid pattern, so there is no upgrade and `parseSite` does not change.

`resolveSite` is the one lookup. The exact origin wins, then the longest wildcard, so one preview can
be switched off or sent to another client under a rule for all of them. The bridge and the relay call
it through `readSite`, and the popup through `findSite`: the same lookup, with the pattern the entry
is stored under, which is what the popup's **Rule:** line names. `site-patterns.test.ts` covers the resolver, and
`sites-storage.test.ts` covers `readSite` over a storage area, because a reader that indexed the map
by origin passes every resolver test.

### What a wildcard covers

`*.staging.acme.dev` covers `staging.acme.dev` too, and so does the match pattern that the background
registers. A wildcard takes no port and covers the default one. How each browser matches a port
in a match pattern was not measured here, and the two ways to be wrong are not equal: if the scripts run on
another port, the resolver answers nothing and the bridge unmounts; if the resolver covered a port the
scripts do not run on, the popup would say **On** over a page with no widget. A bare `*` is refused,
because it is the permission for every site that FRU-41 refused to ask for at install.

The grant and the registration are wider than the resolver. `https://*.staging.acme.dev/*` names no
port, and a match pattern with no port covers every port, so the browser grants access to, and runs
the scripts on, `pr-12.staging.acme.dev:8443` too; the bridge then unmounts there. Putting `:443` in the
pattern would narrow the grant to what the resolver covers. It was not done, because whether each
browser accepts a port in a match pattern was not measured, and the background registers every
pattern in one call: one pattern the browser refuses stops the scripts on every site. Raised in review.

A wildcard on a single label (`*.localhost`, or `*.localhost.` with its root dot) or an IP address is
refused too. `syncRegistration` sends
every pattern in one `registerContentScripts` call, so one pattern the browser refuses stops the
scripts on every site, and the error is only logged. Which of these a browser refuses was not measured,
so the conservative answer is to never store them.

### One writer for the map

The popup and the options page both change the map, and a change reads the whole map and then replaces
it. They share no lock, so two changes close together could each drop the other's entry, or bring a
removed rule back. Raised in review by two reviewers. Both pages now send the change to the background
as a runtime message, and `createSiteOwner` applies one change at a time; `sites-storage.test.ts`
sends three at once and keeps all three. A change the background did not store rejects in the page.

The other fix, one storage key per pattern, was not taken. A key per pattern leaves no single key to
read, so a reader lists the whole `local` area with `get(null)`. The bridge is a reader, and it runs in
a content script; the refresh token is in `local` (FRU-60), and a content script must not read it.

A content script can send a runtime message too, and its input is written by the page. So the
background checks the sender's URL against the extension's own root (`isExtensionPage`): a page must
not be able to add a rule for itself.

**A rejected write can still be stored** (FRU-73). Only the answer is lost, and the page then said the
change was not confirmed and skipped the activation of the tabs already open on the rule. The rule was
On in storage and those tabs held no widget until their next load, with nothing to say why.
`activateStored` reads storage back and activates the patterns of the change that are there and
switched on — the patterns of that change only, never every rule the map holds, because the other tabs
already run. The words on the screen do not change: the write is still unconfirmed, and the list is
what says what is stored. A storage read that fails leaves the tabs as they are.

**An id made of spaces is an absent id.** `complaint` compared the client id with the empty string, and
a file could carry `"   "`. The entry was stored and shown as On, and a worker with several clients
answered `client-required` on every call it made: authorised in the extension, refused on the wire.
Both editors trim the field, so the rule is now in `complaint` and in `siteFrom`, where the import
reaches it too.

### The grant, which nothing else carries

Adding a rule asks for its pattern first, and awaits nothing before the request, the same rule as the
popup's `turnOn`. The duplicate check reads the list the page already holds rather than storage, for
the same reason. A rules file holds patterns, modes, endpoints and client ids, and no session and no
grant. So an imported entry shows **No access in this browser** until **Grant access** is pressed.
A grant writes no storage, so the background listens to `permissions.onAdded` as well as `onRemoved`.
A registration reaches only the next page load, so a rule added, switched on or granted on the options
page is also injected into the tabs already open on it (`injectIntoOpenTabs`), as the popup does for
its own tab. Raised in review.
Without it, an imported rule granted from the options page stays unregistered until the browser
restarts.

### The access goes back when nothing uses it (FRU-115)

« Turn off » unregistered the two scripts and kept the host permission. Nothing ran on the site, but
the browser went on saying that Fruitback can read it, and the store listing could not write that the
access is removed. A rule that is switched off, removed, or moved to another worker now gives its
access back with `permissions.remove`. The cost is the one the ticket accepts: to switch the same site
on again, the browser asks again.

- **The background does it, after it stores the change.** It is the only writer of the map, so the
  popup, the options page and an import all pass there. `createSiteOwner` hands it the map of before
  the change, and the next change waits for it. A change answers when it is stored: an access that
  could not be given back is reported in the console and does not make the change wrong.
- **What is in use is in `accessInUse`** (`access-return.ts`): the pattern of each rule that is on,
  the origin of the worker of each rule that is on, and the origin of each worker this browser holds a
  session with. So the access to a worker goes with its last site, and not while a session needs it
  for its refresh and its log out. A log out then gives it back, from the popup, if no site that is on
  uses that worker.
- **A wildcard that covers something still in use stays.** The browser can hold the wildcard only,
  and to give it back would stop a site that is on. The test is the rule of a match pattern, every
  port included, and not `coversOrigin`. The other way round costs nothing: an exact site that is
  switched off under a wildcard that stays on gives back its own grant, and the wildcard still covers
  it in the browser. Nothing runs there, because the exact rule wins in `resolveSite`.
- **Only the accesses of the rule that changed are candidates, never everything the browser holds.**
  A sweep of the granted origins would take back the access a prompt has just granted, before the
  popup stores its site (FRU-118), and the one a pairing has just asked for, before its session is
  stored.
- **An update gives back the access of the rules that were already off**, once, on `onInstalled`.
- **The options page does not call it a problem.** A rule that is off reads `No access while it is
off`, with no **Grant access**: **Turn on** asks.

**Not verified in a browser.** A prompt for an optional host permission cannot be answered by
automation, so the E2E copy of the extension holds its hosts in the manifest, and a browser refuses to
remove a permission the manifest requires. `permissions.remove` is therefore reached through a seam
under `node --test`, one access at a time so that such a refusal keeps nothing else. What Chromium and
Firefox do with the real call on an optional grant was not measured.

### What was left out

The ticket asks for `chrome.storage.sync`. A host permission does not travel with a synced rule, so a
second browser would show the rule and run nothing; and moving the rules out of `local` is the kind of
storage change FRU-63 needed an ordered upgrade for. It is FRU-72.

No browser ran on this machine when this shipped: the page, the grant prompt for a wildcard and the
download were built and type-checked, not seen. Since FRU-45, `e2e/extension.spec.ts` drives this page
in a real Chromium and adds its rules through it. The prompt and the download are still not exercised:
automation cannot answer the prompt, and the fixture declares its hosts instead.

### Private mode on a worker that wants a session (FRU-66)

A private-mode widget calls the worker from the page, with no credential. On a worker that reads
`authenticated` each read answers `401`, and the widget leaves the page as it is, which is the rule
for a `401` (FRU-40). The reviewer saw a page with no pins and no reason.

**Taken: say so, in the popup.** `read-probe.ts` asks the read the widget asks, for the tab and the
client of the rule, and the popup writes one line on a `401`. Only a `401` is a statement: a worker
that is down, slow or rate-limited gets no line, because the popup did not measure why. The popup
does not wait for the answer, so the switch never sits behind a slow worker.

**Not taken: carry a session in private mode.** Mounting the private-mode widget on the relay would
let a paired reviewer read an `authenticated` worker. The relay checks the endpoint the page
declares against the stored one, and in private mode the page declares nothing, so that check would
have to be designed again rather than reused. Nobody has asked for it. Open it again when somebody
needs a private-mode client on a worker that holds sessions, and not before.

**Measured, because the test cannot see it.** The E2E copy of the extension holds a host permission
on both workers, so its `fetch` skips CORS. The shipped extension holds none in private mode. From a
page of the unmodified build, with `permissions.contains` answering `false` for the worker, a `fetch`
of `/feedback` on an `authenticated` worker reads `status: 401` (Chromium 1234): the worker puts its
CORS headers on the refusal for an extension origin.

## The team mode, and the call the page cannot make (FRU-57)

### The rules, in short

- **The main world announces instead of mounting.** `page.content.ts` puts
  `window.fruitbackExtension = { version, transport }` on the page and fires `fruitback:extension`.
  Two ways to find it because nothing orders a content script against a site's own bundle.
- **Installing the API is idempotent, which is what makes the event safe to mount on.** The global is
  set and the event fired only when the global is not already ours, so a re-posted decision announces
  nothing. **Withdrawal is the same event with the global gone** — nothing here can destroy a widget
  the site owns, so a site switched off would otherwise keep stale pins and a composer that fails
  silently.
- **`clientId` and the widget's endpoint come from the site.** The stored entry carries an endpoint
  anyway, and it is not what the widget is pointed at: it is what the relay checks the page's
  declaration against.
- **The relay is the mode.** Without it this is decluttering: a page can forge the presence signal,
  and `curl` still reads a worker left at `read: 'public'`. It has security value **only** on
  `read: 'authenticated'` (FRU-40, which is built). Do not describe the mode as a guarantee
  without naming that setting.
- **Every decision the relay makes is in the background, and `src/relay.ts` holds all of them.** A
  content script's own input is written by the page, so the isolated world carries the request
  across and decides nothing. The origin comes from `sender`, never from the message; the endpoint
  from storage; the credential from the session.
- **A page that names another worker is refused, never redirected.** A reviewer holds a session per
  worker, so a page free to choose the endpoint could be answered with their credential for a
  worker nobody on that page chose. Relaying to the stored endpoint instead would be worse: the
  widget would report success against a worker it never named.
- **No session, no call, and no plain `http://` either.** Relaying without the header would work on a
  `read: 'public'` worker, and a reviewer would never learn they are unpaired while the mode
  delivered none of what it promises. The endpoint must be https or loopback, because the token is a
  bearer credential and this is the only thing carrying it; the popup refuses a team entry and
  disables pairing on the same rule. **`isWorkerEndpoint` is not tightened** — it gates the private
  mode's mount, which carries no credential.
- **`Authorization` is built in the background and `Content-Type` is the only header the page may
  name.** `ALLOWED_HEADERS` in `protocol.ts` is an allowlist of one, and `relay.ts` writes the
  credential name by name rather than spreading — two spellings of one header reach `fetch` as a
  combined value.
- **One path, `/feedback`.** `relay.test.ts` reads `packages/widget/src/embed.ts` and asserts the
  widget calls that path and names no header the relay would drop, so a call the widget grows later
  fails the suite instead of being dropped silently on a reviewer's page.
- **Two deadlines, and the shorter one aborts.** The composer disables its send button in flight, so
  a promise that never settles leaves a reviewer with a dead button and a written note inside it.
  `RELAY_CALL_TIMEOUT_MS` aborts the background fetch — merely giving up would leave the request in
  flight while the page is told it failed, and a second send plants the note twice.
  `RELAY_ANSWER_TIMEOUT_MS` is longer, so a slow worker is a refusal the background sends rather than
  a timeout the page invents. **`createRelay` never rejects**, because a rejection leaves the
  background with nothing to answer the runtime message with.
- **`relay-transport.ts` exists so `node --test` can reach the correlation**: the widget reads and
  writes independently, so two calls are in flight in the ordinary case. Its ids come from
  `randomId`, not `crypto.randomUUID` — that one needs a **secure context** and this script runs on
  `http://` staging too. `capture.ts` already carried the same fallback for the seed id, and the trap
  was walked back into here.
- **An extension origin is exempt from `ALLOWED_ORIGINS` on every route, by scheme.** The relay
  calls `/feedback` from the service worker, which sends `chrome-extension://<id>`. See
  [worker.md](worker.md).

### The reasons, and the history

Private mode injects a widget into a site that ships none. Team mode is for the team that ships its
own: the widget is in their build, dormant, and it wakes up for a reviewer carrying the extension.
FRU-56 had already put the seam in — `init({ transport })` — and this fills it.

### The page speaks last, and it is told so

`page.content.ts` was written to mount. In team mode it announces instead: it puts
`window.fruitbackExtension = { version, transport }` on the page and fires `fruitback:extension`.
Two ways to find one thing, because **nothing orders a content script against a site's own bundle**
— the property serves a page that looked after the announcement, the event one that looked before.

Which of the two behaviours the main world takes is decided in the isolated world, where the entry
is readable, and travels as one more message kind on the existing channel. That was deliberate: the
generation token and the unchanged-decision guard in `bridge.ts` already exist and already cost a
review round each, and a mode flag read in the main world would have needed both again. The main
world has no `chrome.*` to read a flag with, either.

**Installing the API is what is idempotent, and that is what makes the event safe to mount on.** The
main world sets the global and fires the event only when the global is not already its own, so
re-posting the same decision installs nothing and fires nothing. A site can therefore mount on every
event it receives without ever getting a second widget — which is what the snippet in
`docs/install.md` does. Two guards, one behind the other: `createApply` does not re-post an
unchanged decision, and this does not re-announce one that is already in place.

Withdrawal travels on the **same** event, with the global gone. Nothing here can destroy a widget
the site owns, so a reviewer who switches the site off — or to private mode — would otherwise leave
it on screen with a transport every call is now refused for: stale pins, and a composer that fails
without saying why. The site reads the property rather than assuming an arrival, and destroys its
own.

### The endpoint check, and the ticket bullet it contradicts

The ticket says `clientId` and `endpoint` come from the site, never from the popup. The client id
does. The endpoint cannot, and the entry keeps one.

A reviewer holds a session **per worker**. If the relay sent the call wherever the page asked, a page
on any origin the reviewer enabled could name a _different_ worker they had paired with, and be
answered with their credential for it — notes posted into another team's tracker as them, and that
team's pins read back. The endpoint the reviewer stored for that origin is the only value in this
system that the page did not write, so it is what the declaration is checked against.

**Refused, not redirected.** Sending the call to the stored endpoint when the page named another
would make the widget report success against a worker nobody on that page chose. A failed call is a
state the widget already handles correctly; a lie is not.

The cost is that team mode needs a popup entry, like private mode. That is smaller than it reads: a
reviewer already has to enable the origin and grant it, or no content script runs there at all.

### Everything else the relay refuses

The decision lives in `src/relay.ts`, in the background, because **a content script's own input is
written by the page**. The isolated world carries the request across and decides nothing.

- The **origin** comes from the `sender` the browser reports. `sender.origin` is Chrome's and
  `sender.url` is Firefox's; a sender with neither is refused.
- The **path** is `/feedback`, an allowlist of one. A route the widget grows later is refused here
  until somebody adds it, rather than the relay becoming a way to reach anything on that worker.
- The **headers** are rebuilt name by name. `Content-Type` may come from the page and nothing else
  may, and `Authorization` is written from the session. Spreading the page's map instead would let
  two spellings of one header reach `fetch`, which appends rather than replaces — `a, b`.
- **No session, no call.** This one is a decision rather than a limitation: relaying without the
  header works perfectly on a worker left at `read: 'public'`, so the pins appear, everything looks
  right, and the reviewer never learns they are unpaired while the mode delivers none of what it
  promises. The popup says so at the only moment anybody looks.
- **The endpoint is on https, or there is no call.** The token is a bearer credential and this is the
  only thing carrying it. Loopback is excepted because it is the dev loop and is not on a wire. The
  popup refuses the same thing earlier and louder — a team entry on plain http cannot be stored, and
  pairing is disabled on any insecure endpoint, because pairing is handed a refresh token worth
  thirty days. The rule itself is in `session.ts`, where `pair`, `refresh` and the revoke all ask
  it: a warning on a screen is not a rule, and a session stored before the rule existed would
  otherwise keep spending its token in the clear. `isWorkerEndpoint` is deliberately **not** tightened: it gates the private mode's
  mount, which carries no credential, and an http staging worker that works today has nothing to
  leak. Raised in review.

### What had to change on the worker, and what it gives away

None of this worked at first, and nothing in the extension would have shown why: both of the
worker's origin gates answer `403` to `chrome-extension://<id>`, which is what an MV3 service worker
sends on a POST. FRU-42 had already measured that and exempted the three `/session/` routes; the
relay calls `/feedback` the same way.

So the exemption is now by **scheme**, in one predicate `resolveCors` and `resolveClient` both ask.
A list of schemes rather than "anything that is not http", so `null`, `file://` and whatever a
browser adds next fall through to the allowlist where they belong.

What it gives away is what a caller with no `Origin` already has — `curl` is served today, and
`SECURITY.md` has always said so at length. CORS was never what decides who may read a pin. The
test that asserted the old property was rewritten rather than deleted: it now says the allowlist
still governs sites, and admits the extension.

### The timeout nobody would have noticed

The transport returns a promise, and the composer disables its send button while a submit is in
flight. A relay nobody answers therefore leaves a reviewer looking at a dead button with a written
note inside it — and losing a written note is the one failure this widget cannot afford.

There are **two** deadlines, and the shorter one is the background's. It aborts the call rather than
merely giving up on it: a worker that accepts a connection and never answers would otherwise leave
the request in flight while the page is told it failed, and a reviewer told their note failed presses
send again — which plants it twice. The page's deadline is the longer one, so the ordinary slow
worker becomes a refusal the background sends rather than a timeout the page invents; what is left
for it to catch is a service worker stopped mid-call. `createRelay` never rejects for the same
reason: storage and the session both do I/O, and a rejection would leave the background with nothing
to answer with. All three were raised in review.

`relay-transport.ts` exists so `node --test` can reach that, and the correlation around it: the
widget reads and writes independently, so two calls are in flight in the ordinary case, and a single
pending slot passes every in-order test and fails the reversed one. The three tests that matter are
an answer for another id settling nobody, an answer after the timeout settling nobody, and two calls
at once getting their own.

### What is not verified here

The same limit FRU-60 has: no browser runs on this machine. The worker's side of the origin change
is exercised through `handleRequest`, and the relay's gates through their seams, but the announcement
reaching a real page's `window` and a real `sender.origin` are FRU-45's to prove.

### The two halves nobody raised

Both of the review's findings had a twin in the session code, and the twins were worse.

`postJson` had no deadline while the relay's fetch gained one. That mattered more here than there:
the storage queue chained one promise onto the last, so a worker that accepted a connection and never
answered wedged **every later refresh for every worker** — not only its own, and not only until the
next alarm. It is now bounded the same way. FRU-63 removed that queue, so the hang is back to the
one endpoint whose in-flight promise `refreshOnce` holds — still worth the deadline, no longer worth
every worker.

The https rule was raised about the relay's access token, which is the smaller half. Pairing spends
a code for a refresh token worth thirty days and every renewal spends that token again, all over the
same endpoint. So the rule is in `session.ts` rather than only in the popup: a warning on a screen is
not a rule, and a session already stored would otherwise have gone on leaking.

Both were found by asking what else the accepted fix should have touched, before pushing it.
