<template>
  <div class="logout-config">
    <t-space direction="vertical" size="medium">
      <t-alert theme="warning" :message="$t('settings.logout.warning')" />
      <t-button theme="danger" :loading="loading" @click="openLogoutDialog">
        <template #icon>
          <t-icon name="logout" />
        </template>
        {{ $t("settings.logout.logout") }}
      </t-button>
    </t-space>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import { clearSession } from "@/utils/session";

const router = useRouter();
const loading = ref(false);

function openLogoutDialog() {
  const dialog = DialogPlugin.confirm({
    header: $t("settings.logout.logout"),
    body: $t("settings.logout.confirmLogout"),
    confirmBtn: {
      content: $t("settings.logout.logout"),
      theme: "danger",
    },
    cancelBtn: $t("common.cancel"),
    onConfirm: async () => {
      dialog.destroy();
      await handleLogout();
    },
    onClose: () => dialog.destroy(),
  });
}

/**
 * 登出（Phase 1c Task 11）。
 *
 * ⚠ 顺序与理由：
 *   ① `POST /api/auth/logout` —— **服务端**才是真正的吊销：`tokenVersion++` 让该账号**所有**已签发的
 *      access/refresh 立刻失效（spec §7.2），并清掉 refresh Cookie；
 *   ② 无论它成功与否都要 `clearSession()` —— 否则"网络断了"会让用户**以为**自己退出了，
 *      而内存里那条 access 还在继续被发出去；
 *   ③ 回登录页。
 * ⚠ 旧实现只删 `localStorage` 里的两个键，**从不通知服务端** ⇒ 令牌在 7 天/180 天里一直有效。
 */
async function handleLogout() {
  loading.value = true;
  let ok = true;
  try {
    await axios.post("/auth/logout");
  } catch (error) {
    ok = false;
  } finally {
    clearSession();
    loading.value = false;
  }
  if (ok) {
    window.$message.success($t("settings.logout.msg.logoutSuccess"));
  } else {
    window.$message.error($t("settings.logout.msg.logoutFailed"));
  }
  router.push("/login");
}
</script>

<style lang="scss" scoped>
.logout-config {
  padding: 10px 0;
}
</style>
