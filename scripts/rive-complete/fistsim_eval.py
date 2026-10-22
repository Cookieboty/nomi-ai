import math, numpy as np, cv2, itertools
import round10_hand as H
from fistsim_view import mk
SC=6
def sil(img): return (img.max(2)>40).astype(np.uint8)
def evaluate(side,pose,P=None,box=None):
    P=P or H.build_pieces(side)
    hb=H.grid(side)[0]; box=(hb[0]-25,hb[1]-5,hb[2]+25,hb[3]+30)
    rest=sil(H.render(side,{},SC,pieces=P,box=box,bg=(0,0,0)))
    cur=sil(H.render(side,pose,SC,pieces=P,box=box,bg=(0,0,0)))
    cnts,_=cv2.findContours(rest,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    hull=cv2.convexHull(np.concatenate(cnts)); m=np.zeros_like(rest); cv2.fillPoly(m,[hull],1)
    m=cv2.dilate(m,np.ones((2*SC+1,2*SC+1),np.uint8))
    out=(cur>0)&(m==0)
    n,lab,st,_=cv2.connectedComponentsWithStats(cv2.dilate(cur,np.ones((3,3),np.uint8)))
    return int(out.sum())/SC**2, n-1, int(cur.sum())/SC**2, int(rest.sum())/SC**2
if __name__=='__main__':
    FIST={'thumb':(-30,-45,-35),'index':(80,100,65),'middle':(-75,-95,-60),'ring':(-75,-95,-60),'little':(-75,-95,-60)}
    for side,sgn in (('l',1),('r',-1)):
        for k in (0.6,1,1.15): print(side,k,evaluate(side,mk(FIST,sgn,k)))
