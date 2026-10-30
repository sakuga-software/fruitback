import type { PluralMessage } from './messages.ts';

/**
 * French typography (FRU-517): a narrow no-break space, U+202F, before « : », « ; », « ? », « ! » and
 * « », and after « «. A line never breaks there.
 *
 * Only a space that is already there changes. So « https://… », « 4,5:1 » and « 14:02 » are kept as
 * they are, and a catalogue stays readable with plain spaces: the space is set where it is rendered.
 * The extension sets its own French with this function too; the console has a copy of it, since it
 * does not depend on the widget.
 */
export function frenchSpaces(text: string): string {
  return text.replaceAll(/[  ]([:;?!»])/g, ' $1').replaceAll(/«[  ]/g, '« ');
}

/** Every message of a French catalogue, the forms of a plural too, with `frenchSpaces`. */
export function frenchCatalog<C extends Readonly<Record<string, string | PluralMessage>>>(catalog: C): C {
  return Object.fromEntries(
    Object.entries(catalog).map(([key, message]) => [
      key,
      typeof message === 'string'
        ? frenchSpaces(message)
        : Object.fromEntries(Object.entries(message).map(([form, text]) => [form, frenchSpaces(text as string)])),
    ]),
  ) as C;
}
