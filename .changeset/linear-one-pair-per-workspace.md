---
'@fruitback/worker': patch
'@fruitback/console': patch
'@fruitback/extension': patch
---

Linear keeps one pair of tokens for each Linear workspace, and a new consent ends the pair of before. A Linear connected in a second Fruitback workspace therefore ended the first one. Now every Linear connector of the same Linear workspace shares the pair. A consent or a refresh brings them all back, and disconnecting one connector revokes the pair only when no other connector uses it.

A connection that Linear ended is reconnected in place: « Reconnect Linear » in the panel of the connector keeps its sites, their places and its settings. A « Connect » for a Linear workspace that the workspace already holds brings the old connector back instead of making a second one. The extension says, under « Sent to », that the notes of the site do not reach a tracker that refuses the connection. For an owner or an admin, it opens that connector in the console.
