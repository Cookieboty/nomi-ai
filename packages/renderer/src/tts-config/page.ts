/**
 * TTS 配置页逻辑。以模块方式由 main.ts 引入——生产构建的 CSP（script-src 'self'）不允许内联脚本，
 * 原来写在 tts-config.html 里的 <script> 会被整段拦截（#48）。
 */
/* 该页面是直接操作 DOM 的原生脚本迁移而来：表单控件统一按宽松类型访问，不做逐字段建模 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { t } from '@nomi-ai/ui';

import { applyStaticText } from './staticText';

type Cfg = Record<string, any>;
type El = any;
const $ = (id: string): El => document.getElementById(id);
const electronAPI = (): any => (window as any).electronAPI;
const defaultConfig: Cfg = {
  enabled: true,
  provider: 'sherpa-theresa',
  sherpaSid: 0,
  sherpaSpeed: 1.0,
  baseUrl: 'http://127.0.0.1:8080',
  referenceId: 'nomi',
  format: 'mp3',
  timeoutMs: 30000,
  cloudModel: 's2.1-pro-free',
  hostname: '127.0.0.1',
  port: 8080,
  path: '/v1/tts',
  audioUrl: '',
  promptText: '',
};

let currentConfig: Cfg | null = null;
let isLoading = false;

function formToConfig() {
  const provider = $('provider').value;
  const cfg: Cfg = {
    ...(currentConfig || defaultConfig),
    enabled: $('enabled').checked,
    provider,
    baseUrl: $('baseUrl').value.trim() || defaultConfig.baseUrl,
    referenceId: $('referenceId').value || 'nomi',
    format: $('format').value || 'mp3',
    hostname: $('hostname').value.trim(),
    port: Number($('port').value) || 8080,
    path: $('path').value.trim() || '/v1/tts',
    audioUrl: $('audioUrl').value.trim(),
    promptText: $('promptText').value.trim(),
    lastModified: Date.now(),
  };
  const key = $('apiKey').value;
  if (key) cfg.apiKey = key;
  if ($('clearApiKey').checked) cfg.clearApiKey = true;
  return cfg;
}

function configToForm(cfg: any) {
  const c = { ...defaultConfig, ...(cfg || {}) };
  $('enabled').checked = c.enabled !== false;
  $('provider').value = c.provider || 'sherpa-theresa';
  $('baseUrl').value = c.baseUrl || defaultConfig.baseUrl;
  $('referenceId').value = c.referenceId || 'nomi';
  $('format').value = c.format || 'mp3';
  $('hostname').value = c.hostname || '';
  $('port').value = c.port || 8080;
  $('path').value = c.path || '/v1/tts';
  $('audioUrl').value = c.audioUrl || '';
  $('promptText').value = c.promptText || '';
  $('apiKey').value = '';
  $('clearApiKey').checked = false;
  $('hasApiKeyHint').textContent = c.hasApiKey ? t('已保存云端 Key') : t('尚未保存云端 Key');
  $('config-editor').value = JSON.stringify({ ...c, apiKey: undefined }, null, 2);
  syncVisibility();
  updateStatusFromConfig(c);
}

function syncVisibility() {
  const p = $('provider').value;
  const fish = p === 'fish-local' || p === 'fish-cloud';
  $('sherpa-fields').style.display = p === 'sherpa-theresa' ? '' : 'none';
  if (p === 'sherpa-theresa') refreshSherpaStatus();
  $('fish-fields').style.display = fish ? '' : 'none';
  $('cloud-fields').style.display = p === 'fish-cloud' ? '' : 'none';
  $('legacy-fields').style.display = p === 'legacy' ? '' : 'none';
  if (p === 'fish-cloud' && !$('baseUrl').value.includes('fish.audio')) {
    $('baseUrl').placeholder = 'https://api.fish.audio';
  }
  if (p === 'fish-local') $('baseUrl').placeholder = 'http://127.0.0.1:8080';
}

function updateStatus(type: any, text: any) {
  $('status-indicator').className = 'status-indicator ' + type;
  $('status-text').textContent = text;
}

function updateStatusFromConfig(c: any) {
  if (!c || c.enabled === false) {
    updateStatus('none', t('TTS 已关闭（保持静默）'));
  } else if (c.provider === 'sherpa-theresa') {
    updateStatus('valid', t('内置离线语音（sherpa-onnx）· 模型未就绪则保持静默'));
  } else if (c.provider === 'fish-local') {
    updateStatus(
      'valid',
      t('Fish 本地（高级）· 预设 {0}（未就绪则保持静默）', c.referenceId || 'nomi'),
    );
  } else if (c.provider === 'fish-cloud') {
    updateStatus('valid', c.hasApiKey ? t('Fish 云 · 已配置 Key') : t('Fish 云 · 需填写 API Key'));
  } else {
    updateStatus('valid', t('外部 legacy TTS'));
  }
}

// ---- sherpa 离线模型状态（按需下载到 userData，见 docs/design/tts-on-demand.md） ----
function renderSherpaStatus(st: any) {
  const text = $('sherpa-model-text');
  if (st.state === 'ready') {
    text.textContent =
      st.source === 'dev'
        ? t('模型已就绪（开发目录）')
        : st.source === 'env'
          ? t('模型已就绪（环境变量目录）')
          : st.source === 'userData'
            ? t('模型已就绪（已下载到本机）')
            : t('模型已就绪');
  } else if (st.state === 'downloading') {
    text.textContent = t('模型下载中…（完成后自动可用）');
  } else if (st.state === 'error') {
    text.textContent = t('模型不可用：{0}（当前没有可用 TTS）', st.message || t('未知错误'));
  } else {
    text.textContent = t('模型未下载：在主界面「设置 → 语音与屏幕 → 语音」开启语音即可下载');
  }
}

async function refreshSherpaStatus() {
  if (!electronAPI() || !electronAPI().ttsSherpaStatus) return;
  try {
    renderSherpaStatus(await electronAPI().ttsSherpaStatus());
  } catch (e: any) {
    $('sherpa-model-text').textContent = t('无法获取模型状态：{0}', e.message);
  }
}

function showResult(message: any, ok: any) {
  const el = $('result-message');
  el.textContent = message;
  el.className = 'result-message cd-notice ' + (ok ? 'cd-notice--success' : 'cd-notice--danger');
  el.style.display = 'block';
  setTimeout(() => {
    el.style.display = 'none';
  }, 5000);
}

function showError(msg: any) {
  $('error-message').textContent = msg;
  $('error-message').style.display = 'block';
}
function hideError() {
  $('error-message').style.display = 'none';
}

async function loadCurrentConfig() {
  if (!electronAPI()) {
    configToForm(defaultConfig);
    showResult(t('ElectronAPI 不可用，显示默认配置'), false);
    return;
  }
  try {
    isLoading = true;
    const config = await electronAPI().getTTSConfig();
    currentConfig = config || defaultConfig;
    configToForm(currentConfig);
    showResult(t('配置加载成功'), true);
  } catch (e: any) {
    configToForm(defaultConfig);
    showResult(t('加载失败：{0}', e.message), false);
  } finally {
    isLoading = false;
  }
}

async function checkHealth() {
  if (!electronAPI()) {
    showResult(t('需要在 Electron 中运行'), false);
    return;
  }
  const cfg = formToConfig();
  try {
    $('health-text').textContent = t('检测中…');
    const result = await electronAPI().testTTSConnection(cfg);
    if (result.success) {
      updateStatus(
        'valid',
        result.message + (result.latency != null ? ' · ' + result.latency + 'ms' : ''),
      );
      showResult(result.message, true);
    } else {
      updateStatus('invalid', result.message || t('不可达，当前没有可用 TTS'));
      showResult(result.message || t('检测失败'), false);
    }
  } catch (e: any) {
    showResult(t('检测失败：{0}', e.message), false);
  } finally {
    $('health-text').textContent = t('检测连接');
  }
}

async function saveConfig() {
  if (!electronAPI()) {
    showResult(t('需要在 Electron 中运行'), false);
    return;
  }
  try {
    const cfg = formToConfig();
    const res = await electronAPI().saveTTSConfig(cfg);
    // 主进程拒绝保存（例如系统安全存储不可用时不会明文落盘 API Key）→ 如实显示，不要报「已保存」
    if (res && res.success === false) throw new Error(res.error || t('未知错误'));
    currentConfig = await electronAPI().getTTSConfig();
    configToForm(currentConfig);
    showResult(t('配置已保存'), true);
  } catch (e: any) {
    showResult(t('保存失败：{0}', e.message), false);
  }
}

async function resetConfig() {
  if (!confirm(t('重置为内置离线默认？将清除已保存配置与云 Key。'))) return;
  if (!electronAPI()) {
    configToForm(defaultConfig);
    return;
  }
  try {
    await electronAPI().resetTTSConfig();
    currentConfig = await electronAPI().getTTSConfig();
    configToForm(currentConfig || defaultConfig);
    showResult(t('已重置为内置默认'), true);
  } catch (e: any) {
    showResult(t('重置失败：{0}', e.message), false);
  }
}

function syncEditorFromForm() {
  try {
    const cfg = formToConfig();
    delete cfg.apiKey;
    delete cfg.clearApiKey;
    $('config-editor').value = JSON.stringify(cfg, null, 2);
    hideError();
  } catch (e: any) {
    showError(String(e.message || e));
  }
}

function applyEditorToForm() {
  try {
    const cfg = JSON.parse($('config-editor').value || '{}');
    configToForm({ ...currentConfig, ...cfg });
    hideError();
  } catch (e: any) {
    showError(t('JSON 格式错误：{0}', e.message));
  }
}

/** 语言切换后重新渲染动态文案（静态文案由 staticText 负责） */
export function refreshTtsConfigText(): void {
  if (currentConfig) updateStatusFromConfig(formToConfig());
  $('hasApiKeyHint').textContent = currentConfig?.hasApiKey
    ? t('已保存云端 Key')
    : t('尚未保存云端 Key');
  if ($('provider').value === 'sherpa-theresa') refreshSherpaStatus();
}

export function initTtsConfigPage(): void {
  // 先写静态文案（含状态栏占位），再异步加载配置：加载结果不会被占位覆盖（#48）
  applyStaticText();
  loadCurrentConfig();
  [
    'enabled',
    'provider',
    'baseUrl',
    'referenceId',
    'format',
    'hostname',
    'port',
    'path',
    'audioUrl',
    'promptText',
  ].forEach((id) => {
    $(id).addEventListener('change', () => {
      syncVisibility();
      syncEditorFromForm();
      updateStatusFromConfig(formToConfig());
    });
    $(id).addEventListener('input', () => {
      syncEditorFromForm();
    });
  });
  $('provider').addEventListener('change', syncVisibility);
  $('config-editor').addEventListener('change', applyEditorToForm);
  $('load-btn').addEventListener('click', loadCurrentConfig);
  $('health-btn').addEventListener('click', checkHealth);
  $('save-btn').addEventListener('click', saveConfig);
  $('reset-btn').addEventListener('click', resetConfig);
}

// 模块脚本是 defer 语义：执行时 DOM 已解析完；仍兼容在 loading 阶段被执行的情况
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTtsConfigPage);
} else {
  initTtsConfigPage();
}
