import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getVisibleSettingsItems } from "../src/components/setting/settingsMenu.ts";

const standardItems = [
  { key: "ui", label: "界面设置", icon: "theme" },
  { key: "billing", label: "计费账户", icon: "finance" },
  { key: "language", label: "语言设置", icon: "translate" },
  { key: "loginConfig", label: "登录配置", icon: "lock" },
  { key: "logoutConfig", label: "退出登录", icon: "logout" },
];

const allItems = [
  ...standardItems.slice(0, 3),
  { key: "vendorConfig", label: "服务商配置", icon: "computer" },
  { key: "dbConfig", label: "数据库操作", icon: "data" },
  { key: "about", label: "关于", icon: "info" },
  ...standardItems.slice(3),
];

test("ordinary users see exactly the five prescribed settings in input order", () => {
  assert.deepEqual(getVisibleSettingsItems("user", allItems), standardItems);
});

test("admins retain advanced settings except database operations", () => {
  assert.deepEqual(
    getVisibleSettingsItems("admin", allItems).map((item) => item.key),
    ["ui", "billing", "language", "vendorConfig", "about", "loginConfig", "logoutConfig"],
  );
});

test("unknown roles receive the ordinary-user settings only", () => {
  assert.deepEqual(getVisibleSettingsItems("superuser", allItems), standardItems);
});

test("workbench exposes the shared available balance as a billing shortcut", async () => {
  const workbench = await readFile(new URL("../src/pages/workbench/index.vue", import.meta.url), "utf8");
  assert.match(workbench, /class="balanceLink"/);
  assert.match(workbench, /billingAccount\.refreshAccount\(\)/);
  assert.match(workbench, /getAvailableBalanceMicro\(billingAccount\.account\)/);
  assert.match(workbench, /router\.push\("\/billing"\)/);
});

test("workbench and setting store do not retain update polling state or actions", async () => {
  const workbench = await readFile(new URL("../src/pages/workbench/index.vue", import.meta.url), "utf8");
  const store = await readFile(new URL("../src/stores/setting.ts", import.meta.url), "utf8");
  assert.doesNotMatch(workbench, /checkUpdate|setInterval|openFeedback|jumpGithub|needUpdate/);
  assert.doesNotMatch(store, /needUpdate/);
});
