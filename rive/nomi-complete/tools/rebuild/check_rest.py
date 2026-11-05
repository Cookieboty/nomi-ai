"""Compare a 1:1 Rive screenshot of the rest pose with mother-v2 (composited on the screenshot's
background). usage: check_rest.py <screenshot.png> <mother-v2.png>; exits 1 if any pixel is off by > 2."""
import sys
import numpy as np
import cv2

r = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED).astype(int)
m = cv2.imread(sys.argv[2], cv2.IMREAD_UNCHANGED).astype(int)
bg = r[2, 2, :3]
a = m[..., 3:] / 255.0
exp = np.rint(m[..., :3] * a + bg * (1 - a))
d = np.abs(r[..., :3] - exp).max(2)
print(f'rest pose vs mother-v2: max diff {int(d.max())}, pixels off by >2: {int((d > 2).sum())}')
sys.exit(1 if (d > 2).any() else 0)
