---
'@fruitback/worker': minor
'@fruitback/widget': minor
'@fruitback/console': minor
---

A site can ask a visitor with no account to pass Cloudflare Turnstile before their first note: « Bot check », the second line of the card « Safeguards » in its tab « Access », on by default. The worker needs the two keys of a Turnstile widget, `FRUITBACK_TURNSTILE_SECRET` and `FRUITBACK_TURNSTILE_SITE_KEY`; without them nobody is asked, and the console says so. The widget draws the check in the composer, keeps the text, and sends the note once it passed; that browser is not asked again on the site for 30 days. A page with a Content-Security-Policy allows `https://challenges.cloudflare.com` in `script-src` and `frame-src`. New option of `init`: `turnstileScript`.
