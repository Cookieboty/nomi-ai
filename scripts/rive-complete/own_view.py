import numpy as np, sys
import round10_hand as H
from PIL import Image
cols={'palm':(120,120,120),'thumb':(255,60,60),'index':(60,255,60),'middle':(60,160,255),'ring':(255,255,0),'little':(255,60,255)}
tiles=[]
for side in 'lr':
    P=H.build_pieces(side); h,w=P['palm'].tex.shape[:2]
    best=np.zeros((h,w),int); img=np.zeros((h,w,3),float)
    # color by strongest piece alpha, brightness by source luminance
    names=['palm','thumb','index','middle','ring','little']
    A=np.stack([P[n].tex[...,3] for n in names]).astype(float)/255
    own=np.argmax(A,0); a0=P['palm'].tex[...,3]
    src=np.array(H.grid(side)[1])[...,:3].mean(-1)/255
    out=np.zeros((h,w,3),np.uint8)
    for i,n in enumerate(names):
        m=(own==i)&(A.max(0)>0)
        out[m]=(np.array(cols[n])*(0.45+0.55*src[m,None])).astype(np.uint8)
    # overdraw: count of pieces with alpha>=128
    cnt=(A>=0.5).sum(0)
    out[cnt>=2]=(out[cnt>=2]*0.5+np.array([255,255,255])*0.5).astype(np.uint8)
    tiles.append(Image.fromarray(out).resize((w*10,h*10),Image.NEAREST))
s=Image.new('RGB',(tiles[0].width*2+10,tiles[0].height),(20,20,20)); s.paste(tiles[0],(0,0)); s.paste(tiles[1],(tiles[0].width+10,0)); s.save('/tmp/own.png')
