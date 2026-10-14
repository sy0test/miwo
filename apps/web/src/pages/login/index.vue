<template>
  <div class="loginPage" :style="{ height: isElectron ? 'calc(100vh - 32px)' : '100vh' }">
    <div class="formBox">
      <!-- 设置弹窗 -->
      <t-dialog v-model:visible="showSettingModal" :header="$t('login.settings')" @confirm="handleSaveSetting" :width="400">
        <t-form label-width="80px" labelAlign="top">
          <t-form-item :label="$t('login.requestAddress')">
            <t-input v-model="tempBaseUrl" placeholder="http://localhost:10588" />
          </t-form-item>
        </t-form>
      </t-dialog>
      <div class="logoBox fc">
        <div class="logoImg"></div>
        <div class="fc c">
          <span class="logoText">MirrorWorld</span>
          <span class="slogan">{{ $t("login.slogan") }}</span>
        </div>
      </div>
      <div class="login-form">
        <t-input v-model="state.user.username" :placeholder="$t('login.username')" autocomplete="username" size="large"></t-input>
        <t-input v-model="state.user.password" type="password" :placeholder="$t('login.password')" size="large"></t-input>
        <t-button class="loginBtn" theme="primary" size="large" :loading="state.loginLoading" @click="handleLogin" block>
          {{ $t("login.login") }}
        </t-button>
        <!-- Phase 1c Task 11：注册入口（后端 `/api/auth/register`，默认"邀请码"模式） -->
        <t-button class="registerBtn" variant="text" size="medium" @click="openRegister">{{ $t("login.noAccountRegister") }}</t-button>
      </div>
      <div class="tips c">{{ $t("login.tips") }}</div>
    </div>
  </div>

  <!-- 注册弹窗（最小实现：用户名 / 口令 / 邀请码；不做"找回密码"，见 task-11-report.md 的登记） -->
  <t-dialog
    v-model:visible="showRegisterModal"
    :header="$t('login.register')"
    :width="420"
    :confirmBtn="{ content: $t('login.register'), loading: registerLoading }"
    :cancelBtn="$t('common.cancel')"
    @confirm="handleRegister">
    <t-form label-width="80px" labelAlign="top">
      <t-form-item :label="$t('login.username')">
        <t-input v-model="register.username" :placeholder="$t('login.usernamePlaceholder')" autocomplete="username" />
      </t-form-item>
      <t-form-item :label="$t('login.password')">
        <t-input v-model="register.password" type="password" :placeholder="$t('login.passwordRule')" />
      </t-form-item>
      <t-form-item :label="$t('login.passwordConfirm')">
        <t-input v-model="register.passwordConfirm" type="password" />
      </t-form-item>
      <t-form-item :label="$t('login.inviteCode')">
        <t-input v-model="register.inviteCode" :placeholder="$t('login.inviteCodePlaceholder')" />
      </t-form-item>
      <t-alert theme="info" :message="$t('login.inviteHint')" />
    </t-form>
  </t-dialog>

  <!-- ★ 首次登录**强制**改密（spec §7.1）：不可关闭、不可取消，只能改完或退出 -->
  <t-dialog
    v-model:visible="showChangePasswordModal"
    :header="$t('login.mustChangePasswordTitle')"
    :width="420"
    :closeBtn="false"
    :closeOnOverlayClick="false"
    :closeOnEscKeydown="false"
    :cancelBtn="null"
    :confirmBtn="{ content: $t('login.changePassword'), loading: changeLoading }"
    @confirm="handleChangePassword">
    <t-alert theme="warning" :message="$t('login.mustChangePasswordHint')" />
    <t-form label-width="80px" labelAlign="top" style="margin-top: 12px">
      <t-form-item :label="$t('login.oldPassword')">
        <t-input v-model="changeForm.oldPassword" type="password" />
      </t-form-item>
      <t-form-item :label="$t('login.newPassword')">
        <t-input v-model="changeForm.newPassword" type="password" :placeholder="$t('login.passwordRule')" />
      </t-form-item>
      <t-form-item :label="$t('login.passwordConfirm')">
        <t-input v-model="changeForm.newPasswordConfirm" type="password" />
      </t-form-item>
    </t-form>
  </t-dialog>

  <div class="settingBtn">
    <t-dropdown :options="langOptions" trigger="click" @click="handleChangeLang" :maxColumnWidth="150">
      <t-button shape="circle" theme="default" size="large">
        <template #icon>
          <i-translate theme="outline" size="20" />
        </template>
      </t-button>
    </t-dropdown>
    <t-button shape="circle" theme="primary" size="large" @click="showSettingModal = true">
      <template #icon>
        <i-setting-two theme="outline" size="20" />
      </template>
    </t-button>
  </div>
</template>

<script setup>
import { useI18n } from "vue-i18n";
import Router from "@/router/index.ts";
import logo from "@/assets/logo.png";
import axios from "@/utils/axios";
import settingStore from "@/stores/setting";
import userStore from "@/stores/user";
import { clearSession } from "@/utils/session";
import { storeToRefs } from "pinia";
import { languageList, cachedLocale } from "@/locales";

const { locale } = useI18n();
const langOptions = languageList.map((item) => ({
  content: item.label,
  value: item.value,
}));
const handleChangeLang = (data) => {
  locale.value = data.value;
  cachedLocale.value = data.value;
};

const store = settingStore();
const user = userStore();
const { baseUrl, isElectron } = storeToRefs(store);

const showSettingModal = ref(false);
const tempBaseUrl = ref(baseUrl.value);

// 保存设置
const handleSaveSetting = () => {
  baseUrl.value = tempBaseUrl.value;
  showSettingModal.value = false;
  window.$message.success($t("login.settingsSaved"));
};
const state = ref({
  show: true,
  loginLoading: false,
  user: {
    username: "",
    password: "",
  },
  rules: {
    username: [{ required: true, message: $t("login.usernameRequired") }],
    password: [{ required: true, message: $t("login.passwordRequired") }],
  },
});

/**
 * 错误文案（Phase 1c Task 11）：
 * **按 `code` 映射**成用户可读文案 —— 不渲染后端原始 message（那里面可能有表名/约束名/路径）。
 * `e.message` 已经是 `@/utils/apiError` 归一化过的安全文案，这里只把几个"我们确切知道是什么错"
 * 的 code 换成更精确的措辞（仍然不是后端原文）。
 */
const apiMessage = (e, overrides = {}) => {
  const code = Number(e?.code ?? 0);
  const map = {
    400: $t("common.apiError.badRequest"),
    401: $t("login.badCredentials"),
    403: $t("login.registerNotAllowed"),
    409: $t("login.usernameTaken"),
    429: $t("common.apiError.tooManyRequests"),
  };
  return overrides[code] || map[code] || e?.message || $t("common.apiError.unknown");
};

/** 登录成功后的跳转（改密流程也会走到这里）。 */
const enterWorkspace = () => {
  Router.push("/project");
  window.$message.success($t("login.loginSuccess"));
};

/** 已登录但后端要求先改密（`mustChangePassword`）⇒ 打开强制改密弹窗，**不进工作台**。 */
const handleLoginSuccess = (data) => {
  if (data?.mustChangePassword) {
    changeForm.value = { oldPassword: "", newPassword: "", newPasswordConfirm: "" };
    showChangePasswordModal.value = true;
    return;
  }
  enterWorkspace();
};

const handleLogin = () => {
  if (!state.value.user.username || !state.value.user.password) {
    window.$message.warning($t("login.enterUsernameAndPassword"));
    return;
  }
  state.value.loginLoading = true;
  const obj = { ...state.value.user };
  axios
    .post("/auth/login", obj)
    .then(({ data }) => {
      // ⚠ access token **只进内存 store**（`user.setSession`），**不写** localStorage/sessionStorage。
      user.setSession(data);
      state.value.loginLoading = false;
      handleLoginSuccess(data);
    })
    .catch((e) => {
      state.value.loginLoading = false;
      window.$message.error(apiMessage(e));
    });
};

// ── 注册（Phase 1c Task 11）──
const showRegisterModal = ref(false);
const registerLoading = ref(false);
const register = ref({ username: "", password: "", passwordConfirm: "", inviteCode: "" });

const openRegister = () => {
  register.value = { username: "", password: "", passwordConfirm: "", inviteCode: "" };
  showRegisterModal.value = true;
};

const handleRegister = () => {
  const { username, password, passwordConfirm, inviteCode } = register.value;
  if (!username || !password) {
    window.$message.warning($t("login.enterUsernameAndPassword"));
    return;
  }
  if (password !== passwordConfirm) {
    window.$message.warning($t("login.passwordMismatch"));
    return;
  }
  if (String(password).length < 8) {
    window.$message.warning($t("login.passwordRule"));
    return;
  }
  registerLoading.value = true;
  axios
    .post("/auth/register", { username, password, ...(inviteCode ? { inviteCode } : {}) })
    .then(() => {
      // 注册成功后**自动登录**（少一步操作；口令就是刚填的那一个）
      return axios.post("/auth/login", { username, password });
    })
    .then(({ data }) => {
      showRegisterModal.value = false;
      registerLoading.value = false;
      user.setSession(data);
      window.$message.success($t("login.registerSuccess"));
      handleLoginSuccess(data);
    })
    .catch((e) => {
      registerLoading.value = false;
      window.$message.error(apiMessage(e));
    });
};

// ── 强制改密（spec §7.1：首次登录必须改密，不能只提示）──
const showChangePasswordModal = ref(false);
const changeLoading = ref(false);
const changeForm = ref({ oldPassword: "", newPassword: "", newPasswordConfirm: "" });

const handleChangePassword = () => {
  const { oldPassword, newPassword, newPasswordConfirm } = changeForm.value;
  if (!oldPassword || !newPassword) {
    window.$message.warning($t("login.enterUsernameAndPassword"));
    return;
  }
  if (newPassword !== newPasswordConfirm) {
    window.$message.warning($t("login.passwordMismatch"));
    return;
  }
  if (String(newPassword).length < 8) {
    window.$message.warning($t("login.passwordRule"));
    return;
  }
  changeLoading.value = true;
  axios
    .post("/auth/changePassword", { oldPassword, newPassword })
    .then(() => {
      changeLoading.value = false;
      showChangePasswordModal.value = false;
      // ⚠ 改密会让 `tokenVersion++`：**本设备这条 access 也立刻失效**（后端顺手清了 refresh Cookie）
      //   ⇒ 必须回登录页重新登录，不能直接进工作台（否则第一屏就是一片 401）。
      clearSession();
      window.$message.success($t("login.changePasswordSuccess"));
    })
    .catch((e) => {
      changeLoading.value = false;
      window.$message.error(apiMessage(e, { 400: $t("login.oldPasswordWrong") }));
    });
};
</script>

<style lang="scss" scoped>
.loginPage {
  height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;

  .formBox {
    width: 380px;
    padding: 40px 40px 30px;
    background: var(--td-bg-color-container);
    border-radius: 20px;
    box-shadow: var(--td-shadow-3);

    .logoBox {
      display: flex;
      justify-content: center;
      align-items: center;
      margin-bottom: 30px;
      gap: 12px;

      .logoImg {
        width: 64px;
        height: 64px;
        background-color: var(--td-text-color-primary);
        mask: url("@/assets/logo.svg") no-repeat center;
        mask-size: contain;
        -webkit-mask: url("@/assets/logo.svg") no-repeat center;
        -webkit-mask-size: contain;
      }

      .logoText {
        font-size: 36px;
        font-weight: 800;
        color: var(--td-text-color-primary);
        letter-spacing: 1px;
      }
      .slogan {
        opacity: 0.5;
        white-space: nowrap;
      }
    }

    .login-form {
      display: flex;
      flex-direction: column;
      gap: 20px;

      .input-icon {
        color: var(--td-text-color-placeholder);
        font-size: 18px;
      }

      :deep(.t-input) {
        border-radius: 8px;
      }
    }
  }
  .tips {
    opacity: 0.5;
    font-size: 12px;
    margin-top: 18px;
  }
}

.default-hint {
  margin-top: 20px;
  border-radius: 8px;

  :deep(.t-alert__message) {
    width: 100%;
  }

  .hint-content {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
    color: #666;

    p {
      margin: 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
  }

  code {
    background: var(--td-bg-color-container);
    padding: 2px 10px;
    border-radius: 4px;
    font-family: "Monaco", "Menlo", monospace;
    font-weight: 500;
    font-size: 13px;
    border: 1px solid var(--td-component-border);
  }
}

.settingBtn {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
