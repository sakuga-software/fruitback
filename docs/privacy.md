# What the widget collects

The widget runs on a page somebody else visits, and what they write leaves that page. If your team is
in the European Union, or your reporters are, that is a processing of personal data and you are the
one who has to declare it. You cannot do that without a list of what is sent, so this page is the
list.

**This is not legal advice.** It says what the code does, field by field, and what it does not do
yet. What you owe your reporters under the law that applies to you is for you, or your counsel, to
decide.

## What a note carries

A note is a JSON object the widget builds in the reporter's browser and posts to your
worker. Its shape is `noteSchema` in [`packages/shared/src/note.ts`](https://github.com/sakuga-software/fruitback/blob/main/packages/shared/src/note.ts),
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
still be personal data: an element that shows a customer's name carries that name into the note.
If your staging site shows real customer records, keep that in mind before you invite reviewers.

### What is right by default

- **A reporter who does nothing is anonymous.** The name field sits behind a disclosure, is
  optional, and is sent only when filled in. The widget asks for no e-mail address.
- **The widget remembers nobody who did not ask.** The name stays in the reporter's browser only if
  the reporter ticks « Remember me on this site », and unticking the box erases it at once.
- **No picture leaves the page unless somebody chose it.** The widget bundles no screen capture.
  The setting is absent unless the integrator supplied `captureScreenshot`, and present, it starts
  off: the reporter turns it on. The picture goes to **your** storage, and the note holds only its
  URL — whether that URL is public is your decision. A file that a person joins to a note through
  the worker goes to the ticket of the tracker, never into the note (FRU-331): see below.
- **The identity token never enters the note.** It travels in an `Authorization` header and is
  verified, not stored. The note is kept verbatim for as long as the issue exists, and a credential
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
  in [your notice](privacy/notice.md).

## Where it goes

The widget talks to one address: the worker the integrator, or the reviewer in the extension, named.
On a self-hosted instance that worker is yours, and Fruitback receives nothing. On the Cloud it is
the worker that Sakuga Software runs for you. The worker then writes the note to the store it is
configured with:

| Store      | Where a note lands                                       | Who runs it                         |
| ---------- | -------------------------------------------------------- | ----------------------------------- |
| `linear`   | an issue in your Linear workspace, the note in its body  | Linear, outside your infrastructure |
| `github`   | an issue in your GitHub repository, the note in its body | GitHub, outside your infrastructure |
| `postgres` | a row in the database of the worker, beside the accounts | you                                 |

A workspace can connect **its own GitHub** (FRU-359), on the Cloud or on an instance that sets
`FRUITBACK_GITHUB_CONNECTOR`: an organisation installs the
GitHub App of Fruitback, and each site sends its notes to one of its repositories, as issues. The
worker keeps the id of the installation, and no key and no token of GitHub. When a person installs
the App (FRU-360), GitHub gives the worker a token of that person for a moment. The worker uses it
once, to read which installations the person reaches. It keeps no copy of it and writes it in no
log.

A workspace can also connect **an address of its own** (FRU-122), on the Cloud or on an instance
that sets `FRUITBACK_SECRETS_KEY`. The note is then kept
in the worker and a copy is posted to that address, whole and signed. Who runs that address decides
who reads the copy. [Receiving notes on your own address](rest-connector.md) is the request.

`postgres` is the default, and the database is the one every instance has (FRU-225): the notes of
every workspace are in it, in the clear, beside the accounts. Who reads them there is whoever can
read the database or a dump of it: the role of `FRUITBACK_DATABASE_URL`, the people who run the
server, and whoever holds a backup. [SECURITY.md](https://github.com/sakuga-software/fruitback/blob/main/SECURITY.md#what-the-database-keeps-and-who-reads-it)
says it in full.

In the two trackers, the issue description also states the reporter's name and e-mail in a line
your team reads, and the note below it repeats them. [SECURITY.md](https://github.com/sakuga-software/fruitback/blob/main/SECURITY.md#a-note-is-stored-in-the-clear-in-your-database-or-your-tracker)
says who can read each store. **On a public GitHub repository, that is everyone.**

### Who can read a note back

The widget reads the notes of a page to draw their pins, and the answer carries **the whole note**,
name and e-mail included, and the replies of your team with their authors' names. Who can read
them is the visibility of the site, chosen in the console when it is added (FRU-225): `members`, a
session of its workspace and nobody else, which is what a site added with no visibility gets; or
`everyone`, anybody who knows a page address and the id of the site, with or without the widget.
[SECURITY.md](https://github.com/sakuga-software/fruitback/blob/main/SECURITY.md#who-reads-the-pins-the-visibility-of-each-site) says it in full.

- A worker of before FRU-225 read `FRUITBACK_READ` instead, public by default. That worker no longer
  starts.
- `FRUITBACK_HIDE_COMMENTS=1`, or `showComments: false` on one client, keeps your team's replies,
  and the names of the people who wrote them, out of the answer.
- In the Cloud, the switch « Show Linear comments as replies » of a connector does the same for the
  sites that send there. It cannot show what the worker hides.

### A reply to a note (FRU-257)

A reply written from the page goes where its note went: the tracker of the workspace, or the
database for a site that sends nowhere. It holds what the person wrote, quoted, under one line: the
name of their account and the workspace for a member, the name they typed (or « Visitor ») and « not
verified » for anybody else. The worker keeps no copy of a reply that went to a tracker. In Linear
the comment is shown under the app of Fruitback, or under the owner of a personal key.

### « Looks fixed » and « Still wrong » (FRU-294)

A verdict on a note marked done is a reply: it goes where the note went, under the same line as a
reply of a member (the name of their account and their workspace), then one line that says
« Checked: looks fixed » or « Reopened: still wrong », then what the person typed, if anything,
quoted. « Still wrong » also moves the note back in the tracker. The worker keeps no copy of the
verdict: a read finds it in the replies. The index of the notes keeps nothing new; it already keeps
the account of the member who left a note, and that is what says who may give a verdict.

### What the worker keeps besides the note

- **No access log.** The worker writes to its output at boot, on a configuration problem and on a
  failed request. It does not log the requests it serves. Your reverse proxy probably does: its
  access log holds the address of every visitor that loaded a pin, and you set its retention.
- **The address of a caller, for two minutes.** The rate limit counts requests per address over
  one-minute windows, and keeps a window for two. **It is a row of the table `kv`** of the database
  (FRU-67), so that the replicas share one limit: the address is in the database for those two
  minutes, and in a backup taken during them. Expired rows are removed as requests come.
- **The answer to a read, for 15 seconds**, in the same table. The read
  cache keeps a page's notes so a burst of visitors costs one call to the store.
- **The address a sign-in link or an invitation was sent to, for the time of its limit**, in the same
  place, as the key of a count: the worker sends a few messages to one address in a window, and no
  more.
- **The extension's sessions, in the PostgreSQL database** of `FRUITBACK_DATABASE_URL` (FRU-142).
  Each row holds the
  subject, name and e-mail the operator gave when minting the pairing code, its dates, and a SHA-256
  digest of the code or token, never the token itself. Expired rows are removed when a new code is
  redeemed.
- **The extension that a person connects from the console** (FRU-238). While it waits, a request
  holds a SHA-256 digest of its id and of its secret, the word both screens show, **the short name of
  the browser the extension gave** (« Chrome on macOS », 60 characters at most, never the user agent
  and never an address), its dates, and the account that answered it. It is deleted by the first
  request that comes after its 15 minutes. The session it opens is a row of the sessions above, of the
  account and of no workspace, and keeps that short name, so that « My account » can list it with the
  day it was connected and the last time it was used; it goes when its owner ends it there, when the
  account is deleted, or 30 days after it was made.
- **The accounts, in the PostgreSQL database** of `FRUITBACK_DATABASE_URL` (FRU-141, and nowhere
  else since FRU-150). For each person: the
  address a provider or a link proved, the name the provider gave or the one they chose in « My
  account » (FRU-249: the notes already in a tracker keep the name they were sent with), and which
  provider signed them in or was linked by them
  with the id it gives them, and the language they read (the browser that opened their first sign-in
  link, or their own choice), which their e-mails are written in. For each workspace: the key of each
  tracker it connected, encrypted (FRU-121), and where each site sends its notes; its name, its members and their roles, and the address
  of each site it reviews. No password, and no token of a provider that signs a person in. Deleting a workspace removes its
  members, its sites and the notes that Fruitback keeps for them; the notes already in a tracker stay
  there.

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
  that waits, the SHA-256 of its token and the address it was sent to; the workspaces, their members, the address each invitation was sent
  to and whether a message of it left (FRU-269). The state of a sign-in with a provider is in a cookie of the browser that started it, not in
  the database.

- **The sites shared with a guest** (FRU-250): for each invitation of a guest, the ids of the sites
  it names; for each guest who accepted one, the ids of those sites, with the workspace, the account
  and the date. Nothing else: the sites themselves are the rows above. A row goes with its site, its
  invitation, its workspace or its account, and when the guest leaves or is removed.

- **The files of the notes, in transit, in the PostgreSQL database** (FRU-331): a capture of the
  page or of an area, an image or a file that a person joined to a note that goes to a tracker. Each
  with its name, its type as the worker checked it, the workspace and the site of its note, the
  account that sent it, its date and its end. **Fruitback keeps no file: it waits there until the
  tracker has it, 7 days at most.** Linear takes it with the note, and it leaves the worker at once;
  a REST address reads it by an address of one hour in its delivery, and it leaves the worker one
  hour after that delivery arrived; a file whose note never reaches the tracker leaves at the end of
  its 7 days, and the note goes without it. A note that stays in Fruitback, or goes to GitHub, takes
  no file. **Nobody reads a file in Fruitback**: no route shows one to a member, a guest or a page.
  Who reads it after is who reads the ticket in the tracker, and the receiver of the REST address.
  Deleting the workspace deletes the files that wait. The table is still named `screenshots`; the
  migration of FRU-331 deletes no picture of before: each one ends 7 days after the migration, and
  the sweep of the transit removes it then. A note still on its way is delivered with its picture
  until then. **The pictures
  of the notes kept in Fruitback, with no tracker, are gone with this version**: Fruitback stores no
  image (decision of 2026-10-20), and the address in such a note, `GET /screenshot/<id>`, answers
  nothing any more. A note of before sent again to a site with no tracker goes without its picture,
  and the answer says why (`notTaken: 'no-tracker'`).

- **The notes that wait to be sent to a connected address** (FRU-122), in the database of the accounts.
  A note goes from there when it arrives, and 30 days after its last attempt when it never does.

### The index of the notes, on a worker with accounts (FRU-237)

A worker with a database keeps **one row for each note it planted for a site of a workspace**,
wherever the note went: Linear, GitHub, a REST endpoint, or its own store. The console counts the notes of a
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
| `confirmed`                  | Whether the newest verdict in the replies of the note is « looks fixed » (FRU-295), as the last read that saw them said it. Empty until one did. No name, no text.  |

**A note of 64 characters or fewer is in the index whole**, as its excerpt: that is what « the first
64 characters » means for a short note.

**What the index does not keep**: the rest of the text, the name or the address a reporter typed,
the anchor, the environment, the picture, the replies. Those stay where the note went. So **a
visitor's typed name is in the tracker and never in the index**: the console shows « Visitor ».

**It goes with its site and its workspace**: removing a site removes its rows at once, with the
notes that Fruitback keeps for the site (FRU-194). **`forget` removes the rows of the notes it deletes**,
before it deletes them and again after, so a read of their page during the command does not leave
one behind. **A note that went to a tracker** is not found by an address or a name, since the index
keeps neither: `forget --seed <id>`, with the `id` of the note that its issue holds, removes its row,
whatever the store, and the issue is deleted in the tracker. **A note deleted in a tracker keeps its row**, excerpt included, until its
site goes: the worker is not told of a deletion there, and a read of the page cannot tell a note
that was deleted from one that a tracker did not list. That is the one place where up to 64
characters of a note outlive it; `docs/decisions/worker.md` says how it would be closed.

**The console lists these rows** (FRU-244): the excerpt, the page, the site, the stage, the dates,
the way the note came, and, for a role that sees the tracker, where it went and its reference. Its
search reads these columns only. The name of an author is the name of a member's account as it is
now, read from the account at each request and not kept in the index; a member who left the
workspace is shown with no name.

**The side panel of the extension lists the same rows, for one site** (FRU-306,
`GET /session/notes`), to the same people, with fewer columns: no place, no channel and no delivery.
It reads no data the console does not, and keeps none: the panel holds a page of the list while it is
open.

### The administrator of the instance, and what each of their reads leaves (FRU-261)

**Whoever runs a worker reads its database, and needs no console for it.** On the Cloud that is
Sakuga, the operator. What follows is what the console gives the administrator of the instance, and
what it writes each time.

- **Who.** The first account of the instance, and the accounts that an administrator names (FRU-280):
  `role` of `user` says it.
  On the Cloud it is the account of the operator. Since FRU-261 the database keeps four more columns
  for each person: `role` (`admin` for the administrator, empty for the others), `banned`,
  `banReason` and `banExpires`. `role` has a route that writes it, and `banned` too since FRU-281:
  it says that an administrator suspended the account. `banReason` and `banExpires` stay empty.
- **What the console shows them, of every workspace**: its name and its owners, the name, the address
  and the role of each member, the day each was last seen, the ways each person signs in, the sites
  and who sees them, where each site sends its notes, the label of each connector and whether it
  needs attention, the invitations that wait, and the **counts** of the notes by stage and of the
  deliveries that did not arrive. Never a key of a connector, a token or a digest.
- **The notes of every workspace** (FRU-272), the same on the Cloud and in self-hosting:
  - of each note: its workspace and its site, the address of its page, its stage, its date, by which
    way it came, whether its author was a visitor, a member or the site, where it went, its reference
    and its link in the tracker, and **its first 64 characters**. Never the name of its author;
  - **the whole text of a note that Fruitback keeps in its own store**: a site that sends nowhere, or
    a receiving address (REST), which keeps the note before it sends it;
  - **of a note that went to a tracker** (Linear, GitHub), the 64 characters and nothing more. The
    worker does not ask the tracker of a workspace for the rest of a note, or for its replies.
- **Each read in a workspace the administrator is not a member of leaves a row** in `admin_reads`:
  the workspace, the account and the address of the administrator, which read (`instance`,
  `workspaces`, `workspace`, `users`, `notes` or `actions`) and its moment. The read does not answer when the row cannot
  be written. **The owners of the workspace read these rows**, and nobody else: no other member, and
  not the administrator. A row goes with its workspace; it keeps the address of the administrator
  after their account goes.
- **Each action of an administrator that changes something leaves a row** in `admin_actions`
  (FRU-280): the account and the address of the administrator who acted, which action (`admin-named`,
  `admin-removed`, and since FRU-281 `account-suspended` or `account-restored`), the account and the
  address of the person it touched, the workspace when the action is in one, a detail when the action
  needs one, and its moment. **The administrators of the instance read these rows.** A suspension or
  a restoration writes one row for each workspace that the person is a member of at that moment, and
  **the owners of that workspace read it**, with the address of the administrator and of the person,
  beside the reads. A row keeps both addresses after the accounts go, and stays after its workspace
  goes. Nothing deletes a row: it lives as long as the database.
- **A suspended workspace** (FRU-282) has one row in `workspace_suspensions`: its moment, and the
  reason that the administrator wrote, if any, of 200 characters at most. **Only the administrators
  of the instance read the reason** (FRU-328): a member, a guest or an owner of the workspace reads
  that it is suspended and since when, in `/console/me` and in the refusal of a write, and never why.
  The restoration deletes the row. Each suspension and each restoration also leaves a row in
  `admin_actions` (`workspace-suspended`, `workspace-restored`), with the workspace and the reason in
  its `detail`: **the owners of the workspace read who acted and when** beside the reads, without the
  reason, and the administrators read the reason too. The reason of a suspension that ended stays
  there, as long as the database. A suspension deletes no note: the
  notes that Fruitback keeps, their replies, the files in transit and the deliveries that wait stay, and a
  restoration serves them again. While it lasts, the widget takes no note on its sites, and no
  delivery goes to its receiving addresses. Its owner can delete the workspace, which deletes all of
  it as for any workspace.
- **An administrator of the instance can delete any workspace** (FRU-284), after typing its name.
  The deletion is at once and nothing undoes it. It deletes what the deletion by its owner deletes:
  its members, its invitations, its sites, its connectors, the deliveries that wait, and the notes
  that Fruitback kept for its sites with their replies. The accounts of its people stay. **The issues
  stay in the tracker of the client**: Fruitback only revokes its own access to Linear. The deletion
  leaves one row in `admin_actions` (`workspace-deleted`): the account and the address of the
  administrator, the moment, the id and the **name** of the workspace, and how many sites, members,
  invitations, connectors and kept notes went. The row stays as long as the database, and the
  administrators of the instance read it; no owner does, as the workspace is gone.
- **An administrator of the instance writes in any workspace** (FRU-283): the role of a member, a
  member added by the address of their account, a new owner (the owners of before become admins),
  an invitation of an address that has no account, and a new workspace for an account. Each write
  leaves one row in `admin_actions`: the administrator, the moment, the workspace, the address of the
  person and the role given, and for a new owner the addresses of the owners of before. **The owners
  of the workspace read these rows** beside the reads. An invitation by an administrator is an
  invitation like any other: its address, its role, its end, and its message when the instance sends
  mail. It names the administrator as the one who invites.
- **An administrator of the instance can delete an account** (FRU-285), after typing its address,
  except one that owns a workspace alone, their own, and the last administrator's. It deletes the
  account, its sessions in the console and in the extension, its ways to sign in, its memberships,
  the invitations it made and the sites shared with it. **Its notes stay**: their text, in Fruitback
  or in the tracker, and the name the tracker got with them; the console lists them as of a
  « Former member », with no name. `forget` deletes the notes of a person. The deletion leaves one
  row in `admin_actions` (`account-deleted`) for each workspace of the account, with the address of
  the account, and **the owners of each workspace read it**.

### What the extension declares to Firefox (FRU-333)

Firefox asks a new extension to declare what it sends out of the browser, and shows that list when
somebody installs it. The extension declares five categories, all required, with the name Mozilla
gives each one:

| Category                    | What the extension sends                                                 |
| --------------------------- | ------------------------------------------------------------------------ |
| `websiteContent`            | the selector, the excerpt of the element text, the page title, a picture |
| `browsingActivity`          | the address of the page of the note                                      |
| `personalCommunications`    | the text of the note                                                     |
| `personallyIdentifyingInfo` | a typed name, or the name and the address of a member in team mode       |
| `authenticationInfo`        | the session of the account that the extension keeps                      |

The list says what the extension can send, not what each note holds: a note with no typed name, for
example, carries no name. It goes to the worker named in the extension, and nowhere else. Because
Firefox shows this list itself only from Firefox 140, the extension asks for Firefox 140 or later.

### What stays in the reporter's browser

Since FRU-119 an account also holds the language its person reads, taken from the browser that opened their first sign-in link, or chosen by them: the e-mails to that address are written in it.

- `localStorage`, under `fruitback:config` (or the `configKey` the integrator chose): the stages the
  reporter hid and the screenshot switch. The reporter's name too, **only if the reporter ticked
  « Remember me on this site »**. For a member of a team who chose where a note goes, the identifier of that place: an opaque
  value, with no name of the tracker (FRU-123). No e-mail, no note. In private mode the extension writes `fruitback:config:extension` into **the site's**
  storage, so a site can see that a reviewer used the extension on it.
- `sessionStorage`, under `fruitback:config:drafts` (or the `configKey` with `:drafts`): **the notes a
  reporter chose to keep for later and has not sent yet** (FRU-124), each a whole note, with the name
  they typed if any. Only after a click on « Keep for later ». They go when they are sent, and with
  the tab. Any script of the page can read them while they are there.
- `sessionStorage`, under `fruitback:config:typing` (or the `configKey` with `:typing`): **the note
  being written, as it is typed** (FRU-311), with the address of its page and the anchor of its
  element, so that a reload or a closed composer does not lose it. Twenty at most. It goes when the
  note is sent or kept for later, when the field is emptied, and with the tab. Any script of the page
  can read it, as it can already read the field while somebody types: the widget's Shadow root is
  open.
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
- The console keeps one thing in `sessionStorage`, under `fruitback:connect`, for fifteen minutes at
  most: the id of a request of the extension, while a person signs in with a provider from
  « Connect this browser » (FRU-240), so the console goes back to that request after the provider.
  It is read once and forgotten, and the tab forgets it when it closes. No name, no address, no
  token.
- **The side panel of the browser** (FRU-296), when the reviewer opens it from the popup, reads the
  address of the active tab of its window, the way the popup does: only for a site the extension
  has access to, or after the click on its icon. It keeps nothing, and sends nothing to a worker.
- **« Name on my notes »** (FRU-302), when the reviewer types one in the page of the extension, is
  kept in the extension's own storage and given to the widget the extension mounts on a site in
  private mode, to fill the name of a note. That page can read it while the widget is mounted. It is
  sent only with a note the reviewer sends, as a name typed in the note is.
- The widget sets no cookie.

## How long a note is kept

As long as the issue or the row exists, and in Fruitback no longer than its site (FRU-194).

- **Linear and GitHub:** the retention of your workspace or repository. Closing an issue does not
  delete it.
- **PostgreSQL:** yours, and the dumps of the database are part of it. A dump kept for a year keeps
  every note for a year. **Removing a site deletes the notes that Fruitback keeps for it**: their
  text, their replies and the deliveries that wait to send them. Deleting a workspace does the same
  for each of its sites. A site added again gets a new id, and nothing gives it the old notes back.
  The notes already in a tracker stay there.

## Next steps

- [Delete a reporter's notes](privacy/delete-notes.md): list them, read the list, then delete, in the database or in your tracker.
- [A notice you can adapt](privacy/notice.md): a paragraph to put near the widget, or in your own privacy policy.
