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
  'launch.capturingTouch': 'Annuler',
  'widget.label': 'Feedback Fruitback',
  'capture.instructions': 'Pointez un élément, ou déplacez-vous avec les flèches puis appuyez sur Entrée.',
  'capture.instructionsTouch': 'Touchez un élément.',
  'capture.element': '{tag} : {text}',
  'capture.elementEmpty': '{tag}, sans texte',

  'settings.open': 'Ouvrir les réglages Fruitback',
  'settings.dialog': 'Réglages Fruitback',
  'settings.title': 'Réglages',
  'settings.close': 'Fermer les réglages',
  'settings.stages': 'Pins affichés',
  'settings.hideResolved': 'Masquer les feedbacks résolus',
  'settings.screenshot': 'Joindre une image de l’élément',
  'settings.copy': 'Copier les feedbacks en texte',
  'settings.copied': 'Copié',
  'settings.copyManually': 'Copiez le texte d’ici',

  'composer.placeholder': "Qu'est-ce qui ne va pas ici ?",
  'composer.label': 'Votre commentaire',
  'composer.dialog': 'Laisser une note',
  'composer.identify': 'Ajouter mon nom (facultatif)',
  'composer.namePlaceholder': 'Votre nom',
  'composer.nameLabel': 'Votre nom (facultatif)',
  'composer.remember': 'Se souvenir de moi sur ce site',
  'composer.cancel': 'Annuler',
  'composer.send': 'Envoyer',
  'composer.sending': 'envoi…',
  'composer.sent': 'envoyé',
  'composer.keep': 'Garder pour plus tard',
  'composer.kept': 'gardée pour plus tard',
  'composer.failed': 'pas passé — le texte est gardé, réessayez',
  'composer.failedWait': 'Trop de notes en ce moment. Le texte est gardé : renvoyez-le dans une minute.',
  'composer.failedRefused': 'Ce site n’accepte pas votre note d’ici. Le texte est gardé : prévenez l’équipe du site.',
  'composer.failedSignedOut': 'Votre session a expiré. Le texte est gardé : reconnectez-vous, puis renvoyez-le.',
  'composer.failedTooLarge':
    'Cette note est trop lourde. Le texte est gardé : raccourcissez-la, ou désactivez l’image dans les réglages.',
  'composer.destination': 'Envoyer vers : {destination}',
  'composer.destinations': 'Destination de cette note',
  'composer.destinationUnnamed': 'Destination {position}',
  'composer.destinationGone':
    "L'envoi vers {destination} n'est plus possible. Cette note ira vers la destination par défaut.",

  'pin.label': 'Note {number}, {stage} : {note}',
  'pin.labelUncertain': 'Note {number}, {stage}, position approximative : {note}',
  'pin.labelDraft': 'Pas encore envoyée · {note}',

  'thread.close': 'Fermer la note',
  'thread.dialog': 'Note {number}',
  'thread.draft': 'Pas encore envoyée',
  'thread.draftDialog': 'Note pas encore envoyée',
  'thread.noNote': 'Aucune note.',
  'thread.noReplies': 'Pas encore de réponse.',
  'thread.replies': 'Réponses',
  'thread.team': 'Équipe',
  'thread.anonymous': 'Anonyme',
  'thread.orphan': 'Élément introuvable — position approximative.',
  'thread.uncertain':
    'Élément retrouvé par sa position, pas par son identité — la page a peut-être changé sous le pin.',
  'thread.link': '{identifier}',

  'orphans.count': { one: '{count} note détachée', other: '{count} notes détachées' },
  'orphans.entry': '{stage} · {note}',

  'sidebar.open': 'Afficher toutes les notes de cette page',
  'sidebar.dialog': 'Toutes les notes de cette page',
  'sidebar.title': 'Notes',
  'sidebar.close': 'Fermer la liste',
  'sidebar.empty': 'Aucune note sur cette page pour le moment.',
  'sidebar.loading': 'Lecture des notes de cette page…',
  'sidebar.failed': 'Les notes de cette page n’ont pas pu être lues. Elles ne sont pas perdues.',
  'sidebar.retry': 'Réessayer',
  'sidebar.count': { one: '{count} note', other: '{count} notes' },
  'sidebar.approximate': 'Position approximative',
  'sidebar.detached': 'Élément introuvable sur cette page',
  'sidebar.drafts': 'Gardées pour plus tard, pas encore envoyées',
  'sidebar.sendDrafts': { one: 'Envoyer {count} note', other: 'Envoyer les {count} notes' },
  'sidebar.draftsSent': { one: '{count} note envoyée', other: '{count} notes envoyées' },

  'export.title': 'Feedback sur {url}',
  'export.empty': 'Aucun feedback sur cette page.',
  'export.element': 'Élément : {element}',
  'export.component': 'Composant : {component}',
  'export.by': 'Par : {name}',
  'export.written': 'Écrit le : {date}',
  'export.approximate': 'Position : approximative — retrouvé par sa place dans la page, pas par son identité',
  'export.detached': 'Position : élément introuvable sur cette page',
  'export.picture': 'Image : {url}',
  'export.reply': 'Réponse de {author}',

  'stage.seeded': 'Nouveau',
  'stage.green': 'À faire',
  'stage.ripening': 'En cours',
  'stage.ripe': 'Terminé',
  'stage.composted': 'Fermé',
};
