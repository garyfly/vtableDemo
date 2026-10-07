import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 关于 server.watch：
 *
 * Windows 上「原子写文件」（先写临时目录再改名）会让 Vite 的 fs.watch 撞上
 * 一个瞬时存在、且被占用的文件，直接抛 EBUSY 把 dev server 打挂：
 *   .store.ts.<pid>.<uuid>.tmpdir/store.ts.tmp
 * 所以这里用一个函数式 ignore，把任何包含 .tmpdir / .tmp 的路径、以及
 * 只用于本地探针的 tools/ 目录整体排除掉。
 *
 * 另外：排除掉之后，改名落地这件事在 fs.watch 上**不可靠** ——
 * 实测改完源文件、刷新页面仍然是旧代码（dev server 一直在发陈旧 transform）。
 * 这类环境（编辑器/工具链走原子写）下改用轮询最稳：
 * 监视范围只有 src/ + 几个根文件（node_modules/.git/tools 都 ignore 了），
 * 400ms 一轮的代价可以忽略。
 */
const IGNORED = (p: string): boolean =>
  /[\\/]node_modules[\\/]|[\\/]\.git[\\/]|[\\/]tools[\\/]|\.tmpdir[\\/]|\.tmp$/.test(p);

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5275,
    strictPort: false,
    watch: {
      ignored: ['**/node_modules/**', '**/.git/**', '**/tools/**', IGNORED],
      usePolling: true,
      interval: 400,
    },
  },
  build: {
    target: 'es2020',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
});
