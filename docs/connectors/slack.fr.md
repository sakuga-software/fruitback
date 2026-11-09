# Slack

Publiez les notes de vos sites dans un canal Slack. Slack n’est pas un outil de suivi : les notes
restent dans Fruitback, où vivent leurs repères, leurs fils et leurs statuts, et Slack reçoit un
message pour chacune, avec son lien, sa capture et son élément.

[Read in English](slack.md)

## Ce qu’il vous faut

- Un espace de travail Slack où vous pouvez ajouter une app.
- Le rôle de propriétaire ou d’admin de l’espace de travail dans Fruitback.

## 1. Créer un Incoming Webhook

Fruitback publie avec un Incoming Webhook à vous : une adresse qui publie dans un canal.

1. Ouvrez api.slack.com/apps, puis « Create New App », « From scratch ». Nommez-la `Fruitback`, et
   choisissez votre espace de travail Slack.
2. Ouvrez « Incoming Webhooks », et activez-les.
3. Appuyez sur « Add New Webhook », choisissez le canal, et autorisez.
4. Copiez l’URL du webhook. Elle commence par `https://hooks.slack.com/services/`.

L’URL est un secret : qui l’a publie dans votre canal. Slack révoque une URL qu’il trouve dans un
endroit public.

## 2. Le connecter dans Fruitback

1. Ouvrez « Connecteurs », puis « Nouveau connecteur », puis « Connecter Slack ».
2. Collez l’URL du webhook.
3. Choisissez les notes à publier :
   - Les notes vérifiées seulement, par défaut : une note d’un membre de l’espace de travail, ou d’un
     relecteur que le site a identifié.
   - Toutes les notes : sur un site où n’importe qui peut écrire, la note de chaque visiteur part
     aussi dans le canal.
4. Appuyez sur « Connecter ».

Fruitback publie un message dans le canal pour dire qu’il est connecté. Un webhook que Slack refuse
n’est pas gardé. L’URL est chiffrée avec la clé du serveur (`FRUITBACK_SECRETS_KEY`), et aucun écran
ne la montre de nouveau. Pour changer les notes à publier, déconnectez Slack et connectez-le de
nouveau.

## 3. Envoyer là les notes d’un site

Dans « Sites », ouvrez un site, puis sa destination, et choisissez le canal du connecteur Slack.

## Ce que contient un message

- Le nom de la note et sa page, en un lien qui ouvre la note sur sa page.
- Le texte de la note.
- L’élément : son sélecteur CSS, son composant et son fichier source, quand le site les expose.
- La capture, et un lien vers chaque fichier de la note. Ces liens répondent pendant une heure : les
  fichiers restent dans Fruitback, et Slack peut cesser de montrer la capture après cette heure.
- Le nom que la personne a donné, s’il y en a un.

## Quand une note n’arrive pas dans Slack

Le panneau du connecteur liste les notes qui ne sont pas arrivées, et « Essayer maintenant » en
renvoie une. Fruitback réessaie seul tant que Slack est en panne ou limite le débit.

| Ce que dit le panneau                 | Ce qu’il faut faire                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Slack refuse le webhook               | Le webhook ou son app a été supprimé. Créez un nouveau webhook, déconnectez le connecteur, et connectez-le de nouveau. |
| Slack refuse de publier dans le canal | Le canal a été archivé, ou la publication y est interdite. Créez un webhook pour un autre canal.                       |
