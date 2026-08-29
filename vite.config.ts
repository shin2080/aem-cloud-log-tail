import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// 웹은 web/ 을 루트로 두고, 빌드 산출물은 서버가 정적 서빙할 dist/web 에 넣는다.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 7301,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7300',
        changeOrigin: false,
      },
    },
  },
});
