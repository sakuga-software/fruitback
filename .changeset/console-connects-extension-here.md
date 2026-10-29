---
'@fruitback/extension': minor
'@fruitback/console': minor
---

On Fruitback Cloud, step 3 of the setup connects the extension of the same browser in place: one click, no `/connect` tab, no word to compare. The Chrome and Edge build declares `externally_connectable` for `https://app.fruitback.com` alone, and answers three strict messages from the top frame of a tab of that origin; no secret crosses that channel. Firefox, Safari and a self-hosted console keep the sign-in with the word.
