import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startAppUpdates } from './pwa/updates';
import './styles.css';

startAppUpdates();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
