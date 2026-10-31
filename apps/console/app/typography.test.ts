import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { frenchSpaces as widgetSpaces } from '../../../packages/widget/src/typography.ts';
import { loadLocale, translate } from './i18n.ts';
import { frenchSpaces } from './typography.ts';

const NARROW = ' ';
const SAMPLES = [
  'Qui voit les notes ?',
  'Raison : {reason}',
  'Supprimer « {name} » ; puis réessayez !',
  'Ouvrez https://acme.dev à 14:02, contraste 4,5:1.',
  'Déjà : une espace insécable ordinaire',
];

describe('French typography (FRU-517)', () => {
  // The French map is loaded when French is asked for (FRU-494). Not loaded, it reads English.
  before(() => loadLocale('fr'));

  it('puts a narrow no-break space before : ; ? ! » and after «, where a space was', () => {
    assert.equal(frenchSpaces('Qui voit les notes ?'), `Qui voit les notes${NARROW}?`);
    assert.equal(
      frenchSpaces('« {name} » : ok ; non !'),
      `«${NARROW}{name}${NARROW}»${NARROW}: ok${NARROW}; non${NARROW}!`,
    );
    assert.equal(frenchSpaces('Déjà : oui'), `Déjà${NARROW}: oui`);
  });

  it('adds no space where there was none: an address, an hour, a ratio', () => {
    assert.equal(frenchSpaces('https://acme.dev à 14:02, 4,5:1'), 'https://acme.dev à 14:02, 4,5:1');
  });

  it('answers as the widget does, whose copy it is', () => {
    for (const sample of SAMPLES) assert.equal(frenchSpaces(sample), widgetSpaces(sample), sample);
  });

  it('is applied to the French of the console, and never to English', () => {
    assert.equal(translate('fr', 'Who sees the notes?'), `Qui voit les notes${NARROW}?`);
    assert.equal(translate('fr', 'Reason: {reason}', { reason: 'a: b' }), `Raison${NARROW}: a: b`);
    assert.equal(translate('en', 'Reason: {reason}', { reason: 'x' }), 'Reason: x');
  });
});
