/**
 * The short name of a workspace (FRU-715): the `acme` of `/w/acme` in the console. It is
 * `organization.slug`, unique on the instance. An owner or an admin changes it in « General »
 * (`POST /console/workspaces/<id>` with `slug`). A workspace keeps its id for life, and every call of
 * the API names the id: the short name is only an address of the console.
 *
 * A name that a workspace leaves stays its own for `FORMER_SLUG_DAYS` days
 * (`workspace_former_slugs`): the console still opens the workspace at the old address, and no other
 * workspace can take it in that time. A workspace keeps at most `MAX_FORMER_SLUGS` of them, so that
 * nobody holds many names by renaming in a loop.
 *
 * This file imports nothing of the database: the console API and the stores read the rule here.
 */

/** How many days a name that a workspace left stays its own. */
export const FORMER_SLUG_DAYS = 30;

export const FORMER_SLUG_MS = FORMER_SLUG_DAYS * 24 * 60 * 60 * 1000;

/** The most names a workspace keeps after it left them. A newer one pushes the oldest out. */
export const MAX_FORMER_SLUGS = 5;

export const MIN_SLUG = 3;
export const MAX_SLUG = 40;

/**
 * `[a-z0-9-]`, 3 to 40 characters, a letter or a digit at each end. No `_`: an id of a workspace
 * always holds one (`ws_…`), so a short name never reads as an id, and the console tells them apart.
 */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

/**
 * The names no workspace takes: the paths of the console and of the worker at the root, and words that
 * would read as Fruitback's own pages. The console serves a workspace under `/w/`, so none of them
 * collides today. The mockup draws `app.fruitback.dev/acme`, and the list keeps that address free.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'about',
  'account',
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'authorize',
  'billing',
  'blog',
  'cloud',
  'config',
  'connect',
  'console',
  'dashboard',
  'docs',
  'fruitback',
  'help',
  'invitations',
  'kit',
  'login',
  'logout',
  'mcp',
  'new',
  'oauth',
  'root',
  'settings',
  'setup',
  'sign-in',
  'sign-out',
  'sign-up',
  'signin',
  'signup',
  'static',
  'status',
  'support',
  'system',
  'verify-email',
  'w',
  'well-known',
  'workspace',
  'workspaces',
  'www',
]);

/** Why a short name is refused, before the store is asked: its form, or a reserved word. */
export type SlugRefusal = 'invalid-slug' | 'reserved-slug';

/** The short name as typed, lower case and trimmed, or why it is refused. */
export function readWorkspaceSlug(value: unknown): { slug: string } | { refused: SlugRefusal } {
  if (typeof value !== 'string') return { refused: 'invalid-slug' };
  const slug = value.trim().toLowerCase();
  if (!SLUG.test(slug)) return { refused: 'invalid-slug' };
  if (RESERVED_SLUGS.has(slug)) return { refused: 'reserved-slug' };

  return { slug };
}

/** The part of a short name made from a name, before a suffix: room is left for `-xxxx`. */
const BASE_LENGTH = MAX_SLUG - 5;

/**
 * The short name read in the name of a workspace, when it is made: `Acme Studio` gives
 * `acme-studio`, `Café Crème` gives `cafe-creme`. The accents go, anything else that is not a letter or
 * a digit becomes one `-`. A name that gives less than 3 characters, or a reserved word, gives
 * `workspace`, which is reserved: the store adds a suffix to it.
 */
export function slugFromName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, BASE_LENGTH)
    .replace(/-+$/, '');

  return base.length < MIN_SLUG ? 'workspace' : base;
}

const SUFFIX_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `-` and `size` random letters or digits: 1.7 million of them for four, for a name already taken. */
export function slugSuffix(size = 4, random: (size: number) => Uint8Array = randomBytes): string {
  return `-${Array.from(random(size), (byte) => SUFFIX_LETTERS[byte % SUFFIX_LETTERS.length]).join('')}`;
}

function randomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

/**
 * A free short name for a new workspace named `name`. `taken` asks the store. The name read from the
 * name first, then with a random suffix of four, five times; the last answer has a suffix of eight,
 * unasked: one chance in 2.8 × 10^12 that it is taken, and the unique constraint refuses it then.
 */
export async function freeSlugFor(name: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  const base = slugFromName(name);
  if (!RESERVED_SLUGS.has(base) && !(await taken(base))) return base;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = `${base}${slugSuffix()}`;
    if (!(await taken(slug))) return slug;
  }

  return `${base.slice(0, MAX_SLUG - 9).replace(/-+$/, '')}${slugSuffix(8)}`;
}
