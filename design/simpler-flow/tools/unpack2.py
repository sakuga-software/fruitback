import sys, re, json, base64, gzip, os, hashlib, glob
root = sys.argv[1]
extmap = {'text/html': '.html', 'text/css': '.css', 'application/javascript': '.js', 'text/javascript': '.js', 'image/png': '.png', 'image/svg+xml': '.svg', 'image/jpeg': '.jpg', 'font/woff2': '.woff2', 'font/woff': '.woff', 'image/webp': '.webp', 'font/ttf': '.ttf', 'application/json': '.json'}
def island(html, t):
    m = re.search(r'<script type="__bundler/%s">\s*(.*?)\s*</script>' % t, html, re.S)
    return json.loads(m.group(1)) if m else None
os.makedirs(os.path.join(root, 'assets'), exist_ok=True); os.makedirs(os.path.join(root, 'screens'), exist_ok=True)
seen = {}
rows = []
for f in sorted(glob.glob(os.path.join(root, 'pages', '*.html'))):
    html = open(f, encoding='utf-8').read()
    man = island(html, 'manifest'); tpl = island(html, 'template'); ext = island(html, 'ext_resources'); po = island(html, 'page_order')
    name = os.path.basename(f)
    for u, e in man.items():
        b = base64.b64decode(e['data'])
        if e.get('compressed'): b = gzip.decompress(b)
        h = hashlib.sha256(b).hexdigest()[:16]
        if h not in seen:
            seen[h] = 'assets/%s%s' % (h, extmap.get(e['mime'], '.bin'))
            open(os.path.join(root, seen[h]), 'wb').write(b)
        tpl = tpl.replace(u, '../' + seen[h])
        rows.append((name, u, e['mime'], len(b), seen[h]))
    open(os.path.join(root, 'screens', name), 'w', encoding='utf-8').write(tpl)
    print(name, 'assets', len(man), 'ext', ext, 'page_order', po, 'tpl', len(tpl))
with open(os.path.join(root, 'ASSETS.tsv'), 'w') as fh:
    for r in rows: fh.write('\t'.join(map(str, r)) + '\n')
for h, p in seen.items(): print(p, os.path.getsize(os.path.join(root, p)))
