import axios, { type InternalAxiosRequestConfig } from "axios";
import router from "@/router/index";
import { storeToRefs } from "pinia";
import { MessagePlugin, NotifyPlugin } from "tdesign-vue-next";
import settingStore from "@/stores/setting";
import userStore from "@/stores/user";
import { clearSession, refreshAccessToken } from "@/utils/session";
import { normalizeApiError } from "@/utils/apiError";
import { h } from "vue";

const instance = axios.create();

/**
 * ⚠ **必须保留 `withCredentials`**（Phase 1c Task 11）：refresh 凭证是 `HttpOnly` Cookie，而 dev 下
 * 前端 50188 打后端 10588 是**跨源** —— 不带凭据时浏览器既不**发** Cookie，也不**存**响应里下发的
 * `Set-Cookie`（表现为"登录成功、刷新页面就掉线"）。后端 CORS 已 `credentials: true`（白名单 origin）。
 */
instance.defaults.withCredentials = true;

/** 带 `_retried` 标记的请求配置：401 续期后只重放**一次**（防无限循环）。 */
type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean };

/** 这些路径上的 401 **不是**"access 过期"，去续期只会绕圈（凭据本身就是错的/没有）。 */
const NO_REFRESH_PATHS = ["/auth/login", "/auth/register", "/auth/refresh"];
function shouldTryRefresh(url: string | undefined): boolean {
  const u = String(url ?? "");
  return !NO_REFRESH_PATHS.some((p) => u.includes(p));
}

/** 401 且续不回来 ⇒ 清内存 + 回登录页（已经在登录页就只提示，不重复 push）。 */
function toLogin(message: string): void {
  clearSession();
  if (router.currentRoute.value.path !== "/login") {
    router.push("/login");
    MessagePlugin.error(message);
  }
}

instance.interceptors.request.use(function (config) {
  const { baseUrl, otherSetting } = storeToRefs(settingStore());
  config.baseURL = baseUrl.value;
  config.timeout = otherSetting.value.axiosTimeOut;
  // ⚠【Phase 1c Task 11】令牌从**内存 store** 取（原来是 `localStorage.getItem("token")`）。
  const token = userStore().token;
  if (token) {
    config.headers.Authorization = token;
  }

  return config;
});

instance.interceptors.response.use(
  function (response) {
    return response.data;
  },
  async function (error) {
    const status = Number(error?.response?.status ?? 0);
    const config = error?.config as RetriableConfig | undefined;

    // ── 网络层（连不上后端）：保留原有的排障指引（它说的是"怎么把服务弄起来"，与后端文案无关）──
    if (String(error?.message ?? "").includes("Network Error") || error?.response?.data?.message === "Network Error") {
      NotifyPlugin.error({
        title: "Network Error",
        closeBtn: true,
        duration: 3000, // 不自动关闭，让用户有时间看
        className: "customNotifyFull", // 自定义类名
        content: () =>
          h("div", [
            h("div", { style: { marginBottom: "8px" } }, "网络连接失败，请依次尝试："),
            h("div", { style: { marginBottom: "4px" } }, "1. 右键程序图标 → 以管理员身份运行"),
            h("div", { style: { marginBottom: "4px" } }, "2. 检查后端服务是否已正常启动"),
            h("div", [
              "3. 安装 Visual C++ 运行库：",
              h("div", { style: { display: "flex", gap: "8px", marginTop: "4px" } }, [
                h(
                  "a",
                  {
                    href: "https://aka.ms/vs/17/release/vc_redist.x86.exe",
                    target: "_blank",
                    rel: "noopener noreferrer",
                    style: { color: "#0052d9" },
                  },
                  "32位下载",
                ),
                h(
                  "a",
                  {
                    href: "https://aka.ms/vs/17/release/vc_redist.x64.exe",
                    target: "_blank",
                    rel: "noopener noreferrer",
                    style: { color: "#0052d9" },
                  },
                  "64位下载",
                ),
              ]),
            ]),
          ]),
      });
      return Promise.reject(normalizeApiError(error));
    }

    /**
     * ── 401：**静默续期一次**再重放原请求（Phase 1c Task 11 的核心）──
     * 续期成功 ⇒ 用新 access 重放（`_retried` 保证只重放一次，重放再 401 就落到下面那条）；
     * 续期失败 ⇒ 清内存 + 回登录页。两种情况都**不**依赖后端文案。
     */
    if (status === 401 && config && !config._retried && shouldTryRefresh(config.url)) {
      config._retried = true;
      const token = await refreshAccessToken();
      if (token) {
        config.headers = { ...(config.headers as any), Authorization: token } as any;
        return instance.request(config);
      }
      toLogin(window.$t("common.sessionExpired"));
      return Promise.reject(normalizeApiError(error));
    }

    if (status === 401) {
      // 已经重放过一次 / 是登录注册这类端点本身返回 401 ⇒ 不再续期
      toLogin(window.$t("common.sessionExpired"));
      return Promise.reject(normalizeApiError(error));
    }

    // ── 403 / 429 的分支（原来是 `error.status === 401` 那种**错属性路径**，403/429 无人处理）──
    if (status === 403) {
      MessagePlugin.error(window.$t("common.apiError.forbidden"));
    } else if (status === 429) {
      MessagePlugin.error(window.$t("common.apiError.tooManyRequests"));
    }

    /**
     * ⚠ 归一化后再 reject：调用点写着 `err.message`（全仓 37 个文件），**不改变它们的写法**的前提下，
     *   把"可以直接渲染的文案"放进 `message`、把后端原文放进 `rawMessage`（不渲染）。
     */
    return Promise.reject(normalizeApiError(error));
  },
);

export default instance;
