# What the widget collects

The widget runs on a page somebody else visits, and what they write leaves that page. If your team is
in the European Union, or your reporters are, that is a processing of personal data and you are the
one who has to declare it. You cannot do that without a list of what is sent, so this page is the
list.

**This is not legal advice.** It says what the code does, field by field, and what it does not do
yet. What you owe your reporters under the law that applies to you is for you, or your counsel, to
decide.

## What a note carries

A note is one **seed**: a JSON object the widget builds in the reporter's browser and posts to your
worker. Its shape is `seedSchema` in [`packages/shared/src/seed.ts`](https://github.com/sakuga-software/fruitback/blob/main/packages/shared/src/seed.ts),
and nothing outside that schema is sent.

| Field                                      | What it is                                                                       | Sent                                    | What controls it                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `note`                                     | what the reporter typed, up to 5,000 characters                                  | always                                  | the reporter                                                              |
| `page.url`, `page.path`                    | the page address, with the fragment and the tracking parameters removed          | always                                  | nothing: the page address is how a pin is found again                     |
| `page.title`                               | the page's `<title>`                                                             | when the page has one                   | the site                                                                  |
| `viewport`                                 | the window's width, height and pixel ratio                                       | always                                  | nothing                                                                   |
| `anchor`                                   | a selector, a structural path, the tag, up to 160 characters of the element text | always                                  | nothing: this is what places the pin                                      |
| `anchor.attrs`                             | the element's `id`, test id, `name`, `role` and `aria-label`, when present       | when the element has them               | the site's markup                                                         |
| `source`                                   | the React component, file, line and column behind the element                    | when the build exposes them             | the site's build: a production build usually exposes none                 |
| `client.id`                                | the client id the site was given                                                 | always                                  | the integrator                                                            |
| `reporter.name`                            | what the reporter typed in the optional name field                               | **only if the reporter fills it in**    | the reporter                                                              |
| `reporter.id`, `.name`, `.email`           | the identity in a signed token, replacing anything typed                         | added by the worker, from a valid token | the integrator (`identityToken`) or, in team mode, the pairing            |
| `env.userAgent`, `env.locale`, `.platform` | the browser's user agent string, language and platform                           | **only if the integrator turns it on**  | the integrator: `init({ includeEnv: true })`, or the attribute on the tag |
| `screenshot`                               | the URL of a picture of the page                                                 | **only if the reporter turns it on**    | the integrator supplies `captureScreenshot`; the reporter switches it on  |
| `id`, `createdAt`                          | a random identifier and the time of writing                                      | always                                  | nothing                                                                   |

The excerpt of the element's text (`anchor.text`) is the site's own text, not the reporter's. It can
still be personal data: an element that shows a customer's name carries that name into the seed.
If your staging site shows real customer records, keep that in mind before you invite reviewers.

### What is right by default

- **A reporter who does nothing is anonymous.** The name field sits behind a disclosure, is
  optional, and is sent only when filled in. The widget asks for no e-mail address.
- **The widget remembers nobody who did not ask.** The name stays in the reporter's browser only if
  the reporter ticks « Remember me on this site », and unticking the box erases it at once.
- **No picture leaves the page unless somebody chose it.** The widget bundles no screen capture.
  The setting is absent unless the integrator supplied `captureScreenshot`, and present, it starts
  off: the reporter turns it on. The picture goes to **your** storage, and the seed holds only its
  URL — whether that URL is public is your decision.
- **The identity token never enters the seed.** It travels in an `Authorization` header and is
  verified, not stored. The seed is kept verbatim for as long as the issue exists, and a credential
  in it would outlive its expiry by months.
- **A typed name is never presented as checked.** Only a signed token makes `reporter.verified`
  true; the worker removes the flag from anything a browser sends.
- **The browser environment stays on the page.** A user agent string, with a language and a time,
  narrows down who a reporter is, so `env` is not sent. The extension's private mode mounts the
  widget with its defaults, so it sends none either.

### What you can turn on

- **The browser environment.** Pass `includeEnv: true` to `init`, or write
  `data-fruitback-include-env="true"` on the `<script>` tag, and every note carries the user agent,
  the language and the platform of its reporter. Only the word `true` turns it on. If you do, say so
  in your notice.

## Where it goes

The widget talks to one address: the worker the integrator, or the reviewer in the extension, named.
Fruitback runs no service of its own and receives nothing. The worker then writes the seed to the
store it is configured with:

| Store      | Where a note lands                                       | Who runs it                         |
| ---------- | -------------------------------------------------------- | ----------------------------------- |
| `linear`   | an issue in your Linear workspace, the seed in its body  | Linear, outside your infrastructure |
| `github`   | an issue in your GitHub repository, the seed in its body | GitHub, outside your infrastructure |
| `sqlite`   | a row in a database file on your volume                  | you                                 |
| `postgres` | a row in the database of the worker, beside the accounts | you                                 |

On the Cloud, a workspace can also connect **an address of its own** (FRU-122). The note is then kept
in the worker and a copy is posted to that address, whole and signed. Who runs that address decides
who reads the copy. [Receiving notes on your own address](rest-connector.md) is the request.

In the two trackers, the issue description also states the reporter's name and e-mail in a line
your team reads, and the seed below it repeats them. [SECURITY.md](../SECURITY.md#a-seed-is-stored-in-the-clear-in-your-issue-tracker)
says who can read each store. **On a public GitHub repository, that is everyone.**

### Who can read a note back

The widget reads the notes of a page to draw their pins, and the answer carries **the whole seed**,
name and e-mail included, and the replies of your team with their authors' names. By default the
read path is public (`FRUITBACK_READ=public`): anybody who knows a page address and its client id
can read them, with or without the widget.

- `FRUITBACK_READ=authenticated`, or `"read": "authenticated"` on one client, requires a signed
  identity token on every read. [modes.md](modes.md) says which mode can supply one.
- `FRUITBACK_HIDE_COMMENTS=1`, or `showComments: false` on one client, keeps your team's replies,
  and the names of the people who wrote them, out of the answer.
- In the Cloud, the switch « Show Linear comments as replies » of a connector does the same for the
  sites that send there. It cannot show what the worker hides.

### What the worker keeps besides the note

- **No access log.** The worker writes to its output at boot, on a configuration problem and on a
  failed request. It does not log the requests it serves. Your reverse proxy probably does: its
  access log holds the address of every visitor that loaded a pin, and you set its retention.
- **The address of a caller, for two minutes.** The rate limit counts requests per address over
  one-minute windows, and keeps a window for two. On a worker with no database it is in memory, and
  nothing writes the address to disk. **On a worker with a database it is a row of the table `kv`**
  (FRU-67), so that the replicas share one limit: the address is then in the database for those two
  minutes, and in a backup taken during them. Expired rows are removed as requests come.
- **The answer to a read, for 15 seconds**, in the same place: memory, or the table `kv`. The read
  cache keeps a page's notes so a burst of visitors costs one call to the store.
- **The address a sign-in link or an invitation was sent to, for the time of its limit**, in the same
  place, as the key of a count: the worker sends a few messages to one address in a window, and no
  more.
- **The extension's sessions, on disk**, when `FRUITBACK_SESSION_PATH` is set, or in the PostgreSQL
  database of `FRUITBACK_DATABASE_URL` in place of that file (FRU-142). Each row holds the
  subject, name and e-mail the operator gave when minting the pairing code, its dates, and a SHA-256
  digest of the code or token, never the token itself. Expired rows are removed when a new code is
  redeemed.
- **The accounts, in the PostgreSQL database** of `FRUITBACK_DATABASE_URL` (FRU-141, and nowhere
  else since FRU-150). For each person: the
  address a provider or a link proved, the name the provider gave or the one they chose in « My
  account » (FRU-249: the notes already in a tracker keep the name they were sent with), and which
  provider signed them in or was linked by them
  with the id it gives them, and the language they read (the browser that opened their first sign-in
  link, or their own choice), which their e-mails are written in. For each workspace: the key of each
  tracker it connected, encrypted (FRU-121), and where each site sends its notes; its name, its members and their roles, and the address
  of each site it reviews. No password, and no token of a provider that signs a person in. Deleting a workspace removes its
  members and its sites; the notes already in a tracker stay there.

- **The tables of better-auth, in the same PostgreSQL database** (FRU-144). Since FRU-146 the
  accounts above are in four of them (`user`, `account`, `organization`, `member`): the same things,
  in other tables, and every address there counts as proven. The console signs in with better-auth
  since FRU-147. The seven hold: for each person, the address, whether it is proven, and the name,
  and no picture; for each sign-in by a provider, which provider and the id it gives the person,
  **never its tokens** (FRU-181); for each session of the console, the SHA-256 of its token, never
  the token, and its dates. **The address and the user agent of the browser are kept with a session
  only when the operator sets `FRUITBACK_AUTH_TRACK_IP=1`** (FRU-147); by default the row holds
  neither. **Each session keeps a short label of its browser** (FRU-249, decision of 2026-10-13):
  a family and a system from a closed list, « Chrome on macOS », read once from the user agent when
  the session opens, so that « My account » can say where the person is signed in. Never the user
  agent itself, no version and no device. A session opened before has none. **For each member of a
  workspace, the day they were last seen there** (FRU-249): the day of UTC, and no hour, of their last
  call to the console in that workspace or of the last refresh of their extension for it. Only an
  owner or an admin of the workspace reads it, as « Last seen »; it goes when the person leaves. A session goes 7 days after its last day of use, or when it is ended. For a sign-in link
  that waits, the SHA-256 of its token and the address it was sent to; the workspaces, their members and the address each invitation was sent
  to. The state of a sign-in with a provider is in a cookie of the browser that started it, not in
  the database.

- **The pictures of the notes, in the PostgreSQL database** (FRU-44), when a reviewer turned on
  « Attach a picture of the element » in a widget that the extension mounts. A PNG of the element,
  as the screen showed it, of 1 MB at most, with the workspace it belongs to, the account that sent
  it and its date. Only a member of that workspace reads it. Deleting the workspace deletes its
  pictures. The seed in the tracker holds the address of the picture, not the picture. **The picture
  is sent when the note is written**, so a note that is kept for later (FRU-124) and never sent
  leaves its picture on the worker, with no note that names it.

- **The notes that wait to be sent to a connected address** (FRU-122), in the database of the accounts.
  A note goes from there when it arrives, and 30 days after its last attempt when it never does.

### The index of the notes, on a worker with accounts (FRU-237)

A worker with a database keeps **one row for each note it planted for a site of a workspace**,
wherever the note went: Linear, a REST endpoint, or its own store. The console counts the notes of a
site from it (the list of the notes is FRU-244). The row is written when the note is planted, and its stage is written
again each time a read of the page asks the store; a note planted before the index is written at
the first read of its page, with what that read says.

| Column                       | What it holds                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site_id`, `workspace_id`    | The site of the note and its workspace.                                                                                                                             |
| `seed_id`                    | The id the widget gave the note.                                                                                                                                    |
| `page_url`                   | The address of the page, as the worker canonicalised it.                                                                                                            |
| `excerpt`                    | **The first 64 characters of the text, never more**, spaces and line breaks made one space, cut between two characters. For a person to tell one note from another. |
| `stage`                      | The stage the store last said, and `checked_at` when it said it.                                                                                                    |
| `channel`                    | `script` or `extension`: whether a session of an extension signed the note. Empty for a note from before the index.                                                 |
| `author_kind`                | `visitor`, `site` (a token the site signed), `member` (a session of the workspace) or `verified` (a note from before the index whose reporter was verified).        |
| `author_account_id`          | The account of a member who left the note. Empty for everyone else, and emptied when the account is removed.                                                        |
| `place`, `connector_id`      | Where the note went: the worker's own store, or a connector of the workspace.                                                                                       |
| `reference`, `reference_url` | What the store calls the note (`ACM-151`, `FB-12`) and its address there.                                                                                           |
| `created_at`                 | When the worker took the note.                                                                                                                                      |

**A note of 64 characters or fewer is in the index whole**, as its excerpt: that is what « the first
64 characters » means for a short note.

**What the index does not keep**: the rest of the text, the name or the address a reporter typed,
the anchor, the environment, the picture, the replies. Those stay where the note went. So **a
visitor's typed name is in the tracker and never in the index**: the console shows « Visitor ».

**It goes with its site and its workspace**: removing a site removes its rows at once, whatever
becomes of the notes themselves (FRU-194). **`forget` removes the rows of the notes it deletes**,
before it deletes them and again after, so a read of their page during the command does not leave
one behind. **A note that went to a tracker** is not found by an address or a name, since the index
keeps neither: `forget --seed <id>`, with the `id` of the seed that its issue holds, removes its row,
whatever the store, and the issue is deleted in the tracker. **A note deleted in a tracker keeps its row**, excerpt included, until its
site goes: the worker is not told of a deletion there, and a read of the page cannot tell a note
that was deleted from one that a tracker did not list. That is the one place where up to 64
characters of a note outlive it; `docs/decisions/worker.md` says how it would be closed.

**The console lists these rows** (FRU-244): the excerpt, the page, the site, the stage, the dates,
the way the note came, and, for a role that sees the tracker, where it went and its reference. Its
search reads these columns only. The name of an author is the name of a member's account as it is
now, read from the account at each request and not kept in the index; a member who left the
workspace is shown with no name.

### What stays in the reporter's browser

Since FRU-119 an account also holds the language its person reads, taken from the browser that opened their first sign-in link, or chosen by them: the e-mails to that address are written in it.

- `localStorage`, under `fruitback:config` (or the `configKey` the integrator chose): the stages the
  reporter hid and the screenshot switch. The reporter's name too, **only if the reporter ticked
  « Remember me on this site »**. For a member of a team who chose where a note goes, the identifier of that place: an opaque
  value, with no name of the tracker (FRU-123). No e-mail, no note. In private mode the extension writes `fruitback:config:extension` into **the site's**
  storage, so a site can see that a reviewer used the extension on it.
- `sessionStorage`, under `fruitback:config:drafts` (or the `configKey` with `:drafts`): **the notes a
  reporter chose to keep for later and has not sent yet** (FRU-124), each a whole seed, with the name
  they typed if any. Only after a click on « Keep for later ». They go when they are sent, and with
  the tab. Any script of the page can read them while they are there.
- **The rules of the extension leave the browser only when the reviewer asks** (FRU-72). With
  « Keep my rules in the account of this browser » ticked in the options page, the extension copies
  its rules to `storage.sync`, which the vendor of the browser keeps with the reviewer's account
  (Google for Chrome, Mozilla for Firefox) and gives to their other browsers. A rule holds the
  address of a site, or its pattern, the address of its worker, a client id, whether it is on, and
  two things the reviewer or the workspace named: the label of the launch button, when the rule has
  one, and the name of the workspace of a site turned on from a session.
  **No session token, no access, no note, and no name or address of a person travel.** The box is off by default, and
  turning it off stops the copy; what the account already holds stays there until the rules are
  removed while it is on. That vendor is a recipient you did not have before: say so to a reviewer
  whose staging addresses are confidential.
- The extension keeps its rules and its session tokens in its own storage, which no page can read.
  While a sign-in from the popup waits for the console (FRU-251), it keeps that request there too,
  until it ends or the browser closes; then the address of the console, for « Open the console ». To
  start a sign-in it sends the worker the name of the browser and of its system (« Chrome on
  macOS »), which the console shows to the person who approves. It also keeps the language of the reviewer's account there. That language goes to a page where
  the extension mounts the widget, so the widget speaks it: a site a reviewer turned on can read
  which language their account is set to.
- The widget sets no cookie.

## How long a note is kept

As long as the issue or the row exists. Fruitback deletes nothing on its own.

- **Linear and GitHub:** the retention of your workspace or repository. Closing an issue does not
  delete it.
- **SQLite:** yours, and the file's backups are part of it. A backup kept for a year keeps every
  note for a year.
- **PostgreSQL:** yours too, and the dumps of the database are part of it. The notes of a site stay
  when the site is removed from its workspace: nothing deletes them but the command below.

## Deleting a reporter's notes

The widget asks for no e-mail address since FRU-91, so a note carries one in two cases only: the
integrator's identity token gave it, or the note was written before. A typed name is a claim, and
so was a typed e-mail: a reporter can write somebody else's, and two reporters can write the same
one. So list the notes first, read the list, and delete after.

**A note signed with a name only has no address to search for**, and a note with no name has
nothing to search for at all. Each note has an identifier, and the thread of its pin shows it on the
page.

- **SQLite and PostgreSQL:** the worker has a command for it. Run it in the container, like `pair`:

  ```bash
  docker exec <container> node server.mjs forget --email alice@example.com --dry-run
  docker exec <container> node server.mjs forget --email alice@example.com
  ```

  The first line lists the notes that give this address, with their `FB-n`, date, page and the start
  of the note, and deletes nothing. The second deletes them, with the team's replies to them. The
  address is compared without case and without the spaces around it. You do not have to stop the
  worker: the file is in WAL mode, and the database takes the deletion in one transaction. A page
  can still show a deleted note for up to 15 seconds, from the cache. Then delete it from your
  backups too, or record when they expire. **On PostgreSQL the command reads the notes of every
  site of the worker**, whatever their workspace: it is for whoever runs the worker, not for a
  workspace.

  For a note with no address, list by name, then delete by identifier:

  ```bash
  docker exec <container> node server.mjs forget --name "Alice" --dry-run
  docker exec <container> node server.mjs forget --id FB-12 --id FB-15
  ```

  `--name` only lists, and the command refuses it without `--dry-run`: two reporters sign with the
  same name, so a name finds notes and does not decide which ones go. `--id` deletes the notes you
  name, with their replies. If one identifier of the list names no note, nothing is deleted. Use
  one of `--email`, `--name` and `--id` in a command.

- **After the notes moved from the SQLite file to PostgreSQL (FRU-220), the file still holds them.**
  `migrate-to-postgres --seeds` copies and never writes the file, which is the way back. `forget`
  then deletes in the database only: a note that a person asked you to delete is still in the file
  and in the archives that hold it. Delete the file when the way back is no longer needed, and
  record when its archives expire.
- **Linear and GitHub:** the notes are issues in your own workspace, so you delete them there, and
  the command says so rather than deleting anything. Search the issues for the address, because the
  description states it, read them, and delete the ones that are this reporter's. On GitHub only an
  administrator of the repository can delete an issue. Closing an issue does not delete it.

If you delete PostgreSQL rows by hand, delete the row of `seeds`: its replies in `seed_comments` go
with it.

If you delete SQLite rows by hand with `sqlite3`, start the session with `PRAGMA foreign_keys = ON`.
The `sqlite3` shell turns foreign keys off for each new connection, and without them the note goes
and its replies stay, attached to nothing (measured). The worker's own connection has them on.

## A notice you can adapt

Put this near the widget, or in your own privacy policy, and change what is not true for your
deployment:

> **Feedback on this page.** When you leave a note, we receive what you write, the address of this
> page, the part of the page you pointed at, and the size of your window. Your name is optional; we
> receive it only if you type it, and your browser keeps it only if you ask it to. A picture of the
> page is sent only if you turn it on. Your note is stored in _[Linear / GitHub / our own server]_
> and is visible to _[our team / anyone who can open this page]_ until we delete it. To have your
> notes erased, write to _[address]_.

If you turned `includeEnv` on, add "and your browser's name, version and language" to the first
sentence. Remove the picture sentence if you supplied no `captureScreenshot`.
