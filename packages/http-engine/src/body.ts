import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { ReqvynError } from '@reqvyn/shared';

/**
 * A request body that can be (re)opened multiple times, which is required for redirects (307/308)
 * and authentication round trips (Digest). Files are streamed, never fully buffered.
 */
export interface PreparedBody {
  contentType?: string;
  length?: number;
  open(): Readable;
  /** Short textual preview for timelines / raw view (only for in-memory bodies). */
  preview?: string;
  /** The full in-memory bytes when available (used for signing, e.g. AWS SigV4). */
  bytes?: Uint8Array;
}

export function bufferBody(data: string | Uint8Array, contentType?: string): PreparedBody {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return {
    contentType,
    length: buf.length,
    open: () => Readable.from([buf]),
    preview: buf.length <= 64 * 1024 ? buf.toString('utf8') : buf.subarray(0, 64 * 1024).toString('utf8') + '\n…',
    bytes: buf,
  };
}

export async function fileBody(filePath: string, contentType?: string): Promise<PreparedBody> {
  let size: number;
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not a file');
    size = s.size;
  } catch (e) {
    throw new ReqvynError('IO', `Cannot read body file "${filePath}".`, { cause: e });
  }
  return {
    contentType: contentType ?? guessContentType(filePath),
    length: size,
    open: () => createReadStream(filePath),
    preview: `<file ${basename(filePath)}, ${size} bytes>`,
  };
}

export interface MultipartInput {
  name: string;
  type: 'text' | 'file';
  value?: string;
  filePath?: string;
  contentType?: string;
}

/** Streaming multipart/form-data encoder with a precomputed Content-Length. */
export async function multipartBody(parts: MultipartInput[]): Promise<PreparedBody> {
  const boundary = `----ReqvynBoundary${randomBytes(12).toString('hex')}`;
  const segments: Array<Buffer | { path: string; size: number }> = [];
  const previewLines: string[] = [];
  for (const p of parts) {
    const name = escapeQuoted(p.name);
    if (p.type === 'file') {
      if (!p.filePath) throw new ReqvynError('VALIDATION', `Multipart field "${p.name}" has no file selected.`);
      let size: number;
      try {
        size = (await stat(p.filePath)).size;
      } catch (e) {
        throw new ReqvynError('IO', `Cannot read multipart file "${p.filePath}".`, { cause: e });
      }
      const filename = escapeQuoted(basename(p.filePath));
      const ct = p.contentType || guessContentType(p.filePath);
      segments.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${ct}\r\n\r\n`));
      segments.push({ path: p.filePath, size });
      segments.push(Buffer.from('\r\n'));
      previewLines.push(`${p.name}: <file ${filename}, ${size} bytes>`);
    } else {
      const ctLine = p.contentType ? `Content-Type: ${p.contentType}\r\n` : '';
      segments.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n${ctLine}\r\n${p.value ?? ''}\r\n`));
      previewLines.push(`${p.name}: ${p.value ?? ''}`);
    }
  }
  segments.push(Buffer.from(`--${boundary}--\r\n`));
  const length = segments.reduce((n, s) => n + (Buffer.isBuffer(s) ? s.length : s.size), 0);
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    length,
    preview: previewLines.join('\n'),
    open: () =>
      Readable.from(
        (async function* () {
          for (const s of segments) {
            if (Buffer.isBuffer(s)) yield s;
            else for await (const chunk of createReadStream(s.path)) yield chunk as Buffer;
          }
        })(),
      ),
  };
}

function escapeQuoted(s: string): string {
  return s.replace(/["\\\r\n]/g, (c) => ({ '"': '%22', '\\': '\\\\', '\r': '%0D', '\n': '%0A' })[c] ?? c);
}

const EXT_TYPES: Record<string, string> = {
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  csv: 'text/csv',
  js: 'text/javascript',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  yaml: 'application/yaml',
  yml: 'application/yaml',
};

export function guessContentType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TYPES[ext] ?? 'application/octet-stream';
}
