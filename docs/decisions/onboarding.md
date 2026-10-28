# Onboarding: from the install to the first note (FRU-481, a framing)

Mathieu asked on 2026-10-28 for fewer actions between the install of the extension and the first note,
for a first user above all, and for a guide on the setup page that stays true at each release of the
extension. This page is the framing: the path measured on `main` at `389ac285`, what each action
becomes, and the tickets. The table of the path follows each ticket that changes it.

## The path

### The rules, in short

- **The path is measured, not described.** `e2e/first-note.spec.ts` drives the real console, the real
  extension and the real widget against one worker of the Cloud, and writes each action of the person
  with the place it happens. A change to the path changes that list in the same pull request.
- **Three actions belong to Chrome, and no automation reaches them**: the button of the Chrome Web
  Store, the dialog « Add extension », and the prompt for the access to a site. The spec writes them
  down as `store` or `chrome` and counts them; it does not do them. The prompt stays: the extension
  asks for no host at install, on purpose (`extension.md`).
- **No step of the first path sends the person to a screen that cannot go on.** The welcome page of
  the extension said « click the icon, then Sign in with email », and the popup on that page offered
  no sign-in. Since FRU-482 the page signs in itself, and the popup offers the sign-in on any page.
- **The pin is a tip, not a step** (FRU-484). Nothing between the install and the first note needs it.
- **Firefox is not on AMO yet**: its path installs an archive by hand (`reviewing.md`). It is named
  here, and not measured.

### The path today

The path of a new person who signs in by e-mail, in the order the spec does it. The place is where
the action happens: `console`, `mail`, `tab` (going back to a tab that is already open), `store`,
`chrome`, `welcome` (the page of the extension that opens at install), `popup`, `site`.

| #   | Place   | Action                                                             | Becomes                      |
| --- | ------- | ------------------------------------------------------------------ | ---------------------------- |
| 1   | console | open fruitback.com, then « Set up »                                | stays                        |
| 2   | console | type the e-mail address                                            | stays                        |
| 3   | console | click « Email me a link »                                          | stays                        |
| 4   | mail    | open the mailbox, then the message                                 | stays                        |
| 5   | mail    | click the link: a new tab opens                                    | stays                        |
| 6   | tab     | go back to the tab of the setup                                    | stays (SPEC P4)              |
| 7   | console | type the address of the site                                       | stays                        |
| 8   | console | click « Add site »                                                 | stays                        |
| 9   | console | click « Install the extension (beta) »: the store opens in a tab   | stays                        |
| 10  | store   | click « Add to Chrome »                                            | stays                        |
| 11  | chrome  | click « Add extension » in the dialog of Chrome                    | stays                        |
| 12  | chrome  | open the puzzle menu of the toolbar                                | a tip, FRU-484               |
| 13  | chrome  | click the pin beside Fruitback                                     | a tip, FRU-484               |
| 14  | welcome | click « Sign in with email »: the console opens in a tab           | stays                        |
| 15  | console | click « Connect Chrome » after the word                            | stays                        |
| 16  | tab     | go back to the tab of the setup                                    | removed, FRU-483             |
| 17  | console | click « Open <site> »: the site opens in a tab                     | removed, FRU-483             |
| 18  | popup   | click the Fruitback icon                                           | removed, FRU-483             |
| 19  | popup   | click « Turn on »                                                  | on the welcome page, FRU-483 |
| 20  | chrome  | click « Allow » in the prompt of Chrome for the access to the site | stays                        |
| 21  | site    | click « Leave feedback »                                           | removed, FRU-485             |
| 22  | site    | click the element of the page                                      | stays                        |
| 23  | site    | type the note                                                      | stays                        |
| 24  | site    | click « Send »                                                     | stays                        |

**24 actions: 5 in the screens of Chrome and its store (2 of them become tips with FRU-484), 2
returns to a tab that is already open, and no dead end.** The welcome page signs in itself
(FRU-482): it shows the word that the console shows, claims the session, closes the tab of the
console and says who signed in. The popup on a page that is not a site offers the sign-in too.

### What was measured first

On `main` at `389ac285` the path counted **27 actions**, with **1 dead end**: the welcome page said
« click the icon, then Sign in with email », and the popup on that page said only « Fruitback works
on http and https pages. » (`notAWebPage`). The person went back to the setup, opened the site,
signed in from the popup there, and went back to the site after the console. FRU-482 removed those
three actions and the dead end. The spec also measured that the setup goes on in its first tab after
the link, while the tab of the link says « You are signed in … You can close this one »
(`sign-in.tsx`, the choice P4 of the mockup).

The setup ends by itself at the first note (`setup-install.tsx`). The spec does not check it: the end
reads `lastNoteAt` of the site, which comes from the index of the notes (`notes-index-postgres.ts`),
and the worker of the tests has no index (its PostgreSQL is port 1, `cloud-worker.fixture.ts`).

### The path after the tickets

FRU-482 to FRU-485 give **18 actions**: steps 1 to 11, then on the welcome page « Sign in with
email » and « Connect Chrome » in the console tab that the extension opens and closes (FRU-482,
done), « Turn on <site> » on the welcome page, « Allow » in Chrome, and on the site that opens the
element, the text and « Send ». The 3 actions that only Chrome draws stay. One return to a tab stays
(step 6). No action leads to a dead end.

With question 1 answered yes (FRU-487), the console of the Cloud connects the extension of the same
browser in place, with no word to check and no tab to open: about **15 actions**.

A sign-in with Google or GitHub, where the instance offers it, can replace steps 2 to 6 with one click
and the consent of the provider. **Not measured**: the worker of the tests offers no provider.

### Why the welcome page carries the path

The welcome page is the tab that Chrome shows after the install: the person is there, and it is a
page of the extension. A click on it is a gesture of the person, so `permissions.request` for the
origin of a site works there, as in the popup. It can start the sign-in (`/session/connect`) and read
the sites of the account (`GET /session/sites`). It needs no new permission, no route of the worker,
and no change to who may connect: the request still starts in the extension, and the word is still
checked in the console.

The popup stays the way in for every later visit. The dead end of the popup on a page that is not a
site is fixed too (FRU-482): signed out, it offers the sign-in there as well.

## The guide

### The rules, in short

- **The captures of the guide come from a spec, never from a hand** (FRU-486). The spec walks the
  real path and writes each capture under a stable name. The release of the extension runs it on the
  tag and opens a pull request with the captures that changed.
- **The captures are taken on the `sakuga-mac` runners**: their fonts are the fonts of the mockups,
  and of the machine of the person who reads the guide most.
- **One source for the words**: step 3 of the setup and `docs/reviewing.md` show the same steps.
- **A guard holds the names**: a test fails when a step of the guide names a control that the built
  extension no longer draws. `reviewing-doc.test.ts` holds the words of the popup that the guide
  quotes today; the images have no guard.

### What exists today

`docs/reviewing.md` shows five captures (`docs/assets/guide-*.png`), made by hand for FRU-322 on
2026-10-20. Step 3 of the setup shows no guide: one sentence (« Add it, then connect this browser: a
page opens, and you click the Fruitback icon there ») and two buttons.

## The questions

1. **May the console talk to the extension of the same browser?** (FRU-487) `console.md` says that a
   content script on the console and `externally_connectable` are not wanted. With
   `externally_connectable` limited to the console of the Cloud, step 3 of the setup sees the
   extension and connects it in place. The cost: the extension trusts a page of the Cloud to ask for
   a session with no word. Decided by Mathieu on 2026-10-28: yes, for the console of the Cloud, after FRU-482 and FRU-483.
2. **Does the first activation open the choice of an element by itself?** (FRU-485) The default of
   the ticket: once, at the first activation of a site, never at a load of a page.
3. **Where does the guide show?** (FRU-486) The default of the ticket: folded under the card
   « Browser extension » of step 3, not on a page of its own.

## The tickets

| Ticket  | What                                                                         | State |
| ------- | ---------------------------------------------------------------------------- | ----- |
| FRU-482 | The welcome page signs in itself; the popup on a page that is not a site too | Done  |
| FRU-483 | The welcome page offers « Turn on <site> » and opens the site                | Todo  |
| FRU-484 | The pin is a tip                                                             | Todo  |
| FRU-485 | The first activation opens the choice of an element                          | Todo  |
| FRU-486 | The guide on the setup page, its captures made again at each release         | Todo  |
| FRU-487 | The console talks to the extension of the same browser                       | Todo  |
