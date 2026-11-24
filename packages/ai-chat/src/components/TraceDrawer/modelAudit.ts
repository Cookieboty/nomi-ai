/**
 * 模型切换追踪与指纹验真/质量分析引擎（纯函数，无 React）：
 * - 模型名称归一化（与 Go gateway/modelid Canonical 同口径）与厂商识别；
 * - 单条请求指纹核验：model 名比对、system_fingerprint 冲突、特征响应头冲突、响应 ID 格式、推理签名；
 * - 会话内跨轮模型切换识别、时间连续分段统计与分模型运行质量对比；
 * - 严格区隔「指纹不符(mismatch)」与「质量疑点/运行异常(suspect)」，避免把超时/网络错误误判为模型替换。
 */
import { t } from '@nomi-ai/ui';

import type { QualityFingerprint, QualityOutcome, QualityRequestItem } from '../../services/qualityClient';
import { cacheHitRate } from '../../utils/cacheHit';

import type { TraceAgentLane, TraceNode, TraceTurn } from './model';

export type ModelAuditVerdict = 'verified' | 'suspect' | 'mismatch' | 'unverified';
export type AuditEvidenceStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface AuditEvidence {
  id: string;
  status: AuditEvidenceStatus;
  category: 'model' | 'fingerprint' | 'header' | 'responseId' | 'signature' | 'quality';
  message: string;
}

export interface RequestModelAudit {
  reqId: string;
  traceId?: string;
  turnId?: string;
  ts: number;
  layer: 'gateway' | 'cli';
  requestedModel: string;
  upstreamModel?: string;
  observedModel?: string;
  expectedVendor: string | null;
  observedVendor: string | null;
  providerName?: string;
  wire?: string;
  ingress?: string;
  mode?: 'passthrough' | 'convert';
  verdict: ModelAuditVerdict;
  evidences: AuditEvidence[];
  ttftMs?: number;
  endMs: number;
  tps?: number;
  cacheHitRate?: number;
  outcome: QualityOutcome;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  fingerprint?: QualityFingerprint;
}

export interface TurnModelAudit {
  turnId: string;
  verdict: ModelAuditVerdict;
  requestedModel?: string;
  observedModel?: string;
  switchedFromModel?: string;
  requestCount: number;
  okCount: number;
  avgTtftMs?: number;
  avgTps?: number;
  evidences: AuditEvidence[];
  /**
   * 请求级证据未能定论（unverified）时，仅凭回复消息记录得到的回退结论；
   * 不替代 verdict，只在总览里按较低证据强度补上。
   */
  historyVerdict?: ModelAuditVerdict;
}

export interface TraceModelSwitch {
  turnId: string;
  turnLabel: string;
  laneId: string;
  laneName: string;
  fromModel: string;
  toModel: string;
  at?: number;
}

export interface TraceModelSegment {
  id: string;
  laneId: string;
  modelKey: string;
  modelName: string;
  vendor: string | null;
  turnIds: string[];
  turnRangeLabel: string;
  verdict: ModelAuditVerdict;
  observedModels: string[];
  switchedFromModel?: string;
}

export interface TraceModelSummary {
  modelKey: string;
  modelName: string;
  vendor: string | null;
  turnCount: number;
  turnIds: string[];
  requestCount: number;
  okCount: number;
  failedCount: number;
  successRate?: number;
  avgTtftMs?: number;
  avgE2eMs?: number;
  avgTps?: number;
  cacheHitRate?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  verdict: ModelAuditVerdict;
  anomalyCount: number;
  observedModels: string[];
}

export interface TraceModelAuditSummary {
  distinctModels: Array<{ key: string; name: string; vendor: string | null; verdict: ModelAuditVerdict }>;
  switchCount: number;
  /** 参与核验的请求数 */
  totalAuditedRequests: number;
  /** 参与核验的回合数：有请求证据的回合 + 仅靠回复消息历史回退、未被请求覆盖的回合 */
  totalAuditedTurns: number;
  /** 有请求证据且该回合模型名本身就不一致的请求数 */
  modelNameMismatchRequests: number;
  /** 仅靠历史回复证据、模型名不一致的回合数（没有响应头 / 指纹，证据强度低于请求级 mismatch） */
  historicalModelDiffTurns: number;
  verifiedCount: number;
  suspectCount: number;
  mismatchCount: number;
  unverifiedCount: number;
  overallVerdict: ModelAuditVerdict;
}

export interface TraceModelAnalysis {
  summary: TraceModelAuditSummary;
  switches: TraceModelSwitch[];
  segments: TraceModelSegment[];
  byModel: TraceModelSummary[];
  requestAudits: RequestModelAudit[];
  requestAuditsByReqId: Record<string, RequestModelAudit>;
  turnAuditsByTurnId: Record<string, TurnModelAudit>;
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const GEMINI_PATH_RE = /^(?:projects\/[^/]+\/locations\/[^/]+\/)?(?:publishers\/[^/]+\/)?models\//;
const LATEST_RE = /(?:-latest|:latest|@latest)$/;
const DATE8_RE = /-\d{8}$/;
const DATE_ISO_RE = /-\d{4}-\d{2}-\d{2}$/;
const AT_DATE_RE = /[@:]\d{8}$/;
const DOT_VER_RE = /(\d)\.(\d)/g;

/** 去除最前面一段 `provider/` 前缀用于页面清晰展示 */
export function stripProviderPrefix(model: string): string {
  const s = model.trim();
  if (!s) return '';
  const cleaned = s.replace(GEMINI_PATH_RE, '');
  const parts = cleaned.split('/');
  if (parts.length === 2 && parts[0] && parts[1] && SLUG_RE.test(parts[0].toLowerCase())) {
    return parts[1];
  }
  return cleaned;
}

function lowerBareModelName(model: string): string {
  let s = model.trim().toLowerCase().replace(/_/g, '-').replace(GEMINI_PATH_RE, '');
  if (s.includes('/')) {
    const idx = s.indexOf('/');
    const lastIdx = s.lastIndexOf('/');
    if (idx > 0 && idx === lastIdx) {
      const left = s.slice(0, idx);
      const right = s.slice(idx + 1);
      if (left && right && SLUG_RE.test(left)) {
        s = right;
      }
    }
  }
  return s;
}

/** 与 Go gateway/modelid Canonical 同口径 模型名归一化 */
export function canonicalModelName(model: string): string {
  let s = lowerBareModelName(model);
  if (!s) return '';
  s = s.replace(DOT_VER_RE, '$1-$2');
  for (;;) {
    let next = s;
    for (const re of [LATEST_RE, DATE_ISO_RE, DATE8_RE, AT_DATE_RE]) {
      const m = re.exec(next);
      if (m && m.index > 0) {
        next = next.slice(0, m.index);
        break;
      }
    }
    if (next === s || !next) break;
    s = next;
  }
  return s;
}

/** 保留显式版本标识（日期 / latest）的模型 ID，只去前缀、下划线与点版本号形态 */
export function explicitModelId(model: string): string {
  return lowerBareModelName(model).replace(DOT_VER_RE, '$1-$2');
}

const DATE_SUFFIX_RE = /-(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2}))$|[@:](?:(\d{4})(\d{2})(\d{2}))$/;
const LATEST_SUFFIX_RE = /(?:-latest|:latest|@latest)$/;

function snapshotDate(id: string): string | undefined {
  const m = DATE_SUFFIX_RE.exec(id);
  if (!m) return undefined;
  if (m[1]) return `${m[1]}${m[2]}${m[3]}`;
  if (m[4]) return `${m[4]}${m[5]}${m[6]}`;
  return m[7] ? `${m[7]}${m[8]}${m[9]}` : undefined;
}

/** 去掉日期快照与 latest 后缀后的系列 ID（如 gpt-4o / claude-sonnet-4-5） */
function seriesIdOf(id: string): string {
  const s = id.replace(LATEST_SUFFIX_RE, '').replace(DATE_SUFFIX_RE, '').trim();
  return s || id;
}

export type ModelNameMatch = 'exact' | 'alias' | 'family' | 'unknown';

/** 相邻的大版本编号（claude-3-7 → claude-3、claude-4 → claude-3、gemini-2-5 → gemini-2） */
function adjacentMajorSeries(series: string): string[] {
  const m = /^(.*?)(\d+)$/.exec(series);
  if (!m || !m[1]) return [];
  const major = Number(m[2]);
  return major > 1 ? [`${m[1]}${major - 1}`] : [];
}

function sameFamily(a: string, b: string): boolean {
  const [lo, hi] = a.length <= b.length ? [a, b] : [b, a];
  if (!lo.includes('-') || !hi.startsWith(`${lo}-`)) return false;
  // 基础名必须落在版本段或已知变体前（o3-mini、claude-sonnet-4-5-...），
  // 避免把 gemini-2-5-pro 与 gemini-2-5-flash 这类不同型号判成同系列。
  return /^-(?:\d+|mini|nano|pro|turbo|flash|plus|high|medium)(?:-|:|$)/.test(hi.slice(lo.length));
}

/** 模型大小 / 档位变体，不属于同系列的版本差异 */
const MODEL_SIZE_SET = new Set([
  'mini',
  'nano',
  'pro',
  'turbo',
  'flash',
  'plus',
  'high',
  'medium',
  'low',
  'air',
  'lite',
  'max',
  'ultra',
]);
const VERSION_SEGMENT_RE = /^\d+$/;

/**
 * 同一版本线判定：head 相同、版本段按位相同、大小档位相同、其余修饰词相同。
 * 因为 head 已相同，版本段只可能来自多级版本（gemini-2-5-pro 与 gemini-2-5-flash、claude-3-5 与 claude-3-7），
 * 这里再按版本相同时的大小档位细分，避免把 pro 与 flash 这类不同型号当成同系列。
 */
function sameVersionLine(a: string, b: string): boolean {
  const sa = a.split('-').filter(Boolean);
  const sb = b.split('-').filter(Boolean);
  if (!sa[0] || sa[0] !== sb[0]) return false;
  const pick = (segs: string[], keep: (seg: string) => boolean) => segs.filter(keep).join('.');
  const versionA = pick(sa, (seg) => VERSION_SEGMENT_RE.test(seg));
  const versionB = pick(sb, (seg) => VERSION_SEGMENT_RE.test(seg));
  const sizeA = pick(sa, (seg) => MODEL_SIZE_SET.has(seg));
  const sizeB = pick(sb, (seg) => MODEL_SIZE_SET.has(seg));
  const other = (seg: string) => !VERSION_SEGMENT_RE.test(seg) && !MODEL_SIZE_SET.has(seg);
  const restA = sa.filter(other).sort();
  const restB = sb.filter(other).sort();
  return versionA === versionB && sizeA === sizeB && restA.join('.') === restB.join('.');
}

/**
 * 区分请求模型与返回模型的关系，只认有依据的供应商别名：
 * - exact：去掉前缀 / 大小写 / 下划线差异后完全相同；
 * - alias：未写日期的系列名 vs 该系列自己的日期快照或 latest（绝不跨版本）；
 * - family：同系列的其他版本（含 claude-3-7 vs claude-3-5 这类相邻代）；
 * - unknown：其余一切。
 * 两个不同的显式日期版、两个不同的显式版本号都属于 family，不是版本一致。
 */
export function classifyModelNameMatch(requested: string, observed: string): ModelNameMatch {
  const reqId = explicitModelId(requested);
  const obsId = explicitModelId(observed);
  if (!reqId || !obsId) return 'unknown';
  if (reqId === obsId) return 'exact';
  const reqSeries = seriesIdOf(reqId);
  const obsSeries = seriesIdOf(obsId);
  // 两边的显式快照 / 版本号都互不相同：是同系列的其他快照，不是别名
  const bothSnapshot = snapshotDate(reqId) !== undefined && snapshotDate(obsId) !== undefined;
  const bothLatest = LATEST_SUFFIX_RE.test(reqId) && LATEST_SUFFIX_RE.test(obsId);
  if (reqSeries === obsSeries) return bothSnapshot || bothLatest ? 'family' : 'alias';
  const reqIsSeries = reqSeries === reqId;
  const obsIsSeries = obsSeries === obsId;
  if ((reqIsSeries && obsSeries === reqId) || (obsIsSeries && reqSeries === obsId)) return 'alias';
  if (
    reqSeries === obsSeries ||
    adjacentMajorSeries(reqSeries).includes(obsSeries) ||
    adjacentMajorSeries(obsSeries).includes(reqSeries) ||
    sameFamily(reqSeries, obsSeries) ||
    sameFamily(reqId, obsId) ||
    sameFamily(reqId, obsId) ||
    sameVersionLine(reqSeries, obsSeries)
  ) {
    return 'family';
  }
  return 'unknown';
}

function reportedModel(tr: TraceTurn, replyMsg?: { model?: string; responseModel?: string }): string | undefined {
  return (tr.responseModel || tr.model || replyMsg?.model || '').trim() || undefined;
}

/**
 * 仅凭回复消息（无网关请求）比对请求模型与回复记录：exact / alias 一致，mismatch 才是跨厂商冲突。
 */
function historyModelVerdict(
  tr: TraceTurn,
  replyMsg?: { model?: string; responseModel?: string },
): ModelAuditVerdict {
  const recorded = (replyMsg?.responseModel || '').trim();
  const requested = reportedModel(tr, replyMsg);
  if (!recorded || !requested) return 'unverified';
  const expV = inferModelVendor(stripProviderPrefix(requested) || requested);
  const obsV = inferModelVendor(stripProviderPrefix(recorded) || recorded);
  if (expV && obsV && expV !== obsV) return 'mismatch';
  return 'verified';
}

const VENDOR_PATTERNS: Array<[RegExp, string]> = [
  [/^(gpt|chatgpt|o\d|codex|davinci|text-embedding)/, 'OpenAI'],
  [/^claude/, 'Anthropic'],
  [/^(gemini|gemma)/, 'Google'],
  [/^(deepseek|ds-)/, 'DeepSeek'],
  [/^(glm|chatglm|codegeex)/, 'Z.ai'],
  [/^grok/, 'xAI'],
  [/^(kimi|moonshot)/, 'Moonshot'],
  [/^(qwen|qwq|qvq)/, 'Qwen'],
  [/^(minimax|abab)/, 'MiniMax'],
  [/^doubao/, 'ByteDance'],
  [/^(llama|meta-llama)/, 'Meta'],
  [/^(mistral|mixtral|codestral|magistral|devstral)/, 'Mistral'],
  [/^ernie/, 'Baidu'],
  [/^hunyuan/, 'Tencent'],
];

export function inferModelVendor(model?: string): string | null {
  if (!model) return null;
  const bare = stripProviderPrefix(model).toLowerCase();
  if (!bare) return null;
  for (const [re, vendor] of VENDOR_PATTERNS) {
    if (re.test(bare)) return vendor;
  }
  return null;
}

export function requestOutputTps(req: QualityRequestItem): number | undefined {
  const out = req.tokens.output ?? 0;
  if (out <= 0) return undefined;
  const startMs = req.timing.firstContentMs ?? 0;
  const endMs = req.timing.lastContentMs ?? req.timing.endMs;
  const genMs = endMs - startMs;
  if (!Number.isFinite(genMs) || genMs < 100) return undefined;
  return out / (genMs / 1000);
}

const SYS_FP_TOKENS: Array<[RegExp, string]> = [
  [/deepseek/i, 'DeepSeek'],
  [/qwen/i, 'Qwen'],
  [/claude|anthropic/i, 'Anthropic'],
  [/gemini/i, 'Google'],
  [/chatglm|zhipu|glm/i, 'Z.ai'],
  [/minimax/i, 'MiniMax'],
  [/moonshot|kimi/i, 'Moonshot'],
  [/\b(vllm|sglang|ollama|one-api|new-api)\b/i, 'self-hosted/proxy'],
];

const CLOSED_VENDORS = new Set(['OpenAI', 'Anthropic', 'Google', 'xAI']);

const HEADER_VENDOR_RULES: Array<[string, string]> = [
  ['x-ds-trace-id', 'DeepSeek'],
  ['x-deepseek-version', 'DeepSeek'],
  ['openai-version', 'OpenAI'],
  ['openai-processing-ms', 'OpenAI'],
  ['x-openai-proxy-wasm', 'OpenAI'],
  ['anthropic-version', 'Anthropic'],
  ['x-goog-api-version', 'Google'],
];

const HEADER_MODEL_KEYS = ['x-openrouter-model', 'x-upstream-model', 'x-model', 'openai-model'];

const VERDICT_RANK: Record<ModelAuditVerdict, number> = {
  mismatch: 4,
  suspect: 3,
  verified: 2,
  unverified: 1,
};

export function worstVerdict(list: readonly ModelAuditVerdict[]): ModelAuditVerdict {
  let best: ModelAuditVerdict = 'unverified';
  for (const v of list) {
    if (VERDICT_RANK[v] > VERDICT_RANK[best]) best = v;
  }
  return best;
}

/** 对单条网关/CLI 请求做全维度模型指纹验真与质量分析 */
export function auditQualityRequest(
  req: QualityRequestItem,
  fallbackRequestedModel?: string,
  turnId?: string,
): RequestModelAudit {
  const fp = req.fingerprint;
  const requestedRaw = (req.upstreamModel || req.model || fallbackRequestedModel || '').trim();
  const requestedClean = stripProviderPrefix(requestedRaw) || requestedRaw;
  const observedRaw = (fp?.responseModel || req.responseModel || '').trim();
  const observedClean = observedRaw ? stripProviderPrefix(observedRaw) || observedRaw : '';
  const expectedVendor = inferModelVendor(requestedClean);
  const observedVendor = observedClean ? inferModelVendor(observedClean) : null;

  const evidences: AuditEvidence[] = [];
  let hasFingerprintFail = false;
  let hasFingerprintPass = false;
  let hasSuspectSignal = false;

  // 1. 模型返回名核验（区分精确 / 供应商别名 / 同系列 / 未知，同系列不等于版本一致）
  if (observedRaw && requestedRaw) {
    const nameMatch = classifyModelNameMatch(requestedRaw, observedRaw);
    const mismatchEvidence: AuditEvidence | null =
      expectedVendor && observedVendor && expectedVendor !== observedVendor
        ? {
            id: 'model-cross-vendor',
            status: 'fail',
            category: 'model',
            message: t(
              'ui.devtools.evidence-model-cross-vendor',
              requestedClean,
              expectedVendor,
              observedClean || observedRaw,
              observedVendor,
            ),
          }
        : nameMatch === 'family'
          ? {
              id: 'model-family',
              status: 'fail',
              category: 'model',
              message: t('ui.devtools.evidence-model-family-mismatch', requestedClean, observedRaw),
            }
          : {
              id: 'model-mismatch',
              status: 'fail',
              category: 'model',
              message: t('ui.devtools.evidence-model-mismatch', requestedClean, observedRaw),
            };
    if (nameMatch === 'exact' || nameMatch === 'alias') {
      hasFingerprintPass = true;
      evidences.push({
        id: 'model-match',
        status: 'pass',
        category: 'model',
        message: t('ui.devtools.evidence-model-match', observedRaw),
      });
      if (nameMatch === 'alias') {
        evidences.push({
          id: 'model-alias',
          status: 'info',
          category: 'model',
          message: t('ui.devtools.evidence-model-alias', requestedClean, observedRaw),
        });
      }
    } else if (mismatchEvidence) {
      hasFingerprintFail = true;
      evidences.push(mismatchEvidence);
    }
  } else {
    evidences.push({
      id: 'model-absent',
      status: 'info',
      category: 'model',
      message: t('ui.devtools.evidence-model-absent'),
    });
  }

  // 2. system_fingerprint 异厂或自托管关键字冲突检查
  if (fp?.systemFingerprint) {
    let fpConflictVendor: string | null = null;
    for (const [re, label] of SYS_FP_TOKENS) {
      if (!re.test(fp.systemFingerprint)) continue;
      if (label === 'self-hosted/proxy') {
        if (expectedVendor && CLOSED_VENDORS.has(expectedVendor)) {
          fpConflictVendor = label;
          break;
        }
      } else if (expectedVendor && label !== expectedVendor) {
        fpConflictVendor = label;
        break;
      }
    }
    if (fpConflictVendor && expectedVendor) {
      hasFingerprintFail = true;
      evidences.push({
        id: 'sysfp-conflict',
        status: 'fail',
        category: 'fingerprint',
        message: t(
          'ui.devtools.evidence-sysfp-conflict',
          fp.systemFingerprint,
          fpConflictVendor,
          expectedVendor,
        ),
      });
    } else {
      evidences.push({
        id: 'sysfp-present',
        status: 'info',
        category: 'fingerprint',
        message: t('ui.devtools.evidence-sysfp-present', fp.systemFingerprint),
      });
    }
  }

  // 3. 白名单响应头归属与模型声明检查
  const hdrs = fp?.headers;
  if (hdrs) {
    for (const hk of HEADER_MODEL_KEYS) {
      const hv = hdrs[hk];
      if (!hv || !requestedRaw) continue;
      const hdrMatch = classifyModelNameMatch(requestedRaw, hv);
      if (hdrMatch !== 'exact' && hdrMatch !== 'alias') {
        hasFingerprintFail = true;
        evidences.push({
          id: `hdr-model-${hk}`,
          status: 'fail',
          category: 'header',
          message: t('ui.devtools.evidence-header-model-mismatch', hk, hv, requestedClean),
        });
      }
    }

    for (const [hk, vendor] of HEADER_VENDOR_RULES) {
      if (!hdrs[hk]) continue;
      if (expectedVendor && vendor !== expectedVendor) {
        hasFingerprintFail = true;
        evidences.push({
          id: `hdr-vendor-${hk}`,
          status: 'fail',
          category: 'header',
          message: t('ui.devtools.evidence-header-conflict', hk, vendor, expectedVendor),
        });
      } else if (expectedVendor && vendor === expectedVendor) {
        hasFingerprintPass = true;
        evidences.push({
          id: `hdr-match-${hk}`,
          status: 'pass',
          category: 'header',
          message: t('ui.devtools.evidence-header-match', hk, vendor),
        });
      }
    }
  }

  // 4. 响应 ID 协议格式检查（仅在可识别上游协议与期望厂商时）
  if (fp?.responseId && expectedVendor) {
    const rid = fp.responseId;
    const wire = req.wire;
    if (req.mode !== 'convert') {
      if (expectedVendor === 'OpenAI' && wire === 'chat') {
        if (rid.startsWith('chatcmpl-')) {
          hasFingerprintPass = true;
          evidences.push({
            id: 'rid-match',
            status: 'pass',
            category: 'responseId',
            message: t('ui.devtools.evidence-id-match', 'OpenAI Chat', rid),
          });
        } else {
          hasSuspectSignal = true;
          evidences.push({
            id: 'rid-suspect',
            status: 'warn',
            category: 'responseId',
            message: t('ui.devtools.evidence-id-suspect', rid, 'OpenAI Chat (chatcmpl-)'),
          });
        }
      } else if (expectedVendor === 'OpenAI' && wire === 'responses') {
        if (rid.startsWith('resp_')) {
          hasFingerprintPass = true;
          evidences.push({
            id: 'rid-match',
            status: 'pass',
            category: 'responseId',
            message: t('ui.devtools.evidence-id-match', 'OpenAI Responses', rid),
          });
        } else {
          hasSuspectSignal = true;
          evidences.push({
            id: 'rid-suspect',
            status: 'warn',
            category: 'responseId',
            message: t('ui.devtools.evidence-id-suspect', rid, 'OpenAI Responses (resp_)'),
          });
        }
      } else if (expectedVendor === 'Anthropic' && wire === 'messages') {
        if (rid.startsWith('msg_')) {
          hasFingerprintPass = true;
          evidences.push({
            id: 'rid-match',
            status: 'pass',
            category: 'responseId',
            message: t('ui.devtools.evidence-id-match', 'Anthropic', rid),
          });
        } else {
          hasSuspectSignal = true;
          evidences.push({
            id: 'rid-suspect',
            status: 'warn',
            category: 'responseId',
            message: t('ui.devtools.evidence-id-suspect', rid, 'Anthropic (msg_)'),
          });
        }
      }
    }
  }

  // 5. 推理签名检查
  if (fp?.hasThinkSig || fp?.hasSealedReasoning) {
    hasFingerprintPass = true;
    const kinds = [
      fp.hasThinkSig ? 'signature' : '',
      fp.hasSealedReasoning ? 'sealed' : '',
    ]
      .filter(Boolean)
      .join('+');
    evidences.push({
      id: 'sig-present',
      status: 'pass',
      category: 'signature',
      message: t('ui.devtools.evidence-sig-present', kinds),
    });
  } else if (
    req.mode === 'passthrough' &&
    req.wire === 'messages' &&
    expectedVendor === 'Anthropic' &&
    fp?.hasReasoningText
  ) {
    hasSuspectSignal = true;
    evidences.push({
      id: 'sig-missing',
      status: 'warn',
      category: 'signature',
      message: t('ui.devtools.evidence-sig-missing'),
    });
  }

  // 6. 协议转换与运行质量异常信号（异常运行状态记入 suspect，与模型替换区分开）
  if (req.mode === 'convert' && req.ingress && req.wire) {
    evidences.push({
      id: 'mode-convert',
      status: 'info',
      category: 'quality',
      message: t('ui.devtools.evidence-converted-note', req.ingress, req.wire),
    });
  }
  if (req.burst) {
    hasSuspectSignal = true;
    evidences.push({
      id: 'burst',
      status: 'warn',
      category: 'quality',
      message: t('ui.devtools.evidence-burst'),
    });
  }
  if ((req.attempts?.length ?? 0) > 1) {
    hasSuspectSignal = true;
    evidences.push({
      id: 'fallback',
      status: 'warn',
      category: 'quality',
      message: t('ui.devtools.evidence-fallback', String(req.attempts!.length)),
    });
  }
  if (req.routeQuality === 'degraded' || (req.losses?.length ?? 0) > 0) {
    hasSuspectSignal = true;
    evidences.push({
      id: 'degraded',
      status: 'warn',
      category: 'quality',
      message: t('ui.devtools.evidence-degraded', req.losses?.join(', ') || 'degraded'),
    });
  }
  if (req.outcome !== 'ok' && req.outcome !== 'client-cancel') {
    hasSuspectSignal = true;
    evidences.push({
      id: 'outcome-fail',
      status: 'fail',
      category: 'quality',
      message: t('ui.devtools.evidence-outcome-fail', req.outcome),
    });
  }

  let verdict: ModelAuditVerdict = 'unverified';
  if (hasFingerprintFail) verdict = 'mismatch';
  else if (hasSuspectSignal) verdict = 'suspect';
  else if (hasFingerprintPass) verdict = 'verified';

  const inputTokens = req.tokens.input ?? 0;
  const cacheReadTokens = req.tokens.cacheRead ?? 0;

  return {
    reqId: req.id,
    ...(req.traceId ? { traceId: req.traceId } : {}),
    turnId,
    ts: req.ts,
    layer: req.layer,
    requestedModel: requestedClean || requestedRaw || req.display || t('ui.devtools.model-request'),
    upstreamModel: req.upstreamModel,
    observedModel: observedRaw || undefined,
    expectedVendor,
    observedVendor,
    providerName: req.providerName ?? req.provider,
    wire: req.wire,
    ingress: req.ingress,
    mode: req.mode,
    verdict,
    evidences,
    ttftMs: req.timing.firstContentMs,
    endMs: req.timing.endMs,
    tps: requestOutputTps(req),
    cacheHitRate: cacheHitRate(inputTokens, cacheReadTokens),
    outcome: req.outcome,
    inputTokens,
    outputTokens: req.tokens.output ?? 0,
    cacheReadTokens,
    fingerprint: fp,
  };
}

function modelKeyAndName(rawModel?: string, req?: QualityRequestItem): { key: string; name: string } | null {
  const raw = (rawModel || req?.upstreamModel || req?.model || '').trim();
  if (!raw && !req?.display) return null;
  const clean = raw ? stripProviderPrefix(raw) || raw : req!.display!;
  const key = canonicalModelName(raw || clean) || clean.toLowerCase();
  const name = req?.display && clean === req.model ? req.display : clean;
  return { key, name };
}

function formatTurnsRange(turns: readonly TraceTurn[]): string {
  if (!turns.length) return '';
  if (turns.length === 1) return turns[0]!.label;
  return `${turns[0]!.label} – ${turns[turns.length - 1]!.label}`;
}

/**
 * 扫描整份轨迹的 Turn / Request，生成会话内模型切换链、分模型质量对比与整体指纹验真结论。
 */
export function analyzeTraceModels(
  turns: readonly TraceTurn[],
  nodesById: Readonly<Record<string, TraceNode>>,
  lanesById: Readonly<Record<string, TraceAgentLane>>,
): TraceModelAnalysis {
  const requestAudits: RequestModelAudit[] = [];
  const requestAuditsByReqId: Record<string, RequestModelAudit> = {};
  const turnAuditsByTurnId: Record<string, TurnModelAudit> = {};
  const switches: TraceModelSwitch[] = [];
  const segments: TraceModelSegment[] = [];

  interface ModelAcc {
    key: string;
    name: string;
    vendor: string | null;
    turnIds: string[];
    reqAudits: RequestModelAudit[];
    verdicts: ModelAuditVerdict[];
    observedModels: Set<string>;
    fallbackTtfts: number[];
    fallbackInputs: number;
    fallbackOutputs: number;
    fallbackCacheRead: number;
    fallbackOk: number;
    fallbackFailed: number;
  }
  const byModelMap = new Map<string, ModelAcc>();

  // 按泳道分组并保持时间序
  const turnsByLane = new Map<string, TraceTurn[]>();
  for (const tr of turns) {
    const list = turnsByLane.get(tr.laneId) ?? [];
    list.push(tr);
    turnsByLane.set(tr.laneId, list);
  }

  for (const [laneId, laneTurns] of turnsByLane) {
    const lane = lanesById[laneId];
    let prevModelInfo: { key: string; name: string } | null = null;
    let curSeg: {
      modelKey: string;
      modelName: string;
      vendor: string | null;
      turns: TraceTurn[];
      verdicts: ModelAuditVerdict[];
      observed: Set<string>;
      switchedFrom?: string;
    } | null = null;

    const flushSegment = () => {
      if (!curSeg || !curSeg.turns.length) return;
      segments.push({
        id: `seg-${laneId}-${segments.length + 1}`,
        laneId,
        modelKey: curSeg.modelKey,
        modelName: curSeg.modelName,
        vendor: curSeg.vendor,
        turnIds: curSeg.turns.map((tItem) => tItem.id),
        turnRangeLabel: formatTurnsRange(curSeg.turns),
        verdict: worstVerdict(curSeg.verdicts),
        observedModels: [...curSeg.observed],
        ...(curSeg.switchedFrom ? { switchedFromModel: curSeg.switchedFrom } : {}),
      });
      curSeg = null;
    };

    for (const tr of laneTurns) {
      const reqNodes = tr.requestNodeIds
        .map((id) => nodesById[id])
        .filter((n): n is TraceNode => !!n && n.kind === 'request' && !!n.req);
      const replyNode = tr.nodeIds
        .map((id) => nodesById[id])
        .find((n) => n && (n.kind === 'reply' || n.kind === 'error') && n.message);
      const replyMsg = replyNode?.message;
      const turnRawModel = tr.model || replyMsg?.model || reqNodes[0]?.req?.upstreamModel || reqNodes[0]?.req?.model;
      const modelInfo = modelKeyAndName(turnRawModel, reqNodes[0]?.req);

      const auditsForTurn: RequestModelAudit[] = [];
      for (const rn of reqNodes) {
        const audit = auditQualityRequest(rn.req!, tr.model || replyMsg?.model, tr.id);
        auditsForTurn.push(audit);
        requestAudits.push(audit);
        requestAuditsByReqId[rn.req!.id] = audit;
      }

      // 若当轮无网关请求记录但消息自身携带了 responseModel（历史兼容或直连反馈），补一条核验依据；
      // 只有模型名本身，没有响应头 / 指纹，所以不一致时按证据强度记为 suspect 而不是 mismatch。
      const fallbackEvidences: AuditEvidence[] = [];
      let fallbackVerdict: ModelAuditVerdict = 'unverified';
      const msgRespModel = replyMsg?.responseModel?.trim();
      if (!auditsForTurn.length && msgRespModel && turnRawModel) {
        const reqClean = stripProviderPrefix(turnRawModel) || turnRawModel;
        const obsClean = stripProviderPrefix(msgRespModel) || msgRespModel;
        const expV = inferModelVendor(reqClean);
        const obsV = inferModelVendor(obsClean);
        const msgMatch = classifyModelNameMatch(turnRawModel, msgRespModel);
        if (msgMatch === 'exact' || msgMatch === 'alias') {
          fallbackVerdict = 'verified';
          fallbackEvidences.push({
            id: 'msg-model-match',
            status: 'pass',
            category: 'model',
            message: t('ui.devtools.evidence-model-match', msgRespModel),
          });
          if (msgMatch === 'alias') {
            fallbackEvidences.push({
              id: 'msg-model-alias',
              status: 'info',
              category: 'model',
              message: t('ui.devtools.evidence-model-alias', reqClean, msgRespModel),
            });
          }
        } else if (expV && obsV && expV !== obsV) {
          fallbackVerdict = 'mismatch';
          fallbackEvidences.push({
            id: 'msg-model-cross',
            status: 'fail',
            category: 'model',
            message: t('ui.devtools.evidence-model-cross-vendor', reqClean, expV, obsClean, obsV),
          });
        } else if (msgMatch === 'family') {
          fallbackVerdict = 'suspect';
          fallbackEvidences.push({
            id: 'msg-model-diff',
            status: 'warn',
            category: 'model',
            message: t('ui.devtools.evidence-model-history-diff', reqClean, msgRespModel),
          });
        } else {
          fallbackVerdict = 'mismatch';
          fallbackEvidences.push({
            id: 'msg-model-diff',
            status: 'fail',
            category: 'model',
            message: t('ui.devtools.evidence-model-mismatch', reqClean, msgRespModel),
          });
        }
      }

      const observedFromReqs = auditsForTurn
        .map((a) => a.observedModel)
        .filter((x): x is string => !!x);
      const turnObservedModel = observedFromReqs.find(
        (m) =>
          !turnRawModel || canonicalModelName(m) !== canonicalModelName(turnRawModel),
      ) ?? observedFromReqs[0] ?? msgRespModel;

      const historyEvidence: AuditEvidence[] = [];
      if (
        auditsForTurn.some((a) => a.verdict !== 'mismatch') &&
        msgRespModel &&
        turnRawModel
      ) {
        const expV = inferModelVendor(stripProviderPrefix(turnRawModel) || turnRawModel);
        const obsV = inferModelVendor(stripProviderPrefix(msgRespModel) || msgRespModel);
        if (expV && obsV && expV !== obsV && !auditsForTurn.some((a) => a.verdict === 'mismatch')) {
          historyEvidence.push({
            id: 'msg-model-cross',
            status: 'fail',
            category: 'model',
            message: t(
              'ui.devtools.evidence-model-cross-vendor',
              stripProviderPrefix(turnRawModel) || turnRawModel,
              expV,
              stripProviderPrefix(msgRespModel) || msgRespModel,
              obsV,
            ),
          });
        }
      }

      // 已被请求覆盖的回合只取请求侧判定，回复记录里的冲突出 historyVerdict 进总览，不重复加码
      const turnVerdict = auditsForTurn.length
        ? worstVerdict(auditsForTurn.map((a) => a.verdict))
        : fallbackVerdict;

      let switchedFrom: string | undefined;
      if (modelInfo && prevModelInfo && prevModelInfo.key !== modelInfo.key) {
        switchedFrom = prevModelInfo.name;
        switches.push({
          turnId: tr.id,
          turnLabel: tr.label,
          laneId,
          laneName: lane?.name ?? laneId,
          fromModel: prevModelInfo.name,
          toModel: modelInfo.name,
          at: tr.startedAt,
        });
      }

      const ttfts = auditsForTurn
        .map((a) => a.ttftMs)
        .filter((x): x is number => x !== undefined && Number.isFinite(x));
      const tpsVals = auditsForTurn
        .map((a) => a.tps)
        .filter((x): x is number => x !== undefined && Number.isFinite(x));
      // 有请求的回合：回复消息记录与请求模型冲突（且请求本身没抓到时）也按回复证据记一次
      const combinedEvidences = auditsForTurn.length
        ? [...auditsForTurn.flatMap((a) => a.evidences), ...historyEvidence]
        : fallbackEvidences;
      const historyVerdict = auditsForTurn.length
        ? historyEvidence.length
          ? ('mismatch' as const)
          : ('unverified' as const)
        : turnVerdict === 'unverified'
          ? historyModelVerdict(tr, replyMsg)
          : 'unverified';

      turnAuditsByTurnId[tr.id] = {
        turnId: tr.id,
        verdict: turnVerdict,
        requestedModel: modelInfo?.name ?? turnRawModel,
        observedModel: turnObservedModel,
        ...(switchedFrom ? { switchedFromModel: switchedFrom } : {}),
        requestCount: auditsForTurn.length,
        okCount: auditsForTurn.filter((a) => a.outcome === 'ok').length,
        ...(ttfts.length
          ? { avgTtftMs: ttfts.reduce((s, x) => s + x, 0) / ttfts.length }
          : {}),
        ...(tpsVals.length
          ? { avgTps: tpsVals.reduce((s, x) => s + x, 0) / tpsVals.length }
          : {}),
        evidences: combinedEvidences,
        historyVerdict,
      };

      if (modelInfo) {
        // 更新分模型累计
        let acc = byModelMap.get(modelInfo.key);
        if (!acc) {
          acc = {
            key: modelInfo.key,
            name: modelInfo.name,
            vendor: inferModelVendor(modelInfo.name),
            turnIds: [],
            reqAudits: [],
            verdicts: [],
            observedModels: new Set<string>(),
            fallbackTtfts: [],
            fallbackInputs: 0,
            fallbackOutputs: 0,
            fallbackCacheRead: 0,
            fallbackOk: 0,
            fallbackFailed: 0,
          };
          byModelMap.set(modelInfo.key, acc);
        }
        acc.turnIds.push(tr.id);
        acc.reqAudits.push(...auditsForTurn);
        acc.verdicts.push(turnVerdict);
        if (turnObservedModel) acc.observedModels.add(turnObservedModel);
        if (!auditsForTurn.length) {
          if (tr.durationMs !== undefined) acc.fallbackTtfts.push(tr.durationMs);
          if (tr.usage) {
            acc.fallbackInputs += tr.usage.inputTokens ?? 0;
            acc.fallbackOutputs += tr.usage.outputTokens ?? 0;
            acc.fallbackCacheRead += tr.usage.cacheReadTokens ?? 0;
          }
          if (tr.status === 'error') acc.fallbackFailed += 1;
          else if (tr.status === 'done') acc.fallbackOk += 1;
        }

        // 维护连续分段
        if (!curSeg || curSeg.modelKey !== modelInfo.key) {
          flushSegment();
          curSeg = {
            modelKey: modelInfo.key,
            modelName: modelInfo.name,
            vendor: inferModelVendor(modelInfo.name),
            turns: [tr],
            verdicts: [turnVerdict],
            observed: new Set(turnObservedModel ? [turnObservedModel] : []),
            switchedFrom,
          };
        } else {
          curSeg.turns.push(tr);
          curSeg.verdicts.push(turnVerdict);
          if (turnObservedModel) curSeg.observed.add(turnObservedModel);
        }

        prevModelInfo = modelInfo;
      }
    }
    flushSegment();
  }

  const byModel: TraceModelSummary[] = [...byModelMap.values()].map((acc) => {
    const reqs = acc.reqAudits;
    const reqCount = reqs.length;
    const okCount = reqCount ? reqs.filter((r) => r.outcome === 'ok').length : acc.fallbackOk;
    const failedCount = reqCount
      ? reqs.filter((r) => r.outcome !== 'ok' && r.outcome !== 'client-cancel').length
      : acc.fallbackFailed;
    const denom = okCount + failedCount;
    const ttfts = reqs
      .map((r) => r.ttftMs)
      .filter((x): x is number => x !== undefined && Number.isFinite(x));
    const e2es = reqs.map((r) => r.endMs).filter((x) => Number.isFinite(x) && x > 0);
    const tpss = reqs
      .map((r) => r.tps)
      .filter((x): x is number => x !== undefined && Number.isFinite(x));
    const inputTokens = reqCount
      ? reqs.reduce((s, r) => s + r.inputTokens, 0)
      : acc.fallbackInputs;
    const outputTokens = reqCount
      ? reqs.reduce((s, r) => s + r.outputTokens, 0)
      : acc.fallbackOutputs;
    const cacheReadTokens = reqCount
      ? reqs.reduce((s, r) => s + r.cacheReadTokens, 0)
      : acc.fallbackCacheRead;
    const verdict = worstVerdict(acc.verdicts);
    const anomalyCount = reqCount
      ? reqs.filter((r) => r.verdict === 'mismatch' || r.verdict === 'suspect').length
      : acc.verdicts.filter((v) => v === 'mismatch' || v === 'suspect').length;

    return {
      modelKey: acc.key,
      modelName: acc.name,
      vendor: acc.vendor,
      turnCount: acc.turnIds.length,
      turnIds: acc.turnIds,
      requestCount: reqCount,
      okCount,
      failedCount,
      ...(denom > 0 ? { successRate: okCount / denom } : {}),
      ...(ttfts.length ? { avgTtftMs: ttfts.reduce((s, x) => s + x, 0) / ttfts.length } : {}),
      ...(e2es.length ? { avgE2eMs: e2es.reduce((s, x) => s + x, 0) / e2es.length } : {}),
      ...(tpss.length ? { avgTps: tpss.reduce((s, x) => s + x, 0) / tpss.length } : {}),
      cacheHitRate: cacheHitRate(inputTokens, cacheReadTokens),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      verdict,
      anomalyCount,
      observedModels: [...acc.observedModels],
    };
  });

  // 请求证据与未被请求覆盖的历史回合（仅回复消息回退）一起参与总览：
  // 已被请求覆盖的回合只计请求，避免同一回合双计；没有请求记录的历史回合不能因新请求的出现而被忽略。
  const requestPool = requestAudits.map((r) => r.verdict);
  const uncoveredTurnAudits = Object.values(turnAuditsByTurnId).filter((tItem) => tItem.requestCount === 0);
  const historyPool: ModelAuditVerdict[] = Object.values(turnAuditsByTurnId)
    .filter((tItem) => tItem.requestCount > 0 && tItem.historyVerdict && tItem.historyVerdict !== 'unverified')
    .map((tItem) => tItem.historyVerdict!);
  const auditedPool: ModelAuditVerdict[] = [
    ...requestPool,
    ...historyPool,
    ...uncoveredTurnAudits.map((tItem) => tItem.verdict),
  ];
  const modelNameMismatchRequests = requestAudits.filter((r) =>
    r.evidences.some((e) => e.status === 'fail' && e.category === 'model'),
  ).length;

  const verifiedCount = auditedPool.filter((v) => v === 'verified').length;
  const suspectCount = auditedPool.filter((v) => v === 'suspect').length;
  const mismatchCount = auditedPool.filter((v) => v === 'mismatch').length;
  const unverifiedCount = auditedPool.filter((v) => v === 'unverified').length;

  return {
    summary: {
      distinctModels: byModel.map((m) => ({
        key: m.modelKey,
        name: m.modelName,
        vendor: m.vendor,
        verdict: m.verdict,
      })),
      switchCount: switches.length,
      totalAuditedRequests: requestAudits.length,
      totalAuditedTurns:
        Object.values(turnAuditsByTurnId).filter((tItem) => tItem.requestCount > 0).length +
        uncoveredTurnAudits.length,
      modelNameMismatchRequests,
      historicalModelDiffTurns: uncoveredTurnAudits.filter(
        (tItem) => tItem.verdict === 'mismatch' || tItem.verdict === 'suspect',
      ).length,
      verifiedCount,
      suspectCount,
      mismatchCount,
      unverifiedCount,
      overallVerdict: worstVerdict(auditedPool),
    },
    switches,
    segments,
    byModel,
    requestAudits,
    requestAuditsByReqId,
    turnAuditsByTurnId,
  };
}
