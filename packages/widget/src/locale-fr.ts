import type { Catalog } from './messages.ts';

/**
 * French, maintained in this repository (SKG-531).
 *
 * Every key is required, so a key added to `ENGLISH` does not compile until it is translated here.
 * `messages.test.ts` also checks that each message keeps the placeholders of its English one.
 */
export const FRENCH: Catalog = {
  'launch.label': 'Laisser un feedback',
  'launch.capturing': 'Échap pour annuler',

  'settings.open': 'Ouvrir les réglages Fruitback',
  'settings.dialog': 'Réglages Fruitback',
  'settings.title': 'Réglages',
  'settings.close': 'Fermer les réglages',
  'settings.endpoint': 'Worker',
  'settings.client': 'Client',
  'settings.stages': 'Pins affichés',
  'settings.hideResolved': 'Masquer les feedbacks résolus',
  'settings.screenshot': 'Joindre une image de l’élément',

  'composer.placeholder': "Qu'est-ce qui ne va pas ici ?",
  'composer.label': 'Votre commentaire',
  'composer.identify': 'Ajouter mon nom (facultatif)',
  'composer.namePlaceholder': 'Votre nom',
  'composer.nameLabel': 'Votre nom (facultatif)',
  'composer.emailPlaceholder': 'vous@exemple.fr',
  'composer.emailLabel': 'Votre e-mail (facultatif)',
  'composer.cancel': 'Annuler',
  'composer.send': 'Planter',
  'composer.sending': 'on plante…',
  'composer.harvested': 'récolté',
  'composer.failed': 'pas passé — le texte est gardé, réessayez',

  'pin.label': '{stage} · {note}',
  'pin.labelUncertain': '{stage} · {note} (position approximative)',

  'thread.close': 'Fermer',
  'thread.noNote': 'Aucune note.',
  'thread.noReplies': 'Pas encore de réponse.',
  'thread.team': 'Équipe',
  'thread.anonymous': 'Anonyme',
  'thread.orphan': 'Élément introuvable — position approximative.',
  'thread.uncertain':
    'Élément retrouvé par sa position, pas par son identité — la page a peut-être changé sous le pin.',
  'thread.link': '{identifier} →',

  'orphans.count': { one: '{count} note détachée', other: '{count} notes détachées' },
  'orphans.entry': '{stage} · {note}',

  'stage.seeded': 'Semé',
  'stage.green': 'Vert',
  'stage.ripening': 'En maturation',
  'stage.ripe': 'Mûr',
  'stage.composted': 'Composté',
};
