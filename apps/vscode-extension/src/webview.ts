import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { WebviewToHostSchema, type HostToWebview, type WebviewToHost, type WebviewView } from '@reqvyn/core';
import { errorMessage, isReqvynError } from '@reqvyn/shared';

export function webviewRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(extensionUri, 'media')];
}

/**
 * HTML shell for every REQVYN webview: strict CSP with a per-load nonce, no remote content,
 * scripts only from the bundled `dist/webview` directory.
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: WebviewView, title: string): string {
  const nonce = randomBytes(16).toString('base64');
  const base = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'webview.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'webview.css'));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource}`,
    // React applies inline style properties; no inline <style> or remote CSS is loaded.
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    // Response previews render in a sandboxed blob/srcdoc frame without network access.
    "frame-src blob: data:",
    "connect-src 'none'",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="${vscode.env.language || 'en'}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}" nonce="${nonce}">
<title>${escapeHtml(title)}</title>
</head>
<body>
<div id="root" data-view="${view}"></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Base class for REQVYN webview panels. Validates every incoming message with the Zod protocol
 * schema and answers `ready` with `init` followed by the view's state.
 */
export abstract class ReqvynPanel implements vscode.Disposable {
  protected readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private ready = false;
  private readonly onDisposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.onDisposeEmitter.event;

  protected constructor(
    readonly panel: vscode.WebviewPanel,
    protected readonly extensionUri: vscode.Uri,
    protected readonly view: WebviewView,
  ) {
    panel.iconPath = { light: vscode.Uri.joinPath(extensionUri, 'media', 'reqvyn-light.svg'), dark: vscode.Uri.joinPath(extensionUri, 'media', 'reqvyn-dark.svg') };
    panel.webview.html = webviewHtml(panel.webview, extensionUri, view, panel.title);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => void this.receive(raw)),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  static options(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: webviewRoots(extensionUri), enableFindWidget: true };
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  post(message: HostToWebview): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(message);
  }

  toast(level: 'info' | 'warning' | 'error', message: string): void {
    this.post({ type: 'toast', level, message });
  }

  private async receive(raw: unknown): Promise<void> {
    const parsed = WebviewToHostSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('[reqvyn] rejected invalid webview message', parsed.error.issues.slice(0, 3));
      return;
    }
    const msg = parsed.data;
    try {
      if (msg.type === 'ready') {
        this.ready = true;
        this.post({ type: 'init', view: this.view, brand: { iconUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png')).toString() } });
        await this.sendState();
        return;
      }
      if (msg.type === 'clipboard:write') {
        await vscode.env.clipboard.writeText(msg.text);
        this.toast('info', 'Copied to clipboard.');
        return;
      }
      await this.handle(msg);
    } catch (e) {
      const text = isReqvynError(e) ? `${e.message}${e.hint ? ` – ${e.hint}` : ''}` : errorMessage(e);
      this.toast('error', text);
    }
  }

  protected get isReady(): boolean {
    return this.ready;
  }

  /** Send the full state for this view. */
  protected abstract sendState(): Promise<void>;
  protected abstract handle(msg: WebviewToHost): Promise<void>;

  /** Ask the host for a file path on behalf of the webview (the webview never touches the file system). */
  protected async pickFile(token: string, purpose: string, baseDir?: string): Promise<void> {
    const filters: Record<string, Record<string, string[]>> = {
      cert: { Certificates: ['pem', 'crt', 'cer'], 'All files': ['*'] },
      key: { Keys: ['pem', 'key'], 'All files': ['*'] },
      pfx: { 'PKCS#12': ['pfx', 'p12'], 'All files': ['*'] },
      data: { 'Data files': ['csv', 'json'] },
    };
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: filters[purpose], defaultUri: baseDir ? vscode.Uri.file(baseDir) : undefined });
    let path = picked?.[0]?.fsPath ?? null;
    // Store paths relative to the workspace when possible so collections stay portable.
    if (path && baseDir && path.toLowerCase().startsWith(baseDir.toLowerCase())) {
      path = path.slice(baseDir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    }
    this.post({ type: 'file:picked', token, path });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onDisposeEmitter.fire();
    this.onDisposeEmitter.dispose();
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
