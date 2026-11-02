# Run Fruitback yourself

A self-hosted Fruitback is three containers that `docker-compose.yml` starts together: **the
worker**, which answers the widget; **PostgreSQL**, where the worker keeps the notes, the sites, the
accounts and the sessions; and **the console**, where a person signs in and adds a site. Every
instance has a database and an administrator account (FRU-225). A visitor who leaves a note needs no
account.

This page goes from an empty folder to a pin that a visitor planted, in seven steps. The pages of
[Before you go to production](#before-you-go-to-production) keep the instance running: the reverse
proxy, a database you already run, backups, upgrades, every variable. [install.md](install.md) is the
other half: the widget on your site, and what each of its options does.

Where this page gives a command or an answer, it was measured on the images under `env -i`, as FRU-50
did, and it says what was not.

## Before you start

- **Docker Engine, with Compose 2.20 or later.** `docker compose up --wait` needs 2.20. Check with
  `docker compose version`.
- **A 64-bit machine, `amd64` or `arm64`.** Linux for a server. For a trial, a Mac with Docker Desktop
  or OrbStack is fine: the path below was measured on one. The images are published for both
  architectures, and Docker picks the right one. One CPU is more than enough for one team: see [Sizing](self-hosting/database.md#sizing-and-more-than-one-replica).
- **`openssl`**, to make the secrets.
- **On a server, two HTTPS names**, one for the worker and one for the console, on one domain:
  `api.feedback.example.com` and `app.feedback.example.com`, for example. A browser blocks a call from
  an `https://` page to an `http://` worker, and the console signs in with a cookie that a browser
  sends between two names of one domain only. The certificates come from the reverse proxy: see
  [Behind a reverse proxy](self-hosting/reverse-proxy.md#behind-a-reverse-proxy). **To try it on one machine, you need neither**:
  the defaults of `.env.example` are `http://localhost:8080` and `http://localhost:8081`.

**The two images are not public yet.** On 2026-10-16 the repository was public, and `ghcr.io` still
refused an anonymous pull of `fruitback-worker` and of `fruitback-console` (an anonymous token
answered `401`): GHCR gives a new package the visibility its repository had then, until an owner
changes it (_Packages → `fruitback-worker` → Package settings → Change visibility_, and the same for
`fruitback-console`). Until then, log in to `ghcr.io` with a token that has `read:packages`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

## From an empty folder to a first pin

Seven steps. Three start the instance, two happen in the console, and two on the site. They were
measured from a folder that held nothing, on 2026-10-16, with the images of this commit.

### 1. Download two files

```bash
mkdir fruitback && cd fruitback
curl -fsSLO https://raw.githubusercontent.com/sakuga-software/fruitback/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/sakuga-software/fruitback/main/.env.example -o .env
```

Measured on 2026-10-16: both files came down, and were the ones of this commit.

### 2. Fill five lines of `.env`

`.env` explains each variable beside it. Five have no value that works for you, and the instance
does not start without them. The worker makes no secret itself: a secret it made would change at
each start, or end up in a backup.

| Line                          | What to write                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `ALLOWED_ORIGINS`             | the address of your site, as the browser sends it: `https://staging.example.com`, no slash |
| `FRUITBACK_POSTGRES_PASSWORD` | `openssl rand -hex 32`: hex, because it goes into an address                               |
| `FRUITBACK_AUTH_SECRET`       | `openssl rand -base64 32`                                                                  |
| `FRUITBACK_IDENTITY_SECRET`   | `openssl rand -base64 32`, another one                                                     |
| `FRUITBACK_FIRST_ADMIN`       | your e-mail address. Nothing is sent to it: it names the first administrator, at step 4    |

The lines below are written for **a trial on one machine**: `ALLOWED_ORIGINS` is
`http://localhost:5500`, where step 6 serves a page. For a real site, write its address in the first
line instead, `https://staging.example.com` for example.

Edit the file, or run these lines in the folder (they work with the `sed` of Linux and of macOS):

```bash
sed -i.bak "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=http://localhost:5500|" .env
sed -i.bak "s|^FRUITBACK_POSTGRES_PASSWORD=.*|FRUITBACK_POSTGRES_PASSWORD=$(openssl rand -hex 32)|" .env
sed -i.bak "s|^FRUITBACK_AUTH_SECRET=.*|FRUITBACK_AUTH_SECRET=$(openssl rand -base64 32)|" .env
sed -i.bak "s|^FRUITBACK_IDENTITY_SECRET=.*|FRUITBACK_IDENTITY_SECRET=$(openssl rand -base64 32)|" .env
sed -i.bak "s|^FRUITBACK_FIRST_ADMIN=.*|FRUITBACK_FIRST_ADMIN=you@example.com|" .env
rm .env.bak
```

**Keep the three secrets and the password somewhere other than the server.** No backup holds them,
and [Back it up](self-hosting/backup.md#back-it-up) says what each one costs when it is lost.

For the trial, `FRUITBACK_PUBLIC_URL` and `FRUITBACK_CONSOLE_URL` stay as they are. On a server, set
them to the two HTTPS names now: see [Behind a reverse proxy](self-hosting/reverse-proxy.md#behind-a-reverse-proxy).

### 3. Start the three containers

```bash
docker compose up -d --wait
```

**With no login to `ghcr.io`, the pull of the two images is refused** while they are private (see
[Before you start](#before-you-start)), and the command ends with:

```text
Error response from daemon: error from registry: unauthorized
```

Then build the two images from a checkout of this repository, and name them in `.env`. That is what
the measurements of this page did. From the folder that holds `.env`:

```bash
git clone https://github.com/sakuga-software/fruitback.git ../fruitback-src
(cd ../fruitback-src &&
  docker build -f apps/worker/Dockerfile -t fruitback-worker:local . &&
  docker build -f apps/console/Dockerfile -t fruitback-console:local .)
sed -i.bak "s|^FRUITBACK_IMAGE=.*|FRUITBACK_IMAGE=fruitback-worker:local|" .env
sed -i.bak "s|^FRUITBACK_CONSOLE_IMAGE=.*|FRUITBACK_CONSOLE_IMAGE=fruitback-console:local|" .env
rm .env.bak
docker compose up -d --wait
```

The builds run in the checkout, inside the parentheses, and the shell stays in the folder of `.env`.
`.env` already has the two image lines, so `sed` replaces them. Measured on 2026-10-16: the clone took
3 seconds, and the two builds 12 and 16 seconds with `--no-cache`, on a Mac that held the base images
and the build cache of an earlier build. A first build on a new machine also downloads Node and the
dependencies: count several minutes, which were not measured.

Measured: about 20 seconds, the pull of PostgreSQL included, then `docker compose ps` shows `worker`,
`postgres` and `console`, each `healthy`. The worker makes its tables in the database at its first
request; there is no command to run for it.

```bash
curl http://localhost:8080/health
# {"ok":true,"store":"postgres"}
```

**A `200` on `/health` does not prove the worker can serve**: it checks the configuration and never
opens the database. Step 7 reads a page, which does. Without the password, Compose starts nothing:
`required variable FRUITBACK_POSTGRES_PASSWORD is missing a value` (measured). Without one of the
secrets, the worker starts, refuses to serve, and `--wait` ends with `container … is unhealthy`: see
[When something is wrong](self-hosting/troubleshooting.md#when-something-is-wrong).

### 4. Open the link of the first administrator

```bash
docker compose logs worker
```

While no workspace has an owner, the worker writes a sign-in link in its log when it starts. The log
has other lines before these (`listening on …`, `better-auth is ready, under /console/auth`); here are
the three lines of the link:

```text
[fruitback] this Fruitback has no owner yet. Sign-in link for you@example.com (FRUITBACK_FIRST_ADMIN):
[fruitback]     http://localhost:8081/sign-in#nnuYpvfbXZOxsrjEchrnOFXOugBwtFCq
[fruitback] you@example.com opens it, and makes the first workspace. Valid for 10 minutes, and usable once. Whoever reads this log can use it: start the worker again for another one.
```

Open it in your browser. The console signs you in, makes your workspace, and names it after the domain
of your address (`Example` for `you@example.com`; « Rename » changes it). **The link is valid ten
minutes and works once, and whoever reads the log in that time can use it in your place.** If it
expired, or the log is gone, this command writes a new one on your terminal, and the one before is
refused from then on (measured):

```bash
docker compose exec worker node server.mjs admin-link --email you@example.com
```

**The last line of the log is wrong within the ten minutes.** It says to start the worker again for
another link, but a restart inside the ten minutes writes no link (measured). It writes this line
instead: « this Fruitback has no owner yet, and a sign-in link for its first administrator was written
less than 10 minutes ago, by this worker or by another one (FRUITBACK_FIRST_ADMIN). Read the log of
that start, wait and start again, or run `node server.mjs admin-link --email <address>`. » Use the
command above: it gives a link at once. Once a workspace has an owner, the worker writes no link at
start: [The first administrator](#the-first-administrator-and-getting-back-in) says how to
get back in.

**Nobody else creates an account unless a workspace invites them** (`FRUITBACK_SIGN_UP`, `invited` by
default). Invite a person from « Members » of the console: they sign in with the address of the
invitation. `FRUITBACK_SIGN_UP=anyone` lets every person who signs in create an account.

### 5. Add your site

The console opens on « Set up Fruitback », at « Your site »:

1. In **Site address**, write the address of the site: `http://localhost:5500` for the trial.
2. Under **Who sees the notes?**, choose **Everyone who visits**. The other choice, « Members of … »,
   is the default: there a visitor sees no pin and, on a new site, cannot leave a note. Only a member
   of the workspace signed in through the extension reads and writes the notes.
3. Click **Add site**.

« Put it on the site » then shows the **Script tag** of this site, with **Copy script**:

```html
<script
  src="http://localhost:8081/v/0.2.0-a47786cf7e4c/fruitback.iife.js"
  data-fruitback-endpoint="http://localhost:8080"
  data-fruitback-client="site_29000420191b4eb2b0ea"
  defer
></script>
```

`site_…` is the id of the site: yours is another one. `/v/0.2.0-a47786cf7e4c/` is the version of the
script your image holds: the version of the widget and the start of a hash of the file, so it changes
with the image. The console serves the script of the widget,
and the worker answers the page of each site you add, whatever `ALLOWED_ORIGINS` says (measured).

### 6. Put the script on the site

Paste it before `</body>` of the pages of the site. For the trial, a page in a folder of its own,
which holds the tag of step 5. **Replace `site_…` with the id of your site**, from the tag the console
shows, before you run it:

```bash
mkdir site && cat > site/index.html <<'EOF'
<!doctype html>
<html lang="en">
  <body>
    <main><h1>My site</h1></main>
    <script
      src="http://localhost:8081/fruitback.iife.js"
      data-fruitback-endpoint="http://localhost:8080"
      data-fruitback-client="site_…"
      defer
    ></script>
  </body>
</html>
EOF
python3 -m http.server 5500 --directory site
```

With `site_…` left as it is, the note is refused: the read and the write answer `400 unknown-client`.

The last command keeps running; use another terminal for the next step.

### 7. Leave a note as a visitor

Open `http://localhost:5500` in a private window, where nobody is signed in. Click **Leave a note**,
then the title, write a note, and click **Send**. The pin is on the title. Another visitor who opens
the page sees it too. The screen of step 5 in the console (« Set up Fruitback », `/setup`) shows
« First note received » if it is still open. The « Sites » screen shows the count `1` for the site,
and « Just now ».

Read it back as the widget does, with the id of your site:

```bash
curl -H 'Origin: http://localhost:5500' \
  'http://localhost:8080/feedback?url=http%3A%2F%2Flocalhost%3A5500%2F&client=site_29000420191b4eb2b0ea'
# {"url":"http://localhost:5500/","issues":[{"id":"1","identifier":"FB-1","title":"The title is too small",…}],…}
```

Measured in a headless Chrome on 2026-10-16: the link, the site, the script on a page served this
way, a note sent from a context with no cookie, and a second visitor who saw one pin. Then
`docker compose up -d --wait --force-recreate`, and the note was still read: it is in the database,
not in a container.

FRU-107 counted seven steps for the path of before FRU-225, which ran one container with no database
and no account. The count stayed. What moved is where a site is made: in the console, by a person who
signed in.

### The same path with no browser

For a server with no browser, or a script. These are the calls the console and the widget make. **They
are not a published interface**: a release can change them, and the console is the way that stays.

After step 4, the token is what follows the `#` of the link. The console calls the worker from its own
origin, and the worker answers that origin alone:

```bash
LINK=$(docker compose logs --no-color worker | grep -o 'http[^ ]*/sign-in#[^ ]*' | tail -n 1)
curl -c cookies.txt -H 'Origin: http://localhost:8081' -H 'Content-Type: application/json' \
  -d "{\"token\":\"${LINK#*#}\"}" http://localhost:8080/console/auth/email/redeem
# {"account":{"id":"acc_…","email":"you@example.com"}}
curl -b cookies.txt -H 'Origin: http://localhost:8081' -H 'Content-Type: application/json' \
  -d '{"name":"Acme"}' http://localhost:8080/console/workspaces
# {"id":"ws_616db6c15f434044be78","name":"Acme","role":"owner"}   (201)
curl -b cookies.txt -H 'Origin: http://localhost:8081' -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:5500","visibility":"everyone"}' \
  http://localhost:8080/console/workspaces/ws_616db6c15f434044be78/sites
# {"id":"site_099a1b20980347838e22","origin":"http://localhost:5500","visibility":"everyone",…}   (201)
```

Write the id of your workspace in the last address. `cookies.txt` holds the session of the
administrator: delete it after. Then the note of a visitor, with no cookie and no token, and the
`Origin` a browser on the site sends:

```bash
curl -X POST http://localhost:8080/feedback -H 'Origin: http://localhost:5500' -H 'Content-Type: application/json' -d '{
  "kind":"fruitback.note","v":3,"id":"sd_first_pin","createdAt":"2026-10-16T00:00:00.000Z",
  "text":"My first pin","page":{"url":"http://localhost:5500/","path":"/"},
  "viewport":{"width":1280,"height":800},
  "anchor":{"selector":"main > h1","tag":"h1","bounds":{"xPct":0,"yPct":0,"wPct":100,"hPct":8}},
  "client":{"id":"site_099a1b20980347838e22"}}'
# {"issue":{"id":"1","identifier":"FB-1"}}   (201)
```

The read of step 7 then answers that note, with the id of the site this answer gave. Measured on 2026-10-16. A read that names no site answers
`400 client-required`. A page whose origin is neither a site of the worker nor in `ALLOWED_ORIGINS`
gets `403 origin-not-allowed`. An origin the worker allows, in `ALLOWED_ORIGINS` or the address of
another site, gets `403 origin-not-allowed-for-client` when it names this site.

## What the compose file decides

- **Three services, and the worker waits for the database** to be healthy before it starts. PostgreSQL
  publishes no port: only the worker reaches it, on the network of the file.
- **Two named volumes**: `fruitback-postgres` holds the database. `fruitback-data` holds nothing for
  this worker; it is where an instance of before kept its files, and where `migrate-to-postgres`
  reads them (see [Upgrading](self-hosting/upgrade.md)). Compose prefixes both with the project
  name, so two stacks on one host keep separate data, and `docker compose down -v` in one cannot
  delete the other's. **`docker compose down -v` deletes the database**: every note, site and account.
- **`FRUITBACK_IMAGE` and `FRUITBACK_CONSOLE_IMAGE` are complete image references**, so each takes a
  tag or a digest (`ghcr.io/sakuga-software/fruitback-worker@sha256:…`). **Compose does not pull a tag
  that is already on the machine**, and `edge` moves on every merge: run `docker compose pull` before
  `docker compose up -d --wait` to update.
- **`TRUSTED_PROXY_HOPS` is 0, because the file publishes the ports directly.** The worker's own
  default is 1, for one Traefik. With 1 and no proxy in front, forged reads kept answering `200` past
  the limit; with 0, they answered `429` (measured on this file, FRU-48).
- **A variable exported in your shell wins over `.env`.** Compose reads the shell first, so a
  `LINEAR_API_KEY` left in a shell profile reaches the container even when `.env` leaves it empty.
  The measurements of this page ran under `env -i` for that reason.
- **`ALLOWED_ORIGINS` is required by the file itself.** Without it, Compose refuses to start:
  `required variable ALLOWED_ORIGINS is missing a value: set ALLOWED_ORIGINS in .env`.
- **`.env.example` lists exactly the variables the compose file reads.** `apps/worker/src/compose.test.ts`
  compares both files, and this page's variable reference, with the variables the worker reads.

## The first administrator, and getting back in

A person signs in to the console by a link sent by e-mail, or with GitHub or Google. **An instance
that has none of the three still has its administrator**: the link of step 4, which the worker writes
in its log while no workspace has an owner. `FRUITBACK_FIRST_ADMIN` names the address it is for. Once
somebody used it, the worker writes nothing, whatever the variable says (measured: no link in the log
after a `--force-recreate`). Empty the variable then.

To get back in when the owner lost their session (a session lasts seven days, and an instance with no
e-mail has no other way):

```bash
docker compose exec worker node server.mjs admin-link --email you@example.com
```

Measured: the command writes `sign-in link for you@example.com, an owner of this Fruitback:` and the
link on your terminal. It makes a link for an instance that has no owner yet, or for the address of an
owner, and refuses any other address with `… is not one: the command makes a link for an owner who lost
their session, and never makes another owner` and exit code 1. A link made before is refused from then
on, and the sessions that are open stay open. The log of the worker gets a line that says a link was
made, for whom, and when: never the link.

**The first account of the instance is its administrator** (FRU-261): the account of this link, when
nobody signed up before it. The worker gives the role in the database, when the account is made, and
no variable names an administrator. On a database that had accounts before this version, the oldest
account gets the role. The administrator reads every workspace of the instance under
`/console/admin/`, and each read in a workspace they are not a member of leaves a row that the owners
of that workspace read: [SECURITY.md](https://github.com/sakuga-software/fruitback/blob/main/SECURITY.md#the-administrator-of-the-instance-fru-261) says
what they see and what they do not. No route names a second administrator yet.

The other people of a workspace are invited from the console, on « Members ». An instance with no
e-mail gives no message to them: the console shows the invitation, and the person who invites passes
it on.

## Where the notes go

**In the database, by default** (`FRUITBACK_STORE=postgres`). The pins on the page and the « Notes »
screen of the console are the interface: there is no triage and no issue to assign. A member sets the
status of a note on that screen or in the side panel of the extension (FRU-367, FRU-384), from the
statuses of its site. A workspace can also send the notes of a site to a tracker it connects in the
console (a Linear workspace, a GitHub repository through a GitHub App, or an address that receives
them: [rest-connector.md](rest-connector.md)), and a site can choose where its notes go.

`FRUITBACK_STORE` is where the notes of a site with no tracker of its own go:

| `FRUITBACK_STORE`    | Where the notes live          | Needs                                                                                                  | Choose it when                                                                                                 |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `postgres` (default) | the database of the worker    | nothing more: the database of `FRUITBACK_DATABASE_URL`                                                 | You want no third party.                                                                                       |
| `linear`             | issues in a Linear team       | `LINEAR_API_KEY`, `LINEAR_TEAM_ID`                                                                     | Your whole instance triages in one Linear team. A workspace can connect its own Linear in the console instead. |
| `github`             | issues in a GitHub repository | a GitHub App: `FRUITBACK_GITHUB_APP_ID`, `FRUITBACK_GITHUB_PRIVATE_KEY`, `FRUITBACK_GITHUB_REPOSITORY` | Your team already works in GitHub issues. The pins have three stages instead of five.                          |
| `memory`             | the memory of the process     | nothing                                                                                                | Never on a server. The image refuses it.                                                                       |

The accounts, the sites and the sessions are in the database whatever this variable says. To get the
Linear key and ids, see [install.md](install.md#a-linear-team-for-the-whole-instance). To create the
GitHub App, see [Storing the notes in GitHub Issues](self-hosting/github-issues.md).

What each store can show on a pin. `store-conformance.test.ts` compares the stages, the reply cap in the
Replies column and the last column with the code. A stage is named here as it is stored, in the
`stage` column and in the JSON. The widget shows `new` as **New**, `todo` as **To do**, `progress`
as **In progress**, `done` as **Done** and `closed` as **Closed**.

| Store      | Stages                                      | What changes the stage                                                                          | Replies                                                                            | Runs in production |
| ---------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| `postgres` | `new`, `todo`, `progress`, `done`, `closed` | The status a member sets in the console or the extension. A fix found wrong goes back to `new`. | The newest 20 rows of the `note_comments` table, which replies and verdicts write. | yes                |
| `linear`   | `new`, `todo`, `progress`, `done`, `closed` | The workflow state of the issue.                                                                | The newest 20 comments on the issue.                                               | yes                |
| `github`   | `new`, `done`, `closed`                     | Closing the issue, and the reason for the close.                                                | The newest 20 comments on the issue.                                               | yes                |
| `memory`   | `new`, `todo`, `progress`, `done`, `closed` | Nothing. Each note gets the next state in a fixed list.                                         | Two canned replies, on every third note.                                           | no                 |

## The console

The console is where a person signs in, makes a workspace, adds its sites and reads its members. It
is a second image, `ghcr.io/sakuga-software/fruitback-console`: static files behind nginx, with no
secret in them. `docker-compose.yml` starts it beside the worker, and step 5 of the path uses it.

**One image serves every instance.** The address of the worker is not built in: the container reads
`FRUITBACK_API` when it starts, writes it in the page and in its `Content-Security-Policy`, and
stops with a sentence when the variable is absent or is not an address. Nothing is built again to
change it.

Two values of `.env` say where the two answer, as a browser reaches them. On one machine, the
defaults of `.env.example`:

```
FRUITBACK_PUBLIC_URL=http://localhost:8080
FRUITBACK_CONSOLE_URL=http://localhost:8081
```

`FRUITBACK_PUBLIC_URL` is where **a browser** reaches the worker, and the console is given that
value as its `FRUITBACK_API`: never write the name of the service there. `FRUITBACK_CONSOLE_URL` is
where a browser reaches the console; the worker answers that origin and no other.

**Two addresses, and that is the default on purpose.** The console calls the worker as another
origin, with the cookie of the session, which is the worker's. Behind a proxy, give them two names
of one domain, as `api.feedback.example.com` and `app.feedback.example.com`: a browser then sends the cookie, which is
`SameSite=Strict`, from one to the other. That is what the Cloud runs. One name with two paths is
not offered: the proxy would have to know every path of the worker, and nobody measured it. Two
names of two different domains do not work: the cookie is not sent.

Outside the compose file:

```bash
docker run -d --name fruitback-console -p 8081:80 \
  -e FRUITBACK_API=https://api.feedback.example.com \
  ghcr.io/sakuga-software/fruitback-console:edge
```

| Variable                   | Default | What it does                                                                                              |
| -------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `FRUITBACK_API`            | none    | The address a browser calls the worker at: `https://host`, with a port or a path if it has one. Required. |
| `FRUITBACK_CONSOLE_LISTEN` | `80`    | The port nginx listens on inside the container. The compose file sets `8080`.                             |

The image runs as a user that is not root (`101`), writes under `/tmp` only, and starts with a
read-only root and no capability: the compose file runs it that way. It serves the script of the
widget too (FRU-106, measured):

| Address                          | Answer                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `/v/<version>/fruitback.iife.js` | the script, `Cache-Control: public, max-age=31536000, immutable`. The snippet gives it. |
| `/fruitback.iife.js`             | the same file, `Cache-Control: public, max-age=300`. Snippets copied before FRU-106.    |
| `/v/<other version>/…`           | `302` to the version of this image, kept five minutes: a snippet from an older image.   |

`<version>` is the version of the widget and the first 12 hex characters of the sha256 of the file, so
the file at one address never changes, and a browser that has it never asks again. A page keeps the
script of the snippet it was given until the snippet changes or the browser drops it from its cache:
to move a site to a new image at once, paste the snippet the console gives now.

## Building it from this repository

From the sources, with no container and no `.env`. The command keeps running:

```bash
pnpm --filter @fruitback/worker dev:pglite      # node --watch on the TypeScript, a database in the process
```

The two images, under the names the compose file pulls, then the path above from step 2:

```bash
cp .env.example .env                  # then fill the five lines of step 2
docker build -f apps/worker/Dockerfile -t ghcr.io/sakuga-software/fruitback-worker:edge .
docker build -f apps/console/Dockerfile -t ghcr.io/sakuga-software/fruitback-console:edge .
docker compose up -d --wait
```

The measurements of this page used these two builds, under other tags named in `FRUITBACK_IMAGE` and
`FRUITBACK_CONSOLE_IMAGE`.

## Before you go to production

The path above runs on one machine. These pages keep it running on a server:

- [Behind a reverse proxy](self-hosting/reverse-proxy.md): the HTTPS names, and `TRUSTED_PROXY_HOPS` for Traefik, Caddy or nginx.
- [Your own database](self-hosting/database.md): a PostgreSQL you already run, a shared one, PgBouncer, and sizing.
- [Back up and restore](self-hosting/backup.md): `pg_dump`, and the four secrets no backup holds.
- [GitHub Issues as a store](self-hosting/github-issues.md): each note becomes an issue, through a GitHub App.
- [Upgrade and roll back](self-hosting/upgrade.md): note the image digest, then upgrade.
- [When something is wrong](self-hosting/troubleshooting.md): the log, `/health`, and what each answer means.
- [Environment variables](self-hosting/environment-variables.md) and [Worker responses](self-hosting/worker.md): the reference.
