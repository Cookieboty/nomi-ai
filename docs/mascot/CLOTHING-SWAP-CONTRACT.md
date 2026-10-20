# Nomi·诺米 Clothing Swap Contract（R31d → R33a–c socks/strap/bow → R34 belt/pouch/badge）

**日期**：2026-10-20（Asia/Shanghai）　**分支**：`feat/mascot-rive-full-bone-rig`  
**状态**：层节点已分组文档化；**尚未**接入 StateMachine 显隐 Input（避免打断 `RIVE_NATIVE_MOTIONS`）。换衣时按下列 **Image 节点集合** 设 `opacity=0`（或替换贴图）。

## 共享底模（不可随单件衣服删除）

| 槽 | Image 节点 | 贴图 | 骨骼 |
|---|---|---|---|
| 裸身躯干/髋 | `full.body.backfill` | `body-backfill.png` | torso / spine / pelvis（R28） |
| 肩肤 | `full.arm-{l,r}.shoulder-skin.static` | `arm-*-shoulder-skin.png` | torso + shoulder + upper |
| 上臂肤 | `full.arm-{l,r}.upper-skin.image` | `arm-*-upper-skin.png` | upper |
| 袖下臂肤 | `full.arm-{l,r}.under-skin.image` | `arm-*-under-skin.png` | 与 sleeve 同腱（upper/fore/hand） |
| 手 | `full.hand-{l,r}.*` | `hand-*.png` | 手指链 |
| 腿 | `full.leg.{l,r}.skin.image` | `leg-*-skin.png` | upper/lower/foot（R33a 起**不含袜**） |
| 头/五官/发 | `full.head.*` / eyes / bangs / hair.* | 对应 PNG | head 链 |
| 残片底（通常 opa0） | `full.neutral` | `fullbody-base-no-head-arms.png` | torso/pelvis |

## 可替换衣槽（Garment slots）

### 1. `tank` 背心
- **Images**: `full.torso.tank.image`
- **Assets**: `torso-tank.png`
- **Bones**: torso / spine / pelvis 蒙皮（R28）
- **替换**: 换 PNG + 更新 `DETAIL_LICENSE.json`；网格可复用
- **隐藏风险**: R31b 后露出 `body.backfill` 肤色；颈口/袖笼若新衣更短需再扩肤

### 2. `coat` 外套（整组）
- **Images**:
  - 袖: `full.sleeve-{l,r}.full.image`, `full.sleeve-{l,r}.full.dark.image`
  - 前片: `full.coat-{l,r}.front.image`
  - 肩: `full.arm-{l,r}.coat-shoulder.static`, `.lining.static`, `.dark.static`
  - 袖根: `full.arm-{l,r}.sleeve-stump.static`
  - 袖口: `full.arm-{l,r}.cuff.image`
  - 下摆飘带: `full.hem.ribbon.{l,r}.image`
- **Bones**: sleeveHang / coat-X.front 链 / hem.ribbon 链 / shoulder 辅助
- **隐藏风险**: 露出 arm-under-skin + shoulder-skin；飘带消失
- **勿删**: arm-under-skin（属身体）

### 3. `shorts` 短裤
- **Images**: `full.shorts.image`
- **Assets**: `shorts.png`
- **Bones**: pelvis + leg upper
- **隐藏风险**: 髋下仍可能有缝（腿顶与 backfill 衔接）；大腿绑带已独立为 `thigh-strap`（R33b）

### 4. `shorts-orange` 短裤侧橙饰
- **Images**: `full.shorts.side-orange.image`
- **Assets**: `shorts-side-orange.png`
- **Bones**: 与 shorts 同网格
- **说明**: R31c 从 shorts 迁出；可随短裤一起隐，或单独作饰品槽

### 5. `belt` 腰带（R34a）
- **Images**: `full.belt.band.image`
- **Assets**: `belt-band.png`（**仅**皮带：黑皮带 + 银扣 + 皮带上的橙扣环；R34a 前是含背心/短裤布料、外套橙边的矩形裁片）
- **Bones**: torso（上沿）→ pelvis（下沿）平滑蒙皮，跟髋倾斜
- **隐藏后**: 露出 `full.shorts.waist-backfill.image`（短裤腰头布料，程序化 inpaint，不是肤色）
- **说明**: 挂工牌的橙绳环、挂包的橙带上段若在皮带面上则留在皮带层（视觉上是皮带扣环）；皮带下方的绳/带段属工牌/挂包层

### 5a. `shorts-waist` 短裤腰头回填（R34a，属 shorts 组）
- **Images**: `full.shorts.waist-backfill.image`
- **Assets**: `waist-backfill.png`（旧皮带裁片中的非皮带像素**迁入** + 皮带下 inpaint 布料 + 淡腰缝）
- **Bones**: 克隆皮带网格（torso→pelvis）
- **绘制序**: 皮带 / 工牌 / 挂包 之后、短裤之前
- **隐藏**: 随 `shorts` 一起隐；单独隐背心时腰头上沿仍在（看作高腰短裤）

### 5b. `pouch` 腰包（R34b）
- **Images**: `full.belt.pouch.image`
- **Assets**: `belt-pouch.png`（96×112；仅包体+翻盖+橙标+侧绳+挂带+橙扣/银环；R34b 前为含短裤布料的裁片，且包右下一条被融在 `coat-r-front.png` 里）
- **Bones**: 蒙皮网格：挂带行（y≤446）= pelvis，y 446→462 平滑过渡到 `full.belt.pouch`（pelvis 子骨，枢轴≈(552.8,436.7)）
- **二次运动**: idle 原有 rotation 关键帧保留；walk/run/hop/squat/step 新增阻尼摆（枢轴世界加速度 + 盆骨转角驱动）rotation + 小幅 y 弹跳（≤2px）
- **绘制序**: 在 `coat-r.front` 之前（包在外套前襟之前，与原画一致）；`arm-r.upper-skin` 仍在其前
- **隐藏后**: 露出 `shorts.png` 的平滑回填（normalized-conv 均色 + 淡褶，程序化）与 `coat-r-front` 白边 inpaint
- **隐藏风险**: 包下短裤为平涂暗布，与原布料交界处可见色块边

### 6. `shoes` 鞋
- **Images**: `full.shoe.{l,r}.image`
- **Assets**: `shoe-*.png`
- **隐藏后**: 可见独立袜层 `sock-{l,r}`（R33a）

### 7b. `thigh-strap` 大腿绑带（R33b）
- **Images**: `full.thigh-strap.image`
- **Assets**: `thigh-strap.png`
- **Bones**: 与 `leg-l-skin` 同网格（upper/lower/foot；绑带区权重在大腿 upper）
- **说明**: 黑带+银扣+橙环从 `leg-l-skin` **迁出**；腿肤回填
- **隐藏风险**: 露出回填大腿肤；仅左腿（画面左 / leg-l）有绑带

### 7. `socks` 袜（R33a）
- **Images**: `full.sock.{l,r}.image`
- **Assets**: `sock-l.png`, `sock-r.png`
- **Bones**: 与对应 `leg-*-skin` 同网格（upper/lower/foot）
- **说明**: 白袜+橙星从 `leg-*-skin` **迁出**（非复制）；腿肤踝部已回填裸肤
- **隐藏风险**: 露出回填踝肤；鞋仍盖住脚部

### 8. `choker` / 发饰
- **Images**: `full.choker.image`, `full.hair.clip.image`, `full.hair.bow.image`
- **Assets**: `choker.png`, `hair-clip.png`, `hair-bow.png`
- **`hair.bow`（R33c）**: 橙结从 `hair-lock-r` **迁出**；同 lock-r 网格（head + lock.r.s1–s3，继承 R20 sway）；旧空刚性 Image 已删
- **隐藏风险**: 露出 lock-r 回填深棕发；`hair-back-*` / `hair-lock-l` 上仍可能有少量橙饰未迁

## 建议绘制顺序（换衣友好）

```
body.backfill → leg skins → socks → arm skins → arm-under
→ tank → shorts → shorts-orange → shorts-waist → belt / badge
→ coat-front(r) 之前: pouch
→ coat stump/shoulder → sleeve → coat-front → cuff → hem.ribbon
→ shoes → choker / hair accessories → head/hair/face
```

当前 scene 文档序尚未整体重排（避免大范围改 motion）；新层已按「后画在下」插入正确相对位置。

## 替换操作清单

1. 选定衣槽 → 按上表列出 Images + Assets + 关联骨  
2. 准备同尺寸（或可重蒙皮）PNG；`ai_generated:false` 时写清 deterministic method  
3. 更新 `parts/DETAIL_LICENSE.json` sha/bytes/method  
4. `rive rive/nomi-complete --verify` + `--once`；拷贝 `.riv` 到 `packages/renderer/.../nomi-complete.riv`  
5. `brand-check.py`；`COREPACK_HOME=/tmp npx vitest run tests/mascot/rive.test.ts`  
6. 对 `idle/wave/walk/run` 做「隐该槽」空洞扫描

## 仍非 swap-ready 的项

- ~~腿袜未独立~~ → R33a 已拆 `sock-{l,r}`  
- ~~右大腿绑带融在 leg-l-skin~~ → R33b 已拆 `thigh-strap`  
- 髋/裆与腿顶仍有接缝风险（隐短裤时）  
- 袖下臂肤为几何胶囊，非母图手臂造型  
- 无 StateMachine 换衣 Input；需运行时改 opacity 或换 asset  
- `full.neutral` 仍含橙色边角残片（idle/rest 关键帧 opacity 1，位于最底层）；R34a 已删其皮带区残片
- `hair-back-*` / `hair-lock-l` 残留橙像素（非主结）未迁入 bow
