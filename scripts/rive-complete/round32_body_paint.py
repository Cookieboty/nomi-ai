#!/usr/bin/env python3
"""ROUND32 high-quality body/arm/underlayer PNG painter (deterministic, no generative AI)."""
from __future__ import annotations
import hashlib, json
from pathlib import Path
import numpy as np, cv2
from PIL import Image
import round10_layers as L10

SVG = L10.PROJECT / "reference/svg-rig"
MASTER = L10.PROJECT / "source-nomi-master.png"
OUT = Path("/workspace/scratch/rive-bone-rig/v32/art")
OUT.mkdir(parents=True, exist_ok=True)

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()

def skin_mask(rgb, a, thr_a=8):
    r,g,b = rgb[:,:,0].astype(np.float32), rgb[:,:,1].astype(np.float32), rgb[:,:,2].astype(np.float32)
    orange=(r>180)&(g>80)&(g<180)&(b<100)&((r-g)>40)
    return (a>=thr_a)&(r>150)&(g>100)&(b>60)&(r>g)&((r-b)>20)&((r-g)<70)&~orange

def feather_alpha(rgb_a, solid_dist=1.6):
    m=rgb_a[:,:,3]>0
    dist=cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, 5)
    out=rgb_a.copy()
    out[:,:,3]=np.where(m, np.where(dist>=solid_dist,255,np.clip(dist/solid_dist*255,0,255).astype(np.uint8)),0)
    return out

def paint_body():
    master=np.array(Image.open(MASTER).convert("RGBA"))
    meta=json.loads((SVG/"rig-meta.json").read_text())
    h,w=master.shape[:2]
    yy,xx=np.mgrid[0:h,0:w]
    sk=skin_mask(master[:,:,:3], master[:,:,3], 128)
    dark=(master[:,:,3]>=128)&(np.maximum(np.maximum(master[:,:,0],master[:,:,1]),master[:,:,2])<=145)
    ora=(master[:,:,3]>=128)&(master[:,:,0]>180)&(master[:,:,1]>80)&(master[:,:,1]<180)&(master[:,:,2]<100)&((master[:,:,0].astype(int)-master[:,:,1])>40)
    garment=np.zeros((h,w),bool)
    for key in ("torso-tank","shorts","belt-band","belt-id","belt-pouch"):
        if key not in meta["boxes"]: continue
        x0,y0,x1,y1=meta["boxes"][key]
        crop=np.array(Image.open(SVG/f"{key}.png").convert("RGBA"))
        th,tw=crop.shape[:2]
        garment[y0:y0+th,x0:x0+tw]|=crop[:,:,3]>=40
    torso=(xx>=395)&(xx<=629)&(yy>=315)&(yy<=765)
    cloth=torso&(dark|ora|garment)
    fill=cv2.morphologyEx(cv2.dilate(cloth.astype(np.uint8),np.ones((11,11),np.uint8),2),cv2.MORPH_CLOSE,np.ones((23,23),np.uint8))>0
    fill&=(yy>=315)&(yy<=765)
    mask=fill.astype(np.uint8)*255
    n,lab,st,_=cv2.connectedComponentsWithStats((mask==0).astype(np.uint8),4)
    for i in range(1,n):
        if st[i,0]==0 or st[i,1]==0: continue
        if st[i,0]+st[i,2]>=w or st[i,1]+st[i,3]>=h: continue
        if st[i,4]<8000: mask[lab==i]=255
    fill=mask>0
    cx=512.0
    def hw_band(y0,y1):
        ws=[]
        for y in range(y0,y1):
            xs=np.where(fill[y])[0]
            if len(xs)>=2: ws.append((xs[-1]-xs[0])/2)
        return float(np.median(ws)) if ws else 95
    hw_c,hw_w,hw_h=hw_band(350,420), max(70,hw_band(500,560)*0.86), hw_band(650,730)
    sil=np.zeros_like(fill)
    for y in range(315,765):
        if y<520:
            t=np.clip((y-380)/140.0,0,1); t=t*t*(3-2*t); hw=hw_c*(1-t)+hw_w*t
        else:
            t=np.clip((y-520)/180.0,0,1); t=t*t*(3-2*t); hw=hw_w*(1-t)+hw_h*t
        if y<380: hw=hw_c+(380-y)*0.15
        sil[y, int(cx-hw):int(cx+hw)]=True
    fill=cv2.GaussianBlur(sil.astype(np.float32),(0,0),1.2)>0.4
    face=sk&(yy<260)&(xx>440)&(xx<580)
    leg=sk&(yy>950)&(yy<1150)&(xx>420)&(xx<600)
    neck=sk&(yy>=280)&(yy<340)&(xx>460)&(xx<560)
    samples=np.concatenate([master[:,:,:3][face],master[:,:,:3][leg],master[:,:,:3][neck]])
    p20,p50,p80=np.percentile(samples,[20,50,80],axis=0)
    t=np.clip((yy.astype(float)-320)/420,0,1)
    base=p80[None,None,:]*(1-t[...,None])+p50[None,None,:]*t[...,None]
    nx=(xx-cx)/max(hw_c,1)
    roundness=np.clip(1.08-0.16*np.clip(np.abs(nx),0,1.6)**1.5,0.82,1.08)
    belly=1.0-0.07*np.exp(-((yy-560)/32)**2)*np.exp(-(nx**2)/0.5)
    clav=1.0-0.06*np.exp(-((yy-355)/16)**2)*np.exp(-(nx**2)/0.7)
    hl=1.0+0.04*np.exp(-(nx**2)/0.15)*np.exp(-((yy-480)/200)**2)
    rgb=np.clip(base*roundness[...,None]*belly[...,None]*clav[...,None]*hl[...,None],0,255)
    seeds=sk&(((yy>=300)&(yy<=420)&(xx>=430)&(xx<=594))|((yy>=700)&(yy<=780)&(xx>=410)&(xx<=614)))
    for side,origin in (("l",(315,250)),("r",(554,250))):
        sh=np.array(Image.open(SVG/f"arm-{side}-shoulder-skin.png").convert("RGBA"))
        x0,y0=origin; th,tw=sh.shape[:2]
        y1,x1=min(h,y0+th),min(w,x0+tw)
        seeds[y0:y1,x0:x1]|=skin_mask(sh[:y1-y0,:x1-x0,:3], sh[:y1-y0,:x1-x0,3])
    rgb[seeds]=master[:,:,:3][seeds].astype(float)
    u8=rgb.astype(np.uint8)
    soft=cv2.bilateralFilter(u8,9,55,55)
    u8=np.where(fill[...,None],soft,u8); u8[seeds]=master[:,:,:3][seeds]
    out=np.zeros((h,w,4),np.uint8); out[:,:,:3]=u8; out[:,:,3]=np.where(fill,255,0).astype(np.uint8)
    dist=cv2.distanceTransform(fill.astype(np.uint8),cv2.DIST_L2,5)
    rim=(cv2.Canny(fill.astype(np.uint8)*255,40,100)>0)&(dist<=2.0)&fill
    out[rim,:3]=(out[rim,:3].astype(float)*0.4+np.array([85.,52.,42.])*0.6).astype(np.uint8)
    # bottom feather
    bot=yy>700
    alpha=out[:,:,3].astype(float)
    edge=(dist<4)&(out[:,:,3]>0)&bot
    alpha[edge]=np.minimum(alpha[edge], dist[edge]/4.0*255)
    out[:,:,3]=np.clip(alpha,0,255).astype(np.uint8)
    out=feather_alpha(out,1.6)
    Image.fromarray(out).save(SVG/"body-backfill.png", optimize=True)
    Image.fromarray(out).save(OUT/"body-backfill-final.png", optimize=True)
    om=out[:,:,3]>=8
    return dict(opaque=int(om.sum()), skin=int(skin_mask(out[:,:,:3],out[:,:,3]).sum()),
                mean=[round(float(x),1) for x in out[:,:,:3][om].mean(0)],
                hw_chest=round(hw_c,1), hw_waist=round(hw_w,1), hw_hip=round(hw_h,1), sha256=sha(SVG/"body-backfill.png"))

def paint_arm(side):
    sl=np.array(Image.open(SVG/f"sleeve-{side}-full.png").convert("RGBA"))
    up=np.array(Image.open(SVG/f"arm-{side}-upper-skin.png").convert("RGBA"))
    palm=np.array(Image.open(SVG/f"hand-{side}-palm.png").convert("RGBA"))
    us=skin_mask(up[:,:,:3],up[:,:,3],180); ps=skin_mask(palm[:,:,:3],palm[:,:,3],180)
    mean_u=up[:,:,:3][us].mean(0) if us.any() else np.array([248.,212.,195.])
    mean_p=palm[:,:,:3][ps].mean(0) if ps.any() else mean_u
    solid=sl[:,:,3]>=200; h,w=solid.shape
    cy=np.full(h,np.nan); half=np.full(h,np.nan)
    for y in range(h):
        xs=np.where(solid[y])[0]
        if len(xs)<4: continue
        cy[y]=0.5*(xs[0]+xs[-1]); half[y]=0.5*(xs[-1]-xs[0])
    ys=np.where(~np.isnan(cy))[0]
    cy=np.interp(np.arange(h),ys,cy[ys]); half_sl=np.interp(np.arange(h),ys,half[ys])
    t=np.linspace(0,1,h); elbow=np.exp(-((t-0.42)/0.06)**2)
    up_w=max(10.0,(up[:,:,3]>=180).sum(1).max()/2.0 if (up[:,:,3]>=180).any() else 16)
    palm_w=max(7.0,(palm[:,:,3]>=180).sum(1).max()/2.0 if (palm[:,:,3]>=180).any() else 11)
    target=up_w*(1-t)**0.85 + palm_w*t**0.9
    target=np.minimum(target*(1+0.12*elbow), half_sl-11); target=np.maximum(target,5.5)
    out=np.zeros_like(sl)
    for y in range(h):
        if half_sl[y]<8: continue
        c,hw=cy[y],target[y]
        for x in range(max(0,int(c-hw-1)), min(w,int(c+hw+1)+1)):
            if not solid[y,x]: continue
            u=(x-c)/hw
            if u*u+0.05>1: continue
            z=np.sqrt(max(0,1-u*u)); shade=0.82+0.20*z
            vt=y/max(h-1,1); col=mean_u*(1-vt)+mean_p*vt
            if abs(vt-0.42)<0.05: shade*=0.94
            out[y,x,:3]=np.clip(col*shade*(1.0+0.06*z),0,255); out[y,x,3]=255
    arm_m=out[:,:,3]>=8
    if arm_m.any():
        rgb=out[:,:,:3].astype(float)
        blur=cv2.GaussianBlur(rgb,(0,0),0.8)
        out[:,:,:3]=np.clip(np.where(arm_m[...,None], blur*0.5+rgb*0.5, rgb),0,255).astype(np.uint8)
        dist=cv2.distanceTransform(arm_m.astype(np.uint8),cv2.DIST_L2,5)
        rim=(cv2.Canny(arm_m.astype(np.uint8)*255,30,90)>0)&(dist<=1.8)
        out[rim,:3]=(out[rim,:3].astype(float)*0.4+np.array([88.,55.,45.])*0.6).astype(np.uint8)
    out=feather_alpha(out,1.4); out[sl[:,:,3]<200,3]=0
    dest=SVG/f"arm-{side}-under-skin.png"
    Image.fromarray(out).save(dest, optimize=True)
    meta=dict(side=side, opaque=int((out[:,:,3]>=8).sum()), sha256=sha(dest),
              mean_u=[round(float(x),1) for x in mean_u], mean_p=[round(float(x),1) for x in mean_p])
    (SVG/f"arm-{side}-under-skin.json").write_text(json.dumps(meta,indent=2)+"\n")
    return meta

def paint_underlayer_top():
    tank=np.array(Image.open(SVG/"torso-tank.png").convert("RGBA"))
    h,w=tank.shape[:2]; yy,xx=np.mgrid[0:h,0:w]
    solid=tank[:,:,3]>=160
    dist=cv2.distanceTransform(solid.astype(np.uint8),cv2.DIST_L2,5)
    bra=solid&(dist>=1)&(yy<=int(h*0.72))
    cx,cy=w/2.0,h*0.02
    bra&=~((((xx-cx)/(w*0.32))**2+((yy-cy)/(h*0.28))**2)<=1)
    for sx in (0.0,1.0):
        acx,acy=sx*w,h*0.35
        bra&=~((((xx-acx)/(w*0.22))**2+((yy-acy)/(h*0.35))**2)<=1)
    out=np.zeros_like(tank)
    base=np.array([36.,34.,38.]); hl=np.array([55.,52.,58.]); shc=np.array([22.,20.,24.])
    for y in range(h):
        xs=np.where(bra[y])[0]
        if len(xs)<2: continue
        c=0.5*(xs[0]+xs[-1])
        for x in xs:
            u=(x-c)/max((xs[-1]-xs[0])/2,1)
            fold=0.5+0.5*np.sin(y/5.0+u*2)
            col=base*(0.92+0.08*fold)+hl*(0.12*(1-u*u))+shc*(0.1*max(0,abs(u)-0.3))
            if y>h*0.55: col=col*0.85+shc*0.15
            out[y,x,:3]=np.clip(col,0,255); out[y,x,3]=255
    strap=np.zeros((h,w),bool)
    for shoulder,neck in ((0.18,0.35),(0.82,0.65)):
        for y in range(0,int(h*0.35)):
            t=y/max(h*0.35,1); xs_=int(w*(shoulder+(neck-shoulder)*t))
            for dx in range(-3,4):
                xx_=xs_+dx
                if 0<=xx_<w and solid[y,xx_]: strap[y,xx_]=True
    bra|=strap; out[strap,:3]=base; out[strap,3]=255
    edge=cv2.Canny(bra.astype(np.uint8)*255,40,100)>0
    out[edge,:3]=(12,10,14); out[~bra,3]=0
    out=feather_alpha(out,1.2)
    dest=SVG/"underlayer-top.png"; Image.fromarray(out).save(dest, optimize=True)
    return dict(opaque=int((out[:,:,3]>=8).sum()), sha256=sha(dest))

def paint_underlayer_bottom():
    shorts=np.array(Image.open(SVG/"shorts.png").convert("RGBA"))
    h,w=shorts.shape[:2]; yy,xx=np.mgrid[0:h,0:w]
    solid=shorts[:,:,3]>=160
    dist=cv2.distanceTransform(solid.astype(np.uint8),cv2.DIST_L2,5)
    bike=solid&(dist>=2)&(yy<=int(h*0.86))
    out=np.zeros_like(shorts)
    base=np.array([34.,32.,36.]); shc=np.array([20.,18.,22.]); hl=np.array([50.,48.,54.]); cx=w/2
    for y in range(h):
        xs=np.where(bike[y])[0]
        if len(xs)<2: continue
        for x in xs:
            u=(x-cx)/(w/2); seam=1.0-0.22*np.exp(-((x-cx)/5.0)**2)
            col=base*(0.9+0.1*(1-min(u*u,1)))*seam
            if y>h*0.7: col=col*0.9+shc*0.1
            col=col+hl*0.08*max(0,abs(u)-0.4)
            out[y,x,:3]=np.clip(col,0,255); out[y,x,3]=255
    edge=cv2.Canny(bike.astype(np.uint8)*255,40,100)>0
    out[edge,:3]=(14,12,16); out[~bike,3]=0
    out=feather_alpha(out,1.2)
    dest=SVG/"underlayer-bottom.png"; Image.fromarray(out).save(dest, optimize=True)
    return dict(opaque=int((out[:,:,3]>=8).sum()), sha256=sha(dest))

def paint_all():
    body=paint_body()
    arms={s: paint_arm(s) for s in "lr"}
    top=paint_underlayer_top(); bot=paint_underlayer_bottom()
    return body, arms, top, bot
