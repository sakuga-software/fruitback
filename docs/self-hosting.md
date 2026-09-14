# Running the worker yourself

The worker is the server half of Fruitback: one Node process in one container. It holds the store — a
SQLite file, or a Linear key — and answers the widget. This page goes from an empty machine to a
planted pin, then covers what keeps it running: the reverse proxy, every variable, what to check when
something is wrong, backups, upgrades and sizing. [install.md](install.md) is the other half: the
widget on your site.

Where this page gives a number or an answer, it was measured on the image (SKG-543), and it says so.

## Before you start

- **Docker Engine, with Compose 2.20 or later.** `docker compose up --wait` needs 2.20. Check with
  `docker compose version`.
- **A 64-bit Linux machine, `amd64` or `arm64`.** The image is published for both, and Docker picks
  the right one. One CPU is more than enough for one team: see [Sizing](#sizing-and-more-than-one-replica).
- **An HTTPS name for the worker** if the widget runs on an HTTPS site, for example
  `feedback.example.com`. A browser blocks a call from an `https://` page to an `http://` worker. The
  certificate comes from the reverse proxy: see [Behind a reverse proxy](#behind-a-reverse-proxy).
- **The origin of the site that embeds the widget**, as the browser sends it: scheme, host and port,
  with no path and no trailing slash. `https://staging.example.com` works. Measured:
  `https://staging.example.com/` is accepted at boot, and every call from the site then answers
  `403 origin-not-allowed`.
- **A store**, chosen below.

**While this repository is private, the files and the image need a GitHub login.** GHCR gives a new
package the visibility of its repository, so an anonymous `docker pull` is refused until an owner
makes the package public (*Packages → `fruitback-worker` → Package settings → Change visibility*).
Until then, log in with a token that has `read:packages`, and download the two files with the GitHub
CLI instead of `curl`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
gh api repos/sakuga-software/fruitback/contents/docker-compose.yml -H 'Accept: application/vnd.github.raw' > docker-compose.yml
gh api repos/sakuga-software/fruitback/contents/.env.example -H 'Accept: application/vnd.github.raw' > .env
```

## Choose a store

| `FRUITBACK_STORE` | Where the notes live | Needs | Choose it when |
| --- | --- | --- | --- |
| `sqlite` | one file on a Docker volume | `FRUITBACK_SQLITE_PATH`, on a volume | You want no third party. The pins on the page are the only interface. |
| `linear` | issues in a Linear team | `LINEAR_API_KEY`, `LINEAR_TEAM_ID` | Your team already triages in Linear. |
| `memory` | the memory of the process | nothing | Never on a server. The image refuses it. |

**The worker defaults to `linear`; `docker-compose.yml` and this page default to `sqlite`.** The
worker keeps `linear` so that a deployment from before SQLite existed still starts on the store it
had. To get the Linear key and ids, see [install.md, step 1](install.md#1-linear). A GitHub Issues
store is planned (SKG-525).

## Running the published image

The shortest path: SQLite, nothing in front, one command. While the package is private, log in to
`ghcr.io` first: see [Before you start](#before-you-start).

```bash
docker run -d --name fruitback -p 8080:8080 \
  -e ALLOWED_ORIGINS=https://staging.example.com \
  -e TRUSTED_PROXY_HOPS=0 \
  -e FRUITBACK_STORE=sqlite \
  -e FRUITBACK_SQLITE_PATH=/data/fruitback.db \
  -v fruitback-data:/data \
  ghcr.io/sakuga-software/fruitback-worker:edge
```

- **`TRUSTED_PROXY_HOPS=0`, because nothing is in front.** Without it the worker uses 1, reads the
  caller's own `X-Forwarded-For`, and a forged address gets a new rate-limit bucket on every request.
- **The file must be on the volume.** Measured with the file at `/tmp/fruitback.db`: a pin planted
  before `docker rm` was gone after the next `docker run`.
- **`edge` follows `main`.** Until the first release it is the only moving tag that exists. See
  [Tags and digests](#tags-and-digests).

Then check it, and plant a pin with no site at all:

```bash
curl http://localhost:8080/health
# {"ok":true,"store":"sqlite","openRead":1}

curl -X POST http://localhost:8080/feedback -H 'Content-Type: application/json' -d '{
  "kind":"fruitback.seed","v":2,"id":"sd_first_pin","createdAt":"2026-09-14T00:00:00.000Z",
  "note":"My first pin","page":{"url":"https://staging.example.com/","path":"/"},
  "viewport":{"width":1280,"height":800},
  "anchor":{"selector":"main > h1","tag":"h1","bounds":{"xPct":0,"yPct":0,"wPct":100,"hPct":8}}}'
# {"issue":{"id":"1","identifier":"FB-1"}}   (201)

curl 'http://localhost:8080/feedback?url=https%3A%2F%2Fstaging.example.com%2F'
# {"url":"https://staging.example.com/","issues":[{…"note":"My first pin"…}]}
```

`store` is the store the worker runs on. `openRead` counts the clients whose pins anyone can read, and
is absent when there are none: see `FRUITBACK_READ`. **A `200` on `/health` does not prove the store
works** — the read does. See [When something is wrong](#when-something-is-wrong).

## Running it with docker compose

`docker-compose.yml` runs the same image with the same defaults, and reads every value from `.env`.
It needs nothing else from this repository. **While the repository is private, the two `curl` lines
answer `404`:** use the two `gh api` lines from [Before you start](#before-you-start) instead.

```bash
curl -fsSLO https://raw.githubusercontent.com/sakuga-software/fruitback/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/sakuga-software/fruitback/main/.env.example -o .env
# set ALLOWED_ORIGINS in .env
docker compose up -d --wait
```

`.env.example` explains each variable beside it. What the file decides:

- **SQLite on a named volume, by default.** `fruitback-data` is mounted at `/data`, which holds the
  seeds and, when they are on, the extension's sessions. To use Linear, set `FRUITBACK_STORE=linear`,
  `LINEAR_API_KEY` and `LINEAR_TEAM_ID` in `.env`.
- **The volume belongs to the Compose project.** Compose names it `<project>_fruitback-data`, so two
  stacks on one host keep separate data, and `docker compose down -v` in one cannot delete the other's.
  It is therefore not the `fruitback-data` volume that the `docker run` command above opens.
- **`FRUITBACK_IMAGE` is a complete image reference**, so it takes a tag or a digest
  (`ghcr.io/sakuga-software/fruitback-worker@sha256:…`). **Compose does not pull a tag that is already
  on the machine**, and `edge` moves on every merge: run `docker compose pull` before
  `docker compose up -d --wait` to update.
- **`TRUSTED_PROXY_HOPS` is 0, because the file publishes the port directly.** The worker's own
  default is 1, for one Traefik. With 1 and no proxy in front, forged reads kept answering `200` past
  the limit; with 0, they answered `429` (measured on this file, SKG-541).
- **A variable exported in your shell wins over `.env`.** Compose reads the shell first, so a
  `LINEAR_API_KEY` left in a shell profile reaches the container even when `.env` leaves it empty.
- **`ALLOWED_ORIGINS` is required by the file itself.** Without it, Compose refuses to start:
  `required variable ALLOWED_ORIGINS is missing a value: set ALLOWED_ORIGINS in .env`.
- **`.env.example` lists exactly the variables the compose file reads.** `apps/worker/src/compose.test.ts`
  compares both files, and this page's variable reference, with the variables the worker reads.

## Behind a reverse proxy

A reverse proxy gives the worker its HTTPS name. When one is in front:

1. **Stop publishing the port to the internet.** A port that stays public lets a caller skip the
   proxy and write its own `X-Forwarded-For`. Which way depends on where the proxy runs:
   - **The proxy runs on the host** (nginx or Caddy installed with the system): set
     `FRUITBACK_PORT=127.0.0.1:8080` in `.env`. The port then answers only on the host's loopback
     (measured), and the compose file stays as downloaded.
   - **The proxy runs in a container** (Traefik, Dokploy): the host's loopback is not the proxy's.
     Remove the `ports` mapping and put the worker on the proxy's network. The compose file's
     commented Traefik block has these steps; keep your edit when you download a newer file.
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
feedback.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

### What `TRUSTED_PROXY_HOPS` does

The rate limit keeps one bucket per client address. The worker reads that address from
`X-Forwarded-For`: the entry `TRUSTED_PROXY_HOPS` places from the right. When the header has fewer
entries than that, the worker uses the address of the connection, which is the nearest proxy — and
every caller then shares that proxy's bucket.

**Proxies do not all write the header the same way**, and that changes what a wrong count costs.
Measured on SKG-543: the worker behind each proxy, a caller sending `X-Forwarded-For: 1.2.3.4`, then
24 reads that each forged a different address, against the default limit of 20.

| In front of the worker, default settings | The worker receives | `1` | `2` | `3` |
| --- | --- | --- | --- | --- |
| Traefik v3.5 | the client's address only | right | shared bucket | shared bucket |
| Caddy 2.10 | the client's address only | right | shared bucket | shared bucket |
| nginx 1.29, `$proxy_add_x_forwarded_for` | `1.2.3.4, <client>` | right | **bypassed: 24 × `200`** | shared bucket |
| nginx 1.29, `$remote_addr` | the client's address only | right | shared bucket | shared bucket |
| nginx, then Traefik | nginx's address only | shared bucket | shared bucket | shared bucket |
| nginx, then Traefik trusting nginx | `1.2.3.4, <client>, <nginx>` | shared bucket | right | **bypassed: 24 × `200`** |

*Right* and *shared bucket* both answered 20 × `200` then 4 × `429`: from one caller they look the
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

From a machine outside your network, send 24 reads with forged addresses. With `FRUITBACK_CLIENTS`
set, add `&client=<id>` to the URL.

```bash
URL='https://feedback.example.com/feedback?url=https%3A%2F%2Fstaging.example.com%2F'
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

## Every environment variable

Grouped as in `.env.example`. *Refused* means the worker starts, logs
`misconfigured, missing: …`, answers `/health` with `503` naming the variable, and every other route
with `500`. Docker then marks the container `unhealthy`, and `docker compose up --wait` fails. An
empty value counts as absent.

### The image and the port

| Variable | Default | What it does | When it is wrong |
| --- | --- | --- | --- |
| `FRUITBACK_IMAGE` | `ghcr.io/sakuga-software/fruitback-worker:edge` | Compose only. The image, as a tag or a digest. | A tag that does not exist fails the pull. A tag already on the machine is not pulled again: run `docker compose pull`. |
| `FRUITBACK_PORT` | `8080` | Compose only. The port on the host, or `127.0.0.1:8080` to keep it off the internet. | An `.env` from before SKG-541 says `PORT`, which the file ignores: the port falls back to 8080. |
| `PORT` | `8080` | The port the process listens on, inside the container. Compose sets it to 8080 and does not read it from `.env`. | A value other than the published port makes the worker unreachable, and Docker still reports it `healthy`, because the healthcheck probes the same port (measured with `9000`). With `docker run`, a value that is not a positive integer: the process listens on 8080 with no message, but the healthcheck probes the raw value, so Docker marks the container `unhealthy` (measured with `abc`). |
| `HOST` | `0.0.0.0` | The interface the process listens on. Compose does not pass it. | `127.0.0.1` makes the worker unreachable from outside the container, and Docker still reports it `healthy` (measured). |
| `NODE_ENV` | `production`, set by the image | What refuses the in-memory store. Compose does not pass it. | Any other value lets `FRUITBACK_STORE=memory` start, and every note dies with the container. |

### Who may call the worker

| Variable | Default | What it does | When it is wrong |
| --- | --- | --- | --- |
| `ALLOWED_ORIGINS` | none: required | The sites that may call the worker, comma-separated, or `*`. The `origins` of each client in `FRUITBACK_CLIENTS` join the list. | Absent: Compose does not start. With `docker run`, the container runs and is refused: `/health` answers `503` naming it, and Docker marks it `unhealthy` (measured). An origin that is not exactly what the browser sends — a trailing slash, `http` for `https`, a missing port — is accepted at boot, and each call from the site answers `403 origin-not-allowed`, which the browser shows as a CORS error. A request with no `Origin`, such as `curl`, is not checked. `*` accepts every site. |
| `TRUSTED_PROXY_HOPS` | `1` in the worker, `0` in `docker-compose.yml` | The number of proxies between the internet and the container. | Not a whole number from 0 up: refused. Too high or too low: see [Behind a reverse proxy](#behind-a-reverse-proxy). |
| `RATE_LIMIT_PER_MINUTE` | `20` | Requests a minute per client address, reads and writes together, per container. `/health` is not counted. | Not a whole number above 0: refused. Too low for a team behind one office address: they share a bucket and get `429 rate-limited`. |

### Where the seeds live

| Variable | Default | What it does | When it is wrong |
| --- | --- | --- | --- |
| `FRUITBACK_STORE` | `linear` in the worker, `sqlite` in `docker-compose.yml` | The store: `sqlite`, `linear` or `memory`. | Unknown: refused, `FRUITBACK_STORE (unknown store "sqlit", expected linear \| sqlite \| memory)`. `memory` in the image: refused. Left out of an `.env` from before SKG-541: Compose starts on an empty SQLite file, and the Linear pins seem gone. |
| `FRUITBACK_SQLITE_PATH` | none; `/data/fruitback.db` in `docker-compose.yml` | The SQLite file. It is created, and its schema migrated, on the first read or write. | Absent with `sqlite`: refused. In a directory that does not exist: `/health` answers `200`, and every read and write answers `502 store-unavailable` naming the file (measured). Outside the volume: it works until the container is recreated, then every pin is gone (measured). |
| `LINEAR_API_KEY` | none | A Linear personal API key. A secret: it never reaches a browser. | Absent with `linear`: refused, with `LINEAR_TEAM_ID`. Wrong: `/health` answers `200`, and every read and write answers `502 store-unavailable`, `Linear responded 401` (measured). |
| `LINEAR_TEAM_ID` | none | The team that receives the issues. A client's `teamId` replaces it. | Absent with `linear`: refused. Wrong: not checked at boot; Linear refuses the call, and the worker answers `502 store-unavailable` with Linear's message. |
| `LINEAR_PROJECT_ID` | none | The project for the issues. Optional. A client's `projectId` replaces it. | Wrong: not checked at boot. |

### Several client sites

| Variable | Default | What it does | When it is wrong |
| --- | --- | --- | --- |
| `FRUITBACK_CLIENTS` | none: one client | JSON: clientId → `{ teamId?, projectId?, origins?, identitySecret?, showComments?, read? }`. | Not JSON, or a bad field: refused, with the reason. Set, every read and write must name a client: none answers `400 client-required`, an unknown one `400 unknown-client`, and a client called from a site outside its `origins` `403 origin-not-allowed-for-client` (all measured). Set with `FRUITBACK_SESSION_PATH`: refused. |

### Identity and reads

| Variable | Default | What it does | When it is wrong |
| --- | --- | --- | --- |
| `FRUITBACK_IDENTITY_SECRET` | none: every reporter is self-declared | The HS256 key a site signs identity tokens with, 32 characters or more. Ignored when `FRUITBACK_CLIENTS` is set: each client brings its own. | Under 32 characters: refused. Changed: every token signed with the old key answers `401`. |
| `FRUITBACK_READ` | `public` | Who may read pins: `public` or `authenticated`. A client's `read` replaces it. | A typo: refused, never defaulted to `public`. `authenticated` for a client with no key to verify its tokens: refused. That key is `FRUITBACK_IDENTITY_SECRET` for a single client, and each client's own `identitySecret` when `FRUITBACK_CLIENTS` is set. `authenticated` and a site that sends no token: reads answer `401 identity-required`, and the widget shows no pins. `public`: the boot log names the clients anyone can read, and `/health` counts them in `openRead`. |
| `FRUITBACK_HIDE_COMMENTS` | empty: the team's replies are shown | `1` keeps the team's replies out of the pins. | Any other value, `true` included, is accepted and hides nothing (measured). |

### The browser extension's sessions

| Variable | Default | What it does | When it is wrong |
| --- | --- | --- | --- |
| `FRUITBACK_SESSION_PATH` | none: the `/session/` routes answer `404` | The SQLite file for the extension's sessions. See [The worker](#the-worker). | Without `FRUITBACK_IDENTITY_SECRET`: refused. With `FRUITBACK_CLIENTS`: refused. Outside the volume: every reviewer must pair again after the container is recreated. |
| `FRUITBACK_FAKE_LINEAR` | none | The old spelling of `FRUITBACK_STORE=memory`. Deprecated. | In the image it is ignored, and the boot log says so. Delete the line. |

## When something is wrong

**Start with the first lines of the log**, `docker compose logs worker` or `docker logs fruitback`:

```text
[fruitback] listening on 0.0.0.0:8080 · store sqlite · origins https://staging.example.com · trusted proxy hops 0
[fruitback] read is public for <single client>: their pins, authors and replies are readable by anyone …
```

The first line names the store, the origins and the hop count the worker actually runs with. A worker
that is refused logs `[fruitback] misconfigured, missing: … — /health will report 503` instead. On
`docker stop` it logs `SIGTERM received, draining`, and exits within 10 seconds.

**`/health` checks the configuration, and nothing else.** It does not open the SQLite file, does not
call Linear, and is not rate-limited. So read a page too:
`curl 'http://localhost:8080/feedback?url=https%3A%2F%2Fstaging.example.com%2F'`. All measured on
SKG-543:

| You see | `/health` | A read | Cause |
| --- | --- | --- | --- |
| Compose does not start: `required variable ALLOWED_ORIGINS is missing a value` | — | — | `ALLOWED_ORIGINS` is not in `.env`. |
| `docker compose up --wait` fails, container `unhealthy` | `503` `{"ok":false,"error":"misconfigured","missing":[…]}` | `500` with the same list | Each entry names a variable. Fix every one: they are all listed at once. |
| Pins do not appear, the console shows a CORS error | `200` | `403 origin-not-allowed` from the site | `ALLOWED_ORIGINS` is not exactly the site's origin. |
| Nothing is planted, the widget keeps the note | `200` | `502 store-unavailable`, with a message | The store: a SQLite directory that does not exist, a Linear key or team that is wrong. |
| Docker says `healthy`, nothing answers from outside | unreachable | unreachable | `HOST` is not `0.0.0.0`, or `PORT` is not the published port. |
| Every pin is gone after an update | `200` | `200`, `"issues":[]` | The SQLite file is outside the volume, or an old `.env` lost `FRUITBACK_STORE=linear`. |
| A read answers `400 client-required` or `400 unknown-client` | `200` | `400` | `FRUITBACK_CLIENTS` is set, and the site names no client or an unknown one. |
| A read answers `401 identity-required` | `200` | `401` | `FRUITBACK_READ=authenticated`, and the caller sent no token. |
| Every caller gets `429` at once | `200` | `429 rate-limited` | Callers share one bucket: see [Check it](#check-it). |

The other answers the worker gives:

| Code | `error` | Means |
| --- | --- | --- |
| `400` | `invalid-body`, `invalid-json`, `invalid-seed`, `invalid-url`, `missing-url` | The request is wrong. |
| `401` | `identity-required`, `invalid-identity` | The read needs a token, or the token did not verify. |
| `403` | `origin-not-allowed`, `origin-not-allowed-for-client` | The calling site is not allowed. |
| `404`, `405` | `not-found`, `method-not-allowed` | No such route. |
| `413` | `payload-too-large` | The body is over the limit. |
| `429` | `rate-limited` | The address used up its requests for the minute. |
| `500` | `misconfigured` | The configuration is refused; `/health` says why. |
| `502` | `store-unavailable` | The store did not answer. The widget keeps the note. |
| `503` | `limiter-unavailable` | The rate limiter's state did not answer. |

## Storing the seeds in SQLite

One file, `node:sqlite`, no dependency and no native module to compile. The schema is created on the
first read or write and migrated in place, so there is no separate command to run — a self-hoster
starts one container, not two. The database uses a write-ahead log: recent writes are in
`fruitback.db-wal` beside the file.

What you give up: **SQLite needs a persistent filesystem**, so it cannot run on a serverless runtime.
And with no issue tracker behind it there is no dashboard and no triage UI — the pins on the page are
the interface, and a note's thread lives in the `comments` table. A store with no web interface
reports no link, and the widget renders none.

### Back it up

Through the running container, never with `cp` on the volume: a copy of the `.db` alone misses what is
still in the `-wal` file. With `docker run`, write `docker exec fruitback` and `docker cp fruitback:`
instead of `docker compose exec worker` and `docker compose cp worker:`. The commands below use the
default `FRUITBACK_SQLITE_PATH`, `/data/fruitback.db`; if you set another path, write that path
instead, here and in the restore.

```bash
docker compose exec -T worker sqlite3 /data/fruitback.db ".backup '/data/backup.db'"
docker compose cp worker:/data/backup.db "./fruitback-$(date +%F).db"
docker compose exec -T worker rm /data/backup.db
```

With `FRUITBACK_SESSION_PATH` set, do the same for the sessions file, `/data/sessions.db` for example.

### Restore it

```bash
docker compose cp ./fruitback-2026-09-14.db worker:/data/restore.db
docker compose exec -T worker sqlite3 /data/fruitback.db ".restore '/data/restore.db'"
docker compose exec -T worker rm /data/restore.db
docker compose up -d --wait --force-recreate
```

The recreate empties the read cache, which otherwise serves the old pins of a page for up to 15
seconds. `exec` runs as the `node` user, which owns `/data`, so nothing needs a change of owner.

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

3. Pull and restart, then check `/health` and a read:

   ```bash
   docker compose pull
   docker compose up -d --wait
   ```

The schema migrates by itself on the first read or write, in one transaction.

**Roll back:** set `FRUITBACK_IMAGE` in `.env` to the digest from step 2, then
`docker compose up -d --wait`.

**An older image does not refuse a database that a newer one migrated.** It runs its own code against
the newer schema. The schema has one version today, so every image with the SQLite store reads every
database. When a
release adds a version, its notes say so, and a rollback past it means restoring the backup from
step 1 — and losing the pins planted since.

### Upgrading a deployment from before SKG-541

The old compose file built the image, kept no volume, read `PORT` for the host port, defaulted
`TRUSTED_PROXY_HOPS` to 1, and passed no `FRUITBACK_STORE`, so the worker ran on Linear. An `.env`
written for it keeps those values, and the new file reads it differently.

**If the old deployment kept SQLite seeds or extension sessions under `/data`, copy them out first.**
The old file mounted no volume, so `/data` was an anonymous volume that the image declares. The new
file mounts the named volume there, which starts empty, and the pins and sessions then seem to be
gone. The old volume is not deleted, but nothing mounts it.

Set `dbs` to the files the old deployment used: the value of `FRUITBACK_SQLITE_PATH`, and the value of
`FRUITBACK_SESSION_PATH` if it was set. A file outside `/data` was never on a volume, and nothing is
left to copy. With the **old** file still in place:

```bash
dbs="/data/fruitback.db /data/sessions.db"
for db in $dbs; do
  docker compose exec -T worker sqlite3 "$db" ".backup '$db.migrate'"
  docker compose cp "worker:$db.migrate" "./$(basename "$db").migrate"
done
```

Then replace the compose file, make the changes below with the **same** paths in `.env`, start it, and
restore into the new volume:

```bash
docker compose up -d --wait
for db in $dbs; do
  docker compose cp "./$(basename "$db").migrate" "worker:$db.migrate"
  docker compose exec -T worker sqlite3 "$db" ".restore '$db.migrate'"
  docker compose exec -T worker rm "$db.migrate"
done
docker compose up -d --wait --force-recreate
```

Tested on a stand-in for the old file, with sessions on: after the switch the pin was gone; after the
restore and the recreate, the pin was back and the pairing code was still in `sessions.db`.

Before the first `docker compose up` with the new file, change these lines in `.env`:

1. **If the notes are in Linear, add `FRUITBACK_STORE=linear`.** Otherwise the worker starts on an
   empty SQLite file, and every pin seems to be gone.
2. **Rename `PORT` to `FRUITBACK_PORT`.** The new file ignores `PORT`, so a custom host port falls
   back to 8080.
3. **Set `TRUSTED_PROXY_HOPS` to the number of proxies in front.** The old template wrote 1. Keep 1
   behind one Traefik; change it to 0 if the port is published directly, or a forged
   `X-Forwarded-For` escapes the rate limit.
4. **Add `FRUITBACK_IMAGE`** only to pin a version or a digest. Without it, the file pulls `edge`.

## Sizing, and more than one replica

**One container, and a small one.** Measured on SKG-543, on an Apple Silicon machine under OrbStack,
the container limited to one CPU (`--cpus=1`), on SQLite, with `RATE_LIMIT_PER_MINUTE` raised to
100 000 000 so that the load tool was not refused:

| Load | Throughput | Latency (median, 99th) | Memory after |
| --- | --- | --- | --- |
| At rest | — | — | 24 MiB |
| 20 000 reads of a page with 20 pins, 50 at a time | 4 417 a second | 7 ms, 52 ms | 99 MiB |
| 2 000 writes, 10 at a time | 738 a second | 13 ms, 24 ms | — |
| 5 000 reads of a page with 2 020 pins, a 1 MB answer, 50 at a time | 302 a second | 159 ms, 217 ms | 162 MiB |

The database held 2 020 pins in 4.8 MB. Read these numbers with three limits in mind:

- **Reads come from the cache.** A page's answer is kept for 15 seconds, so the read rows measure the
  cache and the JSON, not the store. A cold page costs one store call per container every 15 seconds.
- **The rate limit, not the CPU, is the ceiling.** With the default of 20, one address gets 20
  requests a minute. A team never reaches the throughput above.
- **Another machine gives other numbers.** A small VPS core is slower than this one. The shape holds:
  memory stays under 200 MiB, and a page with thousands of pins is the expensive case.

**Run one container.** The rate limiter and the read cache keep their state inside each container.
Two are two rate limits: `RATE_LIMIT_PER_MINUTE=20` lets 40 a minute through — and up to 78 in a
burst at a window edge, twice the bound `SECURITY.md` gives for one — with nothing said anywhere, and
a cold page costs one store call per replica. SQLite adds its own reason: one file on one volume
belongs to one container. A state the replicas share is not built: it is SKG-606, written up with what
a first implementation learned.

## Deploying with Dokploy

Dokploy is one way among others: it runs the container behind its own Traefik, which gives the worker
its HTTPS name. Create an **Application** with either source:

| Setting | From the image | From the repository |
| --- | --- | --- |
| Provider | Docker, `ghcr.io/sakuga-software/fruitback-worker:edge` or a digest | GitHub, this repository |
| Build type | — | Dockerfile, path `apps/worker/Dockerfile`, build context `.` |
| Port | `8080` | `8080` |

Then:

- **Set the environment in Dokploy.** It does not read `docker-compose.yml` or `.env`. The names are
  the ones in [Every environment variable](#every-environment-variable). `LINEAR_API_KEY` belongs in
  Dokploy's environment, never in the image or the repository.
- **`TRUSTED_PROXY_HOPS=1`** for Dokploy's Traefik alone, then [check it](#check-it). Add one for each
  proxy in front of Dokploy, such as a CDN.
- **Mount a volume at `/data`** for SQLite, or every pin goes with the next deploy.
- **`/health` is the readiness probe.** It answers `503` while the configuration is refused, so a bad
  deploy gets no traffic. The process drains its requests on `SIGTERM`.

## The worker

A plain Node HTTP process — `node:http` adapted onto a web-standard handler, no framework.

| Route | Status |
| --- | --- |
| `POST /feedback` | plants a seed in the configured store, answers `201` with the issue: `id`, `identifier`, and `url` when the store has a page to open |
| `GET /feedback?url=…[&client=…]` | the seeds of that page: anchor, note, state, stage |
| `OPTIONS /feedback` | CORS preflight, never reaches the store |
| `GET /health` | `200` when the configuration is valid, `503` naming what is wrong when it is not |

The three below exist only when `FRUITBACK_SESSION_PATH` is set, and answer `404` otherwise — a
worker without the extension does not advertise that they are there. They are the browser
extension's session (SKG-535), and they are **exempt from `ALLOWED_ORIGINS`**: an extension's origin
carries an id that differs between an unpacked build and a store build, so an operator cannot put it
on a list. The rate limiter is what protects them, which is why it runs above the path dispatch.

| Route | Status |
| --- | --- |
| `POST /session/pair` | spends a pairing code, opens a session |
| `POST /session/refresh` | a refresh token for a fresh access token |
| `POST /session/revoke` | ends the session; `204` whether or not there was one to end |

A pairing code is minted by a **command on the container**, never over HTTP:

```bash
docker compose exec worker node server.mjs pair --subject alice --name "Alice Martin"
```

Vouching for a person is not something this worker has to defend as a network surface.

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
pnpm --filter @fruitback/worker dev:fake        # node --watch on the TypeScript, in-memory store
```

The image, under the name the compose file pulls:

```bash
docker build -f apps/worker/Dockerfile -t ghcr.io/sakuga-software/fruitback-worker:edge .
docker compose up -d --wait
```

## Tags and digests

Every push to `main` publishes `ghcr.io/sakuga-software/fruitback-worker`, for `linux/amd64` and
`linux/arm64`. Docker picks the architecture from the manifest list; there is no per-architecture tag.

**`edge` and not `latest`, until the first release.** The versioned tags come from a `v*` git tag, so
before one is pushed `latest`, `1.4.2` and `1.4` resolve to nothing, and asking for one gets
`manifest unknown`. `edge` and `sha-<commit>` exist from the first merge onwards.

| Tag | Moves | Published by | Use it for |
| --- | --- | --- | --- |
| `1.4.2` | Only if that release is rebuilt | A `v1.4.2` git tag | Production. This is the one to pin and to roll back to. |
| `1.4` | On every patch in that minor | Any `v1.4.x` git tag | Taking patches without reading a changelog. It moves — do not call it a pin. |
| `latest` | On every release | Any `v*` git tag | A deployment that follows releases and nothing else. |
| `edge` | Every push to `main` | A merge to `main` | Running what is not released yet. |
| `sha-<commit>` | Only if that commit is rebuilt | Every publish | Naming one commit's build, in an incident or a bisect. |
| `@sha256:…` | **Never** | Every publish | The only immutable reference. Pin this when it must not move. |

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
