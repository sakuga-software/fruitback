---
'@fruitback/worker': patch
---

Migration `0039_sites_by_origin`: an index on the origin of the sites, so that the worker can find the site of a request by its origin without reading every site.
