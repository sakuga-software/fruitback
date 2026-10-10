# The worker, and where a seed is stored

The Node service, who may read a pin, and the store interface — what `SeedStore` is, who validates a
connector's environment, and what a second connector with no markdown body actually proved.

## The worker

### The rules, in short

- It exists because a store's API key cannot ship in client-side JS — and, since FRU-31, because
  somebody has to hold the SQLite file too. **Resist putting logic here that belongs in the widget or
  in the store.** The rule is the point; "exactly one reason" was the wording until FRU-26, and it
  stopped being true when a store with no API key shipped.
- **Both paths canonicalize the page URL** — `POST /feedback` re-does `seed.page.url` server-side and
  `GET /feedback` its `url` parameter. A client that skipped normalization would plant a pin nobody
  can find again.
- **The rate limiter and the read cache keep their state in a `Kv`** (FRU-49), and this process
  holds one, in memory. Two replicas are therefore two ceilings — the configured limit multiplied by
  the container count — and the deployment is one container. A Redis implementation was built,
  reviewed and removed before merging: it is FRU-67, with what it learned. `kv.ts` is the seam and
  the memory store. **Values are strings**, so a value a remote store cannot hold fails here too.
- The read cache is two layers. **The in-flight promise stays in this process**, so a burst on one
  replica costs one call and N replicas cost at most N. The settled answer goes in the `Kv` for
  `CACHE_TTL_MS`. A failure is never written: an outage must not be served for the whole TTL.
- **A write invalidates by writing a new page version, never by scanning keys** — a `Kv` cannot be
  asked which keys match. The version is part of the cache key, so a read that was in flight while
  the pin was planted stores its stale answer under a version nobody will read.
- **The limiter refuses when the `Kv` does not answer** (`503 limiter-unavailable`): a limiter that
  opens during an outage is one anybody can open. `/health` never touches the `Kv`, because a
  readiness probe that depends on the `Kv` takes every replica out at once. A failed invalidation after
  a write is the opposite call — the issue exists, and a `502` would have the widget plant it twice.

### The reasons, and the history

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
- The read cache (`cache.ts`) holds the in-flight promise **in this process** and the settled answer
  in the `Kv`, so a burst of visitors on one page costs one Linear call and N replicas cost at most N.
  Failures are never written: an outage must not be served for the whole TTL. See _The rate limit and the cache, behind a Kv_ below.
- Failure codes are deliberate: `400` the caller's fault, `403` origin not allowed, `413` oversized
  body, `429` rate-limited, `500` misconfigured, `502` `store-unavailable` (the widget should keep the
  note and retry), `401` the read needs an identity. `/health` answers `503` when misconfigured so a
  bad deploy is never routed to. **A code the widget reads is a promise**, so it names a role and
  never a vendor — `linear-unavailable` became `store-unavailable` with FRU-29 for that reason.

## The rate limit and the cache, behind a Kv (FRU-49)

`cache.ts` and `rate-limit.ts` each kept a `Map` of their own, reached directly. The ticket asked for
both behind a replaceable store, because two replicas behind one load balancer have two rate limits
and the operator who started the second one is told nothing.

**The interface is `get`, `set` and `incr`, each with an expiry, and nothing else** — what both callers
need, and what every candidate store implements the same way. `kv.ts` holds it and the one
implementation this worker ships, in memory, built once per process and handed over in
`RequestContext.kv` like the store.

**Values are strings**, the memory store included. A store that kept objects would take a value a
remote store cannot hold, and every test written against it would pass. `kv.test.ts` is a contract
suite for that reason, and its integer rules were measured against redis:7: the memory store refuses
to count exactly what Redis refuses.

### Invalidation is a version, not a scan

The old `invalidate(matches)` walked the keys and dropped the ones containing the page URL. Nothing
distributed can answer that question: a `Kv` has no key list, and `KEYS` on a shared Redis is a
production incident waiting for a big enough database.

So a page carries a **version**, an opaque token, and the cache key carries it. A write does one
`set` of a new token, which no reader will ever match. It also closes a race the old version had on
its own: a read in flight while the pin is planted finishes **after** the write and stores an answer
that does not have the pin. Under the old scheme it stored it where the next reader looks — the pin
reads as lost for a whole TTL. Under this one it stores it under a version nobody reads.

The token has a long expiry (a day) and not the cache's. If a version could expire while a slow load
is still in flight, that load could write a stale answer under the version the next reader uses.

### Counting first, and what the window is worth

`incr` comes before the decision, because it is the only atomic step available. Reading a count and
then writing it lets a burst of parallel requests all read the same low number and all pass — on a shared
store, that is a bypass with no ceiling at all. The cost is that a refused request is counted too, so
a caller that keeps sending stays refused.

The window is **two fixed windows, weighted**: the current count plus the previous one, scaled by how
much of it still overlaps the last minute. A true sliding log would be exact and needs sorted sets,
which is a second data structure in the interface for the last few percent of accuracy.

What the estimate costs is bounded, and the bound is proven rather than measured: in any 60-second
interval, with `A` accepted in the older window after fraction `a` of it, the newer window accepts at
most `limit − A(1 − a)`, so the total is at most `limit + A·a < 2 × limit`. With integers that is
`2 × limit − 1` — **39 for the default 20** — and `rate-limit.test.ts` builds exactly that caller and
asserts the next request is refused. A steady caller stays at the limit, and the aligned windows are
also why the boundary is not a reset: a test that crosses one is not a test that flakes.

### An outage refuses, and says so in one place only

A limiter that opens when its store is unreachable is a limiter anybody can open. So a `KvError` from
the limiter is `503 limiter-unavailable`, with the CORS headers the browser needs to read it. Three
consequences, all deliberate:

- `/health` never touches the `Kv`, so a store that stops answering does not take the container out
  of the load balancer. It is the same rule that keeps `/health` unmetered.
- The **cache** does the opposite: a `Kv` that does not answer costs quota, never a read.
- A failed invalidation **after** a write also does the opposite, and that one is the subtle case. The
  issue exists by then. `502` tells the widget to keep the note and retry, and the retry plants it a
  second time — the worker cannot tell. So it answers `201` and logs, and the pin shows up one TTL
  late.

### Redis, built and taken out

The first version of this ticket shipped a Redis implementation: a RESP2 client over `node:net` with
no dependency, verified against a real Redis with ACL users, and reviewed over four rounds. It was
removed before merging, on the maintainer's decision, for two reasons:

- the deployment is one container behind Traefik, where the memory store is already the right
  answer, and nothing needs a second replica;
- nearly every defect the reviews found was in that client or in its parity with the memory store.
  Code nobody runs in production goes on collecting those, with nobody to see them.

What it learned is written up in FRU-67: the atomic `INCR` and `PEXPIRE` script, the timeout that
destroys a pipelined connection, one URL parser for the boot check and the client, `AUTH` for a
named user with no password, the 2^53 ceiling, and TLS as the maintainer's call. So is the option to
measure first, Traefik's `RateLimit` middleware. The removed code is in the history of PR #46.

### What this does not do

The in-flight promise stays per process, and it cannot be otherwise: a promise does not cross a
process. Ten visitors on one replica still cost one call; ten replicas cost ten. That is the
degradation the ticket asked to have written down rather than discovered.

## Who may read a pin

### The rules, in short

- **`read: 'public' | 'authenticated'`** (FRU-40), per client or worker-wide. `public` stays the
  default — that is compatibility, not security, and the exposure is made _sayable_ instead: the boot
  log names every client whose pins anyone can read, and `/health` **counts** them without listing
  the ids.

### The reasons, and the history

- **`GET /feedback` used to answer anyone who could build the URL.** Every note, its author and the
  team's replies were readable by any visitor of the client's site, and by `curl` — which is why
  hiding pins in the browser was never the fix. `read: 'public' | 'authenticated'` is (FRU-40), per
  client in `FRUITBACK_CLIENTS` or worker-wide via `FRUITBACK_READ`.
- **The extension is a different problem.** It settles _visibility_ — the pins leave the visitor's
  DOM. It settles nothing about _authorisation_: the endpoint stays open and `curl` still works.
  Building FRU-41 without this ticket hides the comments in the UI and leaves them in the API.
- **`authorizeRead` runs before `cached`, and the guard is `stub.calls`, not the status code.** A
  gate moved below the cache still returns `401`, so asserting the status cannot tell the two apart
  — it was measured passing against exactly that mutation. What it costs is a Linear call per
  unauthorised request, so the test that pins the position asserts **no call reached Linear**. The
  warm-cache test is a narrower guard: it catches a cache-hit fast path that answers before the gate.
- **`public` stays the default, and that is compatibility rather than security.** Defaulting to
  `authenticated` would blank the pins on every upgraded worker with no error anywhere, and the
  operator would hear about it from users. The exposure is made _sayable_ instead: the boot log names
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

- **Comments come from Linear on every read** (FRU-13), and close the loop: someone leaves a note,
  the team answers in the issue, and the answer appears where the note was left rather than in an
  inbox the reporter does not have.
- **Absent and empty mean different things.** No `comments` field at all means the worker was not
  asked for them, and the widget says nothing; `[]` means it asked and there were none, and the
  widget says so. A client with replies switched off must not read as a team that never answered.
- **`showComments` is on by default and is a real switch**, per client or worker-wide
  (`FRUITBACK_HIDE_COMMENTS=1`). Under `read: 'public'` it is the only thing between an issue thread
  and anyone who can load the client's page; under `read: 'authenticated'` (FRU-40) it is back to
  being the editorial choice it should always have been, because the reader is someone the worker
  checked.

## Where a seed is stored

### The rules, in short

- **`store.ts` is the interface.** `findForPage` states the _intention_, not the method — Linear
  filters by substring, SQL does a `WHERE`, and exposing a `contains` filter would have made
  Linear's trick the contract.
- **Every state the deprecated flag can be in says something at boot** (FRU-54).
  `fakeLinearIgnoredReason` answers when the flag lost — to `NODE_ENV=production`, or to an explicit
  `FRUITBACK_STORE`. `fakeLinearDeprecationNotice` answers when it selected the memory store, and
  when `FRUITBACK_STORE` took precedence over it and the flag is a stale line somebody can delete —
  **precedence, never that the store is in use**, because an explicit `memory` is still refused under
  `NODE_ENV=production` and the notice would otherwise print one line above the boot failure that
  says so. The two are mutually exclusive by construction, and a test pins that over every
  environment it enumerates. **FRU-33 shipped only the first**, which reached every operator except the ones
  still relying on the flag — the inverse of who a deprecation notice is for. `server.ts` has no test
  of its own, so the boot line is asserted on its **source**: the notice's own cases all stay green
  with the call deleted, and the warning then reaches nobody.
- **A row is parsed, never trusted**, in every connector. A malformed one costs that pin; the page
  keeps its other notes. `sqlite.ts`'s `insert` and `select` are `async` so a failure to open the
  file rejects rather than throwing synchronously.
- **Every store passes `store-conformance.test.ts`** (FRU-34). The cases live in
  `store-conformance.fixture.ts`; each store gives a subject that opens it against a double that keeps
  what it receives. A step a store cannot do is a string reason, reported as skipped, never as passed.
  The outage case goes through `handleRequest`, because the promise is the `502`, not the throw. The
  store matrix in `docs/self-hosting.md` is compared with each store's `stages`, reply cap and `devOnly`.
  On a worker without `FRUITBACK_CLIENTS`, a read that names no client gets every seed on the page, on
  every store. A store that routes by client is tested with a second tenant, and a remote store with a
  rejected `fetch` and an unreadable body as well as an error status.
- **`linear-memory.ts` keeps its name and its import of `toSeedIssue` on purpose.** That coupling is
  the feature.
- **`github.ts` signs in as a GitHub App, never with a personal token** (FRU-32). An RS256 JWT from
  `node:crypto` buys an installation token narrowed to **one repository**, cached per repository until
  five minutes before it expires. Concurrent reads share one mint, a failed mint is not kept, and a
  `401` drops the token. The installation is found from the repository, so there is no variable for it.
- **GitHub's `labels=a,b` is AND** (measured on `cli/cli`: 42 for one label, 22 for the pair). It is
  what keeps one client's pins off another's site. A count at the
  page size proves nothing: the first check compared three counts of 100. GitHub also splits the value
  on commas, caps a label at 50 characters and ignores case, so `githubLabelName` hashes any client
  label that is not plain lowercase, or that already has the shape of a hash — on the write and the read
  alike. `matchPage` rechecks every label on the row, and the client the seed names.
- **A Linear read selects by team and page, never by label, and reads the client in the seed**
  (FRU-138). A team can refuse `issueLabelCreate` to the key, and it does to an application that is a
  member of no team (measured). The write then makes the issue with no label, and a read that
  selected by label never showed that note again. The labels stay, when Linear allows them, for the
  people who triage. The client is also looked for in the
  description, as a substring, so the notes of another client of the team do not fill the pages a
  read walks; the exact comparison is in the code.
- **A GitHub read lists the client's issues by label and re-checks `seed.page.url`; it never
  searches.** Search is 30 requests a minute. Every page read walks the client's list, newest first,
  stopped at 1,000 issues, and the read cache is what protects the hourly budget.
- **A label that cannot be created stops a GitHub write.** A read finds a seed by its labels, so an
  issue without them is a note nobody sees again. A `502` keeps the note in the widget.
- **No parameter properties in the worker.** `constructor(readonly status: number)` is TypeScript that
  Node's type stripping refuses, and every test file that imports the module fails to load. `tsc`
  accepts it.

### The reasons, and the history

- **`store.ts` is the interface, and it existed before it was named** (FRU-29). `app.ts` used to
  select between the real and the in-memory module through
  `Pick<typeof realLinear, 'createSeedIssue' | 'fetchSeedIssues'>` — two methods, two
  implementations, an interface discovered by accident. `SeedStore` writes it down so SQLite
  (FRU-31) and GitHub (FRU-32) are implementations rather than new branches.
- **`findForPage` states the intention, not the method.** Linear filters server-side with
  `description: { contains: … }`, GitHub lists issues by label, SQL does a `WHERE`, and a store with no
  search would walk everything. Exposing a `contains` filter on the interface would have made
  Linear's trick the contract.
- **The old `Routing` mixed two things, and the split is the point.** `ClientPolicy` — `showComments`,
  `identitySecret`, `read` — is what the _worker_ decided, whatever store is behind it. `teamId` and
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
  would have opened a SQLite connection per request the moment FRU-31 landed. Caught in review, not
  by a test, because nothing observable was wrong yet. The tests that hold it now assert the handler
  used the store it was **given**: a Linear stub left untouched is the proof it built none of its own.

## Which store, and who validates it

- **`FRUITBACK_STORE` selects the connector, and each connector validates its own environment**
  (FRU-33). FRU-29 named the interface but left the worker Linear-shaped anyway: `WorkerConfig`
  carried `linearApiKey`, `linearTeamId` and `linearProjectId`, so every module that could read the
  config could read one provider's credentials — and `readConfig` checked those three for **every**
  deployment, so a SQLite worker (FRU-31) would have been refused at boot for a missing Linear key.
- **What the worker keeps of a store is a name and a way to build one.** `StoreConfig` is
  `{ provider, create() }` and nothing else; a test asserts exactly those two keys, so the next
  provider's fields cannot arrive here either. `storeFor` is now one line.
- **`store-config.ts` is the mechanism, `stores.ts` is the registry**, and they are two files because
  the connectors import `defineStore` — holding the list in the same file would make it and
  `linear.ts` import each other. A new store is one entry in `STORE_SPECS`.
- **A store names its own environment variables.** `envNames` is required per field, so a boot
  diagnostic says `LINEAR_API_KEY` and never `apiKey` — mutation-tested, and the mutation also trips
  three older tests, which is how load-bearing that diagnostic is. test:`never reports a field name from
any store` asks it of every spec rather than of Linear.
- **An unknown provider and a dev-only one in production are both refused, never defaulted.** A typo
  falling back to Linear would send a worker configured for SQLite to an API it has no key for; and
  feedback accepted into RAM behind a green health check is worse than a worker that will not start.
  That second guard is the one thing this ticket had to generalise without loosening.
- **`FRUITBACK_FAKE_LINEAR=1` still works, and it _degrades_ where `FRUITBACK_STORE=memory` is
  refused.** The asymmetry is deliberate: a flag a container inherited must not stop it serving
  production, while a provider somebody deliberately named must not be silently swapped for another.
  So the sugar falls back to the real store and says so in the log; the explicit selection is refused
  at boot. `pnpm dev` and the E2E suite use the new spelling, which is what keeps the selection path
  exercised outside the unit tests.
  - **The deprecation warning it shipped with fired only when the flag lost** (FRU-54), which is the
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
  - The reason the flag is kept alive is the `.env` files and compose stacks that predate FRU-33.
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
  here, and test:`answers no empty diagnostic` walks every way of making the config invalid rather than the
  one that was noticed.
- **Still Linear-shaped in one place, and left there on purpose**: `apps/worker/src/linear-memory.ts`
  keeps its name and its import of `toSeedIssue`. See _Where a seed is stored_ — that coupling is the
  feature.

## SQLite, and what a second connector actually proved

- **`sqlite.ts` is the connector that had to be uncomfortable** (FRU-31). One implementation of
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
  opens a database per request — the hazard FRU-29 was written to prevent. The test asserts **how
  many handles were opened**, not `connections.size`: the map is keyed by path, so a `connect` that
  stopped reusing overwrites the entry and leaves the size at one. Both weaker spellings were measured
  passing against the mutation before this one was written.
- **There is nothing to project onto `SeedStage`.** The column _is_ a stage, so `stageOf` only applies
  the contract's own tolerance — an unrecognised value colours the pin rather than hiding the note.
- **A row is parsed, never trusted.** The file sits on a volume an operator can edit and a restore can
  be older than the code. A malformed row costs that one pin; the page keeps its other notes.
- **`insert` and `select` are `async` so a failure to open the file rejects rather than throwing
  synchronously.** `connect` throws before any `await`, and `app.ts` happens to catch it either way —
  but a caller reaching for `.catch()` would have been bypassed on the one path that matters, a volume
  nobody mounted.
- **`sqlite3` is in the runtime image for one reason: the backup line in
  [self-hosting.md](../self-hosting.md)** (the README until FRU-26 moved it). The store needs
  nothing installed; `.backup` needs a binary, and it is the only safe way to copy a live database.
  Measured in a container: `fruitback.db` was 4 KB while `fruitback.db-wal` held 53 KB, so a `cp`
  of the `.db` alone would have lost the note that had just been planted.
- **Verified in the container, not only in `node --test`**: boot on `FRUITBACK_STORE=sqlite`, `/health`
  answering `store: sqlite`, a seed posted and read back, the pin surviving `docker restart`, and the
  documented backup command producing a file that holds the seed.
- **`resolveClientIp` is security-relevant.** The client IP is the entry `TRUSTED_PROXY_HOPS` from
  the **right** of `X-Forwarded-For`, because the left of an appended chain is what the caller wrote.
  Reading the leftmost entry makes the rate limit bypassable with one header. An earlier version of
  this line said each proxy appends and that the leftmost entry is correct behind Cloudflare. Neither
  was measured. FRU-50 measured nginx appending, and Traefik and Caddy replacing by default.
- **`FRUITBACK_CLIENTS` makes one worker serve several client sites** (FRU-15). It maps a
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
- **`clientId` is client-asserted**, and FRU-9 did not change that: identity tokens say who the
  _reporter_ is, not which client the page is. `origins` is what turns the claim into something
  checkable against the browser's own header — the trust level CORS gives, and strictly more than
  nothing. Do not describe it as authentication.
- A malformed `FRUITBACK_CLIENTS` is refused at boot rather than ignored, and named on `/health`.
- The rate limiter counts in the `Kv`, which lives in the process: **per replica**, so N containers
  multiply the ceiling by N. A store the replicas share is FRU-67.
- Tests drive `handleRequest` with plain `Request` objects against a stubbed Linear
  (`linear-stub.ts`); no container needed. The assertion that matters most is that the stored
  description parses back into the exact seed that was posted.
- **`reporter.verified` is the worker's word, never the client's** (FRU-9). Anything arriving with
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

## GitHub Issues, and the stages it cannot say (FRU-32)

- **The ticket's own test was the cost, and the cost was low.** `SeedStore` gained one optional field,
  `stages`, and `app.ts`'s read path one line. Everything else is `github.ts`, one entry in
  `STORE_SPECS`, and the configuration around it.
- **What did not project was the vocabulary.** There are five `SeedStage` values because Linear has five
  state types. GitHub has `open` and `closed`, plus a `state_reason` on a close. Three stages come out
  of that honestly: `open` is `seeded`; closed `not_planned` or `duplicate` is `composted`; any other
  close is `ripe`, a close with no reason included, because those predate `state_reason` and meant
  done. The ticket also offered dedicated labels for `green` and `ripening`. Not taken: a label a team
  has to remember to apply is a state the connector invents.
- **So a store declares the stages it reports, and the panel offers only those.** `stages` travels on
  every read, pins or none. Derived from the pins on screen instead, an empty page, or a page whose
  pins are all open, would offer the wrong boxes. It is a read-envelope field, so `SEED_VERSION` stays
  where it was, and `offeredStages` answers every stage for a worker from before this ticket. The
  list is not in `ConfigStore`, which persists to `localStorage`: a stored copy would outlive a change
  of store. A stage the reporter hid stays hidden in the config, so a worker that reports it again
  shows the reporter's choice.
- **A GitHub App, never a personal token.** A personal token does not expire and reaches every
  repository of its owner. The JWT is RS256 through `node:crypto`, `iat` sixty seconds back and `exp`
  nine minutes ahead. It buys an installation token narrowed with `repositories` to one repository,
  cached per repository until five minutes before `expires_at`. Concurrent reads share one mint, a
  failed mint leaves the map before any waiter sees it, and a `401` drops the token. The installation
  is found from the repository (`GET /repos/{owner}/{repo}/installation`), so a client repository in
  another organisation needs no variable of its own.
- **The read lists by label; it does not search.** The search API allows 30 requests a minute and 1,000
  results, shared by every page read of every client. Listing
  `labels=fruitback,fruitback:<client>&state=all` spends the ordinary budget, and the exact
  `seed.page.url` re-check does the job the re-check after `contains` does on Linear.
- **`labels` is AND, and that is the client isolation.** Measured on `cli/cli`, 2026-09-14: `bug` alone
  filled a page of 100, `gh-codespace` gave 42, and `bug,gh-codespace` gave 22, every row carrying
  both. The first comparison proved nothing: three labels, three counts of 100, each one the page size.
- **The cost of listing is stated rather than hidden.** Every page read walks the client's issues,
  newest first, a hundred a page, stopped at ten pages; a client with more than 1,000 Fruitback issues
  loses its oldest pins. Comments cost one or two calls for each pin of that page that has any. The
  read cache is what stands between this and the hourly budget.
- **Conditional requests were planned and taken out before a line was written.** A `304` costs no quota,
  but how GitHub's ETags behave across an hourly token change was not measurable here, and a second
  cache under `cached()` is one more thing to keep in step with the page version. It is the next lever
  if the budget bites.
- **A label that cannot be created stops the write.** `422 already_exists` is success. Any other failure
  is a `502`, so the widget keeps the note: an issue without its labels is one no read finds.
- **Pull requests come back from the issues endpoint**, and are dropped by their `pull_request` key.
- **A client's label is a name GitHub keeps as written, or a hash** (found in review, in two rounds).
  GitHub splits `labels` on commas, limits a name to 50 characters, and compares names without case:
  measured on `cli/cli`, `labels/BUG` answers the `bug` label and `labels=BUG` counts what `bug` counts.
  The first fix kept a comma label out of the query, which made the 1,000-issue cap global across
  clients, and it did nothing for `Acme` and `acme`, which would have shared one label and read each
  other's notes. `githubLabelName` is now applied on the write and on the read: a lowercase name of
  50 characters or fewer stays, anything else becomes `fruitback:` and 32 hex characters of its
  SHA-256. `matchPage` still checks every label on the row, without case as GitHub does. A plain name
  that already has the shape of a hash is hashed too, so a client ID cannot take the label of another
  client, and `matchPage` also requires the seed to name the client it is read for (both found in
  review). The write stores the normalized client ID in the seed, so the check drops no note of its own.
- **A late `401` drops only the token it refused.** Evicting whatever the map held could throw away a
  newer token a concurrent read had just minted.
- **The comment count is a hint.** It comes from the issue list, and a reply can arrive after it;
  `/issues/{n}/comments` has no newest-first order, only `since`. The store reads on while the last page
  is full, two pages at most past the count.
- **Comment lists are fetched four at a time.** Only the pins of the page need them, but a page with
  many pins would otherwise open one request per pin at once, and GitHub's secondary rate limit
  counts concurrent requests (found in review).
- **`constructor(readonly status: number)` stopped six test files.** Parameter properties are
  TypeScript that Node's type stripping refuses, `tsc` accepts them, and every test file whose imports
  reach the store registry failed to load.
- **Not verified against a real repository.** Every call is tested against a fake GitHub built from the
  REST documentation, API version 2022-11-28. The shapes of an issue row, a comment and
  `state_reason` were read from a public repository with `gh api`; nothing was written anywhere.

## The conformance suite, and the matrix (FRU-34)

- **The doubles keep what they receive.** `linear-stub.ts` answers from a fixed list and records the
  calls, so it cannot serve a suite that writes and then reads. `fakeLinear` and `fakeGithub` in
  `store-conformance.test.ts` store the write and apply the filter of the read. A Linear label belongs
  to one team, and GitHub serves comments oldest first, as the real services do. So client isolation is
  tested where each store puts it: the label filter on Linear, the labels and the seed's client on
  GitHub, the `client_id` column on SQLite.
- **The outage case goes through `handleRequest`.** A connector throws `StoreError`, and `app.ts`
  turns it into `502 store-unavailable`. A case that checks only the throw passes with the mapping
  deleted. Measured: a rethrow on the read path, and separately on the write path, fails the case for
  the three stores that can fail.
- **A step can be a string.** The memory store assigns its own states, writes canned replies and has no
  provider. `node:test` reports a reason as skipped. A step that passed with nothing checked would read
  as conformance.
- **The matrix test reads what the code holds**: the stages, the reply cap and whether the store runs
  in production. The reply cap of Linear, GitHub and SQLite comes from each subject, which imports the
  connector's own `COMMENTS_PER_ISSUE`, and a case writes two replies more than the cap. The Replies cell
  of the memory row is prose: the test checks only that it claims no cap. The column that says what
  changes a stage is prose too, and no test reads it.
- **An outage has two shapes, and the Linear store handled one.** The first version of the suite only
  answered `500`. A `fetch` that rejects, which is what a lost network gives, escaped `linear.ts` as a
  plain error and reached the transport as a `500`. GitHub already wrapped it. `graphql` now turns a
  rejected `fetch` and an unreadable body into `StoreError`, and the suite runs all three shapes: an
  error status, a rejected `fetch` and a body that is not JSON.
- **Routing is part of the promise.** Linear and GitHub send a client with its own `teamId` or
  `repository` elsewhere, and `scope` must say so for the read cache. The suite writes and reads a
  client in a second tenant and checks that the default tenant does not see it. SQLite and the memory
  store have one tenant, and say so.
- **Defence in depth shows as a surviving mutation.** Removing only GitHub's client label, or only the
  memory store's client filter, passes: each store has a second layer, the seed's client re-check or
  the client label. Removing both fails.
- **A read that names no client.** The memory store returned only the seeds with no client. Linear,
  GitHub and SQLite return every seed on the page. The suite made the difference visible, and the
  memory store now follows the other three. Only a worker without `FRUITBACK_CLIENTS` accepts such a
  read.
- **The ticket's matrix was wrong in three cells.** GitHub has three stages, not two. Nothing in the
  worker writes SQLite replies or changes a SQLite stage. The Serverless column went, because the
  deployment is Docker only.

## The markdown codec, and the file that outlived its name

### The rules, in short

- **`pageQueryTerm` lives beside it**, because the term works only where `buildSeedBlock` writes the
  canonical URL verbatim into the JSON.
- **The prose of a description is written in the team's language, never the reporter's** (FRU-39).
  `FRUITBACK_TEAM_LOCALE` (English by default) reaches the stores through `ClientPolicy.locale`, and
  `TEAM_WORDS` in `markdown-description.ts` holds the words. A description is read where the issues
  are: a note written in Tokyo must not file a Japanese issue into a team that reads English. **The
  locale reaches the prose and never the JSON block**, which is what keeps the round trip true in
  every language — the test runs over several. A value that is not a locale tag is refused at boot; a
  valid tag this build has no words for degrades to English. The note and the name the reporter typed
  are never translated.
- `packages/shared/src/linear.ts` became `issue.ts`; `apps/worker/src/linear.ts` keeps its name,
  because over there a team really is Linear's.

### The reasons, and the history

- **`markdown-description.ts` holds "put a seed in a markdown body and keep the issue readable"**
  (FRU-30) — `buildIssueTitle`, `buildIssueMetadata`, `buildSeedBlock`, `buildIssueDescription`,
  `parseSeedFromDescription` and `pageQueryTerm`. None of it was ever Linear's; every issue tracker
  worth connecting to stores a markdown body and lets something search it.
- **It is a strategy connectors share, not part of `SeedStore`.** Putting it on the interface would
  have obliged a store that has columns to implement a codec it has no use for — and `sqlite.ts` is
  the standing proof that such a store exists. A connector picks this up; it is not required to.
- **`pageQueryTerm` moved with it, and that is the reason it is a separate point.** The term works
  only because `buildSeedBlock` writes the canonical URL verbatim into the JSON — a property of the
  _writer_, not of any provider. Beside the code that makes it true, it cannot drift from it.
- **The round-trip test travelled with the code rather than being rewritten**, which is what the
  ticket asked for and what makes the move provable: 44 shared tests before, 44 after, and
  `parseSeedFromDescription(buildIssueDescription(seed)) === seed` is still the same assertion on the
  same fixture.
- **`linear.ts` became `issue.ts`, because the name had outlived what it described.** FRU-23 took
  Linear's workflow states out of it, FRU-24 took the words a human reads, and this ticket took the
  codec. What was left — a label, a ripeness, and the shape of what a read answers — names no
  provider at all. `apps/worker/src/linear.ts` keeps its name: over there, a team really is Linear's.
- **Nothing outside the package had to change**, because every consumer imports through the
  `@fruitback/shared` barrel rather than from a file. That is the property that made the rename cost
  one line in `index.ts`, and it is worth not losing.
- The guard that proves it is `package.test.ts`'s test:`type-checks an import with no special tsconfig`:
  it deletes every `dist`, packs all three packages and type-checks an import with `skipLibCheck`
  **off**, so a renamed file that broke the published declarations fails there rather than in a
  consumer's build.

## The extension's session

### The rules, in short

- **A session is credentials, and credentials are not seeds** (FRU-42). `FRUITBACK_SESSION_PATH` is
  its own SQLite file, whatever `FRUITBACK_STORE` says — a worker keeping its seeds in Linear still
  keeps its sessions on a disk it owns.
- **Do not reuse `sqlite.ts`'s `connect` for it.** That helper applies the _seeds_ migrations and
  drives `PRAGMA user_version` with them, so a session database opened through it gets `seeds` and
  `comments` tables and two schemas fighting over one counter. `session-sqlite.ts` has its own.
- **The operator names the person; the browser never does.** A pairing code is minted _for_ someone,
  carrying their name, and whoever redeems it gets a session that says so. An extension supplying its
  own name at pairing time is the browser asserting an identity, which is what FRU-9 closed.
- **The access token is an ordinary identity token**, signed with the same key `identity.ts`
  verifies. One verification path in this worker rather than two, and `read: 'authenticated'` accepts
  the extension with no change at all.
- **Pairing codes and refresh tokens are stored as SHA-256 digests.** A copy of the file must not be
  a set of working logins. A test reads the bytes SQLite wrote — the `-wal` file included, because a
  row just written is only there. **This is why a rotation cannot answer the same successor twice**,
  and it is what shaped FRU-61.
- **Every refresh rotates** (FRU-61). A refresh token that never changes is a thirty-day password.
  What retires a predecessor is its **successor being used** — proof the _token holder_ received it,
  never proof of which holder, because a bearer token cannot say — not a clock.
  `ROTATION_GRACE_SECONDS` is the ceiling for an answer that was lost, measured from the **first**
  rotation, and derived from the extension's `REFRESH_MARGIN_MS + RETRY_DELAY_MS` by a test that
  reads them. Inside it the predecessor may be presented repeatedly; each retry replaces the
  successor nobody received, so one successor is live at a time. A token presented after its
  successor was used is a copy: the **whole chain** is revoked, and the caller gets the same `401`
  as for a token that never existed.
- **Rotation is a detection property, not a lifetime cap.** Do not write that a stolen token is
  useful for "at most one cycle" — three places said so and none was true. Whoever presents a bearer
  token is served, and inside the grace each presentation revokes the successor the one before it
  minted — so the **last** presenter keeps the chain and every earlier holder is locked out. Write
  _last_, not _first_: the inverted version shipped into three documents and a test name. What is
  guaranteed is only that the two cannot both keep the session quietly.
  test:`serves whoever presents last inside the grace, until the earlier holder comes back` holds it.
- **The replay test is the chain, not the row**, and `revokeSession` ends the chain. A revoked
  token presented while something in its chain is still live means two parties hold one chain: that
  is the signal, and everything goes. A chain with nothing live left is an ended session and answers
  `gone`. The earlier test — revoked _and_ rotated — missed the case where a thief has the client's
  own successor revoked under it inside the grace, which left the thief refreshing for thirty days.
  The trade is that intercepting one answer in flight now ends the session at will; that capability
  already subsumes the attack. And a log out that revoked only the row it was handed left the
  successor of a lost-answer token live, held by nobody.
- **`rotated_at` marks the first rotation, never the last.** `AND rotated_at IS NULL` on that update
  is the grace being a ceiling: rewritten on every retry it slides, and whoever holds the token
  re-presents it just inside each window for ever.
- **An access token carries the generation of the session it was minted for** (`matches`). Fresh is
  not enough: the popup and the background write the same two areas from separate contexts, so a
  logout can land between a refresh writing the session and the same refresh writing its grant, and
  the orphan was then honoured for its remaining ten minutes — which revoking on the worker does not
  reach. The two writes are not one operation and cannot be, because `chrome.storage` has no
  transaction. It is an opaque id, never the refresh token: copying a credential into the session
  area would undo the split that keeps it out. Absent on both sides compares equal, so an upgrade
  keeps the session it had. Since FRU-64 that case is refused twice — the session the grant names is
  itself stamped with a run that is over — and what the generation still holds on its own is a grant
  and a session that drifted apart **inside** one run, which a partial write leaves behind.
- **One storage key per endpoint, in both areas** (FRU-63). `fruitback:grant:<endpoint>`, joined by
  `fruitback:epoch:<endpoint>` beside the session it dates (FRU-64), and `Area` has `put`/`drop`
  rather than a whole-record `write`. One
  key holding every endpoint made every write a read-modify-write, and the popup and the background
  do not share a lock: two refreshes each read the record and each replaced it, so the later write
  put the earlier one's **spent** token back — a replay, so the worker revokes the chain and the
  reviewer pairs again. A logout in the popup was written away the same way. `refreshOnce` is per
  endpoint and cannot cover this; it is what makes two workers refresh in parallel in the first
  place. A queue in `session.ts` held it inside one context only, and it is gone.
- **A session key names its run too** (FRU-65): `fruitback:session-run:<epoch>:<endpoint>`. A
  refresh writes the run it read, so a logout and a new pairing inside its window keep the pairing.
  `put` removes the runs of its endpoint that its snapshot shows as over. That is safe because an
  epoch never comes back and a key written after the snapshot is not in it. A refresh that answers
  `401` ends only the run it spent, while that run holds the token it spent, and mints no epoch: an
  epoch would end the pairing. The grant keeps one key per endpoint, so a lost race costs the pairing
  one refresh.
- **The endpoint is the rest of a key after its prefix, colons included.** An endpoint is a URL a
  reviewer typed, so `https://a.test/x:session:y` is legal and splitting on the separator files the
  entry under a worker nobody is paired with. The epoch in a session key is encoded with
  `encodeURIComponent`, which writes no colon, so the first colon after the prefix ends it.
- **The upgrade runs once per context and everything waits on it.** `splitLegacyRecord` takes one
  `get(null)` snapshot, writes only the endpoints with no key of their own, then removes the legacy
  key. `moveToRunKeys` then moves each key per endpoint to its run, the same way. Both go in
  that order, so a failure between the two leaves the credentials readable rather than gone.
  A `drop` that did not wait would remove a key not written yet and the upgrade would put the session
  back: **a logout that does not stick**, the defect the ticket is named after.
- **An upgrade that fails keeps the gate shut**, so every operation rejects. Releasing it is the
  quiet half of the same fact: a read answers that the reviewer is paired with nobody while a live
  credential sits under the legacy key. `upgradeAreas` marks its own rejection seen — an unhandled
  one stops a service worker — and still rejects for whoever waits on it.
- **`session-storage.ts` holds the keys, the `Area` factory, the upgrade and the wiring, behind a
  `StorageArea` seam**, so `node --test` reaches all of it. `session-browser.ts` is left binding
  `browser` and `fetch`. Same split as `bridge.ts`. **`createStoredSessions` is the only assembly**,
  which is what lets a test drive two `Sessions` over one storage — the popup and the background, as
  they really are — rather than over two fakes that cannot reach each other. A fake `Area` answers
  from what a test put in it, so a value the parser drops on the way out of real storage is invisible
  to it: `parseStoredSession` silently dropping the epoch is the defect that found this.
- **The epoch is read inside the sessions area, from the same snapshot as the session** — a call site
  cannot forget to ask, and no logout can land between the two halves of the comparison.
- **One refresh in flight per endpoint** (`refreshOnce` in the extension's `session.ts`). Two callers
  spending the same token is a lockout, not a wasted request: the worker treats the second as a
  retry inside the grace, revokes the first successor, and whichever answer lands last can leave the
  extension holding a revoked token. `background.ts` serialises the **alarm** only — the relay
  calls `ensureAccess` directly, and the widget has a read and a write in flight in the ordinary
  case. The lock is in `session.ts` and not the entrypoint, for the reason `bridge.ts` gives.
- **A `200` from `/session/refresh` with no `refreshToken` is not a success.** Taking it leaves a
  spent token in storage under a working access token, and the session dies when the grace runs out
  with nothing to explain it. Both call sites require the field; `parseIssued` stays tolerant.
- **`app.ts` builds the refresh answer field by field, so `refreshToken` has to be named there.**
  Leaving it out is what the route would do by default: the rotation works, the store holds the
  successor, and the client keeps sending a token the worker retired. `tsc` cannot see it and the
  extension's tests cannot either — they fake the worker. `session-routes.test.ts` asserts the body.
- **Minting a code is a command, not a route** (`node server.mjs pair --subject …`, and
  `server.mjs` because the image copies the bundle and no source). An endpoint
  would need an admin credential of its own and would stay reachable for ever; a command is reachable
  by whoever already sets the secrets.
- **Forgetting a reporter is a command too** (FRU-85): `node server.mjs forget --email … [--dry-run]`.
  It lists before it says what it did, because a typed address is a claim. Only a store that holds
  its rows implements `forget`; a tracker store is refused with where to delete instead.
  **`--name` only lists and `--id` deletes** (FRU-111): the widget asks for no address since FRU-91,
  and a name is a weaker claim than an address. One selector in a command, and one identifier that
  names no note stops the deletion of the others.
  `node:sqlite` turns foreign keys **on** by default, so deleting the pragma in `connect` is an
  equivalent mutant: test the cascade with the pragma set to `OFF`.
- **An extension origin is exempt from `ALLOWED_ORIGINS`, on every route** (FRU-42, widened by
  FRU-57). That list names client _sites_; an extension's origin carries an id that differs between
  an unpacked build and a store build, so an operator cannot put it there. Measured: an MV3 service
  worker posting JSON sends `chrome-extension://<id>` and triggers a preflight, and both answered
  `403`. The `/session/` routes needed it first; the relay then called `/feedback` the same way.
  **`isExtensionOrigin` is one predicate in `cors.ts` that both gates ask** — `resolveCors` and
  `resolveClient` — because two copies of this rule would drift apart in silence. It is a list of
  schemes rather than "not http", so everything else falls through to the allowlist. It grants an
  extension what a caller with no `Origin` already has, and `read: 'authenticated'` is still what
  decides who may read.
- **`checkRateLimit` runs above the path dispatch**, so a route added later is metered by default. It
  used to sit below the `404`, which would have left `/session/pair` an unmetered guessing oracle.
  `/health` stays free — a readiness probe that can be rate-limited takes the container out.
- **Three boot refusals, all loud rather than silent.** A session path with no
  `FRUITBACK_IDENTITY_SECRET` mints nothing; a session path with a client map in which no client
  declares a `workspace` mints tokens no client accepts; a client whose own key is the worker key
  would verify every session token as its own.
- **A session belongs to one workspace, and the `ws` claim is what separates them** (FRU-95). Every
  session token of every workspace is signed with the one worker key, so the signature proves
  nothing about the workspace. `verifyForClient` compares `ws` with the client's `workspace` after
  the signature, on the read and on the write. `pair --workspace` names it, and it travels through
  every rotation.
- **With `FRUITBACK_ACCOUNTS_PATH`, the sites are the clients** (FRU-96). `withSites` in `app.ts` reads
  them from the accounts file on every request and lays them over the configuration as its client map
  and its allowed origins, so routing, CORS and the `ws` check run unchanged. **An empty map stays
  empty**: `undefined` would make it a single-client worker that answers every page. `accounts.ts`
  holds the roles, and `can(role, action)` is the one table of who does what. The boot log says so
  too: `readExposureNotice` does not read a worker with accounts as « one client, public », which is
  what it printed on the first day of the Cloud (FRU-116).
- **Signing in ends in a pairing code, like every session** (FRU-98). `/auth/email` sends a link whose
  code is after the `#`; `/auth/email/redeem` spends it, makes the address an account, then mints and
  spends a pairing code for it. **The console's refresh token is an `HttpOnly` cookie** on
  `/console/session`, and `consoleCors` answers `FRUITBACK_CONSOLE_URL` and no other origin. A console
  session names no workspace: the `ws` check keeps it off every site. `mail.ts` is the seam, Scaleway
  Transactional Email over HTTP the one implementation.
- **A workspace connects its own tracker, and a site chooses where its notes go** (FRU-121).
  `connectors.ts` wraps the worker's store: a client with no `connector` uses it as before, a client
  with one uses a Linear store built from the key of that connector. `clientOf` puts the connector and
  the team on the client entry, so the Linear store routes as it always did. **A connector that cannot
  be used is a store that is down (`502`), never a fall back**: a note in the worker's own store would
  be invisible to the team. The key is sealed by `secrets.ts` with `FRUITBACK_SECRETS_KEY`, and no
  route answers it. The workspace of the client is compared with the workspace of the connector at the
  request too, because the row of a site is only a row.
- **A workspace connects Linear with OAuth where the worker has the application** (FRU-134).
  `linear-oauth.ts`: the console gets a ticket with its token and sends the browser to
  `/auth/linear/start`; a navigation carries no `Authorization`, so the ticket says who starts, once.
  The `state` is bound to the browser by a `SameSite=Lax` cookie, like GitHub's: without it, somebody
  could get a victim's consent on their own `state`, and the victim's Linear would land in their
  workspace. **A Linear connector keeps a key or a pair of tokens**, and `linearAuthorization` is the
  one way to the header: it refreshes a token near its end, one refresh at a time for a connector,
  and writes the new pair before it uses it. A personal key goes raw, a token goes with `Bearer`.
  The connector is named `Linear OAuth · <workspace>`, and the console reads that prefix.
- **A connector can be an address that only receives** (FRU-122). `rest` is no store: the note is
  kept in the worker's own store first, then `receivingStore` puts a row in `deliveries`, and the
  server's loop (`deliverPending`, every 15 seconds, one pass at a time) posts the rows that are due.
  **The attempts of a pass run together**, and one deadline covers a whole exchange: the `timeout` of
  a Node request is an idle time, which a receiver that sends a byte now and then never reaches.
  **The widget is answered when the note is kept**, and a queue that refuses the row is logged and
  does not fail the request: a `502` there would keep the note twice. A row goes when its note
  arrived, so the table holds what is late or given up.
- **`rest-send.ts` checks the address when the socket resolves it**, through the `lookup` of the
  request. A check before the request is passed by a name that answers twice. `isPublicAddress`
  refuses the private, link-local and mesh ranges, and one internal answer refuses the name. The
  sender takes `request`, `lookup` and `allows` as seams, so the tests reach the real code on a
  local socket: the production sender, given the same local server, must refuse it.
- **`docs/rest-connector.md` is a contract**, and `rest-connector.test.ts` holds its waits, its
  timeout, its headers, its body and its `openssl` example to the code. A `Destination` has a team
  for a tracker and none for an address, and `destinationOf` asks the kind of the connector.
- **An e-mail is written in the language of its reader** (FRU-119). An account holds a `locale`: the
  browser that opened its first link, then what the person chose (`POST /console/me/locale`). A later
  sign-in from another browser does not change it. For a mail, the account's language wins, then the
  console that asked, then `Accept-Language`, then English. `readLocaleTag` parses every one with
  `Intl.Locale`: a value from a browser is never kept as typed.
- **GitHub names the person, never the browser** (FRU-97). `github-oauth.ts`: `state` bound to the
  browser by a `SameSite=Lax` cookie (a `Strict` one is not sent on the way back from github.com),
  issued by this worker and spent once; PKCE; the account is GitHub's **verified primary** address.
  `FRUITBACK_PUBLIC_URL` is the callback's base: behind the proxy the worker sees only `http://`.

### The reasons, and the history

- **The reviewer is not a visitor who typed a name** (FRU-42). FRU-9 defined `reporter.verified`
  and left nothing able to set it on this side: a client site could mint an identity token, and the
  extension could not. A session is what finally makes that flag the worker's own word.
- **The operator vouches, and the code carries who for.** A pairing code is minted _for_ Alice, with
  her name and address in it. The alternative — the extension supplying a name at pairing time — is
  the browser asserting an identity again, which is the hole FRU-9 was written to close. It was
  rejected for that reason and not on ergonomics.
- **The access token is an ordinary identity token, and that is the whole economy of the design.**
  `identity.ts` already mints and verifies HS256 JWTs, and both request paths already check them. A
  session that mints the same shape adds no second verification path, and `read: 'authenticated'`
  (FRU-40) started accepting the extension with no change to a single line of the read path.
- **Rotation was refused once, and then built** (FRU-61). It needs a grace for the answer that never
  arrives, and until FRU-60 there was no client half to measure that against. There is now, and the
  measurement changed the design — see _Rotation, and the grace that is not a clock_ below.
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
  spend, this guard _is_ observable: the test makes the insert collide on `sessions.token_hash`,
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

- **Revocation is mutation-tested.** `findSession` is gone since FRU-61 — every read of a session
  rotates it, so there is no lookup beside `rotateSession`. Dropping `revoked_at IS NULL` from
  `revoke` still fails test:`revokes on the worker, so the refresh token stops working everywhere`, and
  dropping the chain revocation from `revokeSession` fails test:`ends the whole chain on log out, not only
the token it was handed` and test:`ends a chain from any link, including the token nobody is holding`,
  and not inheriting `root_hash` on the successor fails nine tests at once.
- **The CORS exemption is mutation-tested.** Replacing `openCors` with the ordinary `resolveCors`
  fails both test:`answers an extension origin that is on no allowlist` and test:`lets the preflight through,
or the POST never happens`. What says the exemption is not a hole in the gate is
  test:`leaves the allowlist in force on /feedback for sites, and admits the extension`: an ordinary site
  origin that is on no allowlist is still refused there.
  - Two of those three names were quoted here **truncated**, and the second was quoted with a
    sentence that had stopped being true. The exemption was scoped to `/session/` when this was
    written; FRU-57 widened it to every route, because the relay calls `/feedback` from the service
    worker. The test was renamed to say so and this paragraph was not. Found while fixing a third
    stale test name a reviewer caught on this ticket — `grep` for a quoted name is the check, and
    nothing runs it.
- **The rate-limit move is mutation-tested.** Putting `checkRateLimit` back below the path dispatch —
  where it sat before this ticket — fails test:`meters the pairing endpoint, not only /feedback`. The
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
with an extension loaded, which FRU-45 exists to build and which does not exist yet. Shipping them
together would let the half nobody can test ride in on the half that is.

Per-client session minting was absent for a stated reason rather than an accidental one: a session
signed with the worker-wide key, and a worker with `FRUITBACK_CLIENTS` ignored that key. The pair was
refused at boot instead of shipping a feature that paired successfully and then answered `401` to
everything. FRU-95 lifted it, below.

## Rotation, and the grace that is not a clock (FRU-61)

A refresh token that never changes is a thirty-day password. A copy taken from a browser profile
stays good for the rest of that month, and nothing observes the theft. Rotating on every refresh
makes its use **visible**.

It does **not** make the copy useful for at most one cycle, which is what this paragraph said until a
reviewer read it properly. A refresh token is a bearer credential and whoever presents it is served.
Inside the grace each presentation of the spent token revokes the successor the one before it
minted, so it is the **last** presenter who ends up with the live chain: a thief who gets in after
the real client takes the session and the client's own token is revoked under it. The first version
of this paragraph said _first_, which is the opposite of what the code does. Measured, and kept as a
test — test:`serves whoever presents last inside the grace, until the earlier holder comes back`. What rotation guarantees is that the two cannot both
keep the session quietly, which is a detection property and not a lifetime one.

### The ticket asked for a replay window. Two measurements said no.

The ask was that a rotated token stay accepted for _a few tens of seconds_ and hand back **the same**
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
revoked under the client was never rotated at all. Asking the chain is stricter _and_ simpler:
after a logout nothing in the chain is live, so a logout stops reading as a replay on its own.

Both mistakes were raised in review, one round apart. See _the hole the grace left_ below for the
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
it failed no test at all until test:`takes a third presentation inside the ceiling, not just a second` was
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
were rewritten rather than deleted — test:`ends the chain when an orphan is presented and something in it
is still live`, and test:`serves whoever presents last inside the grace, until the earlier holder comes
back`.

## A session on a worker that serves several clients (FRU-95)

The lock of the Cloud, and of a self-hosted worker with several clients. Until here, sessions and a
client map were refused together at boot.

- **A session belongs to one workspace.** The operator names it when the code is minted
  (`pair --workspace acme`), the pairing row keeps it, the session copies it, and every rotation
  copies it again. It is a column of `pairings` and of `sessions`, added by the third migration of
  `session-sqlite.ts`. A row written before has none: that session belongs to a single-client worker.
- **One key, and a claim.** The ticket asked: one signing key per workspace, or one key and a
  workspace claim checked on every read. One key: a key per workspace is a secret per tenant to mint,
  store and rotate, and the claim is checked anyway. The access token carries `ws`. Every session
  token of every workspace verifies under the worker key, so **the signature proves nothing about
  the workspace**, and `verifyForClient` in `app.ts` compares `ws` with the workspace of the client
  after the signature. Mutated: without the comparison, six tests of `workspaces.test.ts` fail.
- **The site's own key first.** A client that mints its own tokens (`identitySecret`) keeps doing so.
  A token is tried with that key, then as a session token. A client whose own key **is** the worker
  key would verify every session token as its own and skip the comparison, so that is refused at
  boot.
- **The relay needs no change.** It sends the session token of the stored endpoint, and the worker
  is what refuses a client of another workspace. The test sends both reads from a page origin and
  from an extension origin.
- **What stays refused.** Sessions with a client map in which no client declares a workspace: a
  session there reaches nothing. And `pair` with no workspace on a worker that has some, or with a
  workspace no client declares.
- **What `/health` says is unchanged.** It counts open reads and names no client, and a workspace is
  the same kind of fact as a client id.

## Several client sites

### The rules, in short

- **`FRUITBACK_CLIENTS` maps a `clientId` to a team, a project and the origins that client may be
  embedded on** (FRU-15). Configured, a client has to be named on **both** paths — the `client`
  parameter on a read, `seed.client.id` on a write — and an unknown one is refused. A read that named
  nobody used to answer with every seed on that URL.
- **`normalizeClientId` runs before the id is used for anything.** It picks the route, builds the
  `fruitback:<id>` label of the issue, is the client a read compares each seed with, and keys the cache. Normalising it for the route alone
  put a note in the right team under a label its owner's clean read never asked for: authorised at
  both ends, invisible in between.
- **`resolveClientIp` is security-relevant.** The client IP is the entry `TRUSTED_PROXY_HOPS` from
  the **right** of `X-Forwarded-For`. Reading the leftmost entry makes the rate limit bypassable with
  one header. **Do not write that each proxy appends**: nginx with `$proxy_add_x_forwarded_for`
  appends, while nginx with `$remote_addr`, Traefik and Caddy replace the header (measured, FRU-50).
  The self-hosting guide depends on the difference.
