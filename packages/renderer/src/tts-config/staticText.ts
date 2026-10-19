/**
 * TTS 配置页的静态文案（#48）：HTML 里的中文只是脚本加载前的兜底，这里按 `data-i18n` 用 t() 写入，
 * check:i18n 能扫到这些 key，切换语言时重新调用即可。
 * 含 <strong> / <code> 的句子写成带 {0}… 占位的整句，再把元素节点按位置拼回去（不用 innerHTML）。
 */
import { t } from '@nomi-ai/ui';

type Part = () => Node;
type Text = string | [template: string, ...parts: Part[]];

const el =
  (tag: string, text: string): Part =>
  () => {
    const n = document.createElement(tag);
    n.textContent = text;
    return n;
  };
const code = (s: string) => el('code', s);
const strong = (s: string) => el('strong', s);

const TEXT: Record<string, () => Text> = {
  title: () => t('TTS 语音配置'),
  intro: () => [
    t(
      '默认使用内置{0}（sherpa-onnx，本机合成，模型在开启语音时下载到本机，之后无需联网/外部服务）。模型缺失或合成失败时保持静默。Fish Audio 为可选高级引擎；不提供用户上传/克隆任意音色；仍可自行接入外部 TTS（legacy）。',
    ),
    strong(t('离线语音')),
  ],
  attribution: () => [
    t(
      '{0} — 研究/非商用免费；年营收 < USD 500k 可社区商用；Hosted Service（对外自助 TTS/克隆 API）需另签；不可未经同意克隆真人；不可用输出训练其他基础 TTS 模型。详见仓库 NOTICE / THIRD_PARTY_NOTICES。',
    ),
    strong('Built with Fish Audio'),
  ],
  loading: () => t('加载中…'),
  engine: () => t('语音引擎'),
  enabled: () => t('启用 TTS 播报（关闭则保持静默）'),
  provider: () => t('提供方'),
  'opt-sherpa': () => t('内置离线语音（sherpa-onnx，默认）'),
  'opt-fish-local': () => t('高级：Fish 本地（fish-speech）'),
  'opt-fish-cloud': () => t('高级：Fish 云 API（自备 Key）'),
  'opt-legacy': () => t('自行接入外部 TTS（legacy，自建克隆服务）'),
  'sherpa-hint': () => [
    t(
      '声线 sid 0，语速 1.0（固定默认，不加速）。模型约 115 MB（下载）/ 133 MB（解压），不随安装包分发：在主界面「设置 → 语音与屏幕 → 语音」开启语音时下载到本机。开发态可用环境变量 {0}，或仓库同级 {1}。',
    ),
    code('NOMI_SHERPA_TTS_MODEL_DIR'),
    code('../models/vits-zh-hf-theresa'),
  ],
  'sherpa-checking': () => t('模型状态：检测中…'),
  'base-url': () => t('服务地址'),
  preset: () => t('内置声线预设'),
  'opt-nomi': () => t('Nomi（可爱）'),
  'fish-hint': () => [
    t(
      '应用已内置 Nomi 可爱种子，合成时自动以 {0} 发给本地 Fish，无需手动拷贝。不提供「上传我的音色」入口。',
    ),
    code('reference_audio'),
  ],
  format: () => t('音频格式'),
  'api-key': () => t('Fish 云 API Key（仅存主进程，safeStorage）'),
  'clear-key': () => t('清除已保存的 Key'),
  'legacy-hint': () =>
    t('外部自建 TTS（hostname / port / path / audioUrl / promptText）。JSON 高级编辑见下方。'),
  'audio-url': () => t('audioUrl（服务侧参考音频 URL，非本机上传）'),
  'raw-json': () => t('高级：原始 JSON'),
  load: () => t('加载配置'),
  health: () => t('检测连接'),
  save: () => t('保存配置'),
  reset: () => t('重置为内置默认'),
  'help-title': () => t('怎么用'),
  'help-1': () =>
    t('1. 默认「内置离线语音」：开启语音时下载模型到本机，之后完全本机合成，无需联网。'),
  'help-2': () => t('2. 模型缺失 / 合成出错时，看板娘保持静默，无需试听步骤。'),
  'help-3': () => [
    t(
      '3. 高级：Fish 本地（Docker / uv 启动 fish-speech，监听 {0}）或 Fish 云（自备 API Key，不捆绑 Research-only 权重）。',
    ),
    code('127.0.0.1:8080'),
  ],
  'help-4': () => t('4. 需要对接其它克隆 API 时，选择「自行接入外部 TTS（legacy）」。'),
};

const PLACEHOLDER: Record<string, () => string> = {
  'api-key-placeholder': () => t('留空则保留已保存的 Key'),
};

/** 把 `{0}{1}` 模板与节点拼成子节点：文字段用文本节点，占位处放对应元素 */
function fill(target: Element, text: Text): void {
  if (typeof text === 'string') {
    target.textContent = text;
    return;
  }
  const [template, ...parts] = text;
  const nodes: Node[] = [];
  let last = 0;
  for (const m of template.matchAll(/\{(\d+)\}/g)) {
    nodes.push(document.createTextNode(template.slice(last, m.index)));
    const part = parts[Number(m[1])];
    if (part) nodes.push(part());
    last = m.index! + m[0].length;
  }
  nodes.push(document.createTextNode(template.slice(last)));
  target.replaceChildren(...nodes);
}

/**
 * 写入全部静态文案。动态区域（状态栏、模型状态）只在初始化时写一次占位，
 * 之后由页面逻辑覆盖；`keepDynamic` 为 true（切换语言时）跳过它们，由页面逻辑重新渲染。
 */
export function applyStaticText(root: ParentNode = document, keepDynamic = false): void {
  const dynamic = new Set(['loading', 'sherpa-checking']);
  for (const n of root.querySelectorAll('[data-i18n]')) {
    const key = n.getAttribute('data-i18n')!;
    if (keepDynamic && dynamic.has(key)) continue;
    const text = TEXT[key];
    if (text) fill(n, text());
  }
  for (const n of root.querySelectorAll('[data-i18n-placeholder]')) {
    const text = PLACEHOLDER[n.getAttribute('data-i18n-placeholder')!];
    if (text) (n as HTMLInputElement).placeholder = text();
  }
  if (typeof document !== 'undefined') document.title = t('TTS 语音配置');
}
