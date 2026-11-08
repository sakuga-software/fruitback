# Connecteur GitLab

Connectez une fois un projet GitLab : chaque site de l’espace de travail peut ensuite y envoyer ses
notes. Chaque note devient un ticket du projet, avec ses fichiers, et le repère sur la page prend
l’état du ticket. Le connecteur fonctionne avec gitlab.com et avec un GitLab que votre équipe héberge.

[Read in English](gitlab.md)

## Ce qu’il vous faut

- Un projet sur gitlab.com, ou sur un GitLab auto-hébergé que l’internet atteint en https.
- Un jeton d’accès de ce projet, avec la portée `api` et le rôle **Reporter** ou plus.
- Le rôle de propriétaire ou d’admin de l’espace de travail dans Fruitback.

**Pourquoi Reporter.** GitLab retire les labels qu’un Guest pose sur un ticket. Fruitback lit les
notes d’une page par leurs labels : un ticket sans eux ne reviendrait jamais en repère. La liste des
projets dans Fruitback ne montre que les projets où le jeton est Reporter ou plus.

## 1. Créer le jeton

Un **jeton d’accès de projet** est le meilleur choix : il atteint un seul projet, et rien d’autre de
votre compte. Dans GitLab, ouvrez le projet, puis **Settings**, **Access tokens**, **Add new token** :

| Champ           | Valeur                                                |
| --------------- | ----------------------------------------------------- |
| Token name      | `Fruitback`                                           |
| Expiration date | La date à laquelle votre équipe renouvelle ses jetons |
| Role            | `Reporter`                                            |
| Scopes          | `api` (il écrit les tickets et envoie les fichiers)   |

Copiez le jeton. GitLab ne le montre qu’une fois.

Un jeton d’accès de groupe fonctionne de la même façon pour chaque projet d’un groupe. Un jeton
d’accès personnel fonctionne aussi, mais il agit en votre nom, dans tous les projets que vous
atteignez : préférez un jeton du projet.

Sur un GitLab où les jetons de projet sont désactivés, utilisez le jeton personnel d’un compte de
service qui est Reporter du projet.

## 2. Le connecter dans Fruitback

1. Ouvrez **Connecteurs**, puis **Nouveau connecteur**, puis **Connecter GitLab**.
2. **Adresse de GitLab** : laissez vide pour gitlab.com. Pour un GitLab auto-hébergé, donnez son
   adresse, par exemple `https://gitlab.acme.dev`, ou `https://acme.dev/gitlab` s’il vit sous un
   chemin.
3. **Jeton d’accès** : collez le jeton, puis **Connecter**.

Fruitback demande à GitLab qui est le jeton avant de garder quoi que ce soit. Un jeton que GitLab
refuse n’est pas gardé. Le jeton est chiffré avec la clé du serveur (`FRUITBACK_SECRETS_KEY`), et aucun
écran ne le montre de nouveau.

## 3. Choisir le projet d’un site

Dans **Sites**, ouvrez un site, puis sa destination, et choisissez un projet du connecteur GitLab.
La liste montre les projets où le jeton est Reporter ou plus. Une recherche trouve un projet au-delà
de la première page.

## Ce qui part vers GitLab

- **Le ticket** : son titre est le début de la note, et sa description contient la note, la page,
  l’élément et son sélecteur CSS, le composant et le fichier source quand le site les expose.
- **Les labels** `fruitback` et `fruitback:<site>`. GitLab les crée dans le projet la première fois.
  Ne les retirez pas : Fruitback trouve les notes d’une page grâce à eux.
- **Les fichiers** : la capture et les autres fichiers de la note sont envoyés dans le projet, et
  listés sous **Files** à la fin de la description.

## L’état du repère

GitLab a deux états. Un ticket ouvert est **Nouveau** sur le repère, et un ticket fermé est
**Terminé**. Pour montrer un ticket fermé comme **Fermé**, changez son étape dans les statuts du site.
Les réponses au ticket reviennent dans le fil du repère, sans les lignes que GitLab écrit lui-même
(un label ajouté, un état changé).

## Quand le connecteur demande votre attention

L’écran **Connecteurs** marque le connecteur **Action requise** et dit pourquoi :

| Ce qu’il dit                      | Ce qu’il faut faire                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GitLab refuse le jeton            | Le jeton a expiré ou a été révoqué. Créez un nouveau jeton, déconnectez le connecteur, et connectez GitLab de nouveau. |
| GitLab refuse un projet d’un site | Le jeton a perdu le projet, ou son rôle est sous Reporter. Rendez-lui le rôle, ou choisissez un autre projet.          |

Un GitLab en panne ou qui limite le débit n’est pas un refus : le widget garde la note et la renvoie,
et vous n’avez rien à faire.

## Un GitLab auto-hébergé

- L’adresse doit être en https, et elle doit pointer vers une adresse publique. Une adresse d’un
  réseau privé (`10.0.0.0/8`, `192.168.0.0/16`, un réseau maillé, la boucle locale) est refusée, à la
  création du connecteur et à chaque appel, sur le Cloud comme sur un serveur que vous faites tourner
  vous-même : un espace de travail ne doit pas faire lire au serveur un service de son propre réseau.
- Un GitLab que seuls un VPN ou votre réseau interne atteignent ne peut donc pas encore être connecté.
