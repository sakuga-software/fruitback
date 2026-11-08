# ClickUp (français)

Un espace de travail peut envoyer les notes de ses sites vers ClickUp. Chaque note devient une tâche
dans la liste choisie pour le site, avec les fichiers de la note en pièces jointes. Quand la tâche
change de statut dans ClickUp, son repère sur la page prend l’étape de ce statut.

[Read in English](clickup.md)

## Comment il se connecte

ClickUp offre deux façons, et Fruitback prend les deux :

- par un consentement chez ClickUp (OAuth), quand l’opérateur du serveur a créé une app ClickUp.
  ClickUp la recommande pour une app que d’autres personnes utilisent. La personne qui connecte
  choisit les Workspaces ClickUp atteints.
- par un jeton personnel, sur un serveur sans app ClickUp. ClickUp l’offre pour un usage personnel :
  le jeton agit comme sa personne, dans tous ses Workspaces.

Aucun des deux n’expire : ClickUp dit que son jeton OAuth n’expire pas pour l’instant, et qu’un jeton
personnel n’expire jamais. Fruitback garde le jeton chiffré, et aucun écran ne le montre de nouveau.
Fruitback n’appelle que `api.clickup.com`.

## Ce que l’opérateur configure une fois

Ce n’est utile que pour le consentement. Sur le Cloud, c’est fait.

1. Dans ClickUp, en propriétaire ou admin d’un Workspace, cliquez sur votre avatar, puis
   « Settings », « Apps », et « Create new app ».
2. Donnez-lui un nom, et l’URL de redirection `<FRUITBACK_PUBLIC_URL>/auth/clickup/callback`.
3. Copiez l’identifiant et le secret, puis réglez `FRUITBACK_CLICKUP_OAUTH=<client id>:<secret>` sur
   le serveur.

Le serveur refuse de démarrer avec une valeur qui n’a pas deux parties, ou sans
`FRUITBACK_PUBLIC_URL`, `FRUITBACK_DATABASE_URL` et `FRUITBACK_SECRETS_KEY`. Voir
[les variables d’environnement](../self-hosting/environment-variables.md).

## Connecter un espace de travail

1. Dans la console, ouvrez « Connecteurs », puis « Nouveau connecteur ».
2. Sur la carte « ClickUp », appuyez sur « Connecter ».
   - Avec une app ClickUp sur le serveur, ClickUp demande quels Workspaces atteindre, et votre
     consentement. « Utiliser un jeton » est l’autre façon.
   - Sans app, collez un jeton personnel : dans ClickUp, votre avatar, « Settings », « Apps », puis
     « API Token ». Il commence par `pk_`.
3. Le connecteur porte le nom du Workspace ClickUp : « ClickUp · Acme ».
4. Dans l’écran « Sites », ouvrez un site, puis « Ajouter une destination », et choisissez une
   liste. Une liste est nommée par son espace et son dossier : « Product › Web › Bugs ».

## Ce que devient une note

| Dans la note                            | Dans la tâche                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| sa première ligne                       | le nom                                                                                       |
| son texte, la page, l’élément, l’auteur | la description                                                                               |
| la note elle-même                       | un bloc de code JSON à la fin de la description, que Fruitback relit                         |
| ses fichiers                            | les pièces jointes de la tâche                                                               |
| son site et sa page                     | les étiquettes `fruitback` et `fruitback-page-<empreinte>`, créées dans l’espace de la liste |

Gardez le bloc de code et les étiquettes. Un repère est trouvé par l’étiquette de sa page, et dessiné
d’après le bloc de code. Une tâche qui les perd n’est plus montrée sur la page. Une page montre les
repères de ses 1 000 notes les plus récentes dans ClickUp.

## L’étape d’un repère

| Le type du statut dans ClickUp         | L’étape du repère |
| -------------------------------------- | ----------------- |
| Non commencé (« to do »)               | Nouveau           |
| Actif (« in progress », et les autres) | En cours          |
| Terminé, ou fermé (« complete »)       | Terminé           |

Un site peut donner une autre étape à un statut, sur la page des statuts du site. Les réponses de
l’équipe dans ClickUp reviennent sous la note, quand le site montre les réponses.

## Quand le connecteur demande une action

La console affiche « Action requise » sur le connecteur, et les notes de ses sites attendent dans le
widget :

- ClickUp refuse le jeton : l’app a été retirée du Workspace, ou le jeton personnel a été régénéré.
  Déconnectez-le, puis connectez ClickUp de nouveau.
- ClickUp refuse une liste : la personne qui a connecté n’y a plus accès, ou elle a été supprimée.
  Rendez l’accès dans ClickUp, ou choisissez une autre liste pour le site.

Un ClickUp lent ou en panne n’est pas un refus : la note attend dans le widget, et part dès que
ClickUp répond.

## Déconnecter

« Déconnecter » dans le panneau du connecteur le retire de l’espace de travail, et ses sites gardent
de nouveau leurs notes dans Fruitback. Les tâches déjà dans ClickUp y restent. Pour mettre fin au
jeton tout de suite, retirez l’app dans ClickUp, ou régénérez le jeton personnel.
