import type { RequestSettings, RunnerSettings } from '@reqvyn/core';
import { Checkbox, Notice, Select } from './ui';

type Tri = 'default' | 'on' | 'off';
const tri = (v: boolean | undefined): Tri => (v === undefined ? 'default' : v ? 'on' : 'off');
const fromTri = (t: Tri): boolean | undefined => (t === 'default' ? undefined : t === 'on');

function TriSelect({ label, value, onChange, defaultLabel }: { label: string; value: boolean | undefined; onChange: (v: boolean | undefined) => void; defaultLabel: string }) {
  return (
    <div className="rv-form-row">
      <div className="rv-form-row__label">{label}</div>
      <div className="rv-form-row__control">
        <Select<Tri>
          value={tri(value)}
          ariaLabel={label}
          options={[
            { value: 'default', label: `Inherit (${defaultLabel})` },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
          onChange={(t) => onChange(fromTri(t))}
        />
      </div>
    </div>
  );
}

function NumberRow({ label, value, onChange, placeholder, min = 0, suffix }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; placeholder: string; min?: number; suffix?: string }) {
  return (
    <div className="rv-form-row">
      <div className="rv-form-row__label">{label}</div>
      <div className="rv-form-row__control rv-hstack">
        <input
          className="rv-input rv-input--narrow"
          type="number"
          min={min}
          aria-label={label}
          placeholder={placeholder}
          value={value ?? ''}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return onChange(undefined);
            const n = Math.floor(Number(raw));
            if (Number.isFinite(n) && n >= min) onChange(n);
          }}
        />
        {suffix && <span className="rv-muted">{suffix}</span>}
      </div>
    </div>
  );
}

/** Per request / folder / collection HTTP settings. Undefined values inherit from the parent level. */
export function RequestSettingsEditor({ settings, onChange }: { settings: RequestSettings; onChange: (s: RequestSettings) => void }) {
  const set = <K extends keyof RequestSettings>(k: K, v: RequestSettings[K]) => {
    const next = { ...settings };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  return (
    <div className="rv-settings">
      <NumberRow label="Timeout" value={settings.timeoutMs} onChange={(v) => set('timeoutMs', v === 0 ? undefined : v)} placeholder="default" min={1} suffix="ms" />
      <TriSelect label="Follow redirects" value={settings.followRedirects} onChange={(v) => set('followRedirects', v)} defaultLabel="on" />
      <NumberRow label="Max redirects" value={settings.maxRedirects} onChange={(v) => set('maxRedirects', v)} placeholder="10" />
      <TriSelect label="Verify TLS certificates" value={settings.verifyTls} onChange={(v) => set('verifyTls', v)} defaultLabel="on" />
      {settings.verifyTls === false && (
        <Notice kind="warning" icon="shield">
          TLS certificate verification is <strong>disabled</strong> for this item. Connections are vulnerable to interception — use only for local development with self-signed certificates.
        </Notice>
      )}
      <TriSelect label="Decompress response" value={settings.decompress} onChange={(v) => set('decompress', v)} defaultLabel="on" />
      <TriSelect label="Use cookie jar" value={settings.useCookieJar} onChange={(v) => set('useCookieJar', v)} defaultLabel="on" />
      <TriSelect label="Encode URL" value={settings.encodeUrl} onChange={(v) => set('encodeUrl', v)} defaultLabel="on" />
      <NumberRow label="Max response size" value={settings.maxResponseBytes} onChange={(v) => set('maxResponseBytes', v === 0 ? undefined : v)} placeholder="default" min={1} suffix="bytes kept in memory" />
    </div>
  );
}

export function RunnerSettingsEditor({ settings, onChange }: { settings: RunnerSettings; onChange: (s: RunnerSettings) => void }) {
  return (
    <div className="rv-settings">
      <NumberRow label="Iterations" value={settings.iterations} min={1} placeholder="1" onChange={(v) => onChange({ ...settings, iterations: v ?? 1 })} />
      <NumberRow label="Delay" value={settings.delayMs} placeholder="0" suffix="ms between requests" onChange={(v) => onChange({ ...settings, delayMs: v ?? 0 })} />
      <NumberRow label="Concurrency" value={settings.concurrency} min={1} placeholder="1" suffix="1 = sequential" onChange={(v) => onChange({ ...settings, concurrency: v ?? 1 })} />
      <div className="rv-form-row">
        <div className="rv-form-row__label" />
        <div className="rv-form-row__control">
          <Checkbox checked={settings.stopOnFailure} onChange={(v) => onChange({ ...settings, stopOnFailure: v })} label="Stop on first failure" />
        </div>
      </div>
    </div>
  );
}
