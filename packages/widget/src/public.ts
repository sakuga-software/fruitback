/**
 * What `@fruitback/widget` promises (SKG-505).
 *
 * Deliberately narrower than `index.ts`. Everything in this package is exported *somewhere* because
 * the playground and the tests reach into the parts, but a published surface is a contract: every
 * name here is one that cannot change without a major version, and `createOverlay` or `resolveAnchor`
 * are not promises worth making to a client site.
 *
 * It stops at `init` and what it hands back — deliberately not the config store. A host that could
 * reach in and write preferences would be a host we could never change them under, and the settings
 * panel already owns that job.
 *
 * The emitted declarations still name types from `@fruitback/shared`, which is why that
 * package is published alongside this one: types pointing at something nobody can install are worse
 * than none. Narrowing this entry was tried first and is not sufficient — `panel.d.ts` reaches
 * `config.d.ts`, which reaches the seed contract.
 *
 * A site that outgrows this can vendor the source — `files` ships it — rather than have us pretend
 * the internals were stable.
 */

export { init, type CapturedScreenshot, type Fruitback, type FruitbackOptions } from './embed.ts';
// Types only. `FruitbackOptions.theme` names them, so a consumer cannot describe the object they
// pass without them — a published option whose type is unreachable is one nobody can type-check.
// `THEME_TOKENS` itself stays internal: it is a runtime value, and exporting it would widen the
// published surface to something nobody asked for. `package.test.ts` caught that on the first try.
export type { FruitbackTheme, ThemeToken } from './theme.ts';
export type { ConfigPanel } from './panel.ts';
// `FruitbackOptions.messages` names these. `ENGLISH` stays internal for the same reason as `THEME_TOKENS`.
export type { FruitbackMessages, MessageKey, PluralMessage } from './messages.ts';
// `FruitbackOptions.transport` names these, so a host cannot write one without them. The default
// `fetchTransport` stays internal: it is the behaviour a host gets by passing nothing, never
// something to import and wrap.
export type { FruitbackTransport, TransportRequest, TransportResponse } from './transport.ts';
