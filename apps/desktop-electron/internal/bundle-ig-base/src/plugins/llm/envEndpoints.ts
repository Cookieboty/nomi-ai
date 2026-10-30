/**
 * 环境变量 provider id → 通用 OpenAI Chat Completions 端点的默认值（仅预填，不是按厂商的代码路径）。
 * Claude / Gemini 走各自官方的 OpenAI 兼容端点。
 */
export interface EnvEndpointDefaults {
  baseURL: string;
  model: string;
  requiresApiKey: boolean;
}

export const ENV_ENDPOINT_DEFAULTS: Readonly<Record<string, EnvEndpointDefaults>> = {
  openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', requiresApiKey: true },
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    requiresApiKey: true,
  },
  ollama: {
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:3b-instruct',
    requiresApiKey: false,
  },
  llamacpp: { baseURL: 'http://127.0.0.1:8080/v1', model: 'local', requiresApiKey: false },
  claude: {
    baseURL: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    requiresApiKey: true,
  },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    requiresApiKey: true,
  },
  qwen: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    requiresApiKey: true,
  },
  doubao: {
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-pro',
    requiresApiKey: true,
  },
};
