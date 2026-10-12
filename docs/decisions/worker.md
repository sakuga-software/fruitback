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

## Several notes in one request (FRU-124)

- **`POST /feedback` with an array is a batch; an object is one note**, as before. The relay of the
  extension, CORS and the list of paths do not change. The worker offers a batch in the envelope of
  `GET /feedback` (`batch: { max, maxBytes }`), as it offers `stages`. A widget that gets no `batch`
  sends its notes one by one, so a worker of before never receives an array.
- **`max` is half the limit of a minute, ten at most** (`maxBatch`), and `maxBytes` is the cap of the
  body, which does not move for a batch. The widget cuts its drafts into as many requests as it needs.
- **Every seed is read before anything is written**: a batch with one thing that is not a seed, the
  same seed twice, or two clients is refused whole (`400`). One identity, one place (`?destination=`)
  for the whole batch.
- **The N − 1 other notes are counted by the limiter after the body is read** (`chargeRateLimit`, with
  the amount of `Kv.incr`), before any write.
- **A store groups a batch with `createBatch?`**: Linear writes a parent issue, which holds no seed
  and is no pin, and one sub-issue for each note, which keeps its seed and its state. A store without
  it gets one `create` for each seed (`createAll` in `batch.ts`).
- **One answer for each seed, in order**: `201` when every note was kept, `207` when some were, `502`
  when none was. **A seed kept in the last ten minutes answers its issue again** and is not planted
  twice: `seed.id` is the key, in the `Kv`. That is what a widget sends again after a `207`.
- **A parent whose sub-issues Linear all refused is kept, and used again** (FRU-195). The request
  answers `502` and the parent stays in the team with no sub-issue. The worker remembers it in the
  `Kv` for the ten minutes of a seed, by seed and by place (`batchMemory` in `app.ts`), and the next
  attempt for one of those notes writes its sub-issues under it: one parent for a batch, not one for
  each attempt. The note of a `207` that is sent again goes under the same parent too. **The worker
  archives nothing and changes nothing in the workspace of a team**: it calls `issueCreate` and no
  other mutation of an issue, so this asks no permission more than a batch did. A parent that was
  used again and still kept no note is forgotten, and the attempt after it writes a new one: it may
  be a parent the team deleted, and holding on to it would refuse the notes for ten minutes. A `Kv`
  that does not answer costs a second parent, never a note. **Not measured on a real Linear**: that
  a sub-issue takes a `parentId`, and what Linear answers for a parent that is gone, are read in
  its schema and held by a double (`batch-parent.test.ts`). An empty parent that nobody sends again
  stays: the team deletes it.
- Not done: the delivery of an address that receives (FRU-122) does not carry the id of its batch.

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
- **A connector of a workspace has its own settings** (FRU-102), in one JSON column `settings` of
  `connectors`, read by `connectorSettingsOf` and written by `setConnectorSettings`. The next setting
  of a connector needs no migration. `connectors.ts` applies them to the store of the connector:
  - `showComments: false` takes the replies away; `true` keeps what the worker decides. It can never
    show what `FRUITBACK_HIDE_COMMENTS=1` hides.
  - `stages` holds the exceptions to the projection by type, by **id** of the state, never by name: a
    state that is renamed keeps its colour. A state with no entry takes the stage of its type
    (`stageForLinearState`). `GET /console/workspaces/:id/connectors/:id/states` lists the states of
    the teams the sites of the workspace send to, with the stage of each type.
  - A change reaches the next read of the tracker. The read cache keeps an answer for its TTL.

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
- **The stages are the ones of the tracker that answers for the site** (FRU-201). A site that sends
  to a connector of its workspace is read there, so `createRoutedStore` answers `stagesFor(client)`
  from the store of that connector, and the store of the worker only for a site with no destination.
  A worker on GitHub (three stages) whose site sends to Linear (five) offered three until then. A
  site read in several places gets every stage one of them reports, in the order of `SEED_STAGES`.
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

## The conformance suites of the accounts and the sessions (FRU-140)

### The rules, in short

- **Every `AccountStore` passes `account-conformance.test.ts`, and every `SessionStore` passes
  `session-conformance.test.ts`.** The cases are in `account-conformance.fixture.ts` and
  `session-conformance.fixture.ts`, written once against the interface. A new implementation adds a
  subject to the test file: test:`runs for every implementation the worker exports` reads the
  exported `create…` functions that answer the type, and fails on one that no subject names.
- **A rule of the interface is a case, and a case has a planted violation.** `VIOLATIONS` in each
  test file gives, for each case, one change that breaks its rule. The control applies the change and
  requires the case to fail. A case with no violation, and a violation for a case that is gone, both
  fail test:`plants a violation for every case, and for no case that is gone`.
- **A violation is a change to the source of the SQLite store**, applied to a copy in a temporary
  directory (`mutatedModule` in `conformance.fixture.ts`). For the accounts that source is
  `accounts-sqlite.fixture.ts` since FRU-150: the worker exports no account store on SQLite, and the
  file stays as the reference of the controls. The text to change is in the test file: a
  change to the store that removes that text fails the control with the text, and the violation is
  written again. Do not weaken a case to make a control pass.
- **A race is a case too, and its violation is a store that waits.** `node:sqlite` is synchronous, so
  no change to the SQLite store loses a race. The cases that run calls at the same moment have a
  store that reads, waits a turn of the event loop, then writes: one account for one address, one
  sign-in for one link, one whole list of destinations for one site, one session for one code, one
  live successor for one token, one end for a token and its successor, no live successor of a
  refresh when the sessions of a member end (FRU-149). On SQLite these cases prove nothing: they are
  there for a store on a network.
- **A rule that a foreign key holds has a store around the real one too.** A destination goes with
  its site, its connector and its workspace, and only with them. Without the key the statement
  fails, and a store that throws proves nothing of the case: the control wants an assertion of the
  case to fail. So the violation removes too much, through the interface.
- **What is true of one file format stays out of the suite**: the bytes of the file and of its
  `-wal`, `PRAGMA user_version`, a blob in a `TEXT` column, the cascade read with the foreign keys
  off, a file of a version before. Those are in `accounts.test.ts` and `session.test.ts`, with what
  `session.ts` does above any store.

### The reasons, and the history

- **The suite reads a store through its interface only.** The purge has no reader in the interface,
  so its case turns the clock back: a row that the purge left answers at an instant before its expiry.
- **`redeemPairing` of `session.ts` purges before it redeems**, so a late code is gone before the
  store compares its expiry. The first version of the case went through that function and passed with
  the comparison removed. The case now asks the store directly, at the expiry and one millisecond
  each side.
- **Two cases were made stricter when they moved.** test:`leaves the token a client just received
alone when its predecessor is retired` checked the answer of the rotation and not the token in it:
  a store that revoked the whole chain and still answered `rotated` passed. It now uses the token.
  test:`tells a logged-out token apart from a replayed one` checked a refusal, which a replay gets too:
  it now reads `gone` from the store.
- **The ids are a rule.** `acc_`, `ws_`, `site_`, `con_` and `dlv_` with 20 hexadecimal characters:
  they are in the tokens and in `reporter.id` of the notes already written.
- **Not covered, on purpose**: the 100 rows that `deliveries` answers at most, and the walk of the
  `SITE_COLUMNS` of a row that somebody edited by hand.

## The accounts in PostgreSQL (FRU-141)

The first slice of FRU-139 that touches production code. **Nothing changes for a worker that does not
set `FRUITBACK_DATABASE_URL`**: SQLite stays the default. With the variable, the sessions are in the
same database since FRU-142: see the section after this one.

### The rules, in short

- **`FRUITBACK_DATABASE_URL` puts the accounts in PostgreSQL**, and since FRU-150 nowhere else:
  `FRUITBACK_ACCOUNTS_PATH` is refused at boot. Ask `hasAccounts(config)`, and never the field.
- **`postgres.ts` is the one file that names the driver**, as types, and it loads `pg` at the first
  call. A lint rule holds the import, and test:`loads no file of Drizzle and no file of the driver
for a worker without the variable` holds the rest in a process of its own. `/health` opens no
  database.
- **`Database` is the seam**: `run`, `transaction`, `alone` and `close`. It hands a store the `Db` of
  Drizzle (FRU-180: see _The database in Drizzle_). `createPgDatabase` is the one implementation
  that ships. The tests have a second one on PGlite, in `postgres.fixture.ts`.
- **A `BIGINT` is answered as a number.** Every instant is a `BIGINT` of milliseconds that the worker
  gives, as in the SQLite files, and the driver answers a string for that type by default. The
  schema converts it (`mode: 'number'`), so `account-rows.ts` parses a row of either database.
- **No message holds the address of the database.** It carries the password. A value that is refused
  is named by its variable, and `withoutAddress` takes the address and the password out of what the
  driver says. A database that does not answer is `StoreError`, so `502`, and the reason is in the log.
- **Each connection of the pool has a listener for `error`, for its whole life** (FRU-187). A
  connection that the server closes emits `error`, and with no listener the process stops. The pool
  listens to a connection only while it is idle: one that a transaction, a migration or better-auth
  holds is not listened to by the pool. The call on that connection fails with `502`, and the
  worker stays up.
- **One schema and one folder of migrations for the whole database**: `postgres-schema.ts` and
  `drizzle/`, since FRU-180. See _The database in Drizzle_ for how a migration is written, applied
  and held.
- **`setDestinations` is one transaction that holds the row of its site** (`for('update')`), and the
  row of each connector until it ends (`for('key share')`). SQLite checked, then wrote, with nothing
  between. A list is removed and written again, so two lists for one site must come one after the
  other.
- **A site and its destinations are one statement**, a `LEFT JOIN`, where SQLite reads the sites and
  then every destination. It is one exchange with the server for a request, and one moment of the
  database. `clientMap` orders by position alone: read the numbers below before you add a column to
  that `ORDER BY`.
- **PGlite is the PostgreSQL of `node --test`, and it cannot show a race.** It has one connection, so
  a transaction holds every other call back. The CI job `postgres` runs the same cases on a server,
  and `test:postgres` fails when the address of that server is missing: a suite that is skipped
  proves nothing.
- **The sites are still read on every request, on purpose**: see the numbers below before you add a
  cache.

### The reasons, and the measurements

- **What SQLite did without saying it.** One connection that does one thing at a time made a read
  followed by a write safe. `accounts-postgres.ts` writes each of those on purpose, and its header
  lists them: `ON CONFLICT … DO NOTHING` for `INSERT OR IGNORE`, an insert that names its conflict
  for a new account, one `INSERT … ON CONFLICT … DO UPDATE` for `addSite`, `IS DISTINCT FROM` for
  `IS NOT ?` with a null, one `UPDATE … RETURNING` for a link.
- **The race that only a server shows is planted.** An insert of an account that reads first and
  names no conflict is correct one call after the other. It passes every case on PGlite, and on a
  server test:`fails on a real server when the insert names no conflict` gets `23505`.
  test:`passes on PGlite with an insert that names no conflict` is the other half, kept so the sentence
  about PGlite stays measured.
- **So is the race of two lists.** Without the lock on the site, the second transaction removes the
  rows it saw, not the ones the first one wrote, and both write position 0.
  test:`fails on a real server with no lock on the site` gets `23505` from the key of the table, and
  test:`passes on PGlite with no lock on the site` is the other half.
- **The database never copied the one destination a site had.** Migration 7 of the SQLite file
  copies the three columns of `sites` into `site_destinations`. Migration 2 of the tool of before did
  the same, and no database was at migration 1 when it was written, so it moved nothing anywhere.
  The first migration of Drizzle makes the tables as they are after it, with no copy
  (gone-test:`gives a site the one destination it had before the list existed`): a database that
  ran migration 2 had its copy then, and is adopted as it is (FRU-180). The three columns stay in
  `sites`, unread: the two schemas have the same columns.
- **The driver is CommonJS in an ESM bundle.** esbuild keeps its `require('events')` as a dynamic
  require, which an ESM file does not have. Measured on the bundle against a server: without the
  `createRequire` banner of the build script, the first read answers `502`, and `/health` answers
  `200`. With it the worker applies its migration and answers. The `docker image` job boots the image
  on a database for that reason, and probes a read, not `/health`.
- **The bundle went from 739,751 to 951,408 bytes** with `pg` 8.23.1 and its six packages. PGlite is
  not in it: no shipped file may import it.
- **A restart of PostgreSQL stopped the worker** (FRU-187). Measured on a worker started with
  `node src/main.ts` on PostgreSQL 17: the backend of a `/session/pair` that waits in its
  transaction is ended with `pg_terminate_backend`. Before the fix the worker stopped with
  `Unhandled 'error' event` (`Connection terminated unexpectedly`, `pg/lib/client.js`), and the
  request got no answer. The pool of `pg-pool` 3.14 removes its listener from a connection when it
  hands it out, and puts it back when the connection is released. `postgres.ts` now adds one
  listener to each connection when the pool makes it. test:`answers an error for that request, stays
up, and serves the next one` runs that worker in a process of its own: the defect stops a process.
- **An outage of the accounts is in the log now.** `handleRequest` answered `502` and wrote nothing,
  for SQLite too. That is how the missing banner looked like a database that was down.

### The sites are read on every request, and that was measured

`withSites` reads every site on every request, `/feedback` included. On a file that is free. On a
database it is one exchange with the server. Measured on 2026-10-11, after a site got its list of
destinations (#134), on one machine, PostgreSQL 17 in a container reached through a published port.
Every site but the one that is read has two destinations. 500 calls after 50 to warm up, three runs,
and for each cell the middle value of the three: median and p95.

| Sites | `clientMap`, SQLite | `clientMap`, PostgreSQL | `GET /feedback`, SQLite | `GET /feedback`, PostgreSQL |
| ----- | ------------------- | ----------------------- | ----------------------- | --------------------------- |
| 1     | 0.013 ms, 0.017 ms  | 0.201 ms, 0.691 ms      | 0.054 ms, 0.074 ms      | 0.213 ms, 0.469 ms          |
| 100   | 0.322 ms, 0.427 ms  | 0.576 ms, 1.374 ms      | 0.380 ms, 1.205 ms      | 0.619 ms, 1.138 ms          |
| 1000  | 3.274 ms, 6.506 ms  | 4.018 ms, 7.710 ms      | 4.049 ms, 10.290 ms     | 5.489 ms, 9.563 ms          |

The read of a pin is on the memory store with a warm cache: the fastest read there is, so the
database is the largest share it can be.

**The list of destinations made this read three to five times dearer, on both databases.** Before
it, on 2026-10-10, `clientMap` for 1,000 sites was 0.8 ms on SQLite and 0.7 ms on PostgreSQL, and the
first version of this section said « about one millisecond ». Where the rest goes, measured:

- `clientOf` for 1,000 sites of two destinations is 0.93 ms, and 0.03 ms when they have none. 0.70 ms
  of it is `destinationId`: one SHA-256 for each destination, on each request.
- The statement, on the server, for 1,000 sites and 2,000 destinations: 0.7 ms, and 0.05 ms for the
  one table before. With the id of the site in its `ORDER BY` it is 1.5 ms, which is why `clientMap`
  orders by position alone.

**Decision: no cache in this slice.** The ticket offered a short cache, or a version in the `Kv`.
Neither was taken, for three reasons:

- What PostgreSQL adds is the difference between two columns: less than 1.5 ms for 1,000 sites, and
  0.25 ms for 100, on the same host. A read whose cache is cold calls a tracker, which is hundreds
  of times that.
- A cache changes what is observable. Today a site is served the moment it is added and refused the
  moment it is removed, and a test holds it on both databases. A short cache serves a removed site
  until it ends. A version in the `Kv` is exact only while the `Kv` is in the process: on two
  replicas it is a short cache again, and two replicas are what PostgreSQL is for.
- What grows with the number of sites is not the exchange. It is reading every site, and now naming
  every destination, to route one client: 3 to 5 ms for 1,000 sites, on SQLite too. The answer to
  that is to read one site by its id, and the origins for CORS apart. That is a change to
  `withSites`, not a cache, and no slice of FRU-139 has it.

**Not measured: a database on another host.** There the cost is the round trip of that network on
every request, and this decision must be measured again before such a deployment. The same holds
above a few thousand sites.

## The sessions in PostgreSQL (FRU-142)

**Nothing changes for a worker that does not set `FRUITBACK_DATABASE_URL`**: a self-hoster with no
accounts keeps its session file and `node server.mjs pair`. This store is not a step towards
better-auth: it holds the session of the extension, and it stays.

### The rules, in short

- **With `FRUITBACK_DATABASE_URL` the sessions are in the database, and `FRUITBACK_SESSION_PATH` is
  refused beside it.** One source, as for the accounts. Ask `hasSessions(config)` and never
  `sessionPath`: a route that reads the field is off for a worker on a database.
- **`session-postgres.ts` has the tables, the columns and the digests of `session-sqlite.ts`**:
  `pairings` and `sessions` of `postgres-schema.ts`. `session-rows.ts` parses a row of either
  database.
- **A code is spent by one statement that reads what it changes.** Do not read `redeemed_at` in
  another statement, or in a subquery: the second of two calls then reads the code as it was.
- **A rotation and a log out hold the head of their chain, `for('update')`, before they read the
  token.** `holdChain` is the one place. A rotation is several statements, and none decides alone.
- **`pair` writes in the database, and `main.ts` closes the pool after a command.** Without that the
  command ends ten seconds after its answer.
- **A race is planted with `outcomeOnChangedStore`**, which makes the two calls overlap. Do not write
  a control that waits for the scheduler: see below.

### The reasons, and the measurements

- **What `BEGIN IMMEDIATE` did without saying it.** The SQLite store has one writer at a time for
  the whole file. Here two refreshes are two connections, and with no lock both read « never
  rotated » and leave two live successors. The chain of a token never changes, so it is read first
  with no lock; the token is read again when the chain is held.
- **The three rules of the ticket are cases of the suite**, so SQLite, PGlite and a server run them:
  one session for one code, one live successor for one token refreshed twice, and the end of the
  chain when a token and its successor come together. Each has a store that loses the race, planted
  in `session-postgres.test.ts`: it passes on PGlite and fails on a server, on an assertion of the
  case. test:`fails on a real server with no lock on the chain` is one of the three.
- **The planted store of the code reads it in a subquery.** One call after the other it is correct.
  With two, the second `UPDATE` waits for the row, and reads the row again: but the subquery is read
  as it was when the statement started, so the code is still to spend.
- **A planted race does not wait for the scheduler.** The first control of this kind, for the
  accounts, passed in CI on one head and failed on the next, which changed one line of a document:
  nothing made the two calls overlap. `outcomeOnChangedStore` holds each new row for 0.3 s in a
  trigger, inside the transaction, and opens two connections before the case. That failure was not
  reproduced on a developer machine (25 runs of 25, then 12 of 12 with the server at half a CPU):
  the cause is read from the code, and CI is what says the fix holds.
- **No code and no token is in a row.** test:`holds no code and no token in clear, in any row of any
table` reads every table of the schema after a code was spent, a session refreshed and one logged
  out. test:`finds a token that a row holds in clear` is its control.
- **`pair` ends.** test:`writes the digest of its code in the database, and ends` runs the command as
  a process against a server, with 8 seconds to end. Measured without the line that closes the pool:
  the process is killed at 8 seconds.
- **Whoever can write to the database can write a session**, as whoever could write the session file.
  `SECURITY.md` says it, with what the database holds.

## better-auth, built and switched off (FRU-144)

The first slice of FRU-139 that adds better-auth. **It changes nothing a caller can observe**: no
route is new, and a worker without `FRUITBACK_AUTH_SECRET` loads nothing of the library. What is here
is its configuration, its tables and the guards, so the slice that signs a person in with it is small.

### The rules, in short

- **`FRUITBACK_AUTH_SECRET`, with `FRUITBACK_DATABASE_URL`, switches better-auth on.** The worker then
  builds one instance when it starts (`announceAuth`, from `server.ts`) and says so in its log.
  Without the secret, `authFor` answers `undefined`: nothing is loaded and nothing is opened. Ask
  `hasAuth(config)`, as you ask `hasAccounts(config)`.
- **Off, better-auth serves no route.** No path under `/console/auth/` answers anything but `404`,
  with or without a database: test:`answers 404 on every route of better-auth when it is off, with
or without a database`. On, it serves the paths of `SERVED_PATHS` and no other (FRU-147: see _The
  console signs in with better-auth_). A worker whose database does not answer says `502` there, as
  on every route: the accounts are read before the dispatch.
- **`auth.ts` is the one file that names better-auth**, as types, and it loads the library when the
  instance is built, as `postgres.ts` does for its driver. A lint rule holds the import, for `kysely`
  too. test:`loads no file of better-auth for a worker that has it off, and answers 404 under
/console/auth` holds the rest in a process of its own, and test:`keeps better-auth and the driver
behind a dynamic import, so the image runs none of them at boot` holds it on the graph of the bundle.
- **It does not take the place of the session of the extension.** `session.ts` stays as it is: a
  token that rotates, and a replay that ends the chain. A session of better-auth is one token that
  does not rotate.
- **The `bearer` plugin is never in the configuration**, and `jwt` and `deviceAuthorization` are not
  either. `REFUSED_PLUGINS` in `auth.ts` gives each its reason, and `startAuth` refuses to build an
  instance that has one. With `bearer`, a session opens with its token in an `Authorization` header,
  which a script can send: test:`opens no session with the row of the session table, and the bearer
plugin opens one with the token alone` keeps it measured, with and without the layer below.
- **The database keeps no usable secret of better-auth, even with `FRUITBACK_AUTH_SECRET` beside it**
  (FRU-181). The plugin `fruitback-at-rest` (`auth-at-rest.ts`) puts a layer between better-auth and
  its database adapter: `session.token` and `verification.identifier` are kept as their SHA-256,
  every value that reaches them, written or looked up, and the token columns and the password of
  `account` are written empty. `startAuth` refuses options without the plugin, and with a
  `secondaryStorage`, which keeps the tokens around the layer. **No key is added**, so there is no
  rotation to keep.
- **The worker keeps no token of GitHub or Google, so it can never act at a provider in the name of
  the person who signed in.** A feature that needs it is a decision first, with a key of its own
  beside `FRUITBACK_AUTH_SECRET`, and never `encryptOAuthTokens`, whose key is that secret. Nothing
  relies on those tokens today: the connector of Linear keeps its own, sealed with
  `FRUITBACK_SECRETS_KEY`, the GitHub App signs with its private key, and the old sign-in path
  reads the profile and keeps no token.
- **A session is named by its id, never by its token.** A row read back through the layer has the
  token its caller gave, and a row of a list has none. So `/revoke-session` and
  `/revoke-other-sessions` are in `DISABLED_PATHS` with `/get-access-token`, `/refresh-token` and
  `/account-info`: `404` to a request, and a call in the process throws (`closedPath`). « Sign out
  everywhere » is `/revoke-sessions`. A screen that ends one session of a list (FRU-104) ends it by
  its id, with a route of the worker.
- **A plugin that writes a secret in `verification.value` is measured before it is added.** The
  layer digests the identifier, not the value. `email-otp` keeps its code in the value, and the
  state of OAuth kept its PKCE verifier there, which is why it is in a cookie
  (`storeStateStrategy: 'cookie'`). Each new way to sign in joins the sweep of
  test:`keeps no state of a sign-in with a provider, and no token of the provider, in any row`.
- **The adapter is read before a version of better-auth is trusted.** The layer knows the members of
  the adapter of 1.7.7 (`ADAPTER_MEMBERS`) and refuses an adapter with another one, which could read
  or write a row around it: test:`knows every member of the adapter that better-auth builds, and no
other`.
- **One tool migrates the database, and it is Drizzle** (FRU-180, section below). The tables of
  better-auth are written in `auth-schema.ts`, in Drizzle: the tables that better-auth compiles for
  the options of `auth.ts`, and two constraints more: `UNIQUE ("organizationId", "userId")` on
  `member`, and `UNIQUE ("providerId", "accountId")` on `account` (FRU-146). `drizzle-kit generate` writes their migration with the tables of the worker. `auth
migrate` and `runMigrations()` never run on a database of the worker. **A plugin, a field or a
  version of better-auth that changes its schema is a change of `auth-schema.ts` and a migration
  that `drizzle-kit` generates**: the tests of the schema say what is missing.
- **better-auth keeps its own adapter, Kysely, on the pool of `postgres.ts`.** It does not read the
  schema of Drizzle, and it does not need to: it reads the database. `getMigrations` and the probe of
  `startAuth` work with this adapter only (read: concepts/database), and they are the guards of this
  section. The layer of FRU-181 sits on that adapter. Changing it for the adapter of Drizzle is a
  question of FRU-182, on the weight of better-auth, and FRU-180 does not answer it.
- **`RIGHTS` of `accounts.ts` stays the one table of who may do what.** `auth-roles.ts` asks `can` for
  each role and each action and writes the answer for the organization plugin. `IMPLIED` says what
  an action gives in the words of the plugin: `manage-members` invites and removes,
  `manage-workspace` renames, `delete-workspace` deletes. An action with no line there does not
  compile, and `roleStatements` refuses it at run time. The routes of the worker go on calling `can`.
  `read-members` (FRU-149) gives nothing in the plugin, which asks no permission to list the members:
  the route of the worker asks `can` for it.
- **The limit of the worker is the only one, and better-auth reads no address.** Its own limit is
  off (`rateLimit.enabled: false`) and it tracks no address (`disableIpTracking`). The worker counts
  above the dispatch, for every route, with the address that `resolveClientIp` read.
- **No `BETTER_AUTH_…` variable in the environment of a worker that has better-auth on.** better-auth
  reads them by itself, over its options. `readConfig` refuses the prefix, and names the variable
  without its value.
- **The options that close something are written in `authOptions`, even when they are the default.**
  The cookie is `__Secure-fruitback.session_token`: `HttpOnly`, `Secure`, `SameSite=Strict`,
  `Path=/console`. One trusted origin, the console. No cookie cache, no password, no telemetry.
- **An id of better-auth has the shape of every id of the worker.** `authId`: `acc_` for a `user` and
  `ws_` for an `organization`, which are the ids the worker already gives, then `ses_`, `lgn_`
  (`account`), `ver_`, `mem_` and `inv_`. A table with no prefix throws.
- **better-auth is pinned to one exact version in the catalog**, like `pg`. A test refuses a range.
  Read the documentation of that version again before you change an option: do not trust this page,
  or a ticket, for the name of one.

### The reasons, and the measurements

Read on 2026-10-11 in the documentation of better-auth 1.7.7, the `latest` of npm that day:
installation, basic-usage, concepts/api, concepts/cli, concepts/cookies, concepts/database,
concepts/rate-limit, concepts/session-management, adapters/postgresql, plugins/organization,
plugins/bearer, reference/options, reference/security, reference/telemetry and guides/optimizing-for-performance. Each fact below says
whether it was read there, read in the source of the package, or measured.

- **Why it is built when the server starts, while it serves nothing.** `/health` reads no database
  and no library, so a bundle that cannot load better-auth is green there. That is how the bundle
  without its `createRequire` banner answered `200` on `/health` and `502` on every read (FRU-141).
  Built at the first sign-in, a bundle or a schema that is wrong would show there, to a person. So
  a worker that has the secret builds it at boot and writes one line: « better-auth is ready, under
  /console/auth », or why it did not start. `/health` does not wait for it.
- **better-auth reads the schema of the database while it starts** (measured, with
  `NODE_ENV=production` too; reference/options says « outside production », concepts/database says
  « including in production »). On an empty database it writes « Database schema mismatch » in the
  log before any request. So `authFor` applies the migrations of the worker first, and builds
  nothing when they fail: test:`loads nothing of better-auth while the database of a worker that has
it on does not answer`.
- **A context that is built is not an instance that is ready** (measured). On a schema that is wrong,
  better-auth builds its context all the same. It is the first request that is rejected, and every
  one after it: `auth.handler` rejects with `SCHEMA_MISMATCH`, it does not answer `500`. So
  `startAuth` asks the instance for `/ok`, in the process and through no socket, before it answers,
  and the line of the boot then says what is missing in place of « ready ». The message of
  better-auth ends with « Run `npx auth migrate` », which is the one thing not to do on a database
  of the worker: the worker writes its own words. test:`refuses to call better-auth ready on a
schema that lost a column, and names the column` holds it. **The mount catches that rejection**
  (FRU-147), and answers `502` with the reason in the log: test:`answers 502, and says why in its
log, when better-auth rejects`.
- **A pool of `pg` is what better-auth takes** (read: adapters/postgresql). `postgres.ts` hands over
  the pool of the process, `PgDatabase.pool()`, and nothing else may take it. The tests on PGlite
  give better-auth a pool made of the instance of the case, in `postgres.fixture.ts`: one client out
  at a time, because PGlite is one connection. On a real server they use the pool that ships.
- **What `getMigrations` reports, and what it does not** (measured). It reports a table and a column
  that are missing, and a required column that better-auth never fills. It writes in its log a
  column of another type and a required column that takes a null: the tests read that log. **It reports no index of one column, no foreign key and no unique constraint that an existing table lost.** So
  test:`makes the tables that the migration of better-auth itself makes, and two constraints more`
  compares the catalogue of PostgreSQL after the migrations of the worker with the catalogue after
  better-auth's own migration, on a second empty database, and
  test:`finds an index, a cascade and a unique constraint that the migration lost` is its control.
- **The address of the caller.** The framing said that better-auth reads the left of
  `X-Forwarded-For`. Measured on 1.7.7, and read in `@better-auth/core/dist/utils/ip.mjs`: with no
  `trustedProxies`, it takes a header that holds **one** value as the caller wrote it, and refuses a
  header that holds several. Behind Traefik, which replaces the header, that is the true address.
  With no proxy, which is what `docker-compose.yml` runs, it is whatever the caller wrote. Behind a proxy that appends, every caller who sends the header has no address, and its limit then counts them all in one bucket (read in `api/rate-limiter/index.mjs`). `TRUSTED_PROXY_HOPS` says none of this to better-auth, and `trustedProxies`
  is a list of addresses and not a count. Two limits with two readings of the address are two
  answers to « who is this caller »: its limit is off. The address in a row of `session` comes from
  the same reading, so none is kept. test:`takes a lone X-Forwarded-For as the caller wrote it, and
refuses a chain, when it tracks addresses` keeps the reason measured. A slice that wants the address
  in the `session` table gives better-auth the one that `resolveClientIp` read, in one header that
  the worker writes over anything the caller sent, and names that header in `ipAddressHeaders`.
- **The variables better-auth reads by itself** (read in the source, and measured).
  `BETTER_AUTH_TRUSTED_ORIGINS` is added to the trusted origins: with it set to another origin, a
  request that has the cookie and comes from that origin is answered. `BETTER_AUTH_SECRETS` takes
  the place of the `secret` option. `BETTER_AUTH_TELEMETRY` turns the telemetry on over
  `telemetry.enabled: false`, when `BETTER_AUTH_TELEMETRY_ENDPOINT` names where to send it: 1.7.7
  has no address of its own to send to. `BETTER_AUTH_URL` and `BETTER_AUTH_SECRET` are read only
  when the option is absent, and the worker always writes both. The refusal is on the prefix, so a
  variable that a later version adds is refused too.
  test:`takes an origin and a secret from the environment over its options, when the worker lets one
in` keeps the first two measured.
- **`FRUITBACK_PUBLIC_URL` has no path when better-auth is on.** better-auth takes a path in its
  address as the path its routes are under, in place of `basePath` (read in `utils/url.mjs`). The
  worker refuses such an address at boot and gives better-auth the origin.
- **A request that has the cookie is refused from another origin, and with no `Origin`** (measured:
  `403` both times). `demo.fruitback.com` is the same site as the worker, so `SameSite` does not keep
  it out: the check of the origin does. This is true of the routes of better-auth. The routes of the
  worker under `/console/` read the cookie since FRU-147, and refuse the same two requests when they
  change something.
- **Some lines of better-auth do not go through the logger of the options.** The refusal of an
  origin is written twice: once by the logger the worker gives, as a `[fruitback]` line, and once by
  a logger of the library, with colours (measured). No such line held a secret or an address.
- **better-auth reads every schema of its database** (measured, in CI and on a local server).
  Kysely's `getTables`, which `getMigrations` and the schema check at boot both call, lists the
  tables of all the schemas, then reads each one. The tests of the accounts and the sessions give
  each case a schema in one database, and drop it at the end: a schema dropped between the two reads
  failed a case of better-auth with `schema "t_…" does not exist`, two runs out of three with four
  test files at once. So each case of better-auth on a real server has a database of its own
  (`ownDatabaseUrl` in `auth.fixture.ts`). In production the database of a worker is its own, and
  what this costs there is the time to read every schema of it.
- **Two tables are named after a session, and they are not the same thing.** `sessions` (FRU-142)
  holds the sessions of the extension: digests, a chain, a rotation. `session` (better-auth) will
  hold the sessions of the console, as digests too (FRU-181), and it is empty. A query, a backup
  check or a purge that names one must not mean the other.
- **better-auth 1.7.7 cannot keep a digest of a session token by itself** (read in the types, in the
  source of the package and in reference/options). Its `session` option has `expiresIn`,
  `updateAge`, `disableSessionRefresh`, `deferSessionRefresh`, `storeSessionInDatabase`,
  `preserveSessionInDatabase`, `cookieCache` and `freshAge`, and `findSession` asks the table for
  the row whose `token` is the value of the cookie. The cookie is that value, a dot, and its
  HMAC-SHA256 with the secret (read in `better-call`). So a row and the secret were a cookie:
  test:`opened a session with the token of the table and the secret, before the layer`.
- **Why a layer in front of the adapter, and the options it was weighed against** (FRU-181, the
  report is in the ticket). A hook `databaseHooks.session.create.before` that digests the token puts
  the digest in the cookie too: better-auth signs the token of the row it created.
  `secondaryStorage` keys the sessions by their token in the clear. `encryptOAuthTokens` takes its
  key from the secret. `verification.storeIdentifier: 'hashed'` digests the identifier, then looks
  the identifier up as it was given when the digest finds nothing (read in `db/internal-adapter.mjs`;
  measured: the digest of a copy, presented as the identifier, finds its row). It is kept as a first
  layer, and the layer digests that digest again, so that second lookup finds nothing. A plugin of
  Kysely that rewrites the SQL would tie this to Kysely. The adapter is the one interface every
  adapter of better-auth implements, Kysely today or Drizzle (FRU-180), and the schema does not
  change: the digest is in the same `text UNIQUE` column, and a lookup is a read of its index.
- **The layer wraps the adapter in place**, in the `init` of its plugin. better-auth keeps the check
  of the schema of an adapter in a `WeakMap` of that very object (read in
  `@better-auth/core/dist/db/schema-check.mjs`): another object would lose it, and `startAuth` would
  call an instance ready on a schema that is wrong. A transaction gives its calls an adapter of its
  own, and the layer wraps that one too.
- **Why a closed path also throws in the process.** `disabledPaths` closes a route to a request, not
  to `auth.api`. Called in the process, `revokeOtherSessions` read a list with no token, asked for
  each by none, and better-auth took the refusal of the layer for « no such session »: it answered
  `{ status: true }` and ended nothing (measured). A hook of the plugin throws before the endpoint
  runs: test:`throws on a call in the process to a route that names a session by its token, and ends
nothing`.
- **The tables have the names better-auth gives them**: `user`, `session`, `account`,
  `verification`, `organization`, `member`, `invitation`. They are made in every database of a
  worker, with better-auth on or off, because the database has one list of migrations. Names that
  plain are taken in a database that another application shares: the migration then fails, and
  every read of the accounts answers `502`. The database of a worker is its own. A schema of its
  own does the same, with `options=-c search_path=<schema>` in the address: that is how
  test:`builds better-auth at boot on a real server, and serves its routes` gives each run an empty
  database, and better-auth reads the search path (read: adapters/postgresql).
- **The organization plugin is in the configuration for its tables and its roles.** `getMigrations`
  reads the schema from the plugins, and `member` is a table of that plugin. None of its routes was
  served in this slice. What a guest reads through them, and two roles on one member, are FRU-149,
  below: the constraint on `member` closes only the second row for one person.
- **What was left to the slice that serves a route** (FRU-147 decided each one, below): how long a
  session lasts, which ways to sign in, how two providers that prove one address are linked, and
  whether the `session` table keeps an address.
- **The generated DDL has no unique constraint on `account ("providerId", "accountId")` either.**
  The `logins` table of the worker had that pair as its primary key. FRU-146 moved the rows there
  and added the constraint: see _The accounts in the tables of better-auth_.

### The bundle, and what it costs a worker that has better-auth off

Measured on 2026-10-11, on the commit this slice starts from (the head of FRU-142) and on this one,
two runs of seven boots each:

|                                      | Before        | After         |
| ------------------------------------ | ------------- | ------------- |
| `dist/server.mjs`, bytes             | 959,289       | 3,711,008     |
| the same, gzip                       | 178,187       | 622,017       |
| files in the bundle                  | 162           | 802           |
| packages in the bundle               | 15            | 32            |
| bytes the process evaluates at boot  | 763,922       | 779,458       |
| boot to « listening », median        | 99–108 ms     | 121–139 ms    |
| resident memory after `/health`, KiB | 75,952–76,080 | 87,584–87,728 |

- **The 17 new packages are 2,659,947 bytes**: `zod` 4.6.5 (827,181), `kysely` (602,844),
  `better-auth` (602,191), `@better-auth/core` (315,706), `jose` (92,785), and twelve small ones.
- **Nothing of them runs for a worker that has better-auth off.** The file is larger all the same:
  Node reads and parses it, which is the 13 to 31 ms and the 11.6 MiB of the last two rows (Node
  25.8.1, one machine, `FRUITBACK_STORE=sqlite`, no accounts).
- **`zod` is in the bundle twice.** The worker uses 4.3.6, which the catalog pins with a tilde, and
  better-auth asks for `^4.5.4`. Aligning the catalog takes the second copy out, 513,751 bytes. It is not done here:
  `packages/shared` and the widget bundle use the same entry of the catalog.
- **Not tried: `better-auth/minimal`**, which leaves Kysely out for a deployment that brings its own adapter (read: guides/optimizing-for-performance). The worker gives better-auth a pool, and that path needs Kysely.
- **The scan of the image sees none of the 32 packages.** [image.md](image.md) says what is open.

## The database in Drizzle (FRU-180)

The PostgreSQL database of a worker is described once, in Drizzle, and `drizzle-kit` writes its
migrations: the tables of the worker and the seven tables of better-auth, in one journal. **One tool
migrates the database, and the tool of before is gone**: `postgres-migrations.ts`, `migrate` of
`postgres.ts` and their tests. A database that it made is adopted, and nothing in it is run again.
**Nothing changes for what a worker answers**: the two conformance suites pass on SQLite, on PGlite
and on a server, with no change to a case.

**SQLite is not in Drizzle**: `sqlite.ts`, `accounts-sqlite.ts` (a test fixture since FRU-150) and
`session-sqlite.ts` stay as they are, with their own migrations. Mathieu decided on 2026-10-11 that a worker always has PostgreSQL;
the stores on SQLite and on files go with FRU-184, after the storage of the production moves to
PostgreSQL. Porting them to Drizzle first would be work on code that leaves.

### The rules, in short

- **`postgres-schema.ts` and `auth-schema.ts` are the source, and `drizzle/` is generated from
  them.** `drizzle.config.ts` names both. Change a table there, run
  `pnpm --filter @fruitback/worker db:generate`, and commit what it writes. Never write a migration
  by hand, and never edit one that has shipped: add one. **One case only adds statements to a
  generated file, before its first merge: rows that must move before a table goes.** `drizzle-kit`
  writes no copy of rows. `0002_accounts_in_better_auth` is that case, and its header says which
  statements are not generated.
- **A constraint has the name that PostgreSQL gives it**: `<table>_pkey`, `<table>_<column>_key`,
  `<table>_<column>_fkey`. So a constraint of one column is written in the third argument of
  `pgTable`, with its name, and never on its column, where Drizzle names it in its own way. A database
  that the tool of before made has these names, and a later migration that drops one must find it.
- **A property of the schema has the name of its column** (`created_at`). `account-rows.ts` and
  `session-rows.ts` parse a row of either database, so a row of PostgreSQL has the keys of a row of
  SQLite.
- **A pull request that is rebased after another one merged a migration generates its own again.**
  Remove its SQL file, its snapshot and its entry, then run `db:generate`. Do not merge the journal
  by hand: see the first defect below.
- **Drizzle is named by the files of the database only**: `postgres-schema.ts`, `auth-schema.ts`,
  `postgres-migrate.ts`, `accounts-postgres.ts`, `session-postgres.ts` and `screenshots-postgres.ts`,
  and `postgres.ts` as types. No file that every worker loads imports one of them: `app.ts` takes a store, and `auth.ts`
  takes `migrated`, from `postgres-stores.ts`, which loads them at their first call. A lint rule
  holds both, and test:`loads no file of Drizzle and no file of the driver for a worker without the
variable` holds the rest.
- **The worker applies the migrations at its first call to the database**, with `migrate` of
  `postgres-migrate.ts`. No command applies them, and `drizzle-kit migrate` is never run on a
  database of the worker: the image has no `npx` and no `drizzle-kit`.
- **`migrate` of Drizzle is never called alone.** `postgres-migrate.ts` holds a lock around it,
  adopts a database of the tool of before, and refuses first what Drizzle would skip or would not
  see. Read the three defects below before you change that file.
- **A database that the tool of before made is adopted, once, and nothing in it runs again.** Its
  `schema_migrations` must hold the four migrations of `HOME_MADE`, in order: the worker then writes
  the row of `0000_baseline` in the journal of Drizzle, as Drizzle writes it, and Drizzle applies
  what comes after. `schema_migrations` stays. A database left at an earlier migration of that tool,
  or whose list was edited, is refused before any write, with what to do. **The baseline is never
  edited**, as no migration is: the adoption writes its digest.
- **The adoption first compares the tables of the database with the ones that the baseline makes**
  (FRU-189): `BASELINE_CATALOGUE` of `postgres-baseline-catalogue.ts`, never edited. A column, a
  constraint or an index that is gone, changed or added by hand is refused before any write, and
  the message names the first line of each kind. The operator changes the database until it is what
  the image of before made, and starts the worker again. A table that the baseline does not make is
  left alone.
- **The role of `FRUITBACK_DATABASE_URL` owns its database, or has `CREATE` on it.** The tool of
  before needed `CREATE` on the schema `public` only. A role without it is refused at the first
  call, with what to grant: see the reasons.
- **The tables are in `public`, and a search path that puts another schema first is refused.** The
  tool of before made its tables wherever the search path said. The address, the role and the
  database give no search path, and no schema has the name of the role.
- **A store reads a `BIGINT` through the schema, never with a raw statement.** Through the schema it
  is a number. In the answer of a raw statement it is a string, and `account-rows.ts` reads a string
  as no instant: 1970, with no error. `postgres-numbers.test.ts` holds each of the twenty-one columns.
- **A transaction is the one of `postgres.ts`, never `db.transaction` of Drizzle on the pool.** A
  store takes `database.transaction`, which gives it Drizzle on one connection.
- **The words of an error of Drizzle reach no log.** They quote the statement and its values: an
  address, a digest. `causeOfQueryError` takes the error of the driver out, and `postgres.ts` reports
  only that one.
- **A store gives Drizzle no `undefined`, and no limit that is not a positive integer** (FRU-187).
  Drizzle writes no `NULL` for `undefined`: in `.set()` it leaves the column out, and the row keeps
  its value; in a fragment of `sql` it leaves the value out of the text. It also leaves out a
  `LIMIT` that is negative or `NaN`, and the statement answers every row. No caller passes such a
  value, and the types forbid it. `accounts-postgres.ts` refuses them with a `TypeError` that names
  the value: test:`refuses undefined in place of a value it writes, and changes no row`,
  test:`refuses a limit of due deliveries that is not a positive integer, where Drizzle drops the
LIMIT`.
- **A write that must say whether it changed a row returns that row** (`returning`), and the store
  counts what comes back. The two drivers do not count the rows of a statement in the same way.
- **The tables are in `public`, and so is the journal** (`__drizzle_migrations`). A test that needs
  an empty database on a server makes a database (`createRealDatabase`, `ownDatabase`), not a schema.
- **The database of a case is dropped when its connections have ended, not while they end**
  (FRU-196). `pool.end()` of pg-pool 3.14 answers when it has asked its clients to end, and the
  server still holds their backends for a moment (0.2 to 1 ms, measured on 17.11). The fixture sent
  `DROP DATABASE … WITH (FORCE)` at once: the server ended such a backend, and its client read
  « terminating connection due to administrator command ». A pool of `postgres.ts` writes one line
  for it; a pool of `pg` with no listener throws it, and `node:test` fails the test whose
  `afterEach` runs (`postgres-numbers.test.ts`, twice in CI on 2026-10-12). `drop` of `ownDatabase`
  now waits until `pg_stat_activity` lists no client on the database, two seconds at most, and
  `FORCE` stays for a process that a test killed. test:`ends no connection of a pool that has just
ended` holds it, and test:`ended one when it did not wait, which is what failed a test in CI` is its
  control.
- **`drizzle/` is not formatted.** `drizzle-kit` writes it again at the next `generate`, in its own
  form: the `format` scripts of the worker and the pre-commit hook leave the folder out.

### The reasons, and the measurements

Read on drizzle-orm 0.45.4 and drizzle-kit 0.31.11, the versions of the catalogue, on 2026-10-11.

- **The first defect: a migration dated before the last one applied is skipped, in silence.**
  `migrate` (`pg-core/dialect.js`) reads one row of its journal, the latest, and applies the entries
  whose date is after it. test:`is skipped in silence by Drizzle alone: no error, and no table` is
  that defect, measured. Continuous integration starts from an empty database, applies every entry,
  and sees nothing. Three things hold it here:
  - `postgres-journal.test.ts` refuses the folder before the merge: the dates only go up
    (test:`refuses a migration dated before the one before it: the one a rebase leaves behind`), and
    against the base of the pull request the migrations of the base are first and unchanged
    (test:`refuses a migration of the base that was edited`). The job `test` gives it `HEAD^1`, with
    a checkout of two commits: for a pull request that is the head of the base.
  - `postgres-migrate.ts` refuses the folder when the worker starts: it reads every row before
    Drizzle does (test:`is refused, and named`). The worker then answers `502` and says which
    migration, where it would have run with a column that is not there.
  - The 1.0 of Drizzle chooses the migrations by their name, and not by their date (read on
    `1.0.0-rc.4`, `migrator.utils.js`). It is not a stable version yet.
- **The second defect: no lock.** Two processes that start together on an empty database both read
  « nothing applied ». `migrate` of `postgres-migrate.ts` takes an advisory lock of the session on one
  connection, and Drizzle works on that connection (`alone` of `Database`): the journal is made
  inside the lock too. test:`applies each migration once` starts two Node processes, and the first
  migration sleeps so the second arrives inside it. test:`fails for one of the two when nothing holds
the lock` is its control: the same two processes, with the line of the lock removed.
- **The third defect: the digest is written and never read.** Drizzle keeps a SHA-256 of each SQL
  file, and a migration that was edited after it shipped is not run again on a database that has
  it. test:`refuses a folder in which a migration that shipped was edited` holds the check that
  compares them. The tool of before refused the same thing by the name of the migration.
- **A run of migrations is one transaction**, where the tool of before gave each migration its own.
  test:`leaves nothing of a run that fails, and keeps what the run before applied`. A database that
  holds more migrations than the build is left alone, as before: that is a roll back, and
  test:`leaves a database alone that holds more migrations than the build` holds it.
- **`migrate` of Drizzle needs `CREATE` on the database.** It sends `CREATE SCHEMA IF NOT EXISTS
"public"` before anything else, on every call, and PostgreSQL checks the privilege on the database
  before it looks for the schema. Measured on 17.11 with a role that can make a table in `public`:
  « permission denied for database ». `postgres-migrate.ts` asks `has_database_privilege` first and
  refuses with what to grant, where the worker would say that the database did not answer.
  test:`is refused before any write, with what to grant, and with no name of the role`, and its
  control test:`can make a table in public, and is refused by PostgreSQL when Drizzle alone migrates`.
  The role that owns its database has the privilege, and so has the role that a `postgres` image
  makes from `POSTGRES_USER`, which is what the job `docker image` boots.
- **Two migrations of one date are refused when the worker starts**, before anything is applied:
  test:`refuses a folder in which two migrations have one date, before it applies anything`. The
  journal guard refuses the same folder before a merge.
- **`drizzle-kit` ends with 0 when it fails.** Measured: `--out` with an absolute path is a folder it
  does not find, it prints the error, and ends well. The first form of the drift test passed for
  that reason, and its control is what showed it. So
  test:`are the same: drizzle-kit generate writes nothing` also reads that the tool said it compared,
  and test:`are told apart when a column of the schema has no migration` is the control. It runs
  `drizzle-kit` with the schema files of `drizzle.config.ts`, so the tables of better-auth are held
  too: test:`are told apart when a column of a table of better-auth has no migration`.
- **The transaction of Drizzle gives a broken connection back to the pool.** Read in
  `node-postgres/session.js`: when the `ROLLBACK` fails, its error replaces the first one, and the
  connection is released as a good one. `postgres.ts` keeps its own `BEGIN`, `COMMIT` and `ROLLBACK`,
  and closes a connection that could not roll back.
- **Drizzle gives its own parsers of types to each statement**, so a parser on the pool is not read.
  That is why the `BIGINT` is a number by the schema.
  test:`answers a BIGINT of the schema as a number, on the driver that ships`.
- **What the parser that is gone changes, measured on a server** (raised in review). For each of the
  `BIGINT` columns (twenty then, sixteen since FRU-146, twenty since FRU-103, twenty-one since FRU-44), a pool built as `postgres.ts` built it before answers a number for a raw
  statement, the pool that ships answers a string for the same statement, and the schema answers
  the number: test:`answered a number for a raw statement, and now answers a string for it and a
number through the schema`. No store sends a raw statement
  (test:`sends no raw statement from a store: a column is read through the schema, where it is a
number`), and test:`reads an instant that is a string as no instant, and says 1970 with no error`
  is why that matters. Every column is read at 2^31, past 2^32 and at the last exact integer, and as
  `NULL`: test:`is the number that was written, in every column, at 2^31, past 2^32 and at the last
exact integer`, test:`is null when the column holds no instant, and never 0`. The two stores are
  read at the same values: test:`reaches the console as the instant that was given, through the
store of the accounts`, test:`decides a pairing and a session by their instants, on each side of
2^32`.
- **better-auth reads no `BIGINT` of its tables on that pool, and a count is one.** Its seven tables
  have none (test:`knows the twenty-one BIGINT columns of the worker, and that better-auth has none`).
  `count(*)` is a `BIGINT` whatever the table: the pool now answers it as a string, and better-auth
  reads it as a number, through its adapter and the layer of FRU-181
  (test:`gives better-auth a count as a string, which better-auth reads as a number`).
- **A search path that is not `public` breaks the migrations of `drizzle-kit`, in two ways**
  (raised in review, measured on 17.11). On an empty database the tables go in the first schema of
  the path, and the first foreign key fails: relation `public.…` does not exist
  (test:`fails in the middle of the baseline when Drizzle alone meets it, on a relation of public`).
  On a database that the tool of before made in that schema, there is no `public.schema_migrations`
  to adopt, and the first `CREATE TABLE` fails. `postgres-migrate.ts` reads `current_schema()` first
  and refuses with what to change: test:`is refused before any write, with what to change`,
  test:`is refused too on a database that the tool of before made in that schema, which Drizzle
alone breaks on`. Such a database moves its tables to `public` by hand
  (`ALTER TABLE … SET SCHEMA public`, `schema_migrations` too), and is then adopted.
- **The baseline makes the database that the tool of before made, to the last name.** One database
  made by the four migrations of that tool, as they shipped (`postgres-home-made.fixture.ts`, a copy
  compared word for word with `main` at e74be53), one made by the baseline: their catalogues are the
  same, line for line. That is 204 lines on PostgreSQL 17.11: each column with its place, type,
  default and « not null », each constraint with its name and its definition, each index.
  test:`makes the database that the tool of before made, to the last name` holds it on PGlite and on
  a server. Before the names were written in the schema, only the names of the constraints differed
  (`logins_provider_subject_pk` for `logins_pkey`, `accounts_email_unique` for `accounts_email_key`).
- **A database of before that was changed by hand is not adopted** (FRU-189). The adoption runs
  nothing: it writes that the baseline is applied, which is true only of the database that the
  baseline makes. Before, a database without `sites_workspace_id_origin_key` was adopted, and the
  stores count on that constraint. Now `postgres-migrate.ts` reads the catalogue of `public` (the
  lines of the comparison above) and compares it with `BASELINE_CATALOGUE`, which
  test:`is the catalogue that the baseline makes` holds to the baseline on PGlite and on a server.
  `postgres-adopt.test.ts` then changes a database of before by hand, one case for each line of
  its `CHANGES`: a column, an index or a constraint that is gone, a foreign key that deletes nothing
  any more, a type, a « not null », a column that was added, a table that is gone. Each is refused
  with its line named, and leaves no journal of Drizzle, the same catalogue and the same rows
  after the refusal. test:`is adopted once the database is again what the image of before made`.
  **The lines do not depend on the version of the server, and that was measured**: the baseline
  gives the same 204 lines on PostgreSQL 16.14, 17.11, 18.3 and PGlite, once the rows of
  `pg_constraint` for « not null » are left out. PostgreSQL 18 writes one for each such column (85
  for the baseline), and 17 writes none: with them a database on 18 was never adopted. A table
  that the baseline does not make is another application's: test:`leaves alone a table that the
baseline does not make: it is adopted with it`.
- **Why the baseline is marked and not run on a database of before.** Drizzle alone runs it, and
  fails on the first `CREATE TABLE`: test:`fails on its first CREATE TABLE when Drizzle alone meets
it, and writes no row of its journal` is the control of the adoption. Rows cannot be replayed into
  new tables without a copy, and a copy is a second way to lose them. The two catalogues are the same,
  so the database has what the baseline makes: the row of the journal is the one thing missing.
  test:`is adopted: nothing is run again, every row stays, and the stores read them` plants rows in
  the eighteen tables, compares a digest of each table before and after, and reads them through the
  two stores: a sign-in finds its account, a site its destination, a refresh token rotates.
- **An empty journal of Drizzle does not stop the adoption.** Drizzle makes its journal before its
  transaction, so a `drizzle-kit migrate` that somebody ran by hand on a database of before failed on
  the first `CREATE TABLE` and left the journal, empty. An empty journal says that Drizzle applied
  nothing: test:`is adopted all the same after Drizzle alone met it, and left its journal empty`.
- **Why `schema_migrations` stays.** An image of before reads it, and finds its four migrations
  applied: a roll back by digest still finds its database. Measured once on this machine with the
  worker of `main` e74be53 itself, not with the copy: it made the database (`pair`), the bundle of
  this branch adopted it (`pair`, one row in the journal, the catalogue unchanged), and the worker of
  e74be53 ran `pair` on it again.
- **Why a database left at migration 2 or 3 of the tool of before is refused, and not adopted.**
  On `main`, migration 2 was the last one for 40 minutes (FRU-141 to FRU-142, 2026-10-11) and
  migration 3 for 7 (FRU-142 to FRU-144), and the repository knows no database of the production
  (FRU-183 asks Mathieu to confirm it). Adopting them would keep the SQL of the tool of before in the
  worker. The message says what to do: start an image from FRU-144 to
  before Drizzle on it once, then this one. test:`refuses a database that the tool of before left at
an earlier migration, and writes nothing`.
- **The migrations of `drizzle-kit` name `public` in every foreign key.** A case of a test cannot
  have a schema of its own, as it had. On a server it has a database. PGlite has one database: a
  case empties `public`, so a process holds one PGlite database at a time.
- **The migrations are files beside the bundle.** `migrationsFolder` finds `drizzle/` beside
  `server.mjs` in the image, and beside `src/` and `dist/` in the repository. The Dockerfile copies
  the folder, and the job `docker image` counts the rows of the journal against it.
- **The bundle went from 3,724,344 to 4,041,092 bytes** (+316,748, +8.5 %; gzip 619,850 to 669,989)
  with drizzle-orm 0.45.4, which has no dependency of its own. Measured with
  `pnpm --filter @fruitback/worker build` on `main` dcc96f2 and on this branch. On the base of before
  better-auth it was 959,289 to 1,262,730. `drizzle-kit` is a development dependency, and is not in
  the bundle.
- **A statement is no longer SQL that can be read as it is sent.** That is the cost of this section,
  and the ticket says who chose it. The locks of the two stores are `for('update')` and
  `for('key share')`. The page of Drizzle on `select` does not document them: they are read in its
  types, and the planted races hold them, which pass on PGlite and fail on a server.
- **Not measured: Node 26 on a developer machine.** The measurements of this section ran on Node 25.8
  and on the runners of CI, which have the version of `.nvmrc`.

## The copy of the SQLite files into PostgreSQL (FRU-145)

`node server.mjs migrate-to-postgres --accounts <file> --sessions <file> [--dry-run]` copies the
accounts and the sessions of a worker on SQLite into the database of `FRUITBACK_DATABASE_URL`. It is
the tool of the first switch of the Cloud, and of any self-hoster who moves. The steps of the switch
are in `apps/worker/cloud/README.md`.

### The rules, in short

- **A command, and not a route**, for the reason `pair` gives: whoever can run it already holds the
  secrets. It is in `cli.ts`, and `postgres-copy.ts` does the copy. That file imports Drizzle, so
  `cli.ts` reaches it through `postgres-stores.ts`, at the call.
- **The two files are never opened.** Each one is copied with its `-wal` into a folder of the
  system, and the copy is read. The files are the way back of the switch.
- **The target is made by the migrations of Drizzle up to `COPY_SCHEMA`, and no further** (FRU-146).
  That migration, `0001_connector_settings`, is the last one whose tables are the ones of the two
  files. The copy writes rows only, and the worker applies the later migrations when it starts, as
  on any database: they move the people and the workspaces into the tables of better-auth. So one
  statement moves a row, whether the copy or a worker of before wrote it, and the copy runs from any
  image, before or after FRU-146.
- **The columns of each table are compared on both sides first**, and a file of another version is
  refused: a column on one side only would be lost in silence. `accounts`, `logins`, `workspaces`
  and `members` are written in `postgres-copy.ts`, as `COPY_SCHEMA` has them. **A later migration
  that changes another table of the copy fails `postgres-copy.test.ts`: write that table in
  `postgres-copy.ts` as it was.**
- **One transaction, with an advisory lock in it** (`pg_advisory_xact_lock`, a number that the
  migrations do not use). An interruption leaves nothing.
- **A database with a row in any of the eleven tables is refused**, unless it holds exactly the rows
  of the files: then the command writes nothing and ends with 0. That is a run that went to its end.
  A row in `user`, `account`, `organization` or `member` is refused too: those tables are empty
  until the worker starts. **Once a worker started on the database, the copy is refused**: the
  tables of the files are gone. test:`refuses a database on which a worker started since the copy,
and says why`.
- **The end is a count and a digest of the rows of each table, file against database**, read again
  inside the transaction through the schema. A difference rolls back and ends with 1. `--dry-run`
  does everything and rolls back.
- **The sign-in links are not copied.** They live 15 minutes, and the worker is stopped for longer.
- **No message holds the address of the database**, as everywhere in `postgres.ts`.

### The reasons, and the measurements

- **Why a copy of the files.** SQLite writes a `-shm` beside a file in WAL mode as soon as a reader
  opens it, and a checkpoint moves the journal into the file: a reader changes the digest of what
  it reads. With the files opened in place of their copies,
  test:`writes nothing beside the two files, and leaves them as they were` fails (control planted,
  2026-10-11). The rows of a worker that was just stopped can be in the journal only: the same test
  reads the file without its `-wal` and finds no table, and with the line that copies the `-wal`
  removed, test:`copies every row: a session opened before refreshes after, and a sealed connector
opens` fails. So the copy reads a folder that it cannot write:
  test:`reads the two files in a folder that it cannot write`.
- **What « the same » means after the copy.** The digests of the tokens and the sealed keys are
  copied as they are, so the test reads them as a worker would: the refresh token of a session of
  the file is accepted by the session store of PostgreSQL, and the key of a connector opens with
  `FRUITBACK_SECRETS_KEY`.
- **A row is compared by its values, in the order of the columns of the schema**, as JSON. An
  instant is a number on both sides: the schema answers a `BIGINT` as a number, which is why the
  target is read through it and not with a raw statement. The rows are sorted as text in the
  process: SQLite and PostgreSQL do not sort text in the same way.
- **The interruption is planted, and so is the lost row.** A trigger stops the insert of the last
  table: test:`leaves nothing when it stops in the middle, and gives the same result when it runs
again`. Another one removes a pairing as soon as it is written:
  test:`fails its final count when a row goes missing in the target, and keeps nothing`.
- **Idempotence is « the same rows », not « a mark that the copy ran ».** A mark would say nothing
  of what a worker wrote after it: test:`writes nothing again when it runs a second time`,
  test:`refuses a database that holds other rows, and writes nothing`. A row in a table that
  is not copied counts too (raised in review): a sign-in link made since the copy is a row that
  the files do not have, test:`refuses a database that holds these rows and a sign-in link made
since`.
- **The command runs as a process against a server** in
  test:`copies, ends with 0, and never prints the address of the database`: a dry run, the copy, a
  second run, and a file that does not exist, which `node:sqlite` would otherwise make.

## The accounts in the tables of better-auth (FRU-146)

A person, a way to sign in, a workspace and a membership are rows of `user`, `account`,
`organization` and `member`: the tables of better-auth. **Nothing changes for a caller.** The sign-in
code of before is still the one that runs, `AccountStore` is the same interface, and better-auth
served no route then (FRU-147 serves it). The rows are where better-auth reads them, so the slice that signs a
person in with it (FRU-147) has no data to move.

**Nothing changes on SQLite**: `accounts-sqlite.ts` keeps its four tables. FRU-150 made it a test
fixture, `accounts-sqlite.fixture.ts`.

### The rules, in short

- **`accounts-postgres.ts` reads and writes the four tables itself**, with Drizzle, for `signIn`,
  `account`, `setLocale`, `localeOf`, `createWorkspace`, `memberships`, `role` and
  `deleteWorkspace`. better-auth does not run for these calls, so its layer (`auth-at-rest.ts`) is
  not between this store and the table. **No statement of the store gives a value to a token column
  of `account`, to its scope or to its password**: test:`writes each row as better-auth expects it,
and no token of a provider`, test:`writes a new sign-in and a new workspace as it writes a moved one`.
- **The ids do not change.** `acc_…` is the id of a `user` and `ws_…` the id of an `organization`.
  They are in the access tokens, in `reporter.id` of the notes already written, and in the sessions
  of the extensions. A row of `account` and of `member` gets an id it did not have: `lgn_` and
  `mem_`, then 20 hexadecimal characters, as `authId` gives.
- **What each column holds, for a row of before and for a new one:**

  | Column                                    | Value                                                                                      |
  | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
  | `user.name`                               | the name, or the empty text when the person has none                                       |
  | `user."emailVerified"`                    | `true`: every way to sign in that reaches the store proves the address                     |
  | `user.locale`                             | the language the person chose, or `NULL`                                                   |
  | `user.image`                              | `NULL`                                                                                     |
  | `account."providerId"`                    | `email`, `github` or `google`: the `provider` of before                                    |
  | `account."accountId"`                     | the `subject` of before: the address for `email`, the id the provider gives for the others |
  | `organization.slug`                       | the id of the workspace                                                                    |
  | `member.role`                             | one of the four roles, in one word                                                         |
  | an instant (`"createdAt"`, `"updatedAt"`) | a `timestamptz`, to the millisecond of the `BIGINT` of before                              |

- **`user.name` takes no `NULL`, so « no name » is the empty text.** `accountOf` reads it as no
  name, and a sign-in that brings a name fills it. A row of before that held `NULL` or the empty
  text is the same row now.
- **`organization.slug` is the id of the workspace.** better-auth requires a slug, unique. A
  workspace has no slug that somebody reads, so it gets the one value that is already unique and
  never changes. A slug that a person chooses is a feature, with its own rules.
- **`locale` is an additional field of `user`**, in `authOptions` and in `auth-schema.ts`, with
  `input: false`: a sign-up of better-auth cannot give it.
- **`roleOf` stays strict.** `member.role` is text, and better-auth reads `guest,admin` as two
  roles. For the worker a value that is not one of the four words is no role: the person reads
  nothing. test:`reads a role that is not one of the four as no role, « guest,admin » too`.
- **One identity at a provider is one row**: `UNIQUE ("providerId", "accountId")` on `account`,
  which the DDL of better-auth does not have. It is what the primary key of `logins` said, and the
  insert of a sign-in names it as its conflict. test:`refuses a second row for one identity at a
provider`.
- **A site and a connector are of an `organization`**, with `ON DELETE CASCADE`. Removing a
  workspace is one `DELETE` of its `organization`: its members, its invitations, its sites and
  their destinations, its connectors and their deliveries go with it.
  test:`removes the sites, the connectors and the deliveries of a workspace with it, and of no other`.
- **The copy of the SQLite files still writes the tables of before**, and the worker moves the rows
  when it starts: see _The copy of the SQLite files into PostgreSQL_.

### The migration, and what it refuses

`0002_accounts_in_better_auth` adds `user.locale` and the constraint on `account`, copies the four
tables, points the two foreign keys at `organization`, and drops the four tables. **It is one
transaction with the other migrations of the run** (FRU-180): a failure leaves the database as it
was, and the worker answers `502` until somebody acts.

- **It is the one generated migration with statements added by hand**: the four `INSERT … SELECT`.
  `drizzle-kit` writes no copy of rows. It also wrote the `DROP TABLE … CASCADE` first, then dropped
  by name the two foreign keys that the `CASCADE` had just taken: as generated, the file fails. So
  the statements are in another order, and the tables go last, with no `CASCADE`. A view or a key
  that somebody added on one of them stops the migration, where `CASCADE` would remove it in
  silence.
- **It joins no row that it did not make.** Nothing wrote the four tables of better-auth before it:
  no route serves better-auth. A person who is already in `user`, with the address or the id of an
  account, is a row that nobody can explain, and the unique constraints refuse the copy: nothing
  moves and nothing is dropped. test:`moves nothing and drops nothing when a person is already in
the table of better-auth`.
- **An instant keeps its millisecond**: `'epoch' + created_at * interval '1 millisecond'`, which is
  exact, where `to_timestamp(created_at / 1000.0)` goes through a float. The memberships of a
  person are read in the order they were made, as before:
  test:`finds each membership and each role again, in the order they were made`.
- **`gen_random_uuid()` gives the ids of the moved rows**, cut as `newId` cuts one. It is in
  PostgreSQL since version 13, with no extension.
- **The image of before does not read this database any more.** It finds more migrations than it
  has, leaves them alone (FRU-180), and then reads `accounts`, which is gone: every read answers
  `502`. The way back is a dump taken before the deployment, restored with the image of before:
  `apps/worker/cloud/README.md` has the steps.

### What the tests hold

`accounts-move.test.ts` starts from a database of the image of before, with rows as its stores
wrote them, and applies the migrations as a worker does when it starts, on PGlite and on a server.

- Each person is found under the same id, by each way they signed in with:
  test:`finds each person again, under the same id, by each way they signed in with`.
- A session of the extension that was opened before reads its sites after, and refreshes:
  test:`lets a session of the extension that was opened before read its sites, and refresh`. Its
  control removes the membership: test:`refuses that session the moment its person is no member any
more`.
- better-auth has nothing to create on the database that was moved:
  test:`leaves better-auth nothing to create and nothing to add on the database it moved`.
- The two conformance suites pass on the store with no change to a case.

**Not measured:** a database of real size. The migration holds the four tables for the time of four
`INSERT … SELECT` and of two foreign keys that PostgreSQL validates, in a transaction that the first
call of the worker waits for.

## The console signs in with better-auth (FRU-147)

The worker serves the sign-in of better-auth under `/console/auth/`. It came **beside the path of
before**, which did not change; the console moved in FRU-148, and FRU-150 removed the path of
before: see _The sign-in of before and the accounts file go_ below. What this section says of « the
path of before » is how the two lived together until then.

### The rules, in short

- **`auth-routes.ts` serves `/console/auth/*`, under the limit of the worker**, with the headers of
  `consoleCors` added to the answer: better-auth sets none. **Only the paths of `SERVED_PATHS`** in
  `auth.ts` reach better-auth; any other one answers `404` before it reads the request. A route that a
  plugin adds is closed until somebody names it there with its reason. The routes of the organization
  plugin have their own list and their own file: see _The organization plugin_ below (FRU-149).
- **A reading of the cookie that renews the session renews the cookie** (FRU-208). `sessionOfCookie`
  asks `getSession` with `returnHeaders`, keeps the `Set-Cookie` of the session beside the request,
  and `handleRequest` adds it to the answer that leaves (`withRenewedCookie`). Measured on 1.7.7: a
  session last renewed two days ago moves its end in the row at the next `GET /console/me`, and the
  answer had no `Set-Cookie`; the same reading with `returnHeaders` hands back the cookie of the
  sign-in, token and attributes, with `Max-Age=604800`. A new route that reads the cookie through
  `sessionOfCookie` gets this with nothing to write.
- **A rejection of better-auth is a `502`**, with its reason in the log and no address of the
  database: `auth.handler` rejects on a schema that is wrong.
- **The link of the e-mail is the worker's own two routes.** `POST /console/auth/email` calls
  `signInMagicLink` in the process; its `sendMagicLink` hands the token to the route, which writes
  `<console>/sign-in#<token>` and sends it by `mail.ts`, in the language of the person.
  `POST /console/auth/email/redeem` takes the token in its body, calls `magicLinkVerify` in the
  process, and **hands the browser the `Set-Cookie` and nothing else of its answer**, which holds the
  token of the session. `/sign-in/magic-link` and `/magic-link/verify` are in `disabledPaths`: closed
  to a request, open to `auth.api` (measured). The limit of 3 links per address per 15 minutes
  (`EMAIL_LINKS_PER_WINDOW`, in `auth-routes.ts` since FRU-150) had the key of the path of before,
  so the two paths together sent 3.
- **`sendMagicLink` takes no mailer.** better-auth calls it in the middle of `signInMagicLink`, so the
  route leaves its delivery in a map under a ticket, and names the ticket in the `metadata` of the
  call (`sendLinkThrough`). A call with no ticket sends nothing, and throws.
- **The routes under `/console/` take the cookie**, and since FRU-150 no token.
  **With the cookie, a call that is not a read needs the `Origin` of the console**, and a
  request with none is refused (`callerOf` in `console-api.ts`, `mutationAllowed` in
  `auth-routes.ts`). `consoleCors` lets a request with no `Origin` through: it is not the check.
- **A session is ended by its id, with a route of the worker**: `DELETE /console/sessions/<id>`, of
  the person of the cookie only. `GET /console/sessions` lists them, with no token. The routes of
  better-auth that name a session by its token are closed (FRU-181).
- **An address that a provider did not verify creates no account.** A `databaseHooks.user.create`
  refuses a person whose `emailVerified` is not `true`. A link of the e-mail proves its address;
  better-auth already links no unverified address to an account. Nothing is in `trustedProviders`.
- **GitHub takes an OAuth App of its own**, `FRUITBACK_AUTH_GITHUB_OAUTH`: an App has one callback,
  and the App of before had another. Google takes the client of before with the callback of
  better-auth. **No picture is kept** (`mapProfileToUser`), as
  the accounts of before kept none.
- **A session lasts 7 days, and each day it is used moves its end by 7 days** (`SESSION_TTL_SECONDS`,
  `SESSION_RENEWAL_SECONDS`): the defaults of 1.7.7, written. No cookie cache: a session that is
  ended is refused at the next call. `SECURITY.md` gives the numbers, and `security.test.ts` holds
  them.
- **`FRUITBACK_AUTH_TRACK_IP=1` keeps the address and the user agent of a session, and turns the
  limit of better-auth on** (decision of 2026-10-11). Off, which is the default, a
  `databaseHooks.session.create` empties both columns. On, the worker writes the address that
  `resolveClientIp` read in `x-fruitback-client-ip`, over anything the caller sent, and that header
  is the only one better-auth reads (`ipAddressHeaders`).
- **A sign-in that fails goes back to `<console>/setup?error=<code of better-auth>`**
  (`onAPIError.errorURL`). The console gives each code its sentence (FRU-148).
- **A sign-in with a provider starts by a navigation**: `GET /console/auth/start/<github|google>`
  (FRU-148) calls `signInSocial` in the process and answers `302` to the provider, with the cookie of
  the state. `/sign-in/social` stays served, and sets that cookie on the answer of a `fetch`, which
  WebKit did not send back between two sites. A provider this worker does not have goes back to the
  console with `oauth_provider_not_found`.
  A navigation marked `Sec-Fetch-Site: cross-site` goes back to the console with
  `started_from_another_site` and makes no state (FRU-211): the call in the process skips the check
  better-auth makes on `/sign-in/social`. `same-site`, `same-origin`, `none` (an address typed by
  hand) and no header at all start the sign-in. A link to this route from a page of another site,
  in a document or a mail read in a webmail, therefore lands on the sign-in screen.
- **`GET /auth/providers` says `betterAuth: { email, github, google }`** when better-auth is on, and
  nothing more when it is off: a console of before reads the answer it always read.

### The reasons, and the measurements

Read on better-auth 1.7.7, in `plugins/magic-link/index.mjs`, `@better-auth/core` `social-providers`,
`cookies/index.mjs`; measured in `auth-routes.test.ts`, on PGlite and on PostgreSQL 17.

- **better-auth creates an account for an address that GitHub did not verify, and opens its session**
  (measured on 1.7.7, `emailVerified` false in the row). It links no such address to an account that
  exists (`account_not_linked`). test:`makes an account for an address that GitHub did not verify,
without the hook of the worker` is the control of the hook.
- **GitHub: better-auth takes the address of the profile**, or the primary one when the profile shows
  none, and reads its `verified` in `/user/emails`. The path of before took the primary verified
  address. The two differ for a person whose public address is another verified one: they then
  reach the account of that address.
- **Google: better-auth reads the identity in the id token** that the token endpoint answers, and
  checks no signature. The path of before asked Google's user info. The token comes from Google over
  TLS in the answer to the worker's own request, so nobody else wrote it.
- **The digest of a link, three times.** `storeToken: 'hashed'` keeps `magic-link:<base64url of the
SHA-256 of the token>`, `verification.storeIdentifier: 'hashed'` digests that, and the layer of
  FRU-181 digests it again. None of the three, nor the token, is in a row:
  test:`keeps the link as a digest of a digest, which opens nothing when a copy presents it`. The
  value of the row is `{"type":"magic-link","email":…}`: no secret.
- **A link spent twice**: `consumeVerificationValue` deletes the row in one statement, so of two calls
  at the same moment one finds it. The other gets a redirect to `INVALID_TOKEN`, which the route
  answers as `401`.
- **better-auth signs up a new address by a link**, with an empty name and a verified address, as the
  path of before did. The language of the browser that opened the link is kept when the account has
  none.
- **The state of a sign-in with a provider** is a cookie `__Secure-fruitback.oauth_state`, encrypted,
  `HttpOnly`, `SameSite=Lax`, ten minutes; its path was `/` and is `/console/auth` now (measured).
- **A test that needs a session with a password** says, in `withTestSignUp`, that its address is
  proven: the hook refuses a sign-up with a password otherwise, and that sign-up is off in the worker.

**Not measured here:** Safari; and the two OAuth applications for real, which need Mathieu. The
measures in a browser are in the pull request of FRU-147.

## The organization plugin: one role for a member, and what a guest does not read (FRU-149)

Four routes of the organization plugin of better-auth are served, each under a rule. It is what the
screen of the members and the invitations are built on (FRU-104). `SECURITY.md`, « What the console
may change, and who », says what is protected; this section says how to change it.

### The rules, in short

- **A route of the plugin is open when `ORGANIZATION_PATHS` of `organization-paths.ts` has a rule for
  it, and for no other reason.** A rule is a method, the action of `RIGHTS` the caller needs (or
  none: any member), and the fields the call may hold, each with what reads it. To open a route,
  write its rule, its line in `SECURITY.md`, and its line in the matrix of
  test:`answers each role, on each open route of the plugin, what its rule says`, which fails on an
  open route that it does not ask.
- **`auth-organization.ts` reads a call before better-auth does**: the path and the method, the
  cookie, the `Origin` of a change, the fields, the one role of the caller in the workspace the call
  names, then `can`. It then writes the request that better-auth reads, with those fields and no
  other. Never forward the request of the caller: `organizationSlug` names another workspace than
  the one whose role was read, and `filterField` reads any column of `member`. The body is read
  under the cap of the worker (`bounded-body.ts`, `413` over it). The other routes of the console
  still read theirs with `request.text()`: that is older than this slice, and not changed by it.
- **Every open route names its workspace in `organizationId`.** No call of the worker reads the
  « active » workspace of a session, and nothing writes one: `createWorkspaceWithPlugin` passes
  `keepCurrentActiveOrganization`. Do not open `set-active`.
- **A path with no rule is closed twice**: `404` from the worker, and `disabledPaths` in the options
  of better-auth, which `authOptions` computes from the endpoints of the plugin as it is installed.
  A later version that adds a route adds it to that list with no change here.
- **A role is written in three places, and each refuses what is not one role of the four**: the
  reader of the field `role` in the rule, the hooks `beforeAddMember`, `beforeUpdateMemberRole` and
  `beforeCreateInvitation` of the plugin (`ROLE_REFUSED`), and `roleOf` of `account-rows.ts`, which
  reads `guest,admin` as no role. The store writes `owner` and nothing else. A new way to write a
  member goes through one of the three hooks, or gets its own.
- **Whoever stops being a member keeps no extension for the workspace**, by two locks.
  `SessionStore.endSessionsOf` ends their chains and spends their codes at once: the hook
  `afterRemoveMember` calls it, `auth-organization.ts` calls it after `leave` (which runs no hook in
  1.7.7), `DELETE /console/workspaces/<id>` calls it for the workspace, and the hook
  `user.delete.after` for an account. Then `/session/refresh` and `/session/pair` read the
  membership (`stillOfTheWorkspace` in `app.ts`), for a removal that called nothing. A new way to
  remove a member calls `endSessionsOf`; the second lock is not a reason to skip it, because it acts
  ten minutes later.
- **A workspace is made and deleted by the routes of the worker**, `POST /console/workspaces` and
  `DELETE /console/workspaces/<id>`. The first calls the plugin in the process, for somebody
  of the cookie. The second does not use
  the plugin, whose deletion is off (`disableOrganizationDeletion`): it revokes the tokens of Linear
  first, and the foreign keys take the rest.
- **`endSessionsOf` holds every chain of the person before it ends them** (`session-postgres.ts`).
  Without the hold, a refresh in flight leaves a live successor:
  test:`fails on a real server with no hold on the chains of the person`.

### The reasons, and the measurements

Read on better-auth 1.7.7, in `plugins/organization/routes/crud-members.mjs`, `crud-org.mjs` and
`adapter.mjs`; measured in `auth-organization.test.ts`, on PGlite and on PostgreSQL 17.

- **What the plugin registers**: 22 routes with a path, and `addMember` with none (a call in the
  process only). With teams and « dynamic access control » off, it registers no route of a team or
  of a role. 4 had a rule in FRU-149, 10 since FRU-104, and 12 are closed. `organization-paths.ts` says why for each family.
- **`list-members`, `get-full-organization` and `list-invitations` answer `200` to a guest** on
  better-auth alone: the plugin checks that the caller is a member, and no permission. The control
  of test:`does not let a guest read the members or the invitations, on the API` builds an instance
  with nothing closed and asks it.
- **The decision on the members**: a guest does not read them. A guest is a reviewer from outside,
  and the list is the names and the addresses of everybody, the other guests among them. A member
  reads them: it is their team. The action is `read-members` in `RIGHTS`, so changing the decision
  is one line there.
- **What the plugin holds for the last owner** (and the test holds it against a later version): an
  owner who is alone cannot leave, remove themselves or take another role; somebody who is not an
  owner cannot remove an owner, change the role of one, or give that role. The answers are `400` and
  `403` with the codes of the plugin, which the route hands over.
  test:`keeps the last owner: they cannot leave, be removed, or be demoted, by themselves or by an admin`.
- **An admin may remove another admin, and change their role.** The plugin has one permission for
  members, and `RIGHTS` has one action. Nothing here ranks two admins.
- **`leave` runs no hook**, and `remove-member` runs `afterRemoveMember`. So the end of the sessions
  is in two places, each with its test: taking either one away fails
  test:`stops the extension of a member who is removed: no refresh, no site, no code, and the others go on`
  or test:`stops the extension of a member who leaves: no refresh, no site, no code, and the others go on`.
- **The hook runs after the member is removed.** If the store of the sessions fails then, the call
  answers `502` and the member is gone: the second lock ends their session at its next refresh.
  Before the removal, a refresh between the two would leave a live chain for ten minutes more than
  after it.
- **A session whose row names an « active » workspace**: the plugin takes it out when the person
  leaves, and finds the session by its token, through the layer that keeps a digest.
  test:`lets somebody leave whose session names the workspace as its « active » one`.
- **`create` through the plugin wants a slug.** The store writes the id of the workspace there. The
  plugin makes the id itself, so the route gives a random `slug_…` that nothing reads.
- **`beforeCreateOrganization` is not used**: when it answers data, 1.7.7 merges it over the whole
  body of the call, `keepCurrentActiveOrganization` and `userId` included (read in `crud-org.mjs`,
  not measured). The route gives the plugin what it validated, and needs no hook.
- **An invitation with a role that is not one of the four is refused by the plugin itself**
  (`ROLE_NOT_FOUND`), and one with two roles by the hook: test:`keeps an invitation to one role
too, for the day its route opens`. The route that accepts an invitation runs no `beforeAddMember`
  (read): FRU-104 adds `beforeAcceptInvitation`, which refuses the same.
- **`endSessionsOf` on PostgreSQL, measured on two connections.** A refresh holds the head of its
  chain, writes its successor, and commits. One `UPDATE` that started meanwhile waits for the head,
  then ends the rows it could see when it started: not the successor. With every row of the person
  held first (`FOR UPDATE`, in the order of the tokens, as a rotation holds its two), the refresh
  ends before the hold answers, and the statement that follows reads the successor. A trigger holds
  the successor inside the transaction of the refresh to make the overlap, as for the other races
  of the sessions.
- **No index names a person in `sessions`**, so `endSessionsOf` reads the table. It runs when a
  member is removed, never on a request of the widget.

**Not done here**: a rename of a
workspace (no screen asks for it; `organization: update` stays in the roles), and a membership check
on `GET /feedback`, which would read the accounts on every pin: an access token that was minted
before the removal lives its eleven minutes, and `SECURITY.md` says so.

## The invitations (FRU-104)

An owner or an admin invites an address into a workspace; the person signs in with that address and
joins. Six routes of the organization plugin more, under the rules of the section above.

### The rules, in short

- **The message holds no id and no token.** Its link is `<console>/invitations`, the page that
  lists the invitations of whoever signed in (`list-user-invitations`). Do not put the id of an
  invitation in a link: better-auth gives it to the session of the address only, but a link with an
  id is a link to log, forward and guess at, for nothing.
- **A route of the person is `scope: 'person'`** in `ORGANIZATION_PATHS`: it names no workspace,
  asks no role, and takes only `invitationId`. better-auth reads the address of the session. Never
  give one a field that names an address or a workspace (`email` of `list-user-invitations` is
  refused: better-auth takes it from a call in the process only, and the worker would hand it over).
- **A route that acts on an invitation of a workspace is `ofTheWorkspace: 'invitation'`**: the
  worker reads the workspace of the invitation before better-auth does, and answers `404` when it is
  not the one whose role it read. `cancel-invitation` needs it; a later route on an invitation does too.
- **The worker sends the message, not the plugin** (`sendInvitationEmail` is not set). The route
  asks the plugin first, then counts in one step (`kv.incr`) the window of the workspace for the
  address (`fruitback:invitation:<workspace>:<address>`, 3 in 15 minutes, the numbers of the
  sign-in link), and sends only under it. A call that the plugin refuses spends nothing. **Past the
  window the invitation is kept, no message goes, and the answer says `mailed: false`**: no `429`.
  The window was by address alone, read before the plugin: another workspace closed it, the
  invitation was then not made at all, and the `429` said that the address was invited elsewhere
  (FRU-209). A message that does not leave answers `502`, and the
  invitation waits, to send again with `resend: true`. **A worker with no mailer still invites**
  (decided on FRU-107): the invitation is kept, nothing is sent and nothing is counted, and the
  console shows the link to send by hand. The link is the same `<console>/invitations`, so a link
  sent in a chat is worth exactly the message: nothing without a session of the address.
- **The roles an invitation gives are `INVITED_ROLES`**: `admin` and `member`. `guest` waits for
  a site that can be shared with one person; `owner` is given by a change of role, by an owner.
- **The language of the message** is the one of the account of the address when it has one, else
  the one of the person who invites.
- **The console** (`invitations.tsx`, `members.tsx`, `home.tsx`): the front door sends somebody who
  has an invitation waiting to `/invitations` before the setup, so the person invited does not make a
  workspace of their own first. `e2e/console-invitation.spec.ts` goes from the message to a note.

### The reasons, and the measurements

Read in `routes/crud-invites.mjs` of 1.7.7; measured in `auth-organization.test.ts`.

- **Accepting runs `beforeAcceptInvitation` and no `beforeAddMember`**, and writes the role of the
  row. So the hook refuses a row with two roles: test:`refuses an invitation whose row holds two
roles, when it is accepted`.
- **With the ids of the worker (`generateId`), the plugin asks a verified address** to read, accept
  or decline by id. It is written (`requireEmailVerificationOnInvitation: true`): a later default
  changes nothing.
- **`cancel-invitation` finds the workspace from the invitation**, and checks the role of the caller
  there. Without `ofTheWorkspace`, an admin of a workspace would have passed the check of the worker
  in their workspace, and better-auth's check in the other one only if they were an admin there too:
  safe by better-auth alone, but the worker's own check would have read the wrong workspace.
- **The invitations of somebody who no longer invites are cancelled, and refused at the acceptance**
  (FRU-209, `cancelInvitationsOf` and `inviterStillInvites` in `auth-organization.ts`). better-auth
  never reads the inviter again when an invitation is accepted. They are in the route and not in
  the hooks of the plugin: a hook gets no adapter, the pool of `authOptions` is not a `pg` pool on
  PGlite (`pool.query is not a function`, measured), and `leave` runs no hook at all. The route reads
  who was removed, and the new role, in the answer of better-auth. A demotion that keeps
  `manage-members` (admin to owner, owner to admin) cancels nothing.
- **A second invitation of an address that waits** is refused (`USER_IS_ALREADY_INVITED…`), unless
  `resend`, which moves its end to 7 days from now and sends the message again.
- **What the plugin answers on a resend is the invitation as it was**, with the new end.
- **An invitation past its end** is refused at acceptance (`INVITATION_NOT_FOUND`), and leaves the
  list of the person.

**Not done here**, from the ticket: a guest limited to one site (a table of ours, the next slice),
« Last seen » in the table (nothing records an activity), « My account » (sessions, API keys), the
export of a workspace. The ticket said « the invitation is a pairing code »: with the plugin it is a
row that a session of the address accepts, and the pairing code stays what connects an extension.

## The sign-in of before and the accounts file go (FRU-150)

One way to sign in to the console, better-auth, and one place for the accounts, PostgreSQL. The
ticket removes; it adds no route and no table.

### The rules, in short

- **The console API reads the cookie, and no `Authorization` header.** `callerOf` in
  `console-api.ts` has one branch. A token signed with the key of the worker, the one of an
  extension included, opens nothing under `/console/` (FRU-202 refused it by its `ws`; there is no
  token to tell it from any more).
- **`GET /auth/providers` says `betterAuth` or nothing.** `{}` for a worker with no accounts, or
  with no `FRUITBACK_AUTH_SECRET`. The two booleans of the path of before are gone, so a console of
  before FRU-148 draws no button against this worker.
- **`FRUITBACK_ACCOUNTS_PATH` and `FRUITBACK_GITHUB_OAUTH` are refused at boot, never ignored**
  (`ACCOUNTS_FILE_REFUSED`, `GITHUB_APP_REFUSED` in `env.ts`). The message names what to set and
  `docs/self-hosting.md`. The compose file still hands both to the container, for that reason only:
  a variable that Compose does not pass is one the worker cannot refuse.
- **`FRUITBACK_GOOGLE_OAUTH` needs `FRUITBACK_AUTH_SECRET`**: nothing else reads it.
- **A database with no `FRUITBACK_AUTH_SECRET` is accepted**, and signs nobody in. It is the state of
  the production between switch 1 and switch 2, on the image of before; refusing it here would make
  that state a boot failure on the way back.
- **`accounts-sqlite.fixture.ts` is a test file.** The worker imports it nowhere
  (test:`runs for every implementation the worker exports` leaves it out by name). It stays for two
  jobs: the planted violations of the account conformance are changes to its source, and
  `postgres-copy.test.ts` makes with it the file that `migrate-to-postgres` copies.
  `ACCOUNTS_FILE_VERSION` is in `postgres-copy.ts`, and a test holds it equal to the fixture's.
- **`migrate-to-postgres` stays in the image**: it is how a deployment with an accounts file comes
  to this one.
- **The table `email_links` stays, and nothing reads it.** `createEmailLink` and `spendEmailLink`
  left the `AccountStore`. Dropping the table is a migration, and a migration is not a removal that
  an image of before survives: it goes with the tables of FRU-184.
- **`oauth-client.ts` parses `<client id>:<client secret>`** for the three applications that are
  left (GitHub and Google of better-auth, Linear). `console-cors.ts` holds what `console-routes.ts`
  kept that is not a sign-in: the origin of the console, its CORS, and which paths are the console's.
  `Authorization` is no longer an allowed header of a console route.

### The reasons, and the measurements

- **Refused, not ignored.** A worker that ignored `FRUITBACK_ACCOUNTS_PATH` would start with no
  workspace, and the operator would read the empty console as the accounts lost. A `500` on
  `/health` with the name of the variable is read in a minute:
  test:`refuses the accounts file of before, and says what to set and where to read how (FRU-150)`.
- **The tests of the console API, the connectors, the destinations and the deliveries moved to
  PostgreSQL** (PGlite), with a real sign-in by a link and the cookie: `console-world.fixture.ts`.
  They ran on an accounts file and a token minted by the test. PGlite holds one database per
  process, so a case opens one world.
- **Removed with their subject**: the tests of `console-routes.ts`, `github-oauth.ts` and
  `google-oauth.ts`, the cases of the email links in the two account suites, the case of a worker
  with accounts and no sessions (the sessions are in the same database now), and the one that
  migrated a destination inside an accounts file of an older version.
- **What the production must do before this image** is in `cloud/README.md`, « Switch 3 ».
  No agent ran it on the host.

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
- **`packages/shared/src/linear.ts` became `issue.ts`, because the name had outlived what it described.** FRU-23 took
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
  keeps its sessions on a disk it owns. A worker with `FRUITBACK_DATABASE_URL` keeps them in that
  database instead, beside its accounts (FRU-142): see _The sessions in PostgreSQL_.
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
- **With `FRUITBACK_DATABASE_URL` (FRU-141), the sites are the clients**
  (FRU-96). `withSites` in `app.ts` reads
  them from the accounts on every request and lays them over the configuration as its client map
  and its allowed origins, so routing, CORS and the `ws` check run unchanged. **An empty map stays
  empty**: `undefined` would make it a single-client worker that answers every page. `accounts.ts`
  holds the roles, and `can(role, action)` is the one table of who does what. The boot log says so
  too: `readExposureNotice` does not read a worker with accounts as « one client, public », which is
  what it printed on the first day of the Cloud (FRU-116).
- **Signing in to the console is better-auth's, and ends in no pairing code** (FRU-98, then
  FRU-147 and FRU-150). Until FRU-150 `/auth/email` and `/auth/email/redeem` made a session like the
  one of an extension, with a refresh token in an `HttpOnly` cookie on `/console/session`. They are
  gone. `consoleCors` (`console-cors.ts`) answers `FRUITBACK_CONSOLE_URL` and no other origin.
  `mail.ts` is the seam, Scaleway Transactional Email over HTTP the one implementation.
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
- **GitHub names the person, never the browser** (FRU-97). The worker's own `github-oauth.ts` did it
  until FRU-150; better-auth does it since (FRU-147), and the account is still an address GitHub
  verified. `FRUITBACK_PUBLIC_URL` is the callback's base: behind the proxy the worker sees only
  `http://`.
- **The store of a connector is built for the request, and nothing is kept between two** (FRU-102).
  A map of the stores existed, under a `WeakMap` by the object of the accounts. A request makes a new
  object of the accounts, so the map never found anything, while its comment said that a key was
  opened once. A cache that worked would hold the key of each tracker in the clear for the life of
  the process. A connector whose store costs something to build (GitHub mints a token) must bring
  its own cache, with a way out. `connector-stores.test.ts` holds two workspaces with two trackers,
  and it fails when one store serves the whole process.
- **A connector that its tracker refuses says « Needs attention »** (FRU-102). `connector-health.ts`:
  `watchedStore` notes on the connector what each call through it answered, and the console draws the
  state from that field, with what to do. **Only a refusal is kept**: a key that is refused, a key
  that may not do this, a connection that Linear ended. A tracker that is down answers `502` too, and
  nobody of the workspace can fix it. The first call that the tracker answers clears the state.
  **Keeping the state never changes the answer**: the note exists when it runs, and an error there
  would have the widget send the note again.
- **A delivery that comes back to a worker is refused by its header, not by its host** (FRU-133).
  `handleRequest` answers `508` to every request that carries `X-Fruitback-Delivery`, before the
  readiness probe: `/health` answered 200 to a delivery, and the sender counted the note as arrived.
  A list of the worker's own hosts was not taken: another name on the same IP passes it. `deliverDue`
  gives up on a `508` at once, with `LOOP_ERROR` for the console. **That answer is above the rate
  limit, and not metered, on purpose**: it reads no configuration, no `Kv` and no provider, and below
  the limit a loop would get `429`, which the sender tries again seven times.
- **Google signs a person in like GitHub** (FRU-135), through better-auth since FRU-147;
  `oauth-sign-in.ts`, which held the steps of both, went with FRU-150. Google's address is used only
  when `email_verified` is `true`. **The console asks `GET /auth/providers` before it draws a button**: a button for a
  provider the worker does not have leads to a `404`. The build argument of FRU-97 still turns
  GitHub on at once.

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
- **Nothing on the SQLite store can prove the redeem is atomic.** `redeemPairing` marks the code
  spent in one `UPDATE ... WHERE redeemed_at IS NULL` and acts on `changes === 1`, which is right for
  two workers on one volume or an asynchronous driver. But `DatabaseSync` is synchronous and the
  store awaits nothing between its read and its write, so two redemptions cannot interleave here
  however they are scheduled: a `Promise.all` over three of them passes against a read-then-write
  store too. Measured. The first concurrency test claimed to guard this on SQLite and was deleted.
  The case is back in the conformance suite (FRU-140), for a store that waits, and it says what it
  proves: test:`gives one session to two reviewers who redeem one code at the same moment` passes on
  SQLite whatever the store does, and its control is a store that reads, waits, then writes.
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
- **A site sends to a list of places, and a member chooses one for a note** (FRU-123).
  `Site.destinations` is ordered and holds five at most (`site_destinations`). The first one is where
  the client routes, so a site with one place works as before. **A read asks each place**, with one
  cache entry for each: Linear finds a note by its team. `GET /feedback` answers `destinations` after
  the cache, **never in the cached answer**, and only to a session whose role has `see-tracker`
  (`seesTracker`, the role is read at each request). A place has an opaque id (`destinationId`) and a
  label that the worker writes from the tracker. The choice is `POST /feedback?destination=<id>`:
  the body stays the seed, and the relay carries a query. **`verifyForClient` says `session` only for
  a token that the worker key verified**: a site can write a workspace in its own tokens.
- **`GET /feedback` answers `identified: true` to a reader whose token it verified** (FRU-112), so
  the composer of the widget asks for no name that `attributionFor` would replace. `signsNotes` asks
  `verifyForClient`, like the write path, so a token of the site counts like a session. Asked at each
  request and **never in the cached answer**, like the places. On a public read a token that does
  not verify is not refused, as before: the read answers, without the field. **One bit**: the name,
  the address and the account id of the token are not in the answer, because the page reads it in
  team mode.

## A domain a workspace proves, for the previews of a site (FRU-103)

### The rules, in short

- **`domain-proof.ts` holds the proof, and asks the DNS through a `TxtResolver` it is given.** The
  routes take `RequestContext.resolveTxt`, the timer takes `systemResolver`. **No test asks a real
  DNS**: `domain-proof.test.ts` hands a double to every call, and the default of its harness throws.
- **The value of the record is computed** from the workspace id and the domain, never kept: a domain
  removed and added again is proven by the record still in the zone.
- **Three answers, not two.** `missing` is the DNS answering without the record (`ENOTFOUND`,
  `ENODATA`, or other records); `unknown` is a DNS that did not answer, and it changes nothing but
  `checked_at`. A proof is lost at the first `missing` after it was proven, or after
  `PROOF_GRACE_MS` with no `found`. The first moment of a loss stays.
- **Only a proven domain is asked again by the timer** (`server.ts`, every ten minutes, twenty
  domains a pass, each one every `RECHECK_MS`). A pending domain is asked when an admin presses
  « Check » in the console, at most once in `CHECK_AGAIN_MS`.
- **`previews_site_id` says what an admin asked, and holds only while the proof does.** It survives a
  loss, so a record that comes back covers the previews again with nothing to do. `GET /session/sites`
  lists `previews` for a site only from a domain that is proven at that moment.
- **The domains are a table of their own**, not a column of `sites`: the tables that
  `migrate-to-postgres` copies stay the ones of `COPY_SCHEMA`. A SQLite file that holds a domain is
  refused by the copy, with what to do, rather than copied without it.
- **The PostgreSQL migration is `0003_domains`**, generated.

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
