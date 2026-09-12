# The three modes

The first question a reader has is whether their reviewers need the site to ship anything. There are
three answers, and picking one is the only decision this page asks for.

| | **Public** | **Private** | **Team** |
| --- | --- | --- | --- |
| The site embeds | the widget | **nothing** | the widget, **dormant** |
| Delivered as | `<script>` tag or npm | a browser extension | `<script>` tag or npm |
| What wakes it | nothing, it is there | the extension's popup | the extension announcing itself |
| Who sees pins **on the page** | every visitor | the reviewer who switched the site on | reviewers who are signed in |
| Who can read them **with `curl`** | anyone | anyone | nobody, under `authenticated` |
| The reporter is | anonymous or self-declared | self-declared | **verified**, by the session |
| Good for | a public "report a problem" | reviewing a client's site, invisibly | a team reviewing its own staging |

The last two rows are the ones worth reading twice, and the next section is why.

## Only team mode protects a read

**Public and private mode both call the worker straight from the page, with no credential.** In
private mode the extension mounts the widget, so a visitor of that site sees nothing — but the pins
are the same pins, on the same open read path, and anybody who can build
`GET /feedback?url=…&client=…` gets them. Private mode changes **who is shown** the feedback, never
**who may fetch** it.

Team mode is the one that changes the second. The site's widget is handed the extension's transport,
every call is made from the extension's background with the reviewer's access token attached, and the
worker set to `FRUITBACK_READ=authenticated` answers `401` to everyone else — `curl` included. That
is the whole of its security value, and it is worth saying the other way round too: **team mode on a
worker left at the `public` default buys a tidier page and nothing more.**

So:

- pins nobody minds being read → **public**, and the simplest of the three;
- a client's staging you must not ask them to deploy to → **private**, and treat the notes as
  readable;
- your own product, and the notes are internal → **team**, with `FRUITBACK_READ=authenticated`.

A private-mode reviewer cannot be verified either: verification comes from the session the extension
holds, and only the relay carries it. Their name and address on a note are self-declared, exactly as
in public mode — `reporter.verified` is the worker's word and it withholds it.

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
reason — the same screen as a worker that is down (SKG-605). If a worker serves both a private-mode
client and a team-mode one, set `read` per client in `FRUITBACK_CLIENTS` rather than worker-wide.

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
