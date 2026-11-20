import { ReqvynError, isReqvynError } from '@reqvyn/shared';

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA']);
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
  'EADDRNOTAVAIL',
  'UND_ERR_SOCKET',
]);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'CERT_REVOKED',
  'ERR_OSSL_PEM_NO_START_LINE',
  'ERR_OSSL_EVP_BAD_DECRYPT',
]);

/** Translate low-level Node network errors into structured, actionable REQVYN errors. */
export function mapNetworkError(err: unknown, ctx: { url: string; viaProxy?: string }): ReqvynError {
  if (isReqvynError(err)) return err;
  const e = err as NodeJS.ErrnoException & { reason?: string; hostname?: string };
  const code = e?.code ?? '';
  const host = safeHost(ctx.url);
  const message = e?.message ?? String(err);
  if (DNS_CODES.has(code)) {
    return new ReqvynError('DNS', `Could not resolve host "${e.hostname ?? host}" (${code}).`, {
      cause: err,
      details: { code },
      hint: ctx.viaProxy ? 'Check the proxy host name.' : 'Check the host name, your network connection or DNS settings.',
    });
  }
  if (TLS_CODES.has(code) || /certificate|ssl|tls/i.test(message)) {
    const selfSigned = /SELF_SIGNED|UNABLE_TO_(VERIFY|GET)/.test(code);
    return new ReqvynError('TLS', `TLS error: ${message}${code ? ` (${code})` : ''}`, {
      cause: err,
      details: { code },
      hint: selfSigned
        ? 'The server certificate is not trusted. Add the issuing CA certificate in REQVYN settings (reqvyn.tls.caCertificates) or explicitly disable TLS verification for this request.'
        : 'Check the server certificate, client certificate configuration and TLS version.',
    });
  }
  if (ctx.viaProxy && (CONNECTION_CODES.has(code) || /proxy/i.test(message))) {
    return new ReqvynError('PROXY', `Proxy error via ${ctx.viaProxy}: ${message}`, {
      cause: err,
      details: { code },
      hint: 'Check the proxy URL, credentials and the no-proxy list.',
    });
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return new ReqvynError('TIMEOUT', `Connection to ${host} timed out.`, { cause: err, details: { code } });
  }
  if (CONNECTION_CODES.has(code)) {
    const hint =
      code === 'ECONNREFUSED'
        ? 'Nothing is listening on that host/port. Is the server running?'
        : code === 'ECONNRESET'
          ? 'The server closed the connection unexpectedly.'
          : 'Check your network connection and firewall.';
    return new ReqvynError('CONNECTION', `Connection failed to ${host}: ${message}`, { cause: err, details: { code }, hint });
  }
  if (code.startsWith('HPE_') || /parse error/i.test(message)) {
    return new ReqvynError('INVALID_RESPONSE', `The server sent an invalid HTTP response: ${message}`, {
      cause: err,
      details: { code },
      hint: 'The server may not speak HTTP/1.1 on this port (e.g. HTTPS port called with http://).',
    });
  }
  if (code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR' || code === 'ERR__ERROR_FORMAT_PADDING_1') {
    return new ReqvynError('INVALID_RESPONSE', `Failed to decompress the response body: ${message}`, { cause: err, details: { code } });
  }
  return new ReqvynError('CONNECTION', message || 'Request failed', { cause: err, details: { code } });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
