/**
 * `fruitback` — one install, both halves.
 *
 * The widget and the seed contract are separate packages because they have separate jobs: one runs
 * in a browser, the other is the storage format both ends must agree on. That split is ours, not the
 * caller's, and asking someone to install two packages to put a feedback button on their site is
 * making them care about our layout.
 *
 * So this is the front door. `npm i fruitback` gets the `init` that mounts the widget and the types
 * that describe what it stores — nothing else, and nothing renamed.
 *
 * It re-exports rather than re-implements. Anything defined here rather than forwarded would be a
 * third place for the contract to drift.
 */

// `init` and what it hands back. The widget's published surface is already narrow — see its
// `public.ts` — so this forwards it whole rather than curating a second opinion of it.
export * from '@fruitback/widget';

/**
 * The seed contract: what a pin is, and how it is written into a Linear issue.
 *
 * A caller mounting the widget never needs this. A caller doing more — reading pins to build their
 * own view, or checking what was stored — needs exactly these types, and would otherwise be told to
 * install a second package whose name they never saw in the docs.
 */
export * from '@fruitback/shared';
