/**
 * The French words of the popup and of the options page (FRU-131). The key is the English sentence.
 *
 * `messages.test.ts` fails on a sentence a screen shows that is not here, on an entry no screen
 * shows, and on a translation that lost a placeholder.
 */
export const FRENCH: Readonly<Record<string, string>> = {
  // The popup.
  // The shell and the sign-in (FRU-251).
  // Screens 1 and 4 of the mock-up of 2026-10-20 (FRU-297).
  'Comment on any website, right on the page': 'Commentez n’importe quel site, directement sur la page',
  'Sign in once. Fruitback then works on every site your team reviews.':
    'Connectez-vous une fois. Fruitback fonctionne ensuite sur chaque site que votre équipe relit.',
  'Sign in with email': 'Se connecter par e-mail',
  'Invited by a client or a team?': 'Invité par un client ou une équipe ?',
  'Use the email the invitation was sent to.': 'Utilisez l’adresse à laquelle l’invitation a été envoyée.',
  'Use your own Fruitback server': 'Utiliser votre propre serveur Fruitback',
  Paused: 'En pause',
  "Fruitback can't open this page": 'Fruitback ne peut pas ouvrir cette page',
  'Access to {host} was removed in your browser settings. Your notes are safe.':
    'L’accès à {host} a été retiré dans les réglages de votre navigateur. Vos notes sont en sécurité.',
  'Allow access again': 'Autoriser à nouveau',
  'Turn off for this site': 'Désactiver pour ce site',
  "Fruitback can't reach {worker}": 'Fruitback ne joint pas {worker}',
  // The page of the extension (FRU-301).
  Preferences: 'Préférences',
  'No rules yet. Add one, or turn a site on from the toolbar.':
    'Aucune règle pour l’instant. Ajoutez-en une, ou activez un site depuis la barre d’outils.',
  'No rule matches this filter.': 'Aucune règle ne correspond à ce filtre.',
  Console: 'Console',
  'Reviewer guide': 'Guide de relecture',
  'Which mode?': 'Quel mode ?',
  'A rule says which worker, and which client, a site belongs to. A site no rule covers mounts nothing.':
    'Une règle dit à quel worker, et à quel client, appartient un site. Un site qu’aucune règle ne couvre ne monte rien.',
  'Filter sites': 'Filtrer les sites',
  'Add a site': 'Ajouter un site',
  'Every site this pattern covers': 'Chaque site que couvre ce motif',
  'This origin': 'Cette origine',
  Team: 'Équipe',
  Private: 'Privé',
  Granted: 'Accordé',
  'No access': 'Pas d’accès',
  Site: 'Site',
  Worker: 'Worker',
  Access: 'Accès',
  'Fruitback on {pattern}': 'Fruitback sur {pattern}',
  'Site details': 'Détails du site',
  Rule: 'Règle',
  'Remove rule': 'Retirer la règle',
  'The site ships nothing; the extension mounts the widget for you only.':
    'Le site n’embarque rien ; l’extension monte le widget pour vous seul.',
  'The site embeds a dormant widget; the extension wakes it and carries your session.':
    'Le site embarque un widget endormi ; l’extension le réveille et porte votre session.',
  'Access does not travel with a rule, and it can be removed in the settings of the browser. Nothing is mounted until you grant it.':
    'L’accès ne voyage pas avec une règle, et il peut être retiré dans les réglages du navigateur. Rien n’est monté tant que vous ne l’accordez pas.',
  'Turning the rule on asks the browser for its sites.': 'Activer la règle demande ses sites au navigateur.',
  'Paired as {name}': 'Appairé en tant que {name}',
  'Your session with {worker} is attached in the background, never in the page.':
    'Votre session avec {worker} est jointe en arrière-plan, jamais dans la page.',
  'Not paired': 'Pas appairé',
  'A team site stays asleep until this browser holds a session of its worker.':
    'Un site d’équipe reste endormi tant que ce navigateur n’a pas de session de son worker.',
  'Notes on this site are readable by anyone who can build the URL.':
    'Les notes de ce site sont lisibles par quiconque sait construire l’adresse.',
  // The kit (FRU-293).
  'Account and settings': 'Compte et réglages',
  'Open the console': 'Ouvrir la console',
  'Check that the tab shows the same word': 'Vérifiez que l’onglet affiche le même mot',
  'Waiting for you to connect in the tab…': 'En attente de votre connexion dans l’onglet…',
  'Start again': 'Recommencer',
  'The sign-in did not finish.': 'La connexion n’a pas abouti.',
  'It was refused in the console.': 'Elle a été refusée dans la console.',
  'The tab was not approved in time.': 'L’onglet n’a pas été approuvé à temps.',
  'Fruitback did not answer.': 'Fruitback n’a pas répondu.',
  'Check the connection, then try again.': 'Vérifiez la connexion, puis réessayez.',
  'The sign-in did not start.': 'La connexion n’a pas commencé.',
  'Fruitback named a console that is not its own.': 'Fruitback a indiqué une console qui n’est pas la sienne.',
  'Loading…': 'Chargement…',
  // A site of a workspace (FRU-254). The words of the stages are the widget's.
  New: 'Nouveau',
  'To do': 'À faire',
  'In progress': 'En cours',
  Done: 'Terminé',
  Closed: 'Fermé',
  'In {workspace} · members see the notes': 'Dans {workspace} · les membres voient les notes',
  'In {workspace} · everyone sees the notes': 'Dans {workspace} · tout le monde voit les notes',
  '1 note waits on this site': '1 note attend sur ce site',
  '{count} notes wait on this site': '{count} notes attendent sur ce site',
  'Turn on here': 'Activer ici',
  '{browser} asks for access to this site only.': '{browser} demande l’accès à ce site seulement.',
  'On · {workspace}': 'Activé · {workspace}',
  'Off · {workspace}': 'Désactivé · {workspace}',
  'Fruitback on {host}': 'Fruitback sur {host}',
  'On this page': 'Sur cette page',
  '1 note': '1 note',
  '{count} notes': '{count} notes',
  'Leave feedback': 'Laisser une note',
  'Show every note of the page': 'Voir toutes les notes de la page',
  'Your browser': 'Votre navigateur',
  'A note is being written on the page. Send it or close it first.':
    'Une note est en cours d’écriture sur la page. Envoyez-la ou fermez-la d’abord.',
  'The page did not answer. Reload it, then try again.': 'La page n’a pas répondu. Rechargez-la, puis réessayez.',
  // A site of no workspace (FRU-255).
  'Not in a workspace yet': 'Dans aucun workspace pour l’instant',
  'Ask an admin of your workspace to add this site.': 'Demandez à un admin de votre workspace d’ajouter ce site.',
  'Add it to review it. Nothing goes on the site: members with the extension see the notes, visitors see nothing.':
    'Ajoutez-le pour le relire. Rien n’est posé sur le site : les membres qui ont l’extension voient les notes, les visiteurs ne voient rien.',
  Workspace: 'Workspace',
  'Add to {workspace} and turn on': 'Ajouter à {workspace} et activer',
  'Your role in this workspace does not let you add a site.':
    'Votre rôle dans ce workspace ne permet pas d’ajouter un site.',
  'Too many sites were added in the last hour. Try again later.':
    'Trop de sites ont été ajoutés dans l’heure. Réessayez plus tard.',
  'Fruitback did not answer. Try again.': 'Fruitback n’a pas répondu. Réessayez.',
  'Your sign-in ended': 'Votre connexion a pris fin',
  'Sign in again to see and leave notes here.': 'Reconnectez-vous pour voir et laisser des notes ici.',
  'Fruitback did not answer. The popup asks again.': 'Fruitback n’a pas répondu. Le popup redemande.',
  'The browser did not give the extension access to Fruitback.':
    'Le navigateur n’a pas donné à l’extension l’accès à Fruitback.',
  'Fruitback works on http and https pages.': 'Fruitback fonctionne sur les pages http et https.',
  'No rule covers this origin, so Fruitback does nothing here.':
    'Aucune règle ne couvre cette origine, donc Fruitback ne fait rien ici.',
  'Rule: {pattern}': 'Règle : {pattern}',
  'Which mode can read it': 'Quel mode peut les lire',
  'Pair with this worker': 'Appairer avec ce worker',
  'This page is a pairing link for {worker}.': 'Cette page est un lien d’appairage pour {worker}.',
  'This is a site to review': 'C’est un site à relire',
  'This browser is already paired with that worker, so the link is not needed.':
    'Ce navigateur est déjà appairé avec ce worker, donc le lien n’est pas nécessaire.',
  'Log out': 'Se déconnecter',
  'Paired as {identity}': 'Appairé en tant que {identity}',
  'Pairing code': 'Code d’appairage',
  'I have a code': 'J’ai un code',
  'Not paired — this site cannot reach the worker until you do':
    'Non appairé — ce site ne peut pas joindre le worker tant que vous ne l’êtes pas',
  'Open the pairing link you were sent, then click this icon on that page.':
    'Ouvrez le lien d’appairage que vous avez reçu, puis cliquez sur cette icône sur cette page.',
  'Worker endpoint': 'Adresse du worker',
  'Client id': 'Identifiant du client',
  'Turn on for this site': 'Activer pour ce site',
  Save: 'Enregistrer',
  'Turn off for every site this rule covers': 'Désactiver pour tous les sites que cette règle couvre',
  'Turn off here': 'Désactiver ici',
  'Turn on for every site this rule covers': 'Activer pour tous les sites que cette règle couvre',
  Change: 'Modifier',
  On: 'Activé',
  Off: 'Désactivé',
  'workspace · {name}': 'workspace · {name}',
  // A straight apostrophe: the guide quotes this line as the popup writes it.
  "team mode · the site's own widget": 'mode équipe · le widget du site',
  'Private · the extension mounts the widget': 'Privé · l’extension monte le widget',
  'Team · the site embeds it, we relay': 'Équipe · le site l’intègre, nous relayons',
  Mode: 'Mode',

  // The options page.
  'Grant access': 'Donner l’accès',
  'Access granted': 'Accès donné',
  'No access in this browser': 'Pas d’accès dans ce navigateur',
  'No access while it is off': 'Aucun accès tant qu’il est désactivé',
  Sites: 'Sites',
  'Add rule': 'Ajouter la règle',
  'Add a rule': 'Ajouter une règle',
  'Export rules': 'Exporter les règles',
  'Import a rules file': 'Importer un fichier de règles',
  'Imported 1 rule.': '1 règle importée.',
  'Imported {count} rules.': '{count} règles importées.',
  'Skipped, because they are not valid: {patterns}.': 'Ignorées, parce qu’elles ne sont pas valides : {patterns}.',
  'Synchronise rules': 'Synchroniser les règles',
  'Keep my rules in the account of this browser': 'Garder mes règles dans le compte de ce navigateur',
  'When this is on, your rules (patterns, modes, endpoints, client ids, and the labels and workspace names they hold) are kept by the account of this browser, and reach your other browsers where it is on too. No session and no access travel: on another browser, grant access to each site. Turning it off stops the copy, and removes nothing from the account.':
    'Quand c’est activé, vos règles (motifs, modes, adresses de worker, identifiants de client, et les libellés et noms de workspace qu’elles portent) sont gardées par le compte de ce navigateur, et arrivent dans vos autres navigateurs où c’est activé aussi. Aucune session et aucun accès ne voyagent : sur un autre navigateur, donnez l’accès à chaque site. Désactiver arrête la copie, et ne retire rien du compte.',
  'Share rules': 'Partager les règles',
  'A rules file holds patterns, modes, endpoints and client ids. It holds no session and no access. An imported rule replaces the rule with the same pattern, and the other rules stay.':
    'Un fichier de règles contient des motifs, des modes, des adresses de worker et des identifiants de client. Il ne contient ni session ni accès. Une règle importée remplace la règle du même motif, et les autres règles restent.',

  // The problems, and what to do about each (`remedy.ts`).
  'That code has been used or has expired. Ask for a new one.':
    'Ce code a déjà servi ou a expiré. Demandez-en un nouveau.',
  'The worker did not answer. Try again.': 'Le worker n’a pas répondu. Réessayez.',
  'That worker is on plain http. A session must not cross it.':
    'Ce worker est en http simple. Une session ne doit pas y passer.',
  'Fruitback needs permission to reach that worker.': 'Fruitback a besoin de la permission de joindre ce worker.',
  'Pairing needs https (localhost excepted): a session must not cross http.':
    'L’appairage demande https (sauf localhost) : une session ne doit pas passer en http.',
  'The pairing code is required.': 'Le code d’appairage est requis.',
  'That file is not JSON.': 'Ce fichier n’est pas du JSON.',
  'That file is not a Fruitback rules file.': 'Ce fichier n’est pas un fichier de règles Fruitback.',
  'That file comes from a newer Fruitback. Update the extension, then import it again.':
    'Ce fichier vient d’un Fruitback plus récent. Mettez l’extension à jour, puis importez-le de nouveau.',
  'Try again': 'Réessayer',
  'Change the worker': 'Changer le worker',
  'Check the list': 'Vérifier la liste',
  'How to get a code': 'Comment obtenir un code',
  'A rule for that pattern already exists. Remove it first.':
    'Une règle existe déjà pour ce motif. Supprimez-la d’abord.',
  'Fruitback needs access to those sites to run there. Nothing was saved.':
    'Fruitback a besoin de l’accès à ces sites pour y fonctionner. Rien n’a été enregistré.',
  'Fruitback could not confirm that change. Check the list, then try again.':
    'Fruitback n’a pas pu confirmer ce changement. Vérifiez la liste, puis réessayez.',
  'This worker answers a signed-in reader only, and private mode carries no session. Notes do not show on this site.':
    'Ce worker ne répond qu’à un lecteur connecté, et le mode privé ne porte aucune session. Les notes ne s’affichent pas sur ce site.',
  'The workspace does not prove this domain now, so this rule runs nowhere. It runs again when the worker says the domain is proven.':
    'Le workspace ne prouve pas ce domaine en ce moment, donc cette règle ne s’applique nulle part. Elle s’appliquera à nouveau quand le worker dira que le domaine est prouvé.',
  'This rule is too large for the account of this browser, which keeps at most 8 KB for one rule. It is not copied there, and it stays and works in this browser.':
    'Cette règle est trop grande pour le compte de ce navigateur, qui garde au plus 8 Ko pour une règle. Elle n’y est pas copiée, et elle reste et fonctionne dans ce navigateur.',
  'A wildcard cannot serve team mode, so this rule runs nowhere. Remove it, and add one rule for each origin.':
    'Un joker ne peut pas servir le mode équipe, donc cette règle ne s’applique nulle part. Supprimez-la, et ajoutez une règle par origine.',
  'A team-mode rule must name one origin. A wildcard would lend your session to every site it covers.':
    'Une règle en mode équipe doit nommer une seule origine. Un joker prêterait votre session à tous les sites qu’il couvre.',
  'Use an origin such as https://acme.dev, or a wildcard such as https://*.staging.acme.dev.':
    'Utilisez une origine comme https://acme.dev, ou un joker comme https://*.staging.acme.dev.',
  'The endpoint must be a full http:// or https:// URL.':
    'L’adresse doit être une URL complète en http:// ou https://.',
  'The worker endpoint is required.': 'L’adresse du worker est requise.',
  'The client id is required.': 'L’identifiant du client est requis.',
  'A team-mode worker must be on https (localhost excepted).':
    'Un worker en mode équipe doit être en https (sauf localhost).',
};
