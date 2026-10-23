import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';

/**
 * The validator of addons.mozilla.org on the Firefox build (FRU-389).
 *
 * AMO said two warnings on 0.2.0 and 0.3.0 that are no defect: « The Function constructor is eval »
 * (the probe of zod, `src/no-eval.ts`) and « Unsafe assignment to innerHTML » (the composer, built
 * with `createElement` since). A reviewer may refuse a version for either, and the notes that
 * explained them were pasted by hand on each version. `pnpm e2e` builds the Firefox output first,
 * and this spec fails when either code comes back. No browser: `addons-linter` reads the files.
 */

const FIREFOX = 'apps/extension/.output/firefox-mv3';
/** The two codes of the ticket. Another warning of the validator is not this spec's to judge. */
const GONE = ['DANGEROUS_EVAL', 'UNSAFE_VAR_ASSIGNMENT'];

type Message = { code: string; file?: string; message: string };

test('the validator of AMO finds no eval and no innerHTML in the Firefox build', async () => {
  test.setTimeout(120_000);
  expect(fs.existsSync(`${FIREFOX}/manifest.json`), `${FIREFOX} is not built: run pnpm e2e`).toBe(true);
  const { createInstance } = createRequire(`${process.cwd()}/package.json`)('addons-linter') as {
    createInstance(options: { config: Record<string, unknown>; runAsBinary: boolean }): {
      run(): Promise<{ errors: Message[]; warnings: Message[] }>;
    };
  };
  const linter = createInstance({
    config: { _: [FIREFOX], logLevel: 'fatal', stack: false, pretty: false, output: 'none', boring: true },
    runAsBinary: false,
  });
  const { errors, warnings } = await linter.run();

  // The control of the absence below: the validator read the build and judged it.
  expect(errors).toEqual([]);
  expect(warnings.filter((warning) => GONE.includes(warning.code)).map((w) => `${w.code} ${w.file}`)).toEqual([]);
});
