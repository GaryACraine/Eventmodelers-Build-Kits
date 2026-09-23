"""Extract the model-building commands of USER-MANUAL.md §4 helpers + §5–§12 into a bash script."""
import sys,re
manual, out = sys.argv[1], sys.argv[2]
s=open(manual).read().split('\n')
start=next(i for i,l in enumerate(s) if l.startswith('## 5. '))
end=next(i for i,l in enumerate(s) if l.startswith('## 13. '))
SKIP=re.compile(r'^\s*(git|curl|npm|node|cd|eventmodelers|jq|docker|post|await|const|console|bash|emcli sync|emcli workspace import-status|emcli workspace export|#)')
lines=['set -u','E=${EMCLI:-emcli}','emcli() { command "$E" "$@"; }']
inb=False
for i in range(start,end):
    l=s[i]
    if l.startswith('```'):
        if not inb: inb=True; lang=l[3:].strip(); blk=[]; continue
        inb=False
        if lang!='bash' or any('const ' in b or 'post(' in b for b in blk): continue
        # join continuations
        joined=[];cur=''
        for b in blk:
            if b.rstrip().endswith('\\'): cur+=b.rstrip()[:-1]+' '; continue
            joined.append(cur+b); cur=''
        lines.append(f'# --- manual line {i}')
        for b in joined:
            m=re.match(r'^\s*bash .*docs/examples/(t\d)\.sh', b)
            if m:
                import os
                names=[m.group(1)] + (['t4'] if m.group(1)=='t3' else [])   # §9: "t4 follows the same steps with t4.sh"
                for x in [x for n in names for x in open(os.path.join(os.path.dirname(manual),'examples',n+'.sh')).read().split('\n')]:
                    if x.startswith(('#!','set -e','source em-helpers')): continue
                    lines.append(x)
                continue
            if not b.strip() or SKIP.match(b): continue
            lines.append(b)
        continue
    if inb: blk.append(l)
open(out,'w').write('\n'.join(lines)+'\n')
print(len(lines),'lines')
