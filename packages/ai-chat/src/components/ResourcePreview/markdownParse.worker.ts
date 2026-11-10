import {
  parsePreviewMarkdown,
  type MarkdownParseRequest,
  type MarkdownParseResponse,
} from './markdownParse';

self.onmessage = ({ data }: MessageEvent<MarkdownParseRequest>) => {
  let response: MarkdownParseResponse;
  try {
    response = { id: data.id, tree: parsePreviewMarkdown(data.text, data.editable) };
  } catch {
    response = { id: data.id, error: 'Markdown worker parsing failed' };
  }
  self.postMessage(response);
};
