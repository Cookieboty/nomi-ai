import math, sys, numpy as np, cv2
import round10_hand as H
from PIL import Image
D=math.radians
def mk(FIST,sgn,k=1.0): return {n:tuple(D(sgn*a*k) for a in v) for n,v in FIST.items()}
def sheet(FIST, ks=(0,0.6,1.0,1.15), sc=6, out='/tmp/sim_b.png'):
    rows=[]
    for side,sgn in (('l',1),('r',-1)):
        P=H.build_pieces(side)
        rows.append(np.concatenate([np.pad(H.render(side,mk(FIST,sgn,k),sc,pieces=P),((0,0),(0,8),(0,0)),constant_values=90) for k in ks],1))
    Image.fromarray(np.concatenate(rows,0)[...,::-1][...,::-1]).save(out)
if __name__=='__main__':
    FIST={'thumb':(-30,-45,-35),'index':(80,100,65),'middle':(-75,-95,-60),'ring':(-75,-95,-60),'little':(-75,-95,-60)}
    sheet(FIST)
