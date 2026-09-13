# The worker, and where a seed is stored

The Node service, who may read a pin, and the store interface — what `SeedStore` is, who validates a
connector's environment, and what a second connector with no markdown body actually proved.

## The worker

- It exists for exactly one reason: the Linear API key cannot ship in client-side JS. Resist putting
  logic here that belongs in the widget or in Linear.
- **`app.ts` is transport-agnostic** — a `handleRequest(request, env, context)` over web
  `Request`/`Response`. `server.ts` adapts `node:http` onto it and `main.ts` starts it. Keep new
  behaviour in `app.ts` so it stays testable without opening a socket.
- The env is validated up front (`readConfig`), so a missing secret surfaces at boot and on
  `/health`, not as an opaque Linear error per request.
- `POST /feedback` re-canonicalizes `seed.page.url` server-side. The read path finds seeds by
  matching that URL inside the description, so a client that skipped normalization would plant a pin
  nobody can find again. `GET /feedback` canonicalizes its `url` parameter for the same reason.
- **The `description contains` filter is a substring match**, so `/pricing` also matches the seeds of
  `/pricing?tab=annual`. `fetchSeedIssues` therefore re-checks `seed.page.url` exactly before
  returning an issue — dropping that check silently mixes two pages' pins.
- The read cache (`cache.ts`) holds the in-flight promise, not the value, so a burst of visitors on
  one page costs one Linear call. Failures are evicted at once: an outage must not be served for the
  whole TTL. In-process, therefore per replica — same caveat as the rate limiter.
- Failure codes are deliberate: `400` the caller's fault, `403` origin not allowed, `413` oversized
  body, `429` rate-limited, `500` misconfigured, `502` `store-unavailable` (the widget should keep the
  note and retry), `401` the read needs an identity. `/health` answers `503` when misconfigured so a
  bad deploy is never routed to. **A code the widget reads is a promise**, so it names a role and
  never a vendor — `linear-unavailable` became `store-unavailable` with SKG-522 for that reason.


## Who may read a pin

- **`GET /feedback` used to answer anyone who could build the URL.** Every note, its author and the
  team's replies were readable by any visitor of the client's site, and by `curl` — which is why
  hiding pins in the browser was never the fix. `read: 'public' | 'authenticated'` is (SKG-533), per
  client in `FRUITBACK_CLIENTS` or worker-wide via `FRUITBACK_READ`.
- **The extension is a different problem.** It settles *visibility* — the pins leave the visitor's
  DOM. It settles nothing about *authorisation*: the endpoint stays open and `curl` still works.
  Building SKG-534 without this ticket hides the comments in the UI and leaves them in the API.
- **`authorizeRead` runs before `cached`, and the guard is `stub.calls`, not the status code.** A
  gate moved below the cache still returns `401`, so asserting the status cannot tell the two apart
  — it was measured passing against exactly that mutation. What it costs is a Linear call per
  unauthorised request, so the test that pins the position asserts **no call reached Linear**. The
  warm-cache test is a narrower guard: it catches a cache-hit fast path that answers before the gate.
- **`public` stays the default, and that is compatibility rather than security.** Defaulting to
  `authenticated` would blank the pins on every upgraded worker with no error anywhere, and the
  operator would hear about it from users. The exposure is made *sayable* instead: the boot log names
  every client whose pins anyone can read, `/health` counts them. Loud beats silent both ways.
- **`/health` carries a count, never the ids.** It needs no authentication either, so listing client
  ids would hand over the map the worker serves. The boot log names them, where only an operator looks.
- **A client that requires a token and has no key to check one is refused at boot.** The trap is
  inheritance: `read` is inherited from the worker-wide default, `identitySecret` deliberately never
  is, so flipping `FRUITBACK_READ` can make a client unreadable without its own entry changing.
  `unreadableClients` names them; the alternative is a permanent `401` that looks like a broken widget.
- **A `401` on a read leaves the pins where they are.** Same rule as an unreachable worker: losing
  what is correctly on screen reads as "my notes are gone". Mutation-tested — blanking on a failed
  read fails `embed.test.ts`.
- The switch is applied in **`toSeedIssue`**, which both the real Linear and the in-memory one go
  through, rather than only through the query's `first:` argument. `first: 0` is an assumption about
  what Linear accepts, and this promise should not rest on a backend behaving a particular way.
- **A comment body is `textContent`, never markup.** It is Linear markdown written by anyone who can
  comment on the issue, rendered inside someone else's page; treating it as HTML would make the
  feedback widget the way into their site.
- Sorted oldest-first in the worker, because Linear answers newest-first and a conversation reads the
  other way. Capped at `COMMENTS_PER_ISSUE` — a longer thread belongs in Linear, which the pin links
  to.


## The team's replies

- **Comments come from Linear on every read** (SKG-502), and close the loop: someone leaves a note,
  the team answers in the issue, and the answer appears where the note was left rather than in an
  inbox the reporter does not have.
- **Absent and empty mean different things.** No `comments` field at all means the worker was not
  asked for them, and the widget says nothing; `[]` means it asked and there were none, and the
  widget says so. A client with replies switched off must not read as a team that never answered.
- **`showComments` is on by default and is a real switch**, per client or worker-wide
  (`FRUITBACK_HIDE_COMMENTS=1`). Under `read: 'public'` it is the only thing between an issue thread
  and anyone who can load the client's page; under `read: 'authenticated'` (SKG-533) it is back to
  being the editorial choice it should always have been, because the reader is someone the worker
  checked.


## Where a seed is stored

- **`store.ts` is the interface, and it existed before it was named** (SKG-522). `app.ts` used to
  select between the real and the in-memory module through
  `Pick<typeof realLinear, 'createSeedIssue' | 'fetchSeedIssues'>` — two methods, two
  implementations, an interface discovered by accident. `SeedStore` writes it down so SQLite
  (SKG-524) and GitHub (SKG-525) are implementations rather than new branches.
- **`findForPage` states the intention, not the method.** Linear filters server-side with
  `description: { contains: … }`, GitHub searches bodies, SQL does a `WHERE`, and a store with no
  search would walk everything. Exposing a `contains` filter on the interface would have made
  Linear's trick the contract.
- **The old `Routing` mixed two things, and the split is the point.** `ClientPolicy` — `showComments`,
  `identitySecret`, `read` — is what the *worker* decided, whatever store is behind it. `teamId` and
  `projectId` went to `linear.ts`, where a team means something. `resolveClient` hands the client
  entry on whole, and **each store reads its own fields from it**.
- **`store.scope(client)` is what took `teamId` out of the read cache key.** The worker was building
  its key from `routing.teamId`, so the read path knew that stores route by team. Only the store
  knows what identifies a tenant — a team for Linear, an `owner/repo` for GitHub, nothing for a
  single-file SQLite. The client id stays in the key regardless, which is what keeps two clients
  sharing one team from sharing an entry.
- **`linear-memory.ts` is a `SeedStore` now but keeps importing `toSeedIssue` from the real
  connector, on purpose.** That coupling is the feature: an issue is stored as the description
  `buildIssueDescription` produces and read back through production's own mapping, so a broken round
  trip breaks the playground too. Renaming the file to something provider-agnostic would advertise an
  independence it should not have.
- **The store is built once per process, by the transport.** `createFruitbackServer` constructs it
  and every request gets it through `RequestContext`. It began as `storeFor(config)` inside the two
  handlers, which is invisible for Linear and the in-memory one — both stateless closures — and
  would have opened a SQLite connection per request the moment SKG-524 landed. Caught in review, not
  by a test, because nothing observable was wrong yet. The tests that hold it now assert the handler
  used the store it was **given**: a Linear stub left untouched is the proof it built none of its own.
## Which store, and who validates it

- **`FRUITBACK_STORE` selects the connector, and each connector validates its own environment**
  (SKG-526). SKG-522 named the interface but left the worker Linear-shaped anyway: `WorkerConfig`
  carried `linearApiKey`, `linearTeamId` and `linearProjectId`, so every module that could read the
  config could read one provider's credentials — and `readConfig` checked those three for **every**
  deployment, so a SQLite worker (SKG-524) would have been refused at boot for a missing Linear key.
- **What the worker keeps of a store is a name and a way to build one.** `StoreConfig` is
  `{ provider, create() }` and nothing else; a test asserts exactly those two keys, so the next
  provider's fields cannot arrive here either. `storeFor` is now one line.
- **`store-config.ts` is the mechanism, `stores.ts` is the registry**, and they are two files because
  the connectors import `defineStore` — holding the list in the same file would make it and
  `linear.ts` import each other. A new store is one entry in `STORE_SPECS`.
- **A store names its own environment variables.** `envNames` is required per field, so a boot
  diagnostic says `LINEAR_API_KEY` and never `apiKey` — mutation-tested, and the mutation also trips
  three older tests, which is how load-bearing that diagnostic is. `never reports a field name from
  any store` asks it of every spec rather than of Linear.
- **An unknown provider and a dev-only one in production are both refused, never defaulted.** A typo
  falling back to Linear would send a worker configured for SQLite to an API it has no key for; and
  feedback accepted into RAM behind a green health check is worse than a worker that will not start.
  That second guard is the one thing this ticket had to generalise without loosening.
- **`FRUITBACK_FAKE_LINEAR=1` still works, and it *degrades* where `FRUITBACK_STORE=memory` is
  refused.** The asymmetry is deliberate: a flag a container inherited must not stop it serving
  production, while a provider somebody deliberately named must not be silently swapped for another.
  So the sugar falls back to the real store and says so in the log; the explicit selection is refused
  at boot. `pnpm dev` and the E2E suite use the new spelling, which is what keeps the selection path
  exercised outside the unit tests.
  - **The deprecation warning it shipped with fired only when the flag lost** (SKG-581), which is the
    inverse of who it is for: the operator who needs to hear it is the one the variable still works
    for, and that deployment booted in silence. There are now two halves and they are exhaustive —
    `fakeLinearIgnoredReason` when it got the process nowhere, `fakeLinearDeprecationNotice` when it
    selected the memory store or when an explicit `FRUITBACK_STORE` took precedence over it and the
    line is simply stale. **Precedence, not use**: an explicit `memory` is refused under
    `NODE_ENV=production`, so a notice claiming the store was selected printed directly above the
    boot failure that refuses it. That last state was silent on **both** halves before, because neither owned it.
  - `server.ts` opens a socket and has no test, so the boot line is asserted on its **source**, the
    way `embed.test.ts` asserts the widget's transport. Without that, deleting the `console.warn`
    leaves every case of the notice green and the warning reaching nobody — the shape of defect this
    repository keeps paying for.
  - The reason the flag is kept alive is the `.env` files and compose stacks that predate SKG-526.
    **No script, package manifest or workflow here selects a store with it** — `store-config.ts`'s own
    docstring said it was in `apps/worker/package.json` and the CI workflow for a round after that
    ticket moved both. The tests still set it, deliberately: `stores.test.ts` covers the flag itself,
    and `app.test.ts` covers what a container inheriting it does under `NODE_ENV=production`, which
    an explicit `FRUITBACK_STORE=memory` cannot stand in for because it is refused outright.
- **`/health` answers `store: '<provider>'` instead of `fakeLinear: true`**, always. Which store a
  process runs on is exactly what an operator cannot tell from a green check, and naming one provider
  in the answer was the last place the endpoint assumed there was only ever one. Compared exactly in
  `app.test.ts`, on purpose: this endpoint is public, so a field appearing on it has to be written
  down.
- **A short `FRUITBACK_IDENTITY_SECRET` used to answer `missing:` and then nothing.** The field failed
  the schema, matched no entry in `NAMES_BY_FIELD`, and the list came back empty. Fixed in passing
  here, and `answers no empty diagnostic` walks every way of making the config invalid rather than the
  one that was noticed.
- **Still Linear-shaped in one place, and left there on purpose**: `apps/worker/src/linear-memory.ts`
  keeps its name and its import of `toSeedIssue`. See *Where a seed is stored* — that coupling is the
  feature.

## SQLite, and what a second connector actually proved

- **`sqlite.ts` is the connector that had to be uncomfortable** (SKG-524). One implementation of
  `SeedStore` proved nothing; GitHub Issues would have proved almost as little, since markdown bodies,
  labels and full-text search are Linear's shape under another name. SQLite shares none of it — no
  description, no `contains` filter, no labels, no workflow states.
- **It found exactly two places the interface leaked, and both were ours.** `SeedIssue.url` was
  required, and the only way to satisfy it was to invent a URL for a store with no web page; it is
  optional now. And the widget's thread said **"sur Linear"** — a vendor name in a widget that is not
  supposed to know which store answers, the same defect `store-unavailable` fixed in the error codes.
  Everything else fitted, which is the result the ticket was for.
- **`findForPage` gets to be a plain equality here**, where Linear can only filter by substring and
  re-checks afterwards. That is the payoff of naming the intention rather than the method.
- **The connection is shared per path, and the store object is not.** `handleRequest` still falls back
  to building a store when the transport did not hand it one, so without the shared handle that path
  opens a database per request — the hazard SKG-522 was written to prevent. The test asserts **how
  many handles were opened**, not `connections.size`: the map is keyed by path, so a `connect` that
  stopped reusing overwrites the entry and leaves the size at one. Both weaker spellings were measured
  passing against the mutation before this one was written.
- **There is nothing to project onto `SeedStage`.** The column *is* a stage, so `stageOf` only applies
  the contract's own tolerance — an unrecognised value colours the pin rather than hiding the note.
- **A row is parsed, never trusted.** The file sits on a volume an operator can edit and a restore can
  be older than the code. A malformed row costs that one pin; the page keeps its other notes.
- **`insert` and `select` are `async` so a failure to open the file rejects rather than throwing
  synchronously.** `connect` throws before any `await`, and `app.ts` happens to catch it either way —
  but a caller reaching for `.catch()` would have been bypassed on the one path that matters, a volume
  nobody mounted.
- **`sqlite3` is in the runtime image for one reason: the backup line in
  [self-hosting.md](../self-hosting.md)** (the README until SKG-519 moved it). The store needs
  nothing installed; `.backup` needs a binary, and it is the only safe way to copy a live database.
  Measured in a container: `fruitback.db` was 4 KB while `fruitback.db-wal` held 53 KB, so a `cp`
  of the `.db` alone would have lost the note that had just been planted.
- **Verified in the container, not only in `node --test`**: boot on `FRUITBACK_STORE=sqlite`, `/health`
  answering `store: sqlite`, a seed posted and read back, the pin surviving `docker restart`, and the
  documented backup command producing a file that holds the seed.
- **`resolveClientIp` is security-relevant.** `X-Forwarded-For` is appended to by each proxy, so the
  left of the chain is caller-controlled and forgeable; the client IP is the entry
  `TRUSTED_PROXY_HOPS` from the **right**. Reading the leftmost entry — correct behind Cloudflare,
  wrong behind Traefik — makes the rate limit bypassable with one header.
- **`FRUITBACK_CLIENTS` makes one worker serve several client sites** (SKG-504). It maps a
  `clientId` to a team, a project and the origins that client may be embedded on. Absent, nothing
  changes: one team, one project, `client` optional on a read.
- **Configured, a client has to be named on both paths** — the `client` parameter on a read,
  `seed.client.id` on a write — and an unknown one is refused. A read that named nobody used to
  answer with every seed on that URL, which on a shared worker is one client reading another's
  feedback; a write that names nobody would land in the default team, which is the same leak facing
  the other way. The read cache key carries the team for the same reason.
- **`normalizeClientId` runs before the id is used for anything**, and that ordering is the whole
  point. The id does three jobs — it picks the route, it builds the `fruitback:<id>` label a read
  filters on, and it keys the cache. Normalising it for the route alone put a note in the right team
  under `fruitback:  acme  ` while its owner's clean read asked for `fruitback:acme` and found
  nothing: authorised at both ends, invisible in between. The write path normalises it into the seed
  the same way it re-canonicalises `page.url`, and for the same reason.
- **`clientId` is client-asserted**, and SKG-498 did not change that: identity tokens say who the
  *reporter* is, not which client the page is. `origins` is what turns the claim into something
  checkable against the browser's own header — the trust level CORS gives, and strictly more than
  nothing. Do not describe it as authentication.
- A malformed `FRUITBACK_CLIENTS` is refused at boot rather than ignored, and named on `/health`.
- The rate limiter is in-process, therefore **per replica**. Scaling to N containers multiplies the
  effective ceiling by N; a shared store is the fix if that ever matters.
- Tests drive `handleRequest` with plain `Request` objects against a stubbed Linear
  (`linear-stub.ts`); no container needed. The assertion that matters most is that the stored
  description parses back into the exact seed that was posted.
- **`reporter.verified` is the worker's word, never the client's** (SKG-498). Anything arriving with
  that flag has it stripped, whatever else it says: without that, a browser posting
  `reporter: { name: 'CEO', verified: true }` reads in Linear exactly like an identity this worker
  checked. `identity.ts` sets it only after verifying a **standard compact JWT (HS256)** against the
  client's `identitySecret` (or `FRUITBACK_IDENTITY_SECRET` on a single-client worker), so a client
  site mints one with whatever library it already has.
- **`alg` is asserted against the token, never read from it.** That interoperability is what makes
  the header an attack surface: a verifier that trusts the token's own algorithm accepts `alg: none`
  and validates everything. Anything but `HS256` is refused before a byte of the signature is looked
  at, and the signing input is `header.payload` so swapping the header breaks the signature. Both are
  tested, and both tests fail if the check is removed.
- **The identity token arrives in an `Authorization` header, never in the seed.** The seed is stored
  verbatim in an issue description anyone with workspace access can read, so a credential in there
  would outlive its expiry by months.
- A token that fails to verify is a **401**, not a downgrade to anonymous: a site that meant to
  identify someone and got it wrong should hear about it, rather than have a broken integration go
  unnoticed for a month. No token at all is fine and stays the default.
- `exp` is **required** in the claims — a token that never expires is a password. Signatures are
  compared in constant time, because a `===` on the base64 leaks how much of it was right.

## The markdown codec, and the file that outlived its name

- **`markdown-description.ts` holds "put a seed in a markdown body and keep the issue readable"**
  (SKG-523) — `buildIssueTitle`, `buildIssueMetadata`, `buildSeedBlock`, `buildIssueDescription`,
  `parseSeedFromDescription` and `pageQueryTerm`. None of it was ever Linear's; every issue tracker
  worth connecting to stores a markdown body and lets something search it.
- **It is a strategy connectors share, not part of `SeedStore`.** Putting it on the interface would
  have obliged a store that has columns to implement a codec it has no use for — and `sqlite.ts` is
  the standing proof that such a store exists. A connector picks this up; it is not required to.
- **`pageQueryTerm` moved with it, and that is the reason it is a separate point.** The term works
  only because `buildSeedBlock` writes the canonical URL verbatim into the JSON — a property of the
  *writer*, not of any provider. Beside the code that makes it true, it cannot drift from it.
- **The round-trip test travelled with the code rather than being rewritten**, which is what the
  ticket asked for and what makes the move provable: 44 shared tests before, 44 after, and
  `parseSeedFromDescription(buildIssueDescription(seed)) === seed` is still the same assertion on the
  same fixture.
- **`linear.ts` became `issue.ts`, because the name had outlived what it described.** SKG-516 took
  Linear's workflow states out of it, SKG-517 took the words a human reads, and this ticket took the
  codec. What was left — a label, a ripeness, and the shape of what a read answers — names no
  provider at all. `apps/worker/src/linear.ts` keeps its name: over there, a team really is Linear's.
- **Nothing outside the package had to change**, because every consumer imports through the
  `@fruitback/shared` barrel rather than from a file. That is the property that made the rename cost
  one line in `index.ts`, and it is worth not losing.
- The guard that proves it is `package.test.ts`'s `type-checks an import with no special tsconfig`:
  it deletes every `dist`, packs all three packages and type-checks an import with `skipLibCheck`
  **off**, so a renamed file that broke the published declarations fails there rather than in a
  consumer's build.


## The extension's session

- **The reviewer is not a visitor who typed a name** (SKG-535). SKG-498 defined `reporter.verified`
  and left nothing able to set it on this side: a client site could mint an identity token, and the
  extension could not. A session is what finally makes that flag the worker's own word.
- **The operator vouches, and the code carries who for.** A pairing code is minted *for* Alice, with
  her name and address in it. The alternative — the extension supplying a name at pairing time — is
  the browser asserting an identity again, which is the hole SKG-498 was written to close. It was
  rejected for that reason and not on ergonomics.
- **The access token is an ordinary identity token, and that is the whole economy of the design.**
  `identity.ts` already mints and verifies HS256 JWTs, and both request paths already check them. A
  session that mints the same shape adds no second verification path, and `read: 'authenticated'`
  (SKG-533) started accepting the extension with no change to a single line of the read path.
- **Rotation was refused once, and then built** (SKG-600). It needs a grace for the answer that never
  arrives, and until SKG-599 there was no client half to measure that against. There is now, and the
  measurement changed the design — see *Rotation, and the grace that is not a clock* below.
- **No OAuth, no identity provider, no user table.** Every decision leans on "one administrator, one
  container, no third party". An authentication flow assuming an identity provider makes the project
  unselfhostable in practice, which is the one thing this store was added to avoid.

- **The site allowlist does not reach these routes, and that is a decision rather than an oversight.**
  `ALLOWED_ORIGINS` lists the client sites the widget is embedded on. An extension is not one: its
  origin is `chrome-extension://<id>`, and that id changes when an unpacked build becomes a store
  build — so an operator who listed it would find pairing broken on the day they published. Probed
  against this worker before `openCors` was written: with a normal allowlist, the POST answered
  `403 origin-not-allowed` and so did the preflight. What makes the exemption safe is that these
  three routes carry no ambient authority at all — there is no cookie to ride on, the pairing code is
  a secret the caller must already hold, and the refresh token lives where no page can read it. The
  rate limiter is what stops the pairing endpoint being guessed at.

### What review found, and what it narrowed

- **The redemption is one transaction, not one statement.** Marking the code spent and then failing
  to insert the session — a full volume, a locked file — burns the only code the reviewer has, and
  the retry answers `code-spent-or-expired`, which is true and useless. Unlike the atomicity of the
  spend, this guard *is* observable: the test makes the insert collide on `sessions.token_hash`,
  which is a real failure inside the transaction rather than a raced one.
- **A row is parsed, never trusted — and SQLite narrows what can arrive.** The first version of that
  test asserted an integer `subject`, and it failed: the column has `TEXT` affinity, so `42` comes
  back as `"42.0"` and never reaches the guard as a non-string. Measured. What does reach it is a
  **BLOB**, which keeps its type, and an empty string, which `NOT NULL` holds quite happily. The
  guard is right; the example behind it was not.
- **The body cap was defeated twice over in one line.** `request.text()` buffers the whole upload
  before anything is measured, and `.length` counts UTF-16 units rather than bytes — so a multibyte
  body passed a cap it had already crossed. `readBoundedText` already existed on the feedback path
  and does both correctly; the session handler had quietly reimplemented a weaker version of it.
- **A session store that cannot be opened raises `StoreError` now.** It threw a plain `Error`, which
  `handleSession` had nothing to map, so a missing volume became a bare `500` with no CORS headers —
  unreadable by the extension, and indistinguishable from a bug.
- **`node src/main.ts pair` is a command nobody can run.** The image copies `dist/server.mjs` and no
  source at all, so the documented path fails with a missing file. `node server.mjs pair` is the
  spelling, checked by running it against a real build. The whole argument for minting being a
  command rather than a route rests on that command existing.
- **An unknown flag is refused.** `--emali alice@acme.dev` minted a code whose session carried no
  address, and the operator had no way to know.

### What the tests hold, and one they could not

- **Revocation is mutation-tested.** `findSession` is gone since SKG-600 — every read of a session
  rotates it, so there is no lookup beside `rotateSession`. Dropping `revoked_at IS NULL` from
  `revoke` still fails `revokes on the worker, so the refresh token stops working everywhere`, and
  dropping the chain revocation from `revokeSession` fails `ends the whole chain on log out, not only
  the token it was handed` and `ends a chain from any link, including the token nobody is holding`,
  and not inheriting `root_hash` on the successor fails nine tests at once.
- **The CORS exemption is mutation-tested.** Replacing `openCors` with the ordinary `resolveCors`
  fails both `answers an extension origin that is on no allowlist` and `lets the preflight through,
  or the POST never happens`. What says the exemption is not a hole in the gate is
  `leaves the allowlist in force on /feedback for sites, and admits the extension`: an ordinary site
  origin that is on no allowlist is still refused there.
  - Two of those three names were quoted here **truncated**, and the second was quoted with a
    sentence that had stopped being true. The exemption was scoped to `/session/` when this was
    written; SKG-596 widened it to every route, because the relay calls `/feedback` from the service
    worker. The test was renamed to say so and this paragraph was not. Found while fixing a third
    stale test name a reviewer caught on this ticket — `grep` for a quoted name is the check, and
    nothing runs it.
- **The rate-limit move is mutation-tested.** Putting `checkRateLimit` back below the path dispatch —
  where it sat before this ticket — fails `meters the pairing endpoint, not only /feedback`. The
  unknown-path test stays green under that mutation, because it guards a different ordering.
- **Nothing in this process can prove the redeem is atomic.** `redeemPairing` marks the code spent in
  one `UPDATE ... WHERE redeemed_at IS NULL` and acts on `changes === 1`, which is right for two
  workers on one volume or an asynchronous driver later. But `DatabaseSync` is synchronous and the
  store awaits nothing between its read and its write, so two redemptions cannot interleave here
  however they are scheduled: a `Promise.all` over three of them passes against a read-then-write
  store too. Measured. The concurrency test that claimed to guard this was deleted rather than kept
  green, and the reason is recorded beside the code.
- **The digest guard reads the `-wal` file too.** A row just written is in `sessions.db-wal` and
  nowhere else, so a check that read only the `.db` would pass against a store writing codes in the
  clear. Same trap as the seed store's backup note, arriving from the other side.

### What this deliberately does not do

The extension half — `chrome.storage.local` for the refresh token, `chrome.storage.session` for the
short access token, and the background refresh — is **not** here. The two halves have different
verification stories: this one is fully covered by `node --test`, and the other needs a real Chromium
with an extension loaded, which SKG-538 exists to build and which does not exist yet. Shipping them
together would let the half nobody can test ride in on the half that is.

Per-client session minting is absent for a stated reason rather than an accidental one: a session
signs with the worker-wide key, and a worker with `FRUITBACK_CLIENTS` ignores that key. The pair is
refused at boot instead of shipping a feature that pairs successfully and then answers `401` to
everything. That belongs with team mode (SKG-596), where a request carries a client id.

## Rotation, and the grace that is not a clock (SKG-600)

A refresh token that never changes is a thirty-day password. A copy taken from a browser profile
stays good for the rest of that month, and nothing observes the theft. Rotating on every refresh
makes its use **visible**.

It does **not** make the copy useful for at most one cycle, which is what this paragraph said until a
reviewer read it properly. A refresh token is a bearer credential and whoever presents it is served.
Inside the grace each presentation of the spent token revokes the successor the one before it
minted, so it is the **last** presenter who ends up with the live chain: a thief who gets in after
the real client takes the session and the client's own token is revoked under it. The first version
of this paragraph said *first*, which is the opposite of what the code does. Measured, and kept as a
test — `serves whoever presents last inside the grace, until the earlier holder comes back`. What rotation guarantees is that the two cannot both
keep the session quietly, which is a detection property and not a lifetime one.

### The ticket asked for a replay window. Two measurements said no.

The ask was that a rotated token stay accepted for *a few tens of seconds* and hand back **the same**
successor, so a client whose answer was lost lands on its feet.

Neither half survived contact:

- **The same successor cannot be handed back twice.** Only its SHA-256 digest is stored, which is the
  property that makes a copy of this database useless — and `session.test.ts` reads the bytes SQLite
  wrote, the `-wal` file included, to prove it. Answering the same token again means keeping it in
  the clear, or encrypting it with a key and reviewing a second piece of hand-written cryptography.
- **A few tens of seconds is far too short for this client.** The extension retries a failed refresh
  after `RETRY_DELAY_MS`, which is five minutes. A window of thirty seconds would expire before the
  only retry it exists to catch.

### What replaced it: usage, with a ceiling

**A predecessor is retired the moment its successor is used**, and that needs no clock at all — a
successor being presented is proof the client received it. Until that happens the predecessor stays
usable, because the client may be holding nothing else.

The ceiling is for the case that has no such proof: the answer was lost, so the successor will never
be used by anybody. `ROTATION_GRACE_SECONDS` bounds how long the predecessor then stays live, and it
is **derived** from the extension's own worst case — `REFRESH_MARGIN_MS + RETRY_DELAY_MS` — rather
than chosen. A test reads both out of `apps/extension/src/session.ts` and checks the sum, because
either of them moving would leave a window too short for the retry it was written for, with both
suites still green on their own.

A retry inside the ceiling rotates **again** and revokes the successor nobody received, so one token
never has two live successors.

### Reuse is the signal, and the chain is the answer

A revoked token presented while something in its **chain** is still live: two parties hold tokens
from one chain, so one of them copied theirs. Every live token in the chain is revoked, not only the
one presented — a thief who keeps the session while the victim is locked out is the outcome worth
preventing.

The test was `revoked && rotated` for two rounds, and it was wrong twice over. It read a logout as a
replay — revoking a token whose refresh answer was lost marks exactly that combination with nobody
having replayed anything — and it missed the case that mattered, where the token a thief leaves
revoked under the client was never rotated at all. Asking the chain is stricter *and* simpler:
after a logout nothing in the chain is live, so a logout stops reading as a replay on its own.

Both mistakes were raised in review, one round apart. See *the hole the grace left* below for the
second, which is the one that cost something.

The same review found the defect underneath: **`revokeSession` revoked only the row it was handed.**
After that lost answer, a logout ended the predecessor and left its successor live for the rest of
the thirty days — held by nobody, revocable by nobody. Log out now revokes the chain, and its return
value still describes the presented row alone, so a second log out keeps reading as "nothing live".

The chain is **named**, not walked. `root_hash` carries the head's hash down every successor, so
ending a session is one indexed `UPDATE ... WHERE root_hash = ?` however long the chain is.

It was a walk first, forward through `predecessor_hash`, and that is the version a reviewer measured
properly. A walk is linear in the chain — 10 microseconds a link — and the chain has no bound but
`expires_at`: the first estimate said 5,400 rows by assuming the extension's eight-minute cadence,
which nothing enforces. A holder refreshing at the rate limit reaches hundreds of thousands inside
thirty days, and one logout or replay then held the database for seconds inside `BEGIN IMMEDIATE`.
Measured before and after, on the same chains: 605 ms over 60,000 rows became 6.4 ms, and 42.7 ms
over 5,400 became 0.6 ms.

`predecessor_hash` stays, because retiring a predecessor when its successor is used needs exactly
that one hop. What went with the walk is the `seen` set that kept an operator-edited cycle from
spinning inside a transaction — a statement cannot loop.

One place differs in behaviour rather than in cost. The grace branch drops the successors nobody
received **while the token presenting itself stays live**, so it passes that token as `keep`. Removing
it failed no test at all until `takes a third presentation inside the ceiling, not just a second` was
written — the ceiling allowing more than one retry was a property this file promised and nothing
held.

The caller is told nothing about any of it. `gone` and `reused` answer the same `401`, the way the
two pairing failures do — a reply that told a replayer their copy was genuine would confirm they had
the right kind of secret.

### What it does not change

**The successor inherits the predecessor's expiry.** Rotation shortens what a leaked token is worth;
it does not lengthen a session. Thirty days from pairing stays thirty days, and `SECURITY.md` stays
true without an edit to that row.

### The cost, stated

Inside the grace, somebody holding a stolen predecessor can rotate it and revoke the successor the
real client received — logging the reviewer out. The thief already holds a working refresh token, and
without rotation they would hold it silently for thirty days.

They do **not** get "at most one cycle" — this paragraph said so after the sentence above had already
been corrected, which is how a claim survives being disproved: it was written twice. The thief keeps
the chain and can go on refreshing. What the reviewer gets is the only thing rotation can give them,
and it is not small: their own next refresh fails, so they find out. Without rotation nothing ever
tells them.

There was a case where even that did not hold, and closing it changed what counts as evidence.

### The hole the grace left, and the discriminator that closed it

Raised by a reviewer and reproduced. A thief copies `A`; the client refreshes `A -> B1`; the thief
presents `A` inside the grace, so `B1` is revoked and `B2` minted. The client then presents `B1` —
revoked, `rotated_at` NULL, the orphan state — which answered `gone` **without revoking the chain**.
The client was locked out, `B2` went on refreshing for the remaining thirty days, and nothing
anywhere recorded that one chain had two holders. `SECURITY.md` promised the opposite.

The first answer to this was that the orphan branch is deliberate: a revoked token that never rotated
is a credential that was only ever in flight, and revoking the chain when one appears lets anyone who
intercepted a single lost answer end the session at will.

That reasoning weighed the wrong two things. Reading a response body already implies a position from
which the session can be taken outright, so the denial of service is a capability an attacker who has
it does not need — while the behaviour it protected left a thief with a live chain and no signal to
anybody.

So the test is no longer the row's own state. **Revoked, with something still live in the same
chain, is the leak signal**; a chain with nothing live left is an ended session and answers `gone`.
`root_hash` is what makes that one indexed lookup rather than a walk, which is the second time this
column paid for itself.

It is stricter and simpler than `revoked && rotated`, and it drops that predicate's awkwardness: a
logout no longer reads as a replay, because after it nothing in the chain is live. The cost is
written into `SECURITY.md` rather than left implicit, and the two tests that encoded the old answer
were rewritten rather than deleted — `ends the chain when an orphan is presented and something in it
is still live`, and `serves whoever presents last inside the grace, until the earlier holder comes
back`.
