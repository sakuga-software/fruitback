---
'@fruitback/widget': patch
---

**TypeScript no longer catches a missing `endpoint` or `clientId`.** Both are optional in `FruitbackOptions` now, because `notes` takes the place of a worker. If you call `init` with neither `notes` nor both of them, the compiler accepts the call, and `init` throws a named error when the page loads. Check your `init` call when you update.
