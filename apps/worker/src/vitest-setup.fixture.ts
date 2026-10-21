/**
 * Runs before each test file under vitest (FRU-346).
 *
 * vitest sets `NODE_ENV=test` and `TEST=true`, and `node --test` set neither. better-auth reads them
 * when it loads: under them it leaves out its check of the origin, and `auth-instance.test.ts`
 * measured that check. So the tests run in the environment that the worker runs in.
 */
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV;
delete process.env.TEST;
