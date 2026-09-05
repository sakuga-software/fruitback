# Third-party notices

`@fruitback/widget` is bundled: `react-grab` and `zod` are compiled **into** `dist/fruitback.mjs`
and `dist/fruitback.iife.js` rather than installed by the consumer, so a client site never has to
resolve a version conflict over a library it never asked for.

Both are MIT, and MIT requires their copyright and permission notices to travel with the code.
This file is how they do. It is not courtesy: without it, the widget's `dist` distributes their
work with no attribution.

**Phosphor** is here for the same reason and by a different route: the widget installs no icon
library at all, but `build-icons.ts` copies two of its paths into `src/icon-data.ts` at authoring
time, and those are compiled into the bundle like any other source. Copied geometry is still their
work.

Measured rather than assumed — `react-grab` carries `@license` banners that esbuild preserves into
the bundle, and neither `zod` nor `@iconify-json/ph` carries any, so their notices reach a consumer
only through this file. `@iconify-json/ph` ships no `LICENSE` file either, so the text below comes
from Phosphor's own repository, which `info.json` names.

`@fruitback/shared` is compiled by `tsc`, not bundled, so it keeps `zod` as an ordinary dependency
the consumer installs and needs no notice here. Same for `fruitback`, which forwards both packages.

---

## react-grab

<https://github.com/aidenybai/react-grab>

```
MIT License

Copyright (c) 2025 Aiden Bai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## zod

<https://github.com/colinhacks/zod>

```
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Phosphor

<https://github.com/phosphor-icons/core>

Two icons — `gear-fill` and `x-bold` — read from `@iconify-json/ph` by `build-icons.ts` and written
into `src/icon-data.ts`. Nothing of Iconify's own is distributed: it is the packaging, not the work.

```
MIT License

Copyright (c) 2023 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
