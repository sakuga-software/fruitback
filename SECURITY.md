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

Nothing is released yet. `@fruitback/shared`, `@fruitback/widget` and `fruitback` are at `0.1.0` and
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
  A rules file holds no session and no host
  permission, so an imported rule runs nowhere until the reviewer grants its pattern in their browser.

### `reporter.verified` is the worker's word

Anything a browser posts carrying `verified` has it stripped before storage, whatever else it says.
The flag is set only after an HS256 token verifies against the client's key. Without a token, a name
and an address are a claim by whoever was on the page, and they are stored as one.

### A seed is stored in the clear, in your issue tracker

The whole seed — note, page URL, selector, the reporter's name and address, the screenshot URL — is
stored as it arrived, and **where** depends on the connector:

| Store    | Where a seed lands                                       | Who can read it                                                                    |
| -------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `linear` | verbatim in an issue description                         | anyone with access to that workspace                                               |
| `sqlite` | `JSON.stringify(seed)` in a column of your database file | anyone who can read the file, or a backup of it                                    |
| `github` | verbatim in an issue body                                | anyone who can read that repository. **On a public repository, that is everyone.** |

Whichever store, it outlives any expiry you had in mind, which is why an identity token travels in an
`Authorization` header and never in the seed. On SQLite the file and its backups are the boundary,
and they deserve the care a database of personal data deserves.

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

### The rate limit is per process

`RATE_LIMIT_PER_MINUTE` (20 by default) is held in memory, per container. **Run N replicas and the
effective ceiling is N times what you configured**, with nothing to see anywhere. One container is the
ordinary deployment and the whole story; a store the replicas share is tracked as FRU-67.

The window slides, estimated from the current minute and the one before it. A caller who sends a full
burst at the end of a window and spaces the next ones out gets **at most 39 requests in any 60
seconds** through, for the default limit of 20. That is `2 × limit − 1`, and `rate-limit.test.ts`
holds the number against the code. A steady caller stays at the limit.

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
person; redeeming it opens a session.

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

**`FRUITBACK_SESSION_PATH` is a credentials file.** Give it the same care as a key: a copy of it is
not a set of working logins, but it is a list of who holds a session and until when. Back it up with
`sqlite3 … ".backup"` rather than `cp`, which loses the write-ahead log.

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

### The accounts, and what decides who reads a site (FRU-96)

With `FRUITBACK_ACCOUNTS_PATH` the clients of the worker are the sites the console wrote, read from
that file on every request. A site is a client of one workspace, so a session reaches it only through
the `ws` check above. A site read by `members` is `read: 'authenticated'`; one read by `everyone` is
`public`, with the exposure that section describes. **A worker with accounts and no site serves no
client**: an empty map is not the absence of a map, which would answer every page to anybody. The
file holds addresses, names and the id each provider gives a person, no password, and no token of a provider
that signs a person in. Since FRU-121 it also holds the key of each connector, encrypted: see below. `FRUITBACK_CLIENTS` is refused beside it, so one map has one source.

**With `FRUITBACK_DATABASE_URL` the same accounts are in a PostgreSQL database** (FRU-141), in place
of that file, and the worker refuses to start with both. The database holds what the file holds, in
tables of the same names, and nothing more: addresses, names, the id each provider gives a person,
the roles, the sites, the digest of each sign-in link, the key of each connector encrypted with
`FRUITBACK_SECRETS_KEY`, and the notes that wait for an address that receives them. It holds no
session: those stay in `FRUITBACK_SESSION_PATH`. Three things change with a database on a network,
and each has its condition:

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

A copy of the database is a copy of the file: no working login and no working key of a tracker,
while `FRUITBACK_SECRETS_KEY` is not with it.

**`GET /session/sites` lists the sites of the workspace a session belongs to** (FRU-101), to the
holder of its access token, while that person is still a member: the extension turns such a site on in
one click. It answers an origin, an id and a visibility per site, and the language of the account
(FRU-131), and nothing a member cannot already read in the console. The extension sends that language
to a page where it mounts the widget: it is a locale tag, and the page can read it. A console session names no workspace, and gets `401`. The entry the extension
stores is team mode, so the relay's refusals all apply: the widget it mounts calls through the relay,
and the page never holds the token.

### Signing in to the console (FRU-98)

`POST /auth/email` sends a link to the address it is given, and answers the same whether that address
has an account or not. It is limited to 3 links per address per 15 minutes, on top of the limit per IP
of every route. The link carries 256 random bits after a `#`, so no server and no proxy log sees it;
the accounts file keeps a SHA-256 digest of it, never the code. A link works once, for 15 minutes,
and the first redemption wins.

Opening the link proves the address, and only then does it become an account. The worker then mints a
pairing code for that account and spends it at once: the console's session is an ordinary session,
with the same rotation and the same replay detection. **Its refresh token is a cookie the console's
script cannot read** (`HttpOnly`, `Secure`, `SameSite=Strict`, on `/console/session` only), and the
console routes answer one origin, `FRUITBACK_CONSOLE_URL`, with credentials. A script injected into the
console can use the session while the page is open; it cannot carry the refresh token away. A
console session names no workspace, so it reads no site.

### The key of a connector (FRU-121)

A workspace can hand the worker the API key of its Linear, and the notes of the sites that choose it
go there. **This is the first secret of a customer that the Cloud holds.**

- The accounts file keeps the key encrypted (AES-256-GCM) with `FRUITBACK_SECRETS_KEY`, which stays
  in the environment. A copy of the file alone opens nothing; a copy of the file **and** of the
  environment opens every key. A value changed in the file does not decrypt.
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
- **A note that waits to be sent is kept in the accounts file, in the clear**, as the request body.
  It goes when it arrives. One that never arrives is given up after seven attempts, and removed
  30 days after its last attempt. The route that lists the waiting deliveries answers no body.
- The reporter is answered when the note is kept. A receiver that is down, slow or hostile costs the
  widget nothing. Each attempt is bounded at 10 seconds from its start to the status of the answer,
  whatever the receiver sends in that time, and the body of the answer is not read.
- A workspace can make the worker send requests to a third party: one per note its own sites
  receive, and six more attempts at most. The notes are rate-limited where they come in.

### Signing in with GitHub (FRU-97)

An OAuth App, the authorization code, `state` and PKCE (S256). The worker asks only for the identity
(`read:user user:email`), and **GitHub names the person, never the browser**: the account is the
primary address GitHub says it verified. An unverified address creates no account and joins none,
since it would join the account of whoever owns it. The `state` is bound to the browser that left by
an `HttpOnly` cookie on the callback path (`SameSite=Lax`, because GitHub sends the person back with a
top-level navigation from another site), must be one this worker issued, and is spent once, within ten
minutes. The client secret never leaves the worker. GitHub's token is used for these two reads and
kept nowhere. The session that follows is a console session, as for a link.

### Signing in with Google (FRU-135)

The same steps as GitHub, in the same code: the authorization code, a `state` bound to the browser
by a cookie and spent once, and PKCE. Only the identity is asked for (`openid email profile`).

- The worker asks Google who the token is for, at Google's own address over TLS. It reads no
  identity from a token by itself, so it checks no signature of one.
- **An address is used only when Google says it is verified.** Another one makes no account and
  joins none.
- A person who signs in with Google, with GitHub or with a link for the same verified address is one
  account. That is the rule of FRU-97, and it means the account is as safe as the weakest of the
  providers that can prove the address.
- `GET /auth/providers` answers two booleans to the console, and no client id.

### What the console may change, and who (FRU-99)

The console's routes under `/console/` take the access token of a console session, and read the role
of its account in the workspace **on every call**, from the accounts file: a token says who, never
what they may do, so a member removed a minute ago is refused at once. `can(role, action)` in
`accounts.ts` is the one table. A workspace somebody is not a member of answers `404`, like one that
does not exist. Adding a site keeps the origin of the pasted address and nothing else.

`POST /console/workspaces/<id>/connect` mints a pairing code for the person, in that workspace
(FRU-100). The console puts it after the `#` of the worker's pairing page, and the extension spends it
as it spends a code an operator minted. **A guest's session reaches every site of its workspace
today**: sharing one site with one guest is FRU-104, and until it lands the console creates no guest.

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
