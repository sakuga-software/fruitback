/**
 * What `@sakuga/fruitback-widget` promises (SKG-505).
 *
 * Deliberately narrower than `index.ts`. Everything in this package is exported *somewhere* because
 * the playground and the tests reach into the parts, but a published surface is a contract: every
 * name here is one that cannot change without a major version, and `createOverlay` or `resolveAnchor`
 * are not promises worth making to a client site.
 *
 * It stops at `init` and what it hands back — deliberately not the config store. A host that could
 * reach in and write preferences would be a host we could never change them under, and the settings
 * panel already owns that job. It also keeps the published `.d.ts` free of any type from
 * `@sakuga/fruitback-shared`, which is internal and unpublished: a package whose types point at something
 * nobody can install is worse than one with none.
 *
 * A site that outgrows this can vendor the source — `files` ships it — rather than have us pretend
 * the internals were stable.
 */

export { init, type Fruitback, type FruitbackOptions } from './embed.ts';
export type { ConfigPanel } from './panel.ts';
