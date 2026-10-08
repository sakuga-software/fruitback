import type { Catalog } from './messages.ts';

/**
 * French, maintained in this repository (FRU-38).
 *
 * Every key is required, so a key added to `ENGLISH` does not compile until it is translated here.
 * `messages.test.ts` also checks that each message keeps the placeholders of its English one.
 */
export const FRENCH: Catalog = {
  'launch.label': 'Laisser un feedback',
  'launch.capturing': 'Échap pour annuler',
  'widget.label': 'Feedback Fruitback',
  'capture.instructions': 'Pointez un élément, ou déplacez-vous avec les flèches puis appuyez sur Entrée.',
  'capture.element': '{tag} : {text}',
  'capture.elementEmpty': '{tag}, sans texte',

  'settings.open': 'Ouvrir les réglages Fruitback',
  'settings.dialog': 'Réglages Fruitback',
  'settings.title': 'Réglages',
  'settings.close': 'Fermer les réglages',
  'settings.stages': 'Pins affichés',
  'settings.hideResolved': 'Masquer les feedbacks résolus',
  'settings.screenshot': 'Joindre une image de l’élément',

  'composer.placeholder': "Qu'est-ce qui ne va pas ici ?",
  'composer.label': 'Votre commentaire',
  'composer.dialog': 'Laisser une note',
  'composer.identify': 'Ajouter mon nom (facultatif)',
  'composer.namePlaceholder': 'Votre nom',
  'composer.nameLabel': 'Votre nom (facultatif)',
  'composer.emailPlaceholder': 'vous@exemple.fr',
  'composer.emailLabel': 'Votre e-mail (facultatif)',
  'composer.cancel': 'Annuler',
  'composer.send': 'Envoyer',
  'composer.sending': 'envoi…',
  'composer.sent': 'envoyé',
  'composer.failed': 'pas passé — le texte est gardé, réessayez',

  'pin.label': '{stage} · {note}',
  'pin.labelUncertain': '{stage} · {note} (position approximative)',

  'thread.close': 'Fermer',
  'thread.dialog': 'Feedback {identifier}',
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

  'stage.seeded': 'Nouveau',
  'stage.green': 'À faire',
  'stage.ripening': 'En cours',
  'stage.ripe': 'Terminé',
  'stage.composted': 'Fermé',
};
