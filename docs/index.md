# Fruitback

**Visual feedback on a live site, without a backend to host.**

A client opens their staging site, clicks the element that bothers them, and types a note. It lands
as a triaged issue carrying the CSS selector, the React component and the source file behind that
element. Coming back to the page, they see their pins again, coloured by that issue's status.

Fruitback runs no service that holds your feedback: it lands in the tracker your team already uses —
Linear, GitHub Issues — or in a SQLite file on a volume you own. The one piece you run is a worker,
because a tracker's API key cannot ship in client-side JavaScript.

## The guides

|                                                     |                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [The three modes](modes.md)                         | Public, private and team: what the site ships in each, and who may read the pins. Start here.    |
| [Installing Fruitback](install.md)                  | Two lines on a site with no build step, and what each option does.                               |
| [Running the worker yourself](self-hosting.md)      | One container behind a reverse proxy: every environment variable, and what a wrong value breaks. |
| [Reviewing a site with the extension](reviewing.md) | The reviewer's side: the browser extension, a rule per site, and pairing.                        |
| [Translating the widget](translating.md)            | The words a host can replace, and the catalogs the bundle carries.                               |
| [Architecture](architecture.md)                     | What the parts are, and the designs that were dropped.                                           |

## The code

The source is on [GitHub](https://github.com/sakuga-software/fruitback), under the MIT licence for
the three published packages and AGPL-3.0-only for the worker and the browser extension. The
[decisions](https://github.com/sakuga-software/fruitback/tree/main/docs/decisions) folder holds the
per-ticket histories: the measurements, the first versions that failed, and the reviews that caught
them.
