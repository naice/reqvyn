export type LanguageId = 'json' | 'xml' | 'html' | 'javascript' | 'yaml' | 'graphql' | 'text';

export const LANGUAGE_LABELS: Record<LanguageId, string> = {
  json: 'JSON',
  xml: 'XML',
  html: 'HTML',
  javascript: 'JavaScript',
  yaml: 'YAML',
  graphql: 'GraphQL',
  text: 'Plain text',
};

export function mimeOf(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

export function languageFromContentType(contentType: string): LanguageId | null {
  const mime = mimeOf(contentType);
  if (!mime) return null;
  if (mime === 'application/json' || mime.endsWith('+json') || mime === 'text/json' || mime === 'application/x-ndjson') return 'json';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime === 'application/xml' || mime === 'text/xml' || mime.endsWith('+xml')) return 'xml';
  if (mime.includes('javascript') || mime.includes('ecmascript') || mime === 'application/typescript') return 'javascript';
  if (mime.includes('yaml')) return 'yaml';
  if (mime.includes('graphql')) return 'graphql';
  if (mime.startsWith('text/')) return 'text';
  return null;
}

/** Detect the language for a response body by content type, falling back to sniffing the text. */
export function detectLanguage(contentType: string, text: string): LanguageId {
  const byType = languageFromContentType(contentType);
  if (byType && byType !== 'text') return byType;
  const head = text.slice(0, 512).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) {
    if (looksLikeJson(text)) return 'json';
  }
  if (/^<!doctype html|^<html[\s>]/i.test(head)) return 'html';
  if (head.startsWith('<?xml') || /^<[A-Za-z_][\w:.-]*[\s>/]/.test(head)) return 'xml';
  return byType ?? 'text';
}

function looksLikeJson(text: string): boolean {
  if (text.length > 5_000_000) return true; // too big to verify cheaply; trust the leading bracket
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function isImageType(contentType: string): boolean {
  const mime = mimeOf(contentType);
  return mime.startsWith('image/');
}

const BINARY_TYPES = [
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/vnd.',
  'application/msword',
  'application/x-protobuf',
  'application/protobuf',
  'application/grpc',
  'audio/',
  'video/',
  'font/',
];

/** True when the body should not be rendered as text. */
export function isBinary(contentType: string, bytes: Uint8Array): boolean {
  const mime = mimeOf(contentType);
  if (isImageType(contentType) && mime !== 'image/svg+xml') return true;
  if (languageFromContentType(contentType)) return false;
  if (BINARY_TYPES.some((t) => mime.startsWith(t))) return true;
  const n = Math.min(bytes.length, 1024);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}
