import { useApp } from './app';
import { Icon, IconButton } from './components/ui';
import { ContainerView } from './views/container/ContainerView';
import { EnvironmentView } from './views/environment/EnvironmentView';
import { RequestView } from './views/request/RequestView';
import { RunnerView } from './views/runner/RunnerView';

export function App() {
  const view = useApp((s) => s.view);
  return (
    <>
      {view === 'request' && <RequestView />}
      {view === 'environment' && <EnvironmentView />}
      {view === 'container' && <ContainerView />}
      {view === 'runner' && <RunnerView />}
      <Toasts />
    </>
  );
}

const TOAST_ICON = { info: 'info', warning: 'warning', error: 'error' } as const;

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="rv-toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`rv-toast rv-toast--${t.level}`} role={t.level === 'error' ? 'alert' : 'status'}>
          <Icon name={TOAST_ICON[t.level]} />
          <span className="rv-toast__msg">{t.message}</span>
          <IconButton icon="close" label="Dismiss notification" onClick={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}
