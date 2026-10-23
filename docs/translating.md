# Translate the widget

The widget bundles English and French. On one site, `locale` and `messages` choose the language and
the words: [Another language](#another-language). To add a language to the bundle, so every site gets
it, see [Add a catalog](#add-a-catalog).

## Another language

The widget ships English and French. It follows the browser's language, `locale` overrides it, and
`messages` supplies or overrides the words:

```ts
init({
  endpoint: 'https://api.feedback.acme.dev',
  clientId: 'site_…',
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

## Add a catalog

1. Copy `packages/widget/src/locale-fr.ts` to `locale-<tag>.ts`, for example `locale-de.ts`, and
   rename the constant.
2. Translate every value. Keep each `{placeholder}` the English message has: the widget replaces it,
   and a test fails if one is missing or added.
3. Give each plural message the categories your language uses, as `Intl.PluralRules` names them:
   `zero`, `one`, `two`, `few`, `many`, `other`. `other` is required.
4. In `packages/widget/src/messages.ts`, import the constant beside `FRENCH`
   (`import { GERMAN } from './locale-de.ts';`), then register it in `BUNDLED_CATALOGS` under its
   locale tag.
5. Run `pnpm --filter @fruitback/widget test`.

The type is `Catalog`, and it requires every key. When a key is added to `ENGLISH`, every bundled
catalog stops compiling until it is translated. That is on purpose: a bundled language promises that
no key falls back to English.

## Two names that must stay different

`settings.open` names the gear, and `settings.dialog` names the settings panel it opens. A screen
reader cannot tell two controls with one name apart.

## Right-to-left languages

The direction comes from the language's likely script, so an Arabic, Hebrew or Persian catalog turns
the widget right to left with nothing more to do. No message holds an arrow to turn: `thread.link`
is the identifier alone since FRU-256. The widget's layout follows the direction; the pins do not,
because they sit on elements of the page.

## The size of the bundle

Every bundled catalog ships in the script each site loads, and `package.test.ts` fails past 150 kB
gzipped. If the list of languages grows, catalogs should load on demand; do not raise that limit.
