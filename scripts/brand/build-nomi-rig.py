#!/usr/bin/env python3
"""Cut the approved Nomi half-body illustration into pseudo-3D rig layers.

Local-only (numpy, Pillow, opencv-python-headless; no hosted services).
Usage: python3 scripts/brand/build-nomi-rig.py <nomi-clean-halfbody.jpg> <out-dir/>
Then copy out-dir/*.png to characters/nomi/sprite/layers/
(thumb.png one level up) and paste rig.json into manifest.json under "rig".
Occluded areas (skin under eyes/mouth, hair under the ribbon, neck under the
chin, collar under the swaying side hair) are filled with OpenCV Telea inpainting;
closed/happy eyes and open/o/frown mouths are painted procedurally.
"""
import sys
import numpy as np, cv2, json
from PIL import Image, ImageFilter, ImageDraw
SRC=sys.argv[1] if len(sys.argv)>1 else 'nomi-clean-halfbody.jpg'
OUT=(sys.argv[2].rstrip('/')+'/') if len(sys.argv)>2 else 'out/'
X0,Y0,X1,Y1=400,0,880,560; S=2
im=Image.open(SRC).convert('RGB').crop((X0,Y0,X1,Y1))
im=im.resize(((X1-X0)*S,(Y1-Y0)*S),Image.LANCZOS).filter(ImageFilter.UnsharpMask(1.6,60,2))
rgb=np.asarray(im).astype(np.float32); H,W=rgb.shape[:2]
def P(x,y): return ((x-X0)*S,(y-Y0)*S)
yy,xx=np.mgrid[0:H,0:W]; RX=xx/S+X0; RY=yy/S+Y0   # real coords per px
# --- background removal (white bg flood from border)
d=(255-rgb).max(2)
low=(d<16).astype(np.uint8)
n,lab=cv2.connectedComponents(low)
border=set(np.unique(np.concatenate([lab[0],lab[-1],lab[:,0],lab[:,-1]])))
bg=np.isin(lab,[b for b in border if b!=0 or low[0,0]])&(low>0)
# enclosed background pockets between hair strands (head zone only; keep face, clip, collar)
_RX=np.mgrid[0:low.shape[0],0:low.shape[1]][1]/S+X0; _RY=np.mgrid[0:low.shape[0],0:low.shape[1]][0]/S+Y0
low2=((255-rgb).max(2)<26)
zone=((_RY<200)|((_RY<207)&((_RX<590)|(_RX>690))))&~((_RX>586)&(_RX<692)&(_RY>96)&(_RY<200))&~((_RX>662)&(_RX<702)&(_RY>66)&(_RY<104))
n2,lab2=cv2.connectedComponents((low2&zone).astype(np.uint8))
bg|=(lab2>0)
fg=(~bg).astype(np.float32)
fg=cv2.GaussianBlur(fg,(0,0),0.9)
dnear=cv2.dilate(d,np.ones((9,9),np.uint8))
band=cv2.dilate(bg.astype(np.uint8),np.ones((9,9),np.uint8))>0
est=np.clip((d-5)/np.maximum(dnear*0.85-5,8),0,1)
a=np.where(band,np.minimum(np.maximum(fg,0)*1.0,est)+0*fg,fg)
a=np.where(bg,0,a)
# remove tiny specks
m8=(a>0.5).astype(np.uint8); n,lab,st,_=cv2.connectedComponentsWithStats(m8)
for i in range(1,n):
    if st[i,4]<60: a[lab==i]=0
# decontaminate white fringe
aa=np.clip(a,0.05,1)[...,None]
BGC=np.median(rgb[bg],axis=0)
rgb=np.where(a[...,None]<0.98,np.clip((rgb-(1-aa)*BGC)/aa,0,255),rgb)
# bottom fade
fade=np.clip((H-yy)/(140.0),0,1); a=a*fade
def save(name,alpha,col=None,crop=True):
    col=rgb if col is None else col
    arr=np.dstack([col,np.clip(alpha,0,1)*255]).astype(np.uint8)
    arr[...,3][arr[...,3]<3]=0; arr[arr[...,3]==0,:3]=0
    Image.fromarray(arr,'RGBA').save(OUT+name+'.png',optimize=True)
def soft(m,s): return cv2.GaussianBlur(m.astype(np.float32),(0,0),s)
def ellipse(cx,cy,rx,ry,feather=1.5):
    m=np.zeros((H,W),np.float32); c=P(cx,cy)
    cv2.ellipse(m,(int(c[0]),int(c[1])),(int(rx*S),int(ry*S)),0,0,360,1,-1); return soft(m,feather)
def inpaint(col,mask,r=6):
    img=cv2.cvtColor(col.astype(np.uint8),cv2.COLOR_RGB2BGR)
    out=cv2.inpaint(img,(mask>0.05).astype(np.uint8)*255,r,cv2.INPAINT_TELEA)
    return cv2.cvtColor(out,cv2.COLOR_BGR2RGB).astype(np.float32)
lum=rgb@np.array([.299,.587,.114])
hsv=cv2.cvtColor(np.clip(rgb,0,255).astype(np.uint8),cv2.COLOR_RGB2HSV).astype(np.float32)
NECK=192
headw=np.clip((NECK-RY)/3.0+0.5,0,1)          # head below neckline fades out over 3 real px
bodyw=np.clip((RY-180)/3.0+0.5,0,1)
# --- side hair (secondary motion)
hairm=((lum<110)&(a>0.3)).astype(np.uint8)
hairm=cv2.morphologyEx(hairm,cv2.MORPH_CLOSE,np.ones((5,5),np.uint8)).astype(np.float32)
root=np.clip((RY-142)/16,0,1)*np.clip((215-RY)/6,0,1)
cut=(RY>160)
sideL=soft(hairm*(RX<598),1.2)*root*a
sideR=soft(hairm*(RX>679)*(RX<760),1.2)*root*a
# --- ribbon (orange, right of head)
orange=(hsv[...,0]>5)&(hsv[...,0]<25)&(hsv[...,1]>110)&(hsv[...,2]>120)
rbox=(RX>703)&(RX<758)&(RY>92)&(RY<162)
rib=soft(cv2.dilate((orange&rbox).astype(np.uint8),np.ones((5,5),np.uint8)),1.0)*a*rbox
# --- head
sideHard=np.maximum(sideL,sideR)*cut/np.maximum(a,1e-3)
hairBehind=rbox&(RX<721)&(cv2.dilate(hairm.astype(np.uint8),np.ones((7,7),np.uint8))>0)&(a>0.2)
head_a=a*headw*(1-np.clip(sideHard,0,1))*np.where(hairBehind,1,(1-rib/np.maximum(a,1e-3)).clip(0,1))
headcol=inpaint(rgb,((rib>0.05)&hairBehind)*1.0,5)   # paint hair under ribbon
head_a=np.maximum(head_a,a*headw*rib*0.0+ (rib>0.05)*headw*np.clip(soft((a>0.5)&(~rbox|(RX<725)),3),0,1)*0)  # keep simple
# features: eyes + mouth
eL=ellipse(603.5,132.5,16,12,1.4); eR=ellipse(665,125.5,16.5,12,1.4); mo=ellipse(637.5,165,13,5.5,1.2)
feat=np.maximum(np.maximum(eL,eR),mo)
headcol=inpaint(headcol,cv2.dilate((feat>0.02).astype(np.uint8),np.ones((5,5),np.uint8)),9)
# neck backing in body (painted skin under chin)
skin=rgb[int(P(637,184)[1]),int(P(637,184)[0])]
bodycol=rgb.copy()
neck=np.zeros((H,W),np.float32); p0=P(621,150); p1=P(654,194)
cv2.rectangle(neck,(int(p0[0]),int(p0[1])),(int(p1[0]),int(p1[1])),1,-1); neck=soft(neck,3)
bodycol=bodycol*(1-neck[...,None])+skin*neck[...,None]
# body loses the swaying side hair; inpaint what was under it where jacket continues
side=np.maximum(sideL,sideR)
under=(side>0.3)&(RY>=196)
rowfill=np.zeros((H,W),bool)
nh=(a>0.5)&(side<0.05)
for y in range(H):
    xs=np.where(nh[y])[0]
    if len(xs): rowfill[y,xs.min():xs.max()+1]=True
under&=rowfill
bodycol=inpaint(bodycol,under.astype(np.float32),6)
body_a=np.maximum(a*bodyw*(1-side),under*fade*1.0)
body_a=np.maximum(body_a,neck*0.999*(RY<196))
save('body',body_a,bodycol)
save('head',head_a,headcol)
save('hair-side-l',sideL); save('hair-side-r',sideR); save('ribbon',rib)
save('eye-l',eL*a); save('eye-r',eR*a); save('mouth',mo*a)
# --- procedural variants painted at 4x supersample
lash=np.array([52,30,26]); def_col=tuple(int(v) for v in lash)
def painted(name,draw_fn):
    SS=4; img=Image.new('RGBA',(W*SS,H*SS),(0,0,0,0)); dr=ImageDraw.Draw(img); draw_fn(dr,SS)
    img.resize((W,H),Image.LANCZOS).save(OUT+name+'.png',optimize=True)
def pt(x,y,SS): p=P(x,y); return (p[0]*SS,p[1]*SS)
def closed_eye(dr,SS,cx,cy,w,flip=False,happy=False):
    pts=[]
    for i in range(41):
        t=i/40; x=cx-w/2+w*t; k=(4*t*(1-t))
        y=cy+ (-k*4.5 if happy else k*2.6)
        pts.append(pt(x,y,SS))
    dr.line(pts,fill=def_col+(255,),width=int(2.2*S*SS),joint='curve')
    # outer lash tail
    tail=(cx+w/2*(1 if not flip else -1), cy)
    if not happy:
        dr.line([pt(*tail,SS),pt(tail[0]+(3 if not flip else -3),tail[1]-2,SS)],fill=def_col+(255,),width=int(1.6*S*SS))
painted('eyes-closed',lambda dr,SS:(closed_eye(dr,SS,603,137,27,True),closed_eye(dr,SS,665.5,130,28)))
painted('eyes-happy',lambda dr,SS:(closed_eye(dr,SS,603,136,24,True,True),closed_eye(dr,SS,665.5,129,25,False,True)))
def mouth_open(dr,SS,w=13,h=7.5,round_=False):
    cx,cy=637.5,166
    if round_: w=7
    box=[pt(cx-w/2,cy-h/2,SS),pt(cx+w/2,cy+h/2,SS)]
    if round_: dr.ellipse(box,fill=(120,46,48,255),outline=def_col+(255,),width=int(1.0*S*SS))
    else:
        dr.chord([box[0][0],box[0][1]-h*S*SS*0.5,box[1][0],box[1][1]],0,180,fill=(128,48,50,255),outline=def_col+(255,),width=int(1.0*S*SS))
    tb=[pt(cx-w*0.3,cy+h*0.05,SS),pt(cx+w*0.3,cy+h*0.5,SS)]
    dr.chord(tb,180,360,fill=(226,128,122,255))
painted('mouth-open',lambda dr,SS:mouth_open(dr,SS))
painted('mouth-o',lambda dr,SS:mouth_open(dr,SS,h=8,round_=True))
def frown(dr,SS):
    pts=[pt(631+12*t/20, 167-3*(4*(t/20)*(1-t/20)),SS) for t in range(21)]
    dr.line(pts,fill=(120,60,58,255),width=int(1.4*S*SS),joint='curve')
painted('mouth-frown',frown)
def thumb():
    im2=Image.open(OUT+'head.png'); b=Image.open(OUT+'body.png'); b.alpha_composite(im2)
    for n in ['hair-side-l','hair-side-r','ribbon','eye-l','eye-r','mouth']: b.alpha_composite(Image.open(OUT+n+'.png'))
    b.save(OUT+'composite.png'); c=b.crop((int(P(540,30)[0]),0,int(P(740,30)[0]),int(P(540,230)[1]))).resize((256,256),Image.LANCZOS); c.save(OUT+'thumb.png')
thumb()
anchors={k:list(map(float,P(*v))) for k,v in dict(neck=(637,192),eyeL=(603.5,137),eyeR=(665,130),mouth=(637.5,166),cheekL=(604,152),cheekR=(670,146),hairL=(590,148),hairR=(686,148),ribbon=(714,112),headTop=(637,40)).items()}
json.dump({'size':[W,H],'anchors':anchors},open(OUT+'rig.json','w'),indent=1)
print(W,H,anchors)

import glob,os
layers={}
for f in sorted(glob.glob(OUT+'*.png')):
    n=os.path.basename(f)[:-4]
    if n in('composite','thumb'): continue
    im=Image.open(f); bb=im.getbbox(); bb=(max(bb[0]-2,0),max(bb[1]-2,0),min(bb[2]+2,W),min(bb[3]+2,H))
    im.crop(bb).save(f,optimize=True); layers[n]=[bb[0],bb[1]]
json.dump({'size':[W,H],'anchors':anchors,'layers':layers},open(OUT+'rig.json','w'),indent=1)
