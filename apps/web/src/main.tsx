import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const mount = document.getElementById('root');
if (!mount) {
  throw new Error('Root element missing');
}

createRoot(mount).render(
  <StrictMode>
    <main>
      <h1>GEOPS</h1>
      <p>Wave 0A: estructura de desarrollo con datos sintéticos.</p>
    </main>
  </StrictMode>,
);
