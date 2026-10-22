# CLOTHING-SWAP-AUDIT（R31 更新）

> R31b/c 后：`body-backfill` 已是肤色底（dark≈0）；`arm-*-under-skin` 已挂；短裤侧橙已独立。  
> **仍非完全可换衣** — 见 `CLOTHING-SWAP-CONTRACT.md`「仍非 swap-ready」与 `REPORT` 残留。

# CLOTHING-SWAP-AUDIT

Images: 82. body-backfill skin=102417 dark=0 opaque=102418.
swap_ready: false. blockers: 8.

| image | file | category | opaque | skin | orange | notes |
|---|---|---|---:|---:|---:|---|
| `full.arm-l.upper-skin.image` | `arm-l-upper-skin` | body-skin | 1740 | 1740 | 6 | — |
| `full.coat-l.front.image` | `coat-l-front` | garment-coat | 9848 | 2933 | 1114 | — |
| `full.sleeve-l.full.image` | `sleeve-l-full` | garment-coat | 35280 | 7916 | 3823 | — |
| `full.sleeve-l.full.dark.image` | `sleeve-l-full-dark` | garment-coat | 2278 | 0 | 0 | — |
| `full.arm-l.under-skin.image` | `arm-l-under-skin` | UNCLASSIFIED | 21805 | 21805 | 0 | — |
| `full.arm-l.cuff.image` | `arm-l-cuff` | garment-coat | 6447 | 1159 | 15 | — |
| `full.hand-l.palm.image` | `hand-l-palm` | body-skin | 1407 | 1344 | 28 | — |
| `full.hand-l.web.image` | `hand-l-web` | body-skin | 220 | 220 | 0 | — |
| `full.hand-l.little.image` | `hand-l-little` | body-skin | 198 | 191 | 36 | — |
| `full.hand-l.ring.image` | `hand-l-ring` | body-skin | 238 | 231 | 38 | — |
| `full.hand-l.middle.image` | `hand-l-middle` | body-skin | 245 | 234 | 42 | — |
| `full.hand-l.index.image` | `hand-l-index` | body-skin | 947 | 910 | 91 | — |
| `full.hand-l.thumb.image` | `hand-l-thumb` | body-skin | 1424 | 1383 | 125 | orange baked into body layer (125px) |
| `full.arm-r.upper-skin.image` | `arm-r-upper-skin` | body-skin | 1506 | 1285 | 208 | orange baked into body layer (208px) |
| `full.coat-r.front.image` | `coat-r-front` | garment-coat | 5494 | 1239 | 376 | — |
| `full.sleeve-r.full.image` | `sleeve-r-full` | garment-coat | 31879 | 10234 | 2697 | — |
| `full.sleeve-r.full.dark.image` | `sleeve-r-full-dark` | garment-coat | 1773 | 0 | 0 | — |
| `full.arm-r.under-skin.image` | `arm-r-under-skin` | UNCLASSIFIED | 18286 | 18286 | 0 | — |
| `full.arm-r.cuff.image` | `arm-r-cuff` | garment-coat | 6089 | 1436 | 7 | — |
| `full.hand-r.palm.image` | `hand-r-palm` | body-skin | 2098 | 1942 | 80 | — |
| `full.hand-r.web.image` | `hand-r-web` | body-skin | 191 | 191 | 0 | — |
| `full.hand-r.little.image` | `hand-r-little` | body-skin | 110 | 109 | 28 | — |
| `full.hand-r.ring.image` | `hand-r-ring` | body-skin | 176 | 174 | 25 | — |
| `full.hand-r.middle.image` | `hand-r-middle` | body-skin | 219 | 217 | 28 | — |
| `full.hand-r.index.image` | `hand-r-index` | body-skin | 708 | 690 | 60 | — |
| `full.hand-r.thumb.image` | `hand-r-thumb` | body-skin | 974 | 947 | 88 | — |
| `full.belt.band.image` | `belt-band` | garment-belt | 8421 | 485 | 1041 | — |
| `full.belt.id.image` | `belt-id` | garment-belt | 7488 | 1378 | 1213 | — |
| `full.belt.pouch.image` | `belt-pouch` | garment-belt | 5676 | 367 | 160 | — |
| `full.shorts.side-orange.image` | `shorts-side-orange` | UNCLASSIFIED | 4284 | 1764 | 2130 | — |
| `full.shorts.image` | `shorts` | garment-shorts | 45133 | 600 | 32 | — |
| `full.choker.image` | `choker` | accessory | 4466 | 177 | 85 | — |
| `full.hair.back.l.image` | `hair-back-l` | body-hair | 2373 | 1309 | 749 | orange baked into body layer (749px) |
| `full.hair.back.r.image` | `hair-back-r` | body-hair | 1438 | 1095 | 442 | orange baked into body layer (442px) |
| `full.hair.lock.l.image` | `hair-lock-l` | body-hair | 9113 | 262 | 535 | orange baked into body layer (535px) |
| `full.hair.lock.r.image` | `hair-lock-r` | body-hair | 7090 | 2015 | 2181 | orange baked into body layer (2181px) |
| `full.hair.bow.image` | `hair-bow` | accessory | 6 | 6 | 0 | essentially empty (bow pixels live elsewhere) |
| `full.hair.clip.image` | `hair-clip` | accessory | 209 | 192 | 0 | — |
| `full.brow.l.image` | `brow-l` | body-skin | 93 | 2 | 0 | — |
| `full.brow.r.image` | `brow-r` | body-skin | 123 | 43 | 0 | — |
| `full.bangs.a.image` | `bangs-a` | body-hair | 2148 | 514 | 37 | — |
| `full.bangs.b.image` | `bangs-b` | body-hair | 3276 | 1587 | 146 | orange baked into body layer (146px) |
| `full.bangs.c.image` | `bangs-c` | body-hair | 1542 | 268 | 42 | — |
| `full.head.image` | `head` | body-skin | 35923 | 16952 | 870 | orange baked into body layer (870px) |
| `full.eye2.l.lash.image` | `eye-l-lash` | body-skin | 450 | 200 | 22 | — |
| `full.eye2.l.lid.image` | `eye-l-lid` | body-skin | 208 | 185 | 1 | — |
| `full.eye2.l.hl.image` | `eye-l-hl` | body-skin | 23 | 5 | 0 | — |
| `full.eye2.l.iris.image` | `eye-l-iris` | body-skin | 414 | 183 | 63 | — |
| `full.eye2.l.sclera.image` | `eye-l-sclera` | body-skin | 418 | 223 | 20 | — |
| `full.eye2.l.skin.image` | `eye-l-skin` | body-skin | 1164 | 1164 | 0 | — |
| `full.eye2.r.lash.image` | `eye-r-lash` | body-skin | 465 | 183 | 8 | — |
| `full.eye2.r.lid.image` | `eye-r-lid` | body-skin | 237 | 194 | 2 | — |
| `full.eye2.r.hl.image` | `eye-r-hl` | body-skin | 20 | 7 | 0 | — |
| `full.eye2.r.iris.image` | `eye-r-iris` | body-skin | 464 | 198 | 68 | — |
| `full.eye2.r.sclera.image` | `eye-r-sclera` | body-skin | 492 | 289 | 25 | — |
| `full.eye2.r.skin.image` | `eye-r-skin` | body-skin | 1253 | 1253 | 0 | — |
| `full.face.smile` | `face-smile` | body-skin | 203 | 34 | 0 | — |
| `full.mouth.image` | `mouth` | body-skin | 3189 | 2975 | 54 | — |
| `full.eye.l.image` | `eye-l` | body-skin | 2379 | 1661 | 78 | — |
| `full.eye.r.image` | `eye-r` | body-skin | 1871 | 932 | 49 | — |
| `full.hair.tip.l.image` | `hair-tip-l` | body-hair | 137 | 83 | 5 | — |
| `full.hair.l.image` | `hair-l` | body-hair | 1304 | 55 | 18 | — |
| `full.hair.r.image` | `hair-r` | body-hair | 503 | 384 | 7 | — |
| `full.torso.tank.image` | `torso-tank` | garment-tank | 25365 | 235 | 365 | orange fringe on tank edges |
| `full.shoe.l.image` | `shoe-l` | garment-shoes | 19982 | 2641 | 3781 | — |
| `full.leg.l.skin.image` | `leg-l-skin` | body-skin | 50775 | 42068 | 229 | orange baked into body layer (229px); socks appear baked into leg skin |
| `full.shoe.r.image` | `shoe-r` | garment-shoes | 20614 | 3386 | 4193 | — |
| `full.leg.r.skin.image` | `leg-r-skin` | body-skin | 52989 | 46684 | 562 | orange baked into body layer (562px); socks appear baked into leg skin |
| `full.hem.ribbon.l.image` | `hem-ribbon-l` | garment-coat | 8379 | 2687 | 7040 | — |
| `full.hem.ribbon.r.image` | `hem-ribbon-r` | garment-coat | 7521 | 2764 | 6753 | — |
| `full.arm-l.shoulder-skin.static` | `arm-l-shoulder-skin` | body-skin | 3957 | 3652 | 65 | — |
| `full.arm-r.shoulder-skin.static` | `arm-r-shoulder-skin` | body-skin | 3963 | 3366 | 20 | — |
| `full.arm-l.sleeve-stump.static` | `sleeve-l-stump` | garment-coat | 18192 | 6580 | 2878 | — |
| `full.arm-r.sleeve-stump.static` | `sleeve-r-stump` | garment-coat | 16118 | 5979 | 1850 | — |
| `full.arm-l.coat-shoulder.static` | `coat-l-shoulder` | garment-coat | 6895 | 5687 | 1291 | — |
| `full.arm-l.coat-shoulder.lining.static` | `coat-l-shoulder-lining` | garment-coat | 4793 | 389 | 339 | — |
| `full.arm-l.coat-shoulder.dark.static` | `coat-l-shoulder-dark` | garment-coat | 4368 | 122 | 125 | — |
| `full.arm-r.coat-shoulder.static` | `coat-r-shoulder` | garment-coat | 7610 | 5819 | 1582 | — |
| `full.arm-r.coat-shoulder.lining.static` | `coat-r-shoulder-lining` | garment-coat | 3040 | 303 | 284 | — |
| `full.arm-r.coat-shoulder.dark.static` | `coat-r-shoulder-dark` | garment-coat | 2655 | 102 | 104 | — |
| `full.neutral` | `fullbody-base-no-head-arms` | fused-base | 3934 | 792 | 1024 | base layer contains mother garment pixels, not bare skin |
| `full.body.backfill` | `body-backfill` | fused-base | 102418 | 102417 | 6 | base layer contains mother garment pixels, not bare skin |

## Blockers

- body-backfill converted toward skin — re-check hole-scan
- no continuous arm skin under sleeves (hide-coat severs arms)
- hip/crotch gap when shorts hidden (legs start mid-thigh)
- orange coat rim fused into arm-*-shoulder-skin
- orange side fragments fused into shorts.png
- socks baked into leg-*-skin; no sock layer
- hair-bow.png nearly empty (6 px)
- draw-order not grouped as body→underwear→tops→outerwear→accessories
