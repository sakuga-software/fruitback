import sys,glob,os,re
from html.parser import HTMLParser
VOID={'input','img','br','hr','path','circle','meta','link'}
class P(HTMLParser):
    def __init__(s): super().__init__(convert_charrefs=True); s.stack=[]; s.out=[]; s.skip=0
    def handle_starttag(s,tag,attrs):
        a=dict(attrs)
        if tag in('style','script'): s.skip+=1
        st=a.get('style') or ''
        def g(k):
            m=re.search(r'(?:^|;)\s*'+k+r'\s*:\s*([^;]+)',st); return m.group(1).strip() if m else None
        info={'tag':tag,'fs':g('font-size'),'fw':g('font-weight'),'col':g('color'),'a':a}
        extra=[]
        for k in('aria-label','placeholder','alt','value','title'):
            if a.get(k): extra.append(f'{k}="{a[k]}"')
        if tag in('input','textarea','select','button','a','img') or a.get('role') or extra:
            bits=[tag]+[f'{k}={a[k]}' for k in('type','role','aria-pressed','aria-current','aria-selected','aria-expanded','aria-haspopup','href','name') if a.get(k) is not None]
            for k in('checked','disabled','readonly'):
                if k in a: bits.append(k)
            s.out.append(('ctl',' '.join(bits+extra),len(s.stack)))
        if tag not in VOID: s.stack.append(info)
    def handle_endtag(s,tag):
        if tag in('style','script'): s.skip-=1
        for i in range(len(s.stack)-1,-1,-1):
            if s.stack[i]['tag']==tag: del s.stack[i:]; break
    def handle_data(s,d):
        if s.skip: return
        t=' '.join(d.split())
        if not t: return
        fs=fw=col=None
        for e in reversed(s.stack):
            fs=fs or e['fs']; fw=fw or e['fw']; col=col or e['col']
        def hx(c):
            m=re.match(r'rgb\((\d+), (\d+), (\d+)\)',c or ''); return '#%02x%02x%02x'%tuple(map(int,m.groups())) if m else (c or '')
        tag=next((e['tag'] for e in reversed(s.stack) if e['tag'] in('h1','h2','h3','button','a','label','legend','th','td','dt','dd','p','li','option','pre','code','strong','textarea')),s.stack[-1]['tag'] if s.stack else '')
        s.out.append(('txt',t,tag,fs,fw,hx(col)))
out=[]
for f in sorted(glob.glob(os.path.join(sys.argv[1],'*.html'))):
    p=P(); p.feed(open(f,encoding='utf-8').read())
    out.append('\n### '+os.path.basename(f)[:-5]+'\n')
    for o in p.out:
        if o[0]=='ctl': out.append(f'- _[{o[1]}]_')
        else: out.append(f'- `{o[2]}` {o[3] or ""}/{o[4] or ""} {o[5]} — « {o[1]} »')
open(sys.argv[2],'w').write('\n'.join(out)+'\n'); print(len(out))
