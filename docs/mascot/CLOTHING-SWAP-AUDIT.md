# CLOTHING-SWAP-AUDIT（R31a）

**日期**：2026-10-20（Asia/Shanghai）　**基线 tip**：`27caa3c9`（R30）　**分支**：`feat/mascot-rive-full-bone-rig`

## 一句话结论

**尚未可换衣。** 现有「补底」`body-backfill.png` 实际是母图衣身残片（背心+腰带+短裤剪影，肤色仅 53 px），不是裸身底模；隐藏外套后手臂整段消失；隐藏短裤后大腿根开洞；肩肤/短裤侧缝仍烘焙橙色外套像素。本文件只做盘点与缺口量化，不改 scene。

## 覆盖率快照（idle f001 iso 渲染）

| 视图 | 可见 px | skin-like | orange | dark |
|---|---:|---:|---:|---:|
| `all` | 260354 | 108494 | 28632 | 72608 |
| `hide-coat` | 196755 | 90822 | 13681 | 65478 |
| `hide-tank` | 260258 | 108485 | 28618 | 72675 |
| `hide-shorts` | 254922 | 113632 | 27412 | 63483 |
| `hide-belt` | 261096 | 107189 | 27435 | 76895 |
| `hide-shoes` | 234576 | 104534 | 23111 | 63769 |
| `hide-all-garments` | 159786 | 90546 | 5527 | 46118 |
| `only-body-skin` | 111749 | 68313 | 1820 | 33968 |

only-body-skin 肤色占比 **0.611**（理想裸身底应接近 1.0 且 dark≈0）。判定：NOT swap-ready: body-backfill is garment-colored (dark leftover >> skin); arms incomplete under coat; socks fused to legs

## 隐藏各衣层后的破洞风险

| 隐藏组 | 相对全身丢失 px | 变色 px | 说明 |
|---|---:|---:|---|
| `hide-coat` | 63662 | 1624 | 手臂上臂/前臂整段消失（袖下无连续肤色）；肩头残留橙色（shoulder-skin 融合）；躯干仍见 tank（独立层）+ backfill 衣身 |
| `hide-tank` | 250 | 171 | 几乎无变化：tank 像素大多与 body-backfill 重叠/被外套遮挡；隐藏 tank 后仍见 backfill 里烘焙的背心 |
| `hide-shorts` | 5836 | 8363 | 短裤主体消失后大腿根出现水平缺口；橙色侧片部分仍在 shorts 内故一并消失，但 neutral/backfill 可能残留碎片 |
| `hide-belt` | 377 | 7323 | 腰带/工牌/腰包层消失，但 backfill 内仍烘焙腰带轮廓与孔洞 |
| `hide-shoes` | 25778 | 74 | 鞋消失后可见袜（烘焙在 leg-skin）与部分脚踝；无独立袜层 |
| `hide-all-garments` | 101496 | 11512 | 仍见 tank+belt+shorts 剪影（来自 body-backfill）；手臂缺失；大腿根缺口；肩橙碎片；袜在腿上 |

## 部件分类总表

| Image 节点 | 贴图 | 分类 | 驱动 | 不透明 px | skin | orange | 融合备注 |
|---|---|---|---|---:|---:|---:|---|
| `full.arm-l.upper-skin.image` | `arm-l-upper-skin` | **body-skin** | arm-l.upper | 1740 | 1740 | 6 | — |
| `full.coat-l.front.image` | `coat-l-front` | **garment-coat** | arm-l.upper, arm-l.fore, coat-l.front, coat-l.front.s1 | 9848 | 2933 | 1114 | — |
| `full.sleeve-l.full.image` | `sleeve-l-full` | **garment-coat** | arm-l.upper, arm-l.fore, arm-l.hand | 35280 | 7916 | 3823 | — |
| `full.sleeve-l.full.dark.image` | `sleeve-l-full-dark` | **garment-coat** | arm-l.upper, arm-l.fore, arm-l.hand | 2278 | 0 | 0 | — |
| `full.arm-l.cuff.image` | `arm-l-cuff` | **garment-coat** | arm-l.fore, arm-l.hand | 6447 | 1159 | 15 | — |
| `full.hand-l.palm.image` | `hand-l-palm` | **body-skin** | arm-l.hand, arm-l.fore | 1407 | 1344 | 28 | — |
| `full.hand-l.web.image` | `hand-l-web` | **body-skin** | arm-l.hand, arm-l.thumb, arm-l.index | 220 | 220 | 0 | — |
| `full.hand-l.little.image` | `hand-l-little` | **body-skin** | arm-l.little, arm-l.little.1, arm-l.little.2 | 198 | 191 | 36 | — |
| `full.hand-l.ring.image` | `hand-l-ring` | **body-skin** | arm-l.ring, arm-l.ring.1, arm-l.ring.2 | 238 | 231 | 38 | — |
| `full.hand-l.middle.image` | `hand-l-middle` | **body-skin** | arm-l.middle, arm-l.middle.1, arm-l.middle.2 | 245 | 234 | 42 | — |
| `full.hand-l.index.image` | `hand-l-index` | **body-skin** | arm-l.index, arm-l.index.1, arm-l.index.2 | 947 | 910 | 91 | — |
| `full.hand-l.thumb.image` | `hand-l-thumb` | **body-skin** | arm-l.thumb, arm-l.thumb.1, arm-l.thumb.2 | 1424 | 1383 | 125 | orange baked into body layer (125px) |
| `full.arm-r.upper-skin.image` | `arm-r-upper-skin` | **body-skin** | arm-r.upper | 1506 | 1285 | 208 | orange baked into body layer (208px) |
| `full.coat-r.front.image` | `coat-r-front` | **garment-coat** | arm-r.upper, arm-r.fore, coat-r.front, coat-r.front.s1 | 5494 | 1239 | 376 | — |
| `full.sleeve-r.full.image` | `sleeve-r-full` | **garment-coat** | arm-r.upper, arm-r.fore, arm-r.hand | 31879 | 10234 | 2697 | — |
| `full.sleeve-r.full.dark.image` | `sleeve-r-full-dark` | **garment-coat** | arm-r.upper, arm-r.fore, arm-r.hand | 1773 | 0 | 0 | — |
| `full.arm-r.cuff.image` | `arm-r-cuff` | **garment-coat** | arm-r.fore, arm-r.hand | 6089 | 1436 | 7 | — |
| `full.hand-r.palm.image` | `hand-r-palm` | **body-skin** | arm-r.hand, arm-r.fore | 2098 | 1942 | 80 | — |
| `full.hand-r.web.image` | `hand-r-web` | **body-skin** | arm-r.hand, arm-r.thumb, arm-r.index | 191 | 191 | 0 | — |
| `full.hand-r.little.image` | `hand-r-little` | **body-skin** | arm-r.little, arm-r.little.1, arm-r.little.2 | 110 | 109 | 28 | — |
| `full.hand-r.ring.image` | `hand-r-ring` | **body-skin** | arm-r.ring, arm-r.ring.1, arm-r.ring.2 | 176 | 174 | 25 | — |
| `full.hand-r.middle.image` | `hand-r-middle` | **body-skin** | arm-r.middle, arm-r.middle.1, arm-r.middle.2 | 219 | 217 | 28 | — |
| `full.hand-r.index.image` | `hand-r-index` | **body-skin** | arm-r.index, arm-r.index.1, arm-r.index.2 | 708 | 690 | 60 | — |
| `full.hand-r.thumb.image` | `hand-r-thumb` | **body-skin** | arm-r.thumb, arm-r.thumb.1, arm-r.thumb.2 | 974 | 947 | 88 | — |
| `full.belt.band.image` | `belt-band` | **garment-belt** | torso, pelvis | 8421 | 485 | 1041 | — |
| `full.belt.id.image` | `belt-id` | **garment-belt** | belt.id | 7488 | 1378 | 1213 | — |
| `full.belt.pouch.image` | `belt-pouch` | **garment-belt** | belt.pouch | 5676 | 367 | 160 | — |
| `full.shorts.image` | `shorts` | **garment-shorts** | pelvis, leg-l.upper, leg-r.upper | 49417 | 2364 | 2162 | orange side fragments fused into shorts texture |
| `full.choker.image` | `choker` | **accessory** | torso, spine | 4466 | 177 | 85 | — |
| `full.hair.back.l.image` | `hair-back-l` | **body-hair** | head, hair.back.l.s1, hair.back.l.s2 | 2373 | 1309 | 749 | orange baked into body layer (749px) |
| `full.hair.back.r.image` | `hair-back-r` | **body-hair** | head, hair.back.r.s1, hair.back.r.s2 | 1438 | 1095 | 442 | orange baked into body layer (442px) |
| `full.hair.lock.l.image` | `hair-lock-l` | **body-hair** | head, hair.lock.l.s1, hair.lock.l.s2, hair.lock.l.s3 | 9113 | 262 | 535 | orange baked into body layer (535px) |
| `full.hair.lock.r.image` | `hair-lock-r` | **body-hair** | head, hair.lock.r.s1, hair.lock.r.s2, hair.lock.r.s3 | 7090 | 2015 | 2181 | orange baked into body layer (2181px) |
| `full.hair.bow.image` | `hair-bow` | **accessory** | hair.bow | 6 | 6 | 0 | essentially empty (bow pixels live elsewhere / head) |
| `full.hair.clip.image` | `hair-clip` | **accessory** | hair.clip | 209 | 192 | 0 | — |
| `full.brow.l.image` | `brow-l` | **body-skin** | brow.l | 93 | 2 | 0 | — |
| `full.brow.r.image` | `brow-r` | **body-skin** | brow.r | 123 | 43 | 0 | — |
| `full.bangs.a.image` | `bangs-a` | **body-hair** | head, bangs.a.s1, bangs.a.s2 | 2148 | 514 | 37 | — |
| `full.bangs.b.image` | `bangs-b` | **body-hair** | head, bangs.b.s1, bangs.b.s2 | 3276 | 1587 | 146 | orange baked into body layer (146px) |
| `full.bangs.c.image` | `bangs-c` | **body-hair** | head, bangs.c.s1, bangs.c.s2 | 1542 | 268 | 42 | — |
| `full.head.image` | `head` | **body-skin** | head, torso, spine | 35923 | 16952 | 870 | orange baked into body layer (870px) |
| `full.eye2.l.lash.image` | `eye-l-lash` | **body-skin** | eye2.l.lash | 450 | 200 | 22 | — |
| `full.eye2.l.lid.image` | `eye-l-lid` | **body-skin** | eye2.l | 208 | 185 | 1 | — |
| `full.eye2.l.hl.image` | `eye-l-hl` | **body-skin** | eye2.l.ball | 23 | 5 | 0 | — |
| `full.eye2.l.iris.image` | `eye-l-iris` | **body-skin** | eye2.l.ball | 414 | 183 | 63 | — |
| `full.eye2.l.sclera.image` | `eye-l-sclera` | **body-skin** | eye2.l.ball | 418 | 223 | 20 | — |
| `full.eye2.l.skin.image` | `eye-l-skin` | **body-skin** | eye2.l | 1164 | 1164 | 0 | — |
| `full.eye2.r.lash.image` | `eye-r-lash` | **body-skin** | eye2.r.lash | 465 | 183 | 8 | — |
| `full.eye2.r.lid.image` | `eye-r-lid` | **body-skin** | eye2.r | 237 | 194 | 2 | — |
| `full.eye2.r.hl.image` | `eye-r-hl` | **body-skin** | eye2.r.ball | 20 | 7 | 0 | — |
| `full.eye2.r.iris.image` | `eye-r-iris` | **body-skin** | eye2.r.ball | 464 | 198 | 68 | — |
| `full.eye2.r.sclera.image` | `eye-r-sclera` | **body-skin** | eye2.r.ball | 492 | 289 | 25 | — |
| `full.eye2.r.skin.image` | `eye-r-skin` | **body-skin** | eye2.r | 1253 | 1253 | 0 | — |
| `full.face.smile` | `face-smile` | **body-skin** | head | 203 | 34 | 0 | — |
| `full.mouth.image` | `mouth` | **body-skin** | head, torso, spine | 3189 | 2975 | 54 | — |
| `full.eye.l.image` | `eye-l` | **body-skin** | eye.l | 2379 | 1661 | 78 | — |
| `full.eye.r.image` | `eye-r` | **body-skin** | eye.r | 1871 | 932 | 49 | — |
| `full.hair.tip.l.image` | `hair-tip-l` | **body-hair** | torso, spine | 137 | 83 | 5 | — |
| `full.hair.l.image` | `hair-l` | **body-hair** | head, hair.lock.l.s1, hair.lock.l.s2, hair.lock.l.s3 | 1304 | 55 | 18 | — |
| `full.hair.r.image` | `hair-r` | **body-hair** | head, hair.lock.r.s1, hair.lock.r.s2, hair.lock.r.s3 | 503 | 384 | 7 | — |
| `full.torso.tank.image` | `torso-tank` | **garment-tank** | torso, spine, pelvis | 25365 | 235 | 365 | orange fringe on tank edges (coat bleed) |
| `full.shoe.l.image` | `shoe-l` | **garment-shoes** | leg-l.foot | 19982 | 2641 | 3781 | — |
| `full.leg.l.skin.image` | `leg-l-skin` | **body-skin** | leg-l.upper, leg-l.lower, leg-l.foot | 50775 | 42068 | 229 | orange baked into body layer (229px); socks appear baked into leg skin (large white region) |
| `full.shoe.r.image` | `shoe-r` | **garment-shoes** | leg-r.foot | 20614 | 3386 | 4193 | — |
| `full.leg.r.skin.image` | `leg-r-skin` | **body-skin** | leg-r.upper, leg-r.lower, leg-r.foot | 52989 | 46684 | 562 | orange baked into body layer (562px); socks appear baked into leg skin (large white region) |
| `full.hem.ribbon.l.image` | `hem-ribbon-l` | **garment-coat** | hem.ribbon.l, hem.ribbon.l.s1, hem.ribbon.l.s2, hem.ribbon.l.s3 | 8379 | 2687 | 7040 | — |
| `full.hem.ribbon.r.image` | `hem-ribbon-r` | **garment-coat** | hem.ribbon.r, hem.ribbon.r.s1, hem.ribbon.r.s2, hem.ribbon.r.s3 | 7521 | 2764 | 6753 | — |
| `full.arm-l.shoulder-skin.static` | `arm-l-shoulder-skin` | **body-skin** | torso, arm-l.shoulder, arm-l.upper, spine | 3957 | 3621 | 372 | orange baked into body layer (372px); coat orange rim fused into shoulder skin |
| `full.arm-r.shoulder-skin.static` | `arm-r-shoulder-skin` | **body-skin** | torso, arm-r.shoulder, arm-r.upper, spine | 3963 | 3422 | 307 | orange baked into body layer (307px); coat orange rim fused into shoulder skin |
| `full.arm-l.sleeve-stump.static` | `sleeve-l-stump` | **garment-coat** | torso, arm-l.shoulder, arm-l.upper, spine | 18192 | 6580 | 2878 | — |
| `full.arm-r.sleeve-stump.static` | `sleeve-r-stump` | **garment-coat** | torso, arm-r.shoulder, arm-r.upper, spine | 16118 | 5979 | 1850 | — |
| `full.arm-l.coat-shoulder.static` | `coat-l-shoulder` | **garment-coat** | torso, arm-l.shoulder, arm-l.upper, spine | 6895 | 5687 | 1291 | — |
| `full.arm-l.coat-shoulder.lining.static` | `coat-l-shoulder-lining` | **garment-coat** | torso, arm-l.upper, spine | 4793 | 389 | 339 | — |
| `full.arm-l.coat-shoulder.dark.static` | `coat-l-shoulder-dark` | **garment-coat** | torso, arm-l.upper, spine | 4368 | 122 | 125 | — |
| `full.arm-r.coat-shoulder.static` | `coat-r-shoulder` | **garment-coat** | torso, arm-r.shoulder, arm-r.upper, spine | 7610 | 5819 | 1582 | — |
| `full.arm-r.coat-shoulder.lining.static` | `coat-r-shoulder-lining` | **garment-coat** | torso, arm-r.upper, spine | 3040 | 303 | 284 | — |
| `full.arm-r.coat-shoulder.dark.static` | `coat-r-shoulder-dark` | **garment-coat** | torso, arm-r.upper, spine | 2655 | 102 | 104 | — |
| `full.neutral` | `fullbody-base-no-head-arms` | **fused-base** | torso, pelvis, spine | 3934 | 792 | 1024 | base layer contains mother garment pixels, not bare skin |
| `full.body.backfill` | `body-backfill` | **fused-base** | torso, pelvis, spine | 48846 | 53 | 211 | base layer contains mother garment pixels, not bare skin; only 53 skin-like px — NOT a bare-body base |

## 按换衣目标分组（期望 vs 现状）

| 换衣槽 | 期望内容 | 现状 | 缺口 |
|---|---|---|---|
| **BODY 裸身底** | 连续肤色：躯干+颈+上臂+前臂+骨盆+大腿根 | `body-backfill` 为深色衣身；手臂肤仅肩头/上臂小片；腿从大腿中段起 | 需整幅肤色躯干+臂补全+髋补全 |
| **内衣/底衣** | tank 可独立显隐 | `torso-tank` 独立，但 backfill 重复烘焙背心 → 隐 tank 几乎无变化 | 从 backfill 删除背心像素 |
| **外套** | 袖+肩+前片+下摆飘带+袖口 可整组隐 | R27/R30 已拆前片与袖补底；肩 cap/stump/lining 已独立 | 肩肤仍含橙边；隐外套露臂洞 |
| **短裤** | 短裤本体；侧橙可归短裤或独立饰片 | `shorts.png` 含侧橙 2162 px | 侧橙未分轨；隐短裤露髋洞 |
| **腰带组件** | band / id / pouch 已三件 | 节点已分，但 backfill 仍画腰带 | 清 backfill |
| **鞋袜** | 袜、鞋可分 | 鞋独立；袜烘焙进 leg-skin | 需拆袜层或接受袜属身体 |
| **饰品** | choker、蝴蝶结、发夹、工牌 | choker/clip 有图；`hair-bow.png` 仅 6 px（结在头发层） | 蝴蝶结需从头发拆或标为头发一体 |

## 绘制顺序（scene 文档序，共 79 Image）

现状大致：臂/袖/手 → 腰带/短裤/颈饰/头髮五官 → tank → 鞋/腿 → 飘带 → 肩静态外套件 → neutral(opa0) → **body.backfill**。

**换衣友好顺序建议**：body-skin → socks → tank/underwear → shorts → belt → coat(stump→shoulder→sleeve→front→hem) → shoes → accessories(choker/bow/clip/badges)。

## 阻塞清单（到真正可换衣还需）

1. body-backfill.png is dark garment torso (53 skin px), not bare skin
2. no continuous arm skin under sleeves (hide-coat severs arms)
3. hip/crotch gap when shorts hidden (legs start mid-thigh)
4. orange coat rim fused into arm-*-shoulder-skin
5. orange side fragments fused into shorts.png
6. socks baked into leg-*-skin; no sock layer
7. hair-bow.png nearly empty (6 px)
8. tank hide is a no-op visually because backfill duplicates tank
9. draw-order not grouped as body→underwear→tops→outerwear→accessories

## 交付预览

- `layers/hide-*` / `layers/only-*`：各衣层 iso 隐藏/独显
- `audit/tex-*`：关键贴图预览
- `clothing-swap-inventory.json`：机器可读清单

