# Security

Fruitback puts a widget inside somebody else's page and a worker in front of somebody's issue
tracker. Both of those are trust boundaries, and this file says where they are.

**Writing the known limits down is the policy.** A file that only says "email us" leaves a
self-hoster to discover on their own that their read path is open to anyone who can build a URL.

## Reporting a vulnerability

**This repository is private today**, so GitHub's Private Vulnerability Reporting is not available
on it — that feature is for public repositories, and the endpoint answers `404` here. Checked, not
assumed.

- **While the repository is private**, report through the repository itself. Everyone who can read
  it can already see an issue, so there is no public disclosure to avoid.
- **When it becomes public**, Private Vulnerability Reporting is the channel, and enabling it is part
  of going public. Until it is on, *this section is wrong* — update it in the same change.

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

### `reporter.verified` is the worker's word

Anything a browser posts carrying `verified` has it stripped before storage, whatever else it says.
The flag is set only after an HS256 token verifies against the client's key. Without a token, a name
and an address are a claim by whoever was on the page, and they are stored as one.

### A seed is stored in the clear, in your issue tracker

The whole seed — note, page URL, selector, the reporter's name and address, the screenshot URL — is
stored as it arrived, and **where** depends on the connector:

| Store | Where a seed lands | Who can read it |
| --- | --- | --- |
| `linear` | verbatim in an issue description | anyone with access to that workspace |
| `sqlite` | `JSON.stringify(seed)` in a column of your database file | anyone who can read the file, or a backup of it |

Either way it outlives any expiry you had in mind, which is why an identity token travels in an
`Authorization` header and never in the seed. On SQLite the file and its backups are the boundary,
and they deserve the care a database of personal data deserves.

Tell your reporters not to type credentials into a feedback note, because the note is going to sit
somewhere for a long time.

### The rate limit is per process

`RATE_LIMIT_PER_MINUTE` (20 by default) is held in memory, per container. **Run N replicas and the
effective ceiling is N times what you configured.** It protects your provider quota; it is not a
defence against a determined caller, who can rotate addresses anyway.

`TRUSTED_PROXY_HOPS` (1 by default, which is one Traefik) decides how the client address is read:
`X-Forwarded-For` is appended to by each proxy, so the real address is that many entries **from the
right**.

**Set it too high and the limit is bypassable with one header.** Counting further left reaches the
part of the chain a caller wrote, so anyone can mint a fresh bucket per request. Measured against
`resolveClientIp`, with a caller sending `1.2.3.4` through one proxy that appends `203.0.113.9`:

| `TRUSTED_PROXY_HOPS` | Address used | |
| --- | --- | --- |
| `1` — one proxy, the truth | `203.0.113.9` | the address the proxy observed |
| `2` — one too many | `1.2.3.4` | **what the caller sent** |
| `0` — none | the socket peer | the proxy's own address: everyone shares one bucket |

Count the proxies that **append** to the header, and no others. An edge that rewrites the header
rather than appending — Cloudflare does — is a different rule, and reading the leftmost entry is
correct there and wrong here.

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

That cannot be worked around per client on a worker that serves team mode: `FRUITBACK_SESSION_PATH`
alongside `FRUITBACK_CLIENTS` is **refused at boot**, because a session signs with the worker-wide
key a mapped worker ignores. A worker holding sessions is single-tenant, and its `read` is
worker-wide. See [docs/modes.md](docs/modes.md).

### The extension's page bridge can be forged by the page

In private mode the widget runs in the page's own JavaScript realm, and the bridge is
`window.postMessage`. The parser refuses a malformed message; it **cannot** refuse a well-formed one
the page wrote, because the two are identical. A page on an origin the reviewer enabled can point the
widget at its own worker, or take it away.

That is inherent to the main world and no handshake closes it. What is reduced is what is at stake:
nothing secret travels there, the endpoint and client id are already in the client's own DOM in tag
mode, and **an identity token is not sent at all**.

### What a session protects, and what it does not

The worker can hold sessions for the browser extension. An operator mints a pairing code for a named
person; redeeming it opens a session.

| | |
| --- | --- |
| Pairing code | 60 bits, valid 15 minutes, usable **once** |
| Access token | HS256 identity token, 10 minutes |
| Refresh token | 256 bits, 30 days, **rotated on every refresh**, revocable |
| On disk | codes and refresh tokens are stored as **SHA-256 digests** |

**Every refresh spends its refresh token and issues a new one** (SKG-600). A token that never
changed was a thirty-day password: a copy taken from a browser profile stayed good for the rest of
the month and nothing observed the theft.

**Rotation makes the theft detectable. It does not cap what the thief gets**, and an earlier version
of this section said it did. A refresh token is a bearer credential: whoever presents it is served.
Each presentation of a spent token revokes the successor the one before it minted, so the **last**
holder to present it keeps the live chain and every earlier one is locked out. A thief who presents
after the reviewer takes the session, and the reviewer pairs again.
What rotation guarantees is that the two cannot both keep the session: the loser's next refresh is
refused, so the theft surfaces within one refresh cycle instead of lasting a month. See *the cost*
below, and `serves whoever presents last inside the grace, until the earlier holder comes back`.

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

Since SKG-599 the extension holds its half of that, and **where** matters as much as the lifetimes:

| | |
| --- | --- |
| Refresh token | `chrome.storage.local`, in the reviewer's browser profile — it survives a restart |
| Access token | `chrome.storage.session`, which the browser empties when it closes |

**Each endpoint has its own storage key** (SKG-602). One key holding every worker made the popup and
the background write over each other: a refresh could put a credential back after a logout cleared
it, so a session a reviewer had ended stayed usable until it expired. Logging out now removes the
key it names, and no ordinary operation on another endpoint writes it.

Two writers still reach that key, and the split does not order them. A refresh for the **same**
endpoint compares the stored token and writes after it, so a logout can land between the two. **A
logout mints a new epoch for the endpoint before it clears anything** (SKG-603), and an entry stamped
with the epoch before it is refused by every reader. The write itself cannot be stopped — there is no
transaction and no compare-and-set — and it no longer has to be: the session a refresh puts back is
one nothing answers with, and the access token minted beside it has no session to match. It stays in
storage until the next pairing writes over it, holding the refresh token the logout revoked.

The upgrade to per-endpoint keys writes from a snapshot too, and the epoch reaches that write as
well: a legacy record predates the marker, so what the upgrade puts back carries no epoch and the
logout minted one. What a logout cannot recover from that window is a **pairing** made inside it —
the upgrade puts the older entry back over it, and the endpoint reads as signed out. That costs a
pairing, never a credential somebody ended, and only on the first run after the upgrade. A refresh in
flight can lose a pairing the same way, on any run and not only the first: SKG-604.

Neither is readable from a reviewed page. Both stay inside the extension's **trusted contexts** — the
background service worker, which refreshes, and the popup, which pairs and logs out.
`chrome.storage.session` keeps its default access level, which excludes content scripts, and nothing
about a session travels on the `window.postMessage` bridge. A browser profile is now part of this
boundary: somebody who can read a reviewer's profile can read their refresh token, and revoking it is
the answer.

Pairing asks for a host permission on the **worker's** origin, which is not the site's. It is optional
and granted per worker at the moment somebody pairs, never at install.

### What the extension relays, and what it refuses to

In team mode (SKG-596) the site embeds its own widget and leaves it dormant. The extension puts a
transport on the page, and the calls it carries are made by the background service worker, which
attaches the session token. **The token never travels on the page bridge**; what travels is the
request and the answer.

That makes the extension something that will make a call for a page, so the background refuses more
than it accepts. It sends nothing unless all of the following are true:

| | |
| --- | --- |
| The origin | comes from the sender the browser reports, never from the message |
| The site | has an entry the reviewer stored, switched on, in team mode |
| The endpoint | is the one that entry names — a page asking for another worker is **refused, not redirected** |
| The path | is `/feedback`, the one path the widget calls |
| The headers | are rebuilt: `Content-Type` may come from the page, `Authorization` never does |
| The session | is open for that endpoint — with no session there is no call at all |
| The scheme | is `https`, or loopback. A bearer token does not cross a plain `http://` connection |

The endpoint check is the one that matters. A reviewer holds a session per worker, so a page allowed
to name its own endpoint could ask for a call to a *different* worker that reviewer has paired with,
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
write it down. The three `/session/` routes needed that first; since SKG-596 the relay calls
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

### Personal data

The widget can send, from a third party's page: a hand-written note, a name, an address, the user
agent (`includeEnv`), the page URL, and a picture of what the person was looking at. All of it lands
in an issue tracker, and for the Linear connector that is outside your own infrastructure.

That is a processing of personal data and a deployment of Fruitback has to be declared as one. What
Fruitback owes its operators here is documentation, and that is tracked separately.

## What is not a vulnerability

- **A reporter typing somebody else's name.** With no token that is a claim, which is what
  `verified: false` means. Report a case where a claim comes back marked verified.
- **Pins readable on a worker left at `read: 'public'`.** That is the documented default and the boot
  log says so. Report a case where `authenticated` still answers without a valid token.
- **Exceeding the rate limit from several addresses.** It is quota protection, not authentication.
  Report a bypass from *one* address, or one that works by setting a header.
- **A page forging bridge messages on an origin its reviewer enabled.** Stated above, and inherent to
  the main world. Report a case where an origin nobody enabled can do it, or where a session token
  reaches the page.
- **A team-mode page asking the extension to relay a call.** That is the mode. Report a relay that
  reaches an endpoint the reviewer's entry for that origin does not name, a path other than
  `/feedback`, or one made with no session behind it.
