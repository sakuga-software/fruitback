/**
 * French typography (FRU-517): a narrow no-break space, U+202F, before « : », « ; », « ? », « ! » and
 * « », and after « «. A line never breaks there.
 *
 * Only a space that is already there changes, so « https://… », « 4,5:1 » and « 14:02 » keep none, and
 * `messages.fr.ts` stays readable with plain spaces. A copy of `frenchSpaces` of the widget
 * (`packages/widget/src/typography.ts`): the console does not depend on the widget, and
 * `typography.test.ts` holds both to the same answers.
 */
export function frenchSpaces(text: string): string {
  return text.replaceAll(/[  ]([:;?!»])/g, ' $1').replaceAll(/«[  ]/g, '« ');
}
