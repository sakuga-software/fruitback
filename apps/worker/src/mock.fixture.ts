import { type MockInstance, vi } from 'vitest';

/**
 * Watches `object[name]`, as `mock.method` of `node:test` did (FRU-346). With `implementation`, the
 * double answers in its place; without, the method still runs. `vi.restoreAllMocks()` or
 * `.mockRestore()` puts it back.
 *
 * `vi.spyOn(…).mockImplementation` wants the exact type of the method. A double of `fetch` or of
 * `console.error` types only the arguments that it reads, so this takes any function.
 */
export function mockMethod<T extends object, K extends keyof T & string>(
  object: T,
  name: K,
  implementation?: (...args: never[]) => unknown,
): MockInstance {
  const spy = vi.spyOn(object, name as never) as MockInstance;

  return implementation === undefined ? spy : spy.mockImplementation(implementation as (...args: unknown[]) => unknown);
}
