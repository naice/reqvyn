import * as vscode from 'vscode';
import type { HttpResponseData } from '@reqvyn/core';

export const RESPONSE_SCHEME = 'reqvyn-response';

/** Pick a file extension / language from a content type. */
export function extensionFor(contentType: string): { ext: string; language: string } {
  const ct = contentType.toLowerCase();
  if (ct.includes('json')) return { ext: 'json', language: 'json' };
  if (ct.includes('html')) return { ext: 'html', language: 'html' };
  if (ct.includes('xml')) return { ext: 'xml', language: 'xml' };
  if (ct.includes('javascript')) return { ext: 'js', language: 'javascript' };
  if (ct.includes('css')) return { ext: 'css', language: 'css' };
  if (ct.includes('yaml')) return { ext: 'yaml', language: 'yaml' };
  if (ct.includes('csv')) return { ext: 'csv', language: 'csv' };
  return { ext: 'txt', language: 'plaintext' };
}

/** Body as text; JSON is pretty-printed so diffs and the editor view are readable. */
export function responseText(response: HttpResponseData): string {
  const text = Buffer.from(response.body.base64, 'base64').toString('utf8');
  if (extensionFor(response.contentType).language === 'json') {
    try {
      return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
    } catch {
      return text;
    }
  }
  return text;
}

/** Status line + headers + body, used for "compare responses". */
export function responseDocument(response: HttpResponseData): string {
  const head = [`HTTP/${response.httpVersion} ${response.status} ${response.statusText}`, ...response.headers.map(([k, v]) => `${k}: ${v}`)].join('\n');
  return `${head}\n\n${responseText(response)}`;
}

/** Read-only virtual documents holding response snapshots (used by vscode.diff). */
export class ResponseDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private counter = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path) ?? '';
  }

  /** Register a snapshot and return its URI. Old snapshots are evicted (keeps memory bounded). */
  put(label: string, ext: string, content: string): vscode.Uri {
    const path = `/${++this.counter}/${label.replace(/[^\w.-]+/g, '_') || 'response'}.${ext}`;
    this.docs.set(path, content);
    if (this.docs.size > 40) this.docs.delete(this.docs.keys().next().value!);
    return vscode.Uri.from({ scheme: RESPONSE_SCHEME, path });
  }

  dispose(): void {
    this.docs.clear();
    this.emitter.dispose();
  }
}
