import { AuthSchema, JWT_ALGORITHMS, SENSITIVE_AUTH_FIELDS, type Auth, type AuthType, type OAuth2Config } from '@reqvyn/core';
import type { ReactNode } from 'react';
import { VarInput } from './VarInput';
import { Button, Checkbox, Icon, Notice, SecretInput, Select } from './ui';
import { CodeEditor } from './CodeEditor';
import { KeyValueTable } from './KeyValueTable';
import { pickFile } from '../host';

export interface OAuthStatus {
  status: 'idle' | 'running' | 'success' | 'error';
  message?: string;
  expiresAt?: string;
  userCode?: string;
  verificationUri?: string;
}

const TYPE_LABELS: Record<AuthType, string> = {
  inherit: 'Inherit from parent',
  none: 'No auth',
  basic: 'Basic',
  bearer: 'Bearer token',
  apikey: 'API key',
  oauth2: 'OAuth 2.0',
  jwt: 'JWT',
  awsv4: 'AWS Signature v4',
  digest: 'Digest',
  clientcert: 'Client certificate',
};

export function defaultAuth(type: AuthType): Auth {
  return AuthSchema.parse({ type });
}

export function AuthEditor({
  auth,
  onChange,
  allowInherit,
  inherited,
  onStoreSecret,
  oauth,
}: {
  auth: Auth;
  onChange: (auth: Auth) => void;
  allowInherit: boolean;
  inherited?: { type: string; source: string };
  /** Move a literal sensitive value into secret storage (`secret:store`). */
  onStoreSecret?: (field: string, value: string) => void;
  oauth?: { status: OAuthStatus; onGetToken: () => void; onClearToken: () => void };
}) {
  const types = (Object.keys(TYPE_LABELS) as AuthType[]).filter((t) => allowInherit || t !== 'inherit');
  const set = (patch: Record<string, unknown>) => onChange({ ...auth, ...patch } as Auth);
  const sensitive = SENSITIVE_AUTH_FIELDS[auth.type] ?? [];

  const text = (field: string, label: string, placeholder?: string): ReactNode => {
    const value = String((auth as Record<string, unknown>)[field] ?? '');
    return (
      <Row label={label} key={field}>
        {sensitive.includes(field) ? (
          <SecretInput
            value={value}
            ariaLabel={label}
            placeholder={placeholder}
            onChange={(v) => set({ [field]: v })}
            onStoreSecret={onStoreSecret ? (v) => onStoreSecret(`auth.${field}`, v) : undefined}
          />
        ) : (
          <VarInput value={value} ariaLabel={label} placeholder={placeholder} onChange={(v) => set({ [field]: v })} />
        )}
      </Row>
    );
  };

  const file = (field: 'certPath' | 'keyPath' | 'pfxPath', label: string, purpose: 'cert' | 'key' | 'pfx') => {
    const value = (auth as Record<string, unknown>)[field] as string;
    return (
      <Row label={label} key={field}>
        <div className="rv-hstack">
          <VarInput value={value} ariaLabel={label} placeholder="Path to file" onChange={(v) => set({ [field]: v })} />
          <Button
            icon="folder-opened"
            onClick={() =>
              void pickFile(purpose).then((p) => {
                if (p) set({ [field]: p });
              })
            }
          >
            Browse…
          </Button>
        </div>
      </Row>
    );
  };

  return (
    <div className="rv-auth">
      <Row label="Type">
        <Select<AuthType> value={auth.type} ariaLabel="Authentication type" options={types.map((t) => ({ value: t, label: TYPE_LABELS[t] }))} onChange={(t) => onChange(defaultAuth(t))} />
      </Row>
      {auth.type === 'inherit' && (
        <Notice kind="info" icon="type-hierarchy-super">
          {inherited ? (
            <>
              Using <strong>{TYPE_LABELS[inherited.type as AuthType] ?? inherited.type}</strong> from <strong>{inherited.source}</strong>.
            </>
          ) : (
            'Authentication is inherited from the parent folder or collection.'
          )}
        </Notice>
      )}
      {auth.type === 'none' && <div className="rv-muted rv-pad">This request does not use authentication.</div>}
      {auth.type === 'basic' && [text('username', 'Username'), text('password', 'Password')]}
      {auth.type === 'digest' && [text('username', 'Username'), text('password', 'Password')]}
      {auth.type === 'bearer' && [text('token', 'Token', '{{accessToken}}'), text('prefix', 'Prefix', 'Bearer')]}
      {auth.type === 'apikey' && (
        <>
          {text('key', 'Key', 'X-API-Key')}
          {text('value', 'Value')}
          <Row label="Add to">
            <Select value={auth.in} ariaLabel="Add API key to" options={[{ value: 'header', label: 'Header' }, { value: 'query', label: 'Query params' }]} onChange={(v) => set({ in: v })} />
          </Row>
        </>
      )}
      {auth.type === 'awsv4' && [
        text('accessKeyId', 'Access key ID'),
        text('secretAccessKey', 'Secret access key'),
        text('sessionToken', 'Session token (optional)'),
        text('region', 'Region', 'us-east-1'),
        text('service', 'Service', 'execute-api'),
      ]}
      {auth.type === 'clientcert' && (
        <>
          {file('certPath', 'Certificate (PEM)', 'cert')}
          {file('keyPath', 'Private key (PEM)', 'key')}
          {file('pfxPath', 'PFX / PKCS#12', 'pfx')}
          {text('passphrase', 'Passphrase')}
        </>
      )}
      {auth.type === 'jwt' && (
        <>
          <Row label="Algorithm">
            <Select value={auth.algorithm} ariaLabel="JWT algorithm" options={JWT_ALGORITHMS.map((a) => ({ value: a, label: a }))} onChange={(v) => set({ algorithm: v })} />
          </Row>
          {text('secret', auth.algorithm.startsWith('HS') ? 'Secret' : 'Private key (PEM)')}
          <Row label="">
            <Checkbox checked={auth.secretBase64} onChange={(v) => set({ secretBase64: v })} label="Secret is Base64 encoded" />
          </Row>
          <Row label="Payload">
            <div className="rv-code-box rv-code-box--small">
              <CodeEditor value={auth.payload} language="json" variables ariaLabel="JWT payload" onChange={(v) => set({ payload: v })} />
            </div>
          </Row>
          <Row label="Header">
            <div className="rv-code-box rv-code-box--small">
              <CodeEditor value={auth.header} language="json" variables ariaLabel="JWT extra header" onChange={(v) => set({ header: v })} />
            </div>
          </Row>
          <Row label="Expires in (s)">
            <input
              className="rv-input rv-input--narrow"
              type="number"
              min={0}
              aria-label="Expires in seconds"
              value={auth.expiresInSeconds ?? ''}
              onChange={(e) => set({ expiresInSeconds: e.target.value === '' ? undefined : Math.max(0, Math.floor(Number(e.target.value))) })}
            />
          </Row>
          <Row label="Add to">
            <Select value={auth.addTo} ariaLabel="Add JWT to" options={[{ value: 'header', label: 'Authorization header' }, { value: 'query', label: 'Query param' }]} onChange={(v) => set({ addTo: v })} />
          </Row>
          {auth.addTo === 'header' ? text('headerPrefix', 'Header prefix', 'Bearer') : text('queryParam', 'Query param name', 'token')}
        </>
      )}
      {auth.type === 'oauth2' && <OAuth2Fields auth={auth} set={set} text={text} oauth={oauth} />}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rv-form-row">
      <div className="rv-form-row__label">{label}</div>
      <div className="rv-form-row__control">{children}</div>
    </div>
  );
}

function OAuth2Fields({
  auth,
  set,
  text,
  oauth,
}: {
  auth: OAuth2Config;
  set: (patch: Record<string, unknown>) => void;
  text: (field: string, label: string, placeholder?: string) => ReactNode;
  oauth?: { status: OAuthStatus; onGetToken: () => void; onClearToken: () => void };
}) {
  const g = auth.grantType;
  const st = oauth?.status;
  return (
    <>
      <Row label="Grant type">
        <Select
          value={g}
          ariaLabel="OAuth 2.0 grant type"
          options={[
            { value: 'authorization_code', label: 'Authorization code' },
            { value: 'client_credentials', label: 'Client credentials' },
            { value: 'device_code', label: 'Device code' },
            { value: 'password', label: 'Password (legacy)' },
          ]}
          onChange={(v) => set({ grantType: v })}
        />
      </Row>
      {g === 'authorization_code' && text('authUrl', 'Auth URL', 'https://auth.example.com/authorize')}
      {g === 'device_code' && text('deviceAuthUrl', 'Device auth URL', 'https://auth.example.com/device/code')}
      {text('tokenUrl', 'Token URL', 'https://auth.example.com/token')}
      {text('clientId', 'Client ID')}
      {text('clientSecret', 'Client secret')}
      {g === 'password' && [text('username', 'Username'), text('password', 'Password')]}
      {text('scope', 'Scope', 'openid profile')}
      {text('audience', 'Audience (optional)')}
      {g === 'authorization_code' && (
        <>
          {text('redirectUri', 'Redirect URI')}
          <Row label="">
            <Checkbox checked={auth.usePkce} onChange={(v) => set({ usePkce: v })} label="Use PKCE (S256)" />
          </Row>
        </>
      )}
      <Row label="Client auth">
        <Select
          value={auth.clientAuthentication}
          ariaLabel="Client authentication"
          options={[
            { value: 'body', label: 'Send credentials in body' },
            { value: 'basic', label: 'Send as Basic auth header' },
          ]}
          onChange={(v) => set({ clientAuthentication: v })}
        />
      </Row>
      {text('tokenPrefix', 'Token prefix', 'Bearer')}
      <Row label="">
        <Checkbox checked={auth.autoRefresh} onChange={(v) => set({ autoRefresh: v })} label="Refresh token automatically" />
      </Row>
      <Row label="Extra params">
        <KeyValueTable rows={auth.extraParams} onChange={(rows) => set({ extraParams: rows })} ariaLabel="Extra token request parameters" />
      </Row>
      {oauth && (
        <Row label="Token">
          <div className="rv-oauth">
            <div className="rv-hstack">
              <Button primary icon="key" onClick={oauth.onGetToken} disabled={st?.status === 'running'}>
                {st?.status === 'running' ? 'Waiting…' : 'Get new token'}
              </Button>
              <Button icon="trash" onClick={oauth.onClearToken}>
                Clear token
              </Button>
              {st && st.status !== 'idle' && (
                <span className={`rv-oauth__status rv-oauth__status--${st.status}`} role="status">
                  <Icon name={st.status === 'running' ? 'loading~spin' : st.status === 'success' ? 'pass' : 'error'} />
                  {st.message ?? st.status}
                  {st.expiresAt && st.status === 'success' && <span className="rv-muted"> · expires {new Date(st.expiresAt).toLocaleString()}</span>}
                </span>
              )}
            </div>
            {st?.userCode && (
              <div className="rv-oauth__device">
                Enter code <code className="rv-oauth__code">{st.userCode}</code>
                {st.verificationUri && (
                  <>
                    {' '}
                    at <code>{st.verificationUri}</code>
                  </>
                )}
              </div>
            )}
          </div>
        </Row>
      )}
    </>
  );
}
