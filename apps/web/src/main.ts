import { createApp } from "vue";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import App from "./App.vue";
import router from "./router";
import i18n from "./locales";
import { install } from "@icon-park/vue-next/es/all";
import "@icon-park/vue-next/styles/index.css";

import "tdesign-vue-next/es/style/index.css";
import { LoadingDirective, LoadingPlugin } from "tdesign-vue-next";

import "@/utils/global";
// 接管 monaco 的 worker（修 dev 里 `.vite/deps/ts_worker.js?worker_file` 那条报错）；只有设置页用到 monaco
import "@/utils/monacoWorkers";

import { Log } from "@webav/av-cliper";
Log.setLogLevel(Log.warn);

import "md-editor-v3/lib/style.css";
import "splitpanes/dist/splitpanes.css";

import "./assets/main.scss";

import { imageOptimizer } from '@/utils/imageOptimizer'

const app = createApp(App);
app.use(imageOptimizer)
install(app, "i");
app.use(createPinia().use(piniaPluginPersistedstate));
app.use(router);
app.use(i18n);
app.use(LoadingPlugin);
app.directive("loading", LoadingDirective);
app.mount("#app");

// 「浏览器现在跑的是哪一版前端」由**部署脚本注入 HTML**（docs/tools/deploy-to-server.cjs），
// 这样不依赖构建期变量替换（vite define 对模板字符串里的标识符不可靠）。
