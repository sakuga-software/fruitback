# @fruitback/widget

The Fruitback widget: the button, the element picker, the note popover and the pins, in a Shadow DOM
so that the page and the widget do not change each other's styles.

Most sites install [`fruitback`](https://www.npmjs.com/package/fruitback), which re-exports this
package and the types of what it stores. Install this one directly for its script-tag build.

## Install

```bash
npm i @fruitback/widget
```

The widget sends the notes to a Fruitback instance: [Fruitback Cloud](https://app.fruitback.com), or
your own server ([Running Fruitback yourself](https://fruitback.com/self-hosting.html)). The console of
the instance gives the two values below: its address, and the id of the site (`site_…`).

## Usage

As an import:

```ts
import { init } from '@fruitback/widget';

const widget = init({ endpoint: 'https://api.feedback.acme.dev', clientId: 'site_…' });
```

As a script tag, for a page with no build step. The package exports this build as
`@fruitback/widget/global` (`dist/fruitback.iife.js`). The console gives the tag with the address of
its own copy:

```html
<script
  src="https://cdn.acme.dev/fruitback.iife.js"
  data-fruitback-endpoint="https://api.feedback.acme.dev"
  data-fruitback-client="site_…"
  defer
></script>
```

The tag mounts the widget only when it has both `data-fruitback-endpoint` and
`data-fruitback-client`. Without them, call `Fruitback.init(…)` yourself.

## Guides

- [Installing Fruitback](https://fruitback.com/install.html): the instance, the site, every option of
  `init`.
- [Translating the widget](https://fruitback.com/translating.html): the words you can replace.
- [What the widget collects](https://fruitback.com/privacy.html): every field of a note.

## Licence

MIT. The build includes code from `react-grab`, `zod` and Phosphor Icons, all MIT: their notices are
in `THIRD-PARTY-NOTICES.md`, in this package. The source is in the
[Fruitback repository](https://github.com/sakuga-software/fruitback).
