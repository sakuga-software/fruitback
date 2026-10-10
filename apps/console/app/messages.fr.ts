/**
 * The console in French (FRU-120). The key is the English sentence a screen shows: see `i18n.ts`.
 *
 * A name of a product is a key too when a screen shows it through `t`, and it reads the same.
 */
export const FRENCH: Readonly<Record<string, string>> = {
  Fruitback: 'Fruitback',
  Linear: 'Linear',
  GitHub: 'GitHub',
  Google: 'Google',
  'Fruitback Cloud': 'Fruitback Cloud',

  'Fruitback cannot reach its server. Check your connection.':
    'Fruitback ne joint pas son serveur. Vérifiez votre connexion.',
  'Try again': 'Réessayer',
  'Loading…': 'Chargement…',

  'My account': 'Mon compte',
  'How you sign in, and the workspace you are in.': 'Votre façon de vous connecter, et le workspace où vous êtes.',
  Profile: 'Profil',
  Address: 'Adresse',
  'Sign-in': 'Connexion',
  'Email link': 'Lien par e-mail',
  On: 'Activé',
  Soon: 'Bientôt',
  'After the beta': 'Après la bêta',
  Language: 'Langue',
  'The language of the console, and of the e-mails Fruitback sends you.':
    'La langue de la console, et des e-mails que Fruitback vous envoie.',
  'Your account did not take this language yet. It is kept in this browser, and sent again the next time you open the console.':
    'Votre compte n’a pas encore pris cette langue. Elle est gardée dans ce navigateur, et renvoyée la prochaine fois que vous ouvrez la console.',
  'Address of the person to invite': 'Adresse de la personne à inviter',
  'Fruitback cannot send to this address. Use a full https:// address that the internet can reach.':
    'Fruitback ne peut pas envoyer à cette adresse. Utilisez une adresse https:// complète, joignable depuis internet.',
  'A secret is 16 to 256 characters, with no space. Leave it empty and Fruitback makes one.':
    'Un secret fait 16 à 256 caractères, sans espace. Laissez-le vide et Fruitback en crée un.',
  'REST API': 'API REST',
  'The address could not be kept just now. Try again.': 'L’adresse n’a pas pu être gardée pour le moment. Réessayez.',
  'Copy this secret now': 'Copiez ce secret maintenant',
  'Your receiver checks each request with it. Fruitback does not show it again.':
    'Votre récepteur vérifie chaque requête avec lui. Fruitback ne le montre plus ensuite.',
  Copy: 'Copier',
  'I kept it': 'Je l’ai gardé',
  'Address of your receiver': 'Adresse de votre récepteur',
  'Each note is posted there, signed. The notes stay in Fruitback too.':
    'Chaque note y est envoyée, signée. Les notes restent aussi dans Fruitback.',
  'Secret (optional)': 'Secret (facultatif)',
  'Leave it empty and Fruitback makes one, shown once.':
    'Laissez-le vide et Fruitback en crée un, montré une seule fois.',
  'Your receiver answered {status}': 'Votre récepteur a répondu {status}',
  'No answer: {error}': 'Pas de réponse : {error}',
  'Not sent yet': 'Pas encore envoyée',
  'The new attempt was not started. Try again.': 'La nouvelle tentative n’a pas démarré. Réessayez.',
  'Sends to {host}': 'Envoie à {host}',
  'Which sites send their notes there': 'Quels sites y envoient leurs notes',
  'Fruitback only': 'Fruitback seulement',
  'Fruitback, and this address': 'Fruitback, et cette adresse',
  'The request, and how to check its signature': 'La requête, et comment vérifier sa signature',
  'Notes that did not arrive': 'Notes qui ne sont pas arrivées',
  'Every note arrived.': 'Toutes les notes sont arrivées.',
  'Written {when}': 'Écrite {when}',
  '1 attempt': '1 tentative',
  '{count} attempts': '{count} tentatives',
  'Fruitback stopped trying.': 'Fruitback a arrêté d’essayer.',
  'Next attempt {when}': 'Prochaine tentative {when}',
  'Try now': 'Essayer maintenant',
  'Its sites keep their notes in the workspace, and the notes that waited are not sent.':
    'Ses sites gardent leurs notes dans le workspace, et les notes qui attendaient ne sont pas envoyées.',
  'Where you are signed in': 'Où vous êtes connecté',
  'Console · this browser': 'Console · ce navigateur',
  'Active now': 'Actif maintenant',
  'Sign out': 'Se déconnecter',
  'Delete the workspace': 'Supprimer le workspace',
  'Sites, members and pin positions go. Items already in your sources stay there.':
    'Les sites, les membres et la position des pins disparaissent. Les éléments déjà dans vos sources y restent.',
  'Keep it': 'Le garder',
  'Delete workspace': 'Supprimer le workspace',
  'Delete {workspace}': 'Supprimer {workspace}',

  'An issue per note, in one repository.': 'Un ticket par note, dans un dépôt.',
  'Issues in a Jira Cloud project.': 'Des tickets dans un projet Jira Cloud.',
  'A card per note, in the list you choose.': 'Une carte par note, dans la liste que vous choisissez.',
  'A row per note in a database.': 'Une ligne par note dans une base.',
  'POST each note to your own endpoint.': 'Chaque note envoyée en POST à votre propre adresse.',
  'Linear refused this key. Copy it again from Linear, in Settings, then Security and access.':
    'Linear a refusé cette clé. Copiez-la de nouveau depuis Linear, dans Settings, puis Security and access.',
  'This Fruitback cannot keep a key yet. Its operator must set FRUITBACK_SECRETS_KEY.':
    'Ce Fruitback ne peut pas encore garder de clé. Son opérateur doit définir FRUITBACK_SECRETS_KEY.',
  'Linear knows this key, and it may not list your teams. Create a key with read and write access, then try again.':
    'Linear connaît cette clé, mais elle ne peut pas lister vos équipes. Créez une clé avec accès en lecture et en écriture, puis réessayez.',
  'Only an owner or an admin of the workspace connects a source.':
    'Seul un propriétaire ou un administrateur du workspace connecte une source.',
  'Fruitback did not answer. Try again.': 'Fruitback n’a pas répondu. Réessayez.',
  'Linear did not answer just now. Your key is not kept: try again in a minute.':
    'Linear n’a pas répondu. Votre clé n’est pas gardée : réessayez dans une minute.',
  Connectors: 'Connecteurs',
  'Connect a source once. Every site of the workspace can then send its feedback there.':
    'Connectez une source une fois. Chaque site du workspace peut ensuite y envoyer ses retours.',
  Connected: 'Connectées',
  'The notes stay in this workspace': 'Les notes restent dans ce workspace',
  'Key of {person}': 'Clé de {person}',
  'Add a source': 'Ajouter une source',
  'An issue per note, in the team you choose.': 'Un ticket par note, dans l’équipe que vous choisissez.',
  'An owner or an admin connects a source': 'Un propriétaire ou un administrateur connecte une source',
  'The key could not be kept just now. Try again.': 'La clé n’a pas pu être gardée. Réessayez.',
  'Linear API key': 'Clé d’API Linear',
  'A personal API key, from Linear, Settings, Security and access. Fruitback keeps it encrypted.':
    'Une clé d’API personnelle, depuis Linear, Settings, Security and access. Fruitback la garde chiffrée.',
  'Checking…': 'Vérification…',
  Connect: 'Connecter',
  Cancel: 'Annuler',
  Working: 'En service',
  '{count} site': '{count} site',
  '{count} sites': '{count} sites',
  'Linear did not answer with this key. Disconnect it, then connect a new key.':
    'Linear n’a pas répondu avec cette clé. Déconnectez-la, puis connectez une nouvelle clé.',
  'The destination of this site did not change. Try again.': 'La destination de ce site n’a pas changé. Réessayez.',
  'This source is still connected. Try again.': 'Cette source est toujours connectée. Réessayez.',
  'Connected with the key of {person}': 'Connectée avec la clé de {person}',
  'Where each site sends its notes': 'Où chaque site envoie ses notes',
  'This workspace has no site yet.': 'Ce workspace n’a pas encore de site.',
  'Another source': 'Une autre source',
  'Fruitback, in this workspace': 'Fruitback, dans ce workspace',
  '{team}, no project': '{team}, sans projet',
  Disconnect: 'Déconnecter',
  'Its sites keep their notes in the workspace again.': 'Ses sites gardent de nouveau leurs notes dans le workspace.',

  Owner: 'Propriétaire',
  Admin: 'Administrateur',
  Member: 'Membre',
  Guest: 'Invité',
  Members: 'Membres',
  'Who can see and leave feedback, and who can change the workspace.':
    'Qui peut voir et laisser des retours, et qui peut modifier le workspace.',
  'Invitations come after the beta. Until then, each person signs in and makes their own workspace.':
    'Les invitations arrivent après la bêta. D’ici là, chacun se connecte et crée son propre workspace.',
  Invite: 'Inviter',
  Person: 'Personne',
  Role: 'Rôle',
  Sites: 'Sites',
  All: 'Tous',
  'Sites, connectors, members.': 'Sites, connecteurs, membres.',
  'Every site. Sees the tracker links.': 'Tous les sites. Voit les liens du tracker.',
  'Only the sites shared with them. Free, never sees the tracker.':
    'Seulement les sites partagés avec lui. Gratuit, ne voit jamais le tracker.',

  Workspace: 'Workspace',
  'Sign in, name it': 'Se connecter, le nommer',
  Source: 'Source',
  'Where feedback goes': 'Où vont les retours',
  Site: 'Site',
  'The address you review': 'L’adresse que vous relisez',
  Install: 'Installer',
  'Script or extension': 'Script ou extension',
  'Set up': 'Mise en place',
  'How to run Fruitback': 'Comment faire tourner Fruitback',
  'Self-hosted': 'Auto-hébergé',
  Steps: 'Étapes',
  'Step {step} of {total}': 'Étape {step} sur {total}',
  'Create your workspace': 'Créez votre workspace',
  'That is not an e-mail address. Check it and send again.':
    'Ce n’est pas une adresse e-mail. Vérifiez-la et renvoyez.',
  'Several links went to this address already. Use the last one, or wait fifteen minutes.':
    'Plusieurs liens sont déjà partis vers cette adresse. Utilisez le dernier, ou attendez quinze minutes.',
  'GitHub did not sign you in: the access was declined. Try again, or use an email link.':
    'GitHub ne vous a pas connecté : l’accès a été refusé. Réessayez, ou utilisez un lien par e-mail.',
  'GitHub has no verified primary address for this account. Verify it on GitHub, or use an email link.':
    'GitHub n’a pas d’adresse principale vérifiée pour ce compte. Vérifiez-la sur GitHub, ou utilisez un lien par e-mail.',
  'The sign-in with GitHub did not finish. Try again, or use an email link.':
    'La connexion avec GitHub n’a pas abouti. Réessayez, ou utilisez un lien par e-mail.',
  'The link could not be sent just now. Try again in a minute.':
    'Le lien n’a pas pu être envoyé. Réessayez dans une minute.',
  'One workspace for your team, your sites and your sources. Hosted in Europe.':
    'Un workspace pour votre équipe, vos sites et vos sources. Hébergé en Europe.',
  'Sending…': 'Envoi…',
  Continue: 'Continuer',
  'Google sign-in comes after the beta': 'La connexion avec Google arrive après la bêta',
  'Continue with Google': 'Continuer avec Google',
  'Continue with GitHub': 'Continuer avec GitHub',
  'GitHub sign-in arrives with its OAuth app': 'La connexion avec GitHub arrive avec son application OAuth',
  'or with an email link': 'ou avec un lien par e-mail',
  'Work email': 'E-mail professionnel',
  'Workspace name': 'Nom du workspace',
  'Check your inbox': 'Regardez votre boîte de réception',
  'A sign-in link is on its way to {email}. It works once, for fifteen minutes.':
    'Un lien de connexion est en route vers {email}. Il fonctionne une fois, pendant quinze minutes.',
  'Use another address': 'Utiliser une autre adresse',
  'Open it in this browser. Nothing in it asks for a password, and ignoring it is safe.':
    'Ouvrez-le dans ce navigateur. Rien n’y demande un mot de passe, et l’ignorer est sans risque.',
  'A workspace needs a name of one line, up to 80 characters.':
    'Un workspace a besoin d’un nom d’une ligne, de 80 caractères au plus.',
  'Name your workspace': 'Nommez votre workspace',
  'You are signed in. One more word, and the workspace exists.':
    'Vous êtes connecté. Encore un mot, et le workspace existe.',
  'Notes stay in this workspace. Nothing to connect.': 'Les notes restent dans ce workspace. Rien à connecter.',
  'Where should feedback go?': 'Où doivent aller les retours ?',
  Selected: 'Sélectionné',
  'Paste the full address of the site, starting with https://.':
    'Collez l’adresse complète du site, en commençant par https://.',
  'Which site do you review?': 'Quel site relisez-vous ?',
  'Paste its address. Any page of it will do.': 'Collez son adresse. N’importe laquelle de ses pages convient.',
  'Site address': 'Adresse du site',
  'Who sees the feedback?': 'Qui voit les retours ?',
  'The members of {workspace}': 'Les membres de {workspace}',
  'Visitors of the site see no note.': 'Les visiteurs du site ne voient aucune note.',
  'Everyone who visits the site': 'Tous ceux qui visitent le site',
  'For a public « report a problem ».': 'Pour un « signaler un problème » public.',
  'Install it': 'Installez-le',
  'Two ways to put Fruitback on {site}. Use one, or both.':
    'Deux façons de mettre Fruitback sur {site}. Utilisez l’une, ou les deux.',
  Finish: 'Terminer',
  Script: 'Script',
  'Paste it before the closing body tag of the site.': 'Collez-le avant la balise body fermante du site.',
  Copied: 'Copié',
  'Copy the script': 'Copier le script',
  Extension: 'Extension',
  'Nothing to change on the site. Connect this browser, then click the Fruitback icon on the page that opens.':
    'Rien à changer sur le site. Connectez ce navigateur, puis cliquez sur l’icône Fruitback dans la page qui s’ouvre.',
  'Connect this browser': 'Connecter ce navigateur',
  'A page opened in a new tab. If it did not, open': 'Une page s’est ouverte dans un nouvel onglet. Sinon, ouvrez',
  'this link': 'ce lien',
  ': it works once, for fifteen minutes.': ' : il fonctionne une fois, pendant quinze minutes.',

  'You are not signed in yet': 'Vous n’êtes pas encore connecté',
  'Fruitback did not answer. Your link still works.': 'Fruitback n’a pas répondu. Votre lien fonctionne toujours.',
  'This link no longer works': 'Ce lien ne fonctionne plus',
  'A link works once, for fifteen minutes. Ask for another one.':
    'Un lien fonctionne une fois, pendant quinze minutes. Demandez-en un autre.',
  'Send a new link': 'Envoyer un nouveau lien',
  'Signing you in…': 'Connexion en cours…',

  'The addresses you review. Adding a site is pasting its URL.':
    'Les adresses que vous relisez. Ajouter un site, c’est coller son URL.',
  'Who sees the feedback': 'Qui voit les retours',
  Everyone: 'Tout le monde',
  'Add the site': 'Ajouter le site',
  'No site yet. Paste the address of the one you review.':
    'Pas encore de site. Collez l’adresse de celui que vous relisez.',
  Close: 'Fermer',
  Remove: 'Retirer',
  'Cloud workspace · beta': 'Workspace Cloud · bêta',
};
