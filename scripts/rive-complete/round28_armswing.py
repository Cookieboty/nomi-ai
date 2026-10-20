#!/usr/bin/env python3
"""ROUND28 item 1 - front-view arm swing for `full.walk` / `full.run` (replaces the R26 arm keys).

R26 drove the arms with a screen-plane rotation of the upper arm (walk +-0.075 rad, run +-0.13 rad + 0.09 rad
abduction) and a constant screen-plane elbow, peaking at the PASSING phase.  In a front view that reads as a
sideways pendulum (wrist x travel 52-57 px walk / 108-111 px run, vertical only 9-24 px), both arms sliding the same
screen direction like a windshield wiper, a quarter cycle off the legs (arm extremes must coincide with the
contralateral foot strike, arms pass vertical at mid-swing).

ROUND28 model - every arm has a SAGITTAL swing theta (forward +) and elbow flexion phi, projected onto the screen:
  upper.scaleX  = cos(theta)                       (upper arm foreshortens; elbow and hand RISE on both extremes)
  fore.scaleX   = max(cos(theta+phi), FMIN)/cos(theta)   (forearm foreshortening; flexed forearm pointing forward)
  hand.scaleY   = HK(beta) / (upper.sx * fore.sx)  (hand bone is rotated ~90 deg to the forearm, so its local y is the
                                                  inherited along-arm axis: undo the inherited squash -> undistorted
                                                  hand/fingers, only a mild own foreshortening)
  coat-X.front.scaleX = 1/upper.sx                  (coat panel hangs from the upper arm but must not foreshorten)
  upper.rotation  rest + ins*LAT*sin(theta) (+ABD)  (small: forward swing drifts toward the midline, back swing out)
  fore.rotation   rest + ins*(E0 + E1*max(g,0))     (forearm angles in across the body on the forward swing)
  shoulder        0.65 x the upper's screen delta (R25 rule)  -> tiny now, no shoulder dragging
Phase: g = +1 means arm-r forward / arm-l back.  walk: g = -sgn*cos(pi*(t-LAG)) per step (extreme at foot contact
of the contralateral leg, zero at passing); run: g = cos(2*pi*(ph-0.95)) (arm-r forward just before the l foot strike).
theta_r = A(g), theta_l = A(-g), asymmetric forward/back amplitudes; all deltas x the clip envelope.
Idempotent: strips and rebuilds its own KeyedObjects inside the two clips."""
from __future__ import annotations
import math, re, sys
import round13_anim as A
import round10_layers as L10
import round26_gait as G

SCENE = L10.PROJECT / "scene.rml"
K_SH = 0.65
P = {
    "walk": dict(Af=0.34, Ab=0.28, phi0=0.24, phi_f=0.20, phi_b=0.0, LAT=0.05, ABD=0.0, E0=0.05, E1=0.06, FMIN=0.55, HK=0.15, LAG=0.06),
    "run":  dict(Af=0.55, Ab=0.60, phi0=1.30, phi_f=0.25, phi_b=0.20, LAT=0.06, ABD=0.03, E0=0.28, E1=0.62, FMIN=0.32, HK=0.25, LAG=0.0,
                 R37=dict(Af=0.60, Ab=0.55, LAT=0.04, ABD=0.12, ABB=0.05, EB=0.20, EF=1.95, U0=0.50,
                          TB=0.80, TF=0.62, DIP=0.50, HK=0.06, HW=0.0)),  # ROUND37: screen-plane ~90 deg elbow
}


def phase(clip, f):
    if clip == "walk":
        o = G.walk_frame(f); sgn = 1.0 if o["swing"] == "l" else -1.0
        g = -sgn * math.cos(math.pi * (o["t"] - P["walk"]["LAG"]))
        return g, o["env"]
    o = G.run_frame(f)
    return math.cos(2 * math.pi * (o["t"] - 0.95)), o["env"]


def arm_pose(clip, g, env, side):
    p = P[clip]; ins = 1.0 if side == "r" else -1.0
    gg = g if side == "r" else -g
    if clip == "run" and "R37" in p:
        return run_pose_r37(p["R37"], gg, env, ins)
    th = (p["Af"] * gg if gg > 0 else p["Ab"] * gg) * env
    phi = (p["phi0"] + p["phi_f"] * max(gg, 0) - p["phi_b"] * max(-gg, 0)) * env
    beta = th + phi
    su = math.cos(th)
    sf = max(math.cos(beta), p["FMIN"] + (1 - p["FMIN"]) * (1 - env)) / su
    hk = 1.0 - p["HK"] * (1 - math.cos(min(abs(beta), math.pi / 2)))
    return dict(th=th, phi=phi, su=su, sf=sf, sh=hk / (su * sf),
                du=ins * (p["LAT"] * math.sin(th) + p["ABD"] * env),
                de=ins * (p["E0"] * env + p["E1"] * max(gg, 0) * env))


def run_pose_r37(q, gg, env, ins):
    """ROUND37 run arms.  R28 sold the ~75-89 deg sagittal elbow purely as forearm FORESHORTENING (fore.scaleX down to
    0.32) with only 16-52 deg of screen-plane bend: the forearm collapsed onto the elbow, the fist stayed at hip /
    crotch height (wrist y 485-581, rest 629) pressed flat on the shorts / thigh / pouch - read as "hands not pumping
    + clipping".  R37 shows the elbow in the SCREEN plane and keeps the fist off the thighs:
      u = (gg+1)/2 (0 = back extreme, 1 = forward extreme), w = smoothstep((u-U0)/(1-U0)) (back half: forearm hangs
      ~vertical beside the hip; forward half: lifts to the ~90+ deg pump)
      fore.rotation  rest + ins*eps, eps = EB + (EF-EB)*w   (back: forearm ~vertical beside the hip; forward ~106 deg:
                                                            fist up in front of the lower chest, toward the midline)
      fore projected length T = TB + (TF-TB)*w - DIP*sin(pi*w): the forearm points at the camera while it lifts, so the
      fist rises next to the elbow (outside the hip) instead of sweeping across the shorts; never collapses (>= 0.35)
      upper: sagittal theta -> scaleX cos(theta); abduction ABD + ABB*(1-u)**2 so the elbow / fist pass OUTSIDE the
             hip on the back swing; hand counter-rotates HW*eps so the fist stays fist-like, scaleY undoes the squash."""
    u = 0.5 * (gg + 1.0)
    th = (q["Af"] * gg if gg > 0 else q["Ab"] * gg) * env
    su = math.cos(th)
    w = min(max((u - q["U0"]) / (1.0 - q["U0"]), 0.0), 1.0); w = w * w * (3 - 2 * w)
    eps = (q["EB"] + (q["EF"] - q["EB"]) * w) * env
    Tu = q["TB"] + (q["TF"] - q["TB"]) * w - q["DIP"] * math.sin(math.pi * w)   # forearm points at the camera mid-lift
    T = 1.0 - (1.0 - Tu) * env
    sf = T / su
    hk = 1.0 - q["HK"] * env
    return dict(th=th, phi=eps, su=su, sf=sf, sh=hk / (su * sf),
                du=ins * (q["LAT"] * math.sin(th) - (q["ABD"] + q["ABB"] * (1 - u) ** 2) * env),  # ins*(+) = inward, so minus = abduct
                de=ins * eps, hand=-ins * q["HW"] * eps)


def main():
    s = SCENE.read_text(encoding="utf-8")
    ids = A.ids_by_name(s)
    rest = {}
    for sd in "lr":
        for b in ("upper", "fore", "hand", "shoulder"):
            n = f"full.arm-{sd}.{b}"
            rest[n] = float(re.search(rf'<RootBone name="{re.escape(n)}"[^>]*rotation="([-\d.]+)"', s).group(1))
    own = {ids[f"full.arm-{sd}.{b}"] for sd in "lr" for b in ("upper", "fore", "hand", "shoulder")} | \
          {ids[f"full.coat-{sd}.front"] for sd in "lr"}
    for clip in ("walk", "run"):
        m = re.search(rf'(<LinearAnimation name="full\.{clip}"[^>]*duration="(\d+)"[^>]*>)(.*?)(\s*</LinearAnimation>)', s, re.S)
        dur = int(m.group(2)); body = m.group(3)
        body = re.sub(r'\s*<KeyedObject objectId="(0:\d+)"><KeyedProperty property="(\w+)">(?:<KeyFrameDouble [^>]*/>)*</KeyedProperty></KeyedObject>',
                      lambda k: "" if (k.group(1) in own and (k.group(2) != "rotation" or "coat" not in
                                       next(n for n, i in ids.items() if i == k.group(1)))) else k.group(0), body)
        frames = list(range(0, dur + 1, 2)) + ([dur] if dur % 2 else [])
        tr = {}
        put = lambda n, pr, f, v: tr.setdefault((ids[n], pr), []).append((f, v))
        for f in frames:
            g, env = phase(clip, f)
            for sd in "lr":
                a = arm_pose(clip, g, env, sd); b = f"full.arm-{sd}."
                put(b + "upper", "rotation", f, rest[b + "upper"] + a["du"])
                put(b + "upper", "scaleX", f, a["su"])
                put(b + "shoulder", "rotation", f, rest[b + "shoulder"] + K_SH * a["du"])
                put(b + "fore", "rotation", f, rest[b + "fore"] + a["de"])
                put(b + "fore", "scaleX", f, a["sf"])
                put(b + "hand", "rotation", f, rest[b + "hand"] + a.get("hand", -0.25 * a["de"]))
                put(b + "hand", "scaleY", f, a["sh"])
                put(f"full.coat-{sd}.front", "scaleX", f, 1.0 / a["su"])
        add = "".join(f'\n            <KeyedObject objectId="{o}"><KeyedProperty property="{pr}">' +
                      "".join(f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="linear"/>' for f, v in kf) +
                      '</KeyedProperty></KeyedObject>' for (o, pr), kf in tr.items())
        s = s[:m.start(3)] + body + add + s[m.end(3):]
        print(f"ROUND28 armswing {clip}: {dur} f, {len(tr)} tracks")
    SCENE.write_text(s, encoding="utf-8")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round28_armswing" not in bt:
        bt = bt.replace("python3 round27_coat_rig.py\n", "python3 round27_coat_rig.py\npython3 round28_armswing.py\n")  # needs the R27 coat-X.front chain
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt)


if __name__ == "__main__":
    main()
