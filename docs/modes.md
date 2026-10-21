# The three modes

The first question a reader has is whether their reviewers need the site to ship anything. There are
three answers, and picking one is the only decision this page asks for.

|                                         | **Public**                      | **Private**                           | **Team**                             |
| --------------------------------------- | ------------------------------- | ------------------------------------- | ------------------------------------ |
| The site embeds                         | the widget                      | **nothing**                           | the widget, **dormant**              |
| Delivered as                            | `<script>` tag or npm           | a browser extension                   | `<script>` tag or npm                |
| What wakes it                           | nothing, it is there            | the extension's popup                 | the extension announcing itself      |
| Who sees pins **on the page**           | every visitor                   | the reviewer who switched the site on | members whose extension is connected |
| Who can fetch them, **unauthenticated** | anyone                          | anyone, or nobody                     | nobody, on a site that members read  |
| Who supplies the credential             | nobody                          | **nobody can**                        | the reviewer, by connecting          |
| The reporter is                         | anonymous, or a name they typed | self-declared                         | **verified**, by the session         |
| Good for                                | a public "report a problem"     | reviewing a client's site, invisibly  | a team reviewing its own staging     |

Those middle rows are the ones worth reading twice, and the next section is why.

## Who may read is the visibility of the site, and the mode decides who can satisfy it

**Access is not the mode.** Every site is made in the console, and the person who adds it chooses
who sees its notes:

- **« Everyone who visits »** (`everyone`): a read needs nothing. A visitor needs no account, no
  extension and no token to leave a note and to see the pins.
- **« Members of … »** (`members`), the default: a read needs the session of a member of the
  workspace of the site, which the extension gets when the reviewer connects it. **A guest is a
  member of the sites shared with them only** (FRU-250): on another site of the workspace, their
  session reads and writes nothing, as the session of a person of another workspace.

What the three modes differ on is **who can produce that session**.

- **Public mode cannot, and does not need to.** It is the site that everyone reads. The widget on the
  page reads with no credential, and so does `curl`.
- **Private mode cannot.** The extension mounts the widget with no token and no transport, so it has
  nothing to attach and the site embeds nothing that could supply one. On a site that members read,
  those reads answer `401`, and the page shows no pins. The popup says why: `This worker answers a
signed-in reader only, and private mode carries no session.` On a site that everyone reads, the pins
  are the same pins on the same open path: private mode changes **who is shown** the feedback, never
  **who may fetch** it.
- **Team mode is the only one where the reviewer supplies it, and the only one that keeps it out of
  the page.** The site's widget is handed the extension's transport, and the token is attached in the
  background — the page never holds it, and the host mints nothing. Which is also worth saying the
  other way round: **team mode on a site that everyone reads buys a tidier page and nothing more.**

A credential is a credential in every mode: somebody holding a valid token reads that worker with
`curl` too. That is what the token is for. The row above is about the callers who have none.

**A site that only members read takes a note from its members only, unless it says « Anyone on the
page »** (FRU-330). « Who can leave a note » is a setting of such a site, and « Members only » is the
default of a new one: a note with no session answers `401`, and the widget offers none. With
« Anyone on the page », a note with no session is kept: its sender cannot read it back, and the
members find it. Every site made before FRU-330 has that value. **Private mode carries no session**,
so a site that a reviewer opens in private mode must say « Anyone on the page ».

So:

- pins nobody minds being read → **public**, on a site that everyone reads, and the simplest of the
  three;
- a client's staging you must not ask them to deploy to → **private**, and treat the notes as
  readable by anyone who can build the URL if the site is read by everyone;
- your own product, notes internal → **team**, on a site that members read.

A private-mode reviewer is not verified either: verification comes from the session the extension
holds, and only the relay carries it. Their name on a note is self-declared, exactly as a visitor's
on a public site — `reporter.verified` is the worker's word and it withholds it.

**The token that a host's own backend mints has nothing to verify it on a site of the console.**
`init({ identityToken })` still sends what it returns, but a site of the console has no secret of its
own. Measured on 2026-10-16: a note sent with such a token answers `401 invalid-identity`, so a site
that hands one to the widget plants nothing, and a read of a site that everyone reads answers as if no
token were sent. Until FRU-225, a client of
`FRUITBACK_CLIENTS` had that secret, and « a site with its own login » ran public mode with
`read: 'authenticated'`. Whether a site of the console gets such a secret is not decided (FRU-184).

## Private mode is not going away

Team mode covers a team reviewing its own product, which private mode served awkwardly: it asked a
team to deploy nothing when the code is theirs. Private mode keeps the case team mode cannot reach —
**a client's site that will never install the package**. One origin, switched on in a popup, and
nothing to ask anybody to ship.

Both extension modes are one field on the site's entry, chosen in the popup, and an entry with no
mode reads as private.

## What each one needs

|                                          | Public | Private                      | Team          |
| ---------------------------------------- | ------ | ---------------------------- | ------------- |
| An instance, and the site in its console | yes    | yes                          | yes           |
| A `<script>` tag or `init` on the site   | yes    | **no**                       | yes, dormant  |
| The extension installed                  | no     | yes                          | yes           |
| The extension connected, by a member     | no     | no                           | **yes**       |
| The site read by « Members of … »        | no     | it would lock the widget out | **the point** |

Every mode needs the instance: the worker, its PostgreSQL and its console. The worker holds the key of
a tracker when a site sends there, and that key cannot ship in client-side JavaScript; the console is
where a site is made. Self-hosted, it is one compose file — [self-hosting.md](self-hosting.md).

A site read by members under private mode is worth spelling out: the widget the extension mounts
sends no token, so the read answers `401` and the page shows no pins — the same page as a worker that
is down. The popup tells the two apart: it asks the worker the same read, and on a `401` it says that
the worker wants a session that private mode does not carry. On a site whose notes are « Members
only » (FRU-330), the default of a new site, the widget offers no note either: the refusal of the
read says `canWrite: false`. Such a site must say « Anyone on the page » to take the notes of a
private-mode reviewer, and is still read by members only.

**One instance serves team mode for several clients, grouped in workspaces** (FRU-95). A session
belongs to the workspace it was connected for, and reads and writes on the sites of that workspace
and of no other. Each site keeps its own visibility, so a site in private mode can stay read by
everyone beside a team-mode site that members read.

## `showComments` is an editorial switch, not an access control

The team's replies come back inside the pin by default. `FRUITBACK_HIDE_COMMENTS=1` turns them off for
the whole instance, and the switch « Show Linear comments as replies » of a connector for the sites
that send there.

On a site that everyone reads, that switch is the only thing between an issue thread and every
visitor, so it is worth a thought. On a site that members read, the access question does not arise:
the reader is somebody this worker checked, and the replies are already only reaching people entitled
to them. What is left there is editorial — whether a reviewer should see the team talking about their
note — and it stays the operator's call rather than being forced on. Nothing in the worker couples
the two.

## Where to go next

|                                    |                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| [install.md](install.md)           | The site's and the operator's side: the instance, the site, the widget, the tracker |
| [reviewing.md](reviewing.md)       | The reviewer's side: the extension, switching a site on, pairing                    |
| [self-hosting.md](self-hosting.md) | Running the instance: from an empty folder to a pin, then backups and upgrades      |
| [../SECURITY.md](../SECURITY.md)   | What each boundary actually holds, and what it does not                             |
