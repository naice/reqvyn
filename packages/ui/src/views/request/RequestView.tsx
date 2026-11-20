import { useEffect, useState } from 'react';
import { SplitPane, type SplitOrientation } from '../../components/SplitPane';
import { EmptyState } from '../../components/ui';
import { getUiState, setUiState } from '../../host';
import { CodegenPanel } from './CodegenPanel';
import { RequestPane } from './RequestPane';
import { ResponsePane } from './ResponsePane';
import { TopBar } from './TopBar';
import { cancelRequest, saveRequest, sendRequest, useRequestStore } from './store';

export function RequestView() {
  const request = useRequestStore((s) => s.request);
  const [orientation, setOrientationState] = useState<SplitOrientation>(() => getUiState('splitOrientation', 'horizontal'));
  const [ratio, setRatioState] = useState<number>(() => getUiState('splitRatio', 0.5));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        sendRequest();
      } else if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveRequest(e.shiftKey);
      } else if (e.key === 'Escape' && useRequestStore.getState().response.status === 'loading' && !useRequestStore.getState().codegen.open) {
        cancelRequest();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!request) {
    return <EmptyState icon="loading" title="Loading request…" />;
  }

  const setOrientation = (o: SplitOrientation) => {
    setOrientationState(o);
    setUiState('splitOrientation', o);
  };
  const setRatio = (r: number) => {
    setRatioState(r);
    setUiState('splitRatio', r);
  };

  return (
    <div className="rv-view rv-request">
      <TopBar />
      <div className="rv-request__main">
        <SplitPane
          orientation={orientation}
          ratio={ratio}
          onRatio={setRatio}
          first={<RequestPane request={request} />}
          second={<ResponsePane orientation={orientation} onToggleOrientation={() => setOrientation(orientation === 'horizontal' ? 'vertical' : 'horizontal')} />}
        />
      </div>
      <CodegenPanel />
    </div>
  );
}
