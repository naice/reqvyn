import { createRequest, kv, parseRequest, type Auth, type HttpRequest, type KeyValue, type MultipartPart, type RequestBody, type RequestSettings } from '@reqvyn/core';
import { newId } from '@reqvyn/shared';
import type { ImportResult, ImportWarning } from '../types.js';
import { CollectionBuilder, Warnings, importError, nowIso, parseJsonSafe, parseQueryString, splitUrl } from '../util.js';

/**
 * cURL command parser. Handles POSIX shell quoting ('…', "…", $'…', backslash escapes and line
 * continuations), Windows cmd (`^` escapes and continuations, as produced by "Copy as cURL (cmd)")
 * and PowerShell backtick continuations.
 */

const NEWLINE = '\u0000NL';

export function tokenizeShell(input: string): string[] {
  let s = input.replace(/\r\n?/g, '\n');
  const cmdMode = /\^\n/.test(s) || /\^"/.test(s);
  if (cmdMode) s = s.replace(/\^\n/g, ' ').replace(/\^(.)/g, '$1');
  s = s.replace(/`\n/g, ' ');
  const tokens: string[] = [];
  let cur = '';
  let has = false;
  const push = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === ' ' || c === '\t') {
      push();
      continue;
    }
    if (c === '\n') {
      push();
      tokens.push(NEWLINE);
      continue;
    }
    if (c === '#' && !has && (i === 0 || /\s/.test(s[i - 1] ?? ''))) {
      while (i < s.length && s[i] !== '\n') i++;
      i--;
      continue;
    }
    if (c === '\\' && !cmdMode) {
      const n = s[i + 1];
      if (n === '\n') {
        i++;
        continue;
      }
      if (n !== undefined) {
        cur += n;
        has = true;
        i++;
      }
      continue;
    }
    if (c === "'") {
      has = true;
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw importError('Unterminated single quote in cURL command.');
      cur += s.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      has = true;
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const e = s[i + 1] as string;
          i += 2;
          const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '0': '\0' };
          if (e === 'x') {
            const hex = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i))?.[0] ?? '';
            cur += String.fromCharCode(parseInt(hex || '0', 16));
            i += hex.length;
          } else if (e === 'u') {
            const hex = /^[0-9a-fA-F]{1,4}/.exec(s.slice(i))?.[0] ?? '';
            cur += String.fromCharCode(parseInt(hex || '0', 16));
            i += hex.length;
          } else cur += simple[e] ?? `\\${e}`;
          continue;
        }
        cur += s[i];
        i++;
      }
      if (i >= s.length) throw importError("Unterminated $'…' string in cURL command.");
      continue;
    }
    if (c === '"') {
      has = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1] as string)) {
          if (s[i + 1] !== '\n') cur += s[i + 1];
          i += 2;
          continue;
        }
        cur += s[i];
        i++;
      }
      if (i >= s.length) throw importError('Unterminated double quote in cURL command.');
      continue;
    }
    cur += c;
    has = true;
  }
  push();
  return tokens;
}

const SHORT_WITH_VALUE = new Set('XHdFubAemoxETwDcKrCyYzQ'.split(''));
const SHORT_BOOL = new Set('GIkLsSvifNO46#qjMglRZpnB0123:'.split(''));
const LONG_WITH_VALUE = new Set([
  'request', 'header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json', 'form', 'form-string', 'user', 'cookie', 'user-agent',
  'referer', 'url', 'url-query', 'max-time', 'connect-timeout', 'max-redirs', 'output', 'proxy', 'cert', 'key', 'cacert', 'capath', 'cert-type', 'key-type', 'pass',
  'oauth2-bearer', 'write-out', 'dump-header', 'cookie-jar', 'config', 'range', 'retry', 'retry-delay', 'retry-max-time', 'resolve', 'connect-to', 'interface',
  'proxy-user', 'aws-sigv4', 'upload-file', 'limit-rate', 'unix-socket', 'abstract-unix-socket', 'request-target', 'trace', 'trace-ascii', 'stderr', 'expect100-timeout',
  'keepalive-time', 'local-port', 'max-filesize', 'noproxy', 'preproxy', 'proxy-header', 'socks5', 'socks5-hostname', 'speed-limit', 'speed-time', 'tls-max',
  'ciphers', 'pinnedpubkey', 'hostpubmd5', 'krb', 'netrc-file', 'output-dir', 'variable', 'happy-eyeballs-timeout-ms',
]);

/** Flags that do not influence the request definition (output, verbosity, transport tuning). */
const IGNORED = new Set([
  's', 'S', 'v', 'i', 'f', 'N', 'O', '#', 'q', 'o', 'w', 'D', 'c', 'silent', 'show-error', 'verbose', 'include', 'fail', 'fail-with-body', 'no-buffer', 'output', 'remote-name',
  'write-out', 'dump-header', 'cookie-jar', 'progress-bar', 'no-progress-meter', 'http1.1', 'http1.0', 'http2', 'http2-prior-knowledge', 'http3', 'globoff', 'g', 'ipv4',
  'ipv6', '4', '6', 'no-keepalive', 'tr-encoding', 'path-as-is', 'stderr', 'retry', 'retry-delay', 'retry-max-time', 'create-dirs', 'remote-header-name', 'J', 'output-dir',
  'trace', 'trace-ascii', 'keepalive-time', 'tcp-nodelay', 'no-sessionid', 'no-alpn', 'no-npn', 'tlsv1', 'tlsv1.0', 'tlsv1.1', 'tlsv1.2', 'tlsv1.3', 'tls-max', 'ssl-reqd',
  'location-trusted', 'raw', 'compressed-ssh', 'parallel', 'Z', 'styled-output', 'no-styled-output', 'show-headers',
]);

interface DataPart {
  kind: 'data' | 'raw' | 'binary' | 'urlencode' | 'json';
  value: string;
}

function urlencodeArg(arg: string, w: Warnings): { name?: string; value: string; file?: string } {
  const eq = arg.indexOf('=');
  const at = arg.indexOf('@');
  if (at >= 0 && (eq < 0 || at < eq)) {
    w.add('unsupported-feature', `--data-urlencode with a file (${arg}) is not supported; the field was left empty.`, undefined, '--data-urlencode');
    return { name: arg.slice(0, at) || undefined, value: '', file: arg.slice(at + 1) };
  }
  if (eq < 0) return { value: arg };
  if (eq === 0) return { value: arg.slice(1) };
  return { name: arg.slice(0, eq), value: arg.slice(eq + 1) };
}

function requestName(method: string, url: string): string {
  try {
    const u = new URL(url.replace(/\{\{[^}]*\}\}/g, 'x'));
    return `${method} ${u.pathname === '/' ? u.host : u.pathname}`;
  } catch {
    return `${method} ${url}`.slice(0, 120);
  }
}

export interface CurlParseResult {
  request: HttpRequest;
  warnings: ImportWarning[];
}

/** Parse a single cURL command into a REQVYN request. */
export function parseCurl(command: string): CurlParseResult {
  const w = new Warnings('curl');
  const tokens = tokenizeShell(command).filter((t) => t !== NEWLINE);
  const results = parseCurlTokens(tokens, w);
  return { request: results, warnings: w.list };
}

function parseCurlTokens(tokensIn: string[], w: Warnings): HttpRequest {
  const tokens = [...tokensIn];
  if (tokens[0] && /^curl(\.exe)?$/i.test(tokens[0].split(/[\\/]/).pop() ?? '')) tokens.shift();
  else throw importError('Not a cURL command (it must start with "curl").');

  let method: string | undefined;
  let url: string | undefined;
  const headers: KeyValue[] = [];
  const cookies: KeyValue[] = [];
  const queryExtra: KeyValue[] = [];
  const data: DataPart[] = [];
  const form: MultipartPart[] = [];
  const settings: RequestSettings = {};
  let user: string | undefined;
  let authKind: 'basic' | 'digest' = 'basic';
  let bearer: string | undefined;
  let get = false;
  let head = false;
  let cert: { cert?: string; key?: string } | undefined;
  let uploadFile: string | undefined;
  const ignored = new Set<string>();

  const handle = (flag: string, value: string | undefined): void => {
    switch (flag) {
      case 'X':
      case 'request':
        method = (value ?? '').toUpperCase();
        return;
      case 'H':
      case 'header': {
        const v = value ?? '';
        if (v.startsWith('@')) {
          w.add('unsupported-feature', `Headers from file (${v}) are not supported.`, undefined, '--header');
          return;
        }
        const idx = v.indexOf(':');
        if (idx < 0) {
          if (v.endsWith(';')) headers.push(kv(v.slice(0, -1).trim(), ''));
          else w.add('converted', `Header "${v}" without a value was ignored (curl removes such headers).`, undefined, '--header');
          return;
        }
        const name = v.slice(0, idx).trim();
        const hv = v.slice(idx + 1).trim();
        if (name.toLowerCase() === 'cookie') {
          for (const c of hv.split(';')) {
            const e = c.indexOf('=');
            if (c.trim()) cookies.push(kv((e < 0 ? c : c.slice(0, e)).trim(), e < 0 ? '' : c.slice(e + 1).trim()));
          }
          return;
        }
        headers.push(kv(name, hv));
        return;
      }
      case 'd':
      case 'data':
      case 'data-ascii':
        data.push({ kind: 'data', value: value ?? '' });
        return;
      case 'data-raw':
        data.push({ kind: 'raw', value: value ?? '' });
        return;
      case 'data-binary':
        data.push({ kind: 'binary', value: value ?? '' });
        return;
      case 'data-urlencode':
        data.push({ kind: 'urlencode', value: value ?? '' });
        return;
      case 'json':
        data.push({ kind: 'json', value: value ?? '' });
        return;
      case 'F':
      case 'form':
      case 'form-string': {
        const v = value ?? '';
        const eq = v.indexOf('=');
        const key = eq < 0 ? v : v.slice(0, eq);
        const rest = eq < 0 ? '' : v.slice(eq + 1);
        if (flag !== 'form-string' && (rest.startsWith('@') || rest.startsWith('<'))) {
          const segs = rest.slice(1).split(';');
          const filePath = segs[0] ?? '';
          const type = segs.find((s) => s.startsWith('type='))?.slice(5);
          if (rest.startsWith('<')) w.add('converted', `Form field "${key}" read its value from "${filePath}"; it was imported as a file part.`, undefined, '--form');
          form.push({ id: newId(), key, enabled: true, type: 'file', value: '', filePath, ...(type ? { contentType: type } : {}) });
        } else {
          let val = rest;
          let contentType: string | undefined;
          if (flag !== 'form-string') {
            const m = /^(.*?);type=([^;]+)$/.exec(rest);
            if (m) {
              val = m[1] ?? '';
              contentType = m[2];
            }
            if (/^".*"$/.test(val)) val = val.slice(1, -1);
          }
          form.push({ id: newId(), key, enabled: true, type: 'text', value: val, ...(contentType ? { contentType } : {}) });
        }
        return;
      }
      case 'u':
      case 'user':
        user = value ?? '';
        return;
      case 'digest':
        authKind = 'digest';
        return;
      case 'basic':
        authKind = 'basic';
        return;
      case 'ntlm':
      case 'negotiate':
      case 'anyauth':
        w.add('unsupported-feature', `--${flag} authentication is not supported; basic auth used for the credentials.`, undefined, `--${flag}`);
        return;
      case 'oauth2-bearer':
        bearer = value ?? '';
        return;
      case 'b':
      case 'cookie': {
        const v = value ?? '';
        if (!v.includes('=')) {
          w.add('unsupported-feature', `Cookies read from file "${v}" are not supported.`, undefined, '--cookie');
          return;
        }
        for (const c of v.split(';')) {
          const e = c.indexOf('=');
          if (c.trim()) cookies.push(kv((e < 0 ? c : c.slice(0, e)).trim(), e < 0 ? '' : c.slice(e + 1).trim()));
        }
        return;
      }
      case 'A':
      case 'user-agent':
        headers.push(kv('User-Agent', value ?? ''));
        return;
      case 'e':
      case 'referer':
        headers.push(kv('Referer', (value ?? '').replace(/;auto$/, '')));
        return;
      case 'url':
        if (url === undefined) url = value ?? '';
        else w.add('unsupported-feature', `Additional URL "${value ?? ''}" ignored; only the first URL is imported.`, undefined, '--url');
        return;
      case 'url-query':
        queryExtra.push(...parseQueryString(value ?? ''));
        return;
      case 'G':
      case 'get':
        get = true;
        return;
      case 'I':
      case 'head':
        head = true;
        return;
      case 'k':
      case 'insecure':
        settings.verifyTls = false;
        w.add('insecure', 'The command disables TLS certificate verification (-k/--insecure); the imported request has "Verify TLS" turned off. Re-enable it unless you trust the server.', undefined, '--insecure');
        return;
      case 'L':
      case 'location':
        settings.followRedirects = true;
        return;
      case 'max-redirs': {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0) settings.maxRedirects = n;
        return;
      }
      case 'compressed':
        settings.decompress = true;
        return;
      case 'm':
      case 'max-time': {
        const n = Number(value);
        if (n > 0) settings.timeoutMs = Math.round(n * 1000);
        return;
      }
      case 'E':
      case 'cert':
        cert = { ...cert, cert: (value ?? '').split(':')[0] };
        if ((value ?? '').includes(':') && !/^[A-Za-z]:[\\/]/.test(value ?? ''))
          w.add('secret', 'The certificate passphrase given on the command line was not imported.', undefined, '--cert');
        return;
      case 'key':
        cert = { ...cert, key: value ?? '' };
        return;
      case 'T':
      case 'upload-file':
        uploadFile = value ?? '';
        return;
      case 'x':
      case 'proxy':
      case 'U':
      case 'proxy-user':
        w.add('unsupported-field', 'Proxy settings are configured globally in REQVYN and were not imported.', undefined, '--proxy');
        return;
      case 'cacert':
      case 'capath':
        w.add('unsupported-field', 'Custom CA settings are configured globally in REQVYN and were not imported.', undefined, `--${flag}`);
        return;
      case 'aws-sigv4':
        w.add('converted', 'AWS SigV4 signing: configure the AWS Signature v4 auth on the request.', undefined, '--aws-sigv4');
        return;
      case 'connect-timeout':
        w.add('unsupported-field', '--connect-timeout is not supported per request.', undefined, '--connect-timeout');
        return;
      default:
        if (IGNORED.has(flag)) ignored.add(flag.length === 1 ? `-${flag}` : `--${flag}`);
        else w.add('unsupported-field', `Unknown or unsupported cURL option "${flag.length === 1 ? '-' : '--'}${flag}" was ignored.`, undefined, flag);
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t.startsWith('--') && t.length > 2) {
      let name = t.slice(2);
      let value: string | undefined;
      const eq = name.indexOf('=');
      if (eq > 0 && LONG_WITH_VALUE.has(name.slice(0, eq))) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      } else if (LONG_WITH_VALUE.has(name)) value = tokens[++i];
      handle(name, value);
    } else if (t.startsWith('-') && t.length > 1) {
      const flags = t.slice(1);
      for (let j = 0; j < flags.length; j++) {
        const f = flags[j] as string;
        if (SHORT_WITH_VALUE.has(f)) {
          const attached = flags.slice(j + 1);
          handle(f, attached.length ? attached : tokens[++i]);
          break;
        }
        handle(f, undefined);
        if (!SHORT_BOOL.has(f)) break;
      }
    } else if (url === undefined) url = t;
    else w.add('unsupported-feature', `Additional argument "${t}" ignored; only the first URL is imported.`);
  }
  if (ignored.size) w.add('info', `Output/transport options without effect on the request were ignored: ${[...ignored].join(' ')}.`);
  if (!url) throw importError('The cURL command contains no URL.');

  let rawUrl = url;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) && !rawUrl.startsWith('{{')) rawUrl = `http://${rawUrl}`;
  // Credentials embedded in the URL (user:pass@host).
  const cred = /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i.exec(rawUrl);
  if (cred && !user) {
    user = decodeURIComponent(cred[2] ?? '');
    rawUrl = `${cred[1]}${rawUrl.slice(cred[0].length)}`;
    w.add('secret', 'Credentials embedded in the URL were moved to Basic auth.', undefined, 'url');
  }
  const { base, params } = splitUrl(rawUrl);
  params.push(...queryExtra);

  const ctHeader = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
  const ct = ctHeader.toLowerCase();
  let body: RequestBody = { mode: 'none' };
  if (form.length) {
    body = { mode: 'multipart', parts: form };
    if (data.length) w.add('converted', 'Both --data and --form were given; only the form fields were imported.', undefined, '--data');
  } else if (uploadFile) {
    body = { mode: 'binary', filePath: uploadFile, ...(ctHeader ? { contentType: ctHeader } : {}) };
  } else if (data.length) {
    const fileRef = data.length === 1 && data[0] && data[0].kind !== 'raw' && data[0].kind !== 'urlencode' && data[0].value.startsWith('@') ? data[0].value.slice(1) : undefined;
    const encodedPieces = data.map((p) => {
      if (p.kind !== 'urlencode') return p.value;
      const u = urlencodeArg(p.value, w);
      return u.name ? `${u.name}=${encodeURIComponent(u.value)}` : encodeURIComponent(u.value);
    });
    const isJsonFlag = data.some((p) => p.kind === 'json');
    const joined = isJsonFlag ? encodedPieces.join('') : encodedPieces.join('&');
    if (isJsonFlag && !headers.some((h) => h.key.toLowerCase() === 'accept')) headers.push(kv('Accept', 'application/json'));
    if (get) params.push(...parseQueryString(joined));
    else if (fileRef !== undefined) {
      body = { mode: 'binary', filePath: fileRef, ...(ctHeader ? { contentType: ctHeader } : {}) };
      if (data[0]?.kind === 'data') w.add('converted', `Body is read from file "${fileRef}" (curl -d strips newlines from files; REQVYN sends the file as-is).`, undefined, '--data');
    } else if (isJsonFlag || ct.includes('json')) body = { mode: 'json', text: joined };
    else if (ct.includes('xml')) body = { mode: 'xml', text: joined };
    else {
      const trimmed = joined.trim();
      const looksJson = (trimmed.startsWith('{') || trimmed.startsWith('[')) && parseJsonSafe(trimmed) !== undefined;
      const formLike = !looksJson && /^[^=&\s]+(=[^&]*)?(&[^=&\s]+(=[^&]*)?)*$/.test(joined);
      if ((!ct || ct.includes('x-www-form-urlencoded')) && formLike) body = { mode: 'urlencoded', fields: parseQueryString(joined) };
      else if (!ct && looksJson) {
        body = { mode: 'json', text: joined };
        w.add('converted', 'The body looks like JSON but no Content-Type was given (curl would send application/x-www-form-urlencoded); it was imported as JSON.', undefined, '--data');
      } else body = { mode: 'text', text: joined, contentType: ctHeader || 'application/x-www-form-urlencoded' };
    }
  }

  let auth: Auth = { type: 'inherit' };
  if (bearer !== undefined) auth = { type: 'bearer', token: bearer, prefix: 'Bearer' };
  else if (user !== undefined) {
    const idx = user.indexOf(':');
    const username = idx < 0 ? user : user.slice(0, idx);
    const password = idx < 0 ? '' : user.slice(idx + 1);
    if (idx < 0) w.add('info', 'No password was given with -u; curl would prompt for it. Enter it in the auth settings.', undefined, '--user');
    auth = { type: authKind, username, password };
  } else if (cert) auth = { type: 'clientcert', certPath: cert.cert ?? '', keyPath: cert.key ?? '', pfxPath: '', passphrase: '' };
  if (cert && auth.type !== 'clientcert') w.add('unsupported-field', 'Client certificate options were not imported because another auth method is used.', undefined, '--cert');

  const finalMethod = method || (head ? 'HEAD' : uploadFile ? 'PUT' : !get && (data.length || form.length) ? 'POST' : 'GET');
  const req = createRequest({
    name: requestName(finalMethod, base),
    method: finalMethod,
    url: base,
    params,
    headers,
    cookies,
    body,
    auth,
    settings,
  });
  return parseRequest(req);
}

/** Split text containing several cURL commands (each starting on a new line with "curl"). */
export function splitCurlCommands(text: string): string[] {
  const tokens = tokenizeShell(text);
  const commands: string[][] = [];
  let atLineStart = true;
  for (const t of tokens) {
    if (t === NEWLINE) {
      atLineStart = true;
      continue;
    }
    if (atLineStart && /^curl(\.exe)?$/i.test(t)) commands.push([t]);
    else if (commands.length) commands[commands.length - 1]?.push(t);
    atLineStart = false;
  }
  return commands.map((c) => c.map((t) => `'${t.replace(/'/g, `'\\''`)}'`).join(' '));
}

export function looksLikeCurl(text: string): boolean {
  return /^\s*curl(\.exe)?\s/i.test(text);
}

export function importCurl(text: string, fileName?: string): ImportResult {
  const w = new Warnings('curl');
  const commands = splitCurlCommands(text);
  if (!commands.length) throw importError('No cURL command found.');
  const b = new CollectionBuilder({
    name: fileName ? fileName.replace(/\.[^.]+$/, '') : 'cURL Import',
    meta: { source: { type: 'curl', ...(fileName ? { location: fileName } : {}), importedAt: nowIso() } },
  });
  for (const cmd of commands) {
    const { request, warnings } = parseCurl(cmd);
    w.list.push(...warnings.map((x) => ({ ...x, location: x.location ?? request.name })));
    const { sortKey: _sortKey, ...rest } = request;
    b.addRequest({ ...rest, parentId: null });
  }
  return { collections: [b.build()], environments: [], warnings: w.list };
}
