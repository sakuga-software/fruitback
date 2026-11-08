# Jira Cloud (français)

Un espace de travail peut envoyer les notes de ses sites vers Jira Cloud. Chaque note devient un
ticket dans le projet choisi pour le site, avec les fichiers de la note en pièces jointes. Quand le
ticket change de statut dans Jira, son repère sur la page prend l’étape de ce statut.

[Read in English](jira.md)

## Comment il se connecte

Jira se connecte par un consentement chez Atlassian : OAuth 2.0 (3LO). Fruitback ne demande jamais
de jeton d’API. La page d’Atlassian sur l’authentification basique dit qu’une app qui collecte des
jetons d’API ne respecte pas ses exigences de sécurité, et un jeton atteint tout ce que sa personne
atteint, sans date de fin.

Avec le consentement :

- la personne qui connecte choisit chez Atlassian les sites Jira que la connexion atteint ;
- la connexion agit avec les droits de cette personne dans Jira, et pas plus ;
- le jeton dure une heure, et Fruitback le renouvelle ; il est gardé chiffré, et aucun écran ne le
  montre ;
- la personne le retire en un seul endroit : son compte Atlassian, « Connected apps ».

Fruitback n’appelle que `api.atlassian.com` et `auth.atlassian.com`.

## Ce que l’opérateur configure une fois

Sur le Cloud, c’est fait. Sur un serveur que vous faites tourner, créez une app chez Atlassian pour
tout le serveur :

1. Ouvrez la [console développeur d’Atlassian](https://developer.atlassian.com/console/myapps/) et
   créez une « OAuth 2.0 integration ».
2. Dans « Permissions », ajoutez l’API Jira avec ces portées : `read:jira-work`, `write:jira-work`
   et `read:jira-user`. Fruitback demande aussi `offline_access`, qui ne se règle pas.
3. Dans « Authorization », mettez l’URL de rappel `<FRUITBACK_PUBLIC_URL>/auth/jira/callback`.
4. Dans « Distribution », activez le partage, pour que les personnes de vos espaces de travail
   puissent consentir. L’app reste hors du Marketplace ; Atlassian affiche un avertissement au
   consentement tant que l’app n’est pas relue.
5. Dans « Settings », copiez l’identifiant et le secret, puis réglez
   `FRUITBACK_JIRA_OAUTH=<client id>:<client secret>` sur le serveur.

Le serveur refuse de démarrer avec une valeur qui n’a pas deux parties, ou sans
`FRUITBACK_PUBLIC_URL`, `FRUITBACK_DATABASE_URL` et `FRUITBACK_SECRETS_KEY`. Voir
[les variables d’environnement](../self-hosting/environment-variables.md).

## Connecter un espace de travail

1. Dans la console, ouvrez « Connecteurs », puis « Nouveau connecteur ».
2. Sur la carte « Jira », appuyez sur « Connecter ». Atlassian demande quel site atteindre, et votre
   consentement.
3. De retour dans la console, le connecteur porte le nom du site : « Jira · acme ».
4. Dans l’écran « Sites », ouvrez un site, puis « Ajouter une destination », et choisissez un projet.

La personne qui connecte a besoin de ces droits dans chaque projet vers lequel un site envoie :
« Browse projects », « Create issues » et « Create attachments ».

## Ce que devient une note

| Dans la note                            | Dans le ticket                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| sa première ligne                       | le résumé                                                                      |
| son texte, la page, l’élément, l’auteur | la description                                                                 |
| la note elle-même                       | un bloc de code JSON à la fin de la description, que Fruitback relit           |
| ses fichiers                            | les pièces jointes du ticket                                                   |
| son site et sa page                     | les étiquettes `fruitback`, `fruitback:<site>` et `fruitback-page-<empreinte>` |

Le type de ticket est « Bug » quand le projet en a un, sinon « Task », sinon le premier type du
projet qui n’est pas une sous-tâche.

Une page montre les repères de ses 1 000 notes les plus récentes dans Jira ; les plus anciennes restent
dans Jira et ne sont pas dessinées.

Gardez le bloc de code et les étiquettes. Un repère est trouvé par l’étiquette de sa page, et dessiné
d’après le bloc de code. Un ticket qui les perd n’est plus montré sur la page.

## L’étape d’un repère

| La catégorie du statut dans Jira                                               | L’étape du repère |
| ------------------------------------------------------------------------------ | ----------------- |
| To Do                                                                          | Nouveau           |
| In Progress                                                                    | En cours          |
| Done                                                                           | Terminé           |
| Done, résolu « Won't Do », « Declined », « Duplicate » ou « Cannot Reproduce » | Fermé             |

Un site peut donner une autre étape à un statut, sur la page des statuts du site.

Les réponses de l’équipe dans Jira reviennent sous la note, quand le site montre les réponses.

## Quand le connecteur demande une action

La console affiche « Action requise » sur le connecteur, et les notes de ses sites attendent dans le
widget :

- Jira refuse la connexion : quelqu’un a retiré l’app de son compte Atlassian. Déconnectez-la, puis
  connectez Jira de nouveau.
- Jira refuse un projet : la personne qui a connecté n’y a plus accès, ou il a été archivé. Rendez
  l’accès dans Jira, ou choisissez un autre projet pour le site.
- La connexion a pris fin : Atlassian a refusé de la renouveler, par exemple après un changement de
  mot de passe, ou après 90 jours sans aucun usage. Connectez Jira de nouveau.

Un Jira lent ou en panne n’est pas un refus : la note attend dans le widget, et part dès que Jira
répond.

## Déconnecter

« Déconnecter » dans le panneau du connecteur le retire de l’espace de travail, et ses sites gardent
de nouveau leurs notes dans Fruitback. Les tickets déjà dans Jira y restent. Atlassian n’offre pas de
route pour révoquer le jeton à votre place : retirez l’app de votre compte Atlassian, « Connected
apps », pour y mettre fin tout de suite.
