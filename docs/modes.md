# The three modes

The first question a reader has is whether their reviewers need the site to ship anything. There are
three answers, and picking one is the only decision this page asks for.

| | **Public** | **Private** | **Team** |
| --- | --- | --- | --- |
| The site embeds | the widget | **nothing** | the widget, **dormant** |
| Delivered as | `<script>` tag or npm | a browser extension | `<script>` tag or npm |
| What wakes it | nothing, it is there | the extension's popup | the extension announcing itself |
| Who sees pins **on the page** | every visitor | the reviewer who switched the site on | reviewers who are signed in |
| Who can fetch them, **unauthenticated** | anyone | anyone | nobody, under `authenticated` |
| Who supplies the credential | the host's own backend, or nobody | **nobody can** | the reviewer, by pairing |
| The reporter is | anonymous, or verified by the host's token | self-declared | **verified**, by the session |
| Good for | a public "report a problem" | reviewing a client's site, invisibly | a team reviewing its own staging |

Those middle rows are the ones worth reading twice, and the next section is why.

## Who may read is `read`, and the mode decides who can satisfy it

**Access is not the mode.** `FRUITBACK_READ`, or `read` on one client, is what decides whether a read
needs a credential; it is `public` by default, and under `authenticated` every read wants an HS256
identity token. What the three modes differ on is **who can produce one**.

- **Public mode can, if the host mints them.** `init({ identityToken })` is a function the embedding
  site supplies, and the widget sends what it returns on reads as well as writes. A site with its own
  login can therefore run `read: 'authenticated'` and get verified reporters — the credential is
  minted by that site's backend and lives in its page's JavaScript.
- **Private mode cannot.** The extension mounts the widget with no `identityToken` and no transport,
  so it has nothing to attach and the site embeds nothing that could supply one. On an `authenticated`
  worker those reads answer `401`, and the reviewer gets a page with no pins and no reason
  (SKG-605). Left at the `public` default, the pins are the same pins on the same open path: private
  mode changes **who is shown** the feedback, never **who may fetch** it.
- **Team mode is the only one where the reviewer supplies it, and the only one that keeps it out of
  the page.** The site's widget is handed the extension's transport, and the token is attached in the
  background — the page never holds it, and the host mints nothing. Which is also worth saying the
  other way round: **team mode on a worker left at the `public` default buys a tidier page and
  nothing more.**

A credential is a credential in every mode: somebody holding a valid token reads that worker with
`curl` too. That is what the token is for. The row above is about the callers who have none.

So:

- pins nobody minds being read → **public**, and the simplest of the three;
- a site with its own login, and notes only its users should see → **public** with
  `read: 'authenticated'` and an `identityToken`;
- a client's staging you must not ask them to deploy to → **private**, and treat the notes as
  readable by anyone who can build the URL;
- your own product, notes internal, and nobody wants to mint tokens → **team**, with
  `FRUITBACK_READ=authenticated`.

A private-mode reviewer is not verified either: verification comes from the session the extension
holds, and only the relay carries it. Their name and address on a note are self-declared, exactly as
in a public-mode site that supplies no token — `reporter.verified` is the worker's word and it
withholds it.

## Private mode is not going away

Team mode covers a team reviewing its own product, which private mode served awkwardly: it asked a
team to deploy nothing when the code is theirs. Private mode keeps the case team mode cannot reach —
**a client's site that will never install the package**. One origin, switched on in a popup, and
nothing to ask anybody to ship.

Both extension modes are one field on the site's entry, chosen in the popup, and an entry with no
mode reads as private.

## What each one needs

| | Public | Private | Team |
| --- | --- | --- | --- |
| A worker | yes | yes | yes |
| A `<script>` tag or `init` on the site | yes | **no** | yes, dormant |
| The extension installed | no | yes | yes |
| A pairing code from an operator | no | no | **yes** |
| `FRUITBACK_READ=authenticated` | optional | it would lock the widget out | **the point** |

Every mode needs the worker: it is what holds the tracker's API key, and that key cannot ship in
client-side JavaScript. One container — [self-hosting.md](self-hosting.md).

`FRUITBACK_READ=authenticated` under private mode is worth spelling out: the widget the extension
mounts sends no token, so the read answers `401` and the reviewer gets a page with no pins and no
reason — the same screen as a worker that is down (SKG-605).

**And one worker cannot serve team mode and a client map at the same time.** `FRUITBACK_SESSION_PATH`
alongside `FRUITBACK_CLIENTS` is refused at boot: a session signs its access token with the
worker-wide key, and a mapped worker ignores that key because each client brings its own — so pairing
would work, the reviewer would look signed in, and every read would answer `401`. A worker that holds
sessions is therefore single-tenant today, and its `read` is worker-wide. If you need a private-mode
client beside a team-mode one, that is two workers, or a worker left at `public`.

## `showComments` is an editorial switch, not an access control

The team's replies come back inside the pin by default, and `FRUITBACK_HIDE_COMMENTS` — or
`showComments: false` on one client — turns them off.

Under `read: 'public'` that flag is the only thing between an issue thread and every visitor, so it
is worth a thought. Under `read: 'authenticated'` the access question does not arise: the reader is
somebody this worker checked, and the replies are already only reaching people entitled to them.
What is left there is editorial — whether a reviewer should see the team talking about their note —
and it stays the operator's call rather than being forced on. Nothing in the worker couples the two.

## Where to go next

| | |
| --- | --- |
| [install.md](install.md) | The site's and the operator's side: Linear, the worker, the widget, per-client routing |
| [reviewing.md](reviewing.md) | The reviewer's side: the extension, switching a site on, pairing |
| [self-hosting.md](self-hosting.md) | Running the worker: the image, the tags, a deployment |
| [../SECURITY.md](../SECURITY.md) | What each boundary actually holds, and what it does not |
