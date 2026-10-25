# When something is wrong

**Start with the first lines of the log**, `docker compose logs worker`. Measured, on the path of
[Run Fruitback yourself](../self-hosting.md#from-an-empty-folder-to-a-first-pin):

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

| You see                                                                                    | `/health`                                                  | A read                                                      | Cause                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Compose starts nothing: `required variable FRUITBACK_POSTGRES_PASSWORD is missing a value` | —                                                          | —                                                           | The password is not in `.env` (measured). The same for `ALLOWED_ORIGINS`.                                                 |
| `docker compose up --wait` ends with `container … is unhealthy`                            | `503` `{"ok":false,"error":"misconfigured","missing":[…]}` | `500`                                                       | Each entry of `missing` names a variable and what to do. Fix every one: they are all listed at once (measured).           |
| The entry names `FRUITBACK_DATABASE_URL` and « Upgrading »                                 | `503`                                                      | `500`                                                       | No database: an `.env` of before FRU-225, or a `docker run` with no address. See [Upgrading](upgrade.md).                 |
| An entry names a variable of before, `FRUITBACK_CLIENTS` for example                       | `503`                                                      | `500`                                                       | A variable an instance of before set. Its sentence says what replaces it. See [Upgrading](upgrade.md).                    |
| Nothing is planted, the widget keeps the note                                              | `200`                                                      | `502 store-unavailable`                                     | The database does not answer, or a tracker refuses its key. The log says which (measured with the database stopped).      |
| No link in the log at step 4                                                               | `200`                                                      | —                                                           | `FRUITBACK_FIRST_ADMIN` is empty, or a workspace has an owner already. Use `admin-link`.                                  |
| Pins do not appear, the browser shows a CORS error                                         | `200`                                                      | `403 origin-not-allowed` or `origin-not-allowed-for-client` | The page is on no site of the console, or on another site than the one its script names (measured).                       |
| A read answers `400 client-required` or `400 unknown-client`                               | `200`                                                      | `400`                                                       | The read names no site, or a site this worker does not have. The script of the console names it (measured).               |
| A visitor sees no pin, and a note they send is kept                                        | `200`                                                      | `401 identity-required`                                     | The site is read by « Members of … ». Choose « Everyone who visits » in the console, if every visitor may read the notes. |
| Docker says `healthy`, nothing answers from outside                                        | unreachable                                                | unreachable                                                 | `HOST` is not `0.0.0.0`, or `PORT` is not the published port.                                                             |
| Every caller gets `429` at once                                                            | `200`                                                      | `429 rate-limited`                                          | Callers share one bucket: see [Check it](reverse-proxy.md#check-it).                                                      |

The other answers the worker gives:

| Code         | `error`                                                                      | Means                                                  |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `400`        | `invalid-body`, `invalid-json`, `invalid-note`, `invalid-url`, `missing-url` | The request is wrong.                                  |
| `401`        | `identity-required`, `invalid-identity`                                      | The read needs a session, or the token did not verify. |
| `403`        | `origin-not-allowed`, `origin-not-allowed-for-client`                        | The calling site is not allowed.                       |
| `404`, `405` | `not-found`, `method-not-allowed`                                            | No such route.                                         |
| `413`        | `payload-too-large`                                                          | The body is over the limit.                            |
| `429`        | `rate-limited`                                                               | The address used up its requests for the minute.       |
| `500`        | `misconfigured`                                                              | The configuration is refused; `/health` says why.      |
| `502`        | `store-unavailable`                                                          | The store did not answer. The widget keeps the note.   |
| `503`        | `limiter-unavailable`                                                        | The rate limiter's state did not answer.               |
