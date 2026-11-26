---
'@fruitback/worker': minor
'@fruitback/console': minor
---

The account keeps the look of the console its person chose in Settings › Appearance: their other browsers show it once they sign in, and another account in the same browser does not. `POST /console/me/appearance` takes a whole appearance (eight known values) or `null`, and `GET /console/me` answers it. A migration adds the column `appearance` to `user`, empty for every account.
