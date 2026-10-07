import { defineConfig } from 'vite';

/**
 * 关于 server.watch.ignored：
 *
 * Windows 上「原子写文件」（先写临时目录再改名）会让 Vite 的 fs.watch 撞上
 * 一个瞬时存在、且被占用的文件，直接抛 EBUSY 把 dev server 打挂：
 *   .store.ts.<pid>.<uuid>.tmpdir/store.ts.tmp
 * 所以这里用一个函数式 ignore，把任何包含 .tmpdir / .tmp 的路径、以及
 * 只用于本地探针的 tools/ 目录整体排除掉。
 */
const IGNORED = (p: string): boolean =>
  /[\\/]node_modules[\\/]|[\\/]\.git[\\/]|[\\/]tools[\\/]|\.tmpdir[\\/]|\.tmp$/.test(p);

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: false,
    watch: {
      ignored: ['**/node_modules/**', '**/.git/**', '**/tools/**', IGNORED],
    },
  },
  build: {
    target: 'es2020',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
});
