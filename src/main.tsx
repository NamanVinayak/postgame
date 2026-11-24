import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startAppUpdates } from './pwa/updates';
import './styles.css';

try {
  startAppUpdates();
} catch {
  // e.g. a SecurityError reading navigator.serviceWorker (some privacy modes): run without updates.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
