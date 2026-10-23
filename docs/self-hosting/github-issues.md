# GitHub Issues as a store

Each note becomes an issue in one repository, labelled `fruitback`, and also `fruitback:<client>` when
the note names a client. The seed is in a fenced block at the end of the body. GitHub compares label
names without case and limits them to 50 characters, so a client ID with a capital letter, a comma or
another character outside `a-z`, `0-9`, `.`, `_` and `-`, or a long one, gets `fruitback:` and a hash of
the ID instead. The worker signs in as a GitHub App, never with a
personal token. A personal token does not expire and reaches every repository of its owner. The token
the worker mints expires after one hour and reaches one repository.

What you give up: GitHub has two issue states, so a pin has three stages instead of five, and the
settings panel offers only these three.

| The issue                                                      | The stage of the pin      |
| -------------------------------------------------------------- | ------------------------- |
| open, reopened included                                        | `new`, shown as New       |
| closed as completed, or closed before GitHub recorded a reason | `done`, shown as Done     |
| closed as not planned, or as a duplicate                       | `closed`, shown as Closed |

**On a public repository, every note is public**, with the name and the address of the reporter when
they typed one. See [SECURITY.md](../../SECURITY.md).

## Create the App

1. In the settings of the account or organisation that owns the repository, open **Developer
   settings → GitHub Apps → New GitHub App**.
2. Give it a name and a homepage URL. Clear **Webhook → Active**: the worker does not receive events.
3. Under **Repository permissions**, set **Issues** to **Read and write**, and leave every other
   permission at **No access**. GitHub adds **Metadata: Read-only** itself.
4. Create the App and note its **App ID**. Under **Private keys**, click **Generate a private key**.
   GitHub downloads a `.pem` file.
5. Click **Install App**, choose the account, then **Only select repositories**, and select the
   repository that receives the notes.

**Issues** is the only permission the worker uses: it creates issues and their two labels, lists
issues, and lists the comments of an issue. The App JWT finds the installation and mints the token.

## Configure the worker

In `.env`, the key can keep its line breaks inside double quotes:

```dotenv
FRUITBACK_STORE=github
FRUITBACK_GITHUB_APP_ID=123456
FRUITBACK_GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA…
-----END RSA PRIVATE KEY-----"
FRUITBACK_GITHUB_REPOSITORY=acme/staging-site
```

Or it can be on one line, with each line break written as `\n`. This command prints that line from the
downloaded file:

```bash
awk 'NF { printf "%s\\n", $0 }' fruitback.private-key.pem
```

With `docker run`, pass the file's content: `-e FRUITBACK_GITHUB_PRIVATE_KEY="$(cat fruitback.private-key.pem)"`.

The worker finds the installation from the repository, so a repository in another organisation needs
no other variable. GitHub installs a private App only on the account that owns it, so for another
organisation, make the App public first. Every site with no tracker of its own sends its notes to
this one repository: a site of the console names no repository of its own.

## Check it

`/health` answers `{"ok":true,"store":"github",…}` when the three variables and every other required variable,
`ALLOWED_ORIGINS` included, are valid: it checks
the configuration and never GitHub. Plant a note from the site, then find its issue in the repository. Not measured for this page: it
needs a GitHub App.
If the App is not installed on the repository, or the key belongs to another App, every write answers
`502 store-unavailable`, and a read answers the same code with the status GitHub gave.

## What it costs

An installation token has a budget of at least 5,000 requests an hour. Every read of a page lists the
issues of the client, 100 a call, newest first, and stops at 1,000 issues: a client with more loses its
oldest pins. Each pin of that page with replies costs one or two more calls. The read cache keeps one
answer per page for a short time, so a busy page costs one listing per cache window, not one per
visitor. A write costs one call per label and one for the issue: two calls for a note that names no
client, three for a note that names one.
