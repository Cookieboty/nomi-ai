/**
 * 生图的「适配器 + 端点」两层（参考 feat/2.1.0-image-gen-p0 的 protocols / providers）：
 * - 适配器（adapters/*）：一家接口一个，只做纯函数的「拼请求 / 解析响应」，不发网络、不碰 Key；
 * - 端点（endpoints.ts）：数据化的规则表，按供应商预设 / 地址 / 上游模型名选适配器与供应商的哪个地址。
 * 主进程（Node core / Go core）负责发请求、按适配器声明的方式放 Key、轮询异步任务、下载图片。
 * 新增一家 = 写一个适配器 + 在规则表里加一行。
 */
import type { Wire } from '../ir';

/** 与厂商无关的画幅；各适配器换算成自家的 size / aspectRatio / image_size */
export type ImageAspect = 'auto' | '1:1' | '3:2' | '2:3' | '16:9' | '9:16';
export const IMAGE_ASPECTS: readonly ImageAspect[] = ['auto', '1:1', '3:2', '2:3', '16:9', '9:16'];

/** Key 放在哪：Authorization: Bearer / Authorization: Key（fal）/ x-goog-api-key / x-api-key */
export type ImageAuth = 'bearer' | 'key' | 'x-goog-api-key' | 'x-api-key';

/** 改图的参考图（主进程从本地文件读出来；只发给图片模型，不进对话上下文） */
export interface ImageRef {
  mime: string;
  /** base64（不带 data: 前缀） */
  b64: string;
}

export interface ImageGenInput {
  /** 端点给出的地址（已按规则推导，例如 DashScope 取站点根） */
  baseURL: string;
  /** 上游模型名 */
  model: string;
  prompt: string;
  aspect: ImageAspect;
  /** 带图：待修改的图片或参考图；没有 = 文生图（只有声明 edit 的适配器会收到） */
  refs?: ImageRef[];
  /**
   * 带图的方式：edit = 在 refs[0] 上修改；reference = 以 refs 为参考（风格 / 主体 / 构图）生成新图。
   * 目前各家两种模式的请求形状相同（OpenAI 都走 /images/edits，Gemini / 方舟 / OpenRouter 都把图附在请求里），
   * 有专门参考图接口的适配器（如 FLUX Kontext / Redux）可以按它分开
   */
  refMode?: 'edit' | 'reference';
}

/** multipart 表单（OpenAI /images/edits 这类要上传文件的接口） */
export interface ImageMultipart {
  fields: Record<string, string>;
  files: Array<{ field: string; name: string; mime: string; b64: string }>;
}

/** 拼好的请求（不含 Key：主进程按 auth 补上）；body 发 JSON，multipart 发表单，二选一 */
export interface ImageHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  multipart?: ImageMultipart;
}

/** 一张图：base64（不带 data: 前缀）或待下载的公网 URL */
export interface GeneratedImage {
  b64?: string;
  url?: string;
  mime?: string;
}

/** 解析结果：拿到图片；或异步任务还没完成，afterMs 后再发 next */
export type ImageParse =
  | { kind: 'images'; images: GeneratedImage[]; revisedPrompt?: string }
  | { kind: 'poll'; next: ImageHttpRequest; afterMs: number }
  | { kind: 'failed'; message: string };

export interface ImageAdapter {
  id: string;
  /** 默认的 Key 放法（端点规则可按供应商覆盖，例如中转站的 Gemini 协议用 Bearer） */
  auth: ImageAuth;
  /** 异步任务最多轮询多久（毫秒）；同步接口不写 */
  timeoutMs?: number;
  /** 支持带图（改图 / 参考图，input.refs）：文生图与带图常是不同的接口（OpenAI generations / edits），由适配器自己分 */
  edit?: boolean;
  build(input: ImageGenInput): ImageHttpRequest;
  /** 解析某次响应（首次请求或轮询）；拿不到图也不是任务状态时返回 images: [] */
  parse(body: unknown, input: ImageGenInput): ImageParse;
}

/** 端点判断要用的供应商信息（来自网关供应商配置，不含 Key） */
export interface ImageProviderInfo {
  id: string;
  presetId?: string;
  urls: Partial<Record<Wire, string>>;
  /** 各协议探测到的鉴权方式（中转站的 Gemini 协议常是 Bearer） */
  auth?: Partial<Record<Wire, 'bearer' | 'x-api-key' | 'x-goog-api-key'>>;
}

/** 选好的端点：用哪个适配器、发到哪、用供应商哪个协议的 Key、Key 怎么放 */
export interface ImageEndpoint {
  adapter: ImageAdapter;
  baseURL: string;
  wire: Wire;
  auth: ImageAuth;
}
