/**
 * The French words of the popup and of the options page (FRU-131). The key is the English sentence.
 *
 * `messages.test.ts` fails on a sentence a screen shows that is not here, on an entry no screen
 * shows, and on a translation that lost a placeholder.
 */
export const FRENCH: Readonly<Record<string, string>> = {
  // The popup.
  // The shell and the sign-in (FRU-251).
  'Signed in as {name}': 'Connecté en tant que {name}',
  'Settings and every site': 'Réglages et tous les sites',
  'Open the console': 'Ouvrir la console',
  'Running your own Fruitback?': 'Vous hébergez votre propre Fruitback ?',
  'Connect it in settings': 'Connectez-le dans les réglages',
  'Sign in to see and leave notes here': 'Connectez-vous pour voir et laisser des notes ici',
  'One account for the console and this extension. The sign-in opens in a tab, and this popup picks it up by itself.':
    'Un seul compte pour la console et cette extension. La connexion s’ouvre dans un onglet, et ce popup la reprend tout seul.',
  'Sign in to Fruitback': 'Se connecter à Fruitback',
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
  'Your sign-in ended': 'Votre connexion a pris fin',
  'Sign in again to see and leave notes here.': 'Reconnectez-vous pour voir et laisser des notes ici.',
  'Fruitback did not answer. The popup asks again.': 'Fruitback n’a pas répondu. Le popup redemande.',
  'The browser did not give the extension access to Fruitback.':
    'Le navigateur n’a pas donné à l’extension l’accès à Fruitback.',
  'Fruitback works on http and https pages.': 'Fruitback fonctionne sur les pages http et https.',
  'No rule covers this origin, so Fruitback does nothing here.':
    'Aucune règle ne couvre cette origine, donc Fruitback ne fait rien ici.',
  'Rule: {pattern}': 'Règle : {pattern}',
  'This site is in your workspace.': 'Ce site est dans votre workspace.',
  'This site is in the workspace {name}.': 'Ce site est dans le workspace {name}.',
  'Turn on Fruitback here': 'Activer Fruitback ici',
  'Set up by hand': 'Configurer à la main',
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
  'Turn on here': 'Activer ici',
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
  'Fruitback sites': 'Sites Fruitback',
  'A rule says which worker, and which client, a site belongs to. A site that no rule covers mounts nothing.':
    'Une règle dit à quel worker, et à quel client, un site appartient. Un site qu’aucune règle ne couvre ne monte rien.',
  'No rules yet. Add one below, or turn a site on from the toolbar.':
    'Aucune règle pour le moment. Ajoutez-en une ci-dessous, ou activez un site depuis la barre d’outils.',
  'Grant access': 'Donner l’accès',
  'Turn off': 'Désactiver',
  'Turn on': 'Activer',
  Remove: 'Supprimer',
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
