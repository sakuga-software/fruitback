---
'@fruitback/shared': patch
'@fruitback/widget': patch
---

The script of the widget is 66 kB lighter gzipped (198 kB to 132 kB). The note contract imported zod as one named value, so the bundle kept all of zod: about 50 locales of error messages and the JSON Schema converters, which the widget never uses. It now imports zod as a namespace, which the bundler can trim. The schemas, and the English messages of zod, are the same.
