import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { RunnerSettingsSchema, ancestorFolders, type WebviewToHost } from '@reqvyn/core';
import { createVariableState, parseDataFile, renderReport, runCollection, selectRequests, type ReportFormat, type RunReport } from '@reqvyn/runner';
import { ReqvynError, toErrorJson } from '@reqvyn/shared';
import { ReqvynPanel } from '../webview.js';
import { RequestPanel, type PanelHost } from './requestPanel.js';

export interface RunnerRef {
  storeId: string;
  collectionId: string;
  folderId?: string | null;
}

const keyOf = (r: RunnerRef) => `${r.storeId}|${r.collectionId}|${r.folderId ?? ''}`;
const EXT: Record<ReportFormat, string> = { json: 'json', html: 'html', junit: 'xml' };

/** Collection runner: iterations, data files, delays, concurrency, reports. */
export class RunnerPanel extends ReqvynPanel {
  private static readonly panels = new Map<string, RunnerPanel>();
  private abort?: AbortController;
  private report?: RunReport;

  static async open(host: PanelHost, ref: RunnerRef): Promise<RunnerPanel> {
    const existing = RunnerPanel.panels.get(keyOf(ref));
    if (existing && !existing.isDisposed) {
      existing.panel.reveal();
      return existing;
    }
    const c = await host.services.stores.loadCollection(ref.storeId, ref.collectionId);
    const folder = ref.folderId ? c.folders.find((f) => f.id === ref.folderId) : undefined;
    const panel = vscode.window.createWebviewPanel('reqvyn.runner', `Run: ${folder?.name ?? c.name}`, vscode.ViewColumn.Active, ReqvynPanel.options(host.extensionUri));
    const p = new RunnerPanel(panel, host, ref);
    RunnerPanel.panels.set(keyOf(ref), p);
    return p;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly host: PanelHost,
    private readonly ref: RunnerRef,
  ) {
    super(panel, host.extensionUri, 'runner');
    this.disposables.push({ dispose: () => this.abort?.abort() }, { dispose: () => RunnerPanel.panels.delete(keyOf(ref)) });
  }

  protected async sendState(): Promise<void> {
    const s = this.host.services;
    const c = await s.stores.loadCollection(this.ref.storeId, this.ref.collectionId);
    const envs = await s.stores.environments(this.ref.storeId);
    this.post({
      type: 'runner:config',
      config: {
        storeId: this.ref.storeId,
        collectionId: c.id,
        folderId: this.ref.folderId ?? null,
        collectionName: c.name,
        requests: selectRequests({ collection: c, folderId: this.ref.folderId ?? null }).map((r) => ({
          id: r.id,
          name: r.name,
          method: r.method,
          path: ancestorFolders(c, r.parentId)
            .map((f) => f.name)
            .join(' / '),
        })),
      },
      environments: envs.map((e) => ({ id: e.id, name: e.name })),
      activeEnvironmentId: s.state.activeEnvironmentId(this.ref.storeId),
      defaults: RunnerSettingsSchema.parse(c.runner ?? {}),
    });
  }

  protected async handle(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'runner:start':
        await this.start(msg.options);
        return;
      case 'runner:cancel':
        this.abort?.abort();
        return;
      case 'runner:export':
        await this.exportReport(msg.format);
        return;
      case 'runner:openRequest':
        await RequestPanel.open(this.host, { storeId: this.ref.storeId, collectionId: this.ref.collectionId, requestId: msg.requestId });
        return;
      case 'file:pick':
        await this.pickFile(msg.token, msg.purpose, this.host.services.stores.get(this.ref.storeId).baseDir);
        return;
      default:
        return;
    }
  }

  private async start(options: Extract<WebviewToHost, { type: 'runner:start' }>['options']): Promise<void> {
    if (this.abort) throw new ReqvynError('CONFLICT', 'A run is already in progress.');
    const s = this.host.services;
    const entry = s.stores.get(this.ref.storeId);
    const abort = new AbortController();
    this.abort = abort;
    try {
      const collection = await entry.store.loadCollection(this.ref.collectionId);
      const environment = options.environmentId ? ((await entry.store.listEnvironments()).find((e) => e.id === options.environmentId) ?? null) : null;
      let data;
      if (options.dataFile) {
        const file = isAbsolute(options.dataFile) ? options.dataFile : join(entry.baseDir, options.dataFile);
        data = parseDataFile(file, await fs.readFile(file, 'utf8'));
        if (!data.length) throw new ReqvynError('VALIDATION', 'The data file contains no rows.');
      }
      // Runs start with the session's runtime values; persisting writes results back afterwards.
      const base = s.state.variableState(this.ref.storeId);
      const state = options.persistVariables ? base : { ...createVariableState(), runtime: new Map(base.runtime) };
      const exec = await s.executorOptions(entry.baseDir);
      const report = await runCollection(
        {
          collection,
          folderId: this.ref.folderId ?? null,
          skip: options.skip,
          iterations: options.iterations,
          delayMs: options.delayMs,
          concurrency: options.concurrency,
          stopOnFailure: options.stopOnFailure,
          data,
          environment,
          globals: s.state.globalVariables(),
          workspace: (await entry.store.loadConfig()).variables,
          state,
          signal: abort.signal,
          onProgress: (progress) => this.post({ type: 'runner:progress', progress }),
          onResult: async (outcome) => {
            if (options.persistVariables) await s.persistVariableChanges(this.ref.storeId, collection.id, outcome.rawVariableChanges);
          },
        },
        exec,
      );
      this.report = report;
      this.post({ type: 'runner:done', summary: report.summary });
      if (options.persistVariables) await RequestPanel.refreshVariables();
    } catch (e) {
      this.post({ type: 'runner:error', error: toErrorJson(e) });
    } finally {
      this.abort = undefined;
    }
  }

  private async exportReport(format: ReportFormat): Promise<void> {
    if (!this.report) {
      this.toast('info', 'Run the collection first.');
      return;
    }
    const entry = this.host.services.stores.get(this.ref.storeId);
    const name = format === 'junit' ? 'reqvyn-junit.xml' : `reqvyn-report.${EXT[format]}`;
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(join(entry.baseDir, name)), filters: { Report: [EXT[format]] } });
    if (!uri) return;
    await fs.writeFile(uri.fsPath, renderReport(this.report, format), 'utf8');
    const open = await vscode.window.showInformationMessage(`Report saved to ${uri.fsPath}`, format === 'html' ? 'Open in browser' : 'Open');
    if (open === 'Open in browser') await vscode.env.openExternal(uri);
    else if (open) await vscode.window.showTextDocument(uri);
  }
}
