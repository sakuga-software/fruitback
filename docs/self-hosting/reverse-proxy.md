# Behind a reverse proxy

A reverse proxy gives the worker and the console their HTTPS names, two names of one domain (see
[Before you start](../self-hosting.md#before-you-start)). Set `FRUITBACK_PUBLIC_URL` and `FRUITBACK_CONSOLE_URL` in
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

## What `TRUSTED_PROXY_HOPS` does

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

## Check it

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
  the ones in [Every environment variable](environment-variables.md). `LINEAR_API_KEY` belongs in
  Dokploy's environment, never in the image or the repository.
- **`TRUSTED_PROXY_HOPS=1`** for Dokploy's Traefik alone, then [check it](#check-it). For a proxy in
  front of Dokploy, such as a CDN, first make Dokploy's Traefik trust it
  (`forwardedHeaders.trustedIPs`), then add one. Without the trust, Traefik replaces the header and the
  client's address is lost at every count (measured with nginx in front of Traefik).
- **`FRUITBACK_DATABASE_URL`** is the internal address Dokploy gives the PostgreSQL service. Back it
  up as [Back it up](backup.md#back-it-up) says, with `pg_dump` in that service's container.
- **The console is a second Application**, from `ghcr.io/sakuga-software/fruitback-console:edge`, port
  `80`, with `FRUITBACK_API` set to the HTTPS address of the worker. See [The console](../self-hosting.md#the-console).
- **`/health` is the readiness probe.** It answers `503` while the configuration is refused, so a bad
  deploy gets no traffic. The process drains its requests on `SIGTERM`.
