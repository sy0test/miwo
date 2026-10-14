import { createRouter, createWebHashHistory } from "vue-router";
import userStore from "@/stores/user";
import { refreshAccessToken } from "@/utils/session";
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/:catchAll(.*)",
      name: "404",
      meta: {
        title: "404",
      },
      component: () => import("@/pages/error/404.vue"),
    },
    {
      path: "/",
      redirect: "/workbench",
    },
    {
      path: "/workbench",
      component: () => import("@/pages/workbench/index.vue"),
      redirect: "/project",
      children: [
        {
          path: "/project",
          component: () => import("@/views/project/index.vue"),
        },
        {
          path: "/task",
          component: () => import("@/views/task/index.vue"),
        },
        // {
        //   path: "/detail",
        //   component: () => import("@/views/detail/index.vue"),
        // },
        {
          path: "/novel",
          component: () => import("@/views/novel/index.vue"),
        },
        {
          path: "/script",
          component: () => import("@/views/script/index.vue"),
        },
        {
          // 出海转绘的源片管理（一集 = 一条 o_script，但页面内容是视频卡不是剧本文本）
          path: "/inputVideo",
          component: () => import("@/views/inputVideo/index.vue"),
        },
        {
          path: "/scriptAgent",
          component: () => import("@/views/scriptAgent/index.vue"),
        },
        {
          path: "/cornerScape",
          component: () => import("@/views/cornerScape/index.vue"),
        },
        {
          path: "/production",
          component: () => import("@/views/production/index.vue"),
        },
        {
          path: "/assets",
          component: () => import("@/views/assets/index.vue"),
        },
        {
          path: "/test",
          component: () => import("@/views/test/index.vue"),
        },
      ],
    },
    {
      path: "/login",
      component: () => import("@/pages/login/index.vue"),
    },
  ],
});
/**
 * 路由守卫（Phase 1c Task 11）。
 *
 * ⚠ 判据从 `localStorage.getItem("token")` 换成**内存 store**：access **不落盘**（spec §7.2）。
 *   代价是"刷新页面后内存里一定没有 token"，所以这里先做一次**静默续期**：
 *   refresh 在 `HttpOnly` Cookie 里（JS 读不到、但浏览器会自动带上）⇒ 续期成功就**直接放行**，
 *   用户不需要重新登录。续期失败（Cookie 过期/被吊销/后端没起）⇒ 回登录页。
 *
 * ⚠ `refreshAccessToken()` 是**单飞**的（同一次 401 风暴/首屏多处调用只发一次请求），
 *   且它自己吞掉异常（返回 `null`）—— 守卫里不需要 try/catch。
 * ⚠ 只对**非登录页**做这件事：登录页本来就不需要令牌，去续期只是白白多一个请求。
 */
router.beforeEach(async (to, _from, next) => {
  if (to.path === "/login") {
    next();
    return;
  }
  if (userStore().token) {
    next();
    return;
  }
  const token = await refreshAccessToken();
  if (token) {
    next();
    return;
  }
  next("/login");
});
export default router;
