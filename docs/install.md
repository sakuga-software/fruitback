# Installing Fruitback

Two things have to exist: **the worker**, which holds the Linear key, and **the widget**, which goes
on the site you want feedback about. Neither is useful alone — the widget has nowhere to write, and
the worker has nobody writing to it.

Do the worker first. The widget needs its URL.

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

It is a single Node process in a container. [`.env.example`](../.env.example) lists every variable it
reads, with the reasoning next to each.

The minimum:

```bash
LINEAR_API_KEY=lin_api_…
LINEAR_TEAM_ID=…
ALLOWED_ORIGINS=https://staging.acme.test
```

### Locally

```bash
cp .env.example .env                  # then fill LINEAR_API_KEY
pnpm --filter @fruitback/worker dev   # node --watch, no container
docker compose up --build worker      # the real image
```

To try the whole loop with no Linear account at all, `pnpm dev` runs the worker against an in-memory
Linear and serves the playground next to it. Nothing is written to anyone's workspace.

### On a server

Deployment is Docker behind Traefik, driven by Dokploy from a GitHub push — see
[docs/self-hosting.md](self-hosting.md) for the application settings. Whatever you use, two
things matter:

- **`/health` is a real readiness probe.** It answers `503` while a required variable is missing and
  names it, so a misconfigured deploy never gets traffic and `curl /health` tells you what to set.
- **`TRUSTED_PROXY_HOPS` is how many proxies sit in front of the container** — `1` for Traefik alone.
  `X-Forwarded-For` is appended to by each proxy, so entries on the left are caller-controlled and
  forgeable. Set it too low and the rate-limit key becomes something the caller picks.

Check it before going further:

```bash
curl https://feedback.acme.dev/health
# {"ok":true}
```

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
| `ignore`        | elements the pointer must skip — your own chrome, a support chat, a cookie banner    |
| `identityToken` | a function returning a signed token, so a reporter is *verified* rather than claimed |
| `includeEnv`    | `false` when the reporter has not agreed to send their user agent along              |
| `transport`     | who carries the calls — the extension's, in team mode below                          |

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

const wake = () => {
  const extension = window.fruitbackExtension;
  if (widget !== undefined || extension === undefined) return;

  widget = init({
    endpoint: 'https://feedback.acme.dev',
    clientId: 'acme',
    // Every call goes through the extension, which attaches the reviewer's session.
    transport: extension.transport,
  });
};

window.addEventListener('fruitback:extension', wake);
wake();
```

Both halves are needed: the event for a page that loaded before the extension announced itself, the
call for one that loaded after. `wake` is written so a second announcement cannot mount a second
widget.

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
