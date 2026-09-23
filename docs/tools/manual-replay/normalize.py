import json,sys
ws=json.load(open(sys.argv[1])); ch=ws['chapters'][0]
sl={s['id']:s['label'] for s in ch['slices']}; ln={l['id']:l['label'] for l in ch['lanes']}
key={e['id']:f"{sl[e['sliceId']]}/{e['type']}/{e['name']}" for e in ch['elements']}
def fields(fs): return [{k:v for k,v in f.items()} for f in fs]
out={'lanes':sorted((l['index'],l['label'],l['type']) for l in ch['lanes']),
 'slices':[(s['index'],s['label'],s['status'],s['sliceType'],s.get('implementationNotes')) for s in sorted(ch['slices'],key=lambda s:s['index'])],
 'elements':sorted([{'k':key[e['id']],'lane':ln[e['laneId']],'fields':fields(e['fields']),'copyOf':key.get(e.get('copyOf')),
   'api':e.get('apiEndpoint'),'rmt':e.get('readModelType'),'list':e.get('listElement'),'queries':e.get('queries'),
   'deps':sorted((d['type'],key.get(d['id'],d['id']),d.get('connectionType')) for d in e['dependencies'])} for e in ch['elements']],key=lambda x:x['k']),
 'specs':{sl[s['id']]:[{'title':sp['title'],**{ph:[(st['title'],st['type'],key.get(st.get('linkedId')),[(f['name'],f.get('example')) for f in st['fields']]) for st in sp[ph]] for ph in ('given','when','then')}} for sp in s['specifications']] for s in ch['slices']}}
json.dump(out,open(sys.argv[2],'w'),indent=1,sort_keys=True,default=str)
