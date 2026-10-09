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

| Store    | Where a note lands                                       | Who runs it                         |
| -------- | -------------------------------------------------------- | ----------------------------------- |
| `linear` | an issue in your Linear workspace, the seed in its body  | Linear, outside your infrastructure |
| `github` | an issue in your GitHub repository, the seed in its body | GitHub, outside your infrastructure |
| `sqlite` | a row in a database file on your volume                  | you                                 |

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

### What the worker keeps besides the note

- **No access log.** The worker writes to its output at boot, on a configuration problem and on a
  failed request. It does not log the requests it serves. Your reverse proxy probably does: its
  access log holds the address of every visitor that loaded a pin, and you set its retention.
- **The address of a caller, for two minutes, in memory.** The rate limit counts requests per
  address over one-minute windows, and keeps a window for two. Nothing writes the address to disk.
- **The answer to a read, for 15 seconds, in memory.** The read cache keeps a page's notes so a burst
  of visitors costs one call to the store.
- **The extension's sessions, on disk**, when `FRUITBACK_SESSION_PATH` is set. Each row holds the
  subject, name and e-mail the operator gave when minting the pairing code, its dates, and a SHA-256
  digest of the code or token, never the token itself. Expired rows are removed when a new code is
  redeemed.
- **The accounts, on disk**, when `FRUITBACK_ACCOUNTS_PATH` is set (FRU-96). For each person: the
  address a provider or a link proved, the name the provider gave, and which provider signed them in
  with the id it gives them, and the language they read (the browser that opened their first sign-in
  link, or their own choice), which their e-mails are written in. For each workspace: its name, its members and their roles, and the address
  of each site it reviews. No password, and no token of a provider. Deleting a workspace removes its
  members and its sites; the notes already in a tracker stay there.

### What stays in the reporter's browser

Since FRU-119 an account also holds the language its person reads, taken from the browser that opened their first sign-in link, or chosen by them: the e-mails to that address are written in it.

- `localStorage`, under `fruitback:config` (or the `configKey` the integrator chose): the stages the
  reporter hid and the screenshot switch. The reporter's name too, **only if the reporter ticked
  « Remember me on this site »**. No e-mail, no note. In private mode the extension writes `fruitback:config:extension` into **the site's**
  storage, so a site can see that a reviewer used the extension on it.
- The extension keeps its rules and its session tokens in its own storage, which no page can read.
- The widget sets no cookie.

## How long a note is kept

As long as the issue or the row exists. Fruitback deletes nothing on its own.

- **Linear and GitHub:** the retention of your workspace or repository. Closing an issue does not
  delete it.
- **SQLite:** yours, and the file's backups are part of it. A backup kept for a year keeps every
  note for a year.

## Deleting a reporter's notes

The widget asks for no e-mail address since FRU-91, so a note carries one in two cases only: the
integrator's identity token gave it, or the note was written before. A typed name is a claim, and
so was a typed e-mail: a reporter can write somebody else's, and two reporters can write the same
one. So list the notes first, read the list, and delete after.

**A note signed with a name only has no address to search for**, and a note with no name has
nothing to search for at all. Each note has an identifier, and the thread of its pin shows it on the
page.

- **SQLite:** the worker has a command for it. Run it in the container, like `pair`:

  ```bash
  docker exec <container> node server.mjs forget --email alice@example.com --dry-run
  docker exec <container> node server.mjs forget --email alice@example.com
  ```

  The first line lists the notes that give this address, with their `FB-n`, date, page and the start
  of the note, and deletes nothing. The second deletes them, with the team's replies to them. The
  address is compared without case and without the spaces around it. You do not have to stop the
  worker: the file is in WAL mode. A page can still show a deleted note for up to 15 seconds, from
  the cache. Then delete it from your backups too, or record when they expire.

  For a note with no address, list by name, then delete by identifier:

  ```bash
  docker exec <container> node server.mjs forget --name "Alice" --dry-run
  docker exec <container> node server.mjs forget --id FB-12 --id FB-15
  ```

  `--name` only lists, and the command refuses it without `--dry-run`: two reporters sign with the
  same name, so a name finds notes and does not decide which ones go. `--id` deletes the notes you
  name, with their replies. If one identifier of the list names no note, nothing is deleted. Use
  one of `--email`, `--name` and `--id` in a command.

- **Linear and GitHub:** the notes are issues in your own workspace, so you delete them there, and
  the command says so rather than deleting anything. Search the issues for the address, because the
  description states it, read them, and delete the ones that are this reporter's. On GitHub only an
  administrator of the repository can delete an issue. Closing an issue does not delete it.

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
