import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3501,
    strictPort: true,
    proxy: { '/v1': { target: 'http://127.0.0.1:3500', changeOrigin: false } },
  },
});
