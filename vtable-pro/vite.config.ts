import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5277,
    strictPort: true,
    // Windows + Node 24 下 chokidar 会去 watch Vite 自己写出的 `*.tmpdir` 原子写临时目录，
    // 目录随即被删掉就抛 EBUSY，未捕获的 FSWatcher error 会把 dev server 直接干掉。
    watch: { ignored: ['**/*.tmpdir/**', '**/node_modules/**', '**/.git/**'] },
  },
  preview: { host: '127.0.0.1', port: 5278, strictPort: true },
  build: { target: 'es2020', chunkSizeWarningLimit: 4096 }
});
