# Translating the widget

The widget bundles English and French. This page is for adding a language to the bundle, so every
site gets it. To translate the widget on one site only, pass `messages` to `init` instead — see
[install.md](install.md#another-language).

## Add a catalog

1. Copy `packages/widget/src/locale-fr.ts` to `locale-<tag>.ts`, for example `locale-de.ts`, and
   rename the constant.
2. Translate every value. Keep each `{placeholder}` the English message has: the widget replaces it,
   and a test fails if one is missing or added.
3. Give each plural message the categories your language uses, as `Intl.PluralRules` names them:
   `zero`, `one`, `two`, `few`, `many`, `other`. `other` is required.
4. Register the catalog in `BUNDLED_CATALOGS` in `packages/widget/src/messages.ts`, under its locale
   tag.
5. Run `pnpm --filter @fruitback/widget test`.

The type is `Catalog`, and it requires every key. When a key is added to `ENGLISH`, every bundled
catalog stops compiling until it is translated. That is on purpose: a bundled language promises that
no key falls back to English.

## Two names that must stay different

`settings.open` names the gear, and `settings.dialog` names the settings panel it opens. A screen
reader cannot tell two controls with one name apart.

## Right-to-left languages

The direction comes from the language's likely script, so an Arabic, Hebrew or Persian catalog turns
the widget right to left with nothing more to do. Point the arrow of `thread.link` the other way:
`{identifier} ←`. The widget's layout follows the direction; the pins do not, because they sit on
elements of the page.

## The size of the bundle

Every bundled catalog ships in the script each site loads, and `package.test.ts` fails past 150 kB
gzipped. If the list of languages grows, catalogs should load on demand; do not raise that limit.
