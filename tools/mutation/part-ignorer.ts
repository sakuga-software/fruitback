import { leftOut, PART_IGNORER } from './scope.ts';

/**
 * The ignorer of a part of a file (FRU-340). StrykerJS mutates the part from its first line to the end
 * of the file, and this leaves out each node that starts after `MUTATION_LAST_LINE`, with its
 * descendants: the job of a later part measures them. With no `MUTATION_LAST_LINE`, it leaves out
 * nothing. A package lists it in the `ignorers` of its `stryker.config.json`.
 *
 * It has no import from StrykerJS: `plan` imports `scope.ts` with no install.
 */
export const strykerPlugins = [
  {
    kind: 'Ignore',
    name: PART_IGNORER,
    value: {
      shouldIgnore(path: { node: { loc?: { start: { line: number } } | null } }): string | undefined {
        return leftOut(process.env.MUTATION_LAST_LINE, path.node.loc?.start.line);
      },
    },
  },
];
