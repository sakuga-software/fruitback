/**
 * The French words of the popup and of the options page (FRU-131). The key is the English sentence.
 *
 * `messages.test.ts` fails on a sentence a screen shows that is not here, on an entry no screen
 * shows, and on a translation that lost a placeholder.
 */
export const FRENCH: Readonly<Record<string, string>> = {
  // The popup.
  'Fruitback works on http and https pages.': 'Fruitback fonctionne sur les pages http et https.',
  'No rule covers this origin, so Fruitback does nothing here.':
    'Aucune règle ne couvre cette origine, donc Fruitback ne fait rien ici.',
  'Rule: {pattern}': 'Règle : {pattern}',
  'This site is in your workspace.': 'Ce site est dans votre workspace.',
  'This site is in the workspace {name}.': 'Ce site est dans le workspace {name}.',
  'Turn on Fruitback here': 'Activer Fruitback ici',
  'Set up by hand': 'Configurer à la main',
  'Which mode can read it': 'Quel mode peut les lire',
  'All sites and rules': 'Tous les sites et les règles',
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
  Sites: 'Sites',
  'Add rule': 'Ajouter la règle',
  'Add a rule': 'Ajouter une règle',
  'Export rules': 'Exporter les règles',
  'Import a rules file': 'Importer un fichier de règles',
  'Imported 1 rule.': '1 règle importée.',
  'Imported {count} rules.': '{count} règles importées.',
  'Skipped, because they are not valid: {patterns}.': 'Ignorées, parce qu’elles ne sont pas valides : {patterns}.',
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
