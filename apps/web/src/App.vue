<template>
  <div v-if="loading" class="app-loading">
    <t-loading :loading="true" size="large" text="加载中..." />
  </div>
  <template v-else>
    <t-config-provider :global-config="globalConfig">
      <router-view></router-view>
    </t-config-provider>
  </template>
</template>

<script setup lang="ts">
import settingStore from "@/stores/setting";
import { merge } from "lodash";
import zhConfig from "tdesign-vue-next/es/locale/zh_CN";
import enConfig from "tdesign-vue-next/es/locale/en_US";
import { cachedLocale, languageList } from "@/locales";
import { initTheme } from "@/utils/theme";
import { type GlobalConfigProvider } from "tdesign-vue-next";
import { useI18n } from "vue-i18n";

const { locale } = useI18n();
const { baseUrl, isElectron } = storeToRefs(settingStore());
import { config } from "md-editor-v3";

const loading = ref(true);

watch(
  () => isElectron.value,
  (newVal) => {
    if (newVal) {
      document.body.classList.add("is-electron");
    } else {
      document.body.classList.remove("is-electron");
    }
  },
  { immediate: true },
);

onBeforeMount(() => {
  document.addEventListener("keydown", function (event) {
    if (event.key === "F8") {
      event.preventDefault();
      debugger;
    }
  });
});

// 初始化主题
onMounted(async () => {
  resolveBaseUrl();
});

async function handleLinkClick(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();

  const target = event.currentTarget as HTMLAnchorElement | null;
  const url = target?.getAttribute("data-link") || target?.getAttribute("href");
  if (!url) return false;

  window.open(url, "_blank", "noopener,noreferrer");

  return false;
}

onMounted(() => {
  (window as any).handleLinkClick = handleLinkClick;
});

/** Phase 1e Task 02：原 `getPort()` 已改名（它不再探 Electron 端口，只解析 baseUrl）。 */
async function resolveBaseUrl() {
  await nextTick();
  await nextTick();
  await nextTick();
  await nextTick();
  // ⚠ Phase 1e Task 02：Electron 自定义协议的 getAppUrl 探针已整体删除（服务器版没有该协议，
  //   `isElectron` 恒为 false）。以下是服务器版的**真实路径** —— 必须分两种开发/使用方式，不能一律用同源：
  {
    //   a) **页面就是后端自己吐出来的**（局域网服务器模式：http://<IP>:18080/、或本机 10588）
    //      → 用**同源** /api，这样用户机用任何 IP/域名访问都能连上；
    //   b) **页面是 Vite dev server 吐的**（如 http://localhost:50188），后端另在 10588
    //      → 必须保留默认 `http://localhost:10588/api`，否则会指向 50188 连不上（本机开发会坏掉）。
    // 判据：探测同源有没有后端 —— 用免登录的最小接口 configHealth（只返回文件数量与 error 计数）。
    // ⚠ 不能只看 `r.ok`：**Vite dev server 对未知路径也返回 200**（吐 index.html），
    // 那样会把 50188 误判成后端、本机开发就指向自己了。所以要求响应是 **JSON** 且能解析。
    isElectron.value = false;
    const sameOriginHasBackend = await fetch(`${location.origin}/api/other/configHealth?summary=1`)
      .then(async (r) => {
        if (!r.ok) return false;
        if (!(r.headers.get("content-type") || "").includes("json")) return false;
        return !!(await r.json().catch(() => null));
      })
      .catch(() => false);
    if (sameOriginHasBackend) baseUrl.value = location.origin + "/api";
  }

  loading.value = false;

  config({
    markdownItConfig(md) {
      // 自定义链接渲染
      const defaultRender =
        md.renderer.rules.link_open ||
        function (tokens, idx, options, env, self) {
          return self.renderToken(tokens, idx, options);
        };
      md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
        const token = tokens[idx];
        const href = token.attrGet("href");

        if (href) {
          // 添加 target="_blank" 在新窗口打开
          token.attrSet("target", "_blank");
          token.attrSet("rel", "noopener noreferrer");

          // 或者添加自定义点击事件的标识
          token.attrSet("data-link", href);
          token.attrSet("onclick", "return handleLinkClick(event)");
        }

        return defaultRender(tokens, idx, options, env, self);
      };
    },
  });

  try {
    const language = navigator.language;
    if (language && languageList.some((item) => item.value === language)) {
      cachedLocale.value = language;
      locale.value = language;
    }
  } catch (e) {
    console.error("获取语言失败", e);
  }
}

const tdesignLocaleMap: Record<string, object> = {
  "zh-CN": zhConfig,
  en: enConfig,
};

const customConfig: GlobalConfigProvider = {
  calendar: {},
  table: {},
  pagination: {},
};
const globalConfig = computed<GlobalConfigProvider>(() => merge({}, tdesignLocaleMap[cachedLocale.value] || zhConfig, customConfig));

onBeforeMount(() => {
  initTheme();
});
</script>

<style lang="scss">
.app-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100vw;
  height: 100vh;
  background: var(--td-bg-color-page, #f5f5f5);
}
</style>
