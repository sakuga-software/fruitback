/**
 * The addresses typed in « Emails » of the dialog « Invite people » (FRU-691): one field holds several,
 * cut by a comma, a semicolon, a space or a new line. « Send N invites » counts the valid ones.
 */

/** The longest address the worker keeps (`normalizeEmail` of `apps/worker/src/accounts.ts`). */
const LONGEST = 254;

/**
 * The rule of the worker (`normalizeEmail`): no space, one `@`, a dot after it. An address that the
 * worker would refuse is not counted, so the button never offers an invitation that cannot go.
 */
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Addresses = {
  /** The valid addresses, each once, in the order they were typed, in lower case. */
  valid: readonly string[];
  /** What was typed and is no address, each once, as it was typed. */
  invalid: readonly string[];
};

/** The addresses of what was typed in « Emails ». */
export function addressesIn(typed: string): Addresses {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of typed.split(/[\s,;]+/)) {
    if (part === '') continue;
    const address = part.toLowerCase();
    if (ADDRESS.test(address) && address.length <= LONGEST) {
      if (!valid.includes(address)) valid.push(address);
    } else if (!invalid.includes(part)) {
      invalid.push(part);
    }
  }

  return { valid, invalid };
}

/**
 * What stays in « Emails » after a send: the addresses that did not go, and what is no address. What
 * was sent goes; nothing else that was typed is lost.
 */
export function addressesLeft(addresses: Addresses, refused: readonly string[]): string {
  return [...addresses.valid.filter((each) => refused.includes(each)), ...addresses.invalid].join(', ');
}
