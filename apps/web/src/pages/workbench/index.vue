<template>
  <div class="main" :style="{ height: isElectron ? 'calc(100vh - 32px)' : '100vh' }">
    <div class="menu fc jb">
      <div class="logoBox c">
        <div class="logo"></div>
      </div>
      <div class="itemBox fc ac">
        <t-tooltip
          :content="menu.labelKey ? $t(menu.labelKey) : ''"
          placement="right"
          destroyOnClose
          :showArrow="false"
          v-for="(menu, index) in menuList"
          :key="index">
          <div class="item fc c" v-if="menu.type === 'btn'" :class="{ active: activeMenu == menu.path }" @click="handleClick(menu)">
            <component :is="menu.icon" class="icon" />
          </div>
          <div class="divider" v-if="menu.type === 'divider'"></div>
        </t-tooltip>
      </div>
      <div class="footItem fc ac">
        <t-tooltip :content="$t('workbench.menu.settings')" placement="right" destroyOnClose :showArrow="false">
          <div class="item c" @click="showSetting = true">
            <i-setting-one class="icon" />
          </div>
        </t-tooltip>
        <button class="balanceLink" :class="{ active: activeMenu === '/billing' }" :aria-label="$t('billing.sidebar.label')" :title="billingAccount.account && !billingAccount.error ? `${$t('billing.sidebar.label')}: ${formatMicroToCny(getAvailableBalanceMicro(billingAccount.account))} ${$t('billing.cny')}` : $t('billing.sidebar.unavailable')" @click="openBilling">
          <span class="balanceLabel">{{ $t("billing.sidebar.label") }}</span>
          <strong v-if="billingAccount.account && !billingAccount.error">{{ formatMicroToCny(getAvailableBalanceMicro(billingAccount.account)) }} {{ $t("billing.cny") }}</strong>
          <span v-else-if="billingAccount.loading">{{ $t("billing.sidebar.loading") }}</span>
          <span v-else>{{ $t("billing.sidebar.unavailable") }}</span>
        </button>
      </div>
    </div>
    <div class="view">
      <div class="topMenu f ac jb" v-if="project?.id">
        <div class="title">
          <h2>{{ project?.name || $t("workbench.selectProject") }}</h2>
        </div>
        <div class="rightBtnList f ac">
          <t-tooltip
            :content="menu.labelKey ? $t(menu.labelKey) : ''"
            placement="bottom"
            destroyOnClose
            :showArrow="false"
            v-for="(menu, index) in rightBtnList"
            :key="index">
            <div
              class="item fc c"
              v-if="menu.type === 'btn' && showMenu(menu)"
              :class="{ active: activeMenu == menu.path }"
              @click="handleClick(menu)">
              <component :is="menu.icon" class="icon" />
            </div>
            <div class="divider" v-if="menu.type === 'divider'"></div>
          </t-tooltip>
        </div>
      </div>
      <div class="viewBox">
        <router-view v-slot="{ Component }">
          <component :is="Component" :key="$route.fullPath" />
        </router-view>
      </div>
    </div>
  </div>
  <hello />
  <setting />
</template>

<script setup lang="ts">
import setting from "@/components/setting/index.vue";
import hello from "@/components/hello.vue";
import projectStore from "@/stores/project";
const { project } = storeToRefs(projectStore());
import settingStore from "@/stores/setting";
import billingStore from "@/stores/billing";
import userStore from "@/stores/user";
import { formatMicroToCny, getAvailableBalanceMicro } from "@/views/billing/billingData";
const { showSetting, isElectron } = storeToRefs(settingStore());
const billingAccount = billingStore();
onMounted(() => billingAccount.refreshAccount());
const menuList = computed(() => [
  { type: "btn", path: "/project", labelKey: "workbench.menu.myProject", icon: "i-folder-close" },
  { type: "btn", path: "/task", labelKey: "workbench.menu.taskCenter", icon: "i-view-list" },
  { type: "btn", path: "/billing", labelKey: "workbench.menu.billing", icon: "i-finance" },
  ...(userStore().role === "admin" ? [{ type: "btn", path: "/admin/users", labelKey: "管理用户与分组", icon: "i-peoples" }] : []),
]);

const rightBtnList = ref([
  { type: "btn", path: "/novel", labelKey: "workbench.menu.novel", icon: "i-notebook", nodelOnly: true },
  { type: "btn", path: "/scriptAgent", labelKey: "workbench.menu.scriptAgent", icon: "i-color-filter", nodelOnly: true },
  { type: "btn", path: "/script", labelKey: "workbench.menu.scriptManage", icon: "i-document-folder", hideRedraw: true },
  // 出海转绘：剧本文本换成一集一个源片，剧本管理在这里没有意义（那页会把源片当剧本列出来）
  { type: "btn", path: "/inputVideo", labelKey: "workbench.menu.inputVideo", icon: "i-movie", onlyRedraw: true },
  { type: "btn", path: "/cornerScape", labelKey: "workbench.menu.cornerScape", icon: "i-peoples-two" },
  { type: "btn", path: "/production", labelKey: "workbench.menu.production", icon: "i-carousel-video" },
  { type: "divider" },
  { type: "btn", path: "/assets", labelKey: "workbench.menu.assetCenter", icon: "i-receive" },
]);

/** 顶栏按钮按项目类型取舍：转绘项目没有小说原文/剧本，别让人点进去看一页空表单 */
function showMenu(menu: any) {
  const t = project.value?.projectType;
  if (menu.onlyRedraw) return t === "redraw";
  if (menu.hideRedraw) return t !== "redraw";
  if (menu.nodelOnly) return t === "novel";
  return true;
}

const router = useRouter();
const route = useRoute();
const activeMenu = ref(route.path);

watch(
  () => route.path,
  (newPath) => {
    activeMenu.value = newPath;
  },
);

function handleClick(menu: any) {
  if (menu.needProject && !project.value) return;
  router.push(menu.path);
  activeMenu.value = menu.path;
}

function openBilling() {
  router.push("/billing");
  activeMenu.value = "/billing";
}

</script>

<style lang="scss" scoped>
.main {
  width: 100vw;
  padding: 16px;
  display: flex;

  .menu {
    width: 88px;
    height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    background-color: var(--page);
    border-radius: 16px;
    padding-top: 16px;
    padding-bottom: 16px;
    color: var(--td-text-color-primary);
    .logoBox {
      width: 100%;
      height: fit-content;
      .logo {
        width: 60%;
        aspect-ratio: 1/1;
        background-color: var(--td-text-color-primary);
        mask: url("@/assets/logo.svg") no-repeat center;
        mask-size: contain;
        -webkit-mask: url("@/assets/logo.svg") no-repeat center;
        -webkit-mask-size: contain;
      }
    }
    .itemBox {
      flex: 1;
      margin-top: 16px;
      margin-bottom: 16px;
      padding-bottom: 16px;
      width: 100%;
      height: 100%;
    }
    .footItem {
      width: 100%;
      height: fit-content;
      .item {
        cursor: pointer;
        width: 50px;
        height: 50px;
        .icon {
          font-size: 24px;
        }
        &:hover {
          background-color: var(--td-bg-color-container-hover);
          border-radius: 16px;
        }
      }
      .active {
        background-color: #000 !important;
        border-radius: 16px;
      }
    }
  }
  .menu::-webkit-scrollbar {
    width: 4px;
  }
  .menu::-webkit-scrollbar-thumb {
    background-color: #d5d5d5;
    border-radius: 4px;
    &:hover {
      background-color: #bbb;
    }
  }
  .menu::-webkit-scrollbar-track {
    background-color: transparent;
  }
  .view {
    flex: 1;
    margin-left: 16px;
    background-color: var(--page);
    border-radius: 16px;
    width: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-gutter: stable;
    padding-left: 32px;
    padding-right: 32px;
    .topMenu {
      height: 50px;
      .rightBtnList {
        .item {
          margin-bottom: 0px !important;
          margin-top: 0px !important;
          margin-right: 4px;
          margin-left: 4px;
        }
        .divider {
          width: 1px;
          height: 24px;
          background-color: var(--td-border-level-1-color);
          margin: 0 4px;
        }
      }
    }
    .viewBox {
      width: 100%;
      height: calc(100% - 6vh);
    }
  }
}

.balanceLink {
  width: 78px;
  min-height: 56px;
  flex: 0 0 56px;
  margin-top: 8px;
  padding: 4px;
  border: 0;
  background: transparent;
  color: var(--td-text-color-primary);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  overflow: hidden;
  .balanceLabel { font-size: 11px; line-height: 14px; }
  strong, > span:last-child { max-width: 100%; font-size: 10px; line-height: 12px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  &:hover { background-color: var(--td-bg-color-container-hover); border-radius: 8px; }
}

.item {
  margin-bottom: 4px;
  margin-top: 4px;
  cursor: pointer;
  width: 50px;
  height: 50px;
  .icon {
    font-size: 24px;
  }
  .title {
    font-size: 10px;
    white-space: nowrap;
    color: var(--td-text-color-primary);
  }
  &:hover {
    background-color: var(--td-bg-color-container-hover);
    border-radius: 16px;
  }
}
.active {
  background-color: var(--td-brand-color) !important;
  color: var(--td-font-white-1);
  border-radius: 16px;
}
.divider {
  width: 50px;
  height: 1px;
  background-color: var(--td-border-level-1-color);
  margin: 8px 0;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
