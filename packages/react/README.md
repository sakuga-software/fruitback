# @fruitback/react

The [Fruitback](https://fruitback.com) widget as a React component. It renders nothing: it mounts
the widget in an effect, and takes it away when the component unmounts.

## Install

```bash
npm i @fruitback/react
```

It needs React 18 or later. The widget sends the notes to a Fruitback instance:
[Fruitback Cloud](https://app.fruitback.com), or your own server
([Running Fruitback yourself](https://fruitback.com/self-hosting.html)). The console of the instance
gives the two values below: its address, and the id of the site (`site_…`).

## Usage

```tsx
import { Fruitback } from '@fruitback/react';

export function App() {
  return (
    <>
      <Routes />
      <Fruitback endpoint="https://api.feedback.acme.dev" clientId="site_…" />
    </>
  );
}
```

The props are the options of `init`. A render of the parent does not mount the widget again.
`onMount` gives you the widget, for example to call `refresh()` or `leaveFeedback()`.

## Guides

- [Installing Fruitback](https://fruitback.com/install.html#a-react-component): the component, and
  every option it takes.
- [The three modes](https://fruitback.com/modes.html): public, private and team, and who can read the
  pins.

## Licence

MIT. The source is in the [Fruitback repository](https://github.com/sakuga-software/fruitback).
