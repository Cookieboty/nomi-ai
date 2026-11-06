"""Body geometry of the mother image (1024x1536 px): joints and silhouettes used for segmentation,
backfill painting and the skeleton. All coordinates are mother pixels."""
import numpy as np
import cv2

W, H = 1024, 1536

J = {
    'head': (507, 150), 'chin': (500, 238), 'neck_top': (505, 222), 'neck_base': (507, 272),
    'chest': (507, 380), 'waist': (507, 480), 'pelvis': (507, 640),
    'shoulder_l': (398, 318), 'elbow_l': (356, 548), 'wrist_l': (320, 742),
    'shoulder_r': (625, 318), 'elbow_r': (667, 548), 'wrist_r': (700, 742),
    'hip_l': (452, 668), 'knee_l': (469, 1010), 'ankle_l': (465, 1318), 'toe_l': (458, 1490),
    'hip_r': (563, 668), 'knee_r': (558, 1010), 'ankle_r': (570, 1318), 'toe_r': (575, 1490),
}
ARM_L = [J['shoulder_l'], J['elbow_l'], J['wrist_l']]
ARM_R = [J['shoulder_r'], J['elbow_r'], J['wrist_r']]
LEG_L = [J['hip_l'], J['knee_l'], J['ankle_l']]
LEG_R = [J['hip_r'], J['knee_r'], J['ankle_r']]

FACE_POLY = [(440, 108), (562, 108), (580, 150), (577, 190), (556, 206), (526, 229), (500, 239), (474, 229),
             (447, 206), (434, 172)]
NECK_POLY = [(470, 205), (536, 205), (540, 262), (552, 278), (462, 278), (468, 262)]
# bare torso from the shoulder line down to the hips (under tank / belt / shorts)
TORSO_POLY = [(470, 258), (545, 258), (585, 276), (612, 300), (608, 340), (606, 400), (598, 465), (600, 520),
              (612, 600), (618, 660), (600, 700), (560, 712), (507, 706), (455, 712), (414, 700), (396, 660),
              (402, 600), (414, 520), (418, 465), (410, 400), (408, 340), (404, 300), (430, 276)]

_yy, _xx = np.mgrid[0:H, 0:W]


def poly(pts):
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [np.array(pts, np.int32)], 1)
    return m.astype(bool)


def segdist(p, q):
    p = np.array(p, float)
    q = np.array(q, float)
    d = q - p
    t = np.clip(((_xx - p[0]) * d[0] + (_yy - p[1]) * d[1]) / (d @ d), 0, 1)
    return np.hypot(_xx - (p[0] + t * d[0]), _yy - (p[1] + t * d[1]))


def capsule_chain(points, radii):
    """Union of tapered capsules along a polyline (radius interpolated per segment)."""
    m = np.zeros((H, W), bool)
    for (p, q), (r0, r1) in zip(zip(points[:-1], points[1:]), zip(radii[:-1], radii[1:])):
        p = np.array(p, float)
        q = np.array(q, float)
        d = q - p
        t = np.clip(((_xx - p[0]) * d[0] + (_yy - p[1]) * d[1]) / (d @ d), 0, 1)
        dist = np.hypot(_xx - (p[0] + t * d[0]), _yy - (p[1] + t * d[1]))
        m |= dist <= r0 + (r1 - r0) * t
    return m
