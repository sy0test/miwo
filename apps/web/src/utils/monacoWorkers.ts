/**
 * 接管 monaco 的 worker（修 dev 终端里那条报错）：
 *
 *   The file does not exist at ".../.vite/deps/ts_worker.js?worker_file&type=module"
 *
 * 原因：monaco 内部用 `new Worker(new URL('.../ts.worker.js', import.meta.url))` 起 worker，
 * 而 `monaco-editor-vue3` 是**入口依赖**（页面直接 import），Vite 会把它预构建进 `.vite/deps`；
 * `optimizeDeps.exclude` 对入口依赖无效 → worker 文件不会被 emit 到 deps 目录 → 路径失效。
 *
 * 官方解法：自己设置 `MonacoEnvironment.getWorker`，worker 用 Vite 的 `?worker` 语法引入
 *（由 Vite 负责打包/服务，dev 与 build 都走同一条正确路径）。
 *
 * 注意：只有设置页（devConfig/vendorConfig）用 monaco，不影响分镜台/工作台。
 */
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

type MonacoEnv = { getWorker?: (moduleId: string, label: string) => Worker };

const env = (self as unknown as { MonacoEnvironment?: MonacoEnv }) ?? ({} as MonacoEnv);
env.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};
(self as unknown as { MonacoEnvironment: MonacoEnv }).MonacoEnvironment = env.MonacoEnvironment;

export {};
