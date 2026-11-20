import { create } from 'zustand';
import type { CollectionInfo, Folder, HostToWebview } from '@reqvyn/core';
import type { OAuthStatus } from '../../components/AuthEditor';
import { getUiState, post, setUiState } from '../../host';

export type ContainerTab = 'overview' | 'variables' | 'headers' | 'auth' | 'scripts' | 'tests' | 'settings' | 'runner';

export type ContainerData = { level: 'collection'; collection: CollectionInfo } | { level: 'folder'; folder: Folder; collectionName: string };

export interface ContainerStoreState {
  data: ContainerData | null;
  /** Unsaved local changes (there is no container:update message; edits are kept here until saved). */
  dirty: boolean;
  /** Host reported changes that were made elsewhere while this panel was open. */
  hostDirty: boolean;
  tab: ContainerTab;
  oauth: OAuthStatus;
}

export const useContainerStore = create<ContainerStoreState>(() => ({
  data: null,
  dirty: false,
  hostDirty: false,
  tab: getUiState<ContainerTab>('containerTab', 'overview'),
  oauth: { status: 'idle' },
}));

const set = useContainerStore.setState;
const get = useContainerStore.getState;

export type ContainerEntity = CollectionInfo | Folder;

export function entityOf(data: ContainerData): ContainerEntity {
  return data.level === 'collection' ? data.collection : data.folder;
}

export function editContainer(patch: Partial<CollectionInfo> & Partial<Folder>): void {
  const d = get().data;
  if (!d) return;
  if (d.level === 'collection') set({ data: { ...d, collection: { ...d.collection, ...patch } as CollectionInfo }, dirty: true });
  else set({ data: { ...d, folder: { ...d.folder, ...patch } as Folder }, dirty: true });
}

export function saveContainer(): void {
  const d = get().data;
  if (!d) return;
  post({
    type: 'container:save',
    target: d.level === 'collection' ? { level: 'collection', collection: d.collection } : { level: 'folder', folder: d.folder },
  });
}

export function setContainerTab(tab: ContainerTab): void {
  set({ tab });
  setUiState('containerTab', tab);
}

export function storeContainerSecret(field: string, value: string): void {
  post({ type: 'secret:store', field, value });
}

export function getContainerToken(): void {
  const d = get().data;
  if (!d) return;
  post({ type: 'oauth2:getToken', auth: entityOf(d).auth });
  set({ oauth: { status: 'running', message: 'Requesting token…' } });
}

export function clearContainerToken(): void {
  const d = get().data;
  if (d) post({ type: 'oauth2:clearToken', auth: entityOf(d).auth });
}

export function handleContainerMessage(msg: HostToWebview): void {
  if (msg.type === 'container:state') {
    const data: ContainerData = msg.level === 'collection' ? { level: 'collection', collection: msg.collection } : { level: 'folder', folder: msg.folder, collectionName: msg.collectionName };
    const cur = get().data;
    const sameEntity = cur && cur.level === data.level && entityOf(cur).id === entityOf(data).id;
    // A state push after our own save (msg.dirty false) replaces the local draft; otherwise keep unsaved edits.
    if (sameEntity && get().dirty && msg.dirty) {
      set({ hostDirty: true });
      return;
    }
    set({ data, dirty: msg.dirty, hostDirty: false });
  } else if (msg.type === 'oauth2:status') {
    set({ oauth: { status: msg.status, message: msg.message, expiresAt: msg.expiresAt, userCode: msg.userCode, verificationUri: msg.verificationUri } });
  }
}
