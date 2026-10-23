# @fruitback/element

The [Fruitback](https://fruitback.com) widget as a custom element, `<fruitback-widget>`, for a page
that prefers markup to a call.

## Install

```bash
npm i @fruitback/element
```

The widget sends the notes to a Fruitback instance: [Fruitback Cloud](https://app.fruitback.com), or
your own server ([Running Fruitback yourself](https://fruitback.com/self-hosting.html)). The console of
the instance gives the two values below: its address, and the id of the site (`site_…`).

## Usage

```ts
import '@fruitback/element/auto'; // registers <fruitback-widget>
```

```html
<fruitback-widget endpoint="https://api.feedback.acme.dev" client-id="site_…"></fruitback-widget>
```

The element reads `endpoint`, `client-id`, `label`, `locale` and `include-env`. Other options go
through a property: `element.options = { theme, identityToken }`. Without `endpoint` and `client-id`
it mounts nothing. When it leaves the page, it takes the widget away.

On a page with no build step, load `dist/fruitback-element.iife.js` from this package in place of the
import. `import { defineFruitbackElement } from '@fruitback/element'` registers the element under
another tag name.

## Guides

- [Installing Fruitback](https://fruitback.com/install.html#a-custom-element): the element, and every
  option of the widget.
- [The three modes](https://fruitback.com/modes.html): public, private and team, and who can read the
  pins.

## Licence

MIT. The build includes the widget, and with it code from `react-grab`, `zod` and Phosphor Icons, all
MIT: their notices are in `THIRD-PARTY-NOTICES.md`, in this package. The source is in the
[Fruitback repository](https://github.com/sakuga-software/fruitback).
