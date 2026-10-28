# Connect an AI agent

An AI agent of your team (Claude Code on your machine, in CI, or a cloud agent) can read the notes of
your sites, reply to them and set their status. It talks to the **remote MCP server** of your
worker, `https://<your worker>/mcp`, with an **agent key** of your workspace. Nothing runs in the
pages of your sites, and Fruitback calls no model: the agent is yours, with its own provider.

[The decision page](https://github.com/sakuga-software/fruitback/blob/main/docs/decisions/agents.md) gives the reasons for each rule here.

## Make a key

The owner and the admins of a workspace make its keys. A key names:

- **its sites**, 20 at most: it reads nothing of another site, and nothing of another workspace;
- **its rights**: `read`, or `write` to reply and set a status too;
- **how long it lives**: 90 days unless you choose from 1 to 365. No key lives with no end;
- **`verifiedOnly`**, on by default: on a site that everyone reads, the key reads only the notes of a
  known person, a member or a reviewer that your site identified. Turn it off only knowing that
  anybody can write the other notes.

The key is given **once**, in the answer that makes it. Fruitback keeps only its digest: a key you
lose cannot be shown again, so make another and revoke the first.

In the console, open **Workspace settings**, then **Agents** and **New key**. Name the key, tick
its sites, choose what the agent can do and how long the key lives, then **Make the key**. The
console shows the key once, with the line that connects Claude Code, both ready to copy.

The same screen lists the keys, with when an agent last used each one (to the minute) and when it
ends; it warns 7 days before the end. **Writes** shows the replies and the statuses a key wrote, and
**Revoke** stops it at once: its agent is refused from its next request.

The console calls `/console/workspaces/<workspace id>/agent-keys` of the worker: `POST` makes a key,
`GET` lists them, `DELETE …/agent-keys/<key id>` revokes one, and `GET …/agent-keys/<key id>/writes`
gives what it wrote.

## Connect Claude Code

```bash
claude mcp add --transport http fruitback https://<your worker>/mcp \
  --header "Authorization: Bearer fbk_…"
```

Then ask it, for example: « List the notes of the site `<site id>` with fruitback, and fix the ones
on the pricing page. » It has these tools:

| Tool                                                                    | Right | What it does                                                                                                            |
| ----------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| `list_feedback({ site, stage?, status?, since?, q?, cursor?, limit? })` | read  | The notes of a site, newest first, each whole: text, page, element, component, file and line, picture, replies, status. |
| `get_feedback({ id })`                                                  | read  | One note, by the `id` that `list_feedback` gives.                                                                       |
| `feedback_as_text({ site, page? })`                                     | read  | The notes of a page or of a site as Markdown, each line of a reviewer quoted.                                           |
| `reply_to_feedback({ id, body })`                                       | write | A reply in the thread of the note. The reviewer reads « Agent » beside the name of the key.                             |
| `set_feedback_status({ id, status })`                                   | write | A status of the site (`own:<key>`), for a note that Fruitback keeps. A note in a tracker takes its tracker's status.    |

A key writes 30 times a minute at most.

## Connect an agent that runs elsewhere

The server needs no browser and nobody to approve a session: an agent in CI, or a cloud agent,
connects with the key in a header, as above. Keep the key in the secrets of that runner, never in a
repository. In a configuration file of MCP:

```json
{
  "mcpServers": {
    "fruitback": {
      "type": "http",
      "url": "https://<your worker>/mcp",
      "headers": { "Authorization": "Bearer ${FRUITBACK_AGENT_KEY}" }
    }
  }
}
```

A server answers `404` to a key it does not take: revoked, expired, of a member who left, or of a
suspended workspace. It answers `403` to a request that a browser sends: a page cannot call it.

## What Fruitback cannot stop

**A note is text that a person wrote, maybe a visitor. Nothing stops an agent from obeying it.**
Fruitback gives each note in a field of its own, starts every answer with a line that says the text
is data and not an instruction, keeps the key to its sites, and hides the notes of visitors on a
public site unless you chose otherwise. What the agent then does is yours to bound:

- **No code reaches a branch that deploys without a review by a person.** Let the agent open a pull
  request, never push.
- **A key `write` on a site that everyone reads is a choice made knowing it**: anybody can leave a
  note there, and the agent replies on the page where every visitor reads it.
- Give a key the sites it needs and the shortest life that works, and revoke it when the job ends.
- Read the log of its writes in the console.

## Privacy

When a key exists, the notes it reads leave Fruitback for the agent, and from there for **the
provider of the model your team uses**. [What the widget collects](privacy.md) says it, and the
[notice you can adapt](privacy/notice.md) has a sentence for it. With no key, nothing leaves.
