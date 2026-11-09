# Asana (français)

Un espace de travail peut envoyer les notes de ses sites vers Asana. Chaque note devient une tâche
dans le projet choisi pour le site, avec les fichiers de la note en pièces jointes. Quand la tâche est
terminée dans Asana, ou change de section, son repère sur la page prend l’étape de cet état.

[Read in English](asana.md)

## Comment il se connecte

Asana offre deux façons, et Fruitback prend les deux :

- par un consentement chez Asana (OAuth), quand l’opérateur du serveur a créé une app Asana. Asana la
  recommande pour une app qui agit pour d’autres personnes. Le jeton dure une heure, et Fruitback le
  renouvelle.
- par un jeton d’accès personnel, sur un serveur sans app Asana. Le jeton agit comme sa personne,
  dans tous ses espaces Asana, jusqu’à sa révocation.

Fruitback garde le jeton chiffré, et aucun écran ne le montre de nouveau. Fruitback n’appelle que
`app.asana.com`.

## Ce que l’opérateur configure une fois

Ce n’est utile que pour le consentement. Sur le Cloud, c’est fait.

1. Ouvrez la [console développeur d’Asana](https://app.asana.com/0/my-apps), et créez une app.
2. Dans « OAuth », ajoutez l’URL de redirection `<FRUITBACK_PUBLIC_URL>/auth/asana/callback`, et
   choisissez « Full permissions » : Fruitback ne demande aucune portée à part.
3. Copiez l’identifiant et le secret, puis réglez `FRUITBACK_ASANA_OAUTH=<client id>:<secret>` sur le
   serveur.

Le serveur refuse de démarrer avec une valeur qui n’a pas deux parties, ou sans
`FRUITBACK_PUBLIC_URL`, `FRUITBACK_DATABASE_URL` et `FRUITBACK_SECRETS_KEY`. Voir
[les variables d’environnement](../self-hosting/environment-variables.md).

## Connecter un espace de travail

1. Dans la console, ouvrez « Connecteurs », puis « Nouveau connecteur ».
2. Sur la carte « Asana », appuyez sur « Connecter ».
   - Avec une app Asana sur le serveur, Asana demande votre consentement. « Utiliser un jeton » est
     l’autre façon.
   - Sans app, collez un jeton d’accès personnel, créé dans la
     [console développeur](https://app.asana.com/0/my-apps) d’Asana.
3. Le connecteur porte le nom de l’espace Asana : « Asana · Acme ».
4. Dans l’écran « Sites », ouvrez un site, puis « Ajouter une destination », et choisissez un projet.

## Ce que devient une note

| Dans la note                            | Dans la tâche                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| sa première ligne                       | le nom                                                                        |
| son texte, la page, l’élément, l’auteur | les notes (la description)                                                    |
| la note elle-même                       | un bloc de code JSON à la fin des notes, que Fruitback relit                  |
| ses fichiers                            | les pièces jointes de la tâche                                                |
| son projet, son site et sa page         | l’étiquette `fruitback-page-<empreinte>`, créée dans l’espace Asana du projet |

Gardez le bloc de code et l’étiquette. Un repère est trouvé par l’étiquette de son projet, de son site et de sa page,
et dessiné d’après le bloc de code. Une tâche qui les perd n’est plus montrée sur la page. Une page
montre au plus les repères de 1 000 de ses notes dans Asana : Asana ne dit pas dans quel ordre il liste
les tâches d’une étiquette, donc au-delà de 1 000 notes sur une page, celles qui s’affichent ne sont
pas choisies.

## L’étape d’un repère

| La tâche dans Asana            | L’étape du repère                                  |
| ------------------------------ | -------------------------------------------------- |
| terminée                       | Terminé                                            |
| dans une section, non terminée | Nouveau, ou l’étape que le site donne à la section |

Asana ne dit rien du sens d’une section : chaque section vaut Nouveau tant qu’un site ne lui donne pas
d’étape, sur la page des statuts du site. « Doing » peut valoir En cours, par exemple. Les commentaires
de l’équipe dans Asana reviennent sous la note, quand le site montre les réponses.

## Quand le connecteur demande une action

La console affiche « Action requise » sur le connecteur, et les notes de ses sites attendent dans le
widget :

- Asana refuse le jeton : l’app a été retirée, ou le jeton d’accès personnel a été révoqué.
  Déconnectez-le, puis connectez Asana de nouveau.
- Asana refuse un projet : la personne qui a connecté n’y a plus accès, ou il a été supprimé. Rendez
  l’accès dans Asana, ou choisissez un autre projet pour le site.
- La connexion a pris fin : Asana a refusé de la renouveler. Connectez Asana de nouveau.

Un Asana lent ou en panne n’est pas un refus : la note attend dans le widget, et part dès qu’Asana
répond.

## Déconnecter

« Déconnecter » dans le panneau du connecteur le retire de l’espace de travail, et ses sites gardent
de nouveau leurs notes dans Fruitback. Une connexion faite par consentement est révoquée chez Asana au
même moment. Les tâches déjà dans Asana y restent. Un jeton d’accès personnel reste valable jusqu’à ce
que vous le révoquiez dans la console développeur.
