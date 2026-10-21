# Running Fruitback yourself

A self-hosted Fruitback is three containers that `docker-compose.yml` starts together: **the
worker**, which answers the widget; **PostgreSQL**, where the worker keeps the notes, the sites, the
accounts and the sessions; and **the console**, where a person signs in and adds a site. Every
instance has a database and an administrator account (FRU-225). A visitor who leaves a note needs no
account.

This page goes from an empty folder to a pin that a visitor planted, in seven steps. Then it covers
what keeps the instance running: the reverse proxy, a database you already run, backups, every
variable, what to check when something is wrong, upgrades and sizing. [install.md](install.md) is the
other half: the widget on your site, and what each of its options does.

Where this page gives a command or an answer, it was measured on the images under `env -i`, as FRU-50
did, and it says what was not.

## Before you start

- **Docker Engine, with Compose 2.20 or later.** `docker compose up --wait` needs 2.20. Check with
  `docker compose version`.
- **A 64-bit machine, `amd64` or `arm64`.** Linux for a server. For a trial, a Mac with Docker Desktop
  or OrbStack is fine: the path below was measured on one. The images are published for both
  architectures, and Docker picks the right one. One CPU is more than enough for one team: see [Sizing](#sizing-and-more-than-one-replica).
- **`openssl`**, to make the secrets.
- **On a server, two HTTPS names**, one for the worker and one for the console, on one domain:
  `api.feedback.example.com` and `app.feedback.example.com`, for example. A browser blocks a call from
  an `https://` page to an `http://` worker, and the console signs in with a cookie that a browser
  sends between two names of one domain only. The certificates come from the reverse proxy: see
  [Behind a reverse proxy](#behind-a-reverse-proxy). **To try it on one machine, you need neither**:
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
and [Back it up](#back-it-up) says what each one costs when it is lost.

For the trial, `FRUITBACK_PUBLIC_URL` and `FRUITBACK_CONSOLE_URL` stay as they are. On a server, set
them to the two HTTPS names now: see [Behind a reverse proxy](#behind-a-reverse-proxy).

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
[When something is wrong](#when-something-is-wrong).

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
   is the default: there a visitor can still leave a note, but sees no pin, and only a member of the
   workspace signed in through the extension reads them.
3. Click **Add site**.

« Put it on the site » then shows the **Script tag** of this site, with **Copy script**:

```html
<script
  src="http://localhost:8081/fruitback.iife.js"
  data-fruitback-endpoint="http://localhost:8080"
  data-fruitback-client="site_29000420191b4eb2b0ea"
  defer
></script>
```

`site_…` is the id of the site: yours is another one. The console serves the script of the widget,
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

Open `http://localhost:5500` in a private window, where nobody is signed in. Click **Leave feedback**,
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
  "kind":"fruitback.seed","v":2,"id":"sd_first_pin","createdAt":"2026-10-16T00:00:00.000Z",
  "note":"My first pin","page":{"url":"http://localhost:5500/","path":"/"},
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
  reads them (see [Upgrading](#upgrading-and-rolling-back)). Compose prefixes both with the project
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

## Behind a reverse proxy

A reverse proxy gives the worker and the console their HTTPS names, two names of one domain (see
[Before you start](#before-you-start)). Set `FRUITBACK_PUBLIC_URL` and `FRUITBACK_CONSOLE_URL` in
`.env` to those two addresses: the console calls the first, and a sign-in link opens the second. When
a proxy is in front:

1. **Stop publishing the two ports to the internet.** A port of the worker that stays public lets a
   caller skip the proxy and write its own `X-Forwarded-For`. Which way depends on where the proxy runs:
   - **The proxy runs on the host** (nginx or Caddy installed with the system): set
     `FRUITBACK_PORT=127.0.0.1:8080` and `FRUITBACK_CONSOLE_PORT=127.0.0.1:8081` in `.env`. The port of
     the worker then answers only on the host's loopback (measured on FRU-50), and the compose file
     stays as downloaded.
   - **The proxy runs in a container** (Traefik, Dokploy): the host's loopback is not the proxy's.
     Remove the `ports` mappings and put the worker and the console on the proxy's network. The
     compose file's commented Traefik block has these steps for the worker; the console takes the same
     labels with its own name and port `8080`. Keep your edit when you download a newer file. Not
     measured here with the console.
2. **Set `TRUSTED_PROXY_HOPS` to the number of proxies between the internet and the container.**
3. **Run the check below** from a machine outside your network.

`docker-compose.yml` carries a commented Traefik block with these three steps. For a proxy on the
host, the minimal configurations are:

```nginx
# nginx: TRUSTED_PROXY_HOPS=1
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
}
```

`$remote_addr` replaces the header with the address nginx saw, so a forged value never reaches the
worker. Many nginx examples write `$proxy_add_x_forwarded_for` instead, which keeps what the caller
sent: with that, a count one too high lets a caller escape the rate limit. Use it only when nginx
sits behind another proxy that it trusts.

```caddyfile
# Caddy: TRUSTED_PROXY_HOPS=1
api.feedback.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

### What `TRUSTED_PROXY_HOPS` does

The rate limit keeps one bucket per client address. The worker reads that address from
`X-Forwarded-For`: the entry `TRUSTED_PROXY_HOPS` places from the right. When the header has fewer
entries than that, the worker uses the address of the connection, which is the nearest proxy — and
every caller then shares that proxy's bucket.

**Proxies do not all write the header the same way**, and that changes what a wrong count costs.
Measured on FRU-50: the worker behind each proxy, a caller sending `X-Forwarded-For: 1.2.3.4`, then
24 reads that each forged a different address, against the default limit of 20.

| In front of the worker, default settings | The worker receives          | `1`           | `2`                      | `3`                      |
| ---------------------------------------- | ---------------------------- | ------------- | ------------------------ | ------------------------ |
| Traefik v3.5                             | the client's address only    | right         | shared bucket            | shared bucket            |
| Caddy 2.10                               | the client's address only    | right         | shared bucket            | shared bucket            |
| nginx 1.29, `$proxy_add_x_forwarded_for` | `1.2.3.4, <client>`          | right         | **bypassed: 24 × `200`** | shared bucket            |
| nginx 1.29, `$remote_addr`               | the client's address only    | right         | shared bucket            | shared bucket            |
| nginx, then Traefik                      | nginx's address only         | shared bucket | shared bucket            | shared bucket            |
| nginx, then Traefik trusting nginx       | `1.2.3.4, <client>, <nginx>` | shared bucket | right                    | **bypassed: 24 × `200`** |

_Right_ and _shared bucket_ both answered 20 × `200` then 4 × `429`: from one caller they look the
same. Which one it is comes from the rule above, and the check below tells them apart.

What to take from it:

- **Traefik and Caddy replace the header** with the address they saw, so a forged value never reaches
  the worker. A count that is too high there does not open the limit; it makes everyone share one.
- **nginx does what its configuration says.** With `$proxy_add_x_forwarded_for` it keeps what the
  caller sent and appends, and a count that is too high hands the rate limit to the caller. With
  `$remote_addr` it replaces, like Traefik.
- **A proxy behind another proxy must trust it**, or the client's address is lost at every count. For
  Traefik that is `--entrypoints.<name>.forwardedHeaders.trustedIPs=<address of the proxy in front>`.
  The first proxy, the one facing the internet, must trust nobody.

### Check it

From a machine outside your network, send 24 reads with forged addresses, on a page of a site that
everyone reads, with the id of that site. A read that names no site answers `400`, and counts all the
same.

```bash
URL='https://api.feedback.example.com/feedback?url=https%3A%2F%2Fstaging.example.com%2F&client=site_…'
for i in $(seq 1 24); do
  curl -s -o /dev/null -w '%{http_code}\n' -H "X-Forwarded-For: 198.51.100.$i" "$URL"
done | sort | uniq -c
```

- **24 × `200`: the count is too high, and anyone can escape the limit.** Lower it by one and check
  again.
- **20 × `200` and 4 × `429`: the limit holds.** Now, within the same minute, read once from a
  second network — a phone on mobile data:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' "$URL"
  ```

  `200` means each caller has its own bucket, and the count is right. `429` means every caller shares
  one: the count is too low, or a proxy lost the client's address.

With another `RATE_LIMIT_PER_MINUTE`, expect that many `200` answers before the `429`s, and send a
few more reads than the limit.

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
of that workspace read: [SECURITY.md](../SECURITY.md#the-administrator-of-the-instance-fru-261) says
what they see and what they do not. No route names a second administrator yet.

The other people of a workspace are invited from the console, on « Members ». An instance with no
e-mail gives no message to them: the console shows the invitation, and the person who invites passes
it on.

## Where the notes go

**In the database, by default** (`FRUITBACK_STORE=postgres`). The pins on the page and the « Notes »
screen of the console are the interface: there is no triage and no issue to assign, and a stage
changes only by an `UPDATE` of the `stage` column. A workspace can also send the notes of a site to a
tracker it connects in the console (a Linear workspace, or an address that receives them:
[rest-connector.md](rest-connector.md)), and a site can choose where its notes go.

`FRUITBACK_STORE` is where the notes of a site with no tracker of its own go:

| `FRUITBACK_STORE`    | Where the notes live          | Needs                                                                                                  | Choose it when                                                                                                 |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `postgres` (default) | the database of the worker    | nothing more: the database of `FRUITBACK_DATABASE_URL`                                                 | You want no third party.                                                                                       |
| `linear`             | issues in a Linear team       | `LINEAR_API_KEY`, `LINEAR_TEAM_ID`                                                                     | Your whole instance triages in one Linear team. A workspace can connect its own Linear in the console instead. |
| `github`             | issues in a GitHub repository | a GitHub App: `FRUITBACK_GITHUB_APP_ID`, `FRUITBACK_GITHUB_PRIVATE_KEY`, `FRUITBACK_GITHUB_REPOSITORY` | Your team already works in GitHub issues. The pins have three stages instead of five.                          |
| `memory`             | the memory of the process     | nothing                                                                                                | Never on a server. The image refuses it.                                                                       |

The accounts, the sites and the sessions are in the database whatever this variable says. To get the
Linear key and ids, see [install.md](install.md#a-linear-team-for-the-whole-instance). To create the
GitHub App, see [Storing the seeds in GitHub Issues](#storing-the-seeds-in-github-issues).

What each store can show on a pin. `store-conformance.test.ts` compares the stages, the reply cap in the
Replies column and the last column with the code. A stage is named here as it is stored, in the
`stage` column and in the JSON. The widget shows `seeded` as **New**, `green` as **To do**, `ripening`
as **In progress**, `ripe` as **Done** and `composted` as **Closed**.

| Store      | Stages                                             | What changes the stage                                                          | Replies                                                                             | Runs in production |
| ---------- | -------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------ |
| `postgres` | `seeded`, `green`, `ripening`, `ripe`, `composted` | An `UPDATE` of the `stage` column of `seeds`. Nothing in the worker changes it. | The newest 20 rows of the `seed_comments` table. Nothing in the worker writes them. | yes                |
| `linear`   | `seeded`, `green`, `ripening`, `ripe`, `composted` | The workflow state of the issue.                                                | The newest 20 comments on the issue.                                                | yes                |
| `github`   | `seeded`, `ripe`, `composted`                      | Closing the issue, and the reason for the close.                                | The newest 20 comments on the issue.                                                | yes                |
| `memory`   | `seeded`, `green`, `ripening`, `ripe`, `composted` | Nothing. Each note gets the next state in a fixed list.                         | Two canned replies, on every third note.                                            | no                 |

## In a database you already run

The compose file starts its own PostgreSQL. To keep the worker in one you run already, write its
address in `.env`; the worker then makes its tables there instead. Either leave the `postgres` service
of the file running, unused, with its password still required, or remove it **together with** the
`depends_on` block of the worker: Compose refuses a service that waits for one that is not there.

```bash
FRUITBACK_DATABASE_URL=postgres://fruitback:<password>@db.internal:5432/fruitback
```

The role of the address needs `CREATE` on the schema of the worker, `public` unless the next section
names another. The worker refuses an address that is not `postgres://` with a host. A database that
does not answer, or a role that cannot create its tables, does not stop the worker: every read and
every write answers `502`, the log says why, and `/health` stays green (measured with the database of
the compose file stopped: `/health` `200`, a read and a write `502 store-unavailable`, and the log
`the accounts did not answer: PostgreSQL did not answer: getaddrinfo ENOTFOUND postgres`).

**The worker does not encrypt the connection by itself.** It is encrypted when the address asks for it
(`?sslmode=require`), and only then. Inside the network of the compose file, nothing leaves the host.
Not measured here: a database that requires TLS.

### In a database that another application uses

The worker can live in a database that is not its own, in a schema of its own (FRU-219). In `.env`:

```bash
FRUITBACK_DATABASE_URL=postgres://fruitback:<password>@<host>:5432/<the database>
FRUITBACK_DATABASE_SCHEMA=fruitback
```

Every table of the worker goes in that schema, with the tables of better-auth (`user`, `session`,
`account`, `organization`…) and the journal of the migrations, `__drizzle_migrations`. **The worker
writes nothing in `public` or in any other schema**: a table `user` that another application keeps
in `public` is not read, not changed, and not in the way.

What whoever runs the database does, once, as a role that may:

```sql
CREATE ROLE fruitback LOGIN PASSWORD '<password>';
CREATE SCHEMA fruitback AUTHORIZATION fruitback;
```

A role that owns its schema, or has `USAGE` and `CREATE` on it, is enough: it needs no right on
`public` and none on the database (measured on PostgreSQL 17, and again on 2026-10-16 with the image:
a database with a table `public.user` of its own, a role that owns the schema `fruitback`, and the
worker made its 25 tables there and none in `public`). A role that has `CREATE` on the
database makes the schema itself. The worker sets the search path of each of its connections to
that schema alone, so a search path in the address, on the role or on the database changes nothing.

- **What the role can still read is the business of the database, not of the worker.** PostgreSQL
  gives every role `USAGE` on `public` by default, and whatever the other application granted to
  `PUBLIC`. The worker names no other schema; a person with the password of the role can. Take from
  the role what it does not need: `REVOKE ALL ON SCHEMA public FROM fruitback` does nothing while
  `PUBLIC` still has the right, so that one is revoked from `PUBLIC`, by whoever owns the database.
  **While the role may use `public`, the worker says so in its log** when it migrates, once for each
  start: « the role of FRUITBACK_DATABASE_URL may use the schema « public » … ». It starts all the
  same: a database may be shared on purpose.
- **A pooler must keep a session**: PgBouncer in session mode, never in transaction mode. See
  « Behind a connection pooler » below.
- **Two workers can share one database**, each in its schema: they do not see each other.
- **Back it up by schema**: `pg_dump -n fruitback`, as `apps/worker/cloud/snapshot-pg.sh` does with
  `PGSCHEMA=fruitback`. A dump of the whole database holds the other application too.
- **To move a worker from `public` to a schema**, stop it, then move each table by hand, the journal
  too: `ALTER TABLE public.<table> SET SCHEMA fruitback` for every table of the worker,
  `__drizzle_migrations` included, and set the variable. The worker does not move a database by
  itself. Not tried here: no worker needs it today.

### Behind a connection pooler (FRU-267)

**In short:**

- **PgBouncer in session mode works**, in `public` and in a schema of its own. Point
  `FRUITBACK_DATABASE_URL` at the pooler; nothing else changes on the worker.
- **Transaction mode is not supported.** It passes a quick look with one worker, and fails when two
  workers start together: a migration runs twice, the lock of the migrations stays held by a
  connection of the pooler, and requests then wait without an answer. **Use session mode.**
- **Session mode shares no connection between clients**, so it saves none: each connection of the
  worker holds one of the server while it is open. A worker opens 10 at most. Give the pool of the
  pooler 10 for each worker, and more for whatever else uses it.
- **Keep the reset of PgBouncer** (`server_reset_query`, `DISCARD ALL` by default in session mode). It
  is what gives the next client a clean connection. Not tried: a pooler with it turned off.

The trial is `apps/worker/pgbouncer/trial.sh`, with its compose file beside it. It starts PostgreSQL 17,
PgBouncer 1.26.1 in the mode it is given and a worker behind it, plays the path of « The same path
with no browser » (the first administrator, a workspace, a site, a note, reads), asks the pooler what
it keeps of a session, starts two workers together on an empty database, and removes everything:

```bash
docker build -f apps/worker/Dockerfile -t fruitback-worker:local .
FRUITBACK_IMAGE=fruitback-worker:local apps/worker/pgbouncer/trial.sh session fruitback
FRUITBACK_IMAGE=fruitback-worker:local apps/worker/pgbouncer/trial.sh transaction fruitback
```

The pooler of the trial, as `trial.sh` writes it (the password is in `userlist.txt`):

```ini
[databases]
fruitback = host=postgres port=5432 dbname=fruitback
[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = session
max_client_conn = 200
default_pool_size = 40
```

**Measured on 2026-10-21**, with the image of `main` at `86286cf`, PgBouncer 1.26.1 and PostgreSQL
17, on a laptop. Each mode was run in `public` and in the schema `fruitback`; the start of two workers
together was run six times in session mode (three in each schema) and ten times in transaction
mode (six in `fruitback`, four in `public`).

| What the worker needs                                                                         | Session mode                                       | Transaction mode                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| One worker: start, 21 migrations, the first administrator, a workspace, a site, a note, reads | all answered as without a pooler                   | the same in these runs, where no other client came between two statements of the worker                                                          |
| The search path of the schema, set on each connection (`SET search_path`)                     | kept, and reset for the next client                | **given to the next client**: a client that set it, then another that asked, read the first one's path                                           |
| The lock of the migrations (`pg_advisory_lock`, then `pg_advisory_unlock`)                    | held and given back by the same session            | **lost**: with another client in between, the unlock ran on another connection (`you don't own a lock`), and the lock stayed held                |
| Two workers that start together on an empty database                                          | 6 out of 6: one waited, both started               | 6 out of 6 in a schema: one of the two migrated at the same time and failed; in 5 the lock stayed held, and in 4 a read waited without an answer |
| The lock of the role of administrator (`pg_advisory_xact_lock`, in a transaction)             | held for the transaction: the second client waited | the same: a transaction keeps its connection                                                                                                     |
| The rate limit and the cache (`Kv`): `synchronous_commit` set for one statement               | `off` for that statement, `on` after it            | the same                                                                                                                                         |
| `LISTEN` and `NOTIFY` (the worker uses neither today)                                         | the notification arrived                           | **lost**: the client that listened was on another connection when it came                                                                        |

**What an operator sees in transaction mode.** Nothing at the first start of one worker: `/health`
answers `200`, and the log says « better-auth is ready ». The failure comes with a second worker, or a
restart while another request runs. The log of the worker that lost says one of:

```text
[fruitback] better-auth did not start: PostgreSQL did not answer: schema "fruitback" already exists
[fruitback] better-auth did not start: PostgreSQL did not answer: relation "connectors" already exists
[fruitback] better-auth did not start: PostgreSQL refused a statement: duplicate key value violates unique constraint "pg_type_typname_nsp_index"
```

and, when the lock of the migrations stayed held, a read of that worker answers nothing: it waits on
the lock (`pg_stat_activity` shows `wait_event` `advisory`), and `/health` stays `200`. In these runs
the worker did not name the pooler: the guard of the search path (« A pooler that shares one session
between clients loses it ») did not fire, since every connection of one worker sets the same path.
To get out of it: put the pooler in session mode, restart PgBouncer (its connections, and the lock
they hold, end), then the workers.

**Since FRU-335 the worker names the pooler.** `migrate` asks the server three things of the session
that holds the lock of the migrations: whether that session held it already for another client,
whether each step runs in that session (`pg_backend_pid()`), and whether the unlock gave it back
(`pg_advisory_unlock` answers `false` in another session). The first two refuse before anything is
written; the third writes a warning after the migrations. The lines start with one of:

```text
[fruitback] better-auth did not start: The session that took the lock of the migrations held it already, for another client: a connection pooler in transaction mode (PgBouncer with pool_mode = transaction) is between the worker and PostgreSQL: …
[fruitback] better-auth did not start: The lock of the migrations was taken in one session, and a connection pooler in transaction mode (PgBouncer with pool_mode = transaction) is between the worker and PostgreSQL: …
[fruitback] The lock of the migrations is still held by another session: a connection pooler in transaction mode (PgBouncer with pool_mode = transaction) is between the worker and PostgreSQL: …
```

and each ends with « Put the pooler in session mode, then restart it » and the name of this section.
Without a pooler, and in session mode, a connection of the worker is one session of the server, and
none of the three fires.

Measured on 2026-10-21 with PgBouncer 1.26.1 and PostgreSQL 17, by `migrate` of the worker run twice
at the same moment through the pooler on an empty database, ten times for each line:

| Through PgBouncer         | Two workers, `public`                                                        | Two workers, schema `fruitback`                                                                                             | One worker alone                                    |
| ------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Session mode              | 10 out of 10: both migrated, nothing said of a pooler                        | 10 out of 10: both migrated, nothing said of a pooler                                                                       | not run again                                       |
| Transaction mode, before  | 10 out of 10 named the pooler; in 2 one of the two failed (`already exists`) | 5 out of 10 named the pooler; in 10 one of the two migrated at the same time and failed (`already exists`, `duplicate key`) | not run again                                       |
| Transaction mode, FRU-335 | 10 out of 10: one migrated, the other refused and named the pooler           | 9 out of 10 named the pooler, 1 stopped at the guard of the search path; none migrated twice; in 3 the lock stayed held     | 20 out of 20 (both schemas): migrated, nothing said |

« Before » is a first version of the change, with the second and third checks only. **One worker
alone is not told**: with no other client, the pooler gives it the same session at each statement,
which is what session mode does, and nothing goes wrong then. The second worker, or the next start
while another client works, is the one that says it.

**In `public`**, transaction mode failed less often in these runs: two workers started 4 times out of
4, and one read once waited without an answer after both restarted. Not supported either: the lock
of the migrations is lost the same way.

**Not tried:** another pooler (pgcat, Supavisor, the pooler of a managed database), PgBouncer with
TLS, statement mode, and a pooler on another host than the database.

## Back it up

The database holds everything the instance keeps: the notes and the replies of the store `postgres`,
the accounts, the workspaces and their sites, the sessions as digests, and the keys of the connectors
encrypted. A note that a site sent to Linear or GitHub is in that tracker, and its backups are the
tracker's.

Back it up with PostgreSQL's own tool, never with a copy of the volume: the files of a database that
runs are not a copy to trust. The second command reads the dump to its end. `pg_restore --list` is not
that check: it reads the table of contents, and accepts a dump cut to a tenth of its size (measured).

```bash
docker compose exec -T postgres pg_dump -Fc -U fruitback -d fruitback -f /tmp/fruitback.pgdump &&
docker compose exec -T postgres pg_restore -f /dev/null /tmp/fruitback.pgdump &&
docker compose cp postgres:/tmp/fruitback.pgdump "./fruitback-$(date +%F).pgdump"
```

Measured on 2026-10-16: the dump held the data of every table of the worker, `seeds`,
`seed_comments`, `sites`, `user` and `session` among them.

**Four values are in no dump: keep them apart, somewhere other than the server.**

- `FRUITBACK_POSTGRES_PASSWORD`: the database keeps the password it was made with. A new one in `.env`
  does not change it, and the worker then cannot connect.
- `FRUITBACK_AUTH_SECRET`: lost or changed, every session of the console ends, and everybody signs in
  again.
- `FRUITBACK_IDENTITY_SECRET`: lost or changed, every extension gets `401` until its next refresh.
- `FRUITBACK_SECRETS_KEY`, if you set one: without it, the keys of the connectors do not open, and
  each workspace adds its key again.

With `FRUITBACK_DATABASE_SCHEMA`, dump the schema only: `pg_dump -n fruitback`, as
`apps/worker/cloud/snapshot-pg.sh` does with `PGSCHEMA=fruitback`. A dump of the whole database holds
the other application too.

### Restore it

The dump is restored in a new database, and the two names are exchanged at the end. The database that
was in service stays whole, under the name `fruitback_before`. `test -s` refuses a file that is missing
or empty before anything is stopped, and the commands stop at the first step that fails: the worker
then stays stopped. Fix the cause, and run them again.

```bash
test -s ./fruitback-2026-10-16.pgdump &&
docker compose stop worker &&
docker compose cp ./fruitback-2026-10-16.pgdump postgres:/tmp/restore.pgdump &&
docker compose exec -T postgres pg_restore -f /dev/null /tmp/restore.pgdump &&
docker compose exec -T postgres createdb -U fruitback fruitback_restored &&
docker compose exec -T postgres pg_restore -U fruitback -d fruitback_restored --no-owner --exit-on-error /tmp/restore.pgdump &&
docker compose exec -T postgres psql -U fruitback -d postgres -q \
  -c 'ALTER DATABASE fruitback RENAME TO fruitback_before' -c 'ALTER DATABASE fruitback_restored RENAME TO fruitback' &&
docker compose up -d --wait
```

Measured on 2026-10-16, with this compose file: with the name of a file that does not exist, the
commands stopped at `test -s`, and the worker kept serving. With the dump, a pin planted after the
backup was gone, the pin planted before it was read, and the server held `fruitback` and
`fruitback_before`. The worker starts with an empty read cache. A second restore needs the name
`fruitback_before` free. Remove that database with `dropdb` when you are sure you do not need it: that
last step was not run in the trial.

### Change `FRUITBACK_IDENTITY_SECRET`

The worker signs with this key the access token of a session of the extension. The console signs in
with the cookie of better-auth, which this key does not sign.

- **Give it to no site.** A site signs nothing: who reads it is chosen in the console.
- **Change it if a site ever had it**, for example an instance of before FRU-225 that served one site
  with no accounts, and when you think it was read by somebody else.

To change it, set a new value of 32 characters or more, different from `FRUITBACK_SECRETS_KEY` and
`FRUITBACK_AUTH_SECRET`, and start the worker again. What it cuts:

- Every token signed with the old key answers `401` at once.
- **Nobody signs in again, and no extension pairs again.** A session of an extension is kept as a
  digest of its refresh token, which this key does not sign: the extension gets a new access token
  at its next refresh. A console session is not signed with this key at all.
- **It ends no session.** Deleting a workspace ends the extensions paired for it, and so does
  removing the person from it.

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
widget too, at `/fruitback.iife.js`, which is the address the snippet of the console gives (measured:
`200`).

## Storing the seeds in GitHub Issues

Each note becomes an issue in one repository, labelled `fruitback`, and also `fruitback:<client>` when
the note names a client. The seed is in a fenced block at the end of the body. GitHub compares label
names without case and limits them to 50 characters, so a client ID with a capital letter, a comma or
another character outside `a-z`, `0-9`, `.`, `_` and `-`, or a long one, gets `fruitback:` and a hash of
the ID instead. The worker signs in as a GitHub App, never with a
personal token. A personal token does not expire and reaches every repository of its owner. The token
the worker mints expires after one hour and reaches one repository.

What you give up: GitHub has two issue states, so a pin has three stages instead of five, and the
settings panel offers only these three.

| The issue                                                      | The stage of the pin         |
| -------------------------------------------------------------- | ---------------------------- |
| open, reopened included                                        | `seeded`, shown as New       |
| closed as completed, or closed before GitHub recorded a reason | `ripe`, shown as Done        |
| closed as not planned, or as a duplicate                       | `composted`, shown as Closed |

**On a public repository, every note is public**, with the name and the address of the reporter when
they typed one. See [SECURITY.md](../SECURITY.md).

### Create the App

1. In the settings of the account or organisation that owns the repository, open **Developer
   settings → GitHub Apps → New GitHub App**.
2. Give it a name and a homepage URL. Clear **Webhook → Active**: the worker does not receive events.
3. Under **Repository permissions**, set **Issues** to **Read and write**, and leave every other
   permission at **No access**. GitHub adds **Metadata: Read-only** itself.
4. Create the App and note its **App ID**. Under **Private keys**, click **Generate a private key**.
   GitHub downloads a `.pem` file.
5. Click **Install App**, choose the account, then **Only select repositories**, and select the
   repository that receives the notes.

**Issues** is the only permission the worker uses: it creates issues and their two labels, lists
issues, and lists the comments of an issue. The App JWT finds the installation and mints the token.

### Configure the worker

In `.env`, the key can keep its line breaks inside double quotes:

```dotenv
FRUITBACK_STORE=github
FRUITBACK_GITHUB_APP_ID=123456
FRUITBACK_GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA…
-----END RSA PRIVATE KEY-----"
FRUITBACK_GITHUB_REPOSITORY=acme/staging-site
```

Or it can be on one line, with each line break written as `\n`. This command prints that line from the
downloaded file:

```bash
awk 'NF { printf "%s\\n", $0 }' fruitback.private-key.pem
```

With `docker run`, pass the file's content: `-e FRUITBACK_GITHUB_PRIVATE_KEY="$(cat fruitback.private-key.pem)"`.

The worker finds the installation from the repository, so a repository in another organisation needs
no other variable. GitHub installs a private App only on the account that owns it, so for another
organisation, make the App public first. Every site with no tracker of its own sends its notes to
this one repository: a site of the console names no repository of its own.

### Check it

`/health` answers `{"ok":true,"store":"github",…}` when the three variables and every other required variable,
`ALLOWED_ORIGINS` included, are valid: it checks
the configuration and never GitHub. Plant a note from the site, then find its issue in the repository. Not measured for this page: it
needs a GitHub App.
If the App is not installed on the repository, or the key belongs to another App, every write answers
`502 store-unavailable`, and a read answers the same code with the status GitHub gave.

### What it costs

An installation token has a budget of at least 5,000 requests an hour. Every read of a page lists the
issues of the client, 100 a call, newest first, and stops at 1,000 issues: a client with more loses its
oldest pins. Each pin of that page with replies costs one or two more calls. The read cache keeps one
answer per page for a short time, so a busy page costs one listing per cache window, not one per
visitor. A write costs one call per label and one for the issue: two calls for a note that names no
client, three for a note that names one.

## Every environment variable

Grouped as in `.env.example`. _Refused_ means the worker starts, logs
`misconfigured, missing: …`, answers `/health` with `503` naming the variable, and every other route
with `500`. Docker then marks the container `unhealthy`, and `docker compose up --wait` fails. An
empty value counts as absent.

### The image and the port

| Variable                  | Default                                          | What it does                                                                                                     | When it is wrong                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRUITBACK_IMAGE`         | `ghcr.io/sakuga-software/fruitback-worker:edge`  | Compose only. The image, as a tag or a digest.                                                                   | A tag that does not exist fails the pull. A tag already on the machine is not pulled again: run `docker compose pull`.                                                                                                                                                                                                                                                                             |
| `FRUITBACK_PORT`          | `8080`                                           | Compose only. The port on the host, or `127.0.0.1:8080` to keep it off the internet.                             | An `.env` from before FRU-48 says `PORT`, which the file ignores: the port falls back to 8080.                                                                                                                                                                                                                                                                                                     |
| `FRUITBACK_CONSOLE_IMAGE` | `ghcr.io/sakuga-software/fruitback-console:edge` | Compose only. The image of the console, as a tag or a digest. See [The console](#the-console).                   | A tag that does not exist fails the pull of the console, and of no other service.                                                                                                                                                                                                                                                                                                                  |
| `FRUITBACK_CONSOLE_PORT`  | `8081`                                           | Compose only. The port of the console on the host, or `127.0.0.1:8081` to keep it off the internet.              | The same port as `FRUITBACK_PORT`: the second container does not start.                                                                                                                                                                                                                                                                                                                            |
| `PORT`                    | `8080`                                           | The port the process listens on, inside the container. Compose sets it to 8080 and does not read it from `.env`. | A value other than the published port makes the worker unreachable, and Docker still reports it `healthy`, because the healthcheck probes the same port (measured with `9000`). With `docker run`, a value that is not a positive integer: the process listens on 8080 with no message, but the healthcheck probes the raw value, so Docker marks the container `unhealthy` (measured with `abc`). |
| `HOST`                    | `0.0.0.0`                                        | The interface the process listens on. Compose does not pass it.                                                  | `127.0.0.1` makes the worker unreachable from outside the container, and Docker still reports it `healthy` (measured).                                                                                                                                                                                                                                                                             |
| `NODE_ENV`                | `production`, set by the image                   | What refuses the in-memory store. Compose does not pass it.                                                      | Any other value lets `FRUITBACK_STORE=memory` start, and every note dies with the container.                                                                                                                                                                                                                                                                                                       |

### Who may call the worker

| Variable                | Default                                        | What it does                                                                                                                                                  | When it is wrong                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS`       | none: required                                 | Origins that may call the worker, comma-separated, or `*`. The address of each site of the console joins the list by itself (measured).                       | Absent: Compose does not start. With `docker run`, the container runs and is refused: `/health` answers `503` naming it, and Docker marks it `unhealthy` (measured). An origin that is not exactly what the browser sends — a trailing slash, `http` for `https`, a missing port — is accepted at boot, and each call from the site answers `403 origin-not-allowed`, which the browser shows as a CORS error. A request with no `Origin`, such as `curl`, is not checked. `*` accepts every site. An origin of the list that is no site of the console plants nothing: a write names a site, and the page of another origin gets `403 origin-not-allowed-for-client` (measured). |
| `TRUSTED_PROXY_HOPS`    | `1` in the worker, `0` in `docker-compose.yml` | The number of proxies between the internet and the container.                                                                                                 | Not a whole number from 0 up: refused. Too high or too low: see [Behind a reverse proxy](#behind-a-reverse-proxy).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `RATE_LIMIT_PER_MINUTE` | `20`                                           | Requests a minute per client address, reads and writes together. Counted in the database, so the replicas share one limit (FRU-67). `/health` is not counted. | Not a whole number above 0: refused. Too low for a team behind one office address: they share a bucket and get `429 rate-limited`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Where the notes live

| Variable                       | Default    | What it does                                                                                                                                                                                                                                                  | When it is wrong                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRUITBACK_STORE`              | `postgres` | Where the notes of a site with no tracker of its own go: `postgres` (the database of `FRUITBACK_DATABASE_URL`), `linear`, `github` or `memory`.                                                                                                               | Unknown: refused, `FRUITBACK_STORE (unknown store "postgre", expected …)`, with the list. The store of a file, of before FRU-225: refused, with what to do: see [Upgrading](#upgrading-and-rolling-back). Unset while `LINEAR_API_KEY`, `LINEAR_TEAM_ID` or a `FRUITBACK_GITHUB_` variable is set: refused, because a worker of before with no store ran on Linear; write the store. `memory` in the image: refused. |
| `FRUITBACK_SQLITE_PATH`        | none       | **Gone since FRU-225.** It named the file of the notes of a worker of before. The notes are in the database; `migrate-to-postgres --seeds` copies a file there.                                                                                               | Set: refused, with what to do. Compose hands it over empty for that reason only.                                                                                                                                                                                                                                                                                                                                     |
| `LINEAR_API_KEY`               | none       | A Linear personal API key. A secret: it never reaches a browser.                                                                                                                                                                                              | Absent with `linear`: refused, with `LINEAR_TEAM_ID`. Wrong: `/health` answers `200`, and every read and write answers `502 store-unavailable`, `Linear responded 401` (measured).                                                                                                                                                                                                                                   |
| `LINEAR_TEAM_ID`               | none       | The team that receives the issues. A client's `teamId` replaces it.                                                                                                                                                                                           | Absent with `linear`: refused. Wrong: not checked at boot; Linear refuses the call, and the worker answers `502 store-unavailable` with Linear's message.                                                                                                                                                                                                                                                            |
| `LINEAR_PROJECT_ID`            | none       | The project for the issues. Optional. A client's `projectId` replaces it.                                                                                                                                                                                     | Wrong: not checked at boot.                                                                                                                                                                                                                                                                                                                                                                                          |
| `FRUITBACK_GITHUB_APP_ID`      | none       | The ID of the GitHub App, or its client ID.                                                                                                                                                                                                                   | Absent with `github`: refused, with the two other `FRUITBACK_GITHUB_` variables. Wrong: not checked at boot; GitHub refuses the App's token, and every read and write answers `502 store-unavailable`.                                                                                                                                                                                                               |
| `FRUITBACK_GITHUB_PRIVATE_KEY` | none       | The App's private key, the `.pem` file GitHub generates. A secret. On one line, write each line break as `\n`; inside double quotes, the key can keep its line breaks. Both forms reach the worker as a key it reads (measured with `docker compose config`). | Absent with `github`: refused. Not an RSA private key: refused, and the diagnostic names the variable, never the key. The key of another App: every read and write answers `502 store-unavailable`.                                                                                                                                                                                                                  |
| `FRUITBACK_GITHUB_REPOSITORY`  | none       | The repository that receives the issues, as `owner/repo`. A client's `repository` replaces it.                                                                                                                                                                | Absent with `github`: refused. Not `owner/repo`: refused. A repository the App is not installed on: `/health` answers `200`, and every read and write answers `502 store-unavailable`.                                                                                                                                                                                                                               |

### Several client sites

| Variable            | Default | What it does                                                                                                                    | When it is wrong                                                                                                                                                               |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FRUITBACK_CLIENTS` | none    | **Gone since FRU-225.** It was the map of the sites of a worker with no database. The console makes each site, in the database. | Set, whatever it holds: refused, with what to do: make each site in the console, then copy its notes with `migrate-to-postgres --seeds <file> --client <id>=<id of the site>`. |

### Identity and reads

| Variable                    | Default                             | What it does                                                                                                                                                                                                                                  | When it is wrong                                                                                                                                                                                                                                                  |
| --------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRUITBACK_IDENTITY_SECRET` | none: required                      | The HS256 key that signs the access token of a session of the extension, 32 characters or more. **Give it to no site**: see [Change `FRUITBACK_IDENTITY_SECRET`](#change-fruitback_identity_secret). Make one with `openssl rand -base64 32`. | Absent: refused (FRU-225). Under 32 characters, or with white space at its start or its end: refused. Changed: every reviewer's access token answers `401` until its next refresh.                                                                                |
| `FRUITBACK_READ`            | none                                | It applies to no site: each site of the console has its visibility, `members` or `everyone`, and the boot log says so (measured). It was the setting of a worker of before FRU-225, `public` or `authenticated`.                              | A typo: refused, never defaulted to `public`.                                                                                                                                                                                                                     |
| `FRUITBACK_HIDE_COMMENTS`   | empty: the team's replies are shown | `1` keeps the team's replies out of the pins.                                                                                                                                                                                                 | Any other value, `true` included, is accepted and hides nothing (measured).                                                                                                                                                                                       |
| `FRUITBACK_TEAM_LOCALE`     | `en`                                | The language of the prose in an issue description, for the team that triages it: `en` or `fr`. It never follows the reporter's browser, and the note itself is never translated.                                                              | A value that is not a locale tag: refused at boot, named in `missing`. A valid tag this build has no words for, `de` for example: the description is in English (measured on the round trip, which holds in every language because only the prose is translated). |

### The database, the console and the sessions

| Variable                      | Default                                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | When it is wrong                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRUITBACK_SESSION_PATH`      | none                                                                        | **Gone since FRU-225.** It named the file of the sessions of the extension, on a worker of before. The sessions are in the database.                                                                                                                                                                                                                                                                                                                                                                                                            | Set: refused, with what to do. Each reviewer pairs again, once, from the console.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `FRUITBACK_FIRST_REVIEWER`    | none                                                                        | **Gone since FRU-225.** It paired the first reviewer of a worker with no workspace. The first administrator is `FRUITBACK_FIRST_ADMIN`, and a reviewer pairs from the console.                                                                                                                                                                                                                                                                                                                                                                  | Set: refused, with what to do.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `FRUITBACK_FIRST_ADMIN`       | none: no link is written when the worker starts                             | The address of the first administrator, for an instance that sends no e-mail and has no provider. A worker whose instance has no owner yet writes a sign-in link for that address in its log when it starts. See [The first administrator](#the-first-administrator-and-getting-back-in).                                                                                                                                                                                                                                                       | Not one address: refused. Without `FRUITBACK_AUTH_SECRET` and its database: refused, and the worker does not make the secret.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `FRUITBACK_ACCOUNTS_PATH`     | none                                                                        | **Gone since FRU-150.** It named the file of the accounts. The accounts are in PostgreSQL, with `FRUITBACK_DATABASE_URL`.                                                                                                                                                                                                                                                                                                                                                                                                                       | Set: refused at boot, and the log says what to set. See [Upgrading a deployment that has an accounts file](#upgrading-a-deployment-that-has-an-accounts-file).                                                                                                                                                                                                                                                                                                                                                                  |
| `FRUITBACK_DATABASE_URL`      | none: required; in `docker-compose.yml`, the `postgres` service of the file | The address of the PostgreSQL database that holds everything the worker keeps: the notes, the accounts, the workspaces and their sites, the connectors and the sessions, as `postgres://user:password@host:5432/database`. The worker makes its tables at the first request, so the role of the address has `CREATE` on the schema of the worker: `public`, or the one of `FRUITBACK_DATABASE_SCHEMA`. The worker sets the search path of each of its connections itself: the one of the address, of the role or of the database has no effect. | Absent: refused, with the four variables below and a word on [Upgrading](#upgrading-and-rolling-back) (FRU-225). Not a `postgres://` address with a host: refused. With `FRUITBACK_SESSION_PATH` or `FRUITBACK_CLIENTS`: refused. It holds a password: no log of the worker and no answer of `/health` quotes it. A database that does not answer, or a role that cannot create in the schema of the worker: the worker answers `502` to every read and every write, the log says why, and `/health` stays green.               |
| `FRUITBACK_DATABASE_SCHEMA`   | `public`                                                                    | The schema of that database for the tables of the worker and its journal of migrations: see [In a database that another application uses](#in-a-database-that-another-application-uses).                                                                                                                                                                                                                                                                                                                                                        | Not a plain name (a lower-case letter or `_`, then lower-case letters, digits and `_`, 63 characters at most, not `pg_…` or `information_schema`, and not a key word of SQL such as `user`, `order` or `table`): refused, and the value is not quoted. Set without `FRUITBACK_DATABASE_URL`: refused. A schema that is not there and a role that cannot create in the database: `502`, and the log says what to grant.                                                                                                          |
| `FRUITBACK_POSTGRES_PASSWORD` | none: required by `docker-compose.yml`                                      | The password of the PostgreSQL that `docker-compose.yml` starts beside the worker. The worker does not read it: the compose file puts it in the address it gives the worker. Make one with `openssl rand -hex 32`: it goes into an address.                                                                                                                                                                                                                                                                                                     | Absent: `docker compose` starts nothing, and names it. Changed after the first start: the database keeps the password it was made with, and the worker cannot connect.                                                                                                                                                                                                                                                                                                                                                          |
| `FRUITBACK_CONSOLE_URL`       | none: required; `http://localhost:8081` in `.env.example`                   | Where the console answers. A sign-in link opens it, and the console routes answer this origin only, with credentials.                                                                                                                                                                                                                                                                                                                                                                                                                           | Absent: refused (FRU-225). Plain `http://` on a host other than localhost: refused.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `FRUITBACK_MAIL_FROM`         | none: no sign-in by link                                                    | The address the sign-in links come from, on a domain the provider verified.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Set without `FRUITBACK_SCALEWAY_TEM`: refused. A domain the provider did not verify: `/console/auth/email` answers `502 mail-unavailable`.                                                                                                                                                                                                                                                                                                                                                                                      |
| `FRUITBACK_SCALEWAY_TEM`      | none: no sign-in by link                                                    | Scaleway Transactional Email, as `<project id>:<secret key>` of an API key that may send.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Set without `FRUITBACK_MAIL_FROM`, or with no colon: refused. A revoked key: `/console/auth/email` answers `502 mail-unavailable`.                                                                                                                                                                                                                                                                                                                                                                                              |
| `FRUITBACK_PUBLIC_URL`        | none: required; `http://localhost:8080` in `.env.example`                   | The address this worker answers at, as a browser reaches it, behind its proxy. The console calls it, and GitHub, Google and Linear send a person back to it.                                                                                                                                                                                                                                                                                                                                                                                    | Absent: refused (FRU-225). Plain `http://` on a host other than localhost, or with a path: refused.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `FRUITBACK_GITHUB_OAUTH`      | none                                                                        | **Gone since FRU-150.** It named the GitHub OAuth App of the sign-in of before. `FRUITBACK_AUTH_GITHUB_OAUTH` is the one that signs in.                                                                                                                                                                                                                                                                                                                                                                                                         | Set: refused at boot, and the log says what to remove.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `FRUITBACK_GOOGLE_OAUTH`      | none: no sign-in with Google                                                | A Google OAuth client of type « Web application », as `<client id>:<client secret>`. Its redirect URI is `<FRUITBACK_PUBLIC_URL>/console/auth/callback/google`.                                                                                                                                                                                                                                                                                                                                                                                 | No colon, or set without `FRUITBACK_AUTH_SECRET`: refused. A redirect URI that differs from the client's: Google refuses the sign-in.                                                                                                                                                                                                                                                                                                                                                                                           |
| `FRUITBACK_LINEAR_OAUTH`      | none: a workspace connects Linear with a key                                | A Linear OAuth application, as `<client id>:<client secret>`. Its callback is `<FRUITBACK_PUBLIC_URL>/auth/linear/callback`.                                                                                                                                                                                                                                                                                                                                                                                                                    | No colon, or set without `FRUITBACK_PUBLIC_URL`, `FRUITBACK_DATABASE_URL` or `FRUITBACK_SECRETS_KEY`: refused. A callback that differs from the application's: Linear refuses the consent.                                                                                                                                                                                                                                                                                                                                      |
| `FRUITBACK_SECRETS_KEY`       | none: a workspace connects no tracker                                       | What encrypts, in the database, the key of each connector a workspace adds. At least 32 characters.                                                                                                                                                                                                                                                                                                                                                                                                                                             | With white space at its start or its end: refused. Equal to `FRUITBACK_IDENTITY_SECRET`, white space aside, or set without `FRUITBACK_DATABASE_URL`: refused. Changed or lost: every connector answers `502`, and each workspace adds its key again.                                                                                                                                                                                                                                                                            |
| `FRUITBACK_AUTH_SECRET`       | none: required                                                              | What better-auth signs the session cookie of the console with. The worker builds better-auth when it starts, says so in its log, and serves its sign-in under `/console/auth` (FRU-147). At least 32 random characters. Make one with `openssl rand -base64 32`.                                                                                                                                                                                                                                                                                | Absent: refused (FRU-225): an administrator can always sign in, and the worker makes no secret. Under 32 characters, or with white space at its start or its end (a value of spaces, a line that kept one): refused. Equal to `FRUITBACK_IDENTITY_SECRET` or `FRUITBACK_SECRETS_KEY`, white space aside: refused. With a `BETTER_AUTH_…` variable in the environment: refused, because better-auth reads those over what the worker gives it. Changed or lost: every session of the console ends, and everybody signs in again. |
| `FRUITBACK_AUTH_GITHUB_OAUTH` | none: no sign-in with GitHub                                                | A GitHub OAuth App, as `<client id>:<client secret>`. Its callback is `<FRUITBACK_PUBLIC_URL>/console/auth/callback/github`.                                                                                                                                                                                                                                                                                                                                                                                                                    | No colon: refused. Without `FRUITBACK_AUTH_SECRET`: refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `FRUITBACK_AUTH_TRACK_IP`     | none: no address and no user agent kept                                     | `1`: better-auth keeps the address and the user agent of each session of the console, and limits by address too, with the address the worker read behind its trusted proxies.                                                                                                                                                                                                                                                                                                                                                                   | Any value but `1`: refused. Without `FRUITBACK_AUTH_SECRET`: refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `FRUITBACK_SIGN_UP`           | `invited`: the people a workspace invites, and nobody else                  | Who may create an account. `invited`: a sign-in that would create an account is refused, except for an address that a workspace invited and whose invitation waits, the first account of the instance, and the link of `FRUITBACK_FIRST_ADMIN` or of `admin-link`. The console tells a person who is refused to ask for an invitation. `anyone`: every person who signs in gets an account, and can make a workspace. A person who has an account signs in with either value.                                                                   | Another value, `Anyone` included: refused, with the two values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `FRUITBACK_FAKE_LINEAR`       | none                                                                        | The old spelling of `FRUITBACK_STORE=memory`. Deprecated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | In the image it is ignored, and the boot log says so. Delete the line.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `FRUITBACK_DEV_DATABASE`      | none                                                                        | Development only: `pglite` gives the worker of `pnpm dev` a PostgreSQL in its process. Compose does not pass it.                                                                                                                                                                                                                                                                                                                                                                                                                                | In the image: refused, `/health` answers `503` and names it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `FRUITBACK_DEV_VISIBILITY`    | none                                                                        | Development only: read by the worker of `pnpm dev`, for the site it makes. Compose does not pass it.                                                                                                                                                                                                                                                                                                                                                                                                                                            | The image does not read it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## When something is wrong

**Start with the first lines of the log**, `docker compose logs worker`. Measured, on the path above:

```text
[fruitback] listening on 0.0.0.0:8080 · store postgres · origins http://localhost:5500 · trusted proxy hops 0
[fruitback] who reads a site is chosen site by site, in the console: members only, or everyone. FRUITBACK_READ does not apply to a worker with accounts.
[fruitback] better-auth is ready, under /console/auth
```

The first line names the store, the origins and the hop count the worker actually runs with. A worker
that is refused logs `[fruitback] misconfigured, missing: … — /health will report 503` instead. On
`docker stop` it logs `SIGTERM received, draining`, and exits within 10 seconds.

**`/health` checks the configuration, and nothing else.** It does not open the database, does not call
a tracker, and is not rate-limited. So read a page too, with the id of a site:
`curl -H 'Origin: <the site>' 'http://localhost:8080/feedback?url=<the page, encoded>&client=<site_…>'`.

| You see                                                                                    | `/health`                                                  | A read                                                      | Cause                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Compose starts nothing: `required variable FRUITBACK_POSTGRES_PASSWORD is missing a value` | —                                                          | —                                                           | The password is not in `.env` (measured). The same for `ALLOWED_ORIGINS`.                                                  |
| `docker compose up --wait` ends with `container … is unhealthy`                            | `503` `{"ok":false,"error":"misconfigured","missing":[…]}` | `500`                                                       | Each entry of `missing` names a variable and what to do. Fix every one: they are all listed at once (measured).            |
| The entry names `FRUITBACK_DATABASE_URL` and « Upgrading »                                 | `503`                                                      | `500`                                                       | No database: an `.env` of before FRU-225, or a `docker run` with no address. See [Upgrading](#upgrading-and-rolling-back). |
| An entry names a variable of before, `FRUITBACK_CLIENTS` for example                       | `503`                                                      | `500`                                                       | A variable an instance of before set. Its sentence says what replaces it. See [Upgrading](#upgrading-and-rolling-back).    |
| Nothing is planted, the widget keeps the note                                              | `200`                                                      | `502 store-unavailable`                                     | The database does not answer, or a tracker refuses its key. The log says which (measured with the database stopped).       |
| No link in the log at step 4                                                               | `200`                                                      | —                                                           | `FRUITBACK_FIRST_ADMIN` is empty, or a workspace has an owner already. Use `admin-link`.                                   |
| Pins do not appear, the browser shows a CORS error                                         | `200`                                                      | `403 origin-not-allowed` or `origin-not-allowed-for-client` | The page is on no site of the console, or on another site than the one its script names (measured).                        |
| A read answers `400 client-required` or `400 unknown-client`                               | `200`                                                      | `400`                                                       | The read names no site, or a site this worker does not have. The script of the console names it (measured).                |
| A visitor sees no pin, and a note they send is kept                                        | `200`                                                      | `401 identity-required`                                     | The site is read by « Members of … ». Choose « Everyone who visits » in the console, if every visitor may read the notes.  |
| Docker says `healthy`, nothing answers from outside                                        | unreachable                                                | unreachable                                                 | `HOST` is not `0.0.0.0`, or `PORT` is not the published port.                                                              |
| Every caller gets `429` at once                                                            | `200`                                                      | `429 rate-limited`                                          | Callers share one bucket: see [Check it](#check-it).                                                                       |

The other answers the worker gives:

| Code         | `error`                                                                      | Means                                                  |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `400`        | `invalid-body`, `invalid-json`, `invalid-seed`, `invalid-url`, `missing-url` | The request is wrong.                                  |
| `401`        | `identity-required`, `invalid-identity`                                      | The read needs a session, or the token did not verify. |
| `403`        | `origin-not-allowed`, `origin-not-allowed-for-client`                        | The calling site is not allowed.                       |
| `404`, `405` | `not-found`, `method-not-allowed`                                            | No such route.                                         |
| `413`        | `payload-too-large`                                                          | The body is over the limit.                            |
| `429`        | `rate-limited`                                                               | The address used up its requests for the minute.       |
| `500`        | `misconfigured`                                                              | The configuration is refused; `/health` says why.      |
| `502`        | `store-unavailable`                                                          | The store did not answer. The widget keeps the note.   |
| `503`        | `limiter-unavailable`                                                        | The rate limiter's state did not answer.               |

## Upgrading and rolling back

**Upgrade:**

1. [Back up](#back-it-up) every database.
2. Write down the image you run now, as a digest from the registry:

   ```bash
   docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' \
     "$(docker compose images -q worker)" | grep '^ghcr.io/'
   ```

   Keep the `ghcr.io/` line. An image that also has a local tag lists a name no registry serves, and
   on the containerd image store that name came first (measured).

3. If `FRUITBACK_IMAGE` in `.env` names a digest, or a version such as `1.4.2`, set it to the new
   one first: the pull below does not change a digest, and a version tag moves only when that release
   is rebuilt. A moving tag (`edge`, `latest`, `1.4`) needs nothing set: the pull takes its new image.
   Pull and restart, then check `/health` and a read:

   ```bash
   docker compose pull
   docker compose up -d --wait
   ```

The database migrates by itself, at the first request that needs it, under a lock, with the
migrations that `drizzle-kit` wrote (FRU-180). A database that an earlier image made with its own
migration tool is adopted as it is, and nothing in it runs again, when that image had the tables of
better-auth (FRU-144, image `sha-e74be5311941918429e9b5cf15a1518e49ba828c`, and the ones after it). A
database that an image from before FRU-144 made is refused, and the log says why: start that image of
FRU-144 on it once, then the new one. An image of before still opens a database that was adopted.

**Roll back:** set `FRUITBACK_IMAGE` in `.env` to the digest from step 2, then
`docker compose up -d --wait`.

**An older image does not refuse a database that a newer one migrated.** It runs its own code against
the newer schema. When a release adds a migration that an older image cannot read, its notes say so,
and a rollback past it means restoring the backup from step 1 — and losing the pins planted since.

**What an instance of before FRU-225 loses on the way, and nothing else:** the pairings of the
extension, when it had no accounts. Each reviewer pairs again, once, from the console. The notes, the
sites and the accounts move with `migrate-to-postgres`, below.

### Upgrading a worker that has no database (FRU-225)

A worker with no `FRUITBACK_DATABASE_URL` stops at the upgrade: `/health` answers `503`, every other
route `500`, and the log names `FRUITBACK_DATABASE_URL`, the four variables below and this section
(measured on the image). Nothing is lost: the files stay on the volume, and the image of before
still reads them. To move:

1. Take the new `docker-compose.yml` and the new `.env.example`. In `.env`, fill the five lines that
   `.env.example` asks for: `FRUITBACK_POSTGRES_PASSWORD`, `FRUITBACK_AUTH_SECRET`,
   `FRUITBACK_IDENTITY_SECRET` (keep the one of before if it had one), `FRUITBACK_FIRST_ADMIN`, and the
   two addresses, `FRUITBACK_PUBLIC_URL` and `FRUITBACK_CONSOLE_URL`. Empty `FRUITBACK_CLIENTS`,
   `FRUITBACK_SESSION_PATH`, `FRUITBACK_SQLITE_PATH` and `FRUITBACK_FIRST_REVIEWER`, and set
   `FRUITBACK_STORE=postgres`, or `linear` or `github` to keep sending the notes to that tracker.
2. `docker compose up -d --wait`, then open the link of `docker compose logs worker`: the first
   administrator makes the first workspace. Add each site in the console, one for each client of
   `FRUITBACK_CLIENTS`, or one for the one client of a worker that had no map.
3. A worker that kept its notes in SQLite copies them:
   [Moving the notes of the SQLite file into PostgreSQL](#moving-the-notes-of-the-sqlite-file-into-postgresql).
   Notes in Linear or GitHub stay there: the site reads them where they are, once the console gives
   it that tracker, or through `FRUITBACK_STORE`.
4. **Each reviewer pairs the extension again, once**, from the console. A session of a worker with
   no workspace names no member, and is not copied.

**The way back** is the image of before, by its digest, and the `.env` of before.

### Upgrading a deployment that has an accounts file

Only for a worker that had `FRUITBACK_ACCOUNTS_PATH`. Since FRU-150 the accounts are in PostgreSQL
and nowhere else, and the worker **refuses to start** with that variable: `/health` answers `500`
and the log says what to set. It does not start without the accounts, because a console with no
workspace reads as the accounts lost. The same holds for `FRUITBACK_GITHUB_OAUTH`, the GitHub App of
the sign-in of before.

1. Keep the image that runs, by its digest (step 2 of « Upgrade »), and stop the worker. Copy
   `accounts.db` and `sessions.db`, each with its `-wal`, out of the volume: they are the way back.
2. Take the new `docker-compose.yml`, set `FRUITBACK_POSTGRES_PASSWORD` in `.env`
   (`openssl rand -hex 32`), and start the database alone: `docker compose up -d --wait postgres`.
3. Copy the two files into it, with the new image. The command reads `FRUITBACK_DATABASE_URL` and
   the two paths, and never writes the files. Try it with `--dry-run` first, then without:

   ```bash
   docker compose run --rm --no-deps worker \
     node server.mjs migrate-to-postgres --accounts /data/accounts.db --sessions /data/sessions.db --dry-run
   ```

   Each line says `same`, and the last one `dry run`, then `copied`. A file of a worker older than the
   last one with an accounts file is refused: start that last image on it once, then copy.

4. In `.env`: remove `FRUITBACK_ACCOUNTS_PATH`, `FRUITBACK_SESSION_PATH` and
   `FRUITBACK_GITHUB_OAUTH`; set `FRUITBACK_DATABASE_URL`, `FRUITBACK_AUTH_SECRET` (32 random
   characters or more, not one of the other secrets) and `FRUITBACK_PUBLIC_URL`. For GitHub, a
   GitHub OAuth App whose callback is `<FRUITBACK_PUBLIC_URL>/console/auth/callback/github`, in
   `FRUITBACK_AUTH_GITHUB_OAUTH`. For Google, the redirect URI of the client becomes
   `<FRUITBACK_PUBLIC_URL>/console/auth/callback/google`.
5. `docker compose up -d --wait`, with the console of the same release. The log
   says « better-auth is ready, under /console/auth ». **Everybody signs in to the console again,
   once**, with the same address or the same GitHub or Google account, and finds their workspaces. No
   extension pairs again.

**The way back** is the image of step 1, the `.env` of before and the two files. What was written
to the database since is not in them.

The copy is held by `postgres-copy.test.ts` and `accounts-move.test.ts`, on PGlite and on
PostgreSQL 17. **Not tried:** these five steps with `docker compose`, as written here.

### Moving the notes of the SQLite file into PostgreSQL

For a worker that kept its notes itself, with `FRUITBACK_STORE=sqlite`, which was the default of the
compose file. PostgreSQL is required since FRU-225, and that file is read by nothing else. The notes
and their replies move with one command, and **a pin keeps its number**.

1. Keep the image that runs, by its digest, and stop the worker. Copy the file of
   `FRUITBACK_SQLITE_PATH` with its `-wal` out of the volume: it is the way back.
2. Steps 1 and 2 of [Upgrading a worker that has no database](#upgrading-a-worker-that-has-no-database-fru-225):
   the database, the console, and each site. A site has an id of its own, which the console shows.
3. Try the copy, then run it without `--dry-run`. It reads `FRUITBACK_DATABASE_URL`, and never
   writes the file:

   ```bash
   docker compose run --rm --no-deps worker \
     node server.mjs migrate-to-postgres --seeds /data/fruitback.db --no-client <the id of the site> --dry-run
   ```

   `--no-client` gives a site the notes of a worker that had one client. A worker that had
   `FRUITBACK_CLIENTS` takes one `--client <its id of before>=<the id of the site>` for each client.
   The command says, for each client of the file, how many notes it has and where they go, and
   whether that is a site of the database: **a note that goes to no site is copied, and no page
   reads it**. The two lines of counts say `same`, and the last one `dry run`, then `copied`.

4. Nothing to change in `.env`: step 1 of the section above set `FRUITBACK_STORE=postgres` and
   emptied the variables of before. The worker reads the notes from the database at once.
5. **Each reviewer pairs the extension again, once**: `pair` writes its code in the database now.
   A session of a worker that had no accounts names no member of a workspace, and is not copied.

**The way back** is the image of step 1, the `.env` of before and the file. A note sent since is
not in it. `apps/worker/cloud/README.md`, « Switch 1 bis », is the same switch for the Cloud, with
what was tried. **Not tried:** these five steps with `docker compose`, as written here.

### Upgrading a deployment from before FRU-48

The old compose file built the image, kept no volume, read `PORT` for the host port, defaulted
`TRUSTED_PROXY_HOPS` to 1, and passed no `FRUITBACK_STORE`, so the worker ran on Linear. An `.env`
written for it keeps those values, and the new file reads it differently. **Since FRU-225 this is the
first half of the move**: the files land on the volume of the new file, and
[Upgrading a worker that has no database](#upgrading-a-worker-that-has-no-database-fru-225) then
copies them into the database. The blocks below were measured before FRU-225; the last command of the
second one starts a worker that refuses to serve until `.env` has the lines that section names.

**If the old deployment kept SQLite seeds or extension sessions under `/data`, copy them out first.**
The old file mounted no volume, so `/data` was an anonymous volume that the image of before declared. The new
file mounts the named volume there, which starts empty, and the pins and sessions then seem to be
gone. The old volume is not deleted, but nothing mounts it.

In the `for` line of both blocks below, write the files the old deployment used: the value of
`FRUITBACK_SQLITE_PATH`, and the value of `FRUITBACK_SESSION_PATH` if it was set. A file outside
`/data` was never on a volume, and nothing is left to copy. The list is written in the loop, not in a
variable, because zsh does not split a variable into words. With the **old** file still in place:

```bash
for db in /data/fruitback.db /data/sessions.db; do
  docker compose exec -T worker sqlite3 "$db" ".backup '$db.migrate'" &&
  docker compose cp "worker:$db.migrate" "./$(basename "$db").migrate"
done
```

Then replace the compose file, and make the changes below with the **same** paths in `.env`. Restore
into the new volume before the worker serves anything. `docker compose create` makes the container and
the empty volume without starting it, each restore runs in a one-off container, and the worker starts
only if every restore succeeded:

```bash
docker compose create &&
ok=yes &&
for db in /data/fruitback.db /data/sessions.db; do
  docker compose cp "./$(basename "$db").migrate" "worker:$db.migrate" &&
  docker compose run --rm --no-deps --entrypoint sh worker -c \
    "test -s '$db.migrate' && sqlite3 '$db' \".restore '$db.migrate'\" && rm -f '$db.migrate' '$db.migrate-shm' '$db.migrate-wal'" ||
  { ok=no; echo "restore of $db failed: the worker stays stopped"; break; }
done &&
[ "$ok" = yes ] &&
docker compose up -d --wait
```

If a restore fails, the worker is not started, and the old volume and the `.migrate` files are left
as they were: fix the cause, then run the block again.

Measured with sessions on, in bash and in zsh, on a volume that started empty: with both files, the
pin was back and the pairing code was still in `sessions.db`. With `sessions.db.migrate` missing, the
block stopped at that restore, and the worker was created but never started.

Before the first `docker compose up` with the new file, change these lines in `.env`:

1. **If the notes are in Linear, add `FRUITBACK_STORE=linear`.** Otherwise the worker refuses to start,
   and says to name the store: a worker with a key of Linear and no store ran on Linear before FRU-225.
2. **Rename `PORT` to `FRUITBACK_PORT`.** The new file ignores `PORT`, so a custom host port falls
   back to 8080.
3. **Set `TRUSTED_PROXY_HOPS` to the number of proxies in front.** The old template wrote 1. Keep 1
   behind one Traefik; change it to 0 if the port is published directly, or a forged
   `X-Forwarded-For` escapes the rate limit.
4. **Add `FRUITBACK_IMAGE`** only to choose a version or to pin a digest. Without it, the file pulls `edge`.

## Sizing, and more than one replica

**A small worker.** Measured on FRU-50, on an Apple Silicon machine under OrbStack, the container
limited to one CPU (`--cpus=1`), on the store of before FRU-225, a file on a volume, with `RATE_LIMIT_PER_MINUTE` raised to
100 000 000 so that the load tool was not refused:

| Load                                                               | Throughput     | Latency (median, 99th) | Memory after |
| ------------------------------------------------------------------ | -------------- | ---------------------- | ------------ |
| At rest                                                            | —              | —                      | 24 MiB       |
| 20 000 reads of a page with 20 pins, 50 at a time                  | 4 417 a second | 7 ms, 52 ms            | 99 MiB       |
| 2 000 writes, 10 at a time                                         | 738 a second   | 13 ms, 24 ms           | —            |
| 5 000 reads of a page with 2 020 pins, a 1 MB answer, 50 at a time | 302 a second   | 159 ms, 217 ms         | 162 MiB      |

The database held 2 020 pins in 4.8 MB. Read these numbers with three limits in mind:

- **Reads come from the cache.** A page's answer is kept for 15 seconds, so the read rows measure the
  cache and the JSON, not the store. A cold page costs one store call per container every 15 seconds.
- **For one caller, the rate limit is the ceiling, not the CPU.** With the default of 20, one address
  gets 20 requests a minute, far below the throughput above. Many addresses together can go higher, up
  to what one container serves.
- **Another machine gives other numbers.** A small VPS core is slower than this one. The shape holds:
  memory stays under 200 MiB, and a page with thousands of pins is the expensive case.

**Not measured again on PostgreSQL.** The reads above come from the cache, which the store does not
change; a write and a cold read go to the database now, and nobody timed them for this page.

**The worker keeps the state of the rate limiter and of the read cache in the database** (FRU-67), in
a table of its own, with nothing to set: its replicas share one limit and one cache. PostgreSQL itself
is one service of the compose file; several replicas of the worker need it reachable from each. The limiter then writes one row for each request of
the widget, without waiting for the disk; `SECURITY.md` says what that costs.

## Deploying with Dokploy

Dokploy is one way among others: it runs the containers behind its own Traefik, which gives the worker
and the console their HTTPS names. Fruitback Cloud runs this way (`apps/worker/cloud/README.md`). This
section was not replayed for this page. Create a **PostgreSQL** service in the project, then an
**Application** for the worker with either source:

| Setting    | From the image                                                      | From the repository                                          |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| Provider   | Docker, `ghcr.io/sakuga-software/fruitback-worker:edge` or a digest | GitHub, this repository                                      |
| Build type | —                                                                   | Dockerfile, path `apps/worker/Dockerfile`, build context `.` |
| Port       | `8080`                                                              | `8080`                                                       |

Then:

- **Set the environment in Dokploy.** It does not read `docker-compose.yml` or `.env`. The names are
  the ones in [Every environment variable](#every-environment-variable). `LINEAR_API_KEY` belongs in
  Dokploy's environment, never in the image or the repository.
- **`TRUSTED_PROXY_HOPS=1`** for Dokploy's Traefik alone, then [check it](#check-it). For a proxy in
  front of Dokploy, such as a CDN, first make Dokploy's Traefik trust it
  (`forwardedHeaders.trustedIPs`), then add one. Without the trust, Traefik replaces the header and the
  client's address is lost at every count (measured with nginx in front of Traefik).
- **`FRUITBACK_DATABASE_URL`** is the internal address Dokploy gives the PostgreSQL service. Back it
  up as [Back it up](#back-it-up) says, with `pg_dump` in that service's container.
- **The console is a second Application**, from `ghcr.io/sakuga-software/fruitback-console:edge`, port
  `80`, with `FRUITBACK_API` set to the HTTPS address of the worker. See [The console](#the-console).
- **`/health` is the readiness probe.** It answers `503` while the configuration is refused, so a bad
  deploy gets no traffic. The process drains its requests on `SIGTERM`.

## The worker

A plain Node HTTP process — `node:http` adapted onto a web-standard handler, no framework.

| Route                            | Status                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /feedback`                 | plants a seed in the configured store, answers `201` with the issue: `id`, `identifier`, and `url` when the store has a page to open |
| `GET /feedback?url=…[&client=…]` | the seeds of that page: anchor, note, state, stage                                                                                   |
| `OPTIONS /feedback`              | CORS preflight, never reaches the store                                                                                              |
| `GET /health`                    | `200` when the configuration is valid, `503` naming what is wrong when it is not                                                     |

The four below are the browser extension's session (FRU-42), and they are **exempt from
`ALLOWED_ORIGINS`**: an extension's origin
carries an id that differs between an unpacked build and a store build, so an operator cannot put it
on a list. The rate limiter is what protects them, which is why it runs above the path dispatch.

| Route                   | Status                                                      |
| ----------------------- | ----------------------------------------------------------- |
| `POST /session/pair`    | spends a pairing code, opens a session                      |
| `POST /session/refresh` | a refresh token for a fresh access token                    |
| `POST /session/revoke`  | ends the session; `204` whether or not there was one to end |
| `GET /pair`             | the page a pairing link opens: static, no script            |

**A reviewer connects the extension from the console**: « Connect this browser », on « Put it on the
site » or on « Sites », opens the pairing link of your worker (on Fruitback Cloud the same button
leads to the sign-in of the popup instead, FRU-313). An operator can also mint a pairing code on the container, never over HTTP,
for one workspace and one of its members (FRU-277). The workspace id is in the address of the console,
`/w/<id>/sites`, and the workspace must have a site. `--subject` is the id of the member's account,
which the database gives from their address:

```bash
docker compose exec -T postgres psql -U fruitback -d fruitback -Atc \
  "SELECT id FROM \"user\" WHERE email = 'alice@acme.dev'"
docker compose exec worker node server.mjs pair --subject <account id> --name "Alice Martin" --workspace <id>
```

With a [dedicated schema](#in-a-database-you-already-run), add `SET search_path TO <schema>;` before the
`SELECT`. The command refuses, and prints no code, when the workspace is missing, when it has no site,
and when the account is not a member of it: the route would end such a session at once (FRU-149).

Add `--endpoint https://api.feedback.example.com`, the address reviewers reach this worker at, and the
command also prints a link, `https://api.feedback.example.com/pair#<code>`. The reviewer opens it and
clicks the extension: nothing to copy. The code is after the `#`, so it reaches no server and no access
log, yours included. An `http://` address is refused unless it is `localhost`. Measured: the command
writes a code valid 15 minutes. Not measured for this page: a session of that code reading a site.

**The two paragraphs below describe the `linear` store.** A worker on another store does the same job
by its own means — see `apps/worker/src/store.ts`, where `findForPage` states the intention and never
the method.

Labels are created on demand, so a new client site needs no manual Linear setup. A label that cannot
be created is dropped and the feedback still goes through — losing a label is a triage annoyance,
losing the client's note is a bug.

The read path is one Linear query, narrowed server-side by the `fruitback` label, the per-client
label and `description contains <canonical url>`. `contains` being a substring match, the seed's own
`page.url` is re-checked exactly, or `/pricing` would return the pins of `/pricing?tab=annual`.
Answers are cached for 15 s: the same page opened by a room full of reviewers costs one call against
the Linear quota, and a failed call is never cached.

### Building it from this repository

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

## Tags and digests

Every push to `main` publishes `ghcr.io/sakuga-software/fruitback-worker`, for `linux/amd64` and
`linux/arm64`. Docker picks the architecture from the manifest list; there is no per-architecture tag.

**`edge` and not `latest`, until the first release.** The versioned tags come from a `v*` git tag, so
before one is pushed `latest`, `1.4.2` and `1.4` resolve to nothing, and asking for one gets
`manifest unknown`. `edge` and `sha-<commit>` exist from the first merge onwards.

| Tag            | Moves                           | Published by         | Use it for                                                                                                 |
| -------------- | ------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `1.4.2`        | Only if that release is rebuilt | A `v1.4.2` git tag   | Choosing a release for production. Pin its digest, from step 2 of the upgrade, to deploy and to roll back. |
| `1.4`          | On every patch in that minor    | Any `v1.4.x` git tag | Taking patches without reading a changelog. It moves — do not call it a pin.                               |
| `latest`       | On every release                | Any `v*` git tag     | A deployment that follows releases and nothing else.                                                       |
| `edge`         | Every push to `main`            | A merge to `main`    | Running what is not released yet.                                                                          |
| `sha-<commit>` | Only if that commit is rebuilt  | Every publish        | Naming one commit's build, in an incident or a bisect.                                                     |
| `@sha256:…`    | **Never**                       | Every publish        | The only immutable reference. Pin this when it must not move.                                              |

`latest` does **not** follow `main`: a `latest` that moved on every merge would take away the one
thing a tag is for.

**No tag is immutable, `sha-<commit>` included.** Re-running the workflow on the same commit, or
publishing a `v*` tag that points at a commit already on `main`, builds again and republishes every
tag it computes. `org.opencontainers.image.created` moves, so the digest does. A tag names a commit;
only a digest names a build.

The image runs as `node` rather than root, carries no `node_modules` — the build stage bundles
everything into one file — and declares a `HEALTHCHECK` against `/health`. Every published build ships
a provenance attestation and an SBOM:

```bash
gh attestation verify oci://ghcr.io/sakuga-software/fruitback-worker:edge --owner sakuga-software
docker buildx imagetools inspect ghcr.io/sakuga-software/fruitback-worker:edge --format '{{json .SBOM}}'
```

**Nothing is published before it has been booted and scanned, on every architecture.** The release
workflow builds each platform separately, starts it, waits for `/health`, asserts the image still
**refuses** `FRUITBACK_STORE=memory`, and runs Trivy at `CRITICAL,HIGH`. Both must pass before either
is pushed.
