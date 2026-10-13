# Security

Fruitback puts a widget inside somebody else's page and a worker in front of somebody's issue
tracker. Both of those are trust boundaries, and this file says where they are.

**Writing the known limits down is the policy.** A file that only says "email us" leaves a
self-hoster to discover on their own that their read path is open to anyone who can build a URL.

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

Nothing is released yet. `@fruitback/shared`, `@fruitback/widget` and `fruitback` are at `0.2.0` and
**unpublished**; the worker image on GHCR is the only distributed artefact. There is no supported
version policy to state, and pretending otherwise would be the first thing in this file that is not
true.

`0.x` means the contract can change. Pin a digest rather than a tag if you need a build that cannot
move under you: no tag is immutable, `sha-<commit>` included, because rebuilding the same commit
republishes it under a new digest. See
[docs/decisions/image.md](docs/decisions/image.md).

## The threat model

Everything below is a property of the code as it stands, not an aspiration. Each one is somewhere a
self-hoster could otherwise be surprised.

### The read path is public by default

`GET /feedback` answers **anyone who can build the URL** unless you say otherwise. Every note, the
name and address its reporter typed, and the team's replies are readable by any visitor of the
client's site — and by `curl`. Hiding pins in a browser was never the fix.

A link that opens a note on its page, `<page>#fruitback-note=<id>`, opens nothing to somebody who
cannot already read that page: the widget opens the note among those `GET /feedback` answered to
this reader, and a refused read opens nothing. The id in the address is not a secret and gives no
access.

`FRUITBACK_READ=authenticated`, or `"read": "authenticated"` on a client, requires a signed identity
token. The default stays `public` for compatibility, so **an upgrade never closes it for you**. The
boot log names every client whose pins anyone can read, and `/health` counts them.

The widget sends that token in an `Authorization` header, which makes the request preflighted, so the
worker has to advertise the header in `Access-Control-Allow-Headers`. **It did not until this file
was written**, and the setting therefore answered nobody from a browser at all — the request was
refused by the browser before the worker saw it. Writing the mitigation down is what found that.

`FRUITBACK_HIDE_COMMENTS=1` keeps the team's replies out of the answer. Under `read: 'public'` that
is the only thing between an issue thread and the internet.

**It is the worker-wide fallback, not an override.** A client declared in `FRUITBACK_CLIENTS` with
its own `showComments` wins over it, so setting the flag on a multi-client worker does not close
every client — check each entry, or an operator who believes replies are hidden is wrong for the
ones that say otherwise.

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
direct caller reads nothing. Under the public default, `curl` reads every note on a page, and closing
that is `FRUITBACK_READ=authenticated`, not CORS.

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

### A seed is stored in the clear, in your issue tracker

The whole seed — note, page URL, selector, the reporter's name and address, the screenshot URL — is
stored as it arrived, and **where** depends on the connector:

| Store      | Where a seed lands                                                                              | Who can read it                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `linear`   | verbatim in an issue description                                                                | anyone with access to that workspace                                                                                 |
| `sqlite`   | `JSON.stringify(seed)` in a column of your database file                                        | anyone who can read the file, or a backup of it                                                                      |
| `postgres` | `JSON.stringify(seed)` in the `seed` column of the table `seeds`, in the database of the worker | anyone who can read that database, or a dump of it: the role of `FRUITBACK_DATABASE_URL`, and whoever holds a backup |
| `github`   | verbatim in an issue body                                                                       | anyone who can read that repository. **On a public repository, that is everyone.**                                   |

Whichever store, it outlives any expiry you had in mind, which is why an identity token travels in an
`Authorization` header and never in the seed. On SQLite the file and its backups are the boundary,
and they deserve the care a database of personal data deserves.

**On PostgreSQL one database holds the notes of every workspace** (FRU-218), in the clear, beside
the accounts. Nothing is sealed: `FRUITBACK_SECRETS_KEY` covers the keys of the trackers, not the
notes. What keeps one workspace from the notes of another is the read itself, which names its site
(`client_id`), and a read that names none gets the notes that name none:
test:`never gives a site of one workspace the notes of a site of another, on one page of one address`,
test:`gives a read that names no site the notes that name none, and never the notes of a site`.
`node server.mjs forget` deletes across every site of the worker: it is the command of whoever runs
the worker. The notes of a site that is removed stay in the table (FRU-194 will decide).

Tell your reporters not to type credentials into a feedback note, because the note is going to sit
somewhere for a long time.

### The GitHub App key

`FRUITBACK_GITHUB_PRIVATE_KEY` signs the tokens of the App. Whoever holds the key can mint a token for
every repository the App is installed on, with every permission the App has. The worker narrows each
token to one repository and one hour, but the key itself does not expire. So:

- Give the App **Issues: Read and write** and nothing else, and install it only on the repositories
  that receive notes.
- Keep the key out of the image and out of any repository, like `LINEAR_API_KEY`.
- If the key leaks, generate a new one, delete the old one under **Private keys** in the settings of
  the App, and restart the worker with the new key.

### The rate limit is per process, unless the worker has a database

`RATE_LIMIT_PER_MINUTE` (20 by default) is held in memory, per container, on a worker with no
`FRUITBACK_DATABASE_URL`. **Run N replicas of such a worker and the effective ceiling is N times what
you configured**, with nothing to see anywhere.

**A worker with a database counts there** (FRU-67), in the table `kv`: its replicas share one limit,
one count of the sign-in links and of the invitations of an address, and one read cache. No variable
turns it on. What follows from it:

- **Two replicas that count at the same moment get two different counts.** One statement counts, and
  PostgreSQL locks the row of the key. It runs on a real server, in CI:
  test:`gives each of 400 counts of one key to one caller, from two connections`.
- **A database that does not answer refuses the metered call**, with `503 limiter-unavailable`,
  rather than letting it through: a limiter that opens when its store stops is a limiter anybody can
  open. That holds below the limiter too: the count of the links and the ticket of the way to Linear
  answer the same `503`. `/health` reads no count.
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
[docs/self-hosting.md](docs/self-hosting.md#behind-a-reverse-proxy) has the cases and a check an
operator can run.

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
background service worker, which refreshes, and the popup, which pairs and logs out.
`chrome.storage.session` keeps its default access level, which excludes content scripts, and nothing
about a session travels on the `window.postMessage` bridge. A browser profile is now part of this
boundary: somebody who can read a reviewer's profile can read their refresh token, and revoking it is
the answer.

Pairing asks for a host permission on the **worker's** origin, which is not the site's. It is optional
and granted per worker at the moment somebody pairs, never at install.

### What the extension relays, and what it refuses to

In team mode (FRU-57) the site embeds its own widget and leaves it dormant. The extension puts a
transport on the page, and the calls it carries are made by the background service worker, which
attaches the session token. **The token never travels on the page bridge**; what travels is the
request and the answer.

That makes the extension something that will make a call for a page, so the background refuses more
than it accepts. It sends nothing unless all of the following are true:

|              |                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------- |
| The origin   | comes from the sender the browser reports, never from the message                             |
| The site     | has an entry the reviewer stored for that exact origin, switched on, in team mode             |
| The endpoint | is the one that entry names — a page asking for another worker is **refused, not redirected** |
| The path     | is `/feedback`, the one path the widget calls                                                 |
| The headers  | are rebuilt: `Content-Type` may come from the page, `Authorization` never does                |
| The session  | is open for that endpoint — with no session there is no call at all                           |
| The scheme   | is `https`, or loopback. A bearer token does not cross a plain `http://` connection           |

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

**`FRUITBACK_FIRST_REVIEWER` writes a pairing code in the log** (FRU-108). It is off unless the
operator sets it. A worker that holds no session yet then mints a code for the person the variable
names each time it starts, and writes it in the log of the container, in the clear: as a code, or as
a link when `FRUITBACK_PUBLIC_URL` is set. **Whoever reads that log while the code is valid pairs as
that person**, and gets their session: reading the log is then enough to become the first reviewer.
A log that is shipped elsewhere keeps the line after the code is dead. The code is an ordinary one:
valid 15 minutes, usable once, kept as a digest. Once the store holds a session, live or ended, the
worker mints nothing, so the variable left in place opens nothing later; a worker whose sessions
were all purged after their 30 days is a worker with no session again, so empty the variable once
paired. The worker refuses the variable with accounts or with a client that declares a workspace: a
session there names a workspace, and the variable names none. The browser never names the person.

**`FRUITBACK_SESSION_PATH` is a credentials file.** Give it the same care as a key: a copy of it is
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
storage and the seed holds a URL; whether that URL is public is your decision, not the widget's.

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
[docs/self-hosting.md](docs/self-hosting.md#change-fruitback_identity_secret).

### The accounts, and what decides who reads a site (FRU-96)

With `FRUITBACK_DATABASE_URL` the clients of the worker are the sites the console wrote, read from
that database on every request. A site is a client of one workspace, so a session reaches it only through
the `ws` check above. A site read by `members` is `read: 'authenticated'`; one read by `everyone` is
`public`, with the exposure that section describes. **A worker with accounts and no site serves no
client**: an empty map is not the absence of a map, which would answer every page to anybody. The
file holds addresses, names and the id each provider gives a person, no password, and no token of a provider
that signs a person in. Since FRU-121 it also holds the key of each connector, encrypted: see below. `FRUITBACK_CLIENTS` is refused beside it, so one map has one source.

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
- **« Sign out » ends the session, or says that it did not** (FRU-204). The console stays on « My
  account » with « You are still signed in » when the worker did not confirm. The refresh cookie
  of the path of before, which a browser could hold for 30 days, opens nothing since FRU-150: no
  route reads it.
- **The console holds no token** (FRU-148): no access token in its memory, nothing in `localStorage`
  or `sessionStorage`, and a cookie that `document.cookie` does not show. A script injected into the
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
  header of its own, over anything the caller sent, and better-auth reads no other one.
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
  worker from what the tracker answers when an admin sets the list, never from the request.
- **A member chooses with `POST /feedback?destination=<id>`.** The body stays the seed. An id the
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
(FRU-100). The console puts it after the `#` of the worker's pairing page, and the extension spends it
as it spends a code an operator minted. **A guest's session reaches every site of its workspace
today**: sharing one site with one guest is FRU-104, and until it lands the console creates no guest.

**The members of a workspace (FRU-149) and the invitations (FRU-104).** With better-auth on, ten
routes of its organization plugin are served under `/console/auth/organization/`, with the cookie of
the console. Each one has a rule in `ORGANIZATION_PATHS` (`organization-paths.ts`):

| Route                   | Who                                          | What it does                               |
| ----------------------- | -------------------------------------------- | ------------------------------------------ |
| `list-members`          | owner, admin, member                         | names, addresses and roles                 |
| `update-member-role`    | owner, admin                                 | owner, admin or member, not guest          |
| `remove-member`         | owner, admin                                 | the member, and their codes                |
| `leave`                 | anybody of the workspace, but its last owner | themselves                                 |
| `invite-member`         | owner, admin                                 | an address, as an admin or a member        |
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
- **An invitation gives `admin` or `member`, never `owner` and not yet `guest`**: a guest still
  reaches every site, so the console creates none (above). The role of an accepted invitation is
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
  shared through the database (FRU-67), this is not.
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
  reads the invitations sent to their own address, and no other. A guest reads the name of the workspace, their own role, and its sites
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

### The picture of a note, taken by the extension (FRU-44)

The extension can attach a picture of the element to a note: `tabs.captureVisibleTab`, cut to the
element in the background, sent to `POST /screenshot` of the worker of the site's entry. The widget
writes the address it gets back in the seed. The setting is off until the reviewer turns it on.

- **No new permission.** The capture needs `activeTab`, which the manifest already declares and the
  browser grants when the reviewer opens the popup on the page, until the page navigates. Without
  it the browser refuses the capture, and the note goes without a picture.
- **Only a session of a member sends a picture, and only a member reads it.** `POST /screenshot`
  takes the session token of the extension, a `client` (the site of the note), and keeps the
  picture for the workspace of that site when the token is a session of that workspace and its
  person is a member of it now. `GET /screenshot/<id>` answers the same members, and `404` to
  anybody else with a token, as for a picture that does not exist; `401` with no token. **« A
  member » is anybody of the workspace, a guest included**: a guest reads the notes, and the
  address of a picture is in its note. test:`is sent and read by a guest of the workspace, as by a member`. The address
  is no secret: 128 random bits, but the route asks who reads. **A picture is never readable like
  the pins of a site at `read: 'public'`**: what a public site may show is still open (FRU-84).
- **The guards of the write path.** The rate limit, the CORS of the sites and of the extension,
  `413` over 1 MB (`MAX_SCREENSHOT_BYTES`), `400` for bytes that do not start like a PNG, or declare
  a side over 8,192 pixels. A picture is answered with `Content-Type: image/png`, `nosniff`, a
  `Content-Security-Policy` of `default-src 'none'` and `Cache-Control: private, no-store`.
- **What the page decides is the area, and nothing else.** The capture request travels on the page
  bridge, which the page can forge: it buys a picture of its own tab, sent to the worker of its own
  entry, with a session it never sees, and only when `activeTab` was granted. The background refuses
  a request from a tab that is not the active one, and the endpoint, the client and the token come
  from the stored entry and the session, never from the message.
- **A worker with no database keeps no picture**: both routes answer `404`.
- **A picture is kept when its note is written, not when it is sent.** A note kept for later
  (FRU-124) holds the address of its picture in the seed that waits in the tab. A note that is never
  sent leaves a picture that no note names; it goes with its workspace, and nothing else removes it.

What the picture shows is whatever the element showed on the screen, the open composer of the
widget included when it covers the element.

### Personal data

The widget can send, from a third party's page: a hand-written note, a name, an address, the user
agent (`includeEnv`), the page URL, and a picture of what the person was looking at. All of it lands
in an issue tracker, and for the Linear and GitHub connectors that is outside your own infrastructure.

That is a processing of personal data and a deployment of Fruitback has to be declared as one.
[docs/privacy.md](docs/privacy.md) lists every field, what is sent by default, where it is kept, and
how to delete a reporter's notes. It is not legal advice.

## What is not a vulnerability

- **A reporter typing somebody else's name.** With no token that is a claim, which is what
  `verified: false` means. Report a case where a claim comes back marked verified.
- **Pins readable on a worker left at `read: 'public'`.** That is the documented default and the boot
  log says so. Report a case where `authenticated` still answers without a valid token.
- **Exceeding the rate limit from several addresses.** It is quota protection, not authentication.
  Report a bypass from _one_ address, or one that works by setting a header.
- **A page forging bridge messages on an origin its reviewer enabled.** Stated above, and inherent to
  the main world. Report a case where an origin nobody enabled can do it, or where a session token
  reaches the page.
- **A team-mode page asking the extension to relay a call.** That is the mode. Report a relay that
  reaches an endpoint the reviewer's entry for that origin does not name, a path other than
  `/feedback`, or one made with no session behind it.
