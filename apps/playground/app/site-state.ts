import { useSyncExternalStore } from 'react';

/**
 * The fake client site's own state, shared between the page and the dev toolbar.
 *
 * It exists so a "deploy" is a **React** event rather than DOM surgery. The static playground
 * rewrote class names and inserted nodes by hand, which is not what a redeployed React app does to
 * the DOM: it re-renders, it reorders by key, it unmounts and remounts subtrees. That difference is
 * the reason this ticket exists — re-anchoring has to survive the real thing.
 *
 * A module-level store rather than context, because the toolbar is rendered by the root and the page
 * by a route, and threading a provider between them would say more about React than about the site.
 */

export type SiteState = {
  /** Bumped on every deploy. Used as a React key, so subtrees genuinely remount. */
  deployment: number;
  /** Which build emitted the hashed class names. A deploy swaps them, as a bundler would. */
  build: 'first' | 'second';
  /** A card the new release added at the top of the grid, shifting everything below it. */
  inserted: boolean;
  /** Cards the release removed outright. */
  removed: readonly string[];
};

const INITIAL: SiteState = { deployment: 0, build: 'first', inserted: false, removed: [] };

let state: SiteState = INITIAL;
const listeners = new Set<() => void>();

function set(next: SiteState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function useSiteState(): SiteState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    () => state,
    // The server renders the initial state, and so does the first client render — anything else
    // would be a hydration mismatch, which is its own kind of bug to chase.
    () => INITIAL,
  );
}

/** What a release does to a page: new hashed classes, a card inserted, every card remounted. */
export function redeploy(): void {
  set({
    deployment: state.deployment + 1,
    build: state.build === 'first' ? 'second' : 'first',
    inserted: true,
    removed: state.removed,
  });
}

export function removeCard(id: string): void {
  set({ ...state, removed: [...state.removed, id] });
}

export function resetSite(): void {
  set(INITIAL);
}

/** The class a given build emits for the same button — hashed, and different every release. */
export function hashedButtonClass(build: SiteState['build']): string {
  return build === 'first' ? 'button_3f2a1b' : 'button_9d7e4c';
}

export function hashedMenuClass(build: SiteState['build']): string {
  return build === 'first' ? 'css-1x9f7ab' : 'css-77aa31';
}
