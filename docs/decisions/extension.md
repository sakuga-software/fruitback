# The extension, and the two worlds

**This describes the private mode**, where the client's site embeds nothing and the extension
injects the widget. SKG-539 since named three modes — public, private and équipe — and the team mode
turns the extension into a relay rather than an injector. Nothing below was rewritten for that; it
is the private mode as SKG-534 built it.

## The extension, and the two worlds

- **The client's site embeds nothing** (SKG-534). No tag, no npm package, no deployment — which is
  also the end of the integration friction: today, getting a page reviewed needs a deploy. Ordinary
  visitors see nothing because there is nothing in their page to see.
- **`world: 'MAIN'` is the ticket, not a preference, and it was measured before it was written.** A
  content script in the isolated world shares the DOM and **not** the properties page scripts put on
  it. Probed in Chromium on the playground, on the same `<button>`:

  | | isolated | main |
  | --- | --- | --- |
  | `__reactFiber$` | absent | present |
  | `__reactProps$` | absent | present |
  | `__REACT_DEVTOOLS_GLOBAL_HOOK__` | `undefined` | `object` |
  | own properties | **0** | 2 |

- **Both halves of `source` are blind from the isolated world, not one.** `readReactSource` finds the
  fiber under `__reactFiber$…`; react-grab scans `__reactContainer$` / `__reactInternalInstance$` and
  installs *itself* as `globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__`, which in the isolated world is a
  global React never reads. So the widget would mount, work, and quietly never say which component a
  note is about — the worst shape of failure, because nothing errors.
- **Registered as a content script rather than injected as a `<script>` tag.** A tag pointing at an
  extension URL is evaluated in the page and **the page's CSP can refuse it**. A main-world content
  script — whether it is declared in the manifest or registered through `scripting` — is not subject
  to it. That is the CSP trap the ticket names, avoided rather than worked around. This paragraph
  said *declared in the manifest* until review pointed at it: true of the first draft, and false from
  the moment the manifest stopped declaring anything.
- **`packages/widget` is unchanged by this app, which is the ticket's own test.** The widget runs
  where it always ran — in the page — so the extension is a fourth assembler beside `global.ts` and
  nothing extension-shaped leaks into the widget. `createCaptureHost` does take an `engine` seam that
  would have allowed a narrower bridge; it was not needed, and not using it is what keeps this app
  off SKG-530's branch.
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
  a *malformed* message; it cannot refuse a **well-formed** one the page wrote, because the two are
  identical. A page can post its own `mount` and point the widget at its own worker, or post
  `unmount` and take it away. The first version of this paragraph claimed the parse defended against
  that. It does not, and claiming it was worse than the gap.
- **That is inherent to the main world, not a flaw in the bridge, and no handoff closes it.** The
  main world *is* the page's realm: a hostile page can patch `fetch`, `JSON.stringify` or the
  widget's own methods however the config arrived, and a nonce would have to travel on the channel
  the page reads. So it is stated rather than defended — **a reviewer grants an origin precisely
  because they trust that origin's code**, and the extension runs on no other. What is reduced is
  what is at stake: nothing secret travels there, the endpoint and client id are already in the
  client's own DOM in tag mode, and an identity token is **not sent at all**. SKG-535 keeps the token
  in the isolated world behind a relay, which is what has to keep being true.
- **`registerContentScripts` reaches the *next* page load, never the open one.** So the popup injects
  both files into the current tab after the grant, or the reviewer switches a site on and looks at a
  page with no dock while the popup says it is on. The browser run that first *proved* the no-reload
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
  reads `fruitback:config` from the page's `localStorage` and lets it *override* what `init` was
  passed — correct for one widget, wrong the moment there are two. A site that embeds the widget,
  opened by a reviewer whose extension mounts its own, shares that key: one instance silently takes
  the other's `endpoint` and `clientId`, and the notes go to a worker nobody chose. The seam is not
  extension-shaped — any second instance needs it — which is why it passes the ticket's own test.
- **A second key was half the answer, and the half that was missing is the page can write *ours*.**
  The store restores its key from the page's own `localStorage`, so a page that wrote
  `fruitback:config:extension` before the widget mounted chose where the notes went. The same gap
  faces the other way with nobody hostile at all: a stored `endpoint` beats the new default for ever,
  so changing it in the popup would never take effect on a site the reporter had already set a
  preference on. `createConfigStore({ pinned })` is the fix — `endpoint` and `clientId` are the
  caller's word and are not restorable — and a mount that names its own key pins them. Raised in
  review, mutation-tested.
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
- **A site that embeds the widget *and* a reviewer who has the extension get two docks.** Measured on
  the playground, which mounts its own: switching the extension on took the host count from 1 to 2.
  Harmless, visibly silly, and not solved here — the extension cannot tell its own host from theirs
  without the widget advertising itself, which is a widget change.
- Verified in a real Chromium against the playground: switching the site on mounts a second host
  **with no reload**, the fiber owner chain reads `SiteHeader < Pricing < …` from the page world, and
  switching it off destroys it live. The permission prompt itself is a native dialog no automation
  can drive, which is why that path is unit-tested and the browser run uses a build with the scripts
  declared statically.


## The session, and the token that never goes down (SKG-599)

SKG-535 built the worker half — pairing codes, access and refresh tokens, revocation, three routes
exempt from the origin allowlist. This is the other half, and it carries the constraint that shaped
both: an access token the host site's JavaScript can read is the worst outcome of this batch.

- **Two storage areas, and the split is the decision.** The refresh token goes in
  `chrome.storage.local`, which survives the browser closing; the access token goes in
  `chrome.storage.session`, which does not. Both in `session` would look tidier and be worse: a
  reviewer who pairs again every morning keeps their pairing code in a text file, which is a worse
  place than the one the split was protecting. SKG-535's "when the lifetime suits it" is what allows
  this.
- **Nothing calls `setAccessLevel` on the session area, on purpose.** Its default excludes content
  scripts, which is exactly the boundary this ticket holds. Widening it to
  `TRUSTED_AND_UNTRUSTED_CONTEXTS` so the isolated script could read the token directly would put the
  token one `postMessage` mistake away from the page — the isolated script asks the background to
  make the call instead, which is the same seam SKG-596's relay needs. What *does* hold a token is
  every trusted context: the background refreshes and the popup pairs and logs out, which is what
  `TRUSTED_CONTEXTS` means and what the documentation now says. Raised in review, where the first
  wording claimed the background was the only one.
- **Pairing asks for a host permission on the worker's origin, and that is a hedge rather than a
  proof.** `turnOn` only ever requested the *site*; a worker normally lives somewhere else entirely,
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
    being *entered* instead, then mutated — and removing the guard now fails both cases.
- **The guard is an allowlist, not a denylist** (`src/worlds.test.ts`). Naming the files that must
  stay clean passes a main-world entrypoint added next year. So the entrypoints are *discovered* —
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
- **A busy worker is not a bad code.** A `429` or a `502` on `/session/pair` answers `unavailable`
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
- **Rotation is half-built on purpose.** A rotated refresh token is stored when one arrives, and none
  ever does: the worker does not rotate. A rotation whose response is lost leaves this side holding a
  token the worker has already retired, with nothing to retry — closing that needs a replay window on
  the worker, which is SKG-600.
- Verified over the real transport rather than against the handler, which is this repo's recurring
  defect (SKG-518): a real `OPTIONS` preflight from `chrome-extension://…` for
  `Content-Type: application/json`, then pair → refresh → revoke → refresh, answering
  `204 / 200 / 200 / 204 / 401`. What is **not** verified here is `chrome.storage` itself and the
  real world boundary — that is SKG-538, and no browser runs on this machine.

## The team mode, and the call the page cannot make (SKG-596)

Private mode injects a widget into a site that ships none. Team mode is for the team that ships its
own: the widget is in their build, dormant, and it wakes up for a reviewer carrying the extension.
SKG-595 had already put the seam in — `init({ transport })` — and this fills it.

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

The announcement is idempotent — the site mounts its widget when the event fires, so a second event
hands it a second widget. A re-posted decision therefore changes nothing, which is the same rule the
mount has for the same reason.

### The endpoint check, and the ticket bullet it contradicts

The ticket says `clientId` and `endpoint` come from the site, never from the popup. The client id
does. The endpoint cannot, and the entry keeps one.

A reviewer holds a session **per worker**. If the relay sent the call wherever the page asked, a page
on any origin the reviewer enabled could name a *different* worker they had paired with, and be
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

### What had to change on the worker, and what it gives away

None of this worked at first, and nothing in the extension would have shown why: both of the
worker's origin gates answer `403` to `chrome-extension://<id>`, which is what an MV3 service worker
sends on a POST. SKG-535 had already measured that and exempted the three `/session/` routes; the
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

`relay-transport.ts` exists so `node --test` can reach that, and the correlation around it: the
widget reads and writes independently, so two calls are in flight in the ordinary case, and a single
pending slot passes every in-order test and fails the reversed one. The three tests that matter are
an answer for another id settling nobody, an answer after the timeout settling nobody, and two calls
at once getting their own.

### What is not verified here

The same limit SKG-599 has: no browser runs on this machine. The worker's side of the origin change
is exercised through `handleRequest`, and the relay's gates through their seams, but the announcement
reaching a real page's `window` and a real `sender.origin` are SKG-538's to prove.
