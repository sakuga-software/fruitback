# Reviewing a site with the extension

This is the reviewer's side. The site's side and the worker's are in [install.md](install.md); which
mode you want is in [modes.md](modes.md).

Both extension modes start the same way — install it, switch an origin on — and diverge on one
question: **does that site embed the widget itself?** If it does, that is team mode and you will pair
with the worker. If it does not, that is private mode and the extension mounts the widget for you.

## 1. Install it

The extension is **not published to a store yet**. Build it from this repository and load it
unpacked:

```bash
pnpm install
pnpm --filter @fruitback/extension build           # or build:firefox
```

That writes `apps/extension/.output/chrome-mv3/`. In Chromium, open `chrome://extensions`, turn on
**Developer mode**, choose **Load unpacked** and pick that directory. `pnpm --filter
@fruitback/extension dev` does the same with a reload on every change, which is what you want if you
are working on the extension rather than using it.

**It asks for no host permission at install**, and that is deliberate: it can read nothing anywhere
until you switch a site on, and it asks then, for that origin. Chromium will say the extension can
read and change data on the site you name — that is the grant, and it is what lets a content script
run there.

## 2. Switch a site on

Open the page you want to review and click the extension. The popup names the origin it is about,
and asks for three things:

| Field               |                                             |                                                                |
| ------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| **Mode**            | `Private · the extension mounts the widget` | for a site that embeds nothing                                 |
|                     | `Team · the site embeds it, we relay`       | for a site that ships a dormant widget                         |
| **Worker endpoint** | `https://feedback.acme.dev`                 | your worker, not the site                                      |
| **Client id**       | `acme`                                      | **private mode only** — in team mode the site declares its own |

Then **Turn on for this site**. The browser asks for permission on that origin; refuse it and nothing
runs. The row afterwards reads `On · acme` in private mode, and in team mode
`On · team mode · the site's own widget` — where the client id would be, because there the site
declares its own. Either row carries **Turn off here** and **Change**.

A grant reaches the **next** page load, so the popup injects into the tab you have open. Come back to
the page and the widget is there.

**A team-mode endpoint must be `https`, or loopback for the dev loop** — a session is a bearer
credential and it does not cross plain `http`, so the popup refuses the entry rather than storing one
that would be shown as **On** and refuse every call. **Private mode accepts plain `http://`**, and
that is deliberate: the widget it mounts carries no credential, so there is nothing on the wire to
protect, and an `http://` staging site is exactly the thing this mode is for.

## 3. Pair, in team mode

Private mode needs nothing more — the widget is mounted, and it reads as an anonymous visitor would.
Team mode relays every call through your session, so until you pair the site can reach nothing:

> Not paired — this site cannot reach the worker until you do

**The worker has to be holding sessions at all**, which is not the default: it needs
`FRUITBACK_SESSION_PATH` — its own SQLite file, whatever `FRUITBACK_STORE` says — and
`FRUITBACK_IDENTITY_SECRET`, which signs the access token. A worker with neither mints no codes, and
the command below fails. That is the operator's side, in
[self-hosting.md](self-hosting.md#the-worker), which lists the three `/session/` routes that exist
only when it is set.

**A pairing code is minted by an operator, on the container, never over HTTP:**

```bash
docker compose exec worker node server.mjs pair --subject alex@acme.dev --name "Alex"
```

The name in that command is what your notes will be signed with. The worker vouches for it because
an operator typed it; the browser never asserts its own identity, which is the whole reason the code
comes from a person rather than a form.

Paste it into **Pair with this worker**. The popup then reads `Paired as Alex`, with **Log out**
beside it.

On a worker that is not on `https`, there is nothing to paste into: the button is disabled before you
get that far, under

> Pairing needs https (localhost excepted): a session must not cross http.

Otherwise, what a failed attempt answers:

|                                                              |                                                                                                                                                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `That code has been used or has expired. Ask for a new one.` | Codes are single-use, and expire 15 minutes after they are minted.                                                                                                               |
| `The worker did not answer. Try again.`                      | The worker is down or unreachable — the code is still good.                                                                                                                      |
| `Fruitback needs permission to reach that worker.`           | The prompt for the **worker's** origin was refused. It is not the site's.                                                                                                        |
| `That worker is on plain http. A session must not cross it.` | The same rule as the disabled button above, answered by `session.ts` rather than by the popup. You reach it only if something else asks for a pairing — the popup refuses first. |

Pairing asks for a permission on the worker's origin, which is a different grant from the site's. It
is asked for at the click, so nothing is awaited before the prompt — a browser drops the gesture
otherwise and no prompt ever appears.

## 4. Many sites, from the options page

The popup switches the site you are on, and names the rule that covers it. On a site that no rule covers, the
popup says `No rule covers this origin, so Fruitback does nothing here.` **All sites and rules** opens the
options page, which lists every rule and adds new ones.

A rule names the sites it covers:

| Sites                        | covers                                                            |
| ---------------------------- | ----------------------------------------------------------------- |
| `https://acme.dev`           | that origin only                                                  |
| `https://*.staging.acme.dev` | `staging.acme.dev` and every subdomain of it, on the default port |

A host with no scheme is read as `https://`. A wildcard needs a domain with a dot and no IP address, so
`*.localhost` is refused: add each local origin on its own. When two rules cover a site, the rule for the exact origin
wins, then the longest wildcard. So one preview can go to another client, or be switched off, under a
rule for all of them. **A site that no rule covers mounts nothing**: there is no default client.

**Add rule** asks the browser for access to every site the pattern covers, and stores nothing if you
refuse. On a site a wildcard covers, the popup's switch reads `Turn off for every site this rule covers`,
because that is what it does.

**A wildcard is a convenience in your browser, and grants nothing on the worker.** The worker compares
each page's exact origin with the `origins` of its client, so `pr-12.staging.acme.dev` has to be listed
there too, or its notes are refused.

### Share rules with a team

**Export rules** downloads `fruitback-sites.json`, and **Import a rules file** reads one. A rule in the
file replaces the rule with the same pattern, and the other rules stay. An entry that does not parse is
skipped, and the page names it.

The file holds patterns, modes, endpoints and client ids. It holds no session and no access, so an
imported rule reads `No access in this browser` until you press **Grant access**, and a team-mode worker
still needs you to pair. The rules stay in the browser that holds them: they do not sync to your other
browsers yet (SKG-611).

## What log out does, and what it cannot undo

**Log out** revokes the session on the worker first, then clears both tokens here. The refresh token
is dead and the chain with it, so nothing can be renewed. The access token already minted is not
reachable by a revoke — nothing checks a list when one is presented — and it stops working on its
own. That window is the token's **11 minutes**: its 10 minutes of life, plus the 60 seconds of clock
skew the verifier allows past the moment it expires. Raised in review, which counted the lifetime
and found the document counting one minute less than the code.

If the worker cannot be reached, the tokens are cleared here anyway. A screen saying signed out over
a credential this extension still holds would be the worse of the two, and the token on the worker
expires within 30 days regardless.

## What the extension never does

- **It does not put a token in the page.** The access token lives in the extension's trusted
  contexts, and the widget asks the background to make the call. A page can forge messages on the
  bridge and still cannot ask for one.
- **It does not relay to a worker the page did not name.** A page declaring another endpoint is
  refused rather than answered with your credential for a worker nobody on that page chose.
- **It does not reach a site you have not switched on.** Content scripts are registered per origin,
  at runtime, and unregistered when you switch it off.

The full list, and what each refusal is for, is in
[SECURITY.md](../SECURITY.md#what-the-extension-relays-and-what-it-refuses-to).
