import { t } from '../i18n';
/**
 * OpenAI 兼容的云端 / 本地服务识别：POST {baseURL}/audio/transcriptions（multipart）。
 * 适用于 OpenAI、Groq、SiliconFlow 等，以及本地 whisper.cpp server（--inference-path /v1/audio/transcriptions）。
 */
export function transcriptionsURL(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/audio/transcriptions`;
}

export async function transcribeOpenAICompat(o: {
  baseURL: string;
  apiKey?: string;
  model: string;
  wav: Uint8Array;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(o.wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', o.model);
  form.append('response_format', 'json');
  if (o.language && o.language !== 'auto') form.append('language', o.language);
  if (o.prompt) form.append('prompt', o.prompt);
  const res = await (o.fetchImpl ?? fetch)(transcriptionsURL(o.baseURL), {
    method: 'POST',
    headers: o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {},
    body: form,
    signal: o.signal,
  });
  const body = await res.text();
  if (!res.ok)
    throw new Error(
      t('electron.common.recognition-service-returned', res.status, body.slice(0, 200)),
    );
  try {
    const j = JSON.parse(body) as { text?: string };
    return (j.text ?? '').trim();
  } catch {
    return body.trim();
  }
}
