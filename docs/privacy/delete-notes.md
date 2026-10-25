# Delete a reporter's notes

The widget asks for no e-mail address since FRU-91, so a note carries one in two cases only: the
integrator's identity token gave it, or the note was written before. A typed name is a claim, and
so was a typed e-mail: a reporter can write somebody else's, and two reporters can write the same
one. So list the notes first, read the list, and delete after.

**A note signed with a name only has no address to search for**, and a note with no name has
nothing to search for at all. Each note has an identifier, and the thread of its pin shows it on the
page.

- **PostgreSQL:** the worker has a command for it. Run it in the container, like `pair`:

  ```bash
  docker compose exec worker node server.mjs forget --email alice@example.com --dry-run
  docker compose exec worker node server.mjs forget --email alice@example.com
  ```

  The first line lists the notes that give this address, with their `FB-n`, date, page and the start
  of the note, and deletes nothing. The second deletes them, with the team's replies to them. The
  address is compared without case and without the spaces around it. You do not have to stop the
  worker: the database takes the deletion in one transaction. A page
  can still show a deleted note for up to 15 seconds, from the cache. Then delete it from your
  backups too, or record when they expire. **On PostgreSQL the command reads the notes of every
  site of the worker**, whatever their workspace: it is for whoever runs the worker, not for a
  workspace.

  For a note with no address, list by name, then delete by identifier:

  ```bash
  docker compose exec worker node server.mjs forget --name "Alice" --dry-run
  docker compose exec worker node server.mjs forget --id FB-12 --id FB-15
  ```

  `--name` only lists, and the command refuses it without `--dry-run`: two reporters sign with the
  same name, so a name finds notes and does not decide which ones go. `--id` deletes the notes you
  name, with their replies. If one identifier of the list names no note, nothing is deleted. Use
  one of `--email`, `--name` and `--id` in a command. Measured with the compose file on 2026-10-16:
  `forget --id FB-1 --dry-run` listed the note of the path of [self-hosting.md](../self-hosting.md), and
  deleted nothing.

- **After an upgrade copied the notes of an instance of before FRU-225 into the database (FRU-220),
  the file of before still holds them.** See [self-hosting/upgrade.md](../self-hosting/upgrade.md).
  `migrate-to-postgres --notes` copies and never writes the file, which is the way back. `forget`
  then deletes in the database only: a note that a person asked you to delete is still in the file
  and in the archives that hold it. Delete the file when the way back is no longer needed, and
  record when its archives expire.
- **Linear and GitHub:** the notes are issues in your own workspace, so you delete them there, and
  the command says so rather than deleting anything. Search the issues for the address, because the
  description states it, read them, and delete the ones that are this reporter's. On GitHub only an
  administrator of the repository can delete an issue. Closing an issue does not delete it.

If you delete PostgreSQL rows by hand, delete the row of `notes`: its replies in `note_comments` go
with it.
