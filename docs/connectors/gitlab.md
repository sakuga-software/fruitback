# GitLab connector

Connect a GitLab project once, and every site of the workspace can send its notes there. Each note
becomes an issue of the project, with its files, and the pin on the page takes the state of the
issue. It works with gitlab.com and with a GitLab that your team hosts.

[Lire en français](gitlab.fr.md)

## What you need

- A project on gitlab.com, or on a self-managed GitLab that the internet can reach over https.
- An access token of that project with the `api` scope and the Reporter role or higher.
- The role of owner or admin of the workspace in Fruitback.

Why Reporter. GitLab drops the labels that a Guest sets on an issue. Fruitback reads the notes of
a page by their labels, so an issue without them would never come back as a pin. The list of
projects in Fruitback shows only the projects where the token is Reporter or more.

## 1. Create the token

A project access token is the best choice: it reaches one project, and nothing else of your
account. In GitLab, open the project, then « Settings », « Access tokens », « Add new token »:

| Field           | Value                                          |
| --------------- | ---------------------------------------------- |
| Token name      | `Fruitback`                                    |
| Expiration date | The date your team renews its tokens           |
| Role            | `Reporter`                                     |
| Scopes          | `api` (it writes issues and uploads the files) |

Copy the token. GitLab shows it once.

A group access token works the same way for every project of a group. A personal access token works
too, but it acts as you, in every project you can reach: prefer a token of the project.

On a GitLab where project access tokens are turned off, use a personal access token of a bot account
that is a Reporter of the project.

## 2. Connect it in Fruitback

1. Open « Connectors », then « New connector », then « Connect GitLab ».
2. GitLab address: leave it empty for gitlab.com. For a self-managed GitLab, give its address,
   for example `https://gitlab.acme.dev`, or `https://acme.dev/gitlab` when it lives under a path.
3. Access token: paste the token, then « Connect ».

Fruitback asks GitLab who the token is before it keeps anything. A token that GitLab refuses is not
kept. The token is encrypted with the key of the server (`FRUITBACK_SECRETS_KEY`), and no screen
shows it again.

## 3. Choose the project of a site

On « Sites », open a site, then its destination, and choose a project of the GitLab connector. The
list shows the projects where the token is Reporter or more. A search finds a project past the
first page.

## What goes to GitLab

- The issue: its title is the start of the note, and its description holds the note, the page,
  the element and its CSS selector, the component and the source file when the site exposes them.
- The labels `fruitback` and `fruitback:<site>`. GitLab creates them in the project the first time.
  Do not remove them: Fruitback finds the notes of a page by them.
- The files: the capture and the other files of the note are uploaded to the project, and listed
  under « Files » at the end of the description.

## The state of the pin

GitLab has two states. An open issue is « New » on the pin, and a closed one is « Done ». To show a
closed issue as « Closed » instead, change its stage in the statuses of the site. The replies to the
issue come back to the thread of the pin, without the lines that GitLab writes itself (a label
added, a state changed).

## When the connector needs attention

The « Connectors » screen marks the connector « Needs attention » and says why:

| What it says                       | What to do                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GitLab refuses the token           | The token expired or was revoked. Create a new token, disconnect the connector, and connect GitLab again with it. |
| GitLab refuses a project of a site | The token lost the project, or its role is under Reporter. Give it the role again, or choose another project.     |

A GitLab that is down or that limits the rate is not a refusal: the widget keeps the note and sends
it again, and nothing needs to be done.

## A self-managed GitLab

- The address must be https, and it must resolve to a public address. An address on a private
  network (`10.0.0.0/8`, `192.168.0.0/16`, a mesh network, the loopback) is refused, when the
  connector is made and at each call, on the Cloud and on a server you run yourself: a workspace
  must not make the server read a service of its own network.
- So a GitLab that only a VPN or your internal network reaches cannot be connected yet.
