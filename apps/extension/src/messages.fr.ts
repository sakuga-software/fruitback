/**
 * The French words of the popup and of the options page (FRU-131). The key is the English sentence.
 *
 * `messages.test.ts` fails on a sentence a screen shows that is not here, on an entry no screen
 * shows, and on a translation that lost a placeholder.
 */
export const FRENCH: Readonly<Record<string, string>> = {
  'This preference could not be saved. Try again.': 'Cette préférence n’a pas pu être enregistrée. Réessayez.',
  // FRU-425: « Allow captures on every site », and the prompt of each browser that it quotes.
  'Allow captures on every site': 'Autoriser les captures sur tous les sites',
  'Your browser will say that Fruitback can “{warning}”. Fruitback uses it only for the captures you ask for, so you no longer click its icon before each one. Turning it off gives it back to your browser.':
    'Votre navigateur dira que Fruitback peut « {warning} ». Fruitback s’en sert seulement pour les captures que vous demandez : vous n’avez plus à cliquer sur son icône avant chacune. La désactiver la rend à votre navigateur.',
  'Your browser will ask you to allow Fruitback on every website. Fruitback uses it only for the captures you ask for, so you no longer click its icon before each one. Turning it off gives it back to your browser.':
    'Votre navigateur vous demandera d’autoriser Fruitback sur tous les sites web. Fruitback s’en sert seulement pour les captures que vous demandez : vous n’avez plus à cliquer sur son icône avant chacune. La désactiver la rend à votre navigateur.',
  // Measured: Chrome in French says it so (`e2e/capture-everywhere.spec.ts`).
  'Read and change all your data on all websites': 'Lire et modifier toutes vos données sur tous les sites Web',
  'Access your data for all websites': 'Accéder à vos données sur tous les sites web',
  // FRU-423: the item of the context menu of a page.
  'Capture with Fruitback': 'Capturer avec Fruitback',
  // FRU-444: the widget hidden on one site, its rule still on.
  'Show Fruitback on this page': 'Afficher Fruitback sur cette page',
  // FRU-298: the screens 2 and 3 of the popup.
  'Not in your sites yet': 'Pas encore dans vos sites',
  'In {workspace} · not on in this browser': 'Dans {workspace} · pas activé dans ce navigateur',
  'Turn Fruitback on for this site?': 'Activer Fruitback sur ce site ?',
  'Notes go to': 'Les notes vont vers',
  'Who sees the notes': 'Qui voit les notes',
  'Fruitback (no tracker)': 'Fruitback (sans outil de suivi)',
  'Not known': 'Inconnu',
  Repository: 'Dépôt',
  Project: 'Projet',
  'No project': 'Aucun projet',
  'Choose a team…': 'Choisir une équipe…',
  'Choose a repository…': 'Choisir un dépôt…',
  'The list did not load. Choose the provider again.': 'La liste n’a pas chargé. Choisissez de nouveau l’outil.',
  'This place is not in the tracker any more. Choose another one.':
    'Cet endroit n’est plus dans l’outil de suivi. Choisissez-en un autre.',
  'Your role in this workspace does not let you change this site.':
    'Votre rôle dans cet espace ne vous permet pas de modifier ce site.',
  'This site sends to several places. Change them in Fruitback.':
    'Ce site envoie vers plusieurs endroits. Modifiez-les dans Fruitback.',
  'Turn on': 'Activer',
  'Your browser will ask to allow this site once.': 'Votre navigateur demandera une fois l’accès à ce site.',
  'Your team and invited guests': 'Votre équipe et les invités',
  'Everyone who visits the site': 'Tous ceux qui visitent le site',
  'On · notes go to {tracker}': 'Activé · les notes vont vers {tracker}',
  'or press {keys} on the page': 'ou appuyez sur {keys} sur la page',
  '1 fix to check': '1 correction à vérifier',
  '{count} fixes to check': '{count} corrections à vérifier',
  'Marked done by the team': 'Marquées terminées par l’équipe',
  'No open note': 'Aucune note ouverte',
  '1 open note': '1 note ouverte',
  '{count} open notes': '{count} notes ouvertes',
  'New, to do or in progress': 'Nouvelles, à faire ou en cours',
  'Show all notes in a sidebar': 'Voir toutes les notes dans un panneau',
  // The page that opens at install (FRU-318).
  'Welcome to Fruitback': 'Bienvenue dans Fruitback',
  'Fruitback is installed': 'Fruitback est installé',
  'Pin Fruitback, then sign in. It then works on every site your team reviews.':
    'Épinglez Fruitback, puis connectez-vous. Il marche ensuite sur chaque site que votre équipe relit.',
  'Pin Fruitback': 'Épinglez Fruitback',
  'Open the puzzle piece at the right of the address bar, then press the pin beside Fruitback.':
    'Ouvrez la pièce de puzzle à droite de la barre d’adresse, puis appuyez sur l’épingle à côté de Fruitback.',
  'Sign in': 'Connectez-vous',
  'Click the Fruitback icon, then Sign in with email.':
    'Cliquez sur l’icône de Fruitback, puis sur Se connecter par e-mail.',
  'Invited by a client or a team? Use the email the invitation was sent to.':
    'Invité par un client ou une équipe ? Utilisez l’adresse à laquelle l’invitation a été envoyée.',
  'Open Fruitback': 'Ouvrir Fruitback',
  'Your browser did not open it from this page: click the Fruitback icon in the toolbar.':
    'Votre navigateur ne l’a pas ouvert depuis cette page : cliquez sur l’icône de Fruitback dans la barre d’outils.',
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
  'Runs nowhere': 'Ne tourne nulle part',
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
  'The site ships nothing; the extension mounts the widget of {workspace} and carries your session.':
    'Le site n’embarque rien ; l’extension monte le widget de {workspace} et porte votre session.',
  'The site ships nothing; the extension mounts the widget of your workspace and carries your session.':
    'Le site n’embarque rien ; l’extension monte le widget de votre workspace et porte votre session.',
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
  'Turn on here': 'Activer ici',
  'On · {workspace}': 'Activé · {workspace}',
  'Off · {workspace}': 'Désactivé · {workspace}',
  'Fruitback on {host}': 'Fruitback sur {host}',
  'Leave feedback': 'Laisser une note',
  'A note is being written on the page. Send it or close it first.':
    'Une note est en cours d’écriture sur la page. Envoyez-la ou fermez-la d’abord.',
  'The page did not answer. Reload it, then try again.': 'La page n’a pas répondu. Rechargez-la, puis réessayez.',
  // FRU-395: a pairing link where the worker goes, and a worker that is not at the address of a rule.
  'This is a pairing link, not the address of a worker. Use it to pair, and give the rule the address before /pair.':
    'Ceci est un lien d’appairage, pas l’adresse d’un worker. Utilisez-le pour vous appairer, et donnez à la règle l’adresse avant /pair.',
  'An address that ends in /pair, or that carries a #, is a pairing link, not a worker. Give the address before /pair.':
    'Une adresse qui finit par /pair, ou qui porte un #, est un lien d’appairage, pas un worker. Donnez l’adresse avant /pair.',
  'Pair with this link': 'S’appairer avec ce lien',
  'The worker of this rule does not answer. Check its address in the options.':
    'Le worker de cette règle ne répond pas. Vérifiez son adresse dans les options.',
  // FRU-397: another copy of Fruitback on the page of the tab.
  'Another copy of Fruitback runs on this page, or the version of before of this one. Reload the page. If this stays, remove the other copy in {place}.':
    'Une autre copie de Fruitback tourne sur cette page, ou la version précédente de celle-ci. Rechargez la page. Si cela reste, retirez l’autre copie dans {place}.',
  'Another copy of Fruitback ({version}) runs on this page. Reload the page. If this stays, remove that copy in {place}.':
    'Une autre copie de Fruitback ({version}) tourne sur cette page. Rechargez la page. Si cela reste, retirez cette copie dans {place}.',
  // A site of no workspace (FRU-255).
  'Ask an admin of your workspace to add this site.': 'Demandez à un admin de votre workspace d’ajouter ce site.',
  Workspace: 'Workspace',
  'Your role in this workspace does not let you add a site.':
    'Votre rôle dans ce workspace ne permet pas d’ajouter un site.',
  'Too many sites were added in the last hour. Try again later.':
    'Trop de sites ont été ajoutés dans l’heure. Réessayez plus tard.',
  'Fruitback did not answer. Try again.': 'Fruitback n’a pas répondu. Réessayez.',
  'Your sign-in ended': 'Votre connexion a pris fin',
  'Sign in again to see and leave notes here.': 'Reconnectez-vous pour voir et laisser des notes ici.',
  'Fruitback did not answer. The popup asks again.': 'Fruitback n’a pas répondu. Le popup redemande.',
  'Fruitback did not answer. The page asks again.': 'Fruitback n’a pas répondu. La page redemande.',
  'Signed in as {who}.': 'Connecté en tant que {who}.',
  'Open a site of your team, then click the Fruitback icon.':
    'Ouvrez un site de votre équipe, puis cliquez sur l’icône Fruitback.',
  'Sign in, then turn on a site your team reviews.': 'Connectez-vous, puis activez un site que votre équipe relit.',
  'Tip:': 'Astuce :',
  'Pin Fruitback to find it in the toolbar later: open the puzzle piece at the right of the address bar, then press the pin beside Fruitback.':
    'Épinglez Fruitback pour le retrouver ensuite dans la barre d’outils : ouvrez la pièce de puzzle à droite de la barre d’adresse, puis appuyez sur l’épingle à côté de Fruitback.',
  'No site in your workspaces yet.': 'Aucun site dans vos workspaces pour l’instant.',
  'Open {site}': 'Ouvrir {site}',
  'Turn on {site}': 'Activer sur {site}',
  'Turn on a site of your workspaces:': 'Activez un site de vos workspaces :',
  'Chrome asks for access to this site only.': 'Chrome demande l’accès à ce site seulement.',
  'The browser did not give access to this site.': 'Le navigateur n’a pas donné l’accès à ce site.',
  'The site could not be turned on. Try again.': 'Le site n’a pas pu être activé. Réessayez.',
  'The browser did not give the extension access to Fruitback.':
    'Le navigateur n’a pas donné à l’extension l’accès à Fruitback.',
  // FRU-526: a page of the browser, where no extension draws.
  "Fruitback can't run on this page": 'Fruitback ne peut pas fonctionner sur cette page',
  'This is a page of the browser, like a new tab, the settings, the extension store or a PDF. No extension can draw on it.':
    'C’est une page du navigateur, comme un nouvel onglet, les réglages, la boutique d’extensions ou un PDF. Aucune extension ne peut y dessiner.',
  'Open a site your team reviews.': 'Ouvrez un site que votre équipe relit.',
  'There, click the Fruitback icon, or press {keys}.': 'Là, cliquez sur l’icône de Fruitback, ou appuyez sur {keys}.',
  'There, click the Fruitback icon.': 'Là, cliquez sur l’icône de Fruitback.',
  'Nothing changed for your sites and your notes.': 'Rien n’a changé pour vos sites et vos notes.',
  'No rule covers this origin, so Fruitback does nothing here.':
    'Aucune règle ne couvre cette origine, donc Fruitback ne fait rien ici.',
  'Rule: {pattern}': 'Règle : {pattern}',
  'Which mode can read it': 'Quel mode peut les lire',
  'Pair with this worker': 'Appairer avec ce worker',
  'This page is a pairing link for {worker}.': 'Cette page est un lien d’appairage pour {worker}.',
  'This is a site to review': 'C’est un site à relire',
  'Paired. This browser reads and writes the notes of this worker.':
    'Appairé. Ce navigateur lit et écrit les notes de ce worker.',
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
  'Change it in Add-ons, Manage Extension Shortcuts.':
    'Changez-le dans Modules complémentaires, Gérer les raccourcis d’extensions.',
  // FRU-380: Safari has no page of shortcuts an extension may open. The names are those of Safari in
  // French (Réglages, Extensions), not measured in a French Safari.
  'Change it in Safari Settings, Extensions.': 'Changez-le dans les Réglages de Safari, Extensions.',
  'Safari Settings, Extensions': 'Réglages de Safari, Extensions',
  'Add a rule': 'Ajouter une règle',
  'Import a rules file': 'Importer un fichier de règles',
  'Downloaded {file}, with 1 rule.': '{file} téléchargé, avec 1 règle.',
  'Downloaded {file}, with {count} rules.': '{file} téléchargé, avec {count} règles.',
  'Imported 1 rule.': '1 règle importée.',
  'Imported {count} rules.': '{count} règles importées.',
  'Skipped, because they are not valid: {patterns}.': 'Ignorées, parce qu’elles ne sont pas valides : {patterns}.',
  'Keep my rules in the account of this browser': 'Garder mes règles dans le compte de ce navigateur',
  'When this is on, your rules (patterns, modes, endpoints, client ids, and the labels and workspace names they hold) are kept by the account of this browser, and reach your other browsers where it is on too. No session and no access travel: on another browser, grant access to each site. Turning it off stops the copy, and removes nothing from the account.':
    'Quand c’est activé, vos règles (motifs, modes, adresses de worker, identifiants de client, et les libellés et noms de workspace qu’elles portent) sont gardées par le compte de ce navigateur, et arrivent dans vos autres navigateurs où c’est activé aussi. Aucune session et aucun accès ne voyagent : sur un autre navigateur, donnez l’accès à chaque site. Désactiver arrête la copie, et ne retire rien du compte.',
  'Share rules': 'Partager les règles',
  // FRU-302: « Workers and sessions » and « Preferences ».
  'Workers and sessions': 'Workers et sessions',
  'Pair in the page of the extension': 'Appairer dans la page de l’extension',
  '1 site': '1 site',
  '{count} sites': '{count} sites',
  'You pair with a worker, not with a site: one session covers every site that reports to it. Only team mode needs one.':
    'On s’appaire avec un worker, pas avec un site : une session couvre tous les sites qui lui rendent compte. Seul le mode équipe en a besoin.',
  'No worker yet. A rule names one.': 'Aucun worker pour l’instant. Une règle en nomme un.',
  'Not paired. Private-mode sites read without a session; a team site would stay asleep.':
    'Pas appairé. Les sites en mode privé lisent sans session ; un site d’équipe resterait endormi.',
  Pair: 'Appairer',
  'Plain http on localhost. Pairing works here; anywhere else a session must not cross http.':
    'http simple sur localhost. L’appairage marche ici ; ailleurs, une session ne doit pas passer par http.',
  'Signed in as {name}': 'Connecté en tant que {name}',
  'Signed in': 'Connecté',
  Paired: 'Appairé',
  'One account for the console and this extension': 'Un seul compte pour la console et cette extension',
  'Verified by the worker · renews on its own': 'Vérifié par le worker · se renouvelle seul',
  'Open notes in the sidebar': 'Ouvrir les notes dans le panneau',
  'Instead of floating pins only, on every site you review.':
    'Plutôt que les seules épingles, sur chaque site que vous relisez.',
  'Name on my notes': 'Nom sur mes notes',
  // FRU-349.
  'Show CSS selectors': 'Afficher les sélecteurs CSS',
  // FRU-443: the corner of the widget.
  'Corner of the widget': 'Coin du widget',
  'Where the widget stands on every site you review. It moves at once, and a note being written stays.':
    'L’endroit où le widget se place sur tous les sites que vous relisez. Il se déplace aussitôt, et une note en cours d’écriture reste.',
  'Bottom right': 'En bas à droite',
  'Bottom left': 'En bas à gauche',
  'Top right': 'En haut à droite',
  'Top left': 'En haut à gauche',
  'In the head of a note you write, and in the note of a pin. The issue in your tracker keeps the selector either way.':
    'Dans l’en-tête d’une note que vous écrivez, et dans la note d’une épingle. Le ticket de votre outil de suivi garde le sélecteur dans tous les cas.',
  'Prefilled in private mode. Team mode signs with your session.':
    'Prérempli en mode privé. Le mode équipe signe avec votre session.',
  'Not set': 'Aucun',
  'Leave feedback shortcut': 'Raccourci pour laisser une note',
  "Set in your browser's extension shortcuts.": 'Se règle dans les raccourcis d’extensions du navigateur.',
  // FRU-290: the two cards of « Share rules ».
  'Hand a reviewer a rules file instead of five fields to copy. Browser access never travels with it: they grant it on first use.':
    'Donnez un fichier de règles plutôt que cinq champs à recopier. L’accès du navigateur ne voyage jamais avec lui : il se donne à la première utilisation.',
  Export: 'Exporter',
  Download: 'Télécharger',
  '1 rule': '1 règle',
  '{count} rules': '{count} règles',
  'Drop it here, or choose one': 'Déposez-le ici, ou choisissez-en un',
  'Choose…': 'Choisir…',
  imported: 'importée',
  'This rule came from a rules file, and access does not travel with it. Nothing is mounted until you grant it.':
    'Cette règle vient d’un fichier de règles, et l’accès ne voyage pas avec elle. Rien n’est monté tant que vous ne le donnez pas.',
  // FRU-296: the side panel of the browser.
  'Notes on this page': 'Notes de cette page',
  'Close the sidebar': 'Fermer le panneau',
  'Fruitback is not on for this page.': 'Fruitback n’est pas activé sur cette page.',
  'Turn it on from the Fruitback button in the toolbar.': 'Activez-le depuis le bouton Fruitback de la barre d’outils.',
  // FRU-299: « Notes on this page ».
  You: 'Vous',
  Anonymous: 'Anonyme',
  'Then click the part of the page you want to comment on': 'Puis cliquez sur la partie de la page à commenter',
  Settings: 'Réglages',
  'Reading the notes of this page…': 'Lecture des notes de cette page…',
  'The notes of this page could not be read. They are not lost.':
    'Les notes de cette page n’ont pas pu être lues. Elles ne sont pas perdues.',
  'No notes on this page yet': 'Aucune note sur cette page pour l’instant',
  'Press Leave feedback, click anything that looks wrong and write what you expected. The team gets it right away.':
    'Appuyez sur Laisser une note, cliquez sur ce qui ne va pas et écrivez ce que vous attendiez. L’équipe la reçoit tout de suite.',
  'Open · {count}': 'Ouvertes · {count}',
  'Done · {count}': 'Terminées · {count}',
  'Done notes': 'Notes terminées',
  'Open notes': 'Notes ouvertes',
  'No note is done yet.': 'Aucune note n’est terminée pour l’instant.',
  'No note is open.': 'Aucune note n’est ouverte.',
  Replies: 'Réponses',
  'Show on the page': 'Voir sur la page',
  Reply: 'Répondre',
  'Your reply': 'Votre réponse',
  Cancel: 'Annuler',
  'Sending…': 'Envoi…',
  Send: 'Envoyer',
  'The reply did not go through. Your text is kept. Try again.':
    'La réponse n’est pas partie. Votre texte est gardé. Réessayez.',
  'Too many replies just now. Your text is kept. Try again in a minute.':
    'Trop de réponses à l’instant. Votre texte est gardé. Réessayez dans une minute.',
  'Your session ended. Sign in again from the Fruitback button, then send.':
    'Votre session a pris fin. Reconnectez-vous depuis le bouton Fruitback, puis envoyez.',
  'You cannot reply to this note any more.': 'Vous ne pouvez plus répondre à cette note.',
  'This page was open before Fruitback was on. Reload it to see its notes.':
    'Cette page était ouverte avant que Fruitback soit activé. Rechargez-la pour voir ses notes.',
  'Reload the page': 'Recharger la page',
  'Fruitback did not start on this page. Reload it to see its notes.':
    'Fruitback n’a pas démarré sur cette page. Rechargez-la pour voir ses notes.',
  'Your session ended. Sign in again from the Fruitback button.':
    'Votre session a pris fin. Reconnectez-vous depuis le bouton Fruitback.',
  '{host} runs its own Fruitback.': '{host} a son propre Fruitback.',
  'Its notes are on the page, in its own list. This panel lists the notes of a site Fruitback mounts.':
    'Ses notes sont sur la page, dans sa propre liste. Ce panneau liste les notes d’un site où Fruitback se monte.',
  // FRU-300: « Ready to check ».
  'just now': 'à l’instant',
  'Checked by you · {age}': 'Vérifiée par vous · {age}',
  'Checked by {name} · {age}': 'Vérifiée par {name} · {age}',
  'Reopened by you · {age}': 'Rouverte par vous · {age}',
  'Fixed by {name} · {age}': 'Corrigé par {name} · {age}',
  'Marked done · {age}': 'Marquée terminée · {age}',
  'Ready to check · {count}': 'À vérifier · {count}',
  'The team says these are fixed. Do they look right to you?': 'L’équipe dit que c’est corrigé. Est-ce bon pour vous ?',
  'Looks fixed': 'C’est corrigé',
  'Still wrong': 'Toujours pas',
  'Did not go through. Try again.': 'Ça n’est pas parti. Réessayez.',
  'Too many requests just now. Try again in a minute.': 'Trop de demandes à l’instant. Réessayez dans une minute.',
  'Your session ended. Sign in again from the Fruitback button, then try again.':
    'Votre session a pris fin. Reconnectez-vous depuis le bouton Fruitback, puis réessayez.',
  'This note can no longer be checked here. The list is read again.':
    'Cette note ne peut plus être vérifiée ici. La liste est relue.',

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
  'This site takes notes from its members only, and private mode carries no session: no note can be sent from here. To review it in private mode, an admin of the site sets « Who can leave a note » to « Anyone on the page » in the console.':
    'Ce site prend les notes de ses membres seulement, et le mode privé ne porte aucune session : aucune note ne peut partir d’ici. Pour le relire en mode privé, un admin du site choisit « Toute personne sur la page » sous « Qui peut laisser une note ? » dans la console.',
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
  // FRU-307: « Search and options ».
  'Search and options': 'Recherche et options',
  Scope: 'Portée',
  'This page': 'Cette page',
  'This page · {count}': 'Cette page · {count}',
  'Whole site': 'Tout le site',
  'Whole site · {count}': 'Tout le site · {count}',
  'Search notes': 'Chercher dans les notes',
  'Searches the first words of each note': 'Cherche dans les premiers mots de chaque note',
  Status: 'Statut',
  All: 'Toutes',
  'Show pins on the page': 'Afficher les épingles sur la page',
  '1 detached note': '1 note détachée',
  '{count} detached notes': '{count} notes détachées',
  '{stage} · the element it pointed at is gone': '{stage} · l’élément qu’elle visait n’existe plus',
  'The notes of the whole site cannot be read from this browser.':
    'Les notes de tout le site ne peuvent pas être lues depuis ce navigateur.',
  'Reading the notes of the whole site…': 'Lecture des notes de tout le site…',
  'No note matches.': 'Aucune note ne correspond.',
  'Notes of the whole site': 'Notes de tout le site',
  'Showing {shown} of {total}': '{shown} sur {total}',
  'Reading…': 'Lecture…',
  'The next notes could not be read.': 'Les notes suivantes n’ont pas pu être lues.',
  'Show more': 'Voir plus',
  'The notes of the whole site could not be read. They are not lost.':
    'Les notes de tout le site n’ont pas pu être lues. Elles ne sont pas perdues.',
  'Shows the note on this page': 'Montre la note sur cette page',
  'Opens {path} in a new tab': 'Ouvre {path} dans un nouvel onglet',
  'Open {reference} →': 'Ouvrir {reference} →',
  // FRU-519: the line of a new release, in the popup and the page.
  'Fruitback {version} is out.': 'Fruitback {version} est disponible.',
  Update: 'Mettre à jour',
};
