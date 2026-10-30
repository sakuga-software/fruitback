---
'@fruitback/worker': patch
---

A request reads the one site it names, and asks whether a site has the origin of its page, in place of reading every site of the instance: at 10,500 sites a request of the widget or the console takes 2 to 6 ms in place of 23 to 27. With the database down, a route that reads no site answers `503 limiter-unavailable` where it answered `502 store-unavailable`.
