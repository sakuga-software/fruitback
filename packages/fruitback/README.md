# fruitback

Visual feedback on a live site, delivered to your tracker. A visitor clicks an element of the page and
writes a note. The note becomes an issue that carries the page, the screen size, the CSS selector and,
in a React app, the component and its source file. On the next visit, the pin is still on the
element, in the colour of the issue's stage.

This is the package to install. It brings the widget (`@fruitback/widget`) and the types of what it
stores (`@fruitback/shared`) in one import.

## Install

```bash
npm i fruitback
```

The widget sends the notes to a Fruitback instance: [Fruitback Cloud](https://app.fruitback.com), or
your own server ([Running Fruitback yourself](https://fruitback.com/self-hosting.html)). The console of
the instance gives the two values below: its address, and the id of the site (`site_…`).

## Usage

Call `init` in the browser, after the page has rendered the elements a note can point at:

```ts
import { init } from 'fruitback';

const widget = init({
  endpoint: 'https://api.feedback.acme.dev',
  clientId: 'site_…',
});

// Later, to take the widget off the page:
widget.destroy();
```

In React, call it in an effect, or use [`@fruitback/react`](https://www.npmjs.com/package/@fruitback/react).
`init` works only in a browser: during server rendering it throws an error that says so.

## Guides

- [Installing Fruitback](https://fruitback.com/install.html): the instance, the site, every option of
  `init`.
- [The three modes](https://fruitback.com/modes.html): public, private and team, and who can read the
  pins.
- [What the widget collects](https://fruitback.com/privacy.html): every field of a note.

## Licence

MIT. The source is in the [Fruitback repository](https://github.com/sakuga-software/fruitback).
