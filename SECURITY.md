# Security

Fruitback puts a widget inside somebody else's page and a worker in front of somebody's issue
tracker. Both of those are trust boundaries, and this file says where they are.

**Writing the known limits down is the policy.** A file that only says "email us" leaves a
self-hoster to discover on their own that the pins of a site everyone reads are open to anyone who can
build a URL.

## Reporting a vulnerability

**This repository is private today**, so GitHub's Private Vulnerability Reporting is not available
on it — that feature is for public repositories, and the endpoint answers `404` here. Checked, not
assumed.

- **While the repository is private**, report through the repository itself, with the _Vulnerability_
  issue form. Everyone who can read it can already see an issue, so there is no public disclosure to
  avoid.
- **When it becomes public**, Private Vulnerability Reporting is the channel, and enabling it is part
  of going public. So is deleting `.github/ISSUE_TEMPLATE/security_report.yml`. Until it is on, _this section is wrong_ — update it in the same change.

Please do not open a public issue for a vulnerability once the repository is public.

## What is supported

Since `0.3.0`, the five packages of `packages/*` (`fruitback`, `@fruitback/shared`, `@fruitback/widget`,
`@fruitback/element`, `@fruitback/react`) are on npm, beside the worker image on GHCR. `release-npm.yml`
publishes them from a release published on GitHub (its tag `v*`), after `ci.yml` passed on that commit and a person approved the run. Each
tarball carries a provenance attestation that names the commit and the run that built it: `npm audit
signatures` checks it. A version on npm is never replaced: a fix is a new version. **Only the latest
version gets a fix.**

`0.x` means the contract can change. Pin a digest rather than a tag if you need a build that cannot
move under you: no tag is immutable, `sha-<commit>` included, because rebuilding the same commit
republishes it under a new digest. See
[docs/decisions/image.md](docs/decisions/image.md).

## The threat model

Everything below is a property of the code as it stands, not an aspiration. Each one is somewhere a
self-hoster could otherwise be surprised.

### Who reads the pins: the visibility of each site

Every worker has a database since FRU-225, and its sites are the ones its console made. **Each site
has a visibility, chosen when it is added**:

- `members`: `GET /feedback` answers a session of the workspace of the site, and nobody else. A site
  added through the API with no visibility is `members`.
- `everyone`: `GET /feedback` answers **anyone who can build the URL**. Every note, the name and
  address its reporter typed, and the team's replies are readable by any visitor of the site — and by
  `curl`. Hiding pins in a browser was never the fix.

The boot log says that the visibility is chosen site by site. `FRUITBACK_READ` does not apply to a
site: it was the setting of a worker with no database, and that worker no longer starts.

A site that only members read takes a note from its members only, unless its « Who can leave a
note » says « Anyone on the page ». A new site says « Members only », and a site made before FRU-330
says « Anyone on the page ». The paragraph that starts « The visibility of a site decides who reads
it », further down, gives the tests.

A link that opens a note on its page, `<page>#fruitback-note=<id>`, opens nothing to somebody who
cannot already read that page: the widget opens the note among those `GET /feedback` answered to
this reader, and a refused read opens nothing. The id in the address is not a secret and gives no
access.

A worker with no database, until FRU-225, read `FRUITBACK_READ`: `public` by default, so that an
upgrade never closed a read for its operator, or `authenticated`, which asked for a signed identity
token.

A token travels in an `Authorization` header, which makes the request preflighted, so the worker has
to advertise the header in `Access-Control-Allow-Headers`. **It did not until this file was
written**, and `FRUITBACK_READ=authenticated` therefore answered nobody from a browser at all — the
request was refused by the browser before the worker saw it. Writing the mitigation down is what
found that.

`FRUITBACK_HIDE_COMMENTS=1` keeps the team's replies out of the answer. Under `read: 'public'` that
is the only thing between an issue thread and the internet.

**It was the worker-wide fallback, not an override**, on a worker of before FRU-225: a client declared
in `FRUITBACK_CLIENTS` with its own `showComments` won over it. A site of the console has no such
setting of its own: the switch of its connector, below, is the one that can take replies away.

**A connector of a workspace can only take the replies away** (FRU-102). Its switch « Show Linear
comments as replies » is off or on, and on keeps what the worker decides: a worker with
`FRUITBACK_HIDE_COMMENTS=1` hides the replies of every connector, whatever its switch says. The
switch reaches the next read of the tracker; an answer already in the read cache keeps its replies
until its entry ends, or until a note is written on that page.

### `clientId` is asserted by the browser, never authenticated

A page says which client it is. `origins` is what turns that claim into something checkable against
the browser's own `Origin` header — **the trust level CORS gives, and strictly no more**. It stops an
unrelated site from posting into your tracker through your worker. It is not authentication, and
describing it as such in your own deployment notes would be a mistake.

A request with no `Origin` at all is served — `curl`, a health check, anything server-to-server. That
is about **cross-site forgery** and nothing else: there is no cookie or ambient session, so a page
cannot make a visitor's browser do something privileged. It is emphatically **not** a claim that a
direct caller reads nothing. On a site that everyone reads, `curl` reads every note on a page, and
closing that is the visibility `members`, not CORS.

**The extension's site rules are the same claim, made by the reviewer's browser** (FRU-43). A rule
maps an origin, or a wildcard such as `https://*.staging.acme.dev`, to a worker and a mode, and it can
be imported from a file somebody sent. In private mode the rule holds the client id the widget
asserts; in team mode it holds none, and the site's own widget asserts its client id. Either way the
client id is still a claim. What the worker checks differs by mode:

- **Private mode**: the widget calls from the page, so the worker compares the page's **exact** origin
  with that client's `origins`. A wildcard in a browser does not widen that list.
- **Team mode**: the relay calls from the extension's origin, which the worker exempts from `origins`
  (see [What the extension relays](#what-the-extension-relays-and-what-it-refuses-to)). The binding
  is the extension's own: a page gets a relayed call only if a rule covers its origin, and only to the
  endpoint that rule names. **A team rule names one origin, and a wildcard in team mode covers
  nothing.** A wildcard needs only a base of two labels, so `https://*.vercel.app` is a valid pattern,
  and it would let the sites of other people spend the reviewer's session. The form and the import
  refuse such a rule, and for one already stored the bridge does not announce and the relay answers
  `site-not-configured`. A wildcard stays valid in private mode, which carries no credential.
  **One exception** (FRU-103): a wildcard that the worker of the session lists as the previews of a
  site, because its workspace proved the domain. See
  [A domain a workspace proves it owns](#a-domain-a-workspace-proves-it-owns-to-cover-its-previews-fru-103).
  A rules file holds no session and no host
  permission, so an imported rule runs nowhere until the reviewer grants its pattern in their browser.

### `reporter.verified` is the worker's word

Anything a browser posts carrying `verified` has it stripped before storage, whatever else it says.
The flag is set only after an HS256 token verifies against the client's key. Without a token, a name
and an address are a claim by whoever was on the page, and they are stored as one.

### A note is stored in the clear, in your database or your tracker

The whole note — its text, page URL, selector, the reporter's name and address — is
stored as it arrived, and **where** depends on the connector:

| Store      | Where a note lands                                                                                 | Who can read it                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `linear`   | verbatim in an issue description                                                                   | anyone with access to that workspace                                                                                 |
| `postgres` | `JSON.stringify(note)` in the `payload` column of the table `notes`, in the database of the worker | anyone who can read that database, or a dump of it: the role of `FRUITBACK_DATABASE_URL`, and whoever holds a backup |
| `github`   | verbatim in an issue body                                                                          | anyone who can read that repository. **On a public repository, that is everyone.**                                   |

Whichever store, it outlives any expiry you had in mind, which is why an identity token travels in an
`Authorization` header and never in the note. On PostgreSQL the database and its dumps are the
boundary, and they deserve the care a database of personal data deserves. (A SQLite file kept the
notes of a worker of before FRU-225: `migrate-to-postgres` copies it, and the file and its backups
stay personal data until they are deleted.)

**On PostgreSQL one database holds the notes of every workspace** (FRU-218), in the clear, beside
the accounts. Nothing is sealed: `FRUITBACK_SECRETS_KEY` covers the keys of the trackers, not the
notes. What keeps one workspace from the notes of another is the read itself, which names its site
(`client_id`), and a read that names none gets the notes that name none:
test:`never gives a site of one workspace the notes of a site of another, on one page of one address`,
test:`gives a read that names no site the notes that name none, and never the notes of a site`.
`node server.mjs forget` deletes across every site of the worker: it is the command of whoever runs
the worker. **The notes of a site that is removed are deleted with it**, and those of every site of a
workspace that is deleted (FRU-194):
test:`removes the notes, the replies and the deliveries of a site that goes, and of no other site`.

Tell your reporters not to type credentials into a feedback note, because the note is going to sit
somewhere for a long time.

### What the database keeps, and who reads it

Every instance has a PostgreSQL database since FRU-225 (a decision of 2026-10-13): one of its own,
which `docker-compose.yml` starts, or a schema of one that exists. **What it keeps**, all of it in the
clear unless this list says otherwise:

- **The notes and their replies**, for every site whose notes stay in the instance: the store
  `postgres`, which is the default. A note sent to a tracker leaves its id there, and at most 64
  characters of its text in the index (below).
- **The accounts**: the address of each person, the name they gave, the id each provider gives them,
  their language; the workspaces, their members and roles, the sites and the address of each site.
  No password, and no token of a provider.
- **The sessions**, of the extension and of the console: SHA-256 digests of each code and token, never
  the token, with the name and the dates of each.
- **The key of each connector, encrypted** with `FRUITBACK_SECRETS_KEY`, which is in no row. The notes
  are not encrypted by that key.
- **The addresses of callers, for two minutes**, in the table `kv` of the rate limit.
- **The logo of a workspace**, when its owner or an admin sent one (FRU-428): the bytes of one image,
  in the table `workspace_logos`, until it is removed or replaced, or its workspace goes. See below.

**Who reads it**: the role of `FRUITBACK_DATABASE_URL`, and so whoever holds that address; whoever
runs the server of the database, and any other role it grants; and whoever holds a dump. The worker
keeps the workspaces apart by what each read names, never by a wall in the database. In a database
that another application uses, a schema of its own is a place for names and not a wall: see below.
The connection is encrypted only when the address asks for it (`sslmode`), and only then.

**How long**: as long as the row exists, and no longer than its site: a site removed from its
workspace takes its notes with it (FRU-194), and `node server.mjs forget` deletes them before, as
[docs/privacy.md](docs/privacy.md) says. A session of the extension ends after
30 days at most; a row of `kv` goes after its two minutes, as requests come. **A dump keeps all of it
for as long as the dump is kept**, and the four secrets that the dump lacks
(`FRUITBACK_POSTGRES_PASSWORD`, `FRUITBACK_AUTH_SECRET`, `FRUITBACK_IDENTITY_SECRET`,
`FRUITBACK_SECRETS_KEY`) are what make it a set of working keys. Keep them apart from the dumps.

### The GitHub App key

`FRUITBACK_GITHUB_PRIVATE_KEY` signs the tokens of the App. Whoever holds the key can mint a token for
every repository the App is installed on, with every permission the App has. The worker narrows each
token to one repository and one hour, but the key itself does not expire. So:

- Give the App **Issues: Read and write** and nothing else, and install it only on the repositories
  that receive notes.
- Keep the key out of the image and out of any repository, like `LINEAR_API_KEY`.
- If the key leaks, generate a new one, delete the old one under **Private keys** in the settings of
  the App, and restart the worker with the new key.

**The App of the connectors is another key, and a larger one** (FRU-359). On the Cloud, a workspace
connects its GitHub by an installation of the public App « Fruitback App »
(`FRUITBACK_GITHUB_CONNECTOR`, `FRUITBACK_GITHUB_CONNECTOR_PRIVATE_KEY`). Each organisation that
installs it adds its repositories to what this one key reaches. Whoever holds
`FRUITBACK_GITHUB_CONNECTOR_PRIVATE_KEY` can mint a token for **every repository of every
organisation that installed the App**, with Issues read and write. That person can read and write
the issues of each client, and read their metadata. What holds it:

- The key is in the environment of the worker only. The database keeps the id of each installation,
  sealed by `FRUITBACK_SECRETS_KEY`, and no key and no token: a dump reaches no repository, even
  with that secret.
- The worker asks each token for the repository of one destination only (`repositories` of
  `POST /app/installations/{id}/access_tokens`). The token lasts one hour, and the worker keeps it
  in memory until five minutes before its end, by installation and repository: a token of one
  repository is never used for another. GitHub says which repository the token reaches, and a token
  that does not name the repository of the destination alone is not used.
- **One token reaches every repository of an installation: the token of the list** (FRU-361).
  The console lists the repositories of an installation for an owner or an admin who chooses a
  destination (`GET …/connectors/<id>/repositories`). That token asks for `permissions: { metadata:
  'read' }` and nothing else, so it reads the names and the visibility of the repositories, and
  writes nothing. A token that GitHub answers with another permission is not used. No cache keeps
  it: each list mints its own, and no note, reply or label call ever gets it. The list stops at
  1000 repositories (10 pages of 100). The condition: GitHub gives an installation token only the
  permissions that it asks for.
- **Whether the repository of a destination is public is GitHub's word, never the request's**
  (FRU-382). When a destination is written, the worker asks a token for that repository alone with
  `permissions: { metadata: 'read' }`, and reads `private` from `GET /repos/{owner}/{name}`. A token
  that GitHub answers with another permission, or for another repository, is not used, and no cache
  keeps it. When a note goes there, the token of the note reads it again, and every destination of
  that connector to that repository takes it: a repository that turned public is said at the next
  note. A `private` in the body of the route is not read. A GitHub that does not answer leaves it
  unknown and writes the destination, and costs a note nothing. Every role that reads the
  destinations of a site reads it, a member too: the console warns before an issue goes public.
  test:`learns it when the destination is written, with a token of that repository alone that reads the metadata only`,
  test:`writes the destination when GitHub does not say, and keeps nothing of it`,
  test:`learns it again when a note goes: a repository that turned public is said at once`,
  test:`costs the note nothing when GitHub does not say it then`.
- A repository that the installation does not cover (GitHub answers `403`, `404` or `422` for the
  token, `403` or `404` for the issue) makes the connector « Needs attention ». The worker then asks
  no token for another repository. A rate limit of GitHub is not a refusal, and changes nothing.
- The installation of the App is the client's consent, given on GitHub. The worker attaches an
  installation to a workspace only when the person who comes back from GitHub reaches it, and one
  installation feeds one workspace: « The GitHub App, installed on a workspace » below.

If the key leaks:

1. Under **Private keys** in the settings of « Fruitback App », generate a new key.
2. Put it in `FRUITBACK_GITHUB_CONNECTOR_PRIVATE_KEY`, and restart the worker.
3. Delete the old key on the same page. GitHub then refuses every token that the old key asks for.
   A token minted before stays valid until its end, one hour at most: nobody can revoke it with the
   key alone.
4. Tell each organisation that installed the App: during the leak, its issues could be read and
   written. The audit log of each organisation shows the calls of the App.

Replace the key the same way once a year with no leak. Steps 1 to 3 cost no installation: an
organisation keeps its installation, and the connectors work again after the restart. The client
secret of `FRUITBACK_GITHUB_CONNECTOR` is replaced on the same page, under **Client secrets**.

### The keys of the extension stores

`release-extension.yml` submits the extension to the Chrome Web Store and to AMO (FRU-329). The keys
are the private key of a Google service account and the JWT secret of AMO. Whoever holds either key
can upload a version of the extension, which every reviewer's browser installs after the review of
the store. So:

- The keys are secrets of the GitHub environment `stores`, and not of the repository. The job
  `submit` reads them only after a person of the environment approves the run, and only after the
  job that calls `ci.yml` passed on that commit.
- A release published on GitHub runs on its tag `v*`: after the approval, it sends the archives to
  the stores. A run on any other ref (a start by hand on a branch, or a release whose tag does not
  start with `v`) only checks the keys (`--dry-run`): it uploads nothing.
- The Chrome Web Store publishes nothing by itself. `STAGED_PUBLISH` keeps the reviewed version
  until somebody presses « Publish » in the dashboard.
- Give the service account access to this one publisher only. If a key leaks, delete it in Google
  Cloud or on AMO, then put a new one in the environment.

### Who can publish the packages on npm

`release-npm.yml` publishes the five packages of `packages/*` (FRU-28). A version on npm reaches every
site that installs the widget from it. **No npm token exists**: npm trusts the OIDC token of a run,
and only for these conditions, which each package names as its trusted publisher:

- the repository `sakuga-software/fruitback`, the workflow `release-npm.yml`, the environment `npm`;
- the job `publish` reaches that environment only after a person of the environment approves the
  run, and only after the job that calls `ci.yml` passed on that commit;
- a release published on GitHub runs on its tag `v*` and publishes after the approval; a run on any
  other ref (a start by hand on a branch, or a release whose tag does not start with `v`) only packs
  (`--dry-run`): it publishes nothing.

So who can publish is who can publish a release on GitHub, which takes the right to write to the
repository, as a pushed tag did, **and** approve the environment `npm`. A tag pushed alone starts
nothing since the release trigger. A person of the
org `@fruitback` on npm can still publish by hand, with their own two-factor authentication.

### The rate limit is counted in the database

`RATE_LIMIT_PER_MINUTE` (20 by default) was held in memory, per container, on a worker with no
`FRUITBACK_DATABASE_URL`: N replicas of such a worker had N times the ceiling. Every worker has a
database since FRU-225.

**A worker counts in its database** (FRU-67), in the table `kv`: its replicas share one limit,
one count of the sign-in links and of the invitations of an address, and one read cache. No variable
turns it on. What follows from it:

- **Two replicas that count at the same moment get two different counts.** One statement counts, and
  PostgreSQL locks the row of the key. It runs on a real server, in CI:
  test:`gives each of 400 counts of one key to one caller, from two connections`.
- **A database that does not answer refuses the metered call**, with `503 limiter-unavailable`,
  rather than letting it through: a limiter that opens when its store stops is a limiter anybody can
  open. That holds below the limiter too: the count of the links and the ticket of the way to Linear
  answer the same `503`. `/health` reads no count.
- **The limit of better-auth counts there too** (FRU-229), and it is off unless
  `FRUITBACK_AUTH_TRACK_IP=1`. On, better-auth counts its own routes under `/console/auth/`, by
  address and by route, with its own rules, in the same table: its replicas share one ceiling, where
  each one kept its own count in its memory before.
  test:`makes two instances on one database share the ceiling of a route`. A database that does not
  answer refuses those requests with the same `503`:
  test:`refuses with 503 limiter-unavailable when the Kv does not answer, and lets nothing through`.
  Its window is fixed, and starts at the first request of an address on a route.
- **A write of that table does not wait for the disk.** The limiter writes once for each request of
  the widget, and the wait was the whole cost of a count. If the server of the database crashes, the
  writes of its last few hundred milliseconds can be lost: a caller gets a few requests more in that
  minute. Nothing else is written that way: an account, a site and a session wait for the disk as
  before. On a real server:
  test:`commits without waiting in its own statement, and leaves the connection as the server set it`.
- **Whoever can write to that table can plant pins and clear limits.** A cached answer holds the
  notes of a page, their authors and the replies for 15 seconds, and a row of the limiter holds the
  address of a caller for two minutes. It is the database of the accounts, behind the same password.

The window slides, estimated from the current minute and the one before it. A caller who sends a full
burst at the end of a window and spaces the next ones out gets **at most 39 requests in any 60
seconds** through, for the default limit of 20. That is `2 × limit − 1`, and `rate-limit.test.ts`
holds the number against the code. A steady caller stays at the limit.

**A batch of notes costs one request for each note** (FRU-124). `POST /feedback` with an array passes
the limiter for one when it arrives, and the worker counts the others once the body is read, before
anything is written: over the limit, `429` and no note. A batch holds half the limit of a minute at
most, and ten at most; a worker whose limit is below four takes no batch. The body keeps its cap of
64 KiB, whatever the number of notes.

It protects your provider quota; it is not a defence against a determined caller, who can rotate
addresses anyway.

`TRUSTED_PROXY_HOPS` (1 by default, which is one Traefik) decides how the client address is read:
the worker takes the entry that many places **from the right** of `X-Forwarded-For`, and the socket
peer when the chain is shorter. Set it to the number of proxies between the internet and the
container.

`docker-compose.yml` publishes the port with no proxy in front, so it sets 0 (FRU-48). With 1 and
no proxy, the rightmost entry is the one the caller wrote: each read that forges a new address gets a
new bucket, and the limit never applies. Measured on that file: with 1, forged reads kept answering
`200` past the limit; with 0, the same reads answered `429` once the limit was reached.

**Set it too high behind a proxy that appends, and the limit is bypassable with one header.**
Counting further left reaches the part of the chain a caller wrote, so anyone can mint a fresh bucket
per request. The same happens with nothing in front, as above. Behind a proxy that replaces the header,
a count that is too high costs a shared bucket instead: see the next paragraph. Measured against
`resolveClientIp`, with a caller sending `1.2.3.4` through one proxy that appends `203.0.113.9`:

| `TRUSTED_PROXY_HOPS`       | Address used    |                                                     |
| -------------------------- | --------------- | --------------------------------------------------- |
| `1` — one proxy, the truth | `203.0.113.9`   | the address the proxy observed                      |
| `2` — one too many         | `1.2.3.4`       | **what the caller sent**                            |
| `0` — none                 | the socket peer | the proxy's own address: everyone shares one bucket |

**Not every proxy appends** (measured on FRU-50). nginx with `$proxy_add_x_forwarded_for` keeps what
the caller sent and appends, so the table above holds: with `2` behind it, 24 forged reads all
answered `200`. Traefik v3.5 and Caddy 2.10 replace the header by default with the address they saw.
Behind them a count that is too high falls back to the socket peer, so every caller shares the
proxy's bucket instead of escaping it. A replacing proxy behind another proxy loses the client's
address unless it trusts that proxy (Traefik: `forwardedHeaders.trustedIPs`).
[docs/self-hosting/reverse-proxy.md](docs/self-hosting/reverse-proxy.md#behind-a-reverse-proxy) has the cases and a check an
operator can run.

### The body of a request has a cap (FRU-506)

**Every route of the worker reads its body under a cap**, and answers `413 payload-too-large`, with
`maxBytes`, over it. The cap is 64 KiB (`MAX_BODY_BYTES` of `bounded-body.ts`). A file in transit and
the logo of a workspace have their own caps: see their sections. A declared `Content-Length` over the
cap is refused before a byte is read. A body with no length, or with a false one, is read until it
crosses the cap, and no further.

Before FRU-506 the routes of the console read their body with no cap: the sign-in by a link, the
routes of better-auth that the worker forwards, the account, the workspaces and the administrator.
Three of them answer a person who is not signed in. The routes of OAuth (`/oauth/register`,
`/oauth/token`, `/oauth/revoke`) and of the connection of the extension read under the cap already,
and answered `400` over it: they answer the same `413` now. What the cap protects: the memory of the worker
against one large request. It is not a limit of rate: see the section above.
test:`is refused over the cap on the routes of the sign-in, which need no session`, and the guard
test:`is read by bounded-body.ts and by nothing else`, which fails on a route that reads its body
another way.

### Private mode hides the pins from a visitor, and from nobody else

**The widget the extension mounts in private mode carries no credential.** `page.content.ts` mounts
it with no transport, so it calls the worker exactly as a public-mode site does, and the notes on
that page stay readable by anyone who can build `GET /feedback?url=…&client=…`. What private mode
changes is who is **shown** the feedback — the site embeds nothing, so a visitor sees nothing — never
who may **fetch** it. Its reporters are self-declared for the same reason: verification comes from
the session, and only the relay carries one.

**What changes a read is `read`, not the mode**, and the mode decides who can satisfy it. A
public-mode site can run `read: 'authenticated'` by minting identity tokens itself — `identityToken`
is a seam on `init`, and the widget sends what it returns on reads as well as writes; the credential
then lives in that site's own page. Team mode is the one where the **reviewer** supplies it and the
page never holds it, attached in the extension's background. Private mode can supply neither, so
worker-wide `authenticated` locks its widget out of its own reads.

A worker that serves team mode can hold several clients (FRU-95). **A session belongs to one
workspace**, named by the operator when the code is minted (`pair --workspace`), and its access
token carries it as the `ws` claim. Every session token is signed with the one worker key, so the
signature does not separate two workspaces: **the claim does**. A client that declares a `workspace`
accepts a token signed with the worker key only when `ws` names that workspace, on the read and on
the write, from a page and through the relay. A client with no workspace accepts no session token.
Two boot refusals hold this: sessions with a client map in which no client declares a workspace, and
a client whose own `identitySecret` is the worker key, which would verify every session token as the
site's own and skip the check. See [docs/modes.md](docs/modes.md).

### The extension's page bridge can be forged by the page

In private mode the widget runs in the page's own JavaScript realm, and the bridge is
`window.postMessage`. The parser refuses a malformed message; it **cannot** refuse a well-formed one
the page wrote, because the two are identical. A page on an origin the reviewer enabled can point the
widget at its own worker, or take it away.

That is inherent to the main world and no handshake closes it. What is reduced is what is at stake:
nothing secret travels there, the endpoint and client id are already in the client's own DOM in tag
mode, and **an identity token is not sent at all**. `apps/extension/src/worlds.test.ts` holds that for the imports of
the main-world scripts. `e2e/extension.spec.ts` holds it in a real browser: after a pairing and a
relayed write, no stored token appears in anything the page's JavaScript can read.

**The page learns whether the reviewer's session for its site has ended** (FRU-315): a boolean,
`{ kind: 'session', signedOut }`, so the widget offers the sign-in. It could already tell from the
`401` the relay answers. The page can forge that message and the widget's ask for the sign-in: the
first changes what our widget says on that page, the second opens our popup over that tab, only
when its site wants a session, at most once in 5 s for that tab, and never over a popup already open. Neither reaches a token, the relay or another tab.

**Two copies of Fruitback in one browser do not talk over each other** (FRU-397). The channel
carries the version of its protocol (`fruitback-extension/2`), and each message the tag of its copy:
a tag the page script draws for this page, with a proof in its `ready` that is a hash of the tag and
of the address of its copy (`chrome-extension://<id>/`, read from its own stack). A bridge hears only
the tag whose proof its own address gives. This is not access control: the page can read the same
stack and forge any of it, as above. It keeps the page script of an old copy, which knew no relay,
from obeying a new bridge and reading a site of a workspace with no session. What the page learns
that it did not: the version of the copy that holds it (in `ready`, and on
`window.__fruitbackPageHolder`). The address of the copy is not posted; the tag is new on each page.

### What a session protects, and what it does not

The worker can hold sessions for the browser extension. An operator mints a pairing code for a named
person; redeeming it opens a session. **This table is the session of the extension.** The console
holds another kind of session, a cookie of better-auth (FRU-147), which does not rotate: see
[Signing in to the console with better-auth](#signing-in-to-the-console-with-better-auth-fru-147).

|               |                                                            |
| ------------- | ---------------------------------------------------------- |
| Pairing code  | 60 bits, valid 15 minutes, usable **once**                 |
| Access token  | HS256 identity token, 10 minutes                           |
| Refresh token | 256 bits, 30 days, **rotated on every refresh**, revocable |
| On disk       | codes and refresh tokens are stored as **SHA-256 digests** |

**No cache keeps a token** (FRU-506). Every answer of `/session/pair`, `/session/refresh` and
`/session/revoke`, a refusal included, says `Cache-Control: no-store`. Every other JSON answer of the
worker says it too. Before FRU-506 these three routes did not, and `/session/pair` and
`/session/refresh` answer an access token and a refresh token. The header is an instruction: it
protects against a proxy or a cache that obeys it, and against no other. See
test:`answers POST /session/refresh with Cache-Control: no-store`.

**A pairing code can travel in a link, `<worker>/pair#<code>`** (FRU-92). What that changes:

- **The code is in the fragment**, which a browser sends to no server. The worker does not receive
  it and no access log holds it. `GET /pair` is a static page with no script, it reads nothing from
  the request, and it answers `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- **The code is in the reviewer's browser history and in whatever carried the link**: an e-mail, a
  chat. It was already in that message as a code to copy. It is spent at the first pairing and dies
  after 15 minutes, which is the whole protection: treat a link like the code it holds.
- **Any page can have an address of that shape**, so a link proves nothing about who wrote it. The
  extension takes the worker from the page the link is on, never from a value in the address: a page
  can make the popup offer a pairing with **itself** and with no other worker. The popup names that
  worker and pairs only on a click. A reviewer who pairs with a worker they do not know has given it
  nothing: a session is per worker, and the relay uses it only for a site whose rule names that
  worker.
- **The popup reads the link, not a script in the page.** The address of the tab comes to it through
  `activeTab`, on the click on the toolbar icon. No content script runs on the worker's page and the
  code crosses no `postMessage`.
- **The person is not named before the pairing.** A name in the link would be the word of whoever
  wrote the link. The worker answers who the code was minted for, and the popup shows it after.

**Every refresh spends its refresh token and issues a new one** (FRU-61). A token that never
changed was a thirty-day password: a copy taken from a browser profile stayed good for the rest of
the month and nothing observed the theft.

**Rotation makes the theft detectable. It does not cap what the thief gets**, and an earlier version
of this section said it did. A refresh token is a bearer credential: whoever presents it is served.
Each presentation of a spent token revokes the successor the one before it minted, so the **last**
holder to present it keeps the live chain and every earlier one is locked out. A thief who presents
after the reviewer takes the session, and the reviewer pairs again.
What rotation guarantees is that the two cannot both keep the session: the loser's next refresh is
refused, so the theft surfaces within one refresh cycle instead of lasting a month. See _the cost_
below, and test:`serves whoever presents last inside the grace, until the earlier holder comes back`.

What retires the spent token is its successor being **used**. That is proof the caller who was
answered received it — not that the caller was the real client, which a bearer token cannot say —
and it is not a timer. The timer is only a ceiling for the case with no such proof: an answer lost on the
wire, where the holder never learnt the successor exists. It is set from how long that client waits
before retrying, measured from the **first** rotation, and a test derives it from the extension's own
constants rather than restating a number here.

Inside that ceiling the spent token may be presented more than once. Each time, the successor nobody
received is revoked and another is minted, so exactly one successor is live at any moment. The mark
does not move with the retries — sliding it would turn a lost-answer allowance into an unbounded
lease on a token that was supposed to be spent.

**A refresh token presented after its successor was used revokes the whole chain.** The real client
had moved on, so whoever still holds this one copied it. Every live token descending from it goes
with it, and the reviewer has to pair again. That is the intended outcome — a silent theft becomes a
visible one.

**The test is the chain, not the row.** A revoked token presented while something in its chain is
still live means two parties hold tokens from one chain, and that is the signal. A chain with nothing
live left is an ended session and answers the same `401` without calling anything a replay.

That distinction is what closes the case this section used to get wrong. A thief presenting the
predecessor inside the grace has the client's own successor revoked under it; when the client then
presents that successor — revoked, never rotated — the chain goes, and the thief's session goes with
it. The earlier version answered `gone` there and left the thief refreshing for the rest of the
thirty days while the reviewer re-paired, which is the opposite of what this document promises.

The cost, deliberately taken: whoever intercepts one answer in flight can end the session whenever
they choose. Reading a response body already implies a position from which the session can be taken
outright, so the capability this grants an attacker is one they do not need.

**Log out revokes the chain too** — ending only the token presented would leave its successor live
for the rest of the thirty days.

The reply says nothing about any of this. A replayed token and a token that never existed get the
same `401`, for the same reason the two pairing failures do: telling a replayer that their copy was
genuine confirms they hold the right kind of secret.

The cost is stated rather than hidden, and the two cases differ:

- **Inside the grace**, the successor has not been used yet and the worker cannot tell a retry from a
  copy. Each presentation replaces the successor, so the **last** one to present holds the live chain
  and the earlier holder finds their token revoked. A thief who presents after the reviewer takes the
  session, and the reviewer pairs again.
- **On a replay**, the successor has already been used, so the collision is unambiguous and the whole
  chain goes. Both of them lose the session.

In neither case does the thief end up with less than they started with — they already held a working
credential. What changes is that the theft becomes visible within minutes instead of lasting a
month, and that no state leaves both parties quietly sharing one session.

Since FRU-60 the extension holds its half of that, and **where** matters as much as the lifetimes:

|               |                                                                                   |
| ------------- | --------------------------------------------------------------------------------- |
| Refresh token | `chrome.storage.local`, in the reviewer's browser profile — it survives a restart |
| Access token  | `chrome.storage.session`, which the browser empties when it closes                |

**Each endpoint has its own storage key** (FRU-63). One key holding every worker made the popup and
the background write over each other: a refresh could put a credential back after a logout cleared
it, so a session a reviewer had ended stayed usable until it expired. Logging out now removes the
key it names, and no ordinary operation on another endpoint writes it.

Two writers still reach that key, and the split does not order them. A refresh for the **same**
endpoint compares the stored token and writes after it, so a logout can land between the two. **A
logout mints a new epoch for the endpoint before it clears anything** (FRU-64), and an entry stamped
with the epoch before it is refused by every reader. The write itself cannot be stopped — there is no
transaction and no compare-and-set — and it no longer has to be: the session a refresh puts back is
one nothing answers with, and the access token minted beside it has no session to match. **The key
names the run too** (FRU-65): the refresh writes the run it read, and that write removes its own key
because its snapshot holds the new epoch. So the refresh token the logout revoked does not stay in
storage.

The upgrade to per-endpoint keys writes from a snapshot too, and the epoch reaches that write as
well: a legacy record predates the marker, so what the upgrade puts back carries no epoch and the
logout minted one. A **pairing** made inside either window is kept (FRU-65): its key names its own
run, and neither the refresh nor the upgrade writes that key. A refresh that the worker refuses ends
only the run it spent, and mints no epoch that would end the pairing.

Neither is readable from a reviewed page. Both stay inside the extension's **trusted contexts** — the
background service worker, which refreshes, and the popup, which pairs and logs out. The side panel
is one more page of the extension, and so one more trusted context: it reads the access token only to
ask `GET /session/notes` for « Whole site » (FRU-307), and sends nothing of it to the tab.
`chrome.storage.session` keeps its default access level, which excludes content scripts, and nothing
about a session travels on the `window.postMessage` bridge. A browser profile is now part of this
boundary: somebody who can read a reviewer's profile can read their refresh token, and revoking it is
the answer.

Pairing asks for a host permission on the **worker's** origin, which is not the site's. It is optional
and granted per worker at the moment somebody pairs, never at install.

**Signing in from the popup** (FRU-251) gives the same session by another door: the extension asks
the worker for a request, the person approves it in the console, and the extension spends a
**claim** for the session. The claim is a secret worth a session of thirty days once approved, so it
is kept in `chrome.storage.session` only, with the access token: never in an address, in a page or in
`chrome.storage.local`, and it goes to the worker in the body of one route. What goes in the address
of the console is the request, which takes nothing by itself. A word shown in the popup and in the
console lets the person check that the tab they approve is their browser's. The address of the
console comes from the worker, and the extension opens it only when it is of the worker's site, over
https (loopback excepted), and the page of that request; any other address opens nothing. A request
lives 30 minutes at most here, whatever the worker says, and the click asks for the same optional
access to the worker's origin as a pairing.

### Connecting the extension from the console (FRU-238)

The extension can also be connected by the person it is for, with no operator and no code to copy:
**the extension asks, the console approves.** It is the pairing above turned around, built on the
same store, and it borrows from RFC 8628 (the device authorization grant). better-auth's plugin for
that grant stays refused (`REFUSED_PLUGINS` of `auth.ts`): it ends in a session of better-auth, and
the extension keeps its own session, which rotates. The pairing by code stays, for the operator of an
instance.

**On Fruitback Cloud the console mints no pairing code any more** (FRU-313). « Connect this browser »
opens `/connect`, a page of the console that says to sign in from the popup: the request above, the
word, and a session of the account, the same as « Sign in to Fruitback » gives. Its condition is the
host of the worker the console calls (`connectsBySignIn`, `api.fruitback.com`). What does not change:

- **A self-hosted console still opens `<worker>/pair#<code>`**, minted by
  `POST /console/workspaces/<id>/connect`. The extension of the store signs in to the Cloud alone, so
  a pairing is the one way it gets a session of another worker.
- **The worker of the Cloud pairs nothing by a code** (FRU-325). If the host of `FRUITBACK_PUBLIC_URL`
  is `api.fruitback.com` (`pairsByCode` of `pair-page.ts`, the host the console reads too), then
  `POST /console/workspaces/<id>/connect`, `GET /pair` and `POST /session/pair` answer `404`, as on
  a worker with no sessions, and the `pair` command of the container prints no code. A code made
  before is not spent there either. test:`spends no code there, even a code that is valid`, and its
  control on a worker of another host. On 2026-10-25 the Cloud kept two codes, both spent on
  2026-10-12, and one live session that a code opened.
- **A session that was paired before stays valid**: the refresh of a paired session is unchanged, on
  the Cloud too, and nothing is revoked. test:`still refreshes a session that was paired before`. Such a session ends as before, when its refresh
  token is revoked, when the person leaves the workspace (`stillOfTheWorkspace`), or when it is
  not refreshed for 30 days. The popup still shows it as « Paired as ».

|             |                                                                                   |
| ----------- | --------------------------------------------------------------------------------- |
| Request id  | 128 bits, public: it is in the address the extension opens in the console         |
| Claim       | 256 bits, secret, kept by the extension alone, never in an address                |
| Word        | one of 64 words and two digits (« PLUM 47 »), shown on both screens, not a secret |
| Lifetime    | a request lives 15 minutes, is answered once and claimed once                     |
| Polling     | a claim asked again within 4 seconds answers `429 slow-down`                      |
| Limits      | 10 requests per address in 15 minutes; 1000 requests waiting on the instance      |
| Wrong words | the request is refused after 5 approvals with a word that is not its own          |
| On disk     | the request id and the claim are stored as **SHA-256 digests**                    |

**What a session of the extension gets this way.** It belongs to the account that approved, and not
to one workspace: it reads every site of every workspace the account is a member of **at the moment
of each request**, with the role the account has there. Its access token carries `scope: 'account'`
and no `ws`, and a client of a workspace accepts it, signed with the worker key, only while the
account is a member of that workspace: the role is read in the database at every read, every note and
every file, as `GET /session/sites` reads it. A member removed or demoted is cut at the next call,
with the access token still unexpired in their extension. It never reads more than a session paired
for the workspace would (test:`lets each role approve, and gives the session what a session of the
workspace gets, and no more`). An account with no workspace gets a session that reads nothing. The
console refuses its token as it refuses every token (FRU-202): it is the cookie of better-auth there.

**Who can start a request: anybody.** `POST /session/connect` takes no credential, like the pairing.
A page of a site cannot start one from a browser: its `Origin` is refused, and only an extension or a
caller with no `Origin` is answered. A caller outside a browser writes the `Origin` it likes, so that
check says nothing of an attacker, and the limits above are what bound a flood.

**What a person who guesses or reads a request id gets: nothing to claim.** The id is in the address
of the console, so it can leak with a history, a screen share or a log. It opens no session: only the
claim does, and the claim never leaves the extension that asked. A signed-in person who holds the id
sees the word and the label of the browser while the request waits, and could approve it **to their
own account**: the extension would then be connected to that account. That is not a theft of the
victim's account, and the claim tells the extension which account it is connected to, for the popup
to name it (FRU-251). Once answered, a request shows
nothing to anybody but the account that answered it. The same person can also **refuse** it, with `/refuse` or five
wrong words: the extension hears `410 connect-refused` and asks again, with a new id. Asking for the
word on a refusal would not stop that: the console shows the word to whoever opens a request that
waits. It costs the person one more request, and nothing of their account.

**Phishing: an attacker starts a request and makes a victim approve it.** This is the attack of this
kind of flow, and what stands against it is the person, helped where the worker can:

- **No approval in one click from a link.** Opening the address only reads the request. Approving is a
  `POST` from the console, with the cookie **and** the `Origin` of the console, that names the word
  the screen showed and the account it showed: a link, a form of another page and an image cannot.
- **The word is on both screens.** The console asks the person to check that the popup of **this**
  browser shows the same word. A person who did not ask has no popup showing a word. The word is
  drawn apart from the request, from no clock: nothing reads one from the other.
- **The console shows the label of the browser that asked.** It is the text the extension sent, cleaned
  of controls and of marks that turn a line around, 60 characters at most. It is the caller's word,
  shown and never trusted: an attacker names the browser they like.
- **The request is short-lived**, and five wrong words refuse it.

What the worker cannot do is tell a person who is fooled from one who is not. A victim who approves an
attacker's request, with the word the attacker read out to them, connects the attacker's extension to
the victim's account, for what that account may read. « My account » lists every such browser, and
ends one.

**Replay, double approval, races.** A request is answered once: of two answers at the same instant,
one statement decides, and the other reads `409`. A claim is spent by one statement, with the session
written in the same transaction; a second claim answers as an expired one. An approval or a claim at
the instant of expiry changes nothing. A refused or expired request never becomes valid again, and an
expired one is deleted at the next request. These hold on two connections, so on two replicas: the
cases run on PostgreSQL 17, and a store that reads apart from the statement that writes fails them
(`connect-postgres.test.ts`).

**A write reads the session again; a read keeps the window of its token.** An access token lives
10 minutes, and nothing reaches a token already minted. So a route that **writes** for an extension
asks the store, at each call, whether the session of the token is still live, still the same person,
still a member of its workspace or still an account (`sessionStillValid` of `session-check.ts`). The
routes that write are a file of a note (FRU-331), the creation of a site of FRU-255, the settings of a
site of FRU-453, and the note itself,
alone or in a batch, when a session of an account signs it: once per request. A session ended a
second ago writes nothing (test:`writes nothing for a session that ended, a note or a picture, with
the access token it still holds, and reads in its window`). That closes the case of a stolen refresh
token: its replay ends the chain, and the access token of the thief no longer signs notes `verified`
in the name of the victim for the rest of its ten minutes. Every access token names its chain for
that (`sid`, a digest, never a token); one minted before names none and is refused, and the extension
refreshes. **A note signed by a session paired for one workspace still takes its token as it is**:
those sessions have tokens minted before `sid`, and refusing their notes for ten minutes after an
update would cost notes. A route that **reads** takes the token as it is too, until it expires: ten
minutes at most, plus the skew. A token signed with the key of a site never carries the claims of a
session of the worker (`account`, `sid`): `verifyForClient` drops them.

**What ends such a session.** Its owner, from « My account » (`DELETE /console/me/browsers/<id>`),
the extension logging out, the deletion of the account, or a replay of a spent refresh token, as for
every session. **« Sign out everywhere » and the sign-out of one browser of the console do not**: they
end sessions of the console, and « The extension stays connected. » is what the console says. The
removal of a member does not end it either: it cuts that workspace off at the next call, and the
session goes on with the others.

**Nothing of it is written in a log.** No route writes the request, the claim or a token, and a test
reads the output of the whole way for them (test:`keeps no request, claim or token in clear in any row,
and writes none of them in the log`). The request id is in the path of `GET /console/connect/<id>`,
so a proxy in front of the worker logs it: it is the public half.

### The console of the Cloud talks to the extension of the same browser (FRU-487)

On Fruitback Cloud, step 3 of the setup connects the extension of the browser it runs in, with one
click and no word: the console sends runtime messages to the extension. Decided by Mathieu on
2026-10-28. What this adds to the flow above, and its conditions:

- **Which pages may talk to the extension: `https://app.fruitback.com`, and no other.** The manifest
  of the Chromium build declares `externally_connectable` with that one origin (`matches:
  ["https://app.fruitback.com/*"]`: the path must be written, the host is exact). Chrome gives
  `chrome.runtime.sendMessage` to that origin only, and to no other site. The value is fixed at build
  (`WXT_FRUITBACK_CONSOLE`, `cloudConsole` of `external-console.ts`): a joker, a path, plain http
  away from loopback, or a host outside the site of the Cloud stops the build. A build for a
  self-hosted instance (`WXT_FRUITBACK_CLOUD` empty) has no such key. The key without `ids` also
  closes the extension to the messages of every other extension. It adds no warning at install and
  no prompt at an update.
- **The background checks the sender and the message again.** `sender.origin` must be that origin,
  the URL of the sender of the same origin, the sender the top frame of a tab (`frameId` 0: a
  console in a frame is refused, and the console sends `frame-ancestors 'none'`). The message is one
  of three, with exactly its keys and version 1: `hello`, `connect`, `claim` with a request id in
  base64url. Anything else is not answered, before any `await`, so the page reads that no extension
  answered. test:`refuses a key more, a key less, another version, another type, and a request that
  is not one`, test:`is refused from another origin, a frame, no tab, another extension, or a build
  with no console`, and the spec `console-extension-here.spec.ts` against the built extension.
- **No secret crosses the channel.** The page names no worker: the extension asks its own Cloud
  (`WXT_FRUITBACK_CLOUD`). `connect` answers the request id only, the public half that the popup
  already puts in the address of `/connect`. The claim and the word stay in the extension
  (`storage.session`). The console reads the word from the worker and sends it back with the
  approval, with its cookie and its `Origin`, as `/connect` does: the worker is unchanged. The
  session goes to the holder of the claim, so **the proof of possession is the claim**, which never
  leaves the extension. `hello` says whether the extension holds a session of the Cloud, and nothing
  else: no account, no version, no site. test:`starts a request with the Cloud and answers its id:
  the claim and the word stay here`.
- **Why no word.** The word protects against a request that another browser made: the person checks
  that the popup of this browser shows it. Here the request id comes from the extension of this
  browser, through the browser, and the extension accepts it from the console origin only. An
  attacker's request id cannot reach this page: the phishing above needs the person to approve an id
  that the attacker chose, and this path approves only the id that the extension of this browser
  answered.
- **A page cannot swap the account of a browser that is signed in.** `connect` is refused while the
  extension holds a session of the Cloud (`signed-in`); to change accounts, the person signs out in
  the popup first. test:`refuses to start while the browser holds a session of the Cloud`.
- **A page cannot make the extension flood the worker.** `connect` takes the request that waits
  (`startConnect` keeps one at a time), and `claim` calls the worker once per interval of the request
  (5 seconds), for the request that waits only. test:`claims the request that waits, once per
  interval, and keeps the session`.

**What a script on `app.fruitback.com` gets.** This is the cost of the decision: the extension trusts
every page of that origin. A script there (a cross-site scripting bug in the console, or a compromised
host or dependency of the console) already acts as the person in the console, with their cookie. With
this channel it can also connect the extension of that browser **to the account signed in to the
console**, with no word and no click, when the extension holds no session of the Cloud. It cannot read
a claim, an access token or a refresh token: the extension never sends one. It cannot connect the
extension to another account than the one of that cookie, unless it signs in as another account in
that console first. It cannot sign in a browser that is signed in. The extension then reads what that
account may read; « My account » lists the browser and ends it. The defences of the console itself
are what stands here: its Content Security Policy (`script-src 'self'` with hashes, `frame-ancestors
'none'`, `csp.mjs`) and the review of its dependencies.

**Where it does not apply.** Firefox does not implement `externally_connectable`, and Safari is not
measured here (the id of its extension is not the one of the store): their builds have no such key,
and they keep the flow with the word. A self-hosted console asks no extension: the one of the store
answers the Cloud console alone. The console of the Cloud asks the id of the Chrome Web Store
(`STORE_EXTENSION_ID`), or the ids `/config.js` names (`extensionIds`), which only the operator of
the console writes.

### What the extension relays, and what it refuses to

In team mode (FRU-57) the site embeds its own widget and leaves it dormant. The extension puts a
transport on the page, and the calls it carries are made by the background service worker, which
attaches the session token. **The token never travels on the page bridge**; what travels is the
request and the answer.

That makes the extension something that will make a call for a page, so the background refuses more
than it accepts. It sends nothing unless all of the following are true:

|              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The origin   | comes from the sender the browser reports, never from the message                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The site     | has an entry the reviewer stored for that exact origin, switched on, in team mode                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The endpoint | is the one that entry names — a page asking for another worker is **refused, not redirected**                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The path     | is `/feedback`, `/feedback/<id>/replies` (FRU-257), `/feedback/<id>/check` (FRU-300) or `/feedback/<id>/text` (FRU-475) under one note, or `POST /attachments` (FRU-332): the paths the widget calls; any other path of writing, `/feedback/<id>/stage` included, is refused (test:`refuses a path that is not the one the widget calls`). A body in base64, a file of 10 MB at most, goes to `POST /attachments` only, and nothing else goes there (test:`refuses base64 to another path, text to /attachments, and a read of /attachments`) |
| The headers  | are rebuilt: `Content-Type` may come from the page, `Authorization` never does                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The session  | is open for that endpoint — with no session there is no call at all                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The scheme   | is `https`, or loopback. A bearer token does not cross a plain `http://` connection                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The endpoint check is the one that matters. A reviewer holds a session per worker, so a page allowed
to name its own endpoint could ask for a call to a _different_ worker that reviewer has paired with,
and be answered with their credential for it. Binding the endpoint to the stored entry for that
origin is what closes it, and it is why team mode still needs an entry in the popup.

**Pairing, refreshing and revoking are refused on an insecure endpoint too**, and that is the larger
of the two: a pairing code is spent for a refresh token worth thirty days, and every renewal spends
that token again. The rule lives in the session layer rather than in the screen that warns about it,
so a session stored before the rule existed cannot keep leaking one either. `http://localhost` is
excepted, because it is the development loop and is not on a wire. The private mode's mount is
deliberately **not** held to this rule — it carries no credential at all, and an http staging worker
that works today has nothing to leak.

Refusing when there is no session is deliberate, not an oversight. Relaying without the header would
work on a worker left at `read: 'public'` — the pins would appear, and nothing would tell the
reviewer they are unpaired while the mode delivered none of what it promises.

**A page can ask for a relay, and that is by design**: it is the site's own widget doing the asking,
and the two are indistinguishable from the main world. What a page gains is a call it could already
make, against a worker its reviewer chose, with a credential it never sees.

**A relayed read tells the page one thing about the session: that there is one** (FRU-112). In team
mode the page reads what the worker answers, and `GET /feedback` answers `identified: true` to a
reader whose token it verified, so the composer asks for no name that the worker would replace. It is
one bit, present only when the read carried a valid token, and never in the cached answer. A page
could already tell: under `read: 'authenticated'` the notes come back only to such a reader. Under
`read: 'public'` it is new to the page that its reviewer is paired with this worker. **The answer
does not say who**: no name, no address, no account id. The page learns the name of a reviewer when
that reviewer signs a note with it, and not before. test:`tells a reader it would sign that it is
identified, and tells nobody who (FRU-112)` holds the worker's half, and
test:`names nothing of who the session is in code the page can read` holds the extension's.

**« All pages » of the widget the extension mounts reads the whole site, and the page can read
that answer** (FRU-470). In team mode with the widget mounted by the extension, the list of the
widget asks the background for one page of `GET /session/notes` (FRU-306), the read the side panel
makes for « Whole site ». The widget lives in the page's world, so a script of the site can post the
same request and read the answer. What it gets is what the side panel shows the reviewer for that
site: for each note an excerpt of 64 characters at most (cut by the worker's index, and cut again by the
background before it reaches the page: test:`gives the page an excerpt of 64 code points at most, whatever the worker sent (review of #645)`), its page, its stage, the name of its author
and its date, never its text, a reply, the link to the tracker or a token. This is new to the page in
one way: it learns which pages of its own site have notes, where `GET /feedback` answers one page it
names. **The condition**: the background reads only for the origin the browser reports, for the
entry the reviewer stored for that origin, switched on, in team mode and mounted by the extension,
for the site id of that entry, on its `https` or loopback endpoint, with the reviewer's session. The
page names the words of a search and a cursor, nothing else; any other field is dropped by the parse
(test:`reads nothing for a sender with no origin, no entry, an entry off, private, not mounted, or on http`,
test:`carries the words and the cursor of the page, and nothing else`).

**The first administrator signs in by a link that the worker writes, with no e-mail and no
provider** (FRU-221). An instance that sends no e-mail and has no GitHub or Google sign-in could make
no account at all. With `FRUITBACK_FIRST_ADMIN=<address>`, a worker whose instance has no owner yet
writes a sign-in link for that address in its log when it starts; `node server.mjs admin-link --email
<address>` writes one on the terminal instead. It is the link of the e-mail, made by better-auth and
kept as a digest. **Nothing proves that the person who opens it holds that address: the operator
names it.** What bounds this way in:

- **Whoever reads the link in its ten minutes signs in as that address, and on an instance with no
  owner makes its first workspace and owns it.** The link is in the log of the container in the
  clear, or on a terminal, and a log that is shipped elsewhere keeps the line after the link is
  dead. Ten minutes (`ADMIN_LINK_TTL_SECONDS`), where the link of an e-mail lives fifteen; spent
  once; and when it is spent the worker writes who signed in, so an operator who did not open it
  reads that somebody did: test:`is refused after ten minutes, where the link of an e-mail lives
  fifteen`, test:`is spent once: the same link opened again is refused`.
- **No request makes one.** Only the start of the worker and the command call the function that
  does: test:`whatever the path, the method and the body, on a worker that names a first
  administrator` sends every path the routes spell, and reads that no mark of a link was written.
- **The log writes one only while no workspace has an owner**, and a link kept from before is
  refused once one has, however that owner signed in: test:`writes nothing once a workspace has an
  owner: the variable left in the environment opens nothing`, test:`is refused once somebody else owns
  a workspace, however they signed in`. A link that was refused stays refused.
- **One link at a time.** Two replicas that start together write one link (test:`is one link when
  two replicas start together, and the other one says that it was written`), and a new link ends the
  one before (test:`cancels the link before with each new one, whoever asked for each`).
- **The command makes a link for an instance with no owner, or for an owner who lost their
  session, and for nobody else**: no second owner, and no admin or member made one
  (test:`refuses every other address once there is an owner: no second owner, and nobody
  promoted`). It ends no session (test:`gives an owner who lost their session a link, and ends no
  session that is open`). It needs a shell in the container, which already reads the database. Each
  link it makes leaves a line in the log of the worker: the address and the time, and never the link.
- **The token is on one line, and nowhere else.** It is after the `#` of the link, which a browser
  sends to no server: no access log, no proxy and no error line of the worker holds it, and the
  database holds a digest (test:`writes its token on one line of the log, and nothing else of the
  worker ever writes it`).
- **The secret of the sign-in is asked for, and never made by the worker**: with
  `FRUITBACK_FIRST_ADMIN` and no `FRUITBACK_AUTH_SECRET`, the worker refuses to start.

Empty the variable once the first workspace is made. Left in place it opens nothing while a
workspace has an owner; on an instance whose last owner left, it would write a link again.

**Who may create an account is `FRUITBACK_SIGN_UP`, and its default is `invited`** (FRU-278). A
sign-in by a person who has an account works as before, with either value. With `invited`, a sign-in
that would create an account is refused, except in three cases:

- **the address has an invitation that waits**: one that a workspace made, that nobody cancelled, and
  that did not end;
- **the instance has no account at all**: the first account is the one of its administrator;
- **the sign-in spends the link of `FRUITBACK_FIRST_ADMIN` or of `admin-link`**, which the operator
  made for that address.

With `anyone`, every person who signs in gets an account, as before FRU-278. The Fruitback Cloud runs
with `anyone`. **One place decides**: the hook of better-auth that runs before it writes a row of
`user` (`databaseHooks.user.create.before`). The link of the e-mail, GitHub, Google and every route of
better-auth create an account through that hook, and it throws: no row is written, and the console
says to ask for an invitation. test:`refuses to create the account of a person nobody invited, on an
instance with no variable` drives each way, and test:`has a case for every way to sign in that the
worker serves` fails on a provider that has no case. test:`writes a row of user only through
better-auth, whose hook decides` fails on a file of the worker that writes a row of `user` by another
way. The three cases are test:`creates the first account of an instance that has none, by every way`,
test:`creates the account of an address that a workspace invited, by every way` and
test:`creates the account of the first administrator by the link of the operator, though other
accounts exist`. An invitation that ended or was cancelled opens nothing: test:`refuses an address
whose invitation ended, or was cancelled`.

What it does not hold:

- **Two people who sign in to an empty instance at the same moment can both get an account.** The
  hook counts the accounts before better-auth writes the row, and nothing locks the table between
  the two. Whoever runs a new instance signs in first, before its address is given to anybody.
- **The link of the operator is told to the hook in the process**, never in the request: a request
  cannot claim to be that link.
- **An invitation is for an address, and the sign-in proves that address**: a link of the e-mail, or a
  provider that verified it. Whoever reads the mailbox of an invited address can create its account,
  as they could accept the invitation.

**`FRUITBACK_FIRST_REVIEWER` wrote a pairing code in the log** (FRU-108), on a worker with no
workspace. FRU-225 refused it, and FRU-226 removed its code: the worker refuses the variable with what
to do, and writes no code. The first administrator is `FRUITBACK_FIRST_ADMIN`, above, and a reviewer
pairs from the console.

**`FRUITBACK_SESSION_PATH` was a credentials file**, until FRU-225 refused it. A file of before
holds what follows, until it is deleted. Give it the same care as a key: a copy of it is
not a set of working logins, but it is a list of who holds a session and until when. Back it up with
`sqlite3 … ".backup"` rather than `cp`, which loses the write-ahead log. With
`FRUITBACK_DATABASE_URL` there is no such file: the sessions are two tables of that database
(FRU-142), and the same care goes to the database and to each dump of it.

**An extension origin is exempt from `ALLOWED_ORIGINS`, on every route.** The id in
`chrome-extension://<id>` changes between an unpacked build and a store build, so no operator can
write it down. The three `/session/` routes needed that first; since FRU-57 the relay calls
`/feedback` from the extension's own service worker, which sends the same origin, so the exemption
is by **scheme** — `chrome-extension:`, `moz-extension:`, `safari-web-extension:` — and by nothing
else. Every other origin, including one that merely looks like those, still answers to the list.

It grants an extension exactly what `curl` already has, and the section above says why that is not
much: these routes carry no ambient authority, there is no cookie to ride on, and CORS was never
what decides who may read a pin. Under `read: 'authenticated'` the token still is. What stops the
pairing endpoint being guessed at is the rate limiter.

Revoking ends the session on the worker. It **cannot** reach an access token already minted, and the
window is the token's lifetime **plus the clock skew the verifier allows** — 10 minutes and 60
seconds, so about eleven. Stated as the sum rather than as the nominal lifetime, because the
difference is exactly the part an operator would be surprised by.

### The widget is inside somebody else's page

A Shadow root isolates **styles**, in both directions. It is not a security boundary: in tag mode the
widget is code the client site chose to load, running in that site's realm, and the site can reach
it. What the Shadow root buys is that our stylesheet cannot reshape their page and theirs cannot
reshape ours.

A comment coming back from the tracker is rendered as `textContent`, never as markup — it is text
written by anyone who can comment on the issue, displayed inside a client's page.

The widget bundles no rasteriser. If you supply `captureScreenshot`, the image lands in **your**
storage and the note holds a URL; whether that URL is public is your decision, not the widget's. The
files that a note carries through the worker are another path: see _The files of a note, in transit_.

### The identity verifier is hand-written

`apps/worker/src/identity.ts` verifies a compact JWS itself, so a client site can mint one with
whatever library it already has. That interoperability is exactly what makes the header an attack
surface, so:

- `HS256` is **asserted against** the token, never read from it. A verifier that trusts the token's
  own `alg` accepts `none` and validates everything.
- `exp` is required. A token that never expires is a password.
- The signature is compared in constant time; `===` on the base64 leaks how much of it was right.
- A token over 4 KiB is refused before it is parsed, and clock skew is capped at 60 seconds.

It is a small amount of cryptography and it is reviewed as such. If you find a flaw in it, that is
squarely a vulnerability and we want to hear about it.

### With accounts, the worker key opened the console (FRU-203)

`FRUITBACK_IDENTITY_SECRET` signs the access token of every session of an extension. Until FRU-150
the routes of the console took a token signed with it too, with the id of an account in `sub`, for
a console session of that account: whoever held the key signed one for any account, with no
sign-in. **That is closed.** A console session is the cookie of better-auth, which this key does
not sign, and no route of the console reads a token:
test:`takes no token that the holder of the worker key signed: a console session is the cookie (FRU-150)`.

**The key still signs the token of an extension, so no site holds it on a worker with accounts.**
With accounts no site needs it: a site is a row the console wrote, and it signs nothing. A worker
that served one site with this key, and then got accounts, must change it. The steps are in
[docs/self-hosting/backup.md](docs/self-hosting/backup.md#change-fruitback_identity_secret).

### The index of the notes, and who reads it (FRU-237)

A worker with accounts keeps an index of the notes of its sites: `docs/privacy.md` names each
column. **It holds at most 64 characters of the text of a note**, in one column, and no name or
address a reporter typed: a test leaves a long note, one with composed emoji, one with line breaks
and runs of spaces, and an empty one, and reads every column of every row for 65 characters of each
text, as it was typed and as the excerpt normalises it. A note of 64 characters or fewer is there
whole.

- **The counts of a site are read by every member of its workspace**, as the list of the sites is:
  owner, admin, member and guest (`read-feedback`). **What did not arrive** (`undelivered`) is about
  the tracker, and only a role with `see-tracker` gets it: a guest does not. A person of another
  workspace gets `404`, a caller with no session `401`, and the token of an extension `401` on the
  console's routes (FRU-202).
- **The extension gets the counts of the sites of its workspace** in `GET /session/sites`, with the
  session of a member, and not what did not arrive. It gets, for the session of an account, how many
  notes of that account are done and not confirmed (`toCheck`, FRU-295), and nobody else's.
- **A guest reads the counts of the sites shared with them, and of no other** (FRU-250): the list
  of the sites is narrowed first, in the console and in `GET /session/sites`, and the counts with it.
  test:`lets the guest read every site in GET /console/workspaces/<id>/sites without its filter`.
- **An anonymous reader of a public page writes to the index**: a read that asks the store writes
  the stages it got, at most once for each answer of the read cache. It writes only what the store
  answered for the site of that read, and nothing the reader sent.
- **The index never costs a note**: a note whose row is not written is kept and answered `201`. Its
  row is written by a later read of its page that asks the store, if one comes and the store lists
  the note.
- **`forget` removes the rows of the notes it deletes, before and after it deletes them**, and
  `forget --note <id>` the row of a note that went to a tracker, whatever the store. **The account
  of a member leaves the index with the account** (`ON DELETE SET NULL`).

### The list of the notes of a workspace (FRU-244)

`GET /console/workspaces/<id>/notes` answers the rows of the index above, a page at a time: **an
excerpt of 64 characters at most, never the text of a note**, and a search on what the index keeps
only (the excerpt, the page, the origin of the site, the stage, and the reference for a role with
`see-tracker`). **A guest's search does not read the references**: trying words would otherwise
tell it which note carries which reference (raised by the heavy review of #306; test in
`gives a guest the notes, and nothing of where they went`).

- **Every member of the workspace reads the list** (`read-feedback`), a guest included, **a guest
  on the sites shared with them only** (FRU-250): the list, its counts and its search are of those
  sites, whatever `site` the query names. **Where a note went is read with `see-tracker` only**: the place and the
  connector, the reference and its link in the tracker, the delivery that did not arrive, and the
  counts by place. A guest gets none of it, and a `place` filter is `403` to it. A person of another
  workspace gets `404`, a caller with no session `401`, and the token of an extension `401`.
- **The name of an author is the name its account has now, for a member of the workspace only**;
  a member who left is shown with no name. A name a reporter typed is not in the index, so it is
  not in the list.
- **« Send again » is `manage-sites`**, and reaches only a delivery of a connector of the workspace
  in the address: the note of another workspace is `404`.

**The extension reads the same rows for one whole site** (FRU-306), for the scope « Whole site » of
its side panel: `GET /session/notes?site=<id>&stage=&q=&cursor=&limit=`, the same query of the index
with the same restrictions, and less. What it reads and what it does not:

- **The rows of the index only**: the id the widget gave the note, its excerpt of 64 characters at
  most, its page, its stage, its author as the console names it, its date. **Never the text of a
  note, never its replies, never the selector or the component**: the panel opens the page of the
  note, and the widget reads the note there with `GET /feedback` and its own rules. No place, no
  channel, no delivery, no counts by place, for any role. No `mine` and no `place` filter: the
  route reads `site`, `stage`, `q`, `cursor` and `limit`, and ignores any other field.
- **The session is read again in the store at each call** (`sessionWrites`, as the routes that
  write): a session that ended or was disconnected in « My account », a suspended account, and a
  pairing of a workspace whose person is no longer a member get `401`, whatever their access token
  still says (test:`answers 401 to the cookie of the console, to no token, and to a session that ended`,
  test:`answers 401 to a member who left, whose token is still in date`). The cookie of the console
  is not read here: `401`.
- **The site is one the person reads now**: any site of a workspace the account is a member of, or
  of the workspace of a pairing; for a guest, a site shared with them (FRU-250). Any other site, and
  every site of a suspended workspace (FRU-282), answers `404`, as a site that does not exist
  (test:`gives a guest the site shared with them, and answers 404 for the site that is not`,
  test:`answers 404 to a person of another workspace, and to a site of a suspended workspace`).
- **The reference and its link are read with `see-tracker` only, and a guest's search does not
  read them** (test:`gives a guest nothing of where the notes went, and no search on the references`).
- **No cache of its own**: `Cache-Control: no-store`, and the index is the one source; the rate
  limit of every route applies. Each guard above has a test that fails without it.

With `FRUITBACK_DATABASE_URL` the clients of the worker are the sites the console wrote, read from
that database on every request. A site is a client of one workspace, so a session reaches it only through
the `ws` check above. A site read by `members` is `read: 'authenticated'`; one read by `everyone` is
`public`, with the exposure that section describes. **A worker with accounts and no site serves no
client**: an empty map is not the absence of a map, which would answer every page to anybody. The
file holds addresses, names and the id each provider gives a person, no password, and no token of a provider
that signs a person in. Since FRU-121 it also holds the key of each connector, encrypted: see below. `FRUITBACK_CLIENTS` is refused beside it, so one map has one source.

**A visitor with no account leaves a note on a site that everyone reads, and that is the design**
(FRU-224, a decision of 2026-10-13): no session, no token, no cookie. The page sends the id of the
site and the browser sends its `Origin`; the worker refuses an origin that is no site of the worker
(`origin-not-allowed`) and the origin of another site (`origin-not-allowed-for-client`), and keeps
the name the visitor typed as a claim, never as verified. `visitor.test.ts` holds that path on a
worker whose site was made in the console, with the notes in PostgreSQL:
test:`leaves a note and reads it again, with no session, no token and no cookie`,
test:`refuses a note and a read that name the site from the page of another site`,
test:`keeps the name the visitor typed, and never says the worker verified it`. In a browser,
`e2e/visitor.spec.ts` adds what CORS does: test:`a page of another origin reads no note of the site,
and plants none`. As above, `Origin` binds a claim to a site and authenticates nobody: a request
that is not from a browser sends the one it wants, or none.

**The visibility of a site decides who reads it; on a site that its members read, « Who can leave a
note » decides who writes on it** (FRU-330, the decision of Mathieu of 2026-10-20 on FRU-286). On a
site read by `members`, a read with no session answers `401`
(test:`reads no note: the worker asks for a session, and says so`). Such a site has one of two values:

- **« Members only » (`writers: members`), the default of every new site.** A note, a batch of notes
  and a reply from the page answer `401` with no session, with the body of a refused read
  (`identity-required`), and nothing is written
  (test:`refuses a note and a batch sent with no session where its notes are « Members only », with the answer of a refused read`,
  test:`refuses a reply from the page sent with no session where its notes are « Members only »`).
  The session is one that the worker key signed, of somebody who reads the site, read again in the
  store: the relay of the extension carries it
  (test:`takes the note of a member, sent by the relay with their session, where its notes are « Members only »`).
  A token that a site signs is no session, and is refused for a write where a read takes it
  (test:`takes no token that a site signs as a session, and sees it taken when the check is out`).
  The refusal of a read says `canWrite: false`, so the widget offers no note that would be refused:
  one bit, which a page could learn from a `POST` anyway. `POST /attachments`, which replaced
  `POST /screenshot` (FRU-331), asks for a session of the workspace on every site
  (test:`is refused with no session, whoever may leave a note, and passes the guard for a member`).
- **« Anyone on the page » (`writers: anyone`): a note sent with no session is kept there**, as a
  claim, as on every site that everyone reads: its sender cannot read it back, and the members find
  it, in the worker or in the tracker of the site
  (test:`still takes a note sent with no session, which its sender cannot read back, where anyone on the page leaves one`).
  The migration `0021` gave this value to every site made before FRU-330, which is what the worker
  did for them then (test:`gives « anyone » to every site of before, and « members » to a site made after`).

The field decides nothing on a site that everyone reads: it takes a note from anybody
(test:`leaves a note: the field decides nothing on a site that everyone reads`). A console that does
not send the field changes no site: a site that is added again keeps the value it had.

**With `FRUITBACK_DATABASE_URL` the same accounts are in a PostgreSQL database** (FRU-141), in place
of that file, and the worker refuses to start with both. The database holds what the file holds:
addresses, names, the id each provider gives a person,
the roles, the sites, the digest of each sign-in link, the key of each connector encrypted with
`FRUITBACK_SECRETS_KEY`, and the notes that wait for an address that receives them.

**That database can be one that another application uses, with the worker in a schema of its own**
(`FRUITBACK_DATABASE_SCHEMA`, FRU-219). The worker writes in that schema and nowhere else, and sets
the search path of each of its connections to it alone, whatever the address, the role and the
database say (test:`gives every connection of a pool its schema, whatever the role and the database
say`). **A schema is a place for names, not a wall.** What the role of the worker may read in the
rest of the database is what PostgreSQL grants it: every role has `USAGE` on `public` by default,
and reads what was granted to `PUBLIC`. The worker names no other schema, but whoever holds
`FRUITBACK_DATABASE_URL` can, and so can the other application for the schema of the worker if its
role owns the database or is a superuser. Two applications in one database trust the one who runs
it, and each other as far as their grants say. A role that has its schema and nothing else is
enough for the worker (test:`is enough: no right on public, none on the database, and the worker
signs a person in`), and that test reads that such a role is refused a table of `public` once
`USAGE` on `public` is taken from `PUBLIC`. **The worker says it in its log while its role may use
`public`** (FRU-266), and starts all the same: test:`is said once in the log, and not refused;
nothing is said once it may not, nor for a worker in public`.

**Since FRU-146 the people, their ways to sign in, the workspaces and their members are in four
tables of better-auth**, `user`, `account`, `organization` and `member`, under the ids they had. The
worker's own sign-in code writes them, and better-auth does not run for it. The `account` table has
columns for the tokens of a provider and for a password: **the worker gives them no value**, for a
row it moved and for a row it writes. test:`writes each row as better-auth expects it, and no token
of a provider` reads those columns after the move, and test:`writes a new sign-in and a new
workspace as it writes a moved one` names every column of a new row that holds a value. A role is
one of four words: a value of `member.role` that is anything else, `guest,admin` included, gives no
right (test:`reads a role that is not one of the four as no role, « guest,admin » too`).

**Since FRU-142 that database holds the sessions too**, in place of `FRUITBACK_SESSION_PATH`, which
the worker then refuses. It holds what the file held, in tables of the same names: for each pairing
code and each refresh token its SHA-256 digest, the subject, the name and the address its pairing
gave, its workspace, and its dates. No code and no token is in a row:
test:`holds no code and no token in clear, in any row of any table` reads every table of the schema.
The rules of a session are the same, and they hold between two connections: one code opens one
session, and one token has one live successor.

Since FRU-144 it also has the seven tables of better-auth. Four hold the accounts, as said above; the
other three hold the sessions of the console and the links (FRU-147), and the invitations (FRU-104). See [better-auth, what it keeps and what it refuses](#better-auth-what-it-keeps-and-what-it-refuses-fru-144).

Three things change with a database on a network, and each has its condition:

- **The address holds the password of the database.** No diagnostic of the worker quotes it: a value
  that is refused is named by its variable, and the message of a database that does not answer has
  the address and the password taken out. This holds for what the worker writes. A log of the
  platform that prints the environment of the container prints it.
- **The worker does not encrypt the connection by itself.** It is encrypted when the address asks for
  it (`?sslmode=require`), and what the address asks is the choice of the operator. On the private
  network of one host, between two containers, it is in the clear.
- **Whoever can connect to the database reads every account, and can write a site or a role.** The
  file was reachable by whoever reads the volume. The database is reachable by whoever has its
  address and its password, from wherever its port is open. Do not publish that port.
- **Whoever can write to the database can write a session.** A row with the digest of a token they
  chose is a session of the subject and the workspace they wrote, as it was for whoever could write
  the session file. Reading is not enough: a digest is not a token.

A copy of the database is a copy of the file: no working login and no working key of a tracker,
while `FRUITBACK_SECRETS_KEY` is not with it.

**The backup of the Cloud is such a copy** (FRU-143): `snapshot-pg.sh` writes a dump of the database
each night into the volume of the worker, which the host archives with every other volume. The dump
holds what the database holds, and no secret of the worker: `FRUITBACK_SECRETS_KEY`,
`FRUITBACK_IDENTITY_SECRET` and `FRUITBACK_AUTH_SECRET` are in no backup. It holds no password
either: `pg_dump` writes one database, and the roles are not in it. A dump that failed is removed,
where it was written and in the volume: it is not left beside the good one.

**The volume of the database is in the archive too, and it holds the verifier of the password**
(SCRAM, the role `fruitback`). Whoever reads the archive can try passwords against it offline, as
long as they like. That is useless against a long random password, and only that: the condition of
this paragraph is a password of 32 random characters or more, which is what the runbook asks for.

**`GET /session/sites` lists the sites of the workspace a session belongs to** (FRU-101), to the
holder of its access token, while that person is still a member: the extension turns such a site on in
one click. It answers an origin, an id and a visibility per site, and the language of the account
(FRU-131), and nothing a member cannot already read in the console. The extension sends that language
to a page where it mounts the widget: it is a locale tag, and the page can read it. The cookie of the console is not read here, and gets `401`. The entry the extension
stores is team mode, so the relay's refusals all apply: the widget it mounts calls through the relay,
and the page never holds the token.

**This is the authenticated `GET` that counts by site** (the decision of 2026-10-06 of FRU-58): the
counts of FRU-237, and two fields of FRU-295.

- **`destination: { label }`, where the notes of a site go** (« Linear · Northwind », or « Fruitback »
  for a site that keeps them in the worker), **to a role with `see-tracker` only**: owner, admin,
  member. A guest gets no field, as for the places of `GET /feedback` (FRU-123).
  test:`names the destination to a role that sees the tracker, and not to a guest`, whose control is
  the owner on the same site.
- **`toCheck`, the notes of the person that the team marked done and that they did not confirm**
  (FRU-294), to the session of an account only: it counts the rows of the index whose author is that
  account. **Only notes where a verdict can be given count**: a site whose store takes none (an
  address that receives, a tracker that hides its replies, GitHub) counts zero, since nobody could
  lower that count. A pairing of a workspace gets no field, and nor does a session whose index does
  not answer: absent is « not known », never zero. The count is as the last read of each page left it:
  `asOf` says how late. test:`counts the done notes of the person, not those of another member, and drops by one after « Looks fixed »`.

**`POST /session/sites` adds a site to a workspace, from the extension** (FRU-255): the first route
where the token of an extension writes. It takes the access token of a session of an **account**
(FRU-238), never of a pairing (`403 account-required`); an `Origin` of an extension, or none
(`403 origin-not-allowed` for a page); a workspace where the account holds `manage-sites` (owner,
admin), read at this call: a member and a guest get `403`, an account outside the workspace `404`,
as the console answers. The site is always of **members**, whatever the body says; `visibility` and
`previews` are not read, so no preview is covered without the proof of FRU-103. An origin over https
or on the loopback only. A site already in that workspace is given back as it is: its visibility is
not touched. **Ten sites an hour per account**, counted before anything is written. Each of these
guards, taken out, fails a test of `session-site-add.test.ts`.
**The session is read again in the store at each add** (`sessionStillValid`, decided on 2026-10-14): a
session logged out, a browser disconnected in « My account », or an account that is gone adds nothing
with the access token it still holds, and a token that names no session (no `sid`) adds nothing:
test:`adds no site after a log out: the write reads the session again`,
test:`adds no site once the browser is disconnected in the console`. The role is read at each call
too: test:`reads the role at each call: a person removed between two calls adds nothing more`.

**`POST /session/sites/settings` changes who sees the notes of a site and where they go, from the
extension; `GET /session/sites/places` reads what a source offers for it** (FRU-453): the popup
offers both on the screen that turns a site on, a provider, then a team (a repository for GitHub),
then a project. They ask what the add asks: a session of an **account**, read again in the store
(test:`changes nothing after a log out: the write reads the session again`); an `Origin` of an
extension, or none; `manage-sites` in the workspace named, read at this call (a member and a guest get
`403`, an account outside the workspace `404`, a site of another workspace `404`). **It can make the
notes of a site readable by everyone who visits it**, as « Anyone on the page » does in the console,
for the same roles: an owner or an admin of the workspace. **A place is checked as the console checks
it**: a connector of the workspace (one of another workspace is `400`, and `404` for the read), a team
or a repository its key reaches, the label the tracker answers and never the words of the body. **The
keys of the connectors are opened in the worker and never leave it**: the popup gets ids and names. A
tracker that does not answer is `502`, and nothing is written. A site with two places or more is not
emptied from here (`409`). Each of these guards, taken out, fails a test of
`session-site-settings.test.ts`. `GET /session/sites` lists the sources of a workspace (`sources`: an
id, a kind, a name) and where each site sends (`place`: ids) to a role of `manage-sites` only, which
already reads them in the console.

### Signing in to the console (FRU-98)

The console signs in with better-auth, and with nothing else (FRU-150): the section below. The
routes of before (`POST /auth/email`, `/auth/email/redeem`, `/auth/github`, `/auth/google`,
`/console/session/refresh`, `/console/session/logout`) answer `404`:
test:`says which ways the routes of better-auth offer, and no boolean of the path of before`. The
console API reads no `Authorization` header:
test:`refuses GET /console/me to the token of an extension`. What they held is gone with them: the access token the console kept in memory, and the
refresh token that rotated in a cookie. The table `email_links` of the links of before stays in the
database, and nothing reads or writes it.

### Signing in to the console with better-auth (FRU-147)

With `FRUITBACK_AUTH_SECRET` the worker signs the console in with better-auth, under
`/console/auth/`. Without it nobody signs in. **A session of the console is one token that does not
rotate**, and that is a step back from the sign-in of before, whose refresh token rotated, written
and accepted (FRU-139, point 3 of 2026-10-11):

- **It lasts 7 days, and each day it is used moves its end by 7 days.** It is a cookie that no
  script reads: `__Secure-fruitback.session_token`, `HttpOnly`, `Secure`, `SameSite=Strict`,
  `Path=/console`. **It never rotates, so a stolen cookie is good until it ends or is ended, and
  nothing detects the theft**: there is no second token to replay. The session of an extension
  still rotates, and a replay ends its chain.
- **The cookie is renewed with the session** (FRU-208). When a call of the console renews the
  session, the worker sets the cookie again on its answer, with the same token and attributes and
  7 days more. Until then the row lived on and the cookie of the browser ended 7 days after the
  sign-in, whatever the person did. Only the cookie of the session leaves by this way, only for a
  session that is there, and not for the session that the call itself ends.
  test:`renews the cookie with the session, on each route that reads the cookie, and on no other call`,
  test:`hands the browser the cookie of the session and no other header of a reading`.
- **It is read in the database at each call**, with no cache. A session that is ended, by « sign
  out », by « sign out everywhere » (`/console/auth/revoke-sessions`) or by its id
  (`DELETE /console/sessions/<id>`), is refused at the next call, and so is a member who was removed
  from a workspace: the role is read at each call too. test:`refuses a member who was removed at the
  next call, and a session that was ended`. A session is named by its id, never by its token: the
  list of `GET /console/sessions` holds no token.
- **The link of the e-mail keeps its token after the `#`.** `POST /console/auth/email` sends
  `<console>/sign-in#<token>`, and `POST /console/auth/email/redeem` takes the token in its body. The
  routes of better-auth that carry it in an address (`/sign-in/magic-link`, `/magic-link/verify`) are
  closed to a request: test:`opens a session with a link asked for, then spent, and the token reaches
  the worker in no address`. A link works once, for 15 minutes, and two calls at the same moment open
  one session (test:`opens one session for a link spent twice, or by two calls at the same moment`).
  It answers the same with or without an account, and is limited to 3 links per address per
  15 minutes, on top of the limit per IP of every route. The redeem hands the browser the cookie, and not the answer of
  better-auth, which holds the token of the session. **It answers the console only**, and not a
  request with no `Origin`: another page that spent a link of its own in this browser would sign the
  person in to its account (test:`spends a link for the console only, and not for a request with no
  Origin`).
- **A tab that waited for the link goes on by itself, on the answer of the worker and never on the
  word of another tab** (FRU-235). The tab that opened the link tells the other tabs of the console,
  on a `BroadcastChannel` of its origin, that the browser is signed in. The message is one word: it
  carries no token, no account and no address. A tab that hears it asks `GET /console/me` with the
  cookie, and goes on only if the worker answers a session: `e2e/console-sign-in.spec.ts` has a page
  of the console say the word while nobody is signed in, and the tab that waits does not move.
  **What this does not hold**: a script that runs in the origin of the console can say the word, as
  it can do everything else there; all it gets is one question to the worker.
- **The database keeps the link as a digest of a digest of a digest**, and a copy of the row opens
  nothing: test:`keeps the link as a digest of a digest, which opens nothing when a copy presents
  it`. The value of the row is the address it was sent to.
- **A call with the cookie that changes something must come from the console.** `SameSite=Strict`
  does not keep out a page of the same site, and `demo.fruitback.com` is one. The routes under
  `/console/` refuse a request with the cookie from another origin (`403`), and a request with the
  cookie and no `Origin` that is not a read (`403 origin-not-allowed`): test:`refuses a change with
  the cookie from another origin, or from none, and takes it from the console`. **The routes of
  better-auth are under the same rule, applied by the worker before better-auth reads the request**
  (FRU-212): a call that is not a read answers `403 origin-not-allowed` unless its `Origin` is the
  console. better-auth 1.7.7 alone takes a `Referer` in place of an `Origin` that is missing, and
  checks nothing when the request has no cookie. No route is excepted: GitHub and Google come
  back by a `GET`, and a provider that comes back by a form would need its route named.
  test:`lists every served route that is not only read` names those routes, and one case for each
  refuses it with no `Origin`, with the `Referer` of the console, and with the `Referer` of the
  worker. No call opens these routes with a token in
  `Authorization` (FRU-150).
- **A tab of the console sends nothing for another account than the one it was drawn for**
  (FRU-210). The cookie is of the browser, so a second person who signs in in another tab changes
  who a tab left open speaks for. The tab asks who is signed in when it is shown again and when
  somebody presses « Continue » after a session ended; on another account it stops, shows nothing
  of the person before but the text they were typing, and sends nothing until it is loaded again.
  **The condition: the browser tells the page that the tab is shown again** (`focus`,
  `visibilitychange`); the worker does not check which account a tab believes it is.
- **« Connect this browser » connects nothing without a press on « Connect »** (FRU-240). The page
  shows the word, the browser and the account that the worker answers for the request, never what
  the address of the page says, and sends the word and the account it showed: the worker refuses an
  answer for another word, or from an account that changed since. A sign-in on that page, by a link
  or a provider, leads back to the question. One answer per press: a second press while the first
  is on its way sends nothing, and a request answered in another tab is read again, not answered
  twice. **The condition: the person compares the word with the popup**; the page cannot know which
  browser opened it. `e2e/console-connect.spec.ts` holds each of these, with planted violations.
- **« Sign out » ends the session, or says that it did not** (FRU-204). The console stays on « My
  account » with « You are still signed in » when the worker did not confirm. The refresh cookie
  of the path of before, which a browser could hold for 30 days, opens nothing since FRU-150: no
  route reads it.
- **The console holds no token** (FRU-148): no access token in its memory, no token in `localStorage`
  or `sessionStorage`, and a cookie that `document.cookie` does not show. `sessionStorage` holds one
  thing, for fifteen minutes at most: the id of a request of the extension, while a sign-in with a
  provider started on « Connect this browser » (FRU-240). That id is public: it is in the address
  the extension opened, and it signs nothing in without a session and a press. A script injected into the
  console can call the worker while the page is open, as before; it has nothing to carry away.
  **With no condition since FRU-150**: the console has one path. Until then a worker that answered
  `GET /auth/providers` with no `betterAuth` was a worker of before, and the console held its
  access token (FRU-205 kept a refusal of that question from being read as one).
- **A sign-in with a provider starts by a navigation** to `GET /console/auth/start/<provider>`, which
  answers a redirect to the provider and the cookie of the state. It changes nothing by itself: the
  person still consents at the provider, and comes back with a state that only this browser holds.
  **A page of another site does not start one** (FRU-211): a navigation that the browser marks
  `Sec-Fetch-Site: cross-site` gets no state and no redirect to the provider, and lands on the
  sign-in screen of the console. Without that, a page anywhere could send somebody who had already
  consented at the provider through a sign-in they did not ask for, and replace the session they
  had with one of their own provider account. **The condition: a browser that sends
  `Sec-Fetch-Site`.** One that sends none is served as before; and a page of the same site as the
  worker is not « another site », as for the cookie above. **The console is of the same site as
  the worker**: a console on another site has no session at all, because the browser does not keep
  a `SameSite=Strict` cookie from the answer of its `fetch` (measured in Chromium, Firefox and
  WebKit: the sign-in answers `200`, no cookie is kept, the next call answers `401`). So this
  refusal takes nothing from a deployment that signs in.
  test:`starts no sign-in for a navigation that a page of another site made (FRU-211)`.
- **Only the routes it names are served.** `SERVED_PATHS` of `auth.ts` lists them: `/ok`,
  `/sign-out`, `/revoke-sessions`, `/sign-in/social`, the two callbacks and `/error`.
  Any other path under `/console/auth/` answers `404` before better-auth reads it. `/get-session`
  is one of those (FRU-206): it answers the token of the session in its body, to any script of the
  console, and the console does not call it. No route answers that token:
  test:`answers no route that hands the token of the session to a script of the console`. The routes of the
  organization plugin have a list of their own, with a rule for each of the four that are open: see
  [What the console may change, and who](#what-the-console-may-change-and-who-fru-99).

### better-auth, what it keeps and what it refuses (FRU-144)

The worker carries better-auth, the library that signs a person in to the console (FRU-147: the
section above). A worker without `FRUITBACK_AUTH_SECRET` loads nothing of the library, and answers
`404` under `/console/auth/`. What exists is its configuration, seven tables in the database of the
accounts, and one secret. Four of them hold the accounts since FRU-146.

- **`FRUITBACK_AUTH_SECRET` signs the cookie of a console session.** It is a secret of the worker's
  own, like `FRUITBACK_IDENTITY_SECRET` and `FRUITBACK_SECRETS_KEY`, and it is not one of those two:
  the worker refuses to start when it equals one of them, and when it is under 32 characters. It
  stays in the environment: nothing writes it in the database, and no route answers it. Changing it
  ends every session better-auth opened.
- **A copy of the database opens nothing, even with `FRUITBACK_AUTH_SECRET` beside it** (FRU-181).
  The secret and the database live on one host, so a copy is assumed to come with the secret. The
  `session` table keeps the SHA-256 of the token of each session, never the token, and the
  `verification` table the SHA-256 of each link or code. The worker digests every value that
  reaches those two columns, in a row it writes and in a lookup, so a digest read in a copy is
  digested again when it is presented and finds nothing.
  test:`keeps the digest of the token of a session, which opens nothing, even signed with the secret`
  signs the row with the secret, sends it with no signature and in an `Authorization` header, and
  its control is the cookie the worker set. Before FRU-181 the table held the token itself, and the
  row and the secret together were a cookie for every open session:
  test:`opened a session with the token of the table and the secret, before the layer` keeps that
  measured. A lookup by digest is a read of the unique index of the column, as before. **The
  condition is the plugin `fruitback-at-rest`** (`auth-at-rest.ts`): it puts this layer between
  better-auth and its database adapter, and the worker refuses to build better-auth without it, or
  with a secondary storage, which would keep each token in the clear around it. No key is added: a
  token of 190 bits cannot be found again from its digest, and a key would leak with the secret.
- **No token of GitHub or Google is kept.** better-auth writes the access token, the refresh token
  and the id token of the provider in the `account` table; the worker writes those columns empty,
  and the password column too.
  test:`keeps no state of a sign-in with a provider, and no token of the provider, in any row`
  signs a person in with GitHub (its answers simulated) and reads every column of the seven tables.
  **So the worker can never act at GitHub or Google in the name of the person who signed in.** If
  the product needs that one day, it is a decision, with a key of its own beside
  `FRUITBACK_AUTH_SECRET` and a rotation, and not `encryptOAuthTokens` of better-auth: its key comes
  from that secret, so a copy and the environment would open every token.
- **The state of a sign-in with a provider is not in the database.** It is in an encrypted cookie of
  the browser that started the sign-in, for 10 minutes. In the database it held the state and the
  PKCE verifier in the clear (measured).
- **A route that names a session by its token is closed.** `/revoke-session` and
  `/revoke-other-sessions` answer `404`, and a call to them in the process throws: a list of
  sessions has no token, so they would end nothing and say that they did.
  test:`throws on a call in the process to a route that names a session by its token, and ends
  nothing` plants each call. `/get-access-token`, `/refresh-token` and `/account-info` are closed the
  same way: there is no token of a provider to answer. Signing out, and « sign out everywhere »
  (`/revoke-sessions`), end the session at the next call:
  test:`ends a session at once on sign-out, and every session of a person with « sign out everywhere »`.
- **What a copy holds in the clear**: the address and the name of each person, the user agent of a
  session, a link that waits (its address and name, not its token), and the id of an invitation. An
  invitation is accepted only by a session of the address it invites.
- **Whoever can write to the database can write a session**, as for the extension: with the secret
  too, a row with the digest of a token they chose, and a cookie of that token they sign.
- **The `bearer` plugin is not in the configuration**: the worker refuses to build better-auth with
  it. It opens a session with its token in an `Authorization` header, which a script can send, where
  the console keeps it in a cookie that no script reads. Without the layer, the row of a copy was
  that token:
  test:`opens no session with the row of the session table, and the bearer plugin opens one with the
  token alone` keeps both measured.
- **The environment cannot widen it.** better-auth reads `BETTER_AUTH_TRUSTED_ORIGINS`,
  `BETTER_AUTH_SECRETS` and `BETTER_AUTH_TELEMETRY` from the environment of the process, over what
  the worker gives it (measured). A worker that has better-auth on refuses to start with any
  `BETTER_AUTH_…` variable, and names it without its value.
- **The cookie is for the routes of the console and for no script**: `HttpOnly`, `Secure`,
  `SameSite=Strict`, `Path=/console`. `demo.fruitback.com` is the same site as the worker, so
  `SameSite` does not keep its pages out. What does is the origin: better-auth answers a request
  that has the cookie only from `FRUITBACK_CONSOLE_URL`, and refuses one from another origin and one
  with no `Origin` (measured). The routes of the worker under `/console/` refuse the same requests
  when they change something (FRU-147, above).
- **By default better-auth counts no request and keeps no address and no user agent.** Its limit is
  off, so the limit of the worker is the only one, with the address `TRUSTED_PROXY_HOPS` decides,
  and a row of `session` holds neither: test:`keeps neither when the switch is off, whatever the
  caller writes`. Left alone, better-auth takes an `X-Forwarded-For` that holds one value as the
  caller wrote it (measured). **With `FRUITBACK_AUTH_TRACK_IP=1`** (decision of 2026-10-11) it keeps
  both and counts by address too, with the address the worker read: the worker writes it in a
  header of its own, over anything the caller sent, and better-auth reads no other one. It counts in
  the table `kv` of the database, as the limit of the worker does (FRU-229, above).
  test:`keeps the address that the worker read, and not one that the caller wrote, when it is on`.
- **No password.** The sign-up with a password is off, and the accounts hold none.
- **The session of the extension does not change.** It is not a session of better-auth, and it keeps
  its rotation and its replay detection. Its table is `sessions`, which holds digests; the table of
  better-auth is `session`, without the `s`.
- **A guest and the tracker.** The four roles reach better-auth from the one table of `accounts.ts`:
  a guest has no `see-tracker` there either. No route of the organization plugin answers a connector
  or a destination: its four open routes answer members, and a guest reads none of them (FRU-149).

### The key of a connector (FRU-121)

A workspace can hand the worker the API key of its Linear, and the notes of the sites that choose it
go there. **This is the first secret of a customer that the Cloud holds.**

- The database keeps the key encrypted (AES-256-GCM) with `FRUITBACK_SECRETS_KEY`, which stays
  in the environment. A copy of the database alone opens nothing; a copy of the database **and** of
  the environment opens every key. A value changed in the database does not decrypt.
- No route answers a key, in the clear or encrypted. The console sends it once, and the worker asks
  Linear who it belongs to before it keeps anything: a refused key is never stored.
- The worker sends the key to Linear on every write and read of a site that chose it. It cannot be a
  digest, unlike a pairing code.
- A personal API key reaches **everything its person reaches in Linear**, not one team. The worker
  uses the team a site chose; the limit is the worker's code, not Linear's. Connecting with OAuth
  (below) takes the place of a personal key where the worker has a Linear application.
- A site writes only through a connector of its own workspace. The store refuses the row, and the
  request checks the workspace again before it opens a key.
- An owner or an admin connects and disconnects. A member sees that a source is connected. A guest
  sees nothing of the tracker: not the connector, not the destination of a site.
- A connector that cannot be used answers `502`, and the widget keeps the note. The note is never
  written to the worker's own store in its place: its team would not see it.
- A `github` connector (FRU-359) keeps no key of the customer: the id of an installation of the App
  of the worker, sealed the same way. « The GitHub App key » above says what the key of the App
  reaches.

### The places a site can send to, and who chooses (FRU-123)

A site can send its notes to several places of its workspace, five at most. An owner or an admin
sets the list in the console, and a note goes to the first place unless a member chose another one.

- **The names of the places are for a person who may see the tracker**: an owner, an admin or a
  member. `GET /feedback` answers them in a `destinations` field only to a session of the workspace
  of the site, and it reads the role of the person at each request. A visitor, a guest, a session of
  another workspace and a token that the site signed get no such field.
- **The field is never in the cached answer.** One entry of the read cache serves everybody who may
  read the page, so the field is added after the cache, for the caller of this request.
- **A place is named by an opaque id.** It is a digest of the site, the connector, the team and the
  project. The ids of the connector and of the team stay in the worker. The label is written by the
  worker from what the tracker answers when an admin sets the list, never from the request. The one
  exception is a repository of GitHub (FRU-359): its label is its name, `owner/name` in lower case,
  which the worker reads strictly from the request. GitHub is asked when a note goes, not here.
- **A member chooses with `POST /feedback?destination=<id>`.** The body stays the note. An id the
  site does not have, and a caller who may not see the tracker, both get `403
  destination-not-allowed`, and nothing is written, in the first place either.
- **What says that a caller is a person of the workspace is the worker key, never a claim.** A site
  signs its own identity tokens and can write a workspace in them. `verifyForClient` marks a token as
  a session only when the worker key verified it.
- **A read asks each place.** The cost of a page that opens is the number of places, which is why the
  list is short. A place that cannot be read answers `502` for the page, like one connector that
  cannot be used.

### A domain a workspace proves it owns, to cover its previews (FRU-103)

A wildcard in team mode lends the reviewer's session to every page it covers, and nothing in a
pattern tells `*.preview.acme.dev` from `*.vercel.app`. The DNS can: only who holds the zone of a
domain writes a record under it. So the worker takes the subdomains of a domain as the previews of a
site only while the workspace of that site proves the domain.

- **The proof is a `TXT` record**, `_fruitback.<domain>`, whose value is a digest of the workspace id
  and the domain (`proofRecord` in `domain-proof.ts`). It is public in the DNS and grants nothing to
  whoever reads it: writing it is the proof. **The record of one workspace proves nothing for
  another**, and the record of `preview.acme.dev` proves nothing for `acme.dev`.
- **A domain under a shared host cannot be proven by its tenants.** A tenant of `vercel.app` writes
  no record under `vercel.app` or under the names of the other tenants. **Limit:** a host that lets a
  tenant write `TXT` records under its own subdomain (`_fruitback.myapp.example-host.com`) lets that
  tenant prove that subdomain, and so cover what is under it, which is its own.
- **Only an owner or an admin** adds a domain, asks the DNS, names the site whose previews it covers
  (`manage-sites`). A site of another workspace and a domain of another workspace answer `404`. A
  domain that is not proven cannot name a site (`409 domain-not-proven`).
- **The proof is asked again** every six hours (`RECHECK_MS`). An answer of the DNS without the record
  ends it at once: `GET /session/sites` stops listing the previews of the site, the console shows the
  domain as lost with the moment, and the log says it once. A DNS that does not answer changes
  nothing, **for 72 hours at most** (`PROOF_GRACE_MS`): after that a proof nobody confirmed is lost
  in the same way, the console says that the DNS did not confirm it, with no moment, and the log says
  it once, at the pass that finds it.
  **Limit:** between two checks, a record that was removed still proves the domain, six hours at most.
- **The worker asks the DNS of its host**, with no DNSSEC check of its own. Who can answer the
  resolver of the worker in place of the zone can prove any domain. Tests never ask a real DNS: the
  resolver is a seam, and every case hands over a double.
- **What a proven domain opens, exactly.** In the browser of a reviewer who is paired with the worker
  and who pressed « Turn on Fruitback here » on a page under the domain, **every page of
  `https://*.<domain>`, and of `https://<domain>` itself, on the default port**, gets the widget
  and a relay that calls that worker with the session of the reviewer. A script of such a page can
  forge relayed calls (see
  [The extension's page bridge can be forged by the page](#the-extensions-page-bridge-can-be-forged-by-the-page)),
  so it reads and writes what that session reads and writes: the notes of **every site of the
  workspace**, not only the one the previews belong to, signed with the name of the reviewer. That
  is what the proof is for: whoever serves a page under the domain holds its zone, or was given a
  name in it by who does. **A workspace that proves a domain vouches for every host under it.**
- **The extension grants a team wildcard only from the answer of the worker of the session**
  (`proven-previews.ts`): the very wildcard, for the very site, of the very worker of the rule,
  `https` only. It is kept beside the rules, never in one. A rule that a person types or imports is
  refused as before, so a rules file cannot carry the grant. **The answer ages**: older than two
  hours it grants nothing, and the background asks again every thirty minutes. So a proof that is
  lost stops in the browser thirty minutes after the worker saw it, at most; with the six hours
  between two checks of the DNS, a record that was removed can lend a session for six and a half
  hours at most. A worker that cannot be reached stops granting after two hours. **The answer is
  for the session that asked**: a logout, and a new pairing with the same worker, each forget it at
  once. The page's own script reads the answer of the workers its rules name and nothing else of
  that storage, where the refresh tokens are.
- **Not covered:** a page in clear (`http`), another port, and a team rule that names no site (a
  site that embeds its own widget): those stay refused.

### Linear, connected with OAuth (FRU-134)

Where the worker has a Linear application (`FRUITBACK_LINEAR_OAUTH`), a workspace connects its Linear
by consent at Linear, and no personal key is typed.

- **The token is the application's** (`actor=app`), with the scopes `read,write`: the worker creates
  issues and labels and reads issues and their comments. It is not narrower than a key inside the
  workspace of Linear. What it changes: no person's key is held, the connection does not stop when
  its person leaves, an admin of Linear revokes it in one place, and the token lasts a day.
- **The Linear of one person must not land in the workspace of another.** The flow starts with a
  ticket that only an owner or an admin gets with their access token, spent once and good for a
  minute. The `state` is bound to the browser that started by a cookie, issued by this worker and
  spent once, with PKCE. The role is asked again when Linear sends the person back.
- The access token and the refresh token are kept like a key: sealed with `FRUITBACK_SECRETS_KEY`,
  and answered by no route. Nothing Linear says is echoed to the console: the way back carries one
  word of ours.
- The refresh token changes at each refresh. One refresh runs at a time for a connector, and the
  new pair is written before it is used. A refresh that Linear refuses answers `502`: the note stays
  in the widget, and the workspace connects Linear again.
- Disconnecting revokes the token at Linear, and removes the connector whatever Linear answers.

### The GitHub App, installed on a workspace (FRU-360)

Where the worker has the App of the connectors (`FRUITBACK_GITHUB_CONNECTOR`), an owner or an admin
of a workspace installs it on GitHub, and GitHub sends the person back to
`/auth/github-app/callback` with an `installation_id`, a `setup_action` and a `code`.

- **The `installation_id` of the way back is what the browser says.** Anybody can write the id of
  another client's installation there. The worker changes the `code` for a user token of the person,
  reads every page of `GET /user/installations` with it, and attaches the id only if it is in that
  list. An id that is not in it attaches nothing, and the worker asks no token of that installation.
  The condition: GitHub lists for a person only the installations that the person can reach.
- **One installation feeds one workspace.** The connector keeps an HMAC of the id, keyed by
  `FRUITBACK_SECRETS_KEY`, in a column with a unique constraint. A second workspace that comes back with
  an installation that another workspace holds gets nothing. The first workspace keeps it until it
  removes its connector. The condition: a member of the organisation on GitHub who reaches the
  installation, and who installs it first in their own workspace, holds it. The owners of the
  organisation see the App and its repositories in their settings, and can remove it.
- **The user token is used for this check only.** The worker sends it to `GET /user/installations`
  and to no other route, keeps it nowhere, writes it in no log, and does not keep the refresh token
  that GitHub gives with it. The client secret goes to the exchange of the code only. The worker
  does not revoke the token: that call sends the token and the secret to another route. Keep
  « Expire user authorization tokens » on in the settings of the App, so the token ends in eight
  hours. With that setting off, the token stays valid until the person revokes the App.
- **No code, no connector.** GitHub sends the `code` only when « Request user authorization (OAuth)
  during installation » is on in the settings of the App. Without a `code`, the worker cannot check who
  reaches the installation: it attaches nothing, answers `unauthorized-app`, and says the setting in
  its log. It never attaches an installation on the word of the `installation_id` alone.
- **The flow is bound to the browser, as Linear's is.** It starts with a ticket that only an owner
  or an admin gets, spent once and good for a minute. The `state` is bound to the browser that
  started by a `SameSite=Lax` cookie, issued by this worker, spent once, and good for ten minutes. A
  way back with no `state` is refused. The role and the suspension of the workspace are read again
  when GitHub sends the person back.
- An installation that an owner of the organisation must approve (`setup_action=request`) writes
  nothing. The workspace installs again after the approval.
- A way back with no `state` of this browser, for example after an installation from github.com,
  attaches nothing and goes to the console with `?github=unstarted` (FRU-361). The console then says
  to start from « Connect GitHub » of a workspace, or, to a person who manages no workspace, that
  nothing was connected.

### An address that receives the notes (FRU-122)

A workspace can also connect an address of its own, and the worker posts each note of a site that
chose it. The notes stay in the worker: this is one more copy, sent out.

- **The worker calls an address a customer chose, so it must not be a way in.** The address is
  https only. The worker does not call the machine it runs on (loopback), a private network, a
  link-local address or a mesh range (`100.64.0.0/10`): an IP address written in the address is refused when the connector
  is made, and a name is checked **when the socket resolves it**, at each attempt, so a name that
  changes its answer between a check and the call gains nothing. One internal address among the
  answers of a name refuses the name. A redirect is not followed.
- **A delivery that comes back to a worker is refused** (FRU-133). A workspace can give the public
  address of the worker itself, or another name that points at it, and no list of hosts can name
  every such address. So the refusal is on the request and not on the address: each delivery carries
  `X-Fruitback-Delivery`, and a worker answers `508` to every request that carries it, on every
  route, before it reads its configuration. The sender gives up on a `508` at once, with no other
  attempt, and the console says why. A request without the header arrives like any other from the
  internet, with no credential of the worker in it, and under the rate limit.
- The request is signed with a secret of the connector: HMAC-SHA256 of a timestamp, a dot and the
  body. The timestamp is signed, so a receiver that refuses an old one refuses a replay. **The
  signature proves the sender, and the body is not encrypted beyond TLS.**
- The address and the secret are kept like a tracker key: encrypted with `FRUITBACK_SECRETS_KEY`,
  and answered by no route. A secret the worker made is answered once, when the connector is made.
  The console shows the host of the address only: its path and query can hold a token.
- **A note that waits to be sent is kept in the database of the accounts, in the clear**, as the request body.
  It goes when it arrives. One that never arrives is given up after seven attempts, and removed
  30 days after its last attempt. The route that lists the waiting deliveries answers no body.
- The reporter is answered when the note is kept. A receiver that is down, slow or hostile costs the
  widget nothing. Each attempt is bounded at 10 seconds from its start to the status of the answer,
  whatever the receiver sends in that time, and the body of the answer is not read.
- A workspace can make the worker send requests to a third party: one per note its own sites
  receive, and six more attempts at most. The notes are rate-limited where they come in.
- **The files of a note travel as addresses, not as bytes** (FRU-331). The queue keeps the id, the
  name, the type and the size of each file. Each attempt signs, in its body, an address of one hour
  on the public address of the worker for each file that still waits, and leaves out a file whose
  transit ended. The receiver reads the bytes there, and the file goes one hour after the delivery
  arrived: see _The files of a note, in transit_.

### Signing in with GitHub (FRU-97)

Through better-auth (FRU-147), with an OAuth App (`FRUITBACK_AUTH_GITHUB_OAUTH`, callback
`/console/auth/callback/github`): the authorization code, `state` and PKCE, and the state in an
encrypted cookie (`SameSite=Lax`, `Path=/console/auth`, ten minutes). The sign-in of before, with
its own App and `FRUITBACK_GITHUB_OAUTH`, is gone (FRU-150): the worker refuses to start with that
variable. better-auth takes the address of the
profile, or the primary one when the profile shows none, and calls it verified only when GitHub says
so. **An address that GitHub did not verify creates no account and joins none**: better-auth links no
such address to an account, and the worker refuses the account that better-auth would otherwise
create, with a session (measured on 1.7.7):
test:`creates no account and joins none for an address that GitHub did not verify`, and its control
test:`makes an account for an address that GitHub did not verify, without the hook of the worker`.
No provider is in `trustedProviders`. No token of GitHub and no picture is kept.

### Signing in with Google (FRU-135)

Through better-auth too (FRU-147), with the client of `FRUITBACK_GOOGLE_OAUTH` and the callback
`/console/auth/callback/google`: the authorization code, a `state` and PKCE, as for GitHub. Only the
identity is asked for (`openid email profile`).

- **better-auth reads the identity from the id token** that the token endpoint of Google answers,
  over TLS, and checks no signature of it: the token comes from Google itself, in the answer to a
  request of the worker.
- **An address is used only when Google says it is verified** (`email_verified`). Another one makes
  no account and joins none: test:`creates no account for an address that Google did not
  verify`.
- A person who signs in with Google, with GitHub or with a link for the same verified address is one
  account. That is the rule of FRU-97, and it means the account is as safe as the weakest of the
  providers that can prove the address.
- `GET /auth/providers` answers the console which ways the routes of better-auth offer
  (`betterAuth`), and no client id. A worker with no accounts, or with no `FRUITBACK_AUTH_SECRET`,
  answers `{}`.

### A person's name and the ways they sign in, from « My account » (FRU-249)

- **A person names themself, and nobody else.** `POST /console/me/name` sets the name of the
  account of the cookie, from the console (its `Origin`), and no route takes an id: test:`sets the
  name of the person of the cookie only, by a POST of the console`. The token of an extension opens
  no route of the console. A name is one line of 1 to 80 characters, in NFC, and **holds no control
  character, no format character (a direction mark, a character of no width), no character of
  private use and none that is unassigned**: such a name would draw one name and hold another, as
  the author of a note in a tracker. test:`refuses what is not a name of one line, and keeps the name
  the account had`. A later sign-in with a provider does not write over it. There is no list of
  reserved names: a name is a claim of the person, as the name in a note always was, and the
  address beside it is the one the worker proved.
- **An extension signs the new name from its next access token**, at its next refresh, within ten
  minutes: the rename writes it on the live sessions of the person and on their codes that wait:
  test:`signs the next access token of an extension with the new name, and leaves the token in hand
  as it was`. A refresh or a redemption at the same moment as the rename gets the new name too: the
  rename holds the codes and the chains of the person first, as the end of their sessions does, and
  the redemption reads the name in the statement that spends the code: test:`gives the new name
  to a refresh in flight, on a real server, with the store as it is`. The notes already in a
  tracker keep the name they were sent with.
- **A provider is linked to an account only after its owner confirmed it, in the session that
  started the link** (FRU-415). This protects against a forced link: somebody who gets their own
  provider account linked to the account of another person, then signs in as them. What holds it:
  - **It starts by a `POST` of the console** (`POST /console/auth/link/<provider>`, a form), with the
    `Origin` of the console. A `GET` starts nothing, so a link or an image on a page of the same site
    sends the cookie and links nothing; a form of another page carries its own `Origin` and is refused:
    test:`links nothing on a GET, nor on a POST of another page (FRU-415)`. The id of the session
    that started it goes into the state of better-auth (`serverContext`, which no request writes),
    and the state is in an encrypted cookie of that browser.
  - **The way back from the provider writes no row.** The address of the provider account is known
    only there, so the console asks there: « Link the Google account x@y to your Fruitback
    account? ». The link waits 10 minutes (`PENDING_LINK_MS`), in the table `verification`, under a
    digest of its key. Only the session that started it reads it, confirms it
    (`POST /console/me/sign-in/pending`, with the `Origin` of the console) or cancels it, and it is
    spent once: test:`lets only the session that started a link confirm it, from the console, and
    cancels it (FRU-415)`. This holds for a provider account of the address of the account too:
    test:`links GitHub for the same verified address after the confirmation, keeps no token, and
    goes back to « My account »`.
  - **The address may differ from the one of the account, on three conditions**
    (`accountLinking.allowDifferentEmails`, and `guardLink` of `provider-link.ts`): the provider gave
    an address, and said that it verified it (`email_verified` of Google, `verified` of GitHub); a
    GitHub account that gives no address is refused. test:`refuses an address that the provider did
    not verify, or no address, and writes nothing (FRU-415)`. No other account has that address,
    and no other account has that provider account: the person is told which, and **no account is
    ever joined to another**. test:`refuses a provider account or an address that belongs to another
    account, and joins no account (FRU-415)`. Each condition is read again at the confirmation.
  - **The identity is the id of the provider account** (`sub` of Google, `id` of GitHub), never the
    address. The primary address of the account does not change; since FRU-450 the verified address
    of the provider becomes another address of the account (below): test:`links a provider of another verified address after the confirmation, by its id, and
    alerts the address of the account (FRU-415)`. A later sign-in with that provider account opens
    the account whatever address the provider gives then: test:`signs in by the id of the linked
    provider account, whatever address it gives later (FRU-415)`.
  - **An alert goes to the address of the account after each link**, with the provider account
    and the way to undo it (« My account », then « Unlink »). **On condition that the worker sends
    e-mail**: a worker with no mailer sends none, and a failure to send is logged and does not undo
    the link that the person confirmed.
  - No token of the provider is kept, as for a sign-in. better-auth's own `/link-social`,
    `/unlink-account` and `/list-accounts` stay closed. A sign-in with a provider is not a link: the
    rule of FRU-97 stays, one verified address is one account.
- **A provider goes only while another way to sign in stays** (`DELETE /console/me/sign-in/<provider>`):
  the link of the e-mail on a worker that sends it, or the other provider, linked and set up on this
  worker. Otherwise `409 last-sign-in`: test:`keeps the last way to sign in on a worker that sends no
  link`. **The session must be of the last day** (`freshAge`, the default of better-auth, written):
  an older one answers `403 sign-in-again`, so a cookie copied a week ago takes no way to sign in
  away: test:`asks a session older than a day to sign in again before a provider goes`. Two unlinks
  of one person run one after the other, so two at the same moment cannot take both providers:
  test:`takes one of two providers, and not both, when two unlinks come at the same moment`. **This
  holds for one process of the worker**, as the lock of a workspace does.

### The other addresses of an account (FRU-450)

Decisions of Mathieu, 2026-10-25. An account has one primary address (`user.email` of better-auth)
and others, in the table `account_emails` (`account-emails.ts`). This protects against an address that
nobody proved being used as an identity, and against one address opening two accounts.

- **An address is there only once something proved it.** A linked provider proves the one it gives
  as verified (`email_verified` of Google, `verified` of GitHub). A person adds one in « My account »:
  Fruitback sends a link there, which works once, for 24 hours, **and only in a session of the account
  that asked, from the console** (its `Origin`). Another account that opens it adds nothing, and the
  link stays for the right one: test:`adds an address once its link is opened in the session that
  asked, and lists it`. So a person who adds the address of another one gets it only if that person
  is signed in to their account and opens the link there. The token is after the `#` of the link, and
  the table `verification` keeps a digest of it. An address that waits is nobody's: no sign-in link
  and no invitation reaches the account through it. test:`refuses a link of verification past its 24
  hours`.
- **An address is of one account**, as its primary address or as another one. An address of another
  account is refused with `409 email-taken`, which does not say whose it is: test:`refuses an address
  of another account, and does not say whose it is`. The database holds it too: a trigger on `user`
  and on `account_emails`, under a lock of the address, refuses the write (`0033_one_owner_per_address`):
  test:`holds one address to one account in the database too`. A provider that gives another address
  of an account makes no account: test:`makes no account for a provider that gives another address of
  an account, and joins none`.
- **A link to add an address goes out 5 times an hour for one account, and 3 times an hour to one
  mailbox**: test:`sends 5 links of verification an hour for an account, and no more`. The counts are
  in the `Kv`, so the replicas share them.
- **A sign-in link sent to another address opens the account**: better-auth makes the link of the
  primary address, and the message goes to the address that was typed: test:`opens the account with a
  sign-in link sent to another address it proved, and with none that waits`. So the account is as safe
  as the weakest mailbox of its addresses, as it is of its providers.
- **An invitation sent to another address of an account is accepted by that account.** better-auth
  takes an acceptance from a session of the address of the invitation only: the worker gives the
  invitation the primary address for the length of the call, then its own again. Only an address of
  the account that something proved counts; one that waits does not: test:`lets the account accept an
  invitation sent to another address it proved, and keeps the address of the invitation`. Fruitback
  has no rule of a domain for the invitations; the address that counts is the one the invitation was
  sent to. **This holds for one process of the worker**: an acceptance runs alone in its workspace.
- **The primary address is the one of the notes and of the messages.** The person chooses it among
  their addresses, with a session of the last day, as for an unlink; an older one answers `403
  sign-in-again`. An alert goes to the address of before and to the new one: test:`makes another
  address the primary one, with a session of the last day, and alerts both`. The extensions sign the
  new address from their next access token.
- **A provider follows its address.** At each sign-in, the verified address it gives takes the place
  of the one it gave before; one it did not verify, or none, takes it away: test:`keeps the address of
  a linked provider, follows it at each sign-in, and takes it away at the unlink`. A person takes an
  address away by hand, but not the primary one, nor one that a linked provider gives: test:`takes an
  address away by hand, but never the primary one nor one that a linked provider gives`.
- **An unlink takes the address of the provider away**, unless Fruitback proved it too. When that
  provider alone proves the primary address, the unlink is refused with `409 primary-address` until
  another address is primary: test:`keeps the address of an unlinked provider that Fruitback proved
  too, and refuses the unlink of the one that alone proves the primary address`. The rule « never the
  last way to sign in » stays.

### « Last seen » and the label of a browser (FRU-249)

Decision of Mathieu, 2026-10-13 (Q7): the short label of a browser is kept per session, and « Last
seen » is shown to owners and admins only.

- **« Last seen » is read by an owner or an admin of the workspace, and by nobody else.**
  `GET /console/workspaces/<id>/members/seen` answers `{seen: {<account>: <day>}}` with the right to
  manage the members; a member or a guest gets `403`, a person of another workspace `404`, as for
  every route of a workspace: test:`answers nothing of it to a member, a guest, another workspace,
  nobody, or an extension`. **It is a day, never an hour**: an hour would tell a colleague when
  somebody works. It is written by a call of the person to the console in that workspace, or by a
  refresh of their extension for it, at most once every ten minutes in a process, and it goes
  with the membership: test:`writes once for a person in a workspace while the day is remembered, and forgets the day when they
  leave`. The days of one workspace say nothing of another one: test:`sees a member in the
  workspace they called, and in no other one`.
- **A session of the console keeps the label of its browser, « Chrome on macOS », and not its user
  agent.** The label is two words of closed lists (`browser-label.ts`), so nothing a browser writes,
  no version and no device, reaches the database: test:`keeps « Firefox on Linux », and not the user
  agent, and lists it with the session`. The user agent is kept beside it only when the operator
  keeps addresses (`FRUITBACK_AUTH_TRACK_IP`), as before.

### The statuses of a site (FRU-366)

- **Only a role with `manage-sites`** (an owner or an admin) lists, adds, changes, orders or removes
  the statuses of a site: `GET`, `POST /console/workspaces/<id>/sites/<site>/statuses`,
  `POST …/statuses/order`, `DELETE …/statuses/<source>/<key>`. A member or a guest is `403`, and a
  site of another workspace answers `404`, like one that does not exist, with nothing written.
  test:`answers a site of another workspace as one that does not exist, and refuses a member who does not set sites`,
  test:`answers a site of another workspace as none, and writes nothing there`.
- **The number of notes in each status (FRU-386) comes with the list, under the same role**, and
  counts the notes of that site only. test:`counts the notes in each status of the store, 0 for one with none, and those of its site only (FRU-386)`.
- **A colour reaches a style, so it is `#rrggbb` and nothing else**, checked by the worker on every
  write (`readSiteStatus`) and by every reader of the answer (`offeredStatuses` of `shared`): no
  `var(…)`, no `url(…)`, no named colour. A text colour that the team chose under 4.5:1 on its
  background, or with no background, is refused, never corrected; one the team did not choose is
  computed by `readableTextColor`. test:`refuses what a status cannot be, and says why`.
- **The widget writes a colour of a status into a style only as `#rrggbb`** (FRU-370). It reads the
  list with `offeredStatuses`, and `statusPaint` checks each colour again before `style.setProperty`:
  any other value draws the token of the stage. test:`lets nothing but #rrggbb reach a style, whoever built the status`.
  The side panel of the extension takes the status of a note from the page, a world the page writes
  in: `parsePanelNotes` keeps a colour only as `#rrggbb`, a text colour only with it, and a status only
  of the note's stage. test:`keep the word of the store and the status of a note, and only a colour that is #rrggbb (FRU-370)`.
- **A status comes from the worker's store or from a connector the site sends to.** A source that is
  not one of them is refused (`unknown-source`): a site cannot name the states of another tracker.
- **A status that holds notes is not removed until the request says where they go**
  (`409 status-in-use`, with their number), and they go to a status of the same site only, in the
  transaction that removes it. test:`moves the notes of a status before it goes, and only those of its site`.
- **What a reader of the site learns.** `GET /feedback` gives every reader of the site the names and
  the colours of its statuses, and the status of each note, as it already gives the name of a
  state (`stateName`). A team that names a status writes for whoever reads the site.
- **The states of Linear, and the switch of their colours** (FRU-368): `GET …/statuses/tracker` and
  `POST …/statuses/settings` are `manage-sites` too, and a site of another workspace answers `404`.
  The states are those of the teams the site sends to, read with the key of the connector of the
  workspace: no other team is asked. A colour Linear gives reaches a style only when it is `#rrggbb`
  (`listLinearStates`); « orange » is dropped. The read of a site gives each reader the names and
  colours of the states of its Linear team, as it gives `stateName`, except a reader the tracker is
  hidden from (a guest, FRU-250): the key of such a status holds the id of the state at Linear, so that
  reader gets the statuses of the worker's store only, and no `status` of a tracker on a note
  (`withoutTrackerStatus`). test:`lists the states for the
  statuses page, with the switch, and refuses who does not manage the sites`.

### The status of a note that the worker keeps (FRU-367)

- **`POST /feedback/<id>/status?client=<site>` takes the rights of a verdict** (FRU-294): a session
  of the extension, read again in the store, of a person who reads the site now; and of them, the
  person who left the note (the index keeps their account) or a role with `manage-sites`. Anybody
  else of the workspace is `403`, no session is `401`, and nothing is written.
  test:`refuses a member who did not leave the note, and a request with no session, and changes nothing`.
- **The status is one of the site's, of the worker's store**: a built-in one, or one the team added
  and did not hide (`409 status-hidden`), read again under the lock of the site when the note is
  written (`409 status-changed` if the console removed or hid it in between). A status of a tracker (`400 not-own`), and a note of a
  tracker (`403 statuses-not-taken`), change in the tracker.
  test:`refuses a status the site does not have, a hidden one, one of a tracker, and a value that is no status`,
  test:`refuses the note of a tracker: its status changes in the tracker`.
- **The note takes the stage of its status**, in the store and in the index of the notes, and the
  page is read again (`invalidatePages`). « Still wrong » still reopens the note: it goes back to the
  built-in status of the first stage.
  test:`keeps the effect of « Still wrong »: the note goes back to the first stage, in its built-in status`.

### The status of a note, chosen in the console (FRU-384)

- **`POST /console/workspaces/<id>/notes/<note>/status` takes the rights of the route of the
  extension** (FRU-367), with the cookie of the console: the person who left the note (the index keeps
  their account), or a role with `manage-sites`. Anybody else of the workspace is `403 not-allowed`, a
  site the caller does not read (a guest, FRU-250) or of another workspace is `404`, and nothing is
  written. test:`refuses a member who did not write the note, and writes nothing`,
  test:`answers 404 for a note of a site the caller does not read, or of another workspace`.
- **Every check is in one transaction, the site held for update** (`setNoteStatus` of the accounts
  store): the note of the index and its author, the status of the site (`409 status-hidden`, and
  `409 status-changed` for one it no longer has), then the note and its stage in `notes` and in the
  index. The worker keeps a note in Fruitback, or sent on to an address (a `rest` connector), as
  `FB-<id>`; that row must be of the same site and hold the same note (the id the widget gave it), so a
  note of a tracker, even one it named `FB-<n>`, is `403 statuses-not-taken`.
  test:`refuses a hidden status, and one the site no longer has, with the conflict the console says`,
  test:`takes the note of a site that sends to an address: the worker keeps it too (heavy review of #505)`,
  test:`leaves to its tracker a note it named FB-<n>, the number of another note of the site`.
- **A suspended workspace changes no status** (FRU-282): the route is a write of the console, behind
  its one guard. The page of the note is read again (`invalidatePages`).
  test:`lets the author put the note in a status the team added: the store, the index and the pin follow`.
- **The list says who may change what**: `canSetStatus` on each note the worker keeps, and the
  statuses of the worker's store of its site, hidden ones marked so, to whoever reads the list. A
  status is no secret of the team: the widget and the extension read the same ones (FRU-366).
  test:`lists the status of a kept note, who may change it, and the statuses of its site`.

### The image of the console (FRU-222)

The console is static files behind nginx, in an image of its own. **It holds no secret**: nothing
of the repository but the built files, no variable but the address of the worker, and the session
is a cookie of the worker that no script reads.

- **Its `Content-Security-Policy` lets the page call one worker and run no other script**:
  `script-src 'self'` and the hashes of the inline scripts of the build, never `'unsafe-inline'`;
  `connect-src 'self'` and the origin of the worker; `frame-ancestors 'none'`; `base-uri 'none'`.
- **The preview of the setup frames the site the person added, in their browser** (FRU-354):
  `frame-src https: http:`, and `img-src https:` for the icon of that site. The Sites screen asks
  the same icon of each site it shows (FRU-408), at most 12 at a time, from the browser of the
  person and with no referrer: the site sees a request for its icon from that browser, as a visit
  would make. The frame is sandboxed without `allow-top-navigation`, so the site cannot take the tab
  of the console away, and it gets no referrer. The console asks the site for nothing from a server:
  no request of the worker goes there. A script cannot read what a frame of another origin shows, and the console cannot tell a
  site that refuses to be framed from one that shows, so the person can ask for the address in place
  of the frame. What this widens: markup injected in the console could load an image or a frame
  from any address. `script-src` and `connect-src` are as above, so such markup runs no script and
  calls no other server from the console.
- **The address of the worker is given when the container starts**, as `FRUITBACK_API`, and goes
  into that policy and into `/config.js`. It is held to the letters of an address first: a scheme,
  a host, a port, a path. Anything else stops the container before a file is written, so a value
  cannot add a source to the policy or a statement to the script. **Whoever sets the variables of
  the container chooses the worker the console calls**: that is the operator, as for every variable.
- **`/config.js` is public.** It holds the address of the worker and nothing else.
- **It runs as a user that is not root**, writes under `/tmp` only, and starts with a read-only root
  and no capability, which is how the compose file runs it.
- **The console and the worker are two origins of one site.** The worker answers the origin of
  `FRUITBACK_CONSOLE_URL` and no other, with credentials, and the cookie of the session is
  `SameSite=Strict`: two names of one domain. Not measured: one name with two paths, and the cookie
  on `http://localhost`, where a browser must accept a `Secure` cookie without TLS.

### What the console may change, and who (FRU-99)

The console's routes under `/console/` take the cookie of a console session, and read the role
of its account in the workspace **on every call**, from the database: a session says who, never
what they may do, so a member removed a minute ago is refused at once. `can(role, action)` in
`accounts.ts` is the one table. A workspace somebody is not a member of answers `404`, like one that
does not exist. Adding a site keeps the origin of the pasted address and nothing else.

**The access token of an extension opens none of these routes** (FRU-202). Until FRU-150 the
console held a token signed with the same worker key, and only the `ws` claim told the two apart;
before FRU-202, the 10-minute token of an extension paired for one workspace read and changed every
workspace of the person, with the role of the person, and could mint a pairing code, so a new
30-day session, in any of them. Since FRU-150 these routes read no token at all: any
`Authorization` header is answered `401`, in the workspace of the extension too.
test:`refuses POST connect to the token of an extension, in another workspace and in its own`, and
one test for each other route.

`POST /console/workspaces/<id>/connect` mints a pairing code for the person, in that workspace
(FRU-100), except on the Cloud, where it answers `404` (FRU-325). The console puts it after the `#` of the worker's pairing page, and the extension spends it
as it spends a code an operator minted. **A guest's session reaches the sites shared with them
only** (FRU-250): its token names the workspace, and every route that answers a thing of one site
reads the role and the sites of the person at the request (below, « The guest of one site »).

**The guest of one site (FRU-250).** A guest reads and writes on the sites shared with them, and on
no other site of the workspace; they never read a reference of the tracker.

- **The sites of a guest come from their invitation, and only from it.** `invite-member` with
  `role: 'guest'` takes `sites`, 1 to `MAX_GUEST_SITES` ids, each a site of the workspace the call
  names, read in the store before better-auth keeps anything: a guest with no site, a site of
  another workspace, or `sites` for another role is `400`.
  test:`refuses a guest with no site, a site of another workspace, a site to another role, and a list that is no list`.
  A change of role gives no `guest`: test:`makes no guest by a change of role: a guest is made by an invitation, which names the sites`.
- **The acceptance copies the sites to `site_shares` before better-auth writes the member**, and only
  for the person the invitation is for, while it waits, and who is not a member yet: no moment has a
  guest with sites that are not theirs, and the invitation of another person changes nothing of
  yours. test:`writes no share for somebody who accepts the invitation of another person`. A guest
  invitation whose sites were all removed is refused at the acceptance.
- **Every route that answers a thing of one site reads the role and the sites of the person at the
  request** (`AccountStore.reach`): `GET` and `POST /feedback` (a batch too), `POST /attachments` (a
  file keeps the site of its note, and only its sender names it in a note of that site), `GET /session/sites` for both kinds of session, `GET /console/workspaces/<id>/sites`
  and `/notes`. **A session of a workspace is asked it too**: its token names the workspace, not the
  site. On another site the answer is the one a person of another workspace gets. `guest-site.test.ts`
  asks each route, on the shared site and on another, and plants one violation for each guard:
  test:`lets the guest read the notes of every site in GET /console/workspaces/<id>/notes without its filter`.
  The cost is one read of the database for each authenticated read of a page, as a session of an
  account already paid (FRU-238); it also ends the reads of a member who was removed at once, where
  a token used to live its ten minutes.
- **A guest reads no reference of the tracker**, on any route: no place, no reference, no address
  and no id of an issue. On the routes of the widget the worker gives a guest the id of the note in
  place of the reference and the id of the issue, after the read cache, whose answer every reader
  of the page shares. One test for each route a guest reaches, with a tracker that writes `ACM-n`,
  and its control: test:`gives the same routes a reference for a member: the marks above are what the tracker writes`,
  test:`fails without the hiding of the references on the routes of the widget (planted violation)`. A visitor of a public
  site is not changed by this (FRU-84).
- **A site that goes takes its shares**, and a guest who goes takes theirs: the guest of a removed
  site stays a member and reads nothing. test:`takes the share away with its site: the guest stays a member and reads nothing`.

**The members of a workspace (FRU-149) and the invitations (FRU-104).** With better-auth on, ten
routes of its organization plugin are served under `/console/auth/organization/`, with the cookie of
the console. Each one has a rule in `ORGANIZATION_PATHS` (`organization-paths.ts`):

| Route                   | Who                                          | What it does                               |
| ----------------------- | -------------------------------------------- | ------------------------------------------ |
| `list-members`          | owner, admin, member                         | names, addresses and roles                 |
| `update-member-role`    | owner, admin                                 | owner, admin or member, never guest        |
| `remove-member`         | owner, admin                                 | the member, and their codes                |
| `leave`                 | anybody of the workspace, but its last owner | themselves                                 |
| `invite-member`         | owner, admin                                 | an address, as admin, member or guest      |
| `list-invitations`      | owner, admin                                 | the invitations that wait                  |
| `cancel-invitation`     | owner, admin                                 | an invitation of that workspace            |
| `list-user-invitations` | the person of the session                    | the invitations to the address they proved |
| `accept-invitation`     | the person an invitation names               | joins, with the role of the invitation     |
| `reject-invitation`     | the person an invitation names               | declines                                   |

- **An invitation goes to an address, and only a session of that address takes it.** The message
  holds a link to the console and **no id and no token**: whoever reads it, or a copy of it, opens
  nothing. The person signs in with the address (a link proves it, and a provider that did not verify
  it creates no account), and the console lists the invitations of that address. better-auth refuses
  to read, accept or decline an invitation for any other session, and for an address that is not
  verified (`requireEmailVerificationOnInvitation`, written).
  test:`gives an invitation to the address it names, and to no other session`.
- **An invitation gives `admin`, `member`, or `guest` with the sites it names, never `owner`**
  (FRU-250): « The guest of one site » below. The role of an accepted invitation is
  refused again when its row holds two roles: test:`refuses an invitation whose row holds two roles,
  when it is accepted`. An invitation waits 7 days; one address gets one invitation of a workspace at a
  time, sent again on request; and **3 messages from one workspace to one address in 15 minutes**,
  the numbers of the sign-in link. Past them the invitation is kept and no message goes: the answer
  says `mailed: false`, and the console gives the link to send by hand. The count is by workspace
  and address (FRU-209): counted for every workspace together, somebody else closed the window of
  an address from a workspace of their own, and the refusal told an admin that the address was
  invited elsewhere. **One account sends 20 invitation messages an hour, in every workspace together,
  and one workspace 40, whoever invites** (FRU-209): anybody makes a workspace, so the window of an
  address alone let one account write to as many addresses as it wanted, 60 messages from 12
  workspaces (measured). Past either count the invitation is kept and no message goes, as for the
  address. test:`sends no more messages than one account may in an hour, in every workspace together, and keeps the invitations (FRU-209)`,
  test:`sends no more messages than one workspace may in an hour, whoever invites (FRU-209)`.
  **The subject of the message is the same for every invitation**, and holds no text that a person
  wrote: the name of the workspace was the subject, so « Your invoice is ready: https://… » went
  out under the name of Fruitback. The names of the workspace and of the inviter are in the body
  only, escaped, and written so that a mail client makes no link of them:
  test:`writes no text of a person in the subject, and makes no link of a name in the body (FRU-209)`.
  What remains: 20 messages an hour by account, with a sentence of the sender in the body, and
  nothing that tells accounts of one person apart. A worker with no mailer sends nothing and keeps the invitation: the console shows
  the same link (FRU-107), and it opens nothing more than the message does.
  test:`sends an invitation again when asked to, and no more than three messages to one address in the window`,
  test:`keeps the window of an address to its workspace: another workspace neither closes it nor learns of it (FRU-209)`.
- **An invitation does not outlive the right of whoever made it** (FRU-209). When a member is
  removed, leaves, or gets a role that does not invite, the invitations of theirs that wait in the
  workspace are cancelled in the same call. Without it an admin who was removed left a second
  admin behind: the invitation stayed good for 7 days, and « Resend » moved its end.
  test:`cancels the invitations of an admin who is removed, demoted, or leaves, so nobody joins on their word (FRU-209)`.
  The acceptance checks it again, for a cancellation that did not run (it comes after the write of
  better-auth, in no transaction): an invitation whose inviter is no longer an owner or an admin
  of the workspace is refused,
  test:`refuses at the acceptance an invitation whose inviter no longer invites, when no cancellation ran (FRU-209)`.
  **Both are on the routes of the worker**, not in better-auth: a call to the plugin in the process
  passes neither, and no code of the worker makes one for these routes.
- **One call at a time changes a workspace** (FRU-209). better-auth reads, then writes, in no
  transaction: it counts the owners and then removes one, it looks for an invitation of an address
  and then writes one. On a real PostgreSQL, two owners who left, demoted themselves or removed
  each other at the same moment left a workspace with no owner, which nobody can repair or delete
  (measured, 3 runs of 3), and four invitations of one address wrote two or three rows. The
  `POST /console/auth/organization/*` routes of the worker that name a workspace now run one after
  the other for that workspace:
  test:`keeps one owner when two owners go at the same moment (FRU-209)`,
  test:`writes one invitation for one address when two people invite it at the same moment`.
  **This holds for one process of the worker.** Two replicas do not share it: the rate limit is
  shared through the database (FRU-67), this is not. The last owner is kept on every replica by the
  database since FRU-324 (« A workspace keeps an owner » below); two invitations of one address
  from two replicas are not.
  **The rename and the deletion of a workspace are outside it**: `POST` and `DELETE` on
  `/console/workspaces/<id>`. Neither counts the owners or looks for an invitation before it
  writes. Two renames at the same moment leave the last one written. Not measured: a rename at the
  moment its author loses the right, or at the moment the workspace is deleted.
- **Nobody is removed while their extension lives** (FRU-209). The sessions of the extensions of a
  member end before better-auth deletes the member; when that fails, nothing is deleted, the call
  answers `502`, and it is made again:
  test:`removes nobody when the end of their extensions fails, answers 502, and removes them at the next call (FRU-209)`.
  `leave` has no hook to do it first: its clean-up comes after the write, a failure answers `502`,
  and the same call made again finishes it,
  test:`finishes what follows a departure when somebody who left asks again (FRU-209)`. Until then
  the second lock holds: a refresh and `/session/sites` read the membership.
- **Smaller rules of the invitations** (FRU-209). An invitation that was accepted cannot be
  cancelled (test:`refuses to cancel an invitation that was accepted, and the person stays a member (FRU-209)`).
  One past its end is listed nowhere (test:`lists no invitation past its end, to whoever invites and to the person it names (FRU-209)`).
  A « Resend » names the role of the invitation that waits, or is refused
  (test:`refuses a « Resend » that names another role than the invitation that waits, and sends nothing (FRU-209)`).
  A change of role gives `owner`, `admin` or `member`, and no `guest`, for the reason an invitation
  gives none (test:`makes no guest by a change of role, as by an invitation (FRU-209)`). The address
  of the session must be verified (`requireEmailVerificationOnInvitation`):
  test:`takes an invitation from a session whose address is verified, and from no other (FRU-209)`.
  The window of an address counts its mailbox, without a `+suffix`, for an invitation and for a
  sign-in link: test:`counts the window of an address by its mailbox: a suffix after « + » opens no other (FRU-209)`.
  Dots in the name of a mailbox are not folded: only some providers ignore them.
- **A cancel names the workspace, and the invitation must be of it.** better-auth reads the
  workspace of an invitation from the invitation; the worker reads the role in the workspace of the
  call, so it checks first that the two are one:
  test:`cancels an invitation of the workspace the call names, and of no other`.
- **What a copy of the database shows**: each invitation, its address, its role, its state and the
  id of who sent it. The id of an invitation travels in no link.

- **better-auth is the second reader of a call, never the first.** Before it reads a request the
  worker has checked the cookie, the `Origin` of a call that changes something, the fields of the
  request, the **one** role of the caller in the workspace the call names, and what `can` gives that
  role. Then better-auth is handed a request that the worker wrote, and its own checks stay.
  test:`answers each role, on each open route of the plugin, what its rule says` asks the four
  routes as each role, as somebody of another workspace (`404`) and as nobody (`401`).
- **What a guest does not read: who the members are, and the invitations.** A guest is a reviewer
  from outside, often the client of the team: the list holds the name and the address of every
  member, the other guests among them. The plugin asks no permission to list the members, and
  answers them and the invitations to a guest (measured, and kept measured by the control of
  test:`does not let a guest read the members or the invitations, on the API`). So `list-members`
  asks `can(role, 'read-members')`, which a guest does not have; `list-invitations` asks
  `manage-members`; `get-full-organization` and `get-invitation` stay closed to every role. A guest
  reads the invitations sent to their own address, and no other. A guest reads the name of the workspace, their own role, and the sites shared with them
  without their destinations, as before.
- **Every other route of the plugin answers `404`, twice.** The worker answers it for a path that
  has no rule, and better-auth is built with that path closed to a request: the list of the closed
  paths is read from the plugin as it is installed, so a route that a later version adds is closed
  before anybody reads its name.
  test:`answers 404 on every route of the plugin that has no rule, and on an open one taken out of the list`.
- **A call names its workspace by its id, once.** The worker reads the role in that workspace, so
  better-auth must not read another one: a slug, a field given twice, and any field the rule does
  not have refuse the call (`400`).
  test:`refuses a call that names its workspace twice, by a slug, or with a field the rule does not have`.
- **A member has one role, one of the four.** better-auth takes a list of roles, writes
  `guest,admin`, and gives the union of what each one may do (measured). Three things hold one role:
  the route refuses a role that is not one of the four, a hook of the plugin refuses the same for a
  caller that is not the route, and the worker reads a row that holds anything else as **no role**:
  a `guest,admin` written straight in the database is a member of nothing, on the routes of the
  console, on these four, and for the extension.
  test:`gives a member one role, one of the four: on the route, and in the plugin called in the process`,
  test:`gives no right for a row « guest,admin » planted in the database`. No role is made at run
  time, and there is no team.
- **The last owner stays.** They cannot leave, be removed or be demoted, by themselves or by an
  admin, and an admin cannot make an owner:
  test:`keeps the last owner: they cannot leave, be removed, or be demoted, by themselves or by an admin`.
  These are checks of better-auth 1.7.7, held by that test.
- **A workspace keeps an owner, whoever writes its members** (FRU-324). better-auth counts the owners,
  then writes, in no transaction: the deletion of an account by an administrator (FRU-285) counted
  the other owner, and a route that removed, demoted or let go that owner in the same moment left the
  workspace with no owner (measured on a real PostgreSQL:
  test:`leaves the workspace with no owner without the trigger`). A trigger of the database
  (`0020_workspace_keeps_owner`) now runs after every write that takes an owner away: it holds the
  workspace, so it waits for a deletion that holds it, then counts the owners, and refuses the write
  when none is left, in the transaction of that write:
  test:`refuses to demote or remove the last owner, written straight in the database`. The route then
  answers `502 auth-unavailable`, as for any failure of better-auth; an owner who asks to leave again
  gets the refusal of better-auth of the last owner, `400`. **This holds for every replica**, and for a write that is not a
  route of better-auth. A workspace that is deleted takes its owners with it. A writer that holds a
  workspace and then writes its members holds the members first, so that a route and a deletion do
  not wait for each other:
  test:`deletes Ana while Bob removes her: the route waits for the row, and neither ends on a deadlock`.
- **Somebody who is removed, or who leaves, keeps no extension for the workspace.** Every chain of
  refresh tokens of the person for that workspace is ended at once, and so is a pairing code that
  was minted for them and not redeemed. The refresh and the pairing also read the membership: a
  session of somebody who is no longer a member ends at its next refresh, whatever removed them.
  `GET /session/sites` reads the role at each call.
  test:`stops the extension of a member who is removed: no refresh, no site, no code, and the others go on`,
  test:`ends at the next refresh the session of somebody whose membership went by another way`.
  **What remains: an access token that was already minted.** It reads the notes of the sites of
  the workspace, and leaves notes under the name of the person, until it expires: **11 minutes at
  most**, its 10 minutes and the 60 seconds of clock skew. `GET /feedback` and `POST /feedback`
  compare the workspace of the token, and read no role.
- **A workspace is deleted by its owner only**, by `DELETE /console/workspaces/<id>`. The tokens of
  its Linear connectors are revoked at Linear first, as when one connector is removed; then its
  members, sites, connectors and waiting deliveries go, and every extension paired for it stops.
  The route of the plugin that deletes a workspace does none of that: it is closed to a request,
  and refused to a call in the process.
  test:`deletes a workspace for its owner only: the tokens of Linear first, then its sites, connectors, deliveries and extensions`.
- **A workspace is made by the plugin for somebody of the cookie**: `POST /console/workspaces`
  reads the name, then calls it in the process. Its route stays closed to a request: it takes a
  slug, a logo and metadata that nothing reads.
- **A workspace is renamed by its owner or an admin** (FRU-236), by `POST /console/workspaces/<id>`
  with a name, under the rule of the creation: one line, 1 to 80 characters. The role is read in
  the store of the worker at the call, a member and a guest get `403`, somebody who is not of the
  workspace `404`, and a call that does not carry the `Origin` of the console `403`, as on every
  route of the console that changes something. The plugin writes the name, called in the process
  with the name and nothing else, and reads the person and their role again; its own route
  (`/organization/update`, which also takes a slug, a logo and metadata) stays closed. The id, the
  sites, the members and the extensions that are paired do not move: they name the id.
  test:`moves nothing else: the id, the sites, the members, and the extensions that are paired`.
- **A connector is named by an owner or an admin of its workspace** (FRU-404), by
  `POST /console/workspaces/<id>/connectors/<connector>` with `{ name }`, under the rule of the name of
  a workspace; `null` or an empty name takes it away. A member and a guest get `403`, and a connector
  of another workspace `404`, as for its settings. The name is kept in `connectors.name`, beside the
  `label` that the worker writes, and is never sent to a tracker nor to a page of a site: only
  the routes of the connectors of the console answer it, to who may see the tracker.
  test:`lets only who manages the workspace name a connector, and only one of their own`.

### A reply to a note, from the page (FRU-257)

`POST /feedback/<id>/replies?client=<site>` writes a reply into the tracker of a workspace, or into
the database for a site with no destination.

- **Who.** A session of the workspace of the site, by the relay of the extension, on any site: the
  reply is named by the account, and a name in the body is not read. With no token, a visitor, on a
  site that everybody reads (`everyone`) only: the name they typed is their word, and the text says
  « not verified ». A token that does not verify is `401`, and so is no token on a site of the
  members. test:`refuses a reply with no session on a site of the members, and a session of another workspace`.
- **Under which identity.** The tracker writes the comment under its key: the app of Fruitback for a
  connection by OAuth, **the owner of a personal key** for a key. The first line of the text names
  the person and says whether the worker vouches for them, and every line they wrote is quoted, so a
  forged first line is a line of the quote.
  test:`never lets what somebody wrote pass for the line that says who wrote it`.
- **Which note.** The id names an issue of a tracker, which can be of another site. The worker reads
  the page for the site first and writes only under a note that the read answers, else `404`.
  test:`answers 404 for a note of another site on the same page, and writes nothing`.
- **Where not.** An address that only receives (REST), and a tracker whose workspace hides its
  replies, take none: `403 replies-not-taken`, and `GET /feedback` answers no `canReply` there.
- **How much.** 1 to 2 000 characters, refused beyond and never cut. **5 replies a minute with no
  session from one address**, counted apart from the requests and in the same database; a member is
  not counted. test:`takes 5 replies with no session from one address in a minute, and a member's after them`.

### « Looks fixed » and « Still wrong », from the extension (FRU-294)

`POST /feedback/<id>/check?client=<site>` with `{ url, verdict: 'fixed' | 'wrong', body? }` writes a
verdict on a note that the team marked done. « fixed » writes a marked reply under the note, which
stays done. « wrong » writes the marked reply, then reopens the note in its store (Linear: the first
state of the team of type `triage`, else `backlog`, else `unstarted`; the database: `new`, in the
same transaction).
**The store is the one place that keeps the stage and the verdict**: the worker keeps no copy.

- **Who.** A session of the extension of the workspace of the site, **read again in the store** as
  for every write (2026-10-14), of a person who reads that site now. Of them, **the person who left
  the note**, as the index of the notes keeps their account, **or a role with `manage-sites`**
  (owner, admin). Another member, and a guest who left no note there: `403 not-allowed`. A guest of
  another site: `403`. No token, the token of a site, the cookie of the console, a session that
  ended, a person of another workspace, a workspace suspended: `401`.
  test:`refuses another member who did not leave the note, and takes an owner, who manages the sites`,
  whose control gives the same member to an index that names them as the author:
  test:`the control: the same member is taken when the index names them as the author`.
  test:`refuses no token, a session that ended, and the cookie of the console, with 401`.
- **A note of a visitor, or of the token of a site, has no author the worker vouches for**: only a
  role with `manage-sites` gives a verdict on it.
- **When.** Only on a note that its store says is done **now**, read for the request and not in the
  cache (`409 not-done`), and not confirmed already (`409 already-checked`): a « Still wrong » does
  not reopen a note that the team did not close.
  test:`answers 409 on a note that is not done, and on a note confirmed already, and writes nothing`.
  **One verdict at a time on a note**: a second one sent while the first is written is
  `409 check-in-progress`, held by a key of the shared `kv` for the time of the write (15 s at most),
  and the note is read again under the key, so a request that read it before another wrote reads the
  verdict after. test:`writes one verdict for two sent together, and answers 409 to the other`,
  test:`writes one verdict when the second request read the note before the first wrote, and took the key after`.
- **An index that does not answer is `502 store-unavailable`**, never a refusal of the author: the
  person tries again. test:`answers 502 when the index of the notes does not answer, never a refusal of the author`.
- **Which note.** As for a reply: the route reads the page for the site and writes only under a note
  that the read answers, else `404`. test:`answers 404 for the id of a note of another site`.
- **What goes to the tracker.** The name of the account and the name of the workspace, on the line
  that says who wrote it, then the line of the verdict, then what the person typed, quoted. The
  tracker writes it under the identity of its key, as a reply. **A reply of the page cannot pass for
  a verdict**: its second line is always empty. **A person of the team can write a verdict by hand
  in the tracker**: the tracker is theirs, and they can move the note there too.
  test:`reads a verdict in either language of a team, and no reply of the page as one`.
- **Where not.** A site whose store takes no reply takes no verdict: an address that only receives,
  a tracker whose workspace hides its replies, GitHub. `403 checks-not-taken`.
- **How much.** A text of at most 2 000 characters, like a reply. **No count of its own**: only a
  member gives a verdict, and a member's reply is not counted either (FRU-257); the limit of all
  requests applies. test:`takes more verdicts of members from one address than the replies of visitors allow`.
- **What a read says.** `GET /feedback` adds `checked: { by, at }` to a done note whose newest verdict
  is « fixed », read in its replies: anybody who reads the replies of the page reads it. It adds
  `mine: true` to the notes that the reader left, **for a session of the workspace and nobody
  else**, after the shared cache, like `canReply`.
  test:`says mine to the person who left the note, and to nobody else`.
- **From the extension (FRU-300).** « Looks fixed » and « Still wrong » of the side panel go through
  the widget of the tab, by its transport: the relay of the extension carries
  `POST /feedback/<id>/check` under the same rules as a reply (the list below). The panel moves
  nothing itself: it reads the page again, and the store says where the note is.

### The side panel of the browser (FRU-296)

The extension declares a side panel: `side_panel.default_path` and the `sidePanel` permission on
Chrome, `sidebar_action` on Firefox. It is a page of the extension, `sidepanel.html`.

- **No access to a page.** `sidePanel` lets the extension show its own page beside the tab; it
  grants no host, no content script and no read of a page. Chrome shows no warning for it: measured
  on the built manifest with `management.getPermissionWarningsByManifest`, the warnings with and
  without the panel are the same (`e2e/side-panel.spec.ts`). `sidebar_action` asks for no permission.
- **The panel opens from the button of the popup**, which calls the browser in its click. The click
  on the toolbar icon still opens the popup (`setPanelBehavior({ openPanelOnActionClick: false })`).
- **And from the button of the widget the extension mounts that shows every note** (FRU-469): the
  widget posts `open-panel-request` on the bridge, and the background opens the panel of the tab the
  browser reports as the sender, before any `await`. **A script of a site the reviewer turned on can
  post that request too.** The condition that bounds it: the bridge carries it only while the window
  holds the activation of a gesture of the person (`navigator.userActivation.isActive`, read in the
  isolated world, which no script of the page can set), and Chrome refuses `sidePanel.open` with no
  gesture anyway (measured on Chromium 156: a click on the page opens it, a timer of the page is
  refused). So a page can open the panel only in the seconds after a click or a key of the person on
  it, once in 2 s per tab (test:`answers a tab once in an interval, and each tab apart`,
  test:`is carried only while the window holds the activation of a gesture (review of #648)`). It
  gains nothing: the panel is a page of the extension that reads nothing of the site, and the answer
  says only whether it opened. A page where Fruitback is not on cannot reach the bridge.
- **What it reads.** The address of the active tab of its window, as the popup does: the browser
  gives it only for a site the extension has access to, or after the click on its icon. With it, the
  rule of that site from the extension's storage. It reads no worker and keeps nothing.
- **What it asks the widget of the tab (FRU-299, FRU-300).** Five commands, under the guard of the popup's:
  the bridge takes them from a page of the extension only, never from a content script or another
  extension (`acceptedRequest`; test:`are refused when a page sends them`). `notes` answers the notes
  the widget already read for its pins: no request. `focus-note` and `mark-note` move and mark a pin.
  `reply` sends a reply by the path of the thread of the widget (FRU-257): the same route, the same
  transport, so the relay in team mode, and the same rule of who may reply. `check` (FRU-300) sends
  a verdict the same way, to `POST /feedback/<id>/check`: the worker decides who may, and when. The widget answers only
  for the widget the extension mounted; a site's own widget is the site's.
- **What the page can do with it.** The answer of `notes` crosses the main world, which the page
  writes in: a page can hand the panel notes of its own making, as it can already draw anything in
  its own tab. The panel bounds them (`parsePanelNotes`: 500 notes, 10,000 characters a text) and
  writes them as text, never as markup. The widget tells the panel when its notes change
  (`notes-changed`, then a message of the bridge); the message carries no note, only « read again »
  and the id of a note to open, and the panel takes it from the tab it follows only. A page that
  forges one buys a read of its own notes, or an open row.

### The files of a note, in transit (FRU-331)

**Fruitback stores no file of a note: the ticket of the tracker does** (decision of 2026-10-20,
FRU-198). The one image it keeps is the logo of a workspace, below. A
note that goes to a tracker can carry files: a capture of the page or of an area, an image, any file.
Each one waits in the database of the worker until the tracker has it, and no longer.

- **Who sends one: a session of the workspace of the site, a guest on a site shared with them, and
  nobody else.** `POST /attachments?client=<site>` takes the session token of the extension, and
  keeps the file when the token is a session of the workspace of that site, its person reads that
  site now, and the session is still valid in the store (`writerIn`, as every write). No token, a
  token of a site, a session of another workspace: `401`. test:`is sent by every role of the workspace, a guest on a site shared with them, and by nobody else`.
- **Only the sender names a file, in a note of the same site.** `POST /feedback?attachments=<id>,…`
  hands the files to the store of the site with the note. A file of another person, of another site,
  taken by another note, or past its transit answers `410 attachment-gone`, and nothing is written.
  test:`answers 410 attachment-gone for a file of another person, another note, or past its transit, and writes nothing`.
  A batch takes no file (`400 attachments-in-batch`).
- **A note with no tracker takes no file.** A site whose notes stay in Fruitback, or go to GitHub,
  whose API takes no file, answers `409 attachments-not-taken`, on the file and on the note; a read
  says it to the widget with `canAttach: false`.
- **The worker checks the type against the bytes, and the size.** An image must start as PNG, JPEG,
  WebP or GIF start, a PDF with `%PDF-`, a text must be UTF-8 with no NUL byte; any other file is kept
  and sent as `application/octet-stream`, whatever its sender said. Nothing is decoded. The limits:
  10 MB for an image, a PDF or another file, 2 MB for a text, 5 files and 25 MB for one note, 20
  files a minute for one session (`429 rate-limited`, whatever its address), and 50 files or 100 MB
  in transit for one account (`429 transit-full`). The limit of all requests by address
  (`RATE_LIMIT_PER_MINUTE`) is counted before any of them. A refused file is not kept
  (`admitFile`, `admitNote` of `attachments.ts`). The name is cleaned of its
  path, its control characters and its quotes, and cut at 120 characters.
- **How long: until the tracker has it, 7 days at most.** Linear takes the bytes before the issue is
  written (`fileUpload`, then a `PUT` to the address Linear gives, https only), then
  `attachmentCreate` names the file on the issue; the file leaves the worker at once. A file that
  Linear does not take before the issue is written stays, and the note is refused with `502`: the
  widget sends both again. Once the issue exists, a file that Linear refuses is lost and leaves the
  worker too. A REST address gets each file by an address of one hour in the signed body of each
  attempt (below); the file goes one hour after the delivery arrived. Every file ends 7 days after it
  came, whatever happened: it reads as absent from then on, and the loop of the deliveries and each
  new file sweep it. A note whose delivery arrives later goes without it.
- **Fruitback serves no file of a note to a person.** No route answers a file of a note to a member, a
  guest, a page or a browser: `GET /screenshot/<id>` is gone. The logo of a workspace is no file of a
  note: its read is below. The one read is
  `GET /attachments/<id>?expires=…&signature=…`, for the receiver of a delivery: an HMAC-SHA256 of the
  id and the end, with a key derived from `FRUITBACK_SECRETS_KEY`, compared in constant time, that
  answers for one hour and only for a file that a note took; anything else is `404`, as a file that
  does not exist. It answers as a download (`Content-Disposition: attachment`), with no CORS header,
  `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`,
  `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: private, no-store`. Whoever holds
  the address in that hour reads the file: the address travels only in the body of the delivery,
  over https, to the address the workspace connected.
  test:`answers 404 to a signature that ended, that is not this one, or to a file no note took`.
- **The pictures of before FRU-331** end 7 days after the migration, which deletes none; the sweep
  removes them then. Until then a waiting delivery whose note names one carries it by a signed
  address, and a note of before sent again by its sender goes with it; nothing else reads them.
- **Who reads a file after: the people of the tracker.** A read of the page says the names of the
  files of a note and the address the tracker gave each, for the readers of the note; a guest reads
  the names only, as a guest reads no reference of a tracker.
- **The capture of a page or of an area needs `activeTab`, or `<all_urls>`** (FRU-332, FRU-425):
  `activeTab` by a gesture on the page, or `<all_urls>` when the reviewer turned on « Allow captures
  on every site » (below), with no gesture then. The background takes it only for a site of a workspace in team mode, on an https
  worker, with a session, and answers the PNG to the widget, which sends it like a file of the disk.
  What the page decides is the area, and nothing else: it buys a capture of its own tab, that goes to
  the worker of its own entry with a session it never sees, and only when `activeTab` was granted or
  `<all_urls>` is held.
  The widget is hidden while the capture is taken.
- **« Allow captures on every site »** (FRU-425) is `<all_urls>`, in `optional_host_permissions`:
  nothing asks for it at install, and the popup never asks for it. Only the switch of the options
  page does, in its click, and the row quotes the browser's own warning (Chrome: « Read and change
  all your data on all websites », measured with `getPermissionWarningsByManifest`). **What it gives
  the extension:** `tabs.captureVisibleTab` with no gesture on any tab, and, since it is a host
  permission on every origin, access to every page the scripting API could reach. **What the
  extension does with it:** the capture, under every condition above; the content scripts stay
  registered for the sites the reviewer turned on, and only those (the `sync` of `background.ts`
  starts from the rules that are on, then checks the grant of each). **`<all_urls>` grants no rule**
  (`src/site-grant.ts`, review of #560): the grant of a rule is read from `permissions.getAll`,
  leaving out `<all_urls>` and the pattern of every web page, because `permissions.contains` says
  `true` for every origin once `<all_urls>` is held. A site whose access the reviewer removed in the
  browser stays off, and reads « not granted », with the switch on. Turning the switch off removes `<all_urls>`
  (`permissions.remove`). Whether Chrome then keeps a grant made before for one site is not
  measured: a rule that reads « not granted » after asks again.
- **« Capture with Fruitback », in the context menu of a page** (FRU-423), is the `contextMenus`
  permission. It grants no host, no content script and no read of a page: it puts one item in the
  menu of a web page (`http` and `https` only), and Chrome shows no warning for it (measured on the
  built manifest with `management.getPermissionWarningsByManifest`, `e2e/context-menu.spec.ts`).
  **A click on the item is a gesture of the person**, which the browser answers by granting
  `activeTab` on that tab until it navigates, as a click on the icon does. The item then sends the
  widget of the tab the command `capture-area`, by `tabs.sendMessage`; a tab with no widget of the
  extension answers nothing. No page can click the item, and the capture keeps every condition above.

What a capture shows is whatever the page showed on the screen, the open composer of the widget
included when it covers it.

### The logo of a workspace (FRU-428)

A workspace can have a logo, which the console shows in its rail and on the screen of its settings.
`/console/workspaces/<id>/logo`, under every rule of the console API (the cookie of a session, the
`Origin` of the console for a write, `404` for a workspace somebody is not of):

- **Who sends it, and who removes it: the owner and the admins of the workspace** (`manage-workspace`,
  as for its name). `POST` with the bytes as the body, `DELETE` to remove it. A member or a guest:
  `403`. A suspended workspace refuses both, as every write (`409 workspace-suspended`).
  test:`refuses a member and a guest, as every route of who manages a workspace, and changes nothing`.
- **Who reads it: every member of the workspace, whatever their role**, guests included: they read its
  name already. Nobody else: `404`, and `401` with no session.
- **What the worker takes: a PNG, a JPEG or a WebP of 512 KB at most, and no SVG.** An SVG is a
  document that can run scripts, and the worker has no sanitizer it trusts: it answers
  `415 unsupported-type`, as for a GIF or any other type, before it reads the body. The worker checks
  the bytes and not the word of the sender: they must start as the type says, and the header of the
  image must say a size of 4096 pixels at most on each side (`400 type-mismatch`,
  `400 image-too-large`), so that 512 KB that say 30000 × 30000 pixels never reach a browser that
  would decode them. Over the size: `413 payload-too-large`, read under that cap. Nothing is decoded
  and nothing is resized (`checkLogo` of `workspace-logo.ts`): the console shows it at a fixed size.
  The bytes are kept as they came, metadata included (a JPEG can carry where it was taken).
  test:`refuses an SVG, a GIF, bytes that lie, too many pixels and too many bytes, and keeps the logo of before`.
- **How it is read: with headers that run nothing.** `Content-Type` is the type the worker checked,
  never another; `X-Content-Type-Options: nosniff`; `Content-Security-Policy: default-src 'none';
  sandbox`, should a browser open it as a document; `Cross-Origin-Resource-Policy: same-site`, so the
  `<img>` of the console reads it with the cookie of its session, which no page of another site sends;
  `Cache-Control: private, max-age=86400`. The address (`logo` of a workspace in `/console/me`, or
  `null`) changes with each logo (`?v=`): a member who left can keep the copy of their own browser for
  one day, and nobody else.
  test:`lets the owner and an admin send it, and every member reads it with the headers that run nothing`.
- **How long: until it is replaced or removed, or its workspace is deleted**, which takes it with it.

### The agent keys of a workspace (FRU-461)

An agent key lets an agent with no browser (Claude Code in CI, a cloud agent) reach the notes of some
sites of one workspace. It is the identity of the remote MCP server that FRU-463 adds; this slice
makes, lists and revokes the keys, and reads what a key reaches. `docs/decisions/agents.md` gives the
framing. `/console/workspaces/<id>/agent-keys`, under every rule of the console API (the cookie of a
session, the `Origin` of the console for a write, `404` for a workspace somebody is not of):

- **Who makes, lists and revokes a key: the owner and the admins of the workspace**
  (`manage-workspace`). A member or a guest: `403`. A suspended workspace refuses a new key and a
  revocation, as every write (`409 workspace-suspended`).
  test:`refuses a member and a guest, as every route of who manages a workspace, and writes nothing`.
- **The worker keeps the SHA-256 digest of a key, never the key.** The key is 32 random bytes after
  the prefix `fbk_`, so that a scanner of secrets finds one that leaked. The answer of its creation
  holds it, once; the list and every later answer hold its name, its sites, its rights and its dates
  only. A key is found by its digest, on a unique index. Somebody who reads the database does not
  get a key from it.
  test:`lets the owner and an admin make a key, shown once, and lists it with no key and no digest`.
- **A key reaches one workspace, and only the sites it names**, 20 at most, each a site of that
  workspace (`400 unknown-site` otherwise). A site that goes leaves the keys that name it, and a key
  with no site left reaches nothing.
  test:`never reaches a site it does not name, nor one of another workspace, and nothing once its sites are gone`.
- **A key never does more than the member who made it, read again at each request.** That member
  removed, or their account suspended: the key reaches nothing. Made a guest: the key reads only the
  sites it names that are shared with them. The right `write` holds only while that member may
  manage the sites (`manage-sites`).
  test:`reaches nothing once its member is removed, or their account is suspended`,
  test:`writes no more once its member is a member, and reads only the sites shared once they are a guest`.
- **On a site that everyone reads, a key reads only the notes of a known person by default**
  (`verifiedOnly`, decision 7 of `agents.md`): a member, or a reviewer the site's identity
  verified. Anybody writes the other notes, and an agent can obey their text. The owner or an admin
  turns it off at the creation of the key, knowing it; an agent cannot turn it off. `/mcp` (FRU-463)
  applies it.
- **A key ends.** It lives 90 days unless its creator chooses from 1 to 365 days; no key lives with
  no end. At its date it reaches nothing. A revocation deletes it at once.
  test:`ends at its date, and not before`.
- **The last use of a key is kept, to the minute** (FRU-462), so that the owner and the admins see a
  key that is still used, and one that nobody uses any more. A request of `/mcp` that the key opens
  writes its instant in `agent_keys.last_used_at` when the one kept is a minute old or more; a
  request it refuses (a browser, a method or a version of the protocol it does not take, a body it
  cannot read, an expired key, a suspended workspace) writes nothing. It holds no
  address, no tool and no argument: the writes of a key are its log (FRU-464).
  test:`notes the last use of a key once a minute, and not on a request it refuses (FRU-462)`.
- **What a key does not protect**: whoever holds a key reads what it reaches until it ends or is
  revoked, from anywhere. A workspace holds 20 keys at most.

### The trigger of a site that starts an agent (FRU-468)

A site can call an address of the team when a note arrives, which starts the team's agent; the agent
then reads the note through `/mcp` with its key. `docs/decisions/agents.md`, « Starting an agent on a
note », gives the framing.

- **Off by default, and set by the owner and the admins only** (`manage-workspace`), at
  `/console/workspaces/<id>/sites/<site>/agent-trigger`, under every rule of the console API. A member
  or a guest: `403`.
  test:`refuses a member and a guest, and a connector of another workspace`.
- **The address is an address that receives of the same workspace** (a `rest` connector): the call is
  a delivery of the REST connector, with every guard above (https, no private address at each
  attempt, no redirect, `508` on a loop), signed with its secret. A Linear or GitHub source, or an
  address of another workspace, is refused.
  test:`writes the trigger of a site to an address that receives of its workspace only, and drops it with its address`.
- **The call carries ids only**: the workspace, the site, the identifier and the id of the note. Not
  its text, not its files: an agent reads them through `/mcp`, so its key decides what it reads.
  test:`queues one call with the ids of a note of a member, and none for a note of a visitor`.
- **A note of a visitor never calls**: only a note whose reporter the worker verified (a member, or a
  reviewer the identity of the site signed). Anybody writes the other notes, and a call starts code
  of the team.
- **« Moved to To do » calls only for a person**: the console or the extension, with a session, on a
  note that the worker keeps, at the move into the stage To do. An agent key that sets a status never
  calls, so an agent cannot start itself.
  test:`never calls for an agent key that sets a status: an agent cannot start itself`.
- **What it does not protect**: what the agent does once started is the team's. `docs/agents.md` says
  to let it open a pull request for review, and never push to a branch that deploys; Fruitback cannot
  hold that rule. A known person can start the agent as often as they leave notes.

### The remote MCP server, `/mcp` (FRU-463)

[docs/agents.md](docs/agents.md) is the guide for a team. An agent reads the notes of the sites of its
agent key (FRU-461) through `POST /mcp`, the Streamable
HTTP transport of MCP. Three tools, all reads: `list_feedback`, `get_feedback`, `feedback_as_text`.

- **No valid key, no route.** No key, a key of another shape, a revoked or expired key, a key whose
  member left or was suspended, and a key of a suspended workspace: `401` with
  `WWW-Authenticate: Bearer resource_metadata="…"` where OAuth is on (FRU-467, below), so that a client
  finds where to get a token, and `error="invalid_token"` when a key or a token was presented. The
  answer is the same for each, so a caller learns nothing of which. Where OAuth is off, `404`, as a
  path that does not exist; a worker with no database has no key, and answers `404` too.
  test:`answers 401 with no key, a key it does not know, an expired one and one of a suspended workspace`,
  test:`answers 404 at /mcp, as before, when OAuth is off`.
- **No browser.** A request with an `Origin` is refused (`403`): a page cannot call `/mcp` with a key
  it read somewhere, and the transport asks a server to refuse the origins it does not expect.
  `GET` answers `405`: the server opens no stream and keeps no session.
- **A key reads the sites it names, and no other.** A site out of the key, of another workspace or that
  does not exist answers as one that does not exist; so does the id of a note of such a site.
  test:`never answers a note of a site the key does not name, nor of another workspace`.
- **On a site that everyone reads, a key reads only the notes of a known person** unless the team
  made it with `verifiedOnly: false` (FRU-461): `reporter.verified` is `true`, the word of the
  worker. A site that only its members read is read whole.
  test:`reads only the notes of a known person on a site that everyone reads, unless the key says otherwise`.
- **A key whose member does not see the tracker reads no reference of it**, as a guest in the
  console. test:`gives a key of a guest no reference of the tracker`.
- **The text of a note is data.** Each note is an object of its own in `structuredContent`, and the
  text of every answer starts with a fixed line that says so. **Nothing stops an agent from obeying a
  note**: the key, its sites and `verifiedOnly` bound what it reads; what it does with it is the
  team's.
- **What a read costs a store**: each page of the answer is one read of the page, through the read
  cache of `GET /feedback`. The rate limit per address applies.
- **A key writes only with the right `write`, and while its member may manage the sites** (FRU-464):
  `reply_to_feedback` and `set_feedback_status`. A key `read`, or a key whose member no longer has
  `manage-sites`, is not given them, and `tools/call` refuses them (`-32602`).
  test:`gives a key read no write tool, and refuses both when it calls them`.
- **A reply of an agent says that it is one**, and never names the member who made the key: its
  first line is `**<name of the key>** via Fruitback · agent`, and a read gives it `by: 'agent'`. A
  person who types that line in a reply of the page does not pass for an agent: what a person typed is
  quoted under the line of the worker. A person of the team can write the line by hand in the tracker,
  as for a verdict (FRU-294). test:`never reads a reply that a person typed as a reply of an agent`.
- **A status is set only on a note that the worker keeps**; a note in a tracker answers
  `statuses-not-taken`.
- **Each key writes 30 times a minute at most, and each write is in the log of its key**: the
  owner and the admins read it at `GET /console/workspaces/<id>/agent-keys/<key>/writes`, the
  newest 100. The log of a revoked key stays until its workspace goes.
  test:`stops a key after 30 writes in a minute, and keeps the log of a revoked key`.

### OAuth for `/mcp`, for a connector of claude.ai (FRU-467)

A client that connects from a page (a connector of claude.ai, an MCP client) gets a token for `/mcp`
by OAuth 2.1, as the authorization of MCP (2025-06-18) asks, in place of an agent key pasted by hand.
`apps/worker/src/oauth.ts` is the server; `docs/decisions/agents.md`, « OAuth for MCP », gives the
choices. **A connection is an agent key with no secret**, tied to its client: everything above of a
key holds for it (one workspace, its sites, its rights, its end, its member read again at each
request, the log of its writes, the revocation in « Agents »). It is on when the worker has accounts,
`FRUITBACK_PUBLIC_URL` with no path and `FRUITBACK_CONSOLE_URL`; otherwise every route below answers
`404`.

The routes: `/.well-known/oauth-protected-resource` (also with `/mcp` after it, RFC 9728) and
`/.well-known/oauth-authorization-server` (RFC 8414), `POST /oauth/register` (RFC 7591),
`GET /oauth/authorize`, `POST /oauth/token`, `POST /oauth/revoke` (RFC 7009). They take no cookie,
and any origin may read them. The person approves at `/console/oauth/requests/<id>`, under the cookie
of the console.

**The threats, and what stands against each:**

- **A code sent to an address of an attacker.** A client registers its `redirect_uri`s, 5 at most,
  each `https` (or `http` on `localhost`, `127.0.0.1`, `[::1]`), with no fragment and no user, all on
  one host. `/oauth/authorize` compares the one it is given **byte for byte** with them: no prefix, no
  other path, no other case. Before that check passes, nothing goes back to any address: the worker
  answers a page of `400`, so it is no open redirector.
  test:`never sends a browser to an address the client did not register: a page says why`,
  test:`refuses an address that is not https, a fragment, two hosts, and a method it does not know`.
- **A code that leaks** (a log, a history, a header `Referer`). **PKCE with S256 is required**; a
  request with no challenge, or with `plain`, goes back with `invalid_request`. A code lives 60
  seconds, is kept as a digest, and turns into tokens only with its verifier, from the client it was
  given to, with the same `redirect_uri`. A code presented twice was seen by somebody else: the second
  exchange is refused, and **the connection it made is revoked**, with the tokens of the first.
  test:`refuses a code with another verifier, another address, another client, or after its minute`,
  test:`revokes the connection when its code is used twice`.
- **A forged answer (CSRF on the client, mix-up).** The worker gives back the `state` of the client
  untouched, and adds `iss` (RFC 9207), its own origin, to every answer that goes back, so that a
  client with several servers knows which one answered. Checking `state` is the client's.
- **A forged approval (CSRF on the console).** The consent page approves with the cookie of the
  console, and a `POST` comes from the origin of the console only, as `/connect`. The answer names the
  account the page showed: another account signed in since is refused (`409`). A request is answered
  once, approved or denied, and lives 10 minutes. Signing in on the consent page leads back to the
  question, never to an answer.
  test:`shows the host of the client, its name, and the workspaces the person manages, with their sites`.
- **A client that says it is another.** Anybody can register a client named « Claude ». The consent
  page writes, in large, **the host of the `redirect_uri`**, the one place the code can go, and the
  name the client gave in small, as its own words. A person who reads `claude.ai` approves a client
  whose codes go to `claude.ai` only.
- **A connection that reaches too much.** It reaches one workspace, chosen on the consent page among
  those where the person is an owner or an admin (`manage-workspace`, as for a key; a member or a
  guest cannot approve: `403`; a suspended workspace is not offered, and refuses an approval with
  `409 workspace-suspended`, as every write of the console), only the sites ticked, and only `read` unless the person chose
  `write` **and** the client asked the scope `write`. `verifiedOnly` is on by default, as for a key.
  The token says the scope granted. A token is for `/mcp` of this worker only: a `resource` (RFC 8707)
  that names another answers `invalid_target`.
  test:`gives an access token that reads only the sites the person chose, with the rights chosen`,
  test:`offers no suspended workspace, and makes no connection in one`.
- **A token that leaks.** Every token is 32 random bytes after a prefix (`fba_` access, `fbr_`
  refresh, `fbc_` code, `fbs_` the secret of a client), so that a scanner of secrets finds one; the
  worker keeps the SHA-256 digest of each, never the token. An access token lives **one hour**; a
  refresh token **30 days**, and neither outlives its connection (90 days by default, 365 at most).
  `/mcp` takes a token in the header `Authorization` only, never in an address, and refuses a request
  of a browser (`403`).
- **A refresh token that is copied.** A refresh token is spent once, in one statement, and replaced
  by a new pair. **A spent refresh token presented again revokes the connection**: either the client
  or the thief holds a copy, and the worker cannot tell which (OAuth 2.1, 4.3.1). A refresh token
  turns into tokens only for the client it was given to.
  test:`turns a refresh token once into a new pair, and revokes the connection when a spent one comes back`,
  test:`refuses a refresh token of another client, and an access token that ended`.
- **A connection that should end.** « Revoke » in « Agents » deletes it, and its tokens with it (a
  foreign key in cascade): `/mcp` answers `401` to its next request, and its refresh token turns into
  nothing. So does `POST /oauth/revoke` with one of its tokens, from its own client only. Its member
  removed or suspended: it reaches nothing, as a key.
  test:`ends every token when the person revokes the connection in « Agents »`,
  test:`revokes the connection by RFC 7009, for the client that holds the token only`,
  test:`ends the connection when the member who approved it is suspended, as a key`.
- **A flood of registrations.** Registration is open, as claude.ai needs: 10 an hour from one
  address, beside the limit of every route. A client that nobody approved is deleted after a day, and
  the instance holds 1,000 such clients at most: past that, **the oldest that nobody approved goes, and
  the new one is written**, never refused. A flood from many addresses can push out a client that waits
  for its person (its connector registers again), but cannot keep claude.ai from registering, nor touch
  a client that a person approved.
  test:`holds 1000 clients of OAuth that nobody approved: the oldest goes, and a new one is always written`. A client that asks for a secret
  (`client_secret_basic` or `client_secret_post`) gets one, once, kept as a digest; a public client
  (`none`) has PKCE alone, as OAuth 2.1 allows.
  test:`registers 10 clients an hour from one address, and deletes the stale ones nobody approved`,
  test:`asks a confidential client for its secret, in the form or in Basic`.
- **The worker fetches nothing a client names.** The « Client ID Metadata Document » of the version
  2025-11-25 of MCP would have the worker fetch an address given by anybody (a request forged on the
  server); it is not taken. Registration is by RFC 7591 only.
- **What it does not protect**: whoever holds a valid access token reads what the connection reaches
  for up to an hour after a revocation of the refresh token alone, but not after « Revoke » or a
  replay, which delete the access tokens too. The client (claude.ai) holds the tokens on its side, and
  the model it runs reads the notes: what it does with them is the team's, as for a key
  (`docs/agents.md`). A connection whose code was never exchanged stays in « Agents » as never used,
  with no token, until it is revoked or ends.

### The administrator of the instance (FRU-261)

Mathieu, 2026-10-18: « le premier compte utilisateur est forcèment admin lors de sa création sur
l'interface, géré par better-auth avec le flag admin en base ». The Cloud runs the same code.

- **Who.** The account whose `role` of `user` is `admin`, and that is not banned. No variable names an
  administrator. A role that holds a list (`admin,user`) is no administrator.
- **How one becomes it.** The first account of the instance, in the transaction that creates it: a
  trigger of the database (`0016_first_admin`) gives the role to a new account when the table of
  accounts is empty, under an advisory lock, so two first sign-ins at the same moment make one administrator
  (test:`makes one administrator: the second account waits for the first to commit`, and its control
  without the lock). On a database that had accounts, the migration gives it to the oldest one. In
  self-hosting the first account is the one of the link of `FRUITBACK_FIRST_ADMIN` when nobody signed
  up before it. **A later account never becomes the administrator**, also when no account has the
  role: an instance that loses its last administrator has none until its operator writes the role in
  the database. The route below never takes the role from the last one. An instance whose accounts are all deleted is empty again, and
  its next account is its first. The route that deletes an account (FRU-285, below) never deletes
  the administrator who asks, nor the last one, so only the operator can get there.
- **The admin plugin of better-auth is not mounted, and the worker refuses to start with it**
  (`REFUSED_PLUGINS`): it serves fifteen routes under `/console/auth/admin/`, one of which signs in as
  another person. The worker keeps its four columns of `user` only. Each route of the plugin answers
  `404`: test:`closes every route of the admin plugin of better-auth, which the worker does not mount`.
- **The guard.** The routes under `/console/admin/` read the cookie of the console, then the role, in
  the database, **on every call**: a role taken away a second ago is refused at the next call, with
  the session still open. Any other caller gets `404`, as for a path that does not exist, whatever the
  method. `ADMIN_ROUTES` and `ADMIN_WRITE_ROUTES` of `instance-admin.ts` are the only tables, read after the guard:
  test:`answers 404 on every route of the table to an account without the role, and to nobody, and 200 to the administrator`.
- **What they read.** The configuration of the instance by the names of its variables (whether each
  means of sign-in is on, the public address, the sender of the mail, the schema of the database and
  never its address), the connectors that need attention, every workspace (owners, members and roles,
  sites and their visibility, destinations, counts of notes by stage and of deliveries that did not
  arrive), and every account (workspaces and roles, ways to sign in, last day seen, invitations that
  wait). **No answer holds a secret, a token, a digest or a key of a connector**, not even masked,
  and only `notes` holds a note:
  test:`answers no secret, no token, no digest and no key on any route, and a note on the route of the notes only`.
  No route of the administrator writes anything but the trace, except the role, the suspension of
  an account, the suspension of a workspace, the deletion of a workspace, the writes in a
  workspace and the deletion of an account below.
- **The notes** (FRU-272, `GET /console/admin/notes`). Every note of the index, of every workspace:
  its workspace, its site, its page, its stage, its date, its way (`script` or `extension`), the kind
  of its author and never a name, where it went, the reference and the link in the tracker, and **the
  excerpt of 64 characters**. **The whole text only for a note that the worker keeps** in `notes`:
  the site of the row and the id that the widget gave the note must be the ones of the index, because
  a tracker can name an issue `FB-12` too and a page writes the ids of its notes. A note that went to
  a tracker has its excerpt and nothing more: **the worker calls no tracker to read more**, with the
  key of a client, for somebody that client did not give it to.
  test:`answers the text of a note the worker keeps, and of a note of a tracker its excerpt only`,
  test:`calls no tracker to read the notes, and the control sees the call of a read of Linear`. The
  same on the Cloud and in self-hosting.
- **The trace.** Each read that names a workspace the administrator is not a member of writes one row
  in `admin_reads` (who, which read, when) before the answer leaves, and a row that cannot be written
  fails the read. A list traces the workspaces of the rows it answers, at most 100: its `total`
  counts the matches of a search beyond that page with no row. `GET /console/workspaces/<id>/admin-reads` answers the rows to an owner of that
  workspace, `403` to another member and `404` to anybody else. **The trace is written by the worker,
  in its own database**: whoever runs the database can read it without the console and leaves no row.
- **Who gives the role, and who takes it away** (FRU-280). An administrator only, with
  `POST /console/admin/users/<id>/instance-admin` and `{ admin: true | false }`, behind the same guard:
  any other caller gets `404`, and so does a call with no `Origin` of the console. The route refuses
  with `409` in two cases:
  - `last-admin`: the account is the last administrator of the instance;
  - `self-removal`: the administrator takes the role from themselves, also when another one stays.

  **The checks and the write are in one transaction, under an advisory lock**: the lock of the trigger
  of `0016_first_admin`. The transaction reads the role of the target, counts the administrators, and
  reads again that the caller is one, after the lock. So two administrators who remove each other at
  the same moment leave one: test:`removes one of them: the other gets « last-admin », and one administrator stays`.
  A role taken away ends the access of its account at its next call, with the session still open:
  test:`refuses a removed administrator at their next call, with their session still open`. The
  operator of the database can still write any role, and the worker sees no such write.

- **Each action that changes a role writes one row in `admin_actions`**, in the transaction of the
  change: who acted, which action (`admin-named`, `admin-removed`), on whom, and when. The addresses
  stay after the accounts go. A row that cannot be written changes no role:
  test:`changes no role when its action cannot be written`. A call that changes nothing (the role is
  already the one asked) writes no row. The administrators of the instance read the rows with
  `GET /console/admin/actions`; an action on the instance names no workspace, so no owner reads it.

- **Who suspends an account, and what a suspension ends** (FRU-281). An administrator only, with
  `POST /console/admin/users/<id>/suspension` and `{ suspended: true | false }`, behind the same
  guard. The route refuses with `409` in two cases: `self-suspension`, and `last-admin` for the last
  administrator that is not suspended. The checks and the write are in one transaction, under the
  lock of the role: test:`suspends one of them: the other gets « last-admin », and one administrator stays`.
  **A suspended account signs in by no way**: the link of an e-mail, the link of the operator,
  GitHub and Google all open their session in one hook of better-auth, and the hook refuses it:
  test:`signs a suspended account in by no way, and opens no session for it`. Without that hook a ban
  does nothing in better-auth 1.7.7, because its admin plugin is not mounted:
  test:`signs a banned account in by every way, and keeps its session, without the checks of the worker`.
  **Every session of the account ends**: the sessions of the console are deleted in the transaction,
  and the sessions of the extension and their codes are ended after it. **Each token is refused at
  its next call, whatever ended or not**: the cookie, the console API, an access token of either kind
  of session, a refresh, a pairing code, an approval in the console that was not claimed yet, and
  the `pair` command each read the ban at each call:
  test:`refuses the cookie on every route that reads it, and every token of the extension`.
  **A restored account signs in again, and its old sessions stay ended**, on one condition: an access
  token minted before the suspension reads for the rest of its ten minutes, as the token of a member
  who was removed. It refreshes nothing and writes nothing:
  test:`restores an account: it signs in again, and its old sessions stay ended`. Each change writes
  one row in `admin_actions` for each workspace of the account at that moment, or one row with no
  workspace, and **the owners of each workspace read their rows beside the reads**, also after the
  account leaves or goes:
  test:`writes one row for each workspace of the account, and the owners of each read it beside the reads`.

- **Who suspends a workspace, and what a suspended workspace does** (FRU-282, « Lecture seule, avec
  un bandeau »). An administrator only, with `POST /console/admin/workspaces/<id>/suspension` and
  `{ suspended: true | false, reason? }`, behind the same guard. The reason is one line of 200
  characters at most, and **only the routes of the administrators of the instance answer it**
  (FRU-328): `/console/me`, the `409` of a write and the trace that the owners read say that the
  workspace is suspended and since when, never why, to its owners, members and guests alike:
  test:`answers the reason on no route that a member reads, and on the routes of the administrator (FRU-328)`.
  The banner of a member says the day and who to ask. An administrator can suspend a
  workspace that they are a member of. The check of the role and the write are in one transaction,
  under the lock of the role, so an administrator whose role is being removed is refused:
  test:`refuses the suspension: it waits for the removal, then reads that the account is no administrator`.
  While a workspace is suspended:
  - **its sites answer the widget and the extension as sites that do not exist**: the same status,
    the same headers and the same bytes, on `GET /feedback`, `POST /feedback`, the replies and
    `POST /attachments`, from the origin of the site, from another origin and with none:
    test:`answers every route of the widget that takes a site, for a site of a suspended workspace, with the bytes of an unknown site`.
    The origin of a site stops being allowed, unless a site of another workspace has the same one:
    test:`stops allowing the origin of a site that no other workspace has, as an origin that no site has`.
    `GET /session/sites` answers as if the workspace were deleted, `POST /session/sites` as for a
    workspace that does not exist. **No note is taken, and
    the notes that the worker keeps stay** in its database;
  - **its members sign in and read everything in the console**, and `/console/me` says the suspension;
  - **every write of the workspace is refused with `409 workspace-suspended`**, by one guard, after
    the role of the caller is read: a person who is not a member still gets the `404` of a workspace
    that does not exist. The guard covers every `POST` and `DELETE` under `/console/workspaces/<id>/`
    and every `POST` of the organization plugin that names the workspace, the acceptance of an
    invitation included:
    test:`refuses every write of the console API with 409 and writes nothing, and each one works after the restoration`,
    test:`refuses every POST of the organization plugin that changes the workspace, and lets a member leave`,
    test:`names every route of the console API that writes, and the guard comes before each one`.
    The way back from Linear keeps no connector. Two writes stay allowed: a member leaves the
    workspace, and its owner deletes it;
  - **its deliveries wait**: no attempt and no count, and the next pass after the restoration sends
    them: test:`sends nothing while suspended, counts no attempt, and sends after the restoration`.

  The list of the workspaces of the administrator takes `show=suspended` (FRU-328): the workspaces
  that have a row of `workspace_suspensions`, behind the same guard, with the same trace as every
  list, and `400` for a value it does not know:
  test:`lists the workspaces with their owner, their counts, their destinations and what did not arrive`.

  Each change writes one row in `admin_actions` (`workspace-suspended`, `workspace-restored`) with the
  workspace and the reason, in the transaction of the change, and **the owners read it beside the
  reads**, without the reason. A call that changes nothing writes no row, and a suspended workspace keeps its first
  reason. The tokens of the extension stay valid: they reach no site of the workspace. A session that
  a suspension leaves is ended by nothing, so a restoration gives it back its sites:
  test:`keeps the sessions of the extension: the same tokens read the sites again after the restoration`.
  An acceptance of an invitation tells the suspension to the person of the invitation only, without
  its reason. Another account that holds the id of the invitation gets the refusal of better-auth:
  test:`tells the suspension to the person of an invitation only, not to another account that holds its id`.

- **Who deletes a workspace that is not theirs, and what goes** (FRU-284). An administrator only,
  with `POST /console/admin/workspaces/<id>/deletion` and `{ name }`, behind the same guard: any
  other caller gets `404`, with the right name too:
  test:`answers 404 to every caller who is not the administrator of the instance, with the right name, and deletes nothing`.
  **The deletion is at once, and nothing undoes it.** `name` must be the name of the workspace, case
  included; only spaces at its ends are dropped. Another name gets `409 name-mismatch`, and nothing is
  deleted, revoked or written:
  test:`refuses a name that is not the name of the workspace, and deletes, revokes and writes nothing`.
  The deletion takes the path of the deletion by its owner (`dropWorkspace`): its members, its
  invitations, its sites, its connectors and their deliveries go, and **the notes that Fruitback kept
  for its sites go too** (FRU-194). The accounts of its people stay, and so do its other workspaces.
  The issues stay in the tracker of the client: the worker revokes the OAuth token of each Linear
  connector **after the commit**, so a refusal leaves the connectors working, and calls the tracker for
  nothing else. The sessions of the extension of the workspace end:
  test:`deletes the workspace with the notes Fruitback keeps, and leaves its people, the other workspaces and the tracker`,
  test:`ends the sessions of the extension of the workspace, and no other`.
  The check of the role, the check of the name, the action and the deletion are in one transaction,
  under the lock of the role, and the row of the workspace is held `FOR UPDATE`, so an administrator
  whose role is being removed is refused:
  test:`refuses the deletion: it waits for the removal, then reads that the account is no administrator`.
  **The trace outlives the workspace**: one row in `admin_actions` (`workspace-deleted`) with the
  address of the administrator, the moment, and in `detail` the id and the name of the workspace and
  the counts of what went. Its `workspace_id` is empty, as the deletion would empty it. The owners
  have no workspace left to read it in, so the administrators read it on the page Instance:
  test:`writes one action that outlives the workspace, with its name and what went, that the administrators read`.
  That page asks `GET /console/admin/actions?kind=workspace-deleted`, which names no workspace that
  exists, so its read leaves no trace with an owner:
  test:`lists the deleted workspaces alone with kind, and that read leaves no trace with an owner`.

- **What an administrator writes in a workspace they are not a member of** (FRU-283, « Directes,
  tracées »), behind the same guard, each a `POST` that any other caller gets `404` on:
  test:`answers 404 to an owner, an admin of the workspace and nobody, and writes nothing`.
  - `…/workspaces/<id>/members/<account>/role` `{ role }`: one of `owner`, `admin`, `member`, never
    `guest`, as `update-member-role`. **A workspace keeps an owner**: the last one is refused with
    `409 last-owner`, and the owners are counted under the lock of the role with the workspace held
    `FOR UPDATE`, so two administrators who demote the two owners at once leave one:
    test:`demotes one of them: the other gets « last-owner », and one owner stays`. A role that no
    longer invites cancels the invitations of that person, and a guest who becomes another role
    keeps no site of a guest, as after `update-member-role`:
    test:`cancels the invitations of a member whose new role does not invite, and the sites of a guest who is no longer one`.
  - `…/workspaces/<id>/members` `{ email, role }`: an account that exists, by its address.
  - `…/workspaces/<id>/owner` `{ email }`: that account becomes the owner, a member already or not,
    and **each other owner becomes an admin**: nobody loses access, and the same route undoes it.
    A suspended account cannot become an owner.
  - `…/workspaces/<id>/invitations` `{ email, role }`: an address with **no** account, as `admin` or
    `member`. The row is the one of an invitation of a member, with the administrator as its inviter,
    and its message goes under the same windows. An invitation is the word of whoever made it
    (FRU-209): the acceptance takes the word of an administrator while they are one, and refuses it
    with `INVITER_NO_LONGER_INVITES` once their role is taken away or their account is suspended:
    test:`stands behind an invitation while its administrator is one, and no longer once they are removed`.
  - `/console/admin/new-workspace` `{ name, owner }`: a workspace whose one owner is that account.

  Each write is one transaction under the lock of the role, with the workspace held `FOR UPDATE`, and
  runs one at a time with the routes of the organization plugin in this process (`oneAtATime`). **A
  suspended workspace refuses each one with `409 workspace-suspended`**:
  test:`refuses each one with 409 workspace-suspended and writes nothing, and each works after the restoration`.
  Each change writes one row in `admin_actions` (`member-role-changed`, `member-added`,
  `owner-changed`, `member-invited`, `workspace-created`) with the workspace, the address of the
  person and the role given, and **the owners of the workspace read it beside the reads**. A call
  that changes nothing writes no row.

- **Who deletes an account, and what stays** (FRU-285, D5 of FRU-260, decision 3 of 2026-10-19:
  « Refusé tant qu'il y a des workspaces »). An administrator only, with
  `POST /console/admin/users/<id>/deletion` and `{ email }`, the address of the account, behind the
  same guard. The route refuses with `409`:
  - `sole-owner`, with the workspaces that the account owns alone: **an account that owns a workspace
    alone is not deleted**, until another account owns it or the workspace is deleted:
    test:`refuses an account that owns a workspace alone, and lists those workspaces, until it has another owner`.
    A route of better-auth that takes the other owner away while the deletion runs waits for it, and
    is then refused by the trigger of the last owner (FRU-324, « A workspace keeps an owner » above);
  - `self-deletion`, `email-mismatch`, and `last-admin` for the last administrator. The checks and the
    deletion are one transaction under the lock of the role, with the workspaces of the account held
    `FOR UPDATE`, so two administrators who delete each other leave one:
    test:`deletes one of them: the other gets « last-admin », and one administrator stays`.

  **What goes**: the account, its sessions of the console, its ways to sign in, its memberships, the
  invitations it made and the sites shared with it, by the foreign keys; and **every session of the
  extension of the account**, ended before the transaction and again after it:
  test:`ends the sessions of the extension of the account, of its account and of each workspace, by the real transport`.
  An access token of an account lives its ten minutes, as one of a suspended account, and reaches no
  site: the account is in no workspace. **What stays**: its notes. A note keeps its text and stays in
  its tracker; the list of a workspace names its author « Former member », with no name, as for a
  member who left (FRU-244):
  test:`keeps the notes of the account, which the list names as of a former member, with no name`.
  `forget` stays the way to delete the notes of a person. Each deletion writes one row in
  `admin_actions` (`account-deleted`) for each workspace of the account, before the row goes, and
  **the owners of each read it**, with the address of the account:
  test:`writes one action for each workspace of the account, that their owners read after it goes`.

### Fruitback Cloud: what its host holds, and who reaches it (FRU-106)

This is about the instance that Sakuga runs, `api.fruitback.com` and `app.fruitback.com`, and not
about a self-hosted one. Its runbook is [apps/worker/cloud/README.md](apps/worker/cloud/README.md).
Each fact below comes from that runbook or from the record of the deployment (FRU-183, FRU-106);
what is not recorded is said so.

**The host is `em-sakuga-01`** (Paris), a Dokploy on Docker Swarm, **shared with other projects of
Sakuga**: the Cloud has no host of its own. A dedicated host is a decision to take again before the
first client from outside (FRU-106, decision of 2026-10-20). So whatever reaches that host, that
Docker or that Dokploy for another project reaches the Cloud too.

**What the host holds:**

- **The worker, and its environment, which holds every secret**: the address and password of the
  database (`FRUITBACK_DATABASE_URL`), `FRUITBACK_AUTH_SECRET`, `FRUITBACK_IDENTITY_SECRET`,
  `FRUITBACK_SECRETS_KEY`, the secrets of the OAuth applications (GitHub, Google, Linear), and the key
  that sends the e-mail (Scaleway Transactional Email, an IAM application limited to that service on
  the project of `mail.fruitback.com`). These values are in no image, no row of the database, no
  dump and no file of this repository. Dokploy keeps them to give them to the worker: where and how
  Dokploy stores them on the host is not recorded here.
- **The database**, PostgreSQL 17, with everything that
  [What the database keeps](#what-the-database-keeps-and-who-reads-it) lists: the notes, the accounts,
  the sessions as digests, and the keys of the connectors encrypted with `FRUITBACK_SECRETS_KEY`. It
  publishes no port. The worker reaches it on the network `dokploy-network`, without TLS: the two
  are on one host. What else is on that network is not recorded here.
- **The volume of the database**: the files of a database that runs, with the verifier of its
  password. The password is 40 random letters and digits.
- **The volume of the worker** (`/data`): the dump of each night (`snapshots/fruitback.pgdump`, all of
  the database, in the clear), and nothing else. The three SQLite files of before left it on
  2026-10-25 (FRU-393). The archives of 30 days up to that day still hold them: accounts, sessions as
  digests and notes of before 2026-10-15/16.
- **Dumps taken by hand** before each switch, and the last copy of the SQLite files
  (`sqlite-final-20261025/`), in dated folders of `/home/mheos/fruitback-cloud/`, mode `700`.
- **The console**: static files, and no secret. It serves the script of the widget itself: no
  third-party CDN sees the address of the visitors of a site (FRU-106).

**What leaves the host:** each night at 03:00, the backup of the host archives every Docker volume
to the bucket `backup-elastic-metal` on Scaleway Object Storage, for 30 days. That archive therefore
holds the dumps, the volume of the database and the files of before: all the data, in the clear
unless the archive is encrypted. **What of the secrets it holds:**

- not the values of the environment of the worker, as far as the dumps and the volumes of
  Fruitback go: no dump, no row and no file of the worker holds them;
- **the verifier of the database password**, in the volume of the database: a short password could
  be guessed from it, which is why the Cloud's is 40 random characters;
- **the keys of the connectors, encrypted** with `FRUITBACK_SECRETS_KEY`, in every dump: they open
  with that key, which the archive does not hold;
- the volumes of Dokploy itself, if it keeps any, since the backup takes every Docker volume of the
  host. Whether one of them holds the environment of the worker, and in what form, is not recorded
  here.

**Not recorded here either:** whether that archive is encrypted, whether the bucket is versioned or
locked, and whether a second copy is kept elsewhere (FRU-183, Q5).

**Where the secrets are apart from the host:** the Keychain of the operator's machine, one entry each.
Whether that Keychain is backed up, and whether the archive above holds a copy kept by Dokploy, is
not recorded here.

**Who reaches it:**

- **Whoever has access to Dokploy**, by its interface or its API, reads the environment of the
  worker, so every secret above. With them, a dump becomes a set of working keys.
- **Whoever can run Docker on the host** (root, and the user `mheos`, whose crontab runs the dump)
  reads the database, the volumes and the environment of each container.
- **Whoever reads the bucket** reads all the data of the archive (in the clear, unless the archive is
  encrypted), the encrypted keys of the connectors, and the verifier of the database password. It
  does not get the values of the environment from the dumps or the volumes of Fruitback; what the
  volumes of Dokploy would give is not recorded here.
- **Whoever holds the Keychain of the operator** holds the secrets, without the data.

**Not in place yet** (FRU-106, left to the operator): an alert on the read probe (`/health` does not
read the database), and a restore of a dump tried on the host.

### Personal data

The widget can send, from a third party's page: a hand-written note, a name, an address, the user
agent (`includeEnv`), the page URL, and a picture of what the person was looking at. All of it lands
in the database of the instance or in an issue tracker, and for the Linear and GitHub connectors that
is outside your own infrastructure.

That is a processing of personal data and a deployment of Fruitback has to be declared as one.
[docs/privacy.md](docs/privacy.md) lists every field, what is sent by default, where it is kept, and
how to delete a reporter's notes. It is not legal advice.

## What is not a vulnerability

- **A reporter typing somebody else's name.** With no token that is a claim, which is what
  `verified: false` means. Report a case where a claim comes back marked verified.
- **Pins readable on a site that everyone reads.** That is the visibility the person who added the
  site chose in the console. Report a case where a site that members read answers without a valid
  session.
- **Exceeding the rate limit from several addresses.** It is quota protection, not authentication.
  Report a bypass from _one_ address, or one that works by setting a header.
- **A page forging bridge messages on an origin its reviewer enabled.** Stated above, and inherent to
  the main world. Report a case where an origin nobody enabled can do it, or where a session token
  reaches the page.
- **A team-mode page asking the extension to relay a call.** That is the mode. Report a relay that
  reaches an endpoint the reviewer's entry for that origin does not name, a path other than
  `/feedback`, or one made with no session behind it.
