import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', proxy: { '/ui': 'http://127.0.0.1:3000', '/v1': 'http://127.0.0.1:3000' } },
});
