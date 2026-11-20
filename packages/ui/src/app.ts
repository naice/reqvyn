import { create } from 'zustand';
import type { HostToWebview, WebviewView } from '@reqvyn/core';
import { newId } from '@reqvyn/shared';

export interface Toast {
  id: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}

interface AppState {
  view: WebviewView;
  iconUri: string | null;
  toasts: Toast[];
  pushToast: (level: Toast['level'], message: string) => void;
  dismissToast: (id: string) => void;
}

function initialView(): WebviewView {
  const v = document.getElementById('root')?.dataset.view;
  return v === 'environment' || v === 'runner' || v === 'container' ? v : 'request';
}

export const useApp = create<AppState>((set, get) => ({
  view: initialView(),
  iconUri: null,
  toasts: [],
  pushToast: (level, message) => {
    const id = newId();
    set({ toasts: [...get().toasts.slice(-3), { id, level, message }] });
    setTimeout(() => get().dismissToast(id), level === 'error' ? 10000 : 5000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export function handleAppMessage(msg: HostToWebview): void {
  if (msg.type === 'init') useApp.setState({ view: msg.view, iconUri: msg.brand.iconUri || null });
  else if (msg.type === 'toast') useApp.getState().pushToast(msg.level, msg.message);
}
