"""Mother-space layer compositor for the hand region (diagnostics + before/after sheets)."""
import json, io, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, __file__.rsplit('/',1)[0])
import round9_layers as L
H, W = 1536, 1024
def place(png, box):
    c = Image.new('RGBA', (W, H), (0, 0, 0, 0)); c.paste(png, (box[0], box[1])); return c
def load(name, rev=None, boxes=None):
    boxes = boxes or json.loads(L.META.read_text())['boxes']
    png = L.git_png(rev, name + '.png') if rev else Image.open(L.OUT / (name + '.png')).convert('RGBA')
    return place(png, boxes[name])
def sheet(layers, crop, sc, bgc=(30, 30, 60, 255)):
    bg = Image.new('RGBA', (W, H), bgc)
    for l in layers: bg.alpha_composite(l)
    return bg.crop(crop).resize(((crop[2]-crop[0])*sc, (crop[3]-crop[1])*sc), Image.NEAREST).convert('RGB')
