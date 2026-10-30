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
  line. A `401` that also says `canWrite: false` is a site whose notes are « Members only »
  (FRU-330): the popup says that private mode can send no note there, and how an admin opens the
  site (« Anyone on the page »). The probe was measured from an extension page with **no** host permission on the worker,
  because the E2E copy holds one and its fetch skips CORS. **A client keeps its own `read`** since
  FRU-95: a worker holding sessions can serve several clients, grouped in workspaces, so a
  private-mode client can stay `public` beside a team-mode one.
- **The popup offers pairing in team mode only** (FRU-88). A session changes nothing in private mode,
  and a form that does nothing reads as the fix for a page with no pins. A session the extension
  already holds with that worker stays on the screen with its log out: a credential is never hidden.
- **In the popup a button stays on one line, and two buttons never touch** (FRU-169). Buttons side by
  side go through `actions()` in `popup/main.ts`, which gives them 8 px and lets them go under each
  other. In a `.row` the words give way, not the button, and the buttons go under the words when the
  row is short: French is a third longer, and the popup starts at 280 px. One button may wrap, the
  one of a rule that covers many sites. `e2e/popup-layout.spec.ts` measures the five states at 280
  and 340 px, in both languages.
- **The popup and the options page speak English and French** (FRU-131). `i18n.ts` keys a sentence
  by its English text, like the console. **A constant keeps its English sentence, and `t` runs where
  the text goes on the screen**: `remedyFor` finds a problem by its English text, and the guide is
  checked against the English words of the popup. A problem translated before `showProblem` loses its
  button with nothing to see. `messages.test.ts` reads the two pages and fails on a word outside the
  catalog, on a sentence with no French and on a French entry no page shows.
- **The language is the account's, then the browser's.** `GET /session/sites` answers `locale`, and
  `rememberLanguage` keeps it under `language` in `chrome.storage.local`. It is a tag and no
  credential, so the bridge reads it and `mount` carries it to the widget. **A worker that does not
  answer changes nothing; no session left removes it.** When the account speaks another language than
  the one the popup opened in, the popup draws its screen again in it (FRU-319): the first popup after
  a change in the console spoke the language of before. It does not draw a form, a pairing link, or a
  screen with a field somebody is in or wrote in: a draw loses what somebody types, and the next popup
  shows it. A change of language builds the mounted widget again, like a change of worker.
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
- **The archives a store takes are built by `release-extension.yml`, on a published release `v*`** (FRU-77).
  `wxt zip` for Chrome, `wxt zip -b firefox` for Firefox — the second writes a **sources** archive
  beside it, which AMO asks for whenever the submitted file was built. The tag and
  `apps/extension/package.json` must name the same version, and the job fails when they do not: a
  store refuses an upload whose version is not higher than the last, so a tag that says something
  else publishes a number nobody chose. **The `package` job restores no cache.** A cache entry is
  writable by any run of the repository, and what this job builds is shipped — `zizmor` fails on the
  pair, and `ci.yml` keeps its cache because it ships nothing. **`publish` needs `ci`, a job that
  calls `ci.yml` on the tagged commit** (FRU-172): a tag can name any commit, and the archives of one
  that fails its tests must not reach a release. Those jobs restore the cache of `ci.yml`. They run
  on their own runners with `contents: read`, and nothing they build is in the archives.
  **The archives are under `.output`, and `upload-artifact` leaves out a hidden directory** unless
  `include-hidden-files` says otherwise. The first tag, `v0.1.0`, built both archives and uploaded
  none. `workflows.test.ts` fails on an upload through a dot directory that does not ask for it.
- **The Firefox manifest declares its data, and asks for Firefox 140** (FRU-333). AMO refuses a new
  extension without `browser_specific_settings.gecko.data_collection_permissions`: the first upload
  of `fruitback-0.2.0-firefox.zip` failed on it, and the add-on was never on AMO. The five
  categories are in `src/data-collection.ts`, each with what it covers, all `required`: the
  extension works with none of them missing, and asks for no optional permission later. Firefox
  shows the list itself from Firefox 140, so `strict_min_version` went from 128 to 140; below it, the
  extension would need a consent screen of its own (decision of Mathieu, 2026-10-20).
  `data-collection.test.ts` holds the list, written out. `addons-linter` on the build reports no
  error, and since FRU-389 one warning: the key `data_collection_permissions` is not known to Firefox
  for Android 140 (`KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`), a manifest matter left to a
  ticket of its own.
- **The validator of AMO finds no eval and no `innerHTML`** (FRU-389). It said both on 0.2.0 and
  0.3.0, and both were no defect: the probe of zod for `eval` (`Function("")`, in `background.js`,
  `page.js`, `bridge.js` and the side panel) and the template of the composer given to `innerHTML`.
  The build takes the `Function` constructor out of the two files of zod that name it
  (`src/no-eval.ts`, a plugin of Vite in `wxt.config.ts`): `allowsEval` answers `false`, which is
  what it answered under the CSP of Manifest V3, and zod parses as it does `jitless`. The composer is
  built with `createElement`. Measured with `addons-linter` on the Firefox build: 6 warnings before,
  1 after (the manifest one above). `e2e/amo-lint.spec.ts` runs the validator on the build of
  `pnpm e2e`, which builds the Firefox output too, and fails when either code comes back. No note
  for the reviewer is needed for them any more.
- **The job `submit` hands the archives of `package` to the Chrome Web Store and to AMO** (FRU-329),
  with `wxt submit`, which is `publish-browser-extension` at the version of the lockfile. It builds
  nothing: the stores get the files that the release holds. **It runs in the environment `stores`,
  and a person approves each run**: the keys of the stores are secrets of that environment, and a
  tag alone submits nothing. **It needs `ci`**, as `publish` does, and `workflows.test.ts` counts a
  job of an environment as a job that publishes. **Chrome uses the API v2 with a service account,
  and `STAGED_PUBLISH`**: the reviewed version waits for « Publish » in the dashboard. The variable
  `CHROME_PUBLISH_TYPE` = `DEFAULT_PUBLISH` publishes after the review. **Firefox goes to the
  `listed` channel**, with the archive of the sources. **A run on a branch, or on a tag that does not
  start with `v`, is a `--dry-run`**: it asks each store for a token with its keys, and uploads nothing. On a check, a
  store with no keys is left out with a warning. **On a tag, a store with no keys fails the job**,
  because a release that reached one store and not the other would pass in silence. The steps of a
  release, and the keys to make once, are in « Releasing the extension » at the end of this page.
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
- **The page world builds the widget again only for a mount that differs from the one on screen**
  (FRU-186). The `ready` handshake forces the bridge past its comparison, so when the page world
  had in fact received the first message, the same `mount` arrives twice. Before, the second one
  rebuilt the widget under an open composer: the CI flake of `extension.spec.ts` in private mode
  (the composer field « not visible » for 30 s, twice in a row on `e47f5b0`). A page that posts
  `ready` itself got the same effect. test:`private mode: the same decision posted again keeps the
  open composer and its note` fails without the check, 3 runs out of 3.
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

## One copy of Fruitback drives a page (FRU-397)

### The rules, in short

- **The bridge has a version, and it is in the channel**: `fruitback-extension/2`. The copies of
  0.1.0 to 0.3.0 speak on `fruitback-extension` (`LEGACY_CHANNEL`): a copy hears nothing of the other
  protocol. Measured on 2026-10-23 on a Chrome with the 0.3.0 of the store and a 0.1.0 unpacked: the
  0.1.0 page script held the page, obeyed the 0.3.0 bridge, mounted its site of a workspace with no
  relay, and read it from the page with no session (`401`).
- **Each message carries the tag of its copy** (`copy`). The page script draws it for this page and
  says it in `ready`, with a proof: `proofOf(address, tag)`, where `address` is the host of its copy
  (`chrome-extension://<id>/`), read from its own stack because the main world has no `chrome.*`. The
  bridge reads its own with `runtime.getURL('/')`, takes the tag whose proof it gives, and posts
  nothing before. When it starts it posts `hello`, and each page script says `ready` again. A `ready`
  with no proof (a browser whose stack names no file) is taken while no proven one came: that browser
  mounts as before. See `src/copy.ts`.
- **The guard says who holds the page.** `__fruitbackPageScript` stays `true`, which is what a copy of
  before steps aside on; `__fruitbackPageHolder` holds the tag, the proof and the version. A page
  script that finds the page held by another copy steps aside and says it in its `ready`
  (`heldBy`, with the version when the other wrote one). Held by a copy of before, there is no
  version to say.
- **A site of a workspace is never mounted with no relay by another copy**: only the page script of
  the copy that decided hears the `mount`. A page script of another protocol hears no message of this
  one, so it cannot take a `relay: true` for a private mount.
- **The popup says it**: « Another copy of Fruitback (0.4.0) runs on this page. Reload the page. If
  this stays, remove that copy in chrome://extensions. » (`about:addons` on Firefox). **Reload first**
  (heavy review of #533): a tab left open across an update of this extension keeps the page script
  of the version before, which sets the flag of before and nothing else, like a copy of before. A
  copy of before says no version, and the sentence then names « the version of before of this one »
  too. The bridge adds `otherCopy` to its answers to the
  popup. It learns it from the `ready` of its page script, from a `ready` whose proof is another
  copy's, or from any message on the channel of before; once paired with a page script that holds the
  page, it posts one `ready` on that channel, which a bridge of before answers with its decision.
  Nothing in this copy can stop the other one from mounting its own rules: removing it is the one
  thing that helps.
- `e2e/two-copies.spec.ts` loads an old copy (`e2e/fixtures/old-copy`, the guard and the channel of
  0.1.0) beside the built one, in both orders. Not verified on Firefox: the format of the stack of a
  main-world script there is read from the documentation of the stack, not measured.

## A pairing link is no worker (FRU-395)

### The rules, in short

- **The form of a rule refuses a worker whose path ends in `/pair`, or that carries a `#`**, in the
  popup and on the page of the extension (`complaint` in `site-form.ts`). Measured in production on
  2026-10-23: a rule of private mode kept `https://api.fruitback.com/pair`, a pairing link pasted where
  the worker goes, and every page read `/pair/feedback`, which answered `404`, with nothing on screen.
- **A whole link is offered as a pairing**: « Pair with this link » (remedy `pair`) opens « Workers
  and sessions » on the card of the worker before `/pair`, with the code filled in, as a link opened in
  a tab does (FRU-92). An address with no code says to give the address before `/pair`.
- **The popup says it for a rule already stored**: the probe of FRU-66 now runs in both modes, and a
  `404` says « The worker of this rule does not answer. Check its address in the options. ». A worker
  that is there answers its read, or refuses it: only an address with no route answers `404`.
- **A stored rule is not rewritten** (`…/pair` into `…`): it is said, not corrected in silence
  (the recommendation of the ticket).

## The look of the popup and of the options page (FRU-170)

### The rules, in short

- **The tokens are those of the widget** (FRU-292, FRU-334): the zinc greys of the console, the five
  statuses Mathieu chose on 2026-10-21, the shadows and the radii (`packages/widget/src/theme.ts`), and
  **the accent** since FRU-372: the red `#dd2c27` of the console and of the widget, `#b91c1c` under
  the pointer, white on it at 4.70:1. In the dark scheme it is the dark accent of the widget,
  `#ec6a65` under dark text: `#dd2c27` is 3.44:1 as a link on `#18181b`, under the 4.5:1 of text.
  Mathieu chose one accent everywhere on 2026-10-21, after the orange `#c2410c` of FRU-292.
- **The tokens of the screens to come are declared now**, so that a screen takes a value and never
  writes one: `--surface-warm`, `--line-row`, `--line-control`, `--line-soft`, `--ink`,
  `--on-ink-muted`, `--success-line`, the three of an alert, the three of « Ready to check »,
  `--selection`, `--tile-on`, `--shadow-popup`, `--shadow-panel`, `--radius-card` (12 px),
  `--radius-panel` (14 px), `--font-sans` and `--font-mono`.
- **The edge of a field is `--line-strong` (`#8a8a93`, 3.42:1), the field border of the console.**
  The lighter `#a1a1aa` is 2.56:1 on white, under the 3:1 a field needs. It stays as
  `--line-control`, the edge of a secondary button and of a key, whose label says what it is.
- **The muted text is `#6b6b74`**, the console's: 5.28:1 on white, 4.80:1 on the sunken surface.
- **A drop is written black on new, to do and in progress, white on done and closed, and has an
  edge** (FRU-334): `--on-stage-new`, `--on-stage-todo`, `--on-stage-progress` and
  `--stage-edge` are copies of the widget, and the edge, 3.42:1 on white, is what draws a light
  drop. The detached notes of the panel take `--unplaced`, a grey, where they took the brown of
  « closed ».
- **Less brown** (FRU-334): the creams of the mono block and of « Ready to check » are the raised
  grey, and the chosen row of the page is on the sunken surface under its bar of the accent. A
  problem keeps `#fff7ed`, the tint of the accent: it says a problem in the colour of the
  extension. If the extension takes the red of the console, it becomes a tint of that red. A stone
  grey or a brown written back in a stylesheet of the extension or in a module of the widget fails
  test:`holds no stone grey and no brown of FRU-292, in the extension or in the widget (FRU-334)`.
- **The dark scheme is derived**: the zinc scale of the widget, and an orange lighter than the
  accent under dark text (`#fb923c`, 7.83:1 with `#18181b` on it). The brown fills of a problem and
  of « Ready to check » are greys of the scale now, under a line and a title in the orange.
  Mathieu validates it on the captures of the PR.
- **`entrypoints/popup/style.css` holds the tokens, and the options page loads it first.** A
  stylesheet of an extension page cannot import the widget, so the values are copied.
  `src/design-tokens.test.ts` compares each shared one with the widget in both schemes, checks each
  accent against its own value, and measures each pair that the pages paint: 4.5:1 for text, 3:1
  for the edge of a field and a drawing. A grey that differs between the two surfaces fails it.
- **No rule of either stylesheet writes a colour**: it names a token. The one exception is the drop
  of the mark, in the accent of the light scheme. test:`writes no colour outside the tokens, but
  the drop of the mark`.
- **An action is a pill**, as on the boards (test:`draws an action as a pill`). A label that may take several lines (`button.long`)
  takes the corner of a field: a pill of two lines is a lozenge.
- **The drop of the mark is beside the name**, in the accent of the extension in both schemes, as
  the mock-up of 2026-10-20 draws it. It is a drawing of the stylesheet, not an
  element: a screen reader reads the name alone.

### The reasons, and who decided

The extension had a palette of its own: an orange accent (`#c2410c`, `#fb923c` in the dark scheme)
and rectangles of 6 px. Beside the console and the widget it read as another product, and the popup
is the picture of the store listings. The review of 2026-10-11 (FRU-151) asked the designer three
things. `design/README.md` already answers the first two: a screen with no board takes the language
of the boards, on the tokens of the widget. The third was open: **the options page follows the
popup** (one stylesheet, a white surface), and not the console (`#faf9f5` page, cards of 14 px). The
three were settled on 2026-10-12 by the orchestrator of the agents, to whom Mathieu handed the
current decisions, with the simplest answer that fits what exists. The layout of the options page
did not change: the fields of 760 px and the file input of the browser are as they were.

## The kit of the extension (FRU-293)

### The rules, in short

- **One source for the parts the popup, the side panel and the page share.** `src/kit.ts` builds
  them, with no `browser`, so `kit.test.ts` reads each on happy-dom; `src/kit.css` gives their
  measures on the tokens. The popup and the options page link `kit.css` after `popup/style.css`.
- **The parts, as the mock-up of 2026-10-20 draws them:** the head of a shell (52 px and its rule of 1 px, 53 in all, as the mock-up draws it; the drop and
  « Fruitback », the button of the account of 44 px), the main button (46 px; 56 px with the drop
  for the action of a site; 48 px in the panel), the second button (44 px), the text button
  (« Change », a target of 44 px), the switch (44 × 26, 36 × 22 in a table, 40 × 24 in the
  preferences), the tile and the line of a site, the drop of a status (a mark of 12 px, a pin of
  24 or 28 px with its number), the row of a list (52 px and a chevron), the `dl`, the alert, the
  keys of a shortcut and the segmented tabs.
- **Every control is a native `button` of type `button`**: Space and Enter press it, and it takes
  the focus ring. The tabs have the keyboard of a tab list: the chosen tab is the one stop, and the
  arrows, Home and End move and choose.
- **No rule of `kit.css` writes a colour.** test:`writes no colour in its sheet: each one is a token`.
- **A switch that is off is drawn in `--line-strong` (3.49:1), not in the lighter grey of the
  mock-up (1.48:1)**: its track is what says that the control is there (WCAG 1.4.11).
- **The current popup takes the kit** for its main and second buttons, its switch and the drops of
  the notes of the page. Its screens do not change: the four screens of the mock-up are FRU-297
  and FRU-298, which take the head and the other parts. `e2e/popup-layout.spec.ts` reads the
  measures of the kit on computed styles, in both schemes and in both languages.

## The popup in four screens (FRU-297)

### The rules, in short

- **The ten kinds that `decide` answers fall in the four screens of the mock-up of 2026-10-20**, or
  in the page of the extension: `SCREEN_OF` in `src/popup-state.ts`, a `Record` over the union, so a
  kind with no screen does not compile, and `popup-state.test.ts` holds the table of the ticket.
  1 · signed out (`signed-out`, `connecting`, `sign-in-problem`); 2 · a site not added (`offer`,
  `new-site`); 3 · a site on (`rule`); 4 · a problem (`no-access`, `unreachable`, `not-web`); the
  page (`form`, `pair-link`). Until the page has them (FRU-301, FRU-302), `form` and `pair-link`
  keep their screen of before, and the screens 2 and 3 are FRU-298.
- **The shell is 380 × 580 at least**, with the head of the kit. The button at the top right,
  **Account and settings**, shows the initial of the account, or the gear when nobody is signed in,
  and opens the page of the extension. Screen 1 has no such button: its foot, **Use your own
  Fruitback server**, leads there.
- **E-mail, Google and GitHub all start the sign-in of the console** (FRU-238), which offers its
  own methods. The extension has no surface of authentication of its own: decided by the
  orchestrator on 2026-10-20. A sign-in that did not finish is screen 1 with the alert of the kit
  above the ways in.
- **`no-access` is a rule that is on, for sites the browser no longer grants**: access was removed
  in the settings of the browser. The popup asks `permissions.contains` for the rule's pattern.
  **Allow access again** calls `permissions.request` in the click itself (an await before it loses
  the gesture), then injects the open tabs; **Turn off for this site** keeps the rule, off.
- **The e2e of screen 4 holds `tabs`, in the copy of the extension only**: a popup opened in a tab
  has no `activeTab`, which the click on the toolbar gives, and could not read the address of a site
  it does not grant. Automation cannot answer the prompt of **Allow access again**, so the spec
  plays **Turn off for this site**.

## The page of the extension, its menu and « Sites » (FRU-301)

### The rules, in short

- **The options page is the page of the extension of the mock-up of 2026-10-20**: a menu (the drop,
  « Fruitback » and the version of the manifest, the sections, the two guides), and a column of
  sections. **Sites** is a table of the rules and the panel of the one that is chosen; **Share
  rules** is the two cards of FRU-290; **Preferences** (the copy to the account of the browser) is
  the section of before, until FRU-302 draws it. « Workers and sessions » comes with FRU-302.
- **`src/site-page.ts` builds the parts**, with no `browser`: `site-page.test.ts` reads them on
  happy-dom. `entrypoints/options/main.ts` reads storage and the grants, and binds the clicks.
- **What a rule does has not changed**: the checks of a new rule, the grant asked in the click, the
  switch, the refusal of a team wildcard, `PREVIEWS_NOT_PROVEN`, `STALE_TEAM_WILDCARD` and
  `TOO_LARGE_FOR_ACCOUNT`. **Save** goes through `editor.save`, under the checks of a new rule; it
  keeps the rule on or off as it was, keeps the label of a private rule, and keeps the mount of a site
  of a workspace while its worker stays.
- **A change of storage draws the table again, never the panel**: somebody may be typing in it. The
  panel is drawn when a row is chosen, and goes when its rule is removed.
- **The site of a row is a native button**: Tab reaches it, Enter opens its panel. The switch of a
  row is the switch of a table of the kit, named « Fruitback on {pattern} ».
- **No date « added »**: the mock-up writes one, and storage keeps none. It is left out rather than
  made up.
- **« Share rules » is two cards** (FRU-290, `src/share-rules.ts`): « Export » with **Download**,
  and « Import a rules file », a `label` around a file input kept out of sight but in the tab order.
  A file chosen or dropped on the card is read the same way; the result is a live region in the
  card. No native « Choose file » shows: Chrome and Firefox drew it differently, in their own
  language.
- **The file is `fruitback-rules.json`**, the name of the mock-up. The import reads what the file
  holds (`format: "fruitback-sites"`, unchanged), not its name, so a `fruitback-sites.json` of before
  is read the same.
- **« imported » is said by the page that imported, until it is closed.** A rule from a file is
  stored as a rule typed in: no field of `SiteConfig` marks it, so the account copy (FRU-72) and the
  worker see nothing new. The row and the panel say « imported », and the panel says that access
  did not travel with the file, while the page is open; a removed rule, or one typed in again, loses
  the word.

## The key that starts a note (FRU-291)

### The rules, in short

- **One command of the manifest, `leave-feedback`, with `Alt+Shift+F` suggested** (Option+Shift+F
  on macOS). It sends the widget of the tab the command of the popup button: the capture starts,
  Esc stops it. `src/shortcut.ts` holds the name, the key and the listener (`runShortcut`).
- **The browser owns the key.** A person changes it in the shortcut settings of the browser
  (`chrome://extensions/shortcuts`; in Firefox, Add-ons, Manage Extension Shortcuts). A browser does
  not assign a suggested key that another extension holds: the command is then installed with no
  key, and the options page says « none set ».
- **The page never sees the key, and the widget listens to none.** A key on the page would take one
  from the site under review, so the widget has no shortcut of its own, mounted by the extension or
  by a script tag.
- **A command asks for no permission** and adds no warning at install. `shortcut.test.ts` writes the
  list of permissions out, so a permission added with a key fails there.
- **The page of the extension shows the key now, under « Preferences », « Keyboard shortcut » (where
  the mock-up of 2026-10-20 puts it), read from `commands.getAll()`, with a button that opens the
  settings**: `commands.openShortcutSettings()` where the browser has it (Firefox 137), the page of
  Chromium otherwise. A Firefox older than 137 has neither, so the line says where to look. One line,
  on its own, so the screen of preferences of FRU-302 can take it whole.
- **The tab is the one `onCommand` gives, or the active tab of the window** (`tabOfCommand`) when a
  browser gives none: Chrome passes it since 86, Firefox since 126.
- **A tab with no widget does nothing.** No bridge answers there; the refusal is caught.

### The reasons, and what was measured

- **The mock-up of 2026-10-20 (FRU-58) shows `Alt Shift F`**, and the orchestrator chose it on the
  same day. Chromium installed it on macOS with no conflict (`commands.getAll()` answered `⌥⇧F`).
  A command takes the key before the page: on a site that binds it, the extension wins while the
  command holds the key, and the person can change it. Firefox was not measured.
- **A key pressed by Playwright never reaches a command.** Its keys go to the renderer of the page,
  and the browser catches a command before that: measured, `page.keyboard.press('Alt+Shift+F')` left
  the widget as it was. So `e2e/extension-shortcut.spec.ts` reads the key the browser installed,
  sends from the service worker the message `runShortcut` sends, and drives the options page.
- **The service worker is not a page of the extension**, and the bridge takes commands from the
  pages only (`acceptedCommand`). Measured in Chromium: the bridge takes a message of the service
  worker, and the widget starts the capture. The spec fails if that stops.

## The side panel of the browser (FRU-296)

### The rules, in short

- **One page, `entrypoints/sidepanel/`**: wxt writes `side_panel.default_path` and the `sidePanel`
  permission for Chrome, and `sidebar_action` (`open_at_install: false`) for Firefox. The frame is
  the head of the shell, « Notes on this page » and « Close the sidebar »; the list of the notes is
  FRU-299. `src/side-panel.ts` holds the parts, with no `browser`.
- **The click on the icon keeps the popup.** The background sets
  `setPanelBehavior({ openPanelOnActionClick: false })` at install and at each update. The panel
  opens from « Show all notes in a sidebar » of the popup, and later from the preference « Open
  notes in the sidebar » (FRU-302).
- **`openPanel` is called in the click, before any `await`.** Both browsers open a panel only in a
  gesture of the person; an `await` first drops it. On Chrome it opens the global panel of the
  window of the tab (`sidePanel.open({ tabId })`); on Firefox, `sidebarAction.open()`. A browser
  with neither, or one that refuses to open it, shows the list of the widget in the page
  (`show-notes`), as before (`openPanelOrPage`).
- **The panel follows the active tab of its window** (`tabs.onActivated`, `tabs.onUpdated`,
  `windows.onFocusChanged`, and a change of the rules). It reads the address of the tab itself:
  the browser gives it only for a site the extension has access to, so any other tab reads « not
  on ». It keeps nothing. It reads the worker for one thing only, the scope « Whole site » of
  « Search and options » (FRU-307, see below).
- **The panel lists the notes of the page (FRU-299)**: see the next section.

### What was measured, and what was not

- **Chrome adds no warning for `sidePanel`.** `management.getPermissionWarningsByManifest` on the
  built manifest, and on the same manifest without the panel, answer the same list
  (`e2e/side-panel.spec.ts` asks it on every run).
- **The new headless Chromium of Playwright opens the panel**: the click resolves and the popup
  closes, and `runtime.getContexts` lists a context `SIDE_PANEL` on `sidepanel.html`. Playwright
  does not hand that page over as a `Page`, so the spec reads the panel through that context.
- **Firefox was not measured in a browser.** The suite loads extensions in Chromium only. The
  Firefox build, read by hand on 2026-10-20, holds `sidebar_action` (`default_panel:
  "sidepanel.html"`, `open_at_install: false`) and no `sidePanel`. MDN: `sidebarAction.open()` works
  only in the handler of a user action, which the popup button is, and the sidebar has the same
  `tabs` API. If a Firefox does not open it, the in-page list stays: the popup keeps it for a browser
  with no panel API.

## « Notes on this page », in the side panel (FRU-299)

### The rules, in short

- **The panel asks the widget of the tab for the notes of the page; it reads no worker for them.**
  Only « Whole site » of « Search and options » reads one (FRU-307, below). `notes` answers `pageNotes()` of
  the widget: the notes its pins show, with their numbers, from its last read, and none of a stage
  the reporter hid. One read, the same numbers as the pins, no second model and no cache.
- **The widget says when to ask again.** `watchNotes` of the widget tells of each read, hidden
  stage and kept note, and of the note opened on the page (a click on its pin); `page.content.ts`
  posts `notes-changed`, and the bridge sends it to the panel. The panel takes it from the tab it
  follows only.
- **Four commands**, beside the three of the popup: `notes`, `focus-note` (scroll to the pin and
  open its thread), `mark-note` (the pin of the open row stands out: a fifth bigger, above the
  others) and `reply` (the reply path of the thread, then a read). A reply waits 20 s for its answer;
  the others 1.5 s, as before.
- **Open and Done.** Open is New, To do and In progress; Done is Done and Closed (FRU-300 takes out
  the notes to check). A row is the drop of the kit with the number of its pin, the note, and
  « {stage} · {who} · {age} »: « You » for a note of the reader (`mine`), the name given, or
  « Anonymous ».
- **A site that embeds its own widget (team mode with no mount) has no list in the panel.** That
  widget is the site's, and answers the extension nothing: the panel says that its notes are in its
  own list on the page, rather than wait for them and report a failed read.
- **A row says the status of its note, in its colour** (FRU-370): the name of the status, then the word
  of the store, then the word of the stage, and the drop in the colour the team chose. « Open » and
  « Done » stay by stage. See [statuses.md](statuses.md), « What the widget draws ».
- **A reply is 2,000 characters at most**, the length the worker takes: the field takes no more.
- **The panel does not poll.** `notes` answers the notes, or why there are none: a read not answered
  (the panel waits for `notes-changed`), a read that failed (« Try again » asks the widget to read
  again, `reread`), a session that ended (FRU-315), or nothing on the page at all, a page open before
  the site was on (« Reload the page »). One bounded exception: no widget of ours yet is asked once
  more after `NO_WIDGET_WAIT_MS` (4 s), and a page that still has none (a mount that threw, a widget
  taken down) says « Fruitback did not start on this page » with « Reload the page », rather than
  « Reading… » for ever. After a reply is sent, the focus goes back to « Reply » of its row.
- **A click on a pin opens its row once a list that holds its note is read**: the id waits until
  then (`openOnRead`).
- **What somebody types in a reply stays.** The panel draws again at each change; the text, the
  caret and the focus are put back. A reply that did not go keeps its text and says why.
- **The foot names the host and the workspace of the rule**, which the extension stores. The
  destination of FRU-295 is a read of the worker, which the panel does not make; it comes when the
  background holds it.
- **No shell head in the panel.** The mock-up (`ExtSidebar`) opens on « Notes on this page »; the
  head of FRU-296 is gone.

## « Search and options », in the side panel (FRU-307)

### The rules, in short

- **Behind the magnifier of the head** (`ExtSidebar`), the controls of the board « Sidebar mode »:
  the scope « This page · {n} » / « Whole site · {n} », « Search notes », the chips All, New, To do,
  In progress and Done with their counts (`aria-pressed`), and « Show pins on the page » at the foot.
  `src/search-options.ts` draws them, with no `browser`.
- **While it is open, one list stands in for « Ready to check » and the tabs**: the chips do what
  Open and Done did. Closing it gives the panel of FRU-299 and FRU-300 back as it was.
- **« This page » filters the notes the widget read**: every word of the search in the whole text of
  the note or the name of its author, without case or accents. The notes that lost their element
  (`placement: 'detached'`) are listed at the end, under « {n} detached note(s) », with « the element
  it pointed at is gone ».
- **« Whole site » reads `GET /session/notes` (FRU-306) of the worker of the rule, with the session
  of this browser**, as the popup reads `GET /session/sites`. Only a rule the extension mounts in team
  mode with a session held for its worker has it; a private site, or a site that embeds its own
  widget, has no scope. **The worker is the one source**: one page of 50, its `total`, « Show more »
  for the next; a new search (after 300 ms without typing) or a new opening asks again, and nothing is
  stored. **A list belongs to the words it was read with** (`q`): new words drop any read still on
  its way, « Show more » included, and the list of the words of before offers no « Show more »
  until the read of the new words answers (review of #419: its cursor walks another list). The answer holds excerpts of 64 characters: the hint says « Searches the first words of each
  note », and an excerpt of 64 ends with « … ». The chips count the notes read; « Showing {n} of
  {total} » says when there are more.
- **A row of another page opens that page in a new tab**, never in the tab of the reader, where a
  note may be half written. The panel follows the new tab, opens the row of the note once the widget
  there read it, and opens its thread on the page (`focus-note`). A row of the page of the tab (a
  filled drop, « This page ») opens its thread at once. A row with a reference links to the tracker
  (« Open {reference} → », `noreferrer`).
- **Each row of « Whole site » has « Show on the page »** (« Voir sur la page »), as the table of the
  notes of the console (FRU-434). A note of another page: a link to `<page>#fruitback-note=<id>`
  (`noteLink`, the link of FRU-253, after the fragment of the site), in a new tab, `noreferrer`; the
  widget there scrolls to the note and opens its thread. A note of the page of the tab: a button that
  does what a click on its row does, a scroll to the pin and its thread, in that tab. The row of
  « This page » keeps its « Show on the page » in the row it opens. `e2e/side-panel-search.spec.ts`
  follows both links.
- **« Show pins on the page »** sends `hide-pins` or `show-pins` to the widget of the tab
  (`showPins`), the same switch as the list of the page (FRU-308): the pins are hidden but the pin
  of an open thread, and the notes are still read and listed. The tab the panel leaves gets its pins back. **The pins come back when the panel closes,
  from the background**: the panel holds a port (`PANEL_PORT`) and says on it which tabs it hid;
  when the port goes, the background sends `show-pins` to them (`pinsKeeper`). A page that closes
  cannot be trusted to send a last message (review of #419).
- **What somebody types in the search stays**: the field, its caret and its focus are put back after
  each draw, as for a reply.

## « Ready to check », in the side panel (FRU-300)

### The rules, in short

- **A note is to check when the worker says so**: `done`, `mine: true`, and no `checked` (FRU-294).
  It sits in « Ready to check · {n} », between « Leave feedback » and the tabs, and not in « Done ».
- **« Fixed by {name} · {age}»** names the author of the newest reply of the note, as the store
  keeps it; with none, « Marked done · {age} », from `updatedAt`.
- **« Looks fixed » and « Still wrong » go through the widget of the tab** (`check`, then
  `checkNote` of the widget), by its transport: the relay in team mode carries
  `POST /feedback/<id>/check`, and nothing else new. While a verdict is written both buttons wait and
  say « Sending… »; a verdict that did not go says why in its note, and nothing moves.
- **No optimistic state.** After a verdict the panel reads the page again; the store moved the note,
  or wrote the verdict, and the list says where it is. « Looks fixed » opens « Done », where the row
  says « Checked by you »; « Still wrong » opens « Open », where the row says « Reopened by you ».
  That last word is kept by the panel while it is open: the store keeps the verdict, not who
  reopened from where.

## The page of the extension, « Workers and sessions » and « Preferences » (FRU-302)

### The rules, in short

- **One card for each worker a rule names**, and for a worker this browser holds a session with and
  no rule names (the Cloud of an account). Paired: « Paired as {name} », or « Paired » and the e-mail
  under it when the worker gave no name (FRU-289), « Verified by the worker · renews on its own », and
  **Log out** (revoke on the worker, forget here, give back the access to the worker). The Cloud:
  « Signed in as {name} ». Not paired: the code and **Pair**, which asks for the worker's origin in
  its click, then pairs; plain http off this machine offers no pairing. `src/workers-page.ts` builds
  them, with no `browser`.
- **The popup keeps its pairing.** A pairing link still pairs from the popup, which the specs and the
  guide use; the popup adds **Pair in the page of the extension**, which opens the card of that
  worker with the code filled in (`#workers?worker=…&code=…`). Taking pairing out of the popup is a
  choice for later, once the page is the habit.
- **FRU-289, in the popup too.** A pairing link that just paired says « Paired. This browser reads and
  writes the notes of this worker. »; « already paired » is only for a browser paired before the
  link. With no name, the popup says « Paired » and the e-mail under it, as the card does.
- **« Open notes in the sidebar »** sets what the icon opens: the side panel on a site that is on,
  the popup everywhere else (where a site is turned on). Chrome keeps one behaviour for the browser,
  so the background sets it again when the tab, the rules or the preference change
  (`setPanelOnClick`). Firefox has no such behaviour: the row is not drawn there.
- **« Name on my notes »** is kept in the local area of the extension (`notesName`) and given to a
  widget the extension mounts in private mode: the composer starts with it when the reporter kept no
  name on that site, and the box « remember me » stays as it was, so the site keeps nothing it was not
  asked to. Team mode signs with the session. It is not part of the signature of a mount: a change of
  it never builds the widget again over a note being written; the next mount takes it.
- **« Leave feedback shortcut »** shows the keys of `commands.getAll()` and opens the shortcut settings
  of the browser; **« Keep my rules in the account of this browser »** is the copy of FRU-72, moved.
- **A preference is a write, and a write can fail** (a full storage): the control goes back where it
  was and the card says « This preference could not be saved. Try again. », so the page never shows
  a value the extension did not keep.

## « Show Fruitback on this page », in the popup (FRU-444)

### The rules, in short

- **A switch under the switch of the site**, on screen 3 and on the screen of a rule, while the site
  is on: « Show Fruitback on this page » (« Afficher Fruitback sur cette page »). Off, the widget
  leaves every tab of that **origin**; the rule stays on, keeps its access, and the other origins of
  a wildcard keep the widget. On again, it comes back with no prompt and no reload.
- **Kept per origin in `chrome.storage.local`, under `hiddenOrigins`**, a list of origins
  (`src/page-visibility.ts`). It is no credential and no rule: it is not in the copy of the rules in
  the account of the browser (FRU-72). A read that fails shows the widget, as before the switch.
- **Hidden, nothing runs on the page.** The background registers the scripts of a rule with the
  hidden origins it covers in `excludeMatches` (`syncRegistration`): a page loaded while it is hidden
  gets neither script, so no widget and no `__fruitbackPageScript`. A pair whose hidden origins
  changed is unregistered and registered again, in its own call, like a new origin (FRU-74).
- **A tab already open gets `unmount`.** The bridge reads the list with the rule, and a change of the
  key applies its decision again: hidden is an `unmount`, the message of a site turned off. No new
  message crosses to the page, and `protocol.ts` is unchanged.
- **Shown again, the popup injects both scripts into the open tabs of the origin**, as a site turned on
  does (`injectIntoOpenTabs`): a tab loaded while it was hidden has no bridge to hear the change.
- **Hidden, the screen offers neither « Leave feedback » nor the side panel**: the page has no widget
  to take them. The switch is a `role="switch"` of the kit, named by its words, in the order of the
  keyboard after the switch of the site. `e2e/popup-hide-widget.spec.ts` hides, reloads, reads the
  registered scripts, and shows again; axe runs on the popup in both schemes.
- **Not verified on Firefox**: `excludeMatches` of `scripting.registerContentScripts` is in its
  documentation, and was not measured here.

## « Corner of the widget », in the preferences (FRU-443)

### The rules, in short

- **The corner is said apart from the mount, in a message of its own**: `dock`, with `position`, one of
  the four corners of the widget (`DOCK_POSITIONS`, written in `protocol.ts` so the bridge does not
  import the widget, and held equal to the widget's by `protocol.test.ts`). Absent: the corner by
  default. The page script calls `moveDock` of the widget it mounted: no new widget, so a note being
  written stays, as with `selectors` (FRU-349).
- **A value that is not a corner is no message**: it moves nothing. The page can read and forge it on
  its channel; it moves the dock on that page, and nothing else.
- **Kept in the local area, under `dockPosition`**, for every site. No credential. The corner by
  default is no key: choosing it again removes the key.
- **« Corner of the widget » is a row of « Preferences »**, after « Show CSS selectors »: a `select`
  of the four corners (« Bottom right », « Bottom left », « Top right », « Top left »), which the
  keyboard reaches with Tab and walks with the arrows. A write that fails puts the select back and
  says « This preference could not be saved. Try again. ».
- **The bridge says the corner after each mount, and again when the key changes** (`readDockPosition`
  of `createApply`), like the selectors: a widget already on a page moves at once, with what is
  written in its composer. A read that fails keeps the corner said last.
  `e2e/extension-dock-position.spec.ts` chooses a corner over a note being written, reloads, and
  goes back to the default.

## The button of the widget opens the side panel (FRU-469)

### The rules, in short

- **The widget the extension mounts gets `openSidebar`**, in both modes: its button « Show every
  note in a sidebar » posts `open-panel-request`, and the background opens the panel of the tab of
  the sender (`src/panel-request.ts`), **at once, before any `await`**, then answers `opened`.
- **Refused, absent or silent for 3 s, the widget opens its own list**: Firefox's `sidebarAction.open`
  takes no call from a message, and a browser with no panel has the list of the page.
- **Only during a gesture of the person**: the bridge carries the request only while
  `navigator.userActivation.isActive`, which the isolated world reads and no script of the page sets.
  And a tab is answered once in 2 s. `SECURITY.md` says what this lets a page do.
- Measured on Chromium 156 (Playwright 1.64.1), with a probe extension and no `evaluate` of Playwright
  before the page acts (an `evaluate` carries a gesture, and spoiled a first measure): `sidePanel.open`
  from a message of a content script opens the panel after a click on the page, and is refused after
  a timer of the page. Google Chrome and Firefox are not measured here.
- A site that embeds its own widget (team mode, not mounted by the extension) is not covered: its
  widget does not know the extension, and `FruitbackExtensionApi` offers no way to the panel.

## « All pages » of the widget it mounts (FRU-470)

### The rules, in short

- **The widget the extension mounts in team mode gets `siteNotes`**: « All pages » of its list reads
  `GET /session/notes` (FRU-306) through the bridge and the background, as « Whole site » of the side
  panel does (`src/site-notes.ts`). With no relay (private mode) it gets none: there is no session
  here, and the list keeps « This page » alone.
- **The page asks, the background decides** (`src/site-notes-relay.ts`): `site-notes-request` carries
  an id, the words of a search and a cursor, nothing else. The background reads the origin off the
  sender, the entry of that origin (on, team mode, mounted), its site id and its endpoint (`https` or
  loopback), then the session. Anything else answers `unavailable`, and reads nothing.
- **What goes back to the page is less than the side panel holds**: the link to the tracker and
  « mine » stay out. The bridge rebuilds the answer field by field (`parsePageSiteRead`) and answers
  every request, `failed` when the background gave nothing. The page script waits 15 s at most.
- `SECURITY.md` says what this lets a script of the site read, and on which condition.

## The rules in the reviewer's other browsers (FRU-72)

### The rules, in short

- **Off until the reviewer ticks the box** of the options page. `storage.sync` is kept by the
  vendor of the browser: the address of a staging site does not go there by a default.
- **The map in `local` stays the one that everything reads.** The bridge, the relay, the popup and
  the registration read what they always read, and no stored shape moves: there is no upgrade to
  run, and a version of before reads its rules.
- **`sync` holds a copy, one key for each pattern** (`site:<pattern>`). Two browsers that change two
  rules do not write one item, and the quota of 8 KB is for one rule.
- **Three moves** (`src/site-sync.ts`): a change made here goes to `sync` as that change; a change
  that arrives is applied by the one writer of the map and is not sent back; a merge, when the box
  is ticked and when the browser starts, gives each side the rules it does not have, **except a rule
  this browser knew in the account** (`syncedRules`, in `local`): that one was removed on one side
  while the other was closed, and the removal is carried. A rule it never knew is taken, never
  removed: a browser that holds fewer rules erases none of the others' by starting. Raised in
  review: an additive merge brought back a rule removed while the other browser was closed.
- **The access and the session do not travel.** A rule that arrives runs nowhere until access is
  granted in that browser; the options page says « No access in this browser » beside it, with the
  button. test:`the rules go to the account of the browser only when the reviewer asks, and a rule
  that arrives has no access`.

### The reasons, and what is not done

The ticket asked to move the rules to `sync`, one key for each pattern, with an upgrade from `local`.
That makes every reader list an area, and puts the one stored shape a release cannot re-run at risk
for a feature most reviewers will not turn on. A copy beside the map gives the same result with no
upgrade: this is the simplest answer that fits what exists, and it was taken by the agent under the
rule of 2026-10-12 (the orchestrator decides the current choices on Mathieu's delegation).

- **A rule of both browsers that differs stays as it is on each**, until one of them changes it:
  the merge does not choose. A change, made after, is carried.
- **A browser that was closed** during a removal finds the rule it knew gone from the account at its
  start, and removes it. Whether the browser also says so with `storage.onChanged` was not measured
  between two real browsers: the E2E Chromium has no account, so its `sync` area stays on the machine.
- **Turning the box off forgets what was known**, so the next merge removes nothing, in either
  direction. Two cases follow, and both bring a removed rule back. A rule removed here while the box
  was off comes back from the account when it is ticked again. **A rule removed in another browser
  while the box was off here is sent back to the account by this browser when it is ticked again,
  and so comes back in the other browser too** (raised in review). This browser cannot tell that rule
  from one it holds and never copied: telling them apart needs a mark of each removal in the account
  (a tombstone), and a rule has no date to compare it with. Not done: a removal that comes back is
  seen and done again, and a merge that removed a rule nobody removed would lose one silently.
- **Turning the box off removes nothing from the account.** Removing there would remove the rules of
  the other browsers.
- **A rule larger than the item quota of `sync` (8 KB, the key and the JSON) is not sent** (FRU-264).
  The browser refuses a whole `set` for one larger item, so an import of three rules with one large
  rule copied none, and marked none as known. `fits` measures each rule as the browser does, in
  bytes, before the one `set` of a change or of a merge. The others go, and only they are marked as
  known. The options page shows the reason on the row of a rule that does not fit, while the copy is
  on: it calls the same `fits`, so no list of refused rules is stored. test:`copies the other rules of
  a change when the account refuses one of them, and marks only those as known`. One `set` for each
  rule was not taken: the browser also counts the `set` calls (120 a minute in Chrome), and a large
  import would then meet that quota. A rule that fits and is still refused (that quota, an account
  that is away) is logged, stays in `local`, and the next merge sends it.
- **A large rule that replaces a smaller one keeps the smaller one in the account.** Removing it there
  would remove the rule in the other browsers, which know it.

## A capture of the page, taken by the browser (FRU-44, FRU-332)

### The rules, in short

- **The extension captures, and sends nothing.** The page world gives `init` a `captureVisible`
  (and puts it on `window.fruitbackExtension`, beside the transport, for the widget of a site of a
  workspace). It posts a `capture-request` on the bridge, with the area the person chose or none for
  the whole visible page. The background takes the tab (`tabs.captureVisibleTab`), cuts the area out
  (`createImageBitmap`, `OffscreenCanvas`), and answers the PNG in base64. The widget joins it to the
  note like a file of the disk, and it goes through the relay to `POST /attachments`, then to the
  ticket of the tracker (FRU-331). `src/capture.ts` holds every case where it gives up.
- **Only for a site of a workspace, with a session**: a site in team mode, switched on, on an https
  worker (or loopback), with a session open for it. A page that asks for a capture elsewhere gets none.
- **The relay carries a file to `POST /attachments` only**: its body in base64 (`encoding:
  'base64'`, 10 MB of bytes at most, `MAX_FILE_BASE64`), sent as bytes by the background. Base64 to any
  other path, a body of text to `/attachments`, and a read of `/attachments/<id>` are refused.
- **No new permission: `activeTab`, already declared.** The browser grants it when the reviewer
  opens the popup on the page, until the page navigates. Without it the capture is refused.
- **A capture refused for want of a gesture says what grants it** (FRU-423). In team mode the widget
  mounts by itself, so nobody clicked the icon and `activeTab` is not granted: `captureVisibleTab`
  is refused (« Either the '<all_urls>' or 'activeTab' permission is required. » on Chromium,
  « Missing activeTab permission » on Firefox). `isPermissionRefusal` of `src/capture.ts` reads those
  words, the answer is `{ refused: 'permission' }` across the bridge, and the page world rejects
  `captureVisible` with an error named `NotAllowedError`. The composer says « Click the Fruitback
  icon in the toolbar, then try again. »: the click opens the popup, which grants `activeTab` until
  the page navigates, and the note stays open behind it. Any other failure keeps « The capture was
  not taken ». A widget of before reads the rejection as « not taken », as it read any rejection.
  `e2e/extension-capture-refused.spec.ts` plays the refusal; the grant by a click is checked by hand.
- **« Capture with Fruitback », in the context menu of a web page, is the gesture that grants the
  capture** (FRU-423, `src/context-menu.ts`). The `contextMenus` permission adds no warning at install
  (Chrome, measured with `getPermissionWarningsByManifest` in `e2e/context-menu.spec.ts`). A click on
  the item grants `activeTab` on the tab until it navigates, and sends the widget the command
  `capture-area`: in an open composer that takes files, the capture of an area starts; with no
  composer open, a note starts, as `leave-feedback` does. The item is placed at install and at each
  start, in the language of the reviewer, and placed again when that language changes. It is on
  every `http` and `https` page; where no widget of the extension answers, nothing happens. Nothing in
  automation can click a menu of the browser: the spec checks the permission, the item, and the path
  of the command, with `<all_urls>` on its copy for the capture itself.
- **« Allow captures on every site » asks for `<all_urls>`, once** (FRU-425, `src/capture-everywhere.ts`).
  It is in `optional_host_permissions` beside `*://*/*`: nothing changes at install (Chrome gives the
  same warnings with and without it, `e2e/capture-everywhere.spec.ts`). Only the switch of the
  preferences asks for it, in its click and before anything is awaited; a refused prompt puts the
  switch back, a request that throws says « not saved ». The row quotes the prompt of the browser:
  Chrome « Read and change all your data on all websites » (French: « Lire et modifier toutes vos
  données sur tous les sites Web »), both measured with `getPermissionWarningsByManifest`; Firefox
  « Access your data for all websites », the text Mozilla documents, not measured. With it,
  `captureVisibleTab` takes the tab with no gesture; without it the remedy of FRU-423 stays. Turning
  it off is `permissions.remove`. **It grants no rule**: the background, the options page, the
  popup and a pending site read the grant of a rule from `permissions.getAll` without `<all_urls>`
  (`holdsSiteAccess` of `src/site-grant.ts`), since `permissions.contains` answers `true` for every
  origin once it is held; a site whose access was removed in the browser stays off.
- **A capture that fails costs the capture, never the note.** No `activeTab`, no session, an http
  worker, thirty seconds without an answer: the composer says « The capture was not taken », and the
  text and the other files stay. Ten seconds was too short for a prompt of permission, a crop and a
  JPEG of a large screen (balanced review of #433); an answer after the delay finds no request and
  is dropped, and nothing was sent.
- **A capture over the limit of an image (10 MB) goes as a JPEG of quality 0.85**, `page.jpg` or
  `area.jpg`: a PNG of a whole page of a 5K screen can pass it. A JPEG still over it is answered
  as too large, with its size and no bytes, and the composer says « Too large » rather than « not
  taken ». The three hops of that answer are `captureAnswerOf` of `src/capture.ts` (the background),
  then `captureResponseOf` (the bridge) and `pictureOfAnswer` (the page world) of
  `src/capture-answer.ts`, which reaches no module of the session; and
  `capture-composer.test.ts` runs them, from a tab over the limit to « Too large » in the composer.
  The size of a PNG of a real 5K page, and of its JPEG, is not measured.
- **The picture of the element of FRU-44 is gone from the extension**: its route, `POST /screenshot`,
  answered an address that Fruitback served, and Fruitback serves no file now. `captureScreenshot`
  stays a seam of the widget for a site that stores its own pictures.

### The reasons, and what is not measured

- **Base64 between the page and the background**, because `runtime.sendMessage` carries what JSON
  carries, not bytes. 10 MB of a file is 13.3 MB of text, under the 64 MB that Chromium documents for
  a message (not measured with a file that size).
- **Measured on Chromium 145** (FRU-44): `captureVisibleTab` is refused with the host of the origin,
  with `*://*/*`, and with `activeTab` declared but not granted; it works with `<all_urls>`. The
  success path in a browser needs the gesture on the extension. `extension-capture.spec.ts` takes
  `<all_urls>` in its copy instead. Since FRU-426 the bench makes the click on the icon with
  `Extensions.triggerAction`, and `extension-bench.spec.ts` takes a capture with the `activeTab`
  that it grants (Chromium 156, « The bench of the extension » below).
- **The capture shows what the screen showed**: the widget is hidden for the two frames before it,
  and the area of the capture is drawn by the widget, then removed before the capture is taken.

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

## The shell of the popup, and « Sign in to Fruitback » (FRU-251)

### The rules, in short

- **Every screen of the popup is drawn in one shell**, the mock-up of 2026-10-13 (screens 05 to 08):
  the logo, the person of the account and the gear (« Settings and every site », the options page)
  above, a body, a foot. 360 px wide and 420 px tall at least, so the window does not jump between
  screens. Which screen is drawn is decided in `popup-state.ts`, with nothing to await, and the
  screens of the sign-in are drawn in `popup-view.ts`: both run under `node --test`, state by state.
  `main.ts` gathers the facts and wires the clicks.
- **The extension asks, the console approves** (Q8 of FRU-230, the routes of FRU-238).
  `POST /session/connect` gives a public `request`, a `word` and a secret `claim`. The popup shows
  the word and opens `verificationUri` in a tab; the person checks the word there and approves; the
  popup, or the background on an alarm while it is closed, spends the claim on
  `POST /session/connect/claim` and keeps the session as a pairing keeps it. The session is marked
  as an account's (`StoredSession.account`), and every refresh keeps the mark.
- **The claim lives in `storage.session`, and only there**: never in an address, a page or
  `storage.local`. `e2e/popup-sign-in.spec.ts` reads every address, the page of the site and of the
  console, and both areas, with the claim in `storage.session` while it waits as the control.
- **The console the worker names is checked before a tab opens** (`approvalPage`): https (loopback
  for the dev loop), the host of the worker or a host under the domain it is under (not under a
  shared suffix such as `co.uk` or `workers.dev`), and the path `<console>/connect/<request>` with no
  query and no fragment. Otherwise a hostile or wrong worker would open any page it likes.
- **One request at a time**, given back while it lives, at most 30 minutes whatever the worker says.
  « Start again » forgets it and asks for another one.
- **The Fruitback to sign in to is fixed at build**: `WXT_FRUITBACK_CLOUD`, `https://api.fruitback.com`
  when absent, none when empty (the popup then offers « Connect it in settings » alone). `pnpm e2e`
  builds with the second worker of the suite.
- **The click asks for the optional host access to that Fruitback first**, nothing awaited before it,
  as a pairing does. No permission is added to the manifest.
- **The popup reads the tab it was opened on once.** Asked again after the console tab opened, the
  active tab is the console's.
- **The pairing link and the « Paired as » row stay** for a self-hosted worker, inside the shell: they
  are the only places where « worker » and « pair » remain. On screen 3 the person of a pairing is
  said once more, in the foot, with « Log out » as a link (FRU-319): the head, a « Paired as » row and
  the foot named them three times, and « Log out » was a filled pill of the weight of « Leave
  feedback ».
- **A site of the workspace of this Fruitback, when Fruitback does not answer, is screen 4**
  (FRU-319), and not « On · Acme » with no line under it: `ruleUnreachable` in `decide`. A removed
  access is said first, because it is fixed in this browser.
- **The page of the extension names the workspace of a site of Fruitback** (FRU-319): « This origin
  · Acme » under the site, and « The site ships nothing; the extension mounts the widget of Acme and
  carries your session. » in its panel, where it said that the site embeds a dormant widget.
  « Download » says what it wrote in the status of the card.

### The reasons, and what was measured

The first run of the spec signed in and lost the session at once. `adopt` wrote the session, then
its access token; the background read both the moment the session landed, found no token, refreshed
and spent the refresh token the popup had just stored. A worker that knows the token rotates it, so
the defect cost one useless refresh on every pairing; the worker of the spec did not know it and
ended the session. The access token is now written first.

A claim answered by the loop of the popup used to be claimed again by the drawing that followed. The
request was settled and forgotten by then, so the second claim found nothing, and « It was refused
in the console. » was never shown: the drawing now takes what the loop learned.

The popup and the background can claim at the same instant, and the worker gives the session once:
the context answered second is told the request is spent while the first still writes the session.
That context looks for the session four times, half a second apart, before it says « expired »
(raised in review); a refusal is never a spent request, so it is said at once. And how a request
ended is kept ten minutes in `storage.session` (`fruitback:connect-ended`, without its claim): when the
background ends it while the popup shows the word, the popup says why instead of drawing the screen
of before (raised in review). The popup says it once; the background reads it and keeps it.

The polling is the worker's pace (`interval`, 5 s, believed between 2 and 60), and a `429`
`slow-down` reads as « still waiting ». Only `410 connect-refused` reads as a refusal; any other
`410`, a `400` and a `404` end the request as expired. An outage keeps it.

What is not done here: the account's own shape of `GET /session/sites` (several workspaces), its
counts and the switch of the site are FRU-254 (screen 3 of FRU-298); adding a site from the popup is FRU-255 (screen 2 of FRU-298),
which replaced the fields of before for a person signed in on a site of no rule.

## The console of the Cloud connects the extension of its browser (FRU-487)

Decided by Mathieu on 2026-10-28: yes, for the console of the Cloud only, after FRU-482 and FRU-483.
It reverses the « not wanted » of `console.md` for that console. The threat model is in
`SECURITY.md` (« The console of the Cloud talks to the extension of the same browser »).

### The rules, in short

- **`externally_connectable` names one exact origin: the console of the Cloud.** `cloudConsole` of
  `src/external-console.ts` reads `WXT_FRUITBACK_CONSOLE` and `WXT_FRUITBACK_CLOUD` at build:
  `https://app.fruitback.com` when both are absent, none when the Cloud is empty (a build for a
  self-hosted instance) or the console is empty, none for another Cloud that names no console. A
  joker, a path, a query, plain http away from loopback, or a host outside the site of the Cloud
  (the rule of `approvalPage`) stops the build. The manifest gets `matches: ["<origin>/*"]`: the path
  must be written in a match pattern, and `/*` is the only one. No `ids`: the key closes the
  extension to the messages of other extensions too.
- **Chromium only.** The hook `build:manifestGenerated` writes the key for Chrome and Edge, and not
  for `-b firefox` nor `-b safari`. Firefox does not implement the key (`browser-compat-data`:
  `version_added: false`, bug 1319168). Safari has it since 15.4, `matches` only, marked partial; the
  id of the Safari extension is not the one of the store, and nobody measured it here: it keeps the
  flow with the word. The background listens to `runtime.onMessageExternal` only in the Chromium build.
- **The background answers three messages, and no other** (`acceptedExternal`, decided before any
  `await`): `{type: 'fruitback:hello', v: 1}`, `{type: 'fruitback:connect', v: 1}`,
  `{type: 'fruitback:claim', v: 1, request}`, with exactly those keys, from `sender.origin` equal to
  the console, a URL of the same origin, the top frame of a tab. A message not answered gets no
  `sendResponse`: the page reads `lastError`, as if no extension were there.
- **`connect` starts the request of the popup, with the Cloud of the build** (`startConnect`), and
  answers its id only. The claim and the word stay in `storage.session`. The page names no worker.
  The request must be approved by the same console (`consoleAt` of the worker's answer), or the
  answer is `unavailable`. Refused (`signed-in`) while a session of the Cloud is held.
- **`claim` claims at once**, the request that waits only, once per `interval` (5 s): the person
  waits seconds, not the minute of the alarm. The alarm of the background stays, for a page that
  closes before.
- **The console asks the id of the store** (`STORE_EXTENSION_ID`, from `CHROME_WEB_STORE`) on the
  Cloud, or the ids `/config.js` names (`extensionIds`), and none on a self-hosted console. It
  approves with the word it reads from the worker: the worker is unchanged.
- `pnpm e2e` builds with `WXT_FRUITBACK_CONSOLE=http://localhost:5178`, the console of the suite.
  `e2e/console-extension-here.spec.ts` routes `/config.js` to name the id of the unpacked copy,
  whose id depends on its folder.

### The reasons, and what was measured

The word answers one question: is the request I approve the one of the popup of this browser? Here
the browser answers it. Chrome delivers the message from a tab of this browser, and tells its origin
(`sender.origin`); the request id comes back from the extension of this browser; nothing the person
types or reads is involved. An attacker who wants a victim to approve their request needs to put
their id in front of the victim: this path approves only an id that the extension of the victim's
browser gave.

What it costs: the extension now trusts every page of `https://app.fruitback.com`. A script there
connects the extension of that browser to the account of the console of that browser, when the
extension is signed out. It reads no secret, and it cannot sign in a browser that holds a session.

Measured in Chromium with the built extension (`console-extension-here.spec.ts`): the manifest of the
e2e build holds `{"matches": ["http://localhost:5178/*"]}`; a page of the playground has no
`chrome.runtime` at all; the console has it, and its `hello` is answered; a message with an extra key
is not answered; one click on « Connect this browser » at step 3 connects the extension, with no new
tab, and the extension holds the session of the Cloud; a second `connect` is refused with
`signed-in`.

Not measured: the build of the store against `https://app.fruitback.com` (the id of the store is
fixed by the store, and only the published extension has it), Edge with the extension of the Chrome
Web Store (it installs from there, so its id is the same), and Safari.

## A site of a workspace in the popup (FRU-254, FRU-298)

### The rules, in short

- **Screen 2 (FRU-298), « Turn Fruitback on for this site? »**: the tile and the host, « In {workspace}
  · not on in this browser » for a site a workspace lists and this browser has not turned on, or « Not
  in your sites yet » for a site of no workspace. Then the terms of the kit: « Notes go to » (the
  `destination` of FRU-295; left out when the worker did not say, never « nowhere ») and « Who sees
  the notes » (`members`: « Your team and invited guests »; `everyone`: « Everyone who visits the
  site »), each with « Change », which opens the sites of the workspace in the console (none when the
  console is not known). « Turn on » and « Your browser will ask to allow this site once. ».
  `GET /session/sites` is read in both shapes: a pairing's session names one `workspace`; an
  account's (FRU-238) names its `workspaces`, each with the role held there, and each site says which
  it is of. A site of a workspace the answer does not list is dropped; counts that are not five whole
  numbers are dropped.
- **Screen 3 (FRU-298), a site turned on here, by its own origin**: the site with a switch
  (`role="switch"`, « On »), « On · notes go to {tracker} » (the tracker of the destination) or « On ·
  {workspace} »; « Leave feedback », the tall button of the kit, with « or press Alt Shift F on the
  page » from `commands.getAll()` (no line without a shortcut; the signs of Chrome on macOS, `⌥⇧F`,
  are one key each); « {n} fixes to check » (`toCheck`, an account's only, hidden at 0) and « {n} open
  notes » (New, To do and In progress of the site, « No open note » at 0), plural by
  `Intl.PluralRules`; and « Show all notes in a sidebar ». A line and « Show all notes in a sidebar »
  open the side panel on the tab, in the click (FRU-296). A wildcard of previews keeps the screen of
  before: the switch would turn off every site the rule covers. Off, the screen has the switch only.
- **What the worker says of the site is added after the screen is drawn**: the switch does not wait
  for the worker. The lines come from `GET /session/sites` (`offerFor`), as screen 2 reads them; a
  worker that does not answer leaves them out rather than zeros. The counts of the page are no longer
  in the popup: they live in the side panel (FRU-299). The command `counts` stays in the bridge, and
  the popup no longer asks it.
- **The popup asks the widget of its tab, and only that one** (`tab-command.ts`): `tabs.sendMessage`
  to the isolated world, which takes a command from a page of this extension only (no `sender.tab`,
  this extension's id), and posts it to the main world, where the widget the extension mounted
  answers. A site's own widget (team mode) is not ours to drive. No permission: `tabs.sendMessage`
  needs none.
- **A page can post the command into the main world too, and gains nothing**: the widget's Shadow
  root is open, so a page can already press every one of its buttons.

## A site of no workspace, added from the popup (FRU-255, FRU-298)

### The rules, in short

- **Screen 2, signed in on a site no workspace of the account lists**: « Not in your sites yet », the
  workspaces where the account may add a site (`canAddSite`, read now by the worker) as a « Workspace »
  line with its list when there are several, « Who sees the notes » (a site is added for the members
  of its workspace), and « Turn on ». None: « Ask an admin of your workspace to add this site. », and
  no button. No « Every preview build too »: no preview without the proof of FRU-103 (Q4).
- **The access to the site is asked for first, in the click**, then the site is added
  (`POST /session/sites`, the worker half), then the rule is stored as the one click of a site of a
  workspace stores it. A refusal of the browser adds nothing, and « Grant access » asks again. The
  site the worker answers must be the origin of the tab, in the workspace chosen, or nothing is stored.
- A refused add says why: the role does not allow it, too many sites in the hour, Fruitback did not
  answer; a session that ended draws the screen of a sign-in that ended.
- **This screen has no fields to type in.** A site of no workspace that one browser alone should cover (a private
  site, a worker of its own) is set in the settings, one click away, as the person with no account
  reaches it. Its lists of « Notes go to » and « Who sees the notes » are FRU-453's. It is drawn only signed in to the build's Fruitback, so a build without one never asks
  for the workspaces.

## Who sees the notes and where they go, chosen at the turn on (FRU-453)

### The rules, in short

- **Screen 2 shows lists in place of « Change »**, for a role that manages the sites of the
  workspace (owner, admin: the worker lists `sources` for it in `GET /session/sites`, and the `place`
  of each site by ids). Another role keeps the lines and their « Change », which opens the console.
- **« Notes go to » is three lists, as Mathieu asked in the review of #636**: the provider (« Fruitback
  (no tracker) », then each source of the workspace with its mark beside its name), then the team of a
  Linear or the repository of a GitHub, then a project of the team, which may be none. Each list is
  read again when the one before changes (`place-choice.ts`); the teams are read from the tracker by
  the worker (`GET /session/sites/places`), as the console reads them (FRU-458).
- **Every list of screen 2 is Chromium's customizable select** (`appearance: base-select`, second
  review of Mathieu): the marks are in the options and in the field, the arrow is one chevron at the
  right edge that turns when the menu opens, and words too long for the field or the menu end with
  « … ». The menu is as wide as its field. It stays a native `select`, for the keyboard and a screen
  reader. A browser without it (Firefox today) shows its own lists, the names alone. The marks are the
  console's (`connector-marks.tsx`); « Fruitback » is the red drop of the mark.
- **What moves is short, and nothing moves under `prefers-reduced-motion`**: the menu fades in and
  slides 4 px (0.15 s), the arrow turns (0.18 s), a line that appears in the cascade fades in
  (0.18 s, `@starting-style`).
- **A place is written once it is whole**: « Fruitback » and an address at once, a Linear or a GitHub
  once its team or repository is chosen, a project when it is chosen. It **replaces the default place**
  of the site; the other places stay after it, so flipping the lists does not pile places up. The
  worker checks it against the tracker and writes the label the tracker answers.
- **A site of a workspace: each choice is written at once** (`POST /session/sites/settings`), before
  « Turn on » and not by it: the prompt of the browser can close the popup, and a choice that waited
  for the click would be lost with it. A refusal says why and draws the lists again at the place of
  before.
- **A site of no workspace: the choices are written once the site is added**, before its rule. The
  sources follow the workspace chosen, and go back to « Fruitback » when it changes. A refusal stops
  before the rule: the site is in the workspace as members only, and « Turn on » again adds nothing
  more (the add answers the site that exists).

## A session that ended, met by the relay (FRU-238)

### The rules, in short

- **A call the worker refuses with `401` is renewed once** (`Sessions.renewAccess`, as the picture of a
  note does). A token that was only old gets a new one, and the call goes once more. A session that
  ended (in « My account », by a log out) is refused its refresh too, and forgotten there. Never a
  second renewal: a worker that refuses every token is answered.
- **No session, or one that ended, answers `401` to the widget** (`relay.ts`), not the refusal of
  status `0`. The widget then keeps the text and says « Your session has ended. Your text is kept:
  sign in again, then send it. », where it said « try again » before. A worker that does not answer
  is the moment, and stays a refusal.
- **A rule of a site of the workspace of the build's Fruitback, whose session is gone, draws the
  screen of a sign-in** (`ruleWantsSession` in `popup-state.ts`): the switch of a site that reads and
  writes nothing would hide the one thing to do.
- `e2e/popup-sign-in.spec.ts` holds the way: signed in, the site on, the session refused by the worker,
  the session forgotten, the widget saying so, and the popup offering to sign in.

## The widget says the session ended, and opens the sign-in (FRU-315)

### The rules, in short

- **The page says it at once.** For a widget we mount through the relay, the isolated world posts
  `{ kind: 'session', signedOut }` after the mount, and again each time a session starts or ends
  (`touchesARefreshToken`). `signedOut` is `wantsSession` of `popup-state.ts`, the rule the popup
  already draws its sign-in from: a site of a workspace of this build's Fruitback, with no session.
  The widget is told yes or no, never anything of the session.
- **Apart from the mount**, so a session that ends does not build the widget again over a note being
  written: the widget changes what it offers (`signedOut()` of `init`) and keeps what is written.
- **The bridge reads `storage.local` only, and writes nothing** (`createSessionArea(...).read()`,
  with the epoch rule of every reader). `storage.session` is closed to content scripts, and the
  upgrade of the areas is the background's: the first version used `createBrowserSessions`, whose
  upgrade touches `storage.session`, and the bridge read « signed in » for ever. Found by the E2E.
- **Signed out, the widget offers the sign-in instead of a note**: the launch button says « Sign in
  to leave notes », the list « Sign in to see the notes of this page. » with « Sign in », a send
  refused with `401` offers « Sign in again », the composer asks for no name, and « Keep for later »
  stays offered. Alt+Shift+F and « Leave feedback » of the popup lead to the sign-in too.
- **Each of those asks the background, which opens the popup** over that tab (`action.openPopup`):
  the popup is where a sign-in starts and where its word is compared, so nothing opens the console
  in its place. The ask is taken from a content script of this extension only
  (`acceptedSignIn`), and opens anything only for a tab whose site wants a session, once in 5 s per
  tab (`createSignInGate`), and never over a popup already open (`runtime.getContexts`). A page can
  forge the ask and the session message: at worst it opens our popup over itself, or makes our
  widget say « Sign in » on its own page. Measured in Chromium: no popup context before the click,
  one after (`runtime.getContexts`). Firefox opens a popup from a gesture only; a message is not
  one, so there the click does nothing more than the words, which already say to sign in.
- `e2e/popup-sign-in.spec.ts` (the session that ended), `bridge.test.ts`, `sign-in-request.test.ts`,
  and in the widget `host.test.ts`, `sidebar.test.ts`, `composer.test.ts`, `embed.test.ts`.

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

| Path                                                           | What stops it                                                                                                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A content script on the worker's page                          | It needs a host permission on the worker, and the first pairing is where that permission is asked for.                                                                       |
| `externally_connectable`                                       | The origins are declared in the manifest. A self-hosted worker is not known at build time, and Firefox has no such key. (FRU-487 uses it for the console of the Cloud only.) |
| A page of the extension, `chrome-extension://<id>/pair.html#…` | The worker cannot know the id, which differs between an unpacked build and a store build. A web page cannot link to that scheme either.                                      |
| **The popup reads the address of the tab**                     | Nothing. No new permission, the same on Firefox, and any self-hosted worker.                                                                                                 |

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

## Connected from the console: what the worker offers (FRU-238)

The worker half of « Sign in to Fruitback » (FRU-251 draws the popup). The extension asks, the person
approves in the console, and the extension claims a session **of the account**, for every workspace
the account is a member of. The pairing by code stays. `SECURITY.md` says what each step protects.

### The rules, in short

- **`POST /session/connect {browser}`** answers `{request, claim, word, browser, verificationUri,
  expiresIn, interval}`. The extension opens `verificationUri` in a tab as it is, shows `word` in the
  popup, and keeps `claim` where a page cannot read it (the background, or `chrome.storage.session`).
  **`claim` never goes in an address, a log or a message to a page.** `browser` is a short label
  (« Chrome on macOS »): the console shows it, so it names the browser and nothing else.
- **`POST /session/connect/claim {claim}`** every `interval` seconds: `202` while nobody answered,
  `429 slow-down` with a longer `interval` when asked too soon, `200` once with the session (the
  answer of `POST /session/pair`, with `identity.account: true`), `410 connect-refused` or
  `410 connect-expired`. After a `410` the extension stops and forgets the claim.
- **The session refreshes and logs out as every session**: `POST /session/refresh` and
  `POST /session/revoke`, one storage key per endpoint (FRU-63).
- **`GET /session/sites` answers a session of an account in another shape**:
  `{account: true, workspaces: [{id, name, role}], sites: [{id, origin, visibility, workspace,
  previews?}], locale?}`, with no `workspace` in the singular. `parseWorkspaceSites` of the extension
  of before reads it as no list, and offers nothing: it breaks nothing, and FRU-251 reads it.
- **The worker reads the memberships at each call.** A workspace the person left is gone from the next
  answer, and a note to one of its sites is refused with `401`: the extension shows that, and does not
  keep a list of its own as the truth.

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
  grant and the registration (`https://*.host/*`) cover every port, and **stay so, measured**
  (FRU-74): Firefox 146 accepts a pattern with a port and then runs the scripts on no page at all,
  its own port included. A port in the pattern would turn the site off in Firefox, with the popup
  saying **On**. It needs a base of at least two labels and no IP address. If a browser runs the
  scripts on another port, the bridge unmounts there.
- **Each origin has its own pair of scripts, registered in its own call** (FRU-74,
  `scriptIdsFor`). Chromium 145 refuses a whole call when one pattern is invalid; with one pair for
  every origin, one refused pattern stopped the extension on every site. A refusal now costs that
  origin, and is written in the console. test:`registers every other origin when the browser refuses
  one, and names the one it refused`.
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
- **One team wildcard serves: the previews a worker lists** (FRU-103). `lendsSession(pattern, site,
  proven)` answers no only when the worker of the rule listed that very wildcard for the site the
  rule mounts, in an answer of `GET /session/sites` that is less than two hours old
  (`proven-previews.ts`). **The grant is not in the rule.** It is in `storage.local`, one key for each
  worker (`provenPreviews:<endpoint>`), written only by `cloud.ts` from an answer of that worker: the
  popup when it offers the click, the background every thirty minutes and when it starts. One key
  for each worker, because both write: two writers of one map would each read it and write it back,
  and the later one would put back a list the other had just emptied. A caller that passes no
  `proven` keeps FRU-75 whole, and `complaint` passes none, so the form and the import refuse the
  rule: a rules file cannot grant. The background registers the scripts from the same list, and
  syncs when the list changes, so a proof that is lost takes the scripts off. `accessInUse` keeps
  the host permission of such a rule while it is on, proven or not: the permission alone runs
  nothing, and a proof that comes back must not ask the reviewer again. **A reader asks for the
  keys of the workers its rules name, and never lists the area** (`freshFor` in `sites.ts`): the
  bridge reads this in a content script, and the refresh tokens are in the same area.
  `sites-storage.test.ts` plants a session and reads the log of the calls. **A list does not outlive
  its session**: a pairing and a logout each mint an epoch, and the background then forgets what
  that worker listed and asks it again (`session-previews.ts`), so an account of another workspace
  that pairs with the same worker does not get the wildcard of the first. `session-previews.test.ts`
  drives it with the real sessions over one storage area: a pairing and a logout forget the list, a
  refresh keeps it. **An answer is kept only for the session that asked**: `listedBy` (`cloud.ts`)
  reads the epoch of the session before it asks and after the worker answered, and drops the answer
  of a session that is gone; it reads once more after the write, and takes the list back. Without
  it, an answer in the air at a logout put back the list that had just been forgotten, and nobody
  asks a worker again once it is logged out. All three raised in review.
  **Not driven in a browser**:
  the prompt for a wildcard, the alarm and the registration; the predicate, the list and the offer
  are held by `proven-previews.test.ts`, with five planted violations.
- **A site asked for is remembered before the browser asks for access** (FRU-118). The permission
  prompt can close the popup, and the code after `permissions.request` then never runs: the grant
  exists and no entry does. `pending-site.ts` writes the intent first, **not awaited** (an await loses
  the gesture). The background finishes it on `permissions.onAdded`, and the popup when it opens
  again. A refused prompt leaves it as a draft, and the form shows the values again (FRU-117). It is
  ten minutes old at most: an old intent must not turn a site on by surprise. Automation cannot answer
  a prompt, so the E2E copy never met this: the wiring is asserted on the sources.
- **A site of no workspace that « Turn on » adds is remembered the same way** (FRU-454): the worker,
  the workspace and what was chosen on the screen (FRU-453), before the prompt and not awaited. Its
  entry is known only once the worker added the site, so whoever settles it adds it first
  (`finishAdd` of `cloud.ts`: the add, then the settings, then the entry of the one click). The
  background does it on `permissions.onAdded`, the popup when it opens: nobody clicks « Turn on »
  twice. A worker that did not answer leaves the intent for the next settle; a refusal that holds (a
  role, a session that ended, the count of the hour, a refused setting) drops it. The popup that
  stays open finishes the add itself and forgets its own intent on every outcome, never the intent of
  another site that a click wrote since, and a refused prompt
  forgets it too: an access that comes another way later adds no site by surprise. Both contexts can
  add at once: the worker answers the site that exists to a second add.
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
pattern would narrow the grant to what the resolver covers. **Measured on 2026-10-12 (FRU-74), and
not done.** A probe extension registered `http://*.localhost:5191/*` and `http://127.0.0.1:5191/*`
and opened the two hosts on ports 5191 and 5192:

|                                                                                          | Chromium 145                      | Firefox 146        |
| ---------------------------------------------------------------------------------------- | --------------------------------- | ------------------ |
| `registerContentScripts` with a port                                                     | accepted                          | accepted           |
| the scripts run on that port                                                             | yes                               | **no**, on no port |
| the scripts run on another port                                                          | no                                | no                 |
| `permissions.contains` of a pattern with a port, when the pattern without one is granted | `true`                            | `false`            |
| a call with one invalid pattern (`:99999`)                                               | refused whole, nothing registered | accepted           |

So a port in the pattern works in Chromium and switches the site off in Firefox. The grant stays
wider than the resolver, as before: more access than the rule serves, and no site that fails. Each
origin is registered in its own call now, so a pattern a browser refuses costs that origin only.
Raised in review.

A wildcard on a single label (`*.localhost`, or `*.localhost.` with its root dot) or an IP address is
refused too. Since FRU-74 a refused pattern costs its own origin only (see above), and the error is
only logged. Which of these a browser refuses was not measured,
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
- **Two paths: `/feedback`, and `/feedback/<id>/replies` under one note** (FRU-257, `REPLY_PATH`).
  `relay.test.ts` reads `packages/widget/src/embed.ts` and asserts the widget calls those paths and
  names no header the relay would drop, so a call the widget grows later fails the suite instead of
  being dropped silently on a reviewer's page. The id of a note takes the characters the worker takes,
  and no other: `..` and `/` cannot reach a route around it.
- **A widget the extension mounts with no relay offers no field to reply** (`replies: false`,
  FRU-257). The rule of Mathieu says no for « the extension in anonymous », and the worker cannot tell
  that reader from a visitor of the site: the field is hidden, and the pins stay, as public as before.
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
  `http://` staging too. `capture.ts` already carried the same fallback for the note id, and the trap
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

## The bench of the extension (FRU-426)

### The rules, in short

- **`pnpm ext:bench` opens a Chromium on the screen, with the extension in team mode and paired.**
  It builds the packages and the extension, then starts `e2e/bench.ts`: a worker of development on
  a free port (a database in its process, the site `playground` that members only read,
  `FRUITBACK_STORE=postgres`), the playground if nothing answers on 5177, and a Chromium with a
  profile of its own and a copy of the build. The copy holds host access to the playground and to
  that worker, as the copy of the E2E suite does. Ctrl-C stops all of it.
- **The site of the bench sends its notes through a Linear connector to a fake Linear**
  (`FRUITBACK_DEV_LINEAR=fake`, `linear-fake.fixture.ts`). `linear.ts` runs as in production:
  `fileUpload`, the PUT of the bytes, `issueCreate`, `attachmentCreate`, and the read of the issues.
  Only `fetch` to `api.linear.app` and to the storage it names is answered in the process.
  `GET /__dev/tracker` of that worker answers what the fake received: the issues, each PUT with its
  type, its size and its SHA-256, and each attachment.
- **`grantActiveTab()` is the click on the icon, made by the browser.** It sends
  `Extensions.triggerAction` of the DevTools protocol on the **tab** target of the site. Chromium
  runs the action of the extension: the popup opens, and the tab gets `activeTab`. There is no
  build of the extension for the bench, no entry point for tests, and no permission added for it.
- **A Chromium with no `Extensions.triggerAction` gets `<all_urls>` instead, and says so.** The
  Chromium of Playwright 1.58.2, the one of the image of CI, does not know the method (« wasn't
  found »); Chromium 156 does. `startBench()` asks the browser first, and when the method is missing
  it loads a copy that holds `<all_urls>`: `bench.gesture` is then `all-urls`, `grantActiveTab()`
  does nothing, and every capture is allowed. That proves the capture, the file and the tracker, not
  the gesture: the spec checks the refusal before the click only when `bench.gesture` is `click`.
  WARNING: a machine where `chromium-1208` points to a newer Chromium measures the click, and CI
  does not. Read the annotation `gesture` of the test before you trust a green run for the gesture.
- **The driver is `e2e/bench.ts`**: `startBench()`, then `openSite()`, `signIn()` (done by
  `startBench` unless `paired: false`), `grantActiveTab()`, `leaveNote({ text, attach })`,
  `trackerReceived()`, `screenshot()`, `close()`. `moreCopies: ['copy']` loads a second copy of the
  build, or the directory of another one, beside the first (FRU-397). It needs no runner of
  Playwright. It runs from the root of the repository: its paths are relative to it.
- **`e2e/extension-bench.spec.ts` goes through the driver**, in `pnpm e2e`, headless. The anonymous
  read of the page answers `401`; a capture before the click is refused (« The capture was not
  taken »); after it, a capture of an area and a file of the disk go with a note; the fake Linear
  holds both, the bytes of the file match, and the pin and « 2 attachments » come back after a
  reload, through the relay.

### What was measured (2026-10-23)

Chromium 156.0.8078.4 (Chrome for Testing of Playwright 1.58.2, `channel: 'chromium'`), on a page
of `http://127.0.0.1`, with a copy of the build that holds no host permission unless the row says
so. The service worker then asks for the address of the tab, `tabs.captureVisibleTab`, and
`scripting.executeScript`. Headless and headed gave the same results.

| Path                                                                   | Address of the tab | Capture | Script  |
| ---------------------------------------------------------------------- | ------------------ | ------- | ------- |
| nothing (the control)                                                  | withheld           | refused | refused |
| `<all_urls>` in the copy                                               | read               | taken   | runs    |
| `http://127.0.0.1/*` in the copy                                       | read               | refused | runs    |
| `*://*/*` in the copy                                                  | read               | refused | runs    |
| `Alt+Shift+F` from Playwright (the command holds `⌥⇧F`)                | withheld           | refused | refused |
| `Input.dispatchKeyEvent` from `chrome.debugger` (copy with `debugger`) | withheld           | refused | refused |
| `action.openPopup()` from the service worker (the popup opens)         | withheld           | refused | refused |
| `Extensions.triggerAction` on a browser session, **tab** target        | read               | taken   | runs    |
| the same, then a navigation to `?next` on the same origin              | read               | taken   | runs    |
| the same, then a navigation to `http://localhost`, another origin      | withheld           | refused | refused |
| the same, without `--enable-unsafe-extension-debugging`                | read               | taken   | runs    |

- **A refused capture says** « Either the '<all_urls>' or 'activeTab' permission is required. »
  Two captures less than a second apart are refused for another reason,
  `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`: a measurement waits a second between them.
- **`Extensions.triggerAction` wants the tab target.** On a session of the page it answers
  « Method not allowed ». On the browser session, with the id of the page target, it answers
  « Action can only be triggered on a tab target ». The tab target comes from `Target.getTargets`
  with the filter `type: 'tab'`, found by its address: the driver throws when two tabs show it.
- **Playwright 1.58.2 does not type the method.** Its `protocol.d.ts` knows `Extensions.loadUnpacked`,
  `uninstall` and the storage methods only. The browser has it; `triggerAction` of the driver types
  the call.
- **`Extensions.getStorageItems` is of no use here**: « No associated browser context » on the
  browser session, « Extension not found » on a session of the page.
- **A key of the browser still reaches no command.** Playwright and `chrome.debugger` both send
  their keys to the renderer of the page, through the same `Input` domain, and the browser catches
  a command before that. The key gesture of FRU-291 stays proved by its parts only
  (`extension-shortcut.spec.ts`): the key installed, and the message that `runShortcut` sends.
- **The extension declares no entry in a context menu**, so no menu gesture grants anything. The
  native menu is out of reach of automation; not measured.

### What the bench does not cover, and why

- **The permission prompt of a site.** The copy declares the playground and the worker, because
  automation cannot answer the prompt (FRU-45).
- **The keyboard shortcut as a gesture**, measured above: no automated key reaches a command.
- **The auto-update 0.2.0 → 0.3.0 in an open browser.** Not built: the bench loads unpacked copies,
  and no update path was measured.
- **The side panel** beyond what `side-panel.spec.ts` reads: the bench opens none.
- **Firefox.** `web-ext` is not a dependency of the repository. `pnpm dlx web-ext@10.8.0 run`
  fetched it from the registry (so not offline), and loaded `firefox-mv3`, with host access to the
  playground, in Firefox 153.0: « Installed … as a temporary add-on ». Nothing was mounted and no
  note was sent: a person must add the rule in the page of the extension, and this machine has no
  driver for that Firefox. The Firefox of Playwright is a build of its own, and is not installed
  here. Whether Firefox grants a host permission of the manifest at a temporary install was not
  measured.
- **The fake Linear is not Linear.** It answers the operations `linear.ts` sends, keeps the issues in
  the order they come, gives every issue the state « Todo », and gives no comment. A change in the
  API of Linear does not reach it.
- **The second copy is loaded, nothing more.** What two copies do to one page is FRU-397; the bench
  gives that ticket its setup.

### From /tfp, or any Node script

Write the script anywhere, and run it from the root of the repository:

```js
// node /path/to/run.mjs, with the root of the repository as the current directory
const { startBench } = await import(`${process.cwd()}/e2e/bench.ts`);
const bench = await startBench({ headed: true });
try {
  const site = await bench.openSite();
  await bench.grantActiveTab(site);
  await bench.leaveNote(site, { text: 'From a script', attach: ['area'] });
  await bench.screenshot(site, `${process.env.OUT}/after.png`);
  console.log('TFP_REPORT', JSON.stringify(await bench.trackerReceived()));
} finally {
  await bench.close();
}
```

`startBench` needs the extension built (`pnpm ext:bench` builds it, and so does `pnpm e2e`). It
starts its own worker on a free port, so it runs beside `pnpm dev`; it uses the playground on 5177
when one answers. Node prints a warning about the type of `e2e/bench.ts`, and runs it.

## Safari (FRU-380)

### The rules, in short

- **One source, a third build**: `pnpm --filter @fruitback/extension build:safari` (`wxt build -b
  safari`, MV3) writes `.output/safari-mv3/`, and `pnpm --filter @fruitback/extension safari:xcode`
  (`safari-xcode.ts`) wraps it in an Xcode project, `.output/safari-xcode/`, with
  `xcrun safari-web-extension-converter`. The project is made again from the build each time and is
  not committed. Safari takes an extension only inside a macOS app, signed, from the Mac App Store or
  a notarised download: no archive goes to a store as for Chrome and Firefox.
- **No side panel on Safari.** `entrypoints/sidepanel/` is excluded from the Safari build
  (`manifest.exclude`), so its manifest has neither `side_panel` nor the `sidePanel` permission. The
  panel falls back as it does on a browser with no panel: « Show all notes in a sidebar » of the
  popup and the button of the widget open the list of the page (`openPanelOrPage`,
  `openPanelForTab`), and « Open notes in the sidebar » is not drawn in the preferences.
- **The manifest tells Safari its minimum, 16.4** (`browser_specific_settings.safari`, set by the hook
  `build:manifestGenerated` from `src/browser-family.ts`), and not the keys of Firefox. The app asks
  for macOS 11, the oldest macOS Safari 16.4 came out for.
- **The words that name a browser follow the build** (`src/browser-family.ts`): the shortcut row says
  « Change it in Safari Settings, Extensions. » (Safari has no `commands.openShortcutSettings` and no
  page an extension may open), the popup names « Safari Settings, Extensions » for another copy, and
  « Allow captures on every site » quotes no prompt, since Safari's words were not read.
- **No « Keep my rules in the account of this browser » on Safari**: Safari keeps `storage.sync` on the
  Mac and syncs nothing, so the row is not drawn (raised in review of #666).
- **No new permission.** The Safari manifest asks for the permissions of the Firefox one; Chrome's and
  Firefox's manifests are unchanged.
- **`e2e/safari-build.spec.ts` loads the Safari build in Chromium**, in `pnpm e2e`: its manifest, its
  preferences, and the list of the page from the button of the widget. Chromium gives no
  `chrome.sidePanel` without the permission, the same absence Safari has. It is not Safari.

### What Safari supports of what the extension uses

From `@mdn/browser-compat-data` 8.1.7 (read on 2026-10-28) and from the converter of Xcode 26.6,
which lists the keys of the manifest Safari does not know. Safari 26.5.2 is on this Mac.

| What the extension uses                                         | Safari                                                                                                                                                                                                                           | What the extension does                                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `sidePanel`, `side_panel`                                       | No. The converter: « not supported by your current version of Safari: sidePanel, side_panel ». No `sidebarAction` either.                                                                                                        | Not built for Safari; the list of the page instead.                                                                         |
| `optional_host_permissions`, `permissions.request` of an origin | 15.5 (MV3), 14. Safari asks from its own popover. Asking for `*://*/*` or `<all_urls>` lets the extension ask for an origin, and Safari then asks the person on each new site; a permission given and taken back is asked again. | Unchanged. Not measured in Safari.                                                                                          |
| `scripting.executeScript` with `world: 'MAIN'`                  | 15.4.                                                                                                                                                                                                                            | Unchanged.                                                                                                                  |
| `scripting.registerContentScripts` with `world`                 | 16.4. A report on the Apple forums (FB16590857, no Apple answer) says Safari ignores `excludeMatches`.                                                                                                                           | Covered if true: the bridge reads the hidden origins itself and posts `unmount` (FRU-444), so a hidden page stays bare.     |
| `storage.session`                                               | 16.4.                                                                                                                                                                                                                            | Unchanged: the pending sign-in stays in it.                                                                                 |
| `navigator.userActivation`                                      | 16.4.                                                                                                                                                                                                                            | Unchanged. The button of the widget never reaches a panel on Safari anyway.                                                 |
| `tabs.captureVisibleTab`                                        | 14. Its default format is JPEG, and `<all_urls>` is optional for it there.                                                                                                                                                       | The call asks for `png`. Whether Safari takes a capture with `activeTab` alone was not measured.                            |
| `contextMenus`                                                  | 14, as an alias of `menus`.                                                                                                                                                                                                      | Unchanged.                                                                                                                  |
| `commands`                                                      | 14; the person can change the key from Safari 26. No `commands.openShortcutSettings`.                                                                                                                                            | The row names Safari Settings, Extensions.                                                                                  |
| `runtime.getContexts`                                           | No.                                                                                                                                                                                                                              | Already optional (`openPopup` of the background asks without it).                                                           |
| `action.openPopup`                                              | 16.                                                                                                                                                                                                                              | Unchanged.                                                                                                                  |
| `storage.sync`                                                  | 14, but Safari does not sync it: it acts as `storage.local`.                                                                                                                                                                     | « Keep my rules in the account of this browser » is not drawn on Safari: it would promise a copy that never leaves the Mac. |
| `alarms`, `storage.local`, `tabs`, `windows`, `i18n`            | 14.                                                                                                                                                                                                                              | Unchanged.                                                                                                                  |

### What was measured, and what was not (2026-10-28)

- **Built**: the three builds; the Chrome and Firefox manifests are the ones of before. The
  converter of Xcode 26.6 warned of `sidePanel` and `side_panel` only, before they were removed.
- **`xcodebuild` builds the app**, unsigned (`CODE_SIGN_IDENTITY=-`), in Debug and in Release:
  `Fruitback.app` holds `Fruitback Extension.appex`, `com.apple.Safari.web-extension`, version 0.4.0,
  macOS 11. The converter writes three things wrong, which `src/safari-xcode.ts` corrects (tested):
  the id of the app capitalised (`com.sakuga-software.Fruitback`, and `xcodebuild` stops at
  `ValidateEmbeddedBinary`), the version `1.0`, and the macOS of the converting Mac (26.5).
- **Not run in Safari.** Safari loads an unsigned extension only after « Allow unsigned extensions »
  in its Developer settings, which asks for the password of the Mac and is undone each time Safari
  quits; this Mac has no signing identity. Playwright's WebKit loads no extension, and `safaridriver`
  was not tried. So nothing above that says « Safari does » was seen in Safari: the table is what
  `browser-compat-data` says.

### Signing and publishing: the steps for the owner of the Apple account

The repository signs nothing and uploads nothing to Apple. What it needs, once:

1. **The Apple Developer Program** (99 USD a year) for the organisation, and **Xcode** on a Mac.
2. **The ids**, in Certificates, Identifiers & Profiles: `com.sakuga-software.fruitback` (the app)
   and `com.sakuga-software.fruitback.Extension` (the extension). Change `SAFARI_BUNDLE_ID` in
   `src/safari-xcode.ts` if another id is wanted.
3. **The app in App Store Connect**, macOS, with that id: its name, its privacy answers (the same
   data as the Firefox declaration of FRU-333), a privacy policy URL, screenshots of the extension in
   Safari, and a category.

Then, for each version:

1. `pnpm --filter @fruitback/extension build:safari && pnpm --filter @fruitback/extension safari:xcode`.
2. Open `.output/safari-xcode/Fruitback/Fruitback.xcodeproj`; in **Signing & Capabilities** of both
   targets, choose the team, with « Automatically manage signing ».
3. **Try it first**: Run (⌘R) opens the app; in Safari, Settings, Extensions, turn on Fruitback, and
   give it access to a site. Then the /tfp of the panel fallback, by hand: the popup's « Show all
   notes in a sidebar » must open the list in the page.
4. **Product → Archive**, then **Distribute App → App Store Connect → Upload**. In App Store Connect,
   add the build to a version, and submit it for review.
5. Outside the App Store (a notarised download): **Distribute App → Developer ID**, then the
   notarisation of Apple. Not needed for the App Store.

A job of CI that signs and uploads (`xcodebuild archive` and `xcrun altool` or the App Store Connect
API, with a certificate and a key in secrets) is a later ticket: a new workflow, so a critical PR.

## Releasing the extension (FRU-329)

### The keys, made once

The job `submit` reads these from the GitHub environment `stores` (**Settings → Environments**).

1. **The environment.** Create `stores`. In **Required reviewers**, add the person who approves a
   release. In **Deployment branches and tags**, allow the branch `main`, for
   the check below, and the tags `v*`.
2. **The Chrome Web Store, with a service account** (API v2).
   - In Google Cloud, enable the **Chrome Web Store API**, then create a service account and a JSON
     key for it.
   - In the developer dashboard of the Chrome Web Store, under **Account**, add the e-mail address of
     the service account.
   - Variables of the environment: `CHROME_EXTENSION_ID` (the id of the item), `CHROME_PUBLISHER_ID`
     (the id of the publisher, in the address of the dashboard), and
     `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL`.
   - Secret of the environment: `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY`, the `private_key` of the JSON
     key, with real line breaks and not `\n`.
3. **AMO.** On addons.mozilla.org, under **Developer Hub → Manage API Keys**, make a key.
   - Variable of the environment: `FIREFOX_JWT_ISSUER`.
   - Secret of the environment: `FIREFOX_JWT_SECRET`.
4. **The check.** Start **Release extension** by hand (`workflow_dispatch`) on `main`, and approve
   the run. Each store must answer with a token. The run uploads nothing.

### A release

1. Raise `version` in `apps/extension/package.json`. A store refuses a version that is not higher
   than its last one.
2. Merge, then publish a release `v<version>` on GitHub, with a new tag on that commit (`packaging.md`).
3. `ci`, `package` and `attach to the release` run. Then `submit` waits for the approval: check the
   archives on the release, then approve.
4. Google and Mozilla review the version. Google keeps a reviewed version until somebody presses
   « Publish » in the dashboard (`STAGED_PUBLISH`).
5. A new permission in the manifest needs a reason in the dashboard of each store, and a change of
   the journey can need new texts or screenshots. The job sends neither.

WARNING: a new archive during a review starts the review again. Wait for the end of one review
before you push the next tag.

## The gallery of the extension (FRU-523)

### The rules, in short

- **`apps/extension/gallery/` draws every state of the popup, the welcome page and the side panel**,
  each with its own view of `src/` and the sheets of its entrypoint, on made-up data
  (`gallery/states.ts`). `pnpm --filter @fruitback/extension gallery` serves it on
  http://localhost:5179/gallery/. A page shows all the states of its surface; `?state=<id>` shows
  one alone, as the page of the extension draws it.
- **It is served at https://gallery.fruitback.com**, so the widget of Fruitback can run on it: the
  pages of the extension are `chrome-extension://`, where no widget runs, and a note cannot be left on
  them. The extension mounts the widget there, as on any site of a workspace: the gallery embeds
  nothing. Dokploy builds `apps/extension/gallery/Dockerfile` from `main`.
- **A new screen, or a new state of a screen, gets an entry in `gallery/states.ts`.**
  `src/gallery.test.ts` builds each entry; it does not see a state that has no entry.
- **Not there:** the options page and the rule editor of the popup, which their entrypoints build
  with no function to call, and the widget itself.

## « Fruitback 0.6.0 is out », in the popup and the page (FRU-519)

### The rules, in short

- **Only an install that no store updates says it.** `management.getSelf().installType` is
  `development` for a folder loaded by hand and for Firefox's temporary add-on, `sideload` or `other`
  for an archive another program put there: those ask. `normal` (a store) and `admin` (a policy)
  update on their own, and ask nothing. `getSelf` needs no permission, in Chromium and in Firefox.
- **The source is the last release on GitHub**, `releases/latest`, the page `reviewing.md` sends a
  reviewer to for the archive. Its API answers any origin, so the request needs no host permission.
  Once a day at most, kept in `storage.local` under `latestRelease`; an error of the network keeps
  what was known and shows nothing new. A link that is not a page of the releases of the repository
  is not shown. `src/update-notice.ts`, held by `update-notice.test.ts`.
- **Not the worker:** `/health` and the routes of a session say no version, and the private mode has
  no worker. **Not `runtime.requestUpdateCheck`:** it asks the store of the install, which a folder
  loaded by hand does not have, and Firefox does not have it.
- **One line, `updateLine` of the kit**: the muted grey, the link in the accent in a target of 44 px,
  `role="status"`. Above the foot of every screen of the popup, and under the version in the menu of
  the page.
