import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';

const mount = document.getElementById('root');
if (!mount) throw new Error('Root element missing');
createRoot(mount).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
