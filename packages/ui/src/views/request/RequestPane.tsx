import { emptyGroup, type HttpRequest } from '@reqvyn/core';
import { AssertionBuilder } from '../../components/AssertionBuilder';
import { AuthEditor } from '../../components/AuthEditor';
import { ExtractionBuilder } from '../../components/ExtractionBuilder';
import { InheritedTable, KeyValueTable } from '../../components/KeyValueTable';
import { ScriptEditor } from '../../components/ScriptEditor';
import { RequestSettingsEditor } from '../../components/SettingsEditor';
import { TabPanel, Tabs, type TabDef } from '../../components/Tabs';
import { Section } from '../../components/ui';
import { countAssertions } from '../../lib/assertions';
import { COMMON_HEADERS } from '../../lib/headers';
import { BodyEditor } from './BodyEditor';
import { clearOAuthToken, editRequest, getOAuthToken, setParams, setRequestTab, storeSecret, useRequestStore, type RequestTab } from './store';

const P = 'req';

function count(n: number): number | undefined {
  return n > 0 ? n : undefined;
}

export function RequestPane({ request }: { request: HttpRequest }) {
  const tab = useRequestStore((s) => s.requestTab);
  const context = useRequestStore((s) => s.context);
  const oauth = useRequestStore((s) => s.oauth);
  const trusted = useRequestStore((s) => s.trusted);

  const enabled = (rows: { enabled: boolean; key: string }[]) => rows.filter((r) => r.enabled && r.key).length;
  const tabs: Array<TabDef<RequestTab>> = [
    { id: 'params', label: 'Params', badge: count(enabled(request.params)) },
    { id: 'headers', label: 'Headers', badge: count(enabled(request.headers)) },
    { id: 'body', label: 'Body', badge: request.body.mode !== 'none' ? '●' : undefined },
    { id: 'auth', label: 'Auth', badge: request.auth.type !== 'none' && request.auth.type !== 'inherit' ? '●' : undefined },
    { id: 'cookies', label: 'Cookies', badge: count(enabled(request.cookies)) },
    { id: 'pre', label: 'Pre-request', badge: request.scripts.pre.trim() ? '●' : undefined },
    { id: 'tests', label: 'Tests', badge: count(countAssertions(request.tests) + request.extractions.filter((e) => e.enabled).length) ?? (request.scripts.post.trim() ? '●' : undefined) },
    { id: 'settings', label: 'Settings', badge: request.settings.verifyTls === false ? '!' : undefined },
    { id: 'docs', label: 'Docs' },
  ];

  const edit = (patch: Partial<HttpRequest>) => editRequest((r) => ({ ...r, ...patch }));

  return (
    <div className="rv-pane rv-reqpane">
      <Tabs tabs={tabs} active={tab} onChange={setRequestTab} ariaLabel="Request configuration" idPrefix={P} />
      <TabPanel idPrefix={P} id={tab} className="rv-scroll">
        {tab === 'params' && (
          <>
            <KeyValueTable rows={request.params} onChange={setParams} ariaLabel="Query parameters" keyPlaceholder="Parameter" bulk description />
            <p className="rv-hint">Query parameters stay in sync with the URL. Disabled parameters are kept but not sent.</p>
          </>
        )}
        {tab === 'headers' && (
          <>
            <KeyValueTable rows={request.headers} onChange={(headers) => edit({ headers })} ariaLabel="Request headers" keyPlaceholder="Header" keySuggestions={COMMON_HEADERS} bulk description />
            {context && context.inheritedHeaders.length > 0 && (
              <Section title={`Inherited headers (${context.inheritedHeaders.length})`} collapsible>
                <InheritedTable rows={context.inheritedHeaders} ariaLabel="Inherited headers" />
              </Section>
            )}
          </>
        )}
        {tab === 'body' && <BodyEditor body={request.body} onChange={(body) => edit({ body })} />}
        {tab === 'auth' && (
          <AuthEditor
            auth={request.auth}
            onChange={(auth) => edit({ auth })}
            allowInherit
            inherited={context?.inheritedAuth}
            onStoreSecret={storeSecret}
            oauth={{ status: oauth, onGetToken: getOAuthToken, onClearToken: clearOAuthToken }}
          />
        )}
        {tab === 'cookies' && (
          <>
            <KeyValueTable rows={request.cookies} onChange={(cookies) => edit({ cookies })} ariaLabel="Request cookies" keyPlaceholder="Cookie name" />
            <p className="rv-hint">Cookies listed here are sent in addition to matching cookies from the cookie jar (see Settings).</p>
          </>
        )}
        {tab === 'pre' && <ScriptEditor kind="pre" value={request.scripts.pre} trusted={trusted} onChange={(pre) => edit({ scripts: { ...request.scripts, pre } })} />}
        {tab === 'tests' && (
          <>
            <Section title="Assertions">
              <AssertionBuilder root={request.tests ?? emptyGroup()} onChange={(tests) => edit({ tests })} />
            </Section>
            <Section title="Extract variables (request chaining)">
              <ExtractionBuilder rows={request.extractions} onChange={(extractions) => edit({ extractions })} />
            </Section>
            <Section title="Post-response script" collapsible defaultOpen={!!request.scripts.post.trim()}>
              <ScriptEditor kind="post" value={request.scripts.post} trusted={trusted} onChange={(post) => edit({ scripts: { ...request.scripts, post } })} />
            </Section>
          </>
        )}
        {tab === 'settings' && <RequestSettingsEditor settings={request.settings} onChange={(settings) => edit({ settings })} />}
        {tab === 'docs' && (
          <textarea
            className="rv-textarea rv-docs"
            aria-label="Request documentation (Markdown)"
            placeholder="Describe this request in Markdown…"
            value={request.docs}
            onChange={(e) => edit({ docs: e.target.value })}
          />
        )}
      </TabPanel>
    </div>
  );
}
