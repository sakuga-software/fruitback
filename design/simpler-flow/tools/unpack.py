import sys, re, json, base64, gzip, os, hashlib
src, out = sys.argv[1], sys.argv[2]
html = open(src, encoding='utf-8').read()
def island(t):
    m = re.search(r'<script type="__bundler/%s">\s*(.*?)\s*</script>' % t, html, re.S)
    return json.loads(m.group(1))
manifest = island('manifest'); order = island('page_order'); template = island('template'); ext = island('ext_resources')
os.makedirs(out, exist_ok=True)
open(os.path.join(out, '00-board-template.html'), 'w', encoding='utf-8').write(template)
titles = dict((u, t) for u, t in re.findall(r'<iframe src="about:blank#([0-9a-f-]{36})" title="([^"]*)"', template))
sizes = dict((u, (w, h)) for u, w, h in re.findall(r'<iframe src="about:blank#([0-9a-f-]{36})"[^>]*width="(\d+)" height="(\d+)"', template))
extmap = {'text/html': '.html', 'text/css': '.css', 'application/javascript': '.js', 'text/javascript': '.js', 'image/png': '.png', 'image/svg+xml': '.svg', 'image/jpeg': '.jpg', 'font/woff2': '.woff2', 'font/woff': '.woff', 'image/webp': '.webp'}
index = []
for u, e in manifest.items():
    b = base64.b64decode(e['data'])
    if e.get('compressed'): b = gzip.decompress(b)
    if u in order:
        i = order.index(u) + 1
        slug = re.sub(r'[^a-z0-9]+', '-', titles.get(u, 'page').lower()).strip('-')
        name = 'pages/%02d-%s.html' % (i, slug)
    else:
        name = 'assets/%s%s' % (u, extmap.get(e['mime'], '.bin'))
    p = os.path.join(out, name); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'wb').write(b)
    index.append((name, u, e['mime'], len(b), titles.get(u, ''), sizes.get(u, ('', '')), hashlib.sha256(b).hexdigest()[:12]))
index.sort()
with open(os.path.join(out, 'MANIFEST.tsv'), 'w') as f:
    for r in index: f.write('\t'.join(str(x) for x in r) + '\n'); print(*r, sep='\t')
print('ext_resources', ext, 'entries', len(manifest), 'pages', len(order))
