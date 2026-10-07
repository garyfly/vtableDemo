/**
 * 入口。
 *
 * 命令式版本在这里做 bootstrap(root) 并手工拼外壳；
 * Vue 版把这一切交给 App.vue —— 入口只剩一行挂载。
 */

import { createApp } from 'vue';
import './styles.css';
import App from './App.vue';

createApp(App).mount('#app');
