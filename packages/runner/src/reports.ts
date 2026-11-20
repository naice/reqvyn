import { escapeHtml, escapeXml, formatBytes, formatDuration } from '@reqvyn/shared';
import type { TestResult } from '@reqvyn/core';
import type { RunReport, RunResultEntry } from './runner.js';

export type ReportFormat = 'json' | 'html' | 'junit';

export function toJsonReport(report: RunReport): string {
  return JSON.stringify(report, null, 2) + '\n';
}

function flatten(tests: TestResult[], depth = 0): Array<TestResult & { depth: number }> {
  return tests.flatMap((t) => [{ ...t, depth }, ...flatten(t.children ?? [], depth + 1)]);
}

function caseName(r: RunResultEntry, report: RunReport): string {
  return report.iterations > 1 ? `${r.requestName} [iteration ${r.iteration}]` : r.requestName;
}

/** JUnit XML: one <testsuite> per request execution, one <testcase> per test/assertion. */
export function toJUnitReport(report: RunReport): string {
  const s = report.summary;
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const totalTests = report.results.reduce((n, r) => n + Math.max(1, r.tests.length), 0);
  lines.push(
    `<testsuites name="${escapeXml(report.collection.name)}" tests="${totalTests}" failures="${s.assertions.failed}" errors="${s.errored}" time="${(s.durationMs / 1000).toFixed(3)}" timestamp="${escapeXml(s.startedAt)}">`,
  );
  for (const r of report.results) {
    const name = caseName(r, report);
    const failures = r.tests.filter((t) => !t.passed).length;
    const time = (r.durationMs / 1000).toFixed(3);
    lines.push(
      `  <testsuite name="${escapeXml(name)}" tests="${Math.max(1, r.tests.length)}" failures="${failures}" errors="${r.error ? 1 : 0}" skipped="${r.skipped ? 1 : 0}" time="${time}">`,
    );
    if (r.response) {
      lines.push(`    <properties>`);
      lines.push(`      <property name="method" value="${escapeXml(r.response.sentRequest.method)}"/>`);
      lines.push(`      <property name="url" value="${escapeXml(r.response.sentRequest.url)}"/>`);
      lines.push(`      <property name="status" value="${r.response.status}"/>`);
      lines.push(`    </properties>`);
    }
    if (r.skipped) {
      lines.push(`    <testcase classname="${escapeXml(name)}" name="${escapeXml(name)}" time="0"><skipped/></testcase>`);
    } else if (r.error) {
      lines.push(`    <testcase classname="${escapeXml(name)}" name="${escapeXml(name)}" time="${time}">`);
      lines.push(`      <error type="${escapeXml(r.error.code)}" message="${escapeXml(r.error.message)}">${escapeXml(r.error.hint ?? r.error.message)}</error>`);
      lines.push(`    </testcase>`);
    } else if (r.tests.length === 0) {
      lines.push(`    <testcase classname="${escapeXml(name)}" name="${escapeXml(name)} (no tests)" time="${time}"/>`);
    }
    for (const t of r.tests) {
      lines.push(`    <testcase classname="${escapeXml(name)}" name="${escapeXml(t.name)}" time="0">`);
      if (!t.passed) lines.push(`      <failure message="${escapeXml(t.message ?? 'failed')}">${escapeXml(t.message ?? '')}</failure>`);
      lines.push(`    </testcase>`);
    }
    if (r.console.length) {
      lines.push(`    <system-out>${escapeXml(r.console.map((c) => `[${c.level}] ${c.message}`).join('\n'))}</system-out>`);
    }
    lines.push(`  </testsuite>`);
  }
  lines.push('</testsuites>');
  return lines.join('\n') + '\n';
}

const STATUS_LABEL = { passed: 'Passed', failed: 'Failed', errored: 'Error', skipped: 'Skipped' } as const;

/**
 * Self-contained HTML report (no scripts, no external resources). All dynamic content is escaped;
 * a strict CSP meta tag prevents any script execution even if opened in a browser.
 */
export function toHtmlReport(report: RunReport): string {
  const s = report.summary;
  const rows = report.results
    .map((r) => {
      const tests = flatten(r.tests)
        .map(
          (t) =>
            `<li class="${t.passed ? 'ok' : 'bad'}" style="margin-left:${t.depth * 16}px"><span class="mark">${t.passed ? '✓' : '✗'}</span> ${escapeHtml(t.name)}${
              t.message && !t.passed ? `<div class="msg">${escapeHtml(t.message)}</div>` : ''
            }</li>`,
        )
        .join('');
      const resp = r.response
        ? `<span class="code c${String(r.response.status)[0]}">${r.response.status}</span> <span class="dim">${escapeHtml(formatDuration(r.durationMs))} · ${escapeHtml(formatBytes(r.response.body.size))}</span>`
        : '';
      const err = r.error ? `<div class="msg">${escapeHtml(r.error.code)}: ${escapeHtml(r.error.message)}${r.error.hint ? ` — ${escapeHtml(r.error.hint)}` : ''}</div>` : '';
      const method = r.response?.sentRequest.method ?? '';
      const url = r.response?.sentRequest.url ?? '';
      return `<section class="req ${r.status}">
  <header><span class="badge ${r.status}">${STATUS_LABEL[r.status]}</span> <strong>${escapeHtml(r.requestName)}</strong>${report.iterations > 1 ? ` <span class="dim">#${r.iteration}</span>` : ''} ${resp}</header>
  ${url ? `<div class="url"><b>${escapeHtml(method)}</b> ${escapeHtml(url)}</div>` : ''}
  ${err}
  ${tests ? `<ul class="tests">${tests}</ul>` : ''}
</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>REQVYN Report – ${escapeHtml(report.collection.name)}</title>
<style>
:root{--bg:#0D111B;--panel:#151B2B;--panel2:#1E2639;--accent:#00E5FF;--violet:#A855F7;--text:#F1F5F9;--muted:#94A3B8;--border:#293449;--ok:#22C55E;--warn:#F59E0B;--bad:#EF4444}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--text)}
main{max-width:1100px;margin:0 auto;padding:24px}
h1{margin:0 0 4px;font-size:22px}h1 span{background:linear-gradient(90deg,var(--accent),var(--violet));-webkit-background-clip:text;background-clip:text;color:transparent}
.dim{color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:20px 0}
.card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px}.card b{display:block;font-size:22px}
.req{background:var(--panel);border:1px solid var(--border);border-left:4px solid var(--border);border-radius:8px;padding:12px 14px;margin:10px 0}
.req.passed{border-left-color:var(--ok)}.req.failed,.req.errored{border-left-color:var(--bad)}.req.skipped{border-left-color:var(--muted)}
.badge{font-size:11px;padding:2px 8px;border-radius:99px;background:var(--panel2);text-transform:uppercase;letter-spacing:.04em}
.badge.passed{color:var(--ok)}.badge.failed,.badge.errored{color:var(--bad)}.badge.skipped{color:var(--muted)}
.url{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--muted);margin-top:4px;word-break:break-all}
.code{font-weight:600}.c2{color:var(--ok)}.c3{color:var(--accent)}.c4{color:var(--warn)}.c5{color:var(--bad)}
.tests{list-style:none;padding:0;margin:8px 0 0}.tests li{padding:2px 0}.ok .mark{color:var(--ok)}.bad .mark{color:var(--bad)}
.msg{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--bad);white-space:pre-wrap;margin:2px 0 0 18px}
footer{margin-top:24px;color:var(--muted);font-size:12px}
</style>
</head>
<body><main>
<h1><span>REQVYN</span> Run Report</h1>
<div class="dim">${escapeHtml(report.collection.name)}${report.environment ? ` · Environment: ${escapeHtml(report.environment.name)}` : ''} · ${escapeHtml(s.startedAt)} · ${escapeHtml(formatDuration(s.durationMs))}${s.cancelled ? ' · <b style="color:var(--warn)">cancelled</b>' : ''}</div>
<div class="cards">
<div class="card"><span class="dim">Requests</span><b>${s.total}</b></div>
<div class="card"><span class="dim">Passed</span><b style="color:var(--ok)">${s.passed}</b></div>
<div class="card"><span class="dim">Failed</span><b style="color:var(--bad)">${s.failed}</b></div>
<div class="card"><span class="dim">Errors</span><b style="color:var(--bad)">${s.errored}</b></div>
<div class="card"><span class="dim">Skipped</span><b>${s.skipped}</b></div>
<div class="card"><span class="dim">Assertions</span><b>${s.assertions.passed}/${s.assertions.passed + s.assertions.failed}</b></div>
</div>
${rows}
<footer>Generated by REQVYN ${escapeHtml(report.tool.version)} — Send. Inspect. Repeat. Secret values are masked.</footer>
</main></body></html>
`;
}

export function renderReport(report: RunReport, format: ReportFormat): string {
  return format === 'json' ? toJsonReport(report) : format === 'html' ? toHtmlReport(report) : toJUnitReport(report);
}
