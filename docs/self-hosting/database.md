# Your own database

Keep the worker in a PostgreSQL you already run, in a schema of a database that another
application uses, or behind PgBouncer, and see what one worker can serve.

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

## In a database that another application uses

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

## Behind a connection pooler (FRU-267)

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
PgBouncer 1.26.1 in the mode it is given and a worker behind it, plays the path of
[« The same path with no browser »](../self-hosting.md#the-same-path-with-no-browser) (the first administrator, a workspace, a site, a note, reads), asks the pooler what
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
