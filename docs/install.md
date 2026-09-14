# Installing Fruitback

Two things have to exist: **the worker**, which holds the Linear key, and **the widget**, which goes
on the site you want feedback about. Neither is useful alone — the widget has nowhere to write, and
the worker has nobody writing to it.

Do the worker first. The widget needs its URL.

**Which mode you are installing changes step 3 and nothing else.** Steps 1, 2, 4, 5 and 6 are the
worker's, and every mode needs them. Step 3 is where public mode puts the widget on the page, team
mode ships it dormant, and private mode ships nothing at all — there the extension mounts it, and the
reviewer's side is [reviewing.md](reviewing.md). [modes.md](modes.md) is the page that picks between
the three, and it is worth reading first: **who may read is `read`** — `FRUITBACK_READ` in the
worker's environment at step 2, or per client in the map at step 4 — **and the mode decides who can
satisfy it.** A public-mode site can, by minting the identity tokens of step 5; team mode is the one
where the reviewer supplies the credential and the page never holds it; private mode can do neither.

> **The packages are not on npm yet.** Everything below describes the shape of the install; the
> `npm i` lines will work once the first release is published. Until then, the `<script>` route works
> from a file you host yourself — `pnpm --filter @fruitback/widget build` produces it.

---

## 1. Linear

You need two values and a key.

**The API key** — a personal API key from your Linear settings. It is the only real secret here, and
the entire reason the worker exists: it must never reach a browser.

**The team, and optionally the project.** Both are UUIDs. The quickest way to read them is to ask
Linear:

```bash
curl -s https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ teams { nodes { id key name } } }"}'
```

Swap `teams` for `projects` for the other one. A project is optional: without it, issues are created
in the team's default.

**Labels need no setup.** Fruitback creates `fruitback` — and `fruitback:<clientId>` when a client is
named — on demand, on first use. A label that cannot be created is dropped and the feedback still
goes through: losing a label is a triage annoyance, losing someone's note is a bug.

---

## 2. The worker

It is a single Node process in a container. [`.env.example`](../.env.example) lists every variable
[`docker-compose.yml`](../docker-compose.yml) reads, with the reasoning next to each: the worker's own,
and the two that choose the image and the host port.

The minimum, with the seeds in Linear:

```bash
FRUITBACK_STORE=linear
LINEAR_API_KEY=lin_api_…
LINEAR_TEAM_ID=…
ALLOWED_ORIGINS=https://staging.acme.test
```

With SQLite, which is the default of `docker-compose.yml`, `ALLOWED_ORIGINS` is the only line to set.

### Locally

From the sources, with no container and no `.env`. The command keeps running, so use another
terminal for anything else:

```bash
pnpm --filter @fruitback/worker dev:fake   # node --watch, in-memory store
```

In a container, with the image built from this checkout:

```bash
cp .env.example .env                  # then set ALLOWED_ORIGINS
docker build -f apps/worker/Dockerfile -t ghcr.io/sakuga-software/fruitback-worker:edge .
docker compose up -d --wait           # the image you just built
```

To try the whole loop with no Linear account at all, `pnpm dev` runs the worker against an in-memory
Linear and serves the playground next to it. Nothing is written to anyone's workspace.

### On a server

[docs/self-hosting.md](self-hosting.md) is the guide: the reverse proxy, every variable, backups,
upgrades, and what to check when something is wrong. Whatever you deploy with, two things matter:

- **`/health` checks the configuration, not the store.** It answers `503` and names each variable that
  is missing or wrong. It answers `200` when the SQLite file cannot be opened or Linear refuses the
  key: those show on the first read, as `502 store-unavailable`. So check a read as well.
- **`TRUSTED_PROXY_HOPS` is the number of proxies in front of the container**: `0` when the port is
  published directly, `1` behind one Traefik. Too high behind a proxy that appends to
  `X-Forwarded-For`, and a caller escapes the rate limit with a forged header. Too low, and every
  caller shares one bucket. [Behind a reverse proxy](self-hosting.md#behind-a-reverse-proxy) has the
  measured cases and a check you can run.

Check both before going further:

```bash
curl https://feedback.acme.dev/health
# {"ok":true,"store":"sqlite","openRead":1}
curl 'https://feedback.acme.dev/feedback?url=https%3A%2F%2Fstaging.acme.test%2F'
# {"url":"https://staging.acme.test/","issues":[]}
```

`store` is the store the worker runs on. `openRead` counts the clients whose pins anyone can read, and
is absent when there are none. With `FRUITBACK_CLIENTS` set, add `&client=<id>` to the read; with
`FRUITBACK_READ=authenticated`, the read answers `401`, which is expected.

---

## 3. The widget

### A script tag

For a site with no build step. `endpoint` and `client` are required and are the whole configuration;
`label` is optional.

```html
<script
  src="https://cdn.acme.dev/fruitback.iife.js"
  data-fruitback-endpoint="https://feedback.acme.dev"
  data-fruitback-client="acme"
  data-fruitback-label="Leave feedback"
  defer
></script>
```

`defer` matters: the widget mounts into `<body>`. It auto-mounts only when **both** `endpoint` and
`client` are on the tag; with either missing it does nothing and `Fruitback.init(…)` is yours to call
— which is what a site with its own bootstrap wants.

### An import

```bash
npm i fruitback
```

```ts
import { init } from 'fruitback';

const widget = init({
  endpoint: 'https://feedback.acme.dev',
  clientId: 'acme',
});
```

In React, mount it in an effect — the widget points at elements your app has rendered, so it has to
arrive after they do:

```tsx
useEffect(() => {
  const widget = init({ endpoint: WORKER_URL, clientId: 'acme' });

  return () => widget.destroy();
}, []);
```

`init` is browser-only and says so if called while server-rendering, rather than failing somewhere
inside a bundle.

### What else `init` takes

| Option          | Why you would                                                                       |
| --------------- | ----------------------------------------------------------------------------------- |
| `label`         | the text on the floating button                                                     |
| `locale`        | the language to show, as a tag like `fr` or `pt-BR` — the browser's by default      |
| `messages`      | your own words for that language — see [Another language](#another-language)       |
| `ignore`        | elements the pointer must skip — your own chrome, a support chat, a cookie banner    |
| `identityToken` | a function returning a signed token, so a reporter is *verified* rather than claimed |
| `includeEnv`    | `false` when the reporter has not agreed to send their user agent along              |
| `transport`     | who carries the calls — the extension's, in team mode below                          |

### Another language

The widget ships English and French. It follows the browser's language, `locale` overrides it, and
`messages` supplies or overrides the words:

```ts
init({
  endpoint: 'https://feedback.acme.dev',
  clientId: 'acme',
  messages: {
    de: {
      'launch.label': 'Feedback geben',
      'settings.open': 'Fruitback-Einstellungen öffnen',
      'settings.dialog': 'Fruitback-Einstellungen',
      'orphans.count': { one: '{count} Notiz ohne Element', other: '{count} Notizen ohne Element' },
    },
  },
});
```

- For a `fr-CA` reader, a key comes from your `fr-CA`, the bundled `fr-CA`, your `fr`, the bundled
  `fr`, then English. A key you leave out never shows as its own name.
- The keys and the English they replace are `ENGLISH` in `packages/widget/src/messages.ts`, and
  `MessageKey` is their type.
- A count takes one string per `Intl.PluralRules` category, and `other` is required. `{count}`,
  `{stage}`, `{note}` and `{identifier}` are replaced wherever the English message has them, and the
  count is formatted for the language of the message.
- `settings.open` names the gear and `settings.dialog` the panel it opens. Keep them different: a
  screen reader cannot tell two controls with one name apart.
- In a right-to-left language — Arabic, Hebrew, Persian — the widget reads right to left: the dock
  moves to the left corner and the popover opens on the element's right edge. The pins stay on their
  elements. The direction follows the words, so pass a catalog for the language; without one the
  widget shows English, left to right.
- `label` wins over `launch.label`.
- A script tag cannot carry a catalog, but it detects the browser's language, so a French browser gets
  French. For any other language, call `Fruitback.init` yourself.

To add a language to the bundle, so every site gets it, see [translating.md](translating.md).

### Team mode: dormant until a reviewer arrives

Ship the widget and call `init` only when a reviewer with the extension opens the page. Your users
see nothing; your reviewers see their pins.

```ts
import { init, type FruitbackTransport } from 'fruitback';

// The extension puts this on the page. It is not part of the package, so your project declares it.
declare global {
  interface Window {
    fruitbackExtension?: { version: number; transport: FruitbackTransport };
  }
}

let widget: ReturnType<typeof init> | undefined;

const sync = () => {
  const extension = window.fruitbackExtension;

  // Gone: the reviewer switched this site off, or to private mode. The extension cannot destroy a
  // widget your site owns, so it tells you and you do.
  if (extension === undefined) {
    widget?.destroy();
    widget = undefined;

    return;
  }

  if (widget !== undefined) return;

  widget = init({
    endpoint: 'https://feedback.acme.dev',
    clientId: 'acme',
    // Every call goes through the extension, which attaches the reviewer's session.
    transport: extension.transport,
  });
};

window.addEventListener('fruitback:extension', sync);
sync();
```

Both halves are needed: the event for a page that loaded before the extension announced itself, the
call for one that loaded after. The **same event fires when the extension withdraws**, so `sync`
reads the property rather than assuming an arrival — and it is written so a second announcement
cannot mount a second widget.

The reviewer then turns your origin on in the extension's popup, in **Team** mode, and pairs with
the worker. Until they pair, the extension relays nothing — see
[the threat model](../SECURITY.md#what-the-extension-relays-and-what-it-refuses-to) for why, and for
the five other things the relay checks first.

> This mode is worth turning on only with `FRUITBACK_READ=authenticated`. Otherwise the same pins
> are readable by anyone who can build the URL, and all it buys is a page your users do not see the
> widget on.

---

---

## 4. One worker, several sites

Set `FRUITBACK_CLIENTS` and each site routes to its own team, project and labels:

```json
{
  "acme": { "teamId": "team_…", "projectId": "proj_…", "origins": ["https://acme.test"] },
  "globex": { "teamId": "team_…" }
}
```

Once it is set, a client has to be named on **both** paths — `client=` on a read, `seed.client.id` on
a write — and an unknown one is refused rather than served from the default. On a shared worker,
falling back to the default team is how one client reads another's feedback.

`origins` binds a client to the sites it may be embedded on. It is not authentication: `clientId` is
asserted by the browser. It is the same trust level CORS gives, and strictly more than nothing.

---

## 5. Identified reporters, optionally

By default a reporter is anonymous, and a name typed into the popover is stored as a **claim** —
Linear shows it as *self-declared*. A site that already knows who its visitor is can say so properly:
share a secret with the worker, mint a short-lived JWT, and hand it to the widget.

```ts
init({
  endpoint: WORKER_URL,
  clientId: 'acme',
  // Called before every write, so a token that expired mid-session is refreshed rather than refused.
  identityToken: () => fetch('/api/fruitback-token').then((response) => response.text()),
});
```

The token is an **HS256 JWT** with `sub`, an `exp`, and optionally `name` and `email`, signed with
the client's `identitySecret`. It travels in the `Authorization` header and never inside the seed —
the seed is stored verbatim in an issue description that anyone with workspace access can read.

A token that fails to verify is a `401`, not a silent downgrade to anonymous: a site that meant to
identify someone and got it wrong should hear about it.

---

## 6. What the team sees

A note becomes a Linear issue titled with the reporter's own words, carrying the CSS selector, the
React component and the source file. Replying in the issue puts the reply back inside the pin on the
page — that is the loop closing, and it needs nothing configured.

If your team treats issue comments as internal, turn that off: `FRUITBACK_HIDE_COMMENTS=1`, or
`"showComments": false` on one client. The read path needs no authentication, so anything it returns
is readable by anyone who can load the page.
