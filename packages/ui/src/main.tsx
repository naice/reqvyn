import '@vscode/codicons/dist/codicon.css';
import './styles/base.css';
import './styles/components.css';
import './styles/views.css';
import './styles/editor.css';
import { createRoot } from 'react-dom/client';
import { App } from './Root';
import { handleAppMessage } from './app';
import { onHostMessage, post } from './host';
import { handleContainerMessage } from './views/container/store';
import { handleEnvironmentMessage } from './views/environment/store';
import { handleRequestMessage } from './views/request/store';
import { handleRunnerMessage } from './views/runner/store';

// One dispatcher for all host messages; each view store ignores messages that are not meant for it.
onHostMessage((msg) => {
  handleAppMessage(msg);
  handleRequestMessage(msg);
  handleEnvironmentMessage(msg);
  handleContainerMessage(msg);
  handleRunnerMessage(msg);
});

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
  post({ type: 'ready' });
}
