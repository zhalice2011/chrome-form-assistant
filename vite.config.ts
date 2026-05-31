import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // logs 页不在 manifest 主流程里（仅 web_accessible_resources），
      // 必须显式加为 input 才会被 rollup 处理。
      input: {
        logs: 'src/logs/index.html',
      },
    },
  },
});
