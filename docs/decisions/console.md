# The console

The console of the Cloud, `apps/console`: its words, its kit, and what it shows of a connector.

## The console

### The rules, in short

- **The console speaks the language of its person** (FRU-120). `apps/console/app/i18n.ts`: the
  English sentence is the key (`t('Create your workspace')`), and `messages.fr.ts` maps it to French.
  A sentence in a table is marked with `msg` and translated where it is shown. `messages.test.ts`
  reads the screens: every sentence has French, the map holds no sentence no screen shows, and no text
  is shown that did not go through `t`. The language is the account's, then this browser's last
  choice, then the browser's own. **Every component that calls `t` calls `useLocale()` first**, and
  the guard fails on one that does not: `t` reads the language at render, so a component with no
  subscription keeps the old words. The root holds no `key` on the language: a screen mounted again
  loses what somebody typed and runs its effects twice. **`HydrateFallback` holds no word**: it is rendered when the console
  is built, and a word in another language is a hydration error in the browser.
- `apps/console` (`@fruitback/console`) — the console of the Cloud (FRU-99): React Router in SPA mode,
  Tailwind on the tokens of `design/`, served as static files by nginx. It holds no secret: the access
  token lives in the page's memory, the refresh token is the worker's `HttpOnly` cookie. **One refresh
  in flight** (`refresh()` in `api.ts`): two calls spending one cookie race, like the extension's.
  The image hashes the inline scripts of `index.html` into its policy (`csp.mjs`), never
  `'unsafe-inline'`, and serves the widget's script at `/fruitback.iife.js` until it has a CDN.
- `design/` — the reference mockups of the Cloud and the simplified extension (a Claude Design
  export, 2026-10-07), with a picture of each board. **Build a screen that has a board to its board**:
  layout, words and tokens. `design/README.md` says which board belongs to which ticket.
- **The console connects an address, and shows the notes that did not arrive** (FRU-132). A source is
  drawn by its `kind`: a tracker has teams to choose, an address has none, so a site sends there or
  does not. **A secret that the worker made is on the screen once**, in the form that made the
  connector, and in no state after it. An address says « Connected », never « Working »: the list
  cannot know that its notes arrive. **No list of deliveries is not an empty list**: a worker that did
  not answer must not read as « every note arrived ».
- **The console draws its controls with HeroUI v3, through its own kit** (FRU-125). `ui.tsx` is the
  one file that imports `@heroui/react`: `Button`, `Field`, `Choice` (a select), `Pick` (radios),
  `Chip` and `Problem`. A screen uses the kit, and `messages.test.ts` fails on a native control in a
  screen. **HeroUI takes the theme**: `app.css` gives its variables the tokens of `design/README.md`,
  and HeroUI names `--color-accent`, `--color-muted` and `--color-surface` from them, so those three
  are no longer in our `@theme`. **A button takes no `title`**: a tooltip does not open on a disabled
  control, so the reason is written beside it. The overlays of React Aria position with inline
  styles, which the console's CSP allows (`style-src 'unsafe-inline'`); its scripts stay hashed.
