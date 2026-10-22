"""ROUND11 thumb path search (numpy skinning preview, see fistsim.Sim3): finds smoothstep delays (root lag b, p1 finish a1, p2 finish a2)
for the thumb joints so that the thumb never pokes out sideways beyond the palm width while folding.  Result used in round10_fist.THUMB_G:
root b=0.4, p1 a1=0.6, p2 a2=0.3 -> max 5 px outside (R10 path: 53 px).  run: python3 search_thumb.py  (~5 min)"""
import os,sys,itertools,numpy as np; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fistsim as F, prev
P={s: prev.H.build_pieces(s) for s in 'lr'}
S=F.Sim3(P,3)
def sm(x): x=np.clip(x,0,1); return x*x*(3-2*x)
FS=np.linspace(0,1,41)
def ev(fn):
    w={'l':0,'r':0}
    for side in 'lr':
        for f in FS:
            r,p1,p2=fn(f)
            w[side]=max(w[side],S.out_thumb(side,F.pose_of(side,{'thumb':(r,p1,p2)})))
    return w
res=[]
for a1 in (0.3,0.45,0.6,0.8,1.0):
  for a2 in (0.3,0.45,0.6,0.8,1.0):
    for b in (0.0,0.2,0.4,0.55,0.7,0.85):
      fn=lambda f:(sm((f-b)/(1-b)),sm(f/a1),sm(f/a2))
      w=ev(fn); res.append((max(w.values()),w,(a1,a2,b)))
res.sort(key=lambda x:(x[0],x[2][2]))
for r in res[:20]: print(r)
