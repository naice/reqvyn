import { emptyGroup, type RunnerSettings } from '@reqvyn/core';
import { useEffect } from 'react';
import { AssertionBuilder } from '../../components/AssertionBuilder';
import { AuthEditor } from '../../components/AuthEditor';
import { KeyValueTable } from '../../components/KeyValueTable';
import { ScriptEditor } from '../../components/ScriptEditor';
import { RequestSettingsEditor, RunnerSettingsEditor } from '../../components/SettingsEditor';
import { TabPanel, Tabs, type TabDef } from '../../components/Tabs';
import { Button, EmptyState, Icon, Notice, Section } from '../../components/ui';
import { countAssertions } from '../../lib/assertions';
import { COMMON_HEADERS } from '../../lib/headers';
import {
  clearContainerToken,
  editContainer,
  entityOf,
  getContainerToken,
  saveContainer,
  setContainerTab,
  storeContainerSecret,
  useContainerStore,
  type ContainerTab,
} from './store';

const P = 'ctr';

export function ContainerView() {
  const data = useContainerStore((s) => s.data);
  const dirty = useContainerStore((s) => s.dirty);
  const hostDirty = useContainerStore((s) => s.hostDirty);
  const tab = useContainerStore((s) => s.tab);
  const oauth = useContainerStore((s) => s.oauth);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveContainer();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!data) return <EmptyState icon="loading" title="Loading settings…" />;
  const entity = entityOf(data);
  const isCollection = data.level === 'collection';
  const n = (x: number) => (x > 0 ? x : undefined);

  const tabs: Array<TabDef<ContainerTab>> = [
    { id: 'overview', label: 'Overview' },
    { id: 'variables', label: 'Variables', badge: n(entity.variables.length) },
    { id: 'headers', label: 'Headers', badge: n(entity.headers.filter((h) => h.enabled && h.key).length) },
    { id: 'auth', label: 'Auth', badge: entity.auth.type !== 'none' && entity.auth.type !== 'inherit' ? '●' : undefined },
    { id: 'scripts', label: 'Scripts', badge: entity.scripts.pre.trim() || entity.scripts.post.trim() ? '●' : undefined },
    { id: 'tests', label: 'Tests', badge: n(countAssertions(entity.tests ?? emptyGroup())) },
    { id: 'settings', label: 'Settings' },
  ];
  if (isCollection) tabs.push({ id: 'runner', label: 'Runner' });
  const active: ContainerTab = tabs.some((t) => t.id === tab) ? tab : 'overview';
  const scope = isCollection ? 'collection' : 'folder';

  return (
    <div className="rv-view rv-container">
      <header className="rv-topbar">
        <Icon name={isCollection ? 'library' : 'folder'} />
        {!isCollection && <span className="rv-breadcrumb">{data.collectionName} /</span>}
        <input className="rv-input rv-topbar__name" value={entity.name} aria-label={`${isCollection ? 'Collection' : 'Folder'} name`} onChange={(e) => editContainer({ name: e.target.value })} />
        {dirty && (<span className="rv-dirty" title="Unsaved changes" role="status" aria-label="Unsaved changes">●</span>)}
        <span className="rv-spacer" />
        <Button primary icon="save" onClick={saveContainer} disabled={!dirty}>
          Save
        </Button>
      </header>
      {hostDirty && <Notice kind="warning">This {scope} was changed elsewhere. Saving will overwrite those changes.</Notice>}
      <Tabs tabs={tabs} active={active} onChange={setContainerTab} ariaLabel={`${isCollection ? 'Collection' : 'Folder'} settings`} idPrefix={P} />
      <TabPanel idPrefix={P} id={active} className="rv-scroll rv-grow rv-pad">
        {active === 'overview' && (
          <div className="rv-settings">
            <label className="rv-subhead" htmlFor="ctr-desc">
              Description (Markdown)
            </label>
            <textarea id="ctr-desc" className="rv-textarea rv-docs" value={entity.description} placeholder={`Describe this ${scope}…`} onChange={(e) => editContainer({ description: e.target.value })} />
          </div>
        )}
        {active === 'variables' && (
          <>
            <KeyValueTable rows={entity.variables} onChange={(variables) => editContainer({ variables })} ariaLabel={`${scope} variables`} keyPlaceholder="Variable" bulk description />
            <p className="rv-hint">
              {isCollection ? 'Collection' : 'Folder'} variables apply to every request inside and are stored in the {scope} file. Put secrets in an environment marked secret
              instead.
            </p>
          </>
        )}
        {active === 'headers' && (
          <>
            <KeyValueTable rows={entity.headers} onChange={(headers) => editContainer({ headers })} ariaLabel={`${scope} headers`} keyPlaceholder="Header" keySuggestions={COMMON_HEADERS} bulk description />
            <p className="rv-hint">Sent with every request in this {scope}. Request headers with the same name take precedence.</p>
          </>
        )}
        {active === 'auth' && (
          <AuthEditor
            auth={entity.auth}
            onChange={(auth) => editContainer({ auth })}
            allowInherit={!isCollection}
            onStoreSecret={storeContainerSecret}
            oauth={{ status: oauth, onGetToken: getContainerToken, onClearToken: clearContainerToken }}
          />
        )}
        {active === 'scripts' && (
          <>
            <Section title="Pre-request script">
              <ScriptEditor kind="pre" value={entity.scripts.pre} onChange={(pre) => editContainer({ scripts: { ...entity.scripts, pre } })} />
            </Section>
            <Section title="Post-response script">
              <ScriptEditor kind="post" value={entity.scripts.post} onChange={(post) => editContainer({ scripts: { ...entity.scripts, post } })} />
            </Section>
            <p className="rv-hint">Runs for every request in this {scope}, outer scopes first.</p>
          </>
        )}
        {active === 'tests' && (
          <>
            <AssertionBuilder root={entity.tests ?? emptyGroup()} onChange={(tests) => editContainer({ tests })} />
            <p className="rv-hint">These assertions are evaluated for every response in this {scope}.</p>
          </>
        )}
        {active === 'settings' && <RequestSettingsEditor settings={entity.settings} onChange={(settings) => editContainer({ settings })} />}
        {active === 'runner' && data.level === 'collection' && (
          <>
            <RunnerSettingsEditor settings={data.collection.runner as RunnerSettings} onChange={(runner) => editContainer({ runner })} />
            <p className="rv-hint">Defaults used when running this collection.</p>
          </>
        )}
      </TabPanel>
    </div>
  );
}
