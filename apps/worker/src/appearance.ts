/**
 * The appearance of the console that an account keeps (FRU-716): what the person chose in Settings ›
 * Appearance (FRU-694). The worker keeps it for the person alone, and it changes nothing but the
 * look of their own console. `apps/console/app/appearance.ts` says what each value draws;
 * `apps/console/app/appearance-account.test.ts` holds the two lists of values together.
 *
 * A write is checked whole: each of the eight fields, with a value the console knows, and no other
 * field. A read gives back what was kept, and the console reads each field again (`readAppearance`),
 * so a value that a later console no longer knows is its default, field by field.
 */

const CHOICES = {
  mode: ['light', 'dark', 'system'],
  light: ['slate', 'snow', 'zinc'],
  dark: ['midnight', 'graphite'],
  sidebar: ['page', 'faint', 'theme', 'deep', 'ink'],
  accent: ['red', 'orange', 'teal', 'blue', 'indigo', 'ink'],
  density: ['compact', 'default', 'comfortable'],
  radius: [0, 4, 6, 8],
  fontSize: [12, 13, 14],
} as const;

/** The values each field of an appearance may take, in the order of the console. */
export const APPEARANCE_CHOICES: { readonly [Field in keyof typeof CHOICES]: readonly (string | number)[] } = CHOICES;

/** An appearance as the worker keeps it: one known value for each field. */
export type AppearanceChoice = { -readonly [Field in keyof typeof CHOICES]: (typeof CHOICES)[Field][number] };

/**
 * `value` when it is a whole appearance: an object with the eight fields, each one a known value, and
 * nothing else. `undefined` for anything else, which the route refuses with `400`.
 */
export function readAppearanceChoice(value: unknown): AppearanceChoice | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const given = value as Record<string, unknown>;
  const fields = Object.keys(CHOICES) as (keyof typeof CHOICES)[];
  if (Object.keys(given).length !== fields.length) return undefined;
  const choice: Record<string, string | number> = {};
  for (const field of fields) {
    const each = given[field];
    if (!(CHOICES[field] as readonly unknown[]).includes(each)) return undefined;
    choice[field] = each as string | number;
  }

  return choice as AppearanceChoice;
}

/**
 * What a read of the column answers: the object kept, or `undefined` for none. A row is parsed, never
 * trusted: a value that is no object (an operator's edit, a restore) is no choice.
 */
export function keptAppearanceOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
