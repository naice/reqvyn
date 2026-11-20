/**
 * Minimal stand-in for the `vscode` module so pure extension helpers can be unit-tested
 * without an Extension Development Host. Aliased in vitest.config.ts.
 * Anything not modelled here is a permissive no-op proxy.
 */
const noop = (): unknown => proxy;
const proxy: unknown = new Proxy(noop, {
  get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => '' : proxy),
  apply: () => proxy,
  construct: () => proxy as object,
});

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Disposable {
  constructor(private readonly fn?: () => void) {}
  dispose(): void {
    this.fn?.();
  }
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class TreeItem {
  constructor(
    public label: unknown,
    public collapsibleState?: number,
  ) {}
}

export class MarkdownString {
  constructor(public value = '') {}
  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }
  appendText(s: string): this {
    this.value += s;
    return this;
  }
}

export class DataTransferItem {
  constructor(readonly value: unknown) {}
  asString(): Promise<string> {
    return Promise.resolve(String(this.value));
  }
}

interface MockUri {
  scheme: string;
  path: string;
  fsPath: string;
  toString(): string;
}
const makeUri = (scheme: string, p: string): MockUri => ({ scheme, path: p, fsPath: p, toString: () => `${scheme}://${p}` });
export const Uri = {
  file: (p: string) => makeUri('file', p),
  parse: (s: string) => makeUri(s.split(':')[0] ?? 'file', s.replace(/^[a-z-]+:\/*/i, '/')),
  joinPath: (u: MockUri, ...segments: string[]) => makeUri(u.scheme, [u.path.replace(/\/$/, ''), ...segments].join('/')),
  from: (o: { scheme: string; path: string }) => makeUri(o.scheme, o.path),
};

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ViewColumn = { Active: -1, Beside: -2, One: 1 };
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };

export const env = { language: 'en', clipboard: { readText: async () => '', writeText: async () => undefined } };
export const workspace = proxy;
export const window = proxy;
export const commands = proxy;
export const l10n = { t: (s: string) => s };
