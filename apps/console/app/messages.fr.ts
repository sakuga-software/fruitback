/**
 * The console in French (FRU-120). The key is the English sentence a screen shows: see `i18n.ts`.
 *
 * A name of a product is a key too when a screen shows it through `t`, and it reads the same.
 */
export const FRENCH: Readonly<Record<string, string>> = {
  Linear: 'Linear',

  'Fruitback cannot reach its server. Check your connection.':
    'Fruitback ne joint pas son serveur. Vérifiez votre connexion.',
  'Try again': 'Réessayer',
  'Sign in': 'Se connecter',
  'Your session ended. Sign in again in another tab: what you wrote here stays.':
    'Votre session a pris fin. Reconnectez-vous dans un autre onglet : ce que vous avez écrit ici reste.',
  'You are still signed out. Sign in in the other tab, then continue.':
    "Vous n'êtes toujours pas connecté. Connectez-vous dans l'autre onglet, puis continuez.",
  'Loading…': 'Chargement…',

  'My account': 'Mon compte',
  'Your name on notes, how you sign in, and where.': 'Votre nom sur les notes, comment vous vous connectez, et où.',
  'Name shown on notes': 'Nom affiché sur les notes',
  'How you sign in': 'Comment vous vous connectez',
  'Any of these opens the same account, in the console and in the extension.':
    'Chacune ouvre le même compte, dans la console et dans l’extension.',
  'Always on': 'Toujours actif',
  'Disconnect a browser you no longer use. It stops showing notes at once.':
    'Déconnectez un navigateur que vous n’utilisez plus. Il cesse aussitôt d’afficher les notes.',
  'Fruitback did not answer. The browsers where you are signed in could not be read.':
    'Fruitback n’a pas répondu. Les navigateurs où vous êtes connecté n’ont pas pu être lus.',
  'This browser': 'Ce navigateur',
  'Console · another browser': 'Console · un autre navigateur',
  'Signed in {since} · used {last}': 'Connecté le {since} · utilisé le {last}',
  'This browser is still signed in: Fruitback did not end its session. Try again.':
    'Ce navigateur est toujours connecté : Fruitback n’a pas fermé sa session. Réessayez.',
  Disconnect: 'Déconnecter',
  'Sign out everywhere': 'Se déconnecter partout',
  'Sign out of every browser': 'Se déconnecter de tous les navigateurs',
  'Stay signed in': 'Rester connecté',
  'Every browser where the console is signed in to your account is signed out, this one too. The extension stays connected.':
    'Chaque navigateur où la console est connectée à votre compte est déconnecté, celui-ci aussi. L’extension reste connectée.',
  'You may still be signed in: Fruitback did not confirm the sign-out of every browser. Try again.':
    'Vous êtes peut-être encore connecté : Fruitback n’a pas confirmé la déconnexion de tous les navigateurs. Réessayez.',
  Profile: 'Profil',
  'Email link': 'Lien par e-mail',
  'After the beta': 'Après la bêta',
  Language: 'Langue',
  'The language of the console, and of the e-mails Fruitback sends you.':
    'La langue de la console, et des e-mails que Fruitback vous envoie.',
  'Your account did not take this language yet. It is kept in this browser, and sent again the next time you open the console.':
    'Votre compte n’a pas encore pris cette langue. Elle est gardée dans ce navigateur, et renvoyée la prochaine fois que vous ouvrez la console.',
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
  'Linear did not answer for this connection. Disconnect it, then connect Linear again.':
    'Linear n’a pas répondu pour cette connexion. Déconnectez-la, puis connectez Linear de nouveau.',
  'Linear was not connected: the consent was refused there.':
    'Linear n’a pas été connecté : le consentement y a été refusé.',
  'Fruitback could not start the connection to Linear. Try again.':
    'Fruitback n’a pas pu démarrer la connexion à Linear. Réessayez.',
  'Going to Linear…': 'Direction Linear…',
  'Use an API key': 'Utiliser une clé d’API',
  'Workspace {name}': 'Workspace {name}',
  'Connected to the workspace {name}': 'Connecté au workspace {name}',
  'Google did not sign you in: the access was declined. Try again, or use an email link.':
    'Google ne vous a pas connecté : l’accès a été refusé. Réessayez, ou utilisez un lien par e-mail.',
  'Google has no verified address for this account. Use an email link.':
    'Google n’a pas d’adresse vérifiée pour ce compte. Utilisez un lien par e-mail.',
  'The sign-in with Google did not finish. Try again, or use an email link.':
    'La connexion avec Google n’a pas abouti. Réessayez, ou utilisez un lien par e-mail.',
  'Not set up': 'Non configuré',
  'Could not check': 'Vérification impossible',
  'Where you are signed in': 'Où vous êtes connecté',
  'Console · this browser': 'Console · ce navigateur',
  'Active now': 'Actif maintenant',
  'Sign out': 'Se déconnecter',
  'This Fruitback sends no sign-in link by e-mail. Only its owner signs in for now, with a link that the person who runs it makes. Everybody else can sign in once it sends e-mail, or offers GitHub or Google.':
    'Ce Fruitback n’envoie pas de lien de connexion par e-mail. Seul son propriétaire se connecte pour l’instant, avec un lien que crée la personne qui l’exploite. Les autres pourront se connecter quand il enverra des e-mails, ou proposera GitHub ou Google.',
  'Nobody can sign in to this Fruitback yet: its sign-in is not set up. The person who runs it has one setting to add.':
    'Personne ne peut encore se connecter à ce Fruitback : sa connexion n’est pas configurée. La personne qui l’exploite a un réglage à ajouter.',
  'Another account is signed in in this browser': 'Un autre compte est connecté dans ce navigateur',
  'You were signed out': 'Vous avez été déconnecté',
  'This tab was open for another account, so it stopped: nothing was sent from it. Load it again to go on.':
    'Cet onglet était ouvert pour un autre compte, il s’est donc arrêté : rien n’en est parti. Rechargez-le pour continuer.',
  'Your session ended while this tab was away, so it stopped: nothing was sent from it.':
    'Votre session s’est terminée pendant que cet onglet était de côté, il s’est donc arrêté : rien n’en est parti.',
  'What you were writing, to copy:': 'Ce que vous étiez en train d’écrire, à copier :',
  'Load the console again': 'Recharger la console',
  'You are still signed in: Fruitback did not confirm the sign-out. Try again.':
    'Vous êtes toujours connecté : Fruitback n’a pas confirmé la déconnexion. Réessayez.',
  'Delete the workspace': 'Supprimer le workspace',
  'Sites, members and pin positions go. Items already in your sources stay there.':
    'Les sites, les membres et la position des pins disparaissent. Les éléments déjà dans vos sources y restent.',
  'Keep it': 'Le garder',
  'Delete workspace': 'Supprimer le workspace',
  'Delete {workspace}': 'Supprimer {workspace}',

  'An issue per note, in one repository.': 'Un ticket par note, dans un dépôt.',
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
  Connected: 'Connectées',
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
  'Needs attention': 'Action requise',
  'Linear refuses this connection since {when}, and the notes of its sites do not reach Linear. Disconnect it, then connect Linear again.':
    'Linear refuse cette connexion depuis {when}, et les notes de ses sites n’arrivent pas dans Linear. Déconnectez-la, puis connectez Linear de nouveau.',
  'Since {when}, Linear refuses what Fruitback asks with this key, and the notes of its sites do not reach Linear. Disconnect it, then connect Linear with a key that has read and write access.':
    'Depuis {when}, Linear refuse ce que Fruitback demande avec cette clé, et les notes de ses sites n’arrivent pas dans Linear. Déconnectez-la, puis connectez Linear avec une clé qui a les droits de lecture et d’écriture.',
  'Linear ended this connection, and since {when} the notes of its sites do not reach Linear. Disconnect it, then connect Linear again.':
    'Linear a mis fin à cette connexion, et depuis {when} les notes de ses sites n’arrivent pas dans Linear. Déconnectez-la, puis connectez Linear de nouveau.',
  '{count} site': '{count} site',
  '{count} sites': '{count} sites',
  'The destination of this site did not change. Try again.': 'La destination de ce site n’a pas changé. Réessayez.',
  'This source is still connected. Try again.': 'Cette source est toujours connectée. Réessayez.',
  'Connected with the key of {person}': 'Connectée avec la clé de {person}',
  'This workspace has no site yet.': 'Ce workspace n’a pas encore de site.',
  'Another source': 'Une autre source',
  '{team}, no project': '{team}, sans projet',

  Owner: 'Propriétaire',
  Admin: 'Administrateur',
  Member: 'Membre',
  Guest: 'Invité',
  Members: 'Membres',
  'Who sees and leaves notes, and who changes the workspace.':
    'Qui voit et laisse des notes, et qui modifie le workspace.',
  'Invite someone': 'Inviter quelqu’un',
  Email: 'E-mail',
  Invite: 'Inviter',
  'Invitation sent to {email}. You can also send them this link:':
    'Invitation envoyée à {email}. Vous pouvez aussi lui envoyer ce lien :',
  'Invitation kept for {email}. Send them this link:': 'Invitation gardée pour {email}. Envoyez-lui ce lien :',
  'They open it, sign in with {email}, and join. The link alone opens nothing.':
    'La personne l’ouvre, se connecte avec {email}, et rejoint l’espace. Le lien seul n’ouvre rien.',
  'Copy the link': 'Copier le lien',
  'The browser refused the copy. Select the link above and copy it by hand.':
    'Le navigateur a refusé la copie. Sélectionnez le lien ci-dessus et copiez-le à la main.',
  '{name} (you)': '{name} (vous)',
  'Shared ones': 'Partagés',
  'Remove {name}': 'Retirer {name}',
  '{name} leaves the workspace, and their extension stops reading its sites. Their notes stay.':
    '{name} quitte l’espace de travail, et son extension cesse de lire ses sites. Ses notes restent.',
  'Invitation sent': 'Invitation envoyée',
  'Until {date}': 'Jusqu’au {date}',
  'Invitation kept': 'Invitation gardée',
  'Sent {date}': 'Envoyée le {date}',
  Joined: 'Arrivée',
  Resend: 'Renvoyer',
  'Cancel the invitation of {email}': 'Annuler l’invitation de {email}',
  'The message already sent no longer lets {email} join.':
    'Le message déjà envoyé ne permet plus à {email} de rejoindre l’espace.',
  'Type the full address of the person, like name@company.com.':
    'Tapez l’adresse complète de la personne, comme nom@entreprise.com.',
  'This person is already a member of the workspace.': 'Cette personne est déjà membre de l’espace de travail.',
  'This address is invited already. Send the invitation again from its row.':
    'Cette adresse est déjà invitée. Renvoyez l’invitation depuis sa ligne.',
  'Invitation kept for {email}, but no message was sent: too many invitation messages went in a short time. Send them this link:':
    'Invitation gardée pour {email}, mais aucun message n’est parti : trop de messages d’invitation sont partis en peu de temps. Envoyez-lui ce lien :',
  'The invitation is kept, but its message did not leave. Send it again from its row.':
    'L’invitation est gardée, mais son message n’est pas parti. Renvoyez-la depuis sa ligne.',
  'A workspace has a hundred invitations waiting at most. Cancel some first.':
    'Un espace de travail a au plus cent invitations en attente. Annulez-en d’abord.',
  'Only an owner or an admin of the workspace invites.':
    'Seul un propriétaire ou un administrateur de l’espace de travail invite.',
  'The invitation was not sent. Try again.': 'L’invitation n’a pas été envoyée. Réessayez.',
  'That did not go through. Try again.': 'Cela n’a pas abouti. Réessayez.',
  'The last owner of a workspace stays in it.': 'Le dernier propriétaire d’un espace de travail y reste.',
  'Only an owner removes an owner.': 'Seul un propriétaire retire un propriétaire.',
  'Only an owner or an admin of the workspace changes its members.':
    'Seul un propriétaire ou un administrateur de l’espace de travail change ses membres.',

  Invitations: 'Invitations',
  'This invitation was cancelled, or it ended. Ask for another one.':
    'Cette invitation a été annulée, ou elle a pris fin. Demandez-en une autre.',
  'The invitation could not be answered. Try again.': 'L’invitation n’a pas pu recevoir de réponse. Réessayez.',
  'Sign in with the address the invitation was sent to, and it shows here.':
    'Connectez-vous avec l’adresse à laquelle l’invitation a été envoyée, et elle s’affiche ici.',
  'Fruitback did not answer. Your invitations are not lost.':
    'Fruitback n’a pas répondu. Vos invitations ne sont pas perdues.',
  'No invitation waits for {email}. An invitation sent to another address shows to that address only.':
    'Aucune invitation n’attend {email}. Une invitation envoyée à une autre adresse ne s’affiche qu’à cette adresse.',
  'Go to the console': 'Aller à la console',
  Decline: 'Refuser',
  'Joining…': 'Arrivée…',
  'Join {workspace}': 'Rejoindre {workspace}',
  Person: 'Personne',
  Role: 'Rôle',
  Sites: 'Sites',
  'Every site': 'Tous les sites',
  'Sites, connectors and members.': 'Sites, connecteurs et membres.',
  'Every site. Sees the links to the tracker.': 'Tous les sites. Voit les liens vers le tracker.',
  'Only the sites shared with them. Free, and never sees the tracker.':
    'Seulement les sites partagés avec lui. Gratuit, et ne voit jamais le tracker.',

  Workspace: 'Workspace',
  Install: 'Installer',
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
  'The access was declined. Try again, or use an email link.':
    "L'accès a été refusé. Réessayez, ou utilisez un lien par e-mail.",
  'The sign-in started in another browser, or too long ago. Start it again from here.':
    'La connexion a commencé dans un autre navigateur, ou il y a trop longtemps. Recommencez-la depuis cette page.',
  'The provider has no verified address for this account. Verify it there, or use an email link.':
    "Le fournisseur n'a pas d'adresse vérifiée pour ce compte. Vérifiez-la chez lui, ou utilisez un lien par e-mail.",
  'The provider gave no address for this account. Use an email link.':
    "Le fournisseur n'a donné aucune adresse pour ce compte. Utilisez un lien par e-mail.",
  'This way to sign in is not set up on this Fruitback. Use an email link.':
    "Cette façon de se connecter n'est pas configurée sur ce Fruitback. Utilisez un lien par e-mail.",
  'The sign-in did not finish. Try again, or use an email link.':
    "La connexion n'a pas abouti. Réessayez, ou utilisez un lien par e-mail.",
  'The link could not be sent just now. Try again in a minute.':
    'Le lien n’a pas pu être envoyé. Réessayez dans une minute.',
  'Sending…': 'Envoi…',
  Continue: 'Continuer',
  'Continue with Google': 'Continuer avec Google',
  'Continue with GitHub': 'Continuer avec GitHub',
  'Work email': 'E-mail professionnel',
  'Workspace name': 'Nom du workspace',
  'Check your inbox': 'Regardez votre boîte de réception',
  'Use another address': 'Utiliser une autre adresse',
  'A workspace needs a name of one line, up to 80 characters.':
    'Un workspace a besoin d’un nom d’une ligne, de 80 caractères au plus.',
  'Paste the full address of the site, starting with https://.':
    'Collez l’adresse complète du site, en commençant par https://.',
  'Site address': 'Adresse du site',
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
  'Signing you in…': 'Connexion en cours…',

  'Fruitback did not answer. The sources and their sites could not be read.':
    'Fruitback n’a pas répondu. Les sources et leurs sites n’ont pas pu être lus.',
  Close: 'Fermer',
  Remove: 'Retirer',
  'Only an owner or an admin of the workspace adds a site.':
    'Seul un propriétaire ou un administrateur du workspace ajoute un site.',
  'The site was not added. Try again.': 'Le site n’a pas été ajouté. Réessayez.',
  'The workspace was not created. Try again.': 'Le workspace n’a pas été créé. Réessayez.',
  'Only an owner or an admin of the workspace removes a site.':
    'Seul un propriétaire ou un administrateur du workspace retire un site.',
  'This site is still here. Try again.': 'Ce site est toujours là. Réessayez.',
  'This browser was not connected. Try again.': 'Ce navigateur n’a pas été connecté. Réessayez.',
  'The browser refused the copy. Select the script above and copy it by hand.':
    'Le navigateur a refusé la copie. Sélectionnez le script ci-dessus et copiez-le à la main.',
  'The browser refused the copy. Select the secret above and copy it by hand.':
    'Le navigateur a refusé la copie. Sélectionnez le secret ci-dessus et copiez-le à la main.',
  'Only the owner of the workspace deletes it.': 'Seul le propriétaire du workspace le supprime.',
  'The workspace was not deleted. Try again.': 'Le workspace n’a pas été supprimé. Réessayez.',
  'Remove {site}': 'Retirer {site}',
  'Where {workspace} collects notes, and where they stand.':
    'Là où {workspace} recueille des notes, et où elles en sont.',
  'Add a site': 'Ajouter un site',
  'The sites did not load': 'Les sites ne se sont pas chargés',
  'Fruitback did not answer. Your sites and notes are safe.':
    'Fruitback n’a pas répondu. Vos sites et vos notes sont en sécurité.',
  'No site yet': 'Aucun site pour l’instant',
  "Paste the address of a site you review. Staging, a preview build or a client's live site: any page of it will do.":
    'Collez l’adresse d’un site que vous relisez. Un staging, une preview ou le site en ligne d’un client : n’importe laquelle de ses pages convient.',
  'An owner or an admin of {workspace} adds its first site.':
    'Un propriétaire ou un admin de {workspace} ajoute son premier site.',
  'Notes go to': 'Les notes vont vers',
  Actions: 'Actions',
  'A site with no tracker keeps its notes in Fruitback.': 'Un site sans tracker garde ses notes dans Fruitback.',
  'Connect a tracker': 'Connecter un tracker',
  'Add site': 'Ajouter le site',
  'Who sees the notes?': 'Qui voit les notes ?',
  'Members of {workspace}': 'Les membres de {workspace}',
  "Visitors of the site see nothing. Right for staging and for a client's site.":
    'Les visiteurs du site ne voient rien. Convient à un staging et au site d’un client.',
  'Everyone who visits': 'Tous les visiteurs',
  'A public way to report a problem on a live site.': 'Un moyen public de signaler un problème sur un site en ligne.',
  'A tracker': 'Un tracker',
  'Team {team}': 'Équipe {team}',
  'Kept in Fruitback': 'Gardées dans Fruitback',
  'No tracker yet': 'Pas encore de tracker',
  '{place} and {count} more': '{place} et {count} de plus',
  'Preview builds': 'Previews',
  'More for {site}': 'Plus pour {site}',
  'Install on {site}': 'Installer sur {site}',
  'The widget stops on {site}, and the script pasted there no longer works: adding the site again gives it a new script. The notes already in a tracker stay there.':
    'Le widget s’arrête sur {site}, et le script collé là ne marche plus : ajouter le site à nouveau lui donne un nouveau script. Les notes déjà dans un tracker y restent.',
  'Disconnect {source}': 'Déconnecter {source}',
  'Connect a tracker once. Every site of {workspace} can then send its notes there.':
    'Connectez un tracker une fois. Chaque site de {workspace} peut alors y envoyer ses notes.',
  'No tracker yet. The notes stay in Fruitback.': 'Pas encore de tracker. Les notes restent dans Fruitback.',
  '1 note did not arrive': '1 note n’est pas arrivée',
  '{count} notes did not arrive': '{count} notes ne sont pas arrivées',
  'An issue in a Jira Cloud project.': 'Une issue dans un projet Jira Cloud.',
  'An issue in a project, cloud or self-managed.': 'Une issue dans un projet, cloud ou auto-hébergé.',
  'A card in the list you choose.': 'Une carte dans la liste que vous choisissez.',
  'A row in a database.': 'Une ligne dans une base de données.',
  'Tells Slack or any address when a note arrives.':
    'Prévient Slack ou n’importe quelle adresse quand une note arrive.',
  'Linear was not connected. Start again from « Connect ».':
    'Linear n’a pas été connecté. Recommencez depuis « Connecter ».',
  'Sites sending here': 'Sites qui envoient ici',
  'No site sends its notes here yet.': 'Aucun site n’envoie encore ses notes ici.',
  'Other sites': 'Autres sites',
  'Which Linear state gives each pin its status.': 'Quel état Linear donne son statut à chaque pin.',
  'Status for {state}': 'Statut pour {state}',
  'Fruitback could not read the states of Linear. The statuses you set are not lost.':
    'Fruitback n’a pas pu lire les états de Linear. Les statuts que vous avez réglés ne sont pas perdus.',
  'Its sites keep their notes in the workspace again. The issues already in Linear stay there.':
    'Ses sites gardent de nouveau leurs notes dans le workspace. Les issues déjà dans Linear y restent.',
  'Cloud workspace': 'Workspace Cloud',
  Notes: 'Notes',
  'Help and docs': 'Aide et documentation',

  New: 'Nouveau',
  'To do': 'À faire',
  'In progress': 'En cours',
  Done: 'Terminé',
  Closed: 'Fermé',
  'This setting did not change. Try again.': 'Ce réglage n’a pas changé. Réessayez.',
  'Status of the pins': 'État des pins',
  'The states appear here once a site sends its notes to a team.':
    'Les états apparaissent ici dès qu’un site envoie ses notes à une équipe.',
  'Show Linear comments as replies': 'Montrer les commentaires de Linear comme réponses',
  'The destinations of this site did not change. Try again.':
    'Les destinations de ce site n’ont pas changé. Réessayez.',
  'Its notes stay in Fruitback, in this workspace.': 'Ses notes restent dans Fruitback, dans ce workspace.',
  Default: 'Par défaut',
  'Make it the default': 'Mettre par défaut',
  'Add a destination for {site}': 'Ajouter une destination pour {site}',
  'Add a destination…': 'Ajouter une destination…',
  'A site sends to {count} places at most.': 'Un site envoie vers {count} destinations au plus.',
  'A note goes to the default place. With two places or more, a member chooses one in the widget when they write.':
    'Une note va vers la destination par défaut. À partir de deux destinations, un membre en choisit une dans le widget quand il écrit.',
  // The domains a workspace proves, for its previews (FRU-103).
  'This is not a domain. Type the name alone, like preview.acme.dev.':
    'Ce n’est pas un domaine. Tapez le nom seul, comme preview.acme.dev.',
  'A workspace holds 20 domains at most. Remove one first.':
    'Un workspace garde 20 domaines au plus. Retirez-en un d’abord.',
  'Only an owner or an admin of the workspace proves a domain.':
    'Seul un propriétaire ou un admin du workspace prouve un domaine.',
  'This domain is not proven, so it covers no preview yet.':
    'Ce domaine n’est pas prouvé : il ne couvre encore aucune preview.',
  'This domain was not added. Try again.': 'Ce domaine n’a pas été ajouté. Réessayez.',
  'This did not change. Try again.': 'Rien n’a changé. Réessayez.',
  'Preview deploys': 'Previews',
  'Each preview has an address of its own. Prove that a domain is yours, and every address under it counts as a preview of the site you choose.':
    'Chaque preview a sa propre adresse. Prouvez qu’un domaine est à vous, et chaque adresse sous ce domaine compte comme une preview du site que vous choisissez.',
  Domain: 'Domaine',
  'Add the domain': 'Ajouter le domaine',
  'Fruitback did not answer. Your domains are not lost.': 'Fruitback n’a pas répondu. Vos domaines ne sont pas perdus.',
  'No domain yet. A site covers its own address only.':
    'Aucun domaine pour l’instant. Un site ne couvre que sa propre adresse.',
  'The DNS did not confirm this domain for three days. Its previews are not covered until it does.':
    'Le DNS n’a pas confirmé ce domaine depuis trois jours. Ses previews ne sont plus couvertes tant qu’il ne le fait pas.',
  'The record is gone from the DNS since {when}. The previews of this domain are not covered until it is back.':
    'L’enregistrement a disparu du DNS depuis {when}. Les previews de ce domaine ne sont plus couvertes tant qu’il n’est pas revenu.',
  'Add this TXT record to the DNS of the domain, then check.':
    'Ajoutez cet enregistrement TXT au DNS du domaine, puis vérifiez.',
  Name: 'Nom',
  Value: 'Valeur',
  'Copy the value': 'Copier la valeur',
  'The browser refused the copy. Select the value above and copy it by hand.':
    'Le navigateur a refusé la copie. Sélectionnez la valeur ci-dessus et copiez-la à la main.',
  'Site whose previews are {pattern}': 'Site dont les previews sont {pattern}',
  'No site': 'Aucun site',
  'The DNS did not answer just now. Nothing changed: check again in a minute.':
    'Le DNS n’a pas répondu à l’instant. Rien n’a changé : vérifiez à nouveau dans une minute.',
  'Check the DNS': 'Vérifier le DNS',
  'The previews under {domain} are not covered any more. The record can stay in the DNS: adding the domain again proves it at once.':
    'Les previews sous {domain} ne sont plus couvertes. L’enregistrement peut rester dans le DNS : ajouter le domaine à nouveau le prouve aussitôt.',
  Proven: 'Prouvé',
  'Proof lost': 'Preuve perdue',
  'Not proven yet': 'Pas encore prouvé',
  // The sign-in page, and the tab that goes on by itself (FRU-235).
  'Sign in to Fruitback': 'Connectez-vous à Fruitback',
  'We email you a link that signs you in on this browser.':
    'Nous vous envoyons par e-mail un lien qui vous connecte dans ce navigateur.',
  'Email me a link': 'Recevoir un lien par e-mail',
  or: 'ou',
  'New to Fruitback?': 'Nouveau sur Fruitback ?',
  'Set up a workspace': 'Créer un workspace',
  'A sign-in link is on its way to {email}.': 'Un lien de connexion est en route vers {email}.',
  'Open it in this browser and this tab signs in by itself. The link works once, for fifteen minutes.':
    'Ouvrez-le dans ce navigateur, et cet onglet se connecte tout seul. Le lien fonctionne une fois, pendant quinze minutes.',
  'Send again in {time}': 'Renvoyer dans {time}',
  'Send again': 'Renvoyer',
  'You are signed in': 'Vous êtes connecté',
  'Your other Fruitback tab has carried on without you. You can close this one.':
    'Votre autre onglet Fruitback a continué sans vous. Vous pouvez fermer celui-ci.',
  'Continue in this tab': 'Continuer dans cet onglet',
  'A link works once, for fifteen minutes. This one was already used or ran out of time.':
    'Un lien fonctionne une fois, pendant quinze minutes. Celui-ci a déjà servi, ou son délai est passé.',
  'Send me a new link': 'M’envoyer un nouveau lien',
  // The setup on one screen (FRU-239).
  'Set up Fruitback': 'Mettre en place Fruitback',
  'Current step:': 'Étape en cours :',
  'Running your own server?': 'Vous hébergez votre propre serveur ?',
  'Self-hosting guide': 'Guide d’auto-hébergement',
  'Three steps to your first note on a live page. Hosted in Europe.':
    'Trois étapes jusqu’à votre première note sur une page en ligne. Hébergé en Europe.',
  'Your account': 'Votre compte',
  'Your site': 'Votre site',
  'The address you review.': 'L’adresse que vous relisez.',
  'Put it on the site': 'Le mettre sur le site',
  'The extension, or a script tag.': 'L’extension, ou une balise de script.',
  'Preview of your site': 'Aperçu de votre site',
  'your site': 'votre site',
  'Your site shows here once you add it, with its pins.': 'Votre site s’affiche ici une fois ajouté, avec ses pins.',
  'A preview of your site. Pins show the same way on the real page.':
    'Un aperçu de votre site. Les pins s’affichent de la même façon sur la vraie page.',
  'We send you a sign-in link. No password to make up.':
    'Nous vous envoyons un lien de connexion. Aucun mot de passe à inventer.',
  'Your workspace takes the name of your domain. Rename it whenever you like.':
    'Votre workspace prend le nom de votre domaine. Renommez-le quand vous voulez.',
  'A sign-in link is on its way to {email}. Open it in this browser: this page carries on by itself.':
    'Un lien de connexion est en route vers {email}. Ouvrez-le dans ce navigateur : cette page continue toute seule.',
  'The link works once, for fifteen minutes. Nothing in it asks for a password.':
    'Le lien fonctionne une fois, pendant quinze minutes. Rien n’y demande un mot de passe.',
  'Signed in as {email}': 'Connecté en tant que {email}',
  'The workspace was not renamed. Try again.': 'Le workspace n’a pas été renommé. Réessayez.',
  'Only an owner or an admin of the workspace renames it.': 'Seul un propriétaire ou un admin du workspace le renomme.',
  Save: 'Enregistrer',
  Rename: 'Renommer',
  'Any page of it will do.': 'N’importe laquelle de ses pages convient.',
  'Members of {workspace} see the notes': 'Les membres de {workspace} voient les notes',
  'Everyone who visits sees the notes': 'Tous les visiteurs voient les notes',
  'Fruitback did not answer. Your sites are not lost.': 'Fruitback n’a pas répondu. Vos sites ne sont pas perdus.',
  Site: 'Site',
  Change: 'Modifier',
  '{site} is still in your sites, with its notes. Remove it in Sites if you no longer review it.':
    '{site} est toujours dans vos sites, avec ses notes. Retirez-le dans Sites si vous ne le relisez plus.',
  // The screen of an invitation (FRU-241).
  '{workspace} invited you': '{workspace} vous a invité',
  'Join {workspace} on Fruitback': 'Rejoignez {workspace} sur Fruitback',
  'You join as an admin: you manage the sites, the connectors and the members of {workspace}.':
    'Vous rejoignez en tant qu’admin : vous gérez les sites, les connecteurs et les membres de {workspace}.',
  'You join as a member: you see and leave notes on every site of {workspace}.':
    'Vous rejoignez en tant que membre : vous voyez et laissez des notes sur tous les sites de {workspace}.',
  'Signed in as': 'Connecté en tant que',
  'Not {email}?': 'Vous n’êtes pas {email} ?',
  'One more invitation': 'Une autre invitation',
  '{count} more invitations': '{count} autres invitations',
  'You are in': 'Vous y êtes',
  'One more thing: the extension shows the notes on the sites of {workspace} and lets you leave yours.':
    'Une dernière chose : l’extension affiche les notes sur les sites de {workspace} et vous permet de laisser les vôtres.',
  'One more thing: the extension shows the notes on {site} and lets you leave yours.':
    'Une dernière chose : l’extension affiche les notes sur {site} et vous permet de laisser les vôtres.',
  'Add to Chrome': 'Ajouter à Chrome',
  'Open {site}': 'Ouvrir {site}',
  'Using Firefox?': 'Vous utilisez Firefox ?',
  'Get the Firefox add-on': 'Obtenir le module pour Firefox',
  // The last step of the setup, and the example page of its preview (FRU-242).
  'An example page. Pins show the same way on your site.':
    'Une page d’exemple. Les pins s’affichent de la même façon sur votre site.',
  'Leave feedback': 'Laisser un feedback',
  'Click Leave feedback, then any part of the page.':
    'Cliquez sur Laisser un feedback, puis sur n’importe quelle partie de la page.',
  'Use one, or both.': 'Utilisez l’un, ou les deux.',
  'Browser extension': 'Extension de navigateur',
  "Nothing to deploy. Right for a client's site you cannot touch.":
    'Rien à déployer. Convient au site d’un client auquel vous ne pouvez pas toucher.',
  'Add it, then connect this browser: a page opens, and you click the Fruitback icon there.':
    'Ajoutez-la, puis connectez ce navigateur : une page s’ouvre, et vous y cliquez sur l’icône Fruitback.',
  'Script tag': 'Balise de script',
  'Before the closing body tag. Members see their pins on every visit.':
    'Avant la balise body fermante. Les membres voient leurs pins à chaque visite.',
  'Before the closing body tag. Every visitor sees the pins.':
    'Avant la balise body fermante. Chaque visiteur voit les pins.',
  'Copy script': 'Copier le script',
  'Open the site, click Leave feedback, then any part of the page.':
    'Ouvrez le site, cliquez sur Laisser un feedback, puis sur n’importe quelle partie de la page.',
  'Open the console': 'Ouvrir la console',
  // The first note of the setup (FRU-242).
  'Waiting for your first note.': 'En attente de votre première note.',
  'Extension on': 'Extension activée',
  'Script on the site': 'Script sur le site',
  'Fruitback on the site': 'Fruitback sur le site',
  'First note received': 'Première note reçue',
  'First note received just now': 'Première note reçue à l’instant',
  'First note received {when}': 'Première note reçue {when}',
  'Your first note is in': 'Votre première note est arrivée',
  'It waits in the {workspace} workspace. Send your notes to Linear or your own API whenever you like.':
    'Elle vous attend dans le workspace {workspace}. Envoyez vos notes vers Linear ou votre propre API quand vous voulez.',
  '{name} · just now': '{name} · à l’instant',
  // How long ago (ago.ts).
  'Just now': 'À l’instant',
  '{count} min ago': 'il y a {count} min',
  '{count} h ago': 'il y a {count} h',
  Yesterday: 'Hier',
  '{count} days ago': 'il y a {count} jours',
  // Sites, second time (FRU-270).
  'On the page with': 'Sur la page avec',
  'Last note': 'Dernière note',
  Statuses: 'Statuts',
  'None yet': 'Aucune pour l’instant',
  'Extension, script': 'Extension, script',
  'Waiting for the first note': 'En attente de la première note',
  '1 not delivered yet': '1 pas encore livrée',
  '{count} not delivered yet': '{count} pas encore livrées',
  '1 note: {new} new, {todo} to do, {progress} in progress, {done} done, {closed} closed':
    '1 note : {new} nouvelle, {todo} à faire, {progress} en cours, {done} terminée, {closed} fermée',
  '{count} notes: {new} new, {todo} to do, {progress} in progress, {done} done, {closed} closed':
    '{count} notes : {new} nouvelles, {todo} à faire, {progress} en cours, {done} terminées, {closed} fermées',
  // Notes (FRU-245).
  'Every note left on the sites of {workspace}, and where it went.':
    'Chaque note laissée sur les sites de {workspace}, et où elle est partie.',
  'Where the notes went': 'Où sont parties les notes',
  All: 'Toutes',
  'In Fruitback': 'Dans Fruitback',
  'A source that was removed': 'Une source retirée',
  'Search notes': 'Chercher dans les notes',
  'Search the text, the page or the reference': 'Chercher le texte, la page ou la référence',
  'Search the text or the page': 'Chercher le texte ou la page',
  Status: 'Statut',
  'Any status': 'Tous les statuts',
  'Only my notes': 'Seulement mes notes',
  Note: 'Note',
  'Left by': 'Laissée par',
  'Went to': 'Partie vers',
  When: 'Quand',
  'Show on the page': 'Voir sur la page',
  You: 'Vous',
  'Former member': 'Ancien membre',
  'Verified by {site}': 'Vérifié par {site}',
  Anonymous: 'Anonyme',
  Visitor: 'Visiteur',
  'Somebody of the workspace': 'Quelqu’un du workspace',
  'Not delivered yet': 'Pas encore livrée',
  'Not delivered: Fruitback stopped trying': 'Non livrée : Fruitback a cessé d’essayer',
  'Delivered to {host}': 'Livrée à {host}',
  'Pages of notes': 'Pages de notes',
  '{from} to {to} of {total}': '{from} à {to} sur {total}',
  Previous: 'Précédentes',
  Next: 'Suivantes',
  'The notes did not load': 'Les notes ne se sont pas chargées',
  'Fruitback did not answer. Your notes are safe.': 'Fruitback n’a pas répondu. Vos notes sont en sécurité.',
  'No note yet. Notes show here as soon as someone leaves one on a site of {workspace}.':
    'Pas encore de note. Les notes s’affichent ici dès que quelqu’un en laisse une sur un site de {workspace}.',
  'No note matches.': 'Aucune note ne correspond.',
  'Clear the filters': 'Effacer les filtres',
  'see where every note went': 'voir où est partie chaque note',
  // Connect this browser (FRU-240).
  'This browser is not connected': 'Ce navigateur n’est pas connecté',
  'The extension stays signed out. To connect it later, open its popup and sign in from there.':
    'L’extension reste déconnectée. Pour la connecter plus tard, ouvrez sa fenêtre et connectez-vous depuis celle-ci.',
  'This request no longer works': 'Cette demande ne fonctionne plus',
  'A request works for fifteen minutes, and is answered once. Open the popup again, and sign in from there.':
    'Une demande fonctionne quinze minutes, et reçoit une seule réponse. Rouvrez la fenêtre de l’extension, et connectez-vous depuis celle-ci.',
  'The Fruitback extension asks to sign in as you. It reads and leaves notes on the sites of your workspaces, and nothing else.':
    'L’extension Fruitback demande à se connecter en votre nom. Elle lit et laisse des notes sur les sites de vos workspaces, et rien d’autre.',
  'Check that the popup shows the same word': 'Vérifiez que la fenêtre de l’extension affiche le même mot',
  Account: 'Compte',
  Browser: 'Navigateur',
  Workspaces: 'Workspaces',
  'No workspace yet': 'Aucun pour l’instant',
  'Connecting…': 'Connexion…',
  'Connect {browser}': 'Connecter {browser}',
  'Not now': 'Pas maintenant',
  'You can disconnect it at any time from My account.': 'Vous pouvez le déconnecter à tout moment depuis Mon compte.',
  '{browser} is connected': '{browser} est connecté',
  'It reads the sites of your workspaces, and you have none yet. Set one up, and the popup finds its site.':
    'Elle lit les sites de vos workspaces, et vous n’en avez encore aucun. Créez-en un, et la fenêtre de l’extension trouvera son site.',
  'Open the popup on any site of {workspaces}. You can close this tab.':
    'Ouvrez la fenêtre de l’extension sur n’importe quel site de {workspaces}. Vous pouvez fermer cet onglet.',
  'Sign in to connect this browser': 'Connectez-vous pour connecter ce navigateur',
  'The Fruitback extension is waiting. Sign in, then check the word and connect it.':
    'L’extension Fruitback attend. Connectez-vous, puis vérifiez le mot et connectez-la.',
  'The Fruitback extension in {browser} is waiting. Sign in, then check the word and connect it.':
    'L’extension Fruitback de {browser} attend. Connectez-vous, puis vérifiez le mot et connectez-la.',
  'Open it in this browser: this page comes back to the word to check. The link works once, for fifteen minutes.':
    'Ouvrez-le dans ce navigateur : cette page revient au mot à vérifier. Le lien fonctionne une fois, pendant quinze minutes.',
  // Members, « Last seen » (FRU-247, FRU-249).
  'Last seen': 'Vu pour la dernière fois',
  Today: 'Aujourd’hui',
  'Not seen yet': 'Pas encore vu',
  // My account, FRU-249.
  Linked: 'Lié',
  'Not linked': 'Non lié',
  'That account has another address than yours. Fruitback links only the address of your account.':
    'Ce compte a une autre adresse que la vôtre. Fruitback ne lie que l’adresse de votre compte.',
  'That account already opens another Fruitback account.': 'Ce compte ouvre déjà un autre compte Fruitback.',
  'The provider did not say that this address is verified. Verify it there, then link again.':
    'Le fournisseur n’a pas dit que cette adresse est vérifiée. Vérifiez-la chez lui, puis liez à nouveau.',
  'Your session ended before the link. Sign in, then link again.':
    'Votre session s’est terminée avant le lien. Connectez-vous, puis liez à nouveau.',
  'The account was not linked. Try again.': 'Le compte n’a pas été lié. Réessayez.',
  'This is the last way you sign in here: link another one first.':
    'C’est votre dernière façon de vous connecter ici : liez-en une autre d’abord.',
  'Sign in again first: a way to sign in changes only in the day after a sign-in.':
    'Reconnectez-vous d’abord : une façon de se connecter ne change que dans la journée qui suit une connexion.',
  '{provider} is still linked. Try again.': '{provider} est toujours lié. Réessayez.',
  'A name is one line of 1 to 80 characters.': 'Un nom tient sur une ligne, de 1 à 80 caractères.',
  'Your name was not changed. Try again.': 'Votre nom n’a pas été changé. Réessayez.',
  '{provider} is linked to your account.': '{provider} est lié à votre compte.',
  'Not sent by this Fruitback': 'Pas envoyé par ce Fruitback',
  Unlink: 'Délier',
  'Unlink {provider}': 'Délier {provider}',
  'You no longer sign in with {provider}. Your account and its notes stay.':
    'Vous ne vous connectez plus avec {provider}. Votre compte et ses notes restent.',
  'Link {provider}': 'Lier {provider}',
  'Console · {browser}': 'Console · {browser}',
  // My account, the browsers of the extension (FRU-249).
  'Extension · {browser}': 'Extension · {browser}',
  'Connected {day} · used {last}': 'Connectée le {day} · utilisée {last}',
  'Disconnect the extension in {browser}': 'Déconnecter l’extension dans {browser}',
  'It stops showing notes at once. It connects again from its popup, with your approval here.':
    'Elle cesse d’afficher les notes tout de suite. Elle se reconnecte depuis son popup, avec votre accord ici.',
  'Fruitback did not answer. The browsers of the extension could not be read.':
    'Fruitback n’a pas répondu. Les navigateurs de l’extension n’ont pas pu être lus.',
  'This extension is still connected: Fruitback did not end its session. Try again.':
    'Cette extension est toujours connectée : Fruitback n’a pas mis fin à sa session. Réessayez.',
  // The guest of one site (FRU-250).
  'Guest, one site': 'Invité, un site',
  'This site is no longer one of the workspace. Choose another one.':
    'Ce site ne fait plus partie de l’espace. Choisissez-en un autre.',
  'Review {site} with {workspace}': 'Relisez {site} avec {workspace}',
  'You join as a guest: you see and leave notes on this site only. Guests are free and never see the tracker.':
    'Vous rejoignez en tant qu’invité : vous voyez et laissez des notes sur ce site seulement. Les invités sont gratuits et ne voient jamais le tracker.',
};
