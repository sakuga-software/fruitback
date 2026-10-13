/**
 * The name a workspace takes when its first person signs in (FRU-239): nobody is asked for one.
 *
 * It is read in the address of the person. An address of a company gives the name of its domain; an
 * address of a public mailbox gives what is before the `@`. The person renames it whenever they like.
 */

/** Mailboxes anybody opens: their domain names no team. A short list, on purpose. */
const PUBLIC_MAILBOXES = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
]);

/**
 * The labels that stand before a country in a suffix of two parts: `co.uk`, `com.au`, `ac.nz`.
 * With one of these before a country of two letters, the name of the company is one label further.
 */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or']);

/** The rule of the worker for the name of a workspace: one line, 80 characters at the most. */
const LONGEST = 80;
/** For an address that gives nothing to read: the worker refuses an empty name. */
const NO_NAME = 'Workspace';

function capital(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The label of a domain that names its owner: `acme` in `mail.acme.co.uk`. */
function owner(domain: string): string {
  const labels = domain.split('.').filter((label) => label !== '');
  const last = labels.at(-1) ?? '';
  const double = labels.length >= 3 && last.length === 2 && SECOND_LEVEL.has(labels.at(-2) ?? '');

  return labels.at(double ? -3 : -2) ?? labels[0] ?? '';
}

export function workspaceNameFrom(email: string): string {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  // What is after a `+` sorts the mail of a person, and is not a part of their name.
  const local = (at === -1 ? address : address.slice(0, at)).split('+')[0] ?? '';
  const domain = at === -1 ? '' : address.slice(at + 1);
  const read = domain === '' || PUBLIC_MAILBOXES.has(domain) ? local : owner(domain);
  // One line, as the worker reads it: no control character, spaces of any kind as one, none at the ends.
  const name = capital(
    (read === '' ? local : read)
      .replaceAll(/\p{Cc}/gu, '')
      .replaceAll(/\s+/g, ' ')
      .trim(),
  ).slice(0, LONGEST);

  return name === '' ? NO_NAME : name;
}
