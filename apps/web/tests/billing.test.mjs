import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canManageBilling,
  formatMicroToCny,
  formatPriceMicroToCny,
  hasInsufficientBalance,
  parseCnyToMicro,
  getAccountViewState,
  groupUsageByProviderModel,
  getPendingManualOrders,
  sortLedgerEntries,
  getAvailableBalanceMicro,
  loadBillingAccount,
  getRechargeAttempt,
  getModelGroupError,
} from "../src/views/billing/billingData.ts";

test("formats signed and very large micro-CNY values to two decimals without floating point", () => {
  assert.equal(formatMicroToCny("1234567890123456789012345"), "1234567890123456789.01");
  assert.equal(formatMicroToCny("1"), "0.00");
  assert.equal(formatMicroToCny("4999"), "0.00");
  assert.equal(formatMicroToCny("5000"), "0.01");
  assert.equal(formatMicroToCny("-5000"), "-0.01");
  assert.equal(formatMicroToCny("-4999"), "0.00");
  assert.equal(formatMicroToCny("999999"), "1.00");
  assert.throws(() => formatMicroToCny(Number.MAX_SAFE_INTEGER + 1), /safe integer/);
});

test("formats price rates without rounding away micro-CNY values", () => {
  assert.equal(formatPriceMicroToCny("10"), "0.00001");
  assert.equal(formatPriceMicroToCny("1000"), "0.001");
  assert.equal(formatPriceMicroToCny("1000000"), "1.00");
  assert.equal(formatPriceMicroToCny("0"), "0.00");
  assert.throws(() => formatPriceMicroToCny("-1"), /must not be negative/);
});

test("parses decimal CNY into exact micro-CNY and rejects excessive precision", () => {
  assert.equal(parseCnyToMicro("9007199254.740993"), "9007199254740993");
  assert.equal(parseCnyToMicro(99999), "99999000000");
  assert.throws(() => parseCnyToMicro("0.0000001"));
});

test("model-group operations explain known validation failures without exposing unknown raw errors", () => {
  assert.equal(getModelGroupError({ rawMessage: "模型组参数无效", message: "请求参数不合法" }), "模型组参数格式不正确，请检查模型组名称和所选模型。");
  assert.equal(getModelGroupError({ rawMessage: "模型组只能包含已配置的模型", message: "请求参数不合法" }), "所选模型未在服务商配置中找到，请刷新配置后重试。");
  assert.equal(getModelGroupError({ rawMessage: "内部 SQL error", message: "请求参数不合法" }), "请求参数不合法");
});

test("detects insufficient available balance using exact integer arithmetic", () => {
  assert.equal(hasInsufficientBalance({ balanceMicro: "1200000", frozenMicro: "1200000" }), true);
  assert.equal(hasInsufficientBalance({ balanceMicro: "1200000", frozenMicro: "200000" }), false);
});

test("sorts ledger entries newest-first with id as a deterministic tie-breaker", () => {
  const rows = [
    { id: 3, createdAt: 20 },
    { id: 8, createdAt: 30 },
    { id: 2, createdAt: 30 },
  ];
  assert.deepEqual(sortLedgerEntries(rows).map((row) => row.id), [8, 2, 3]);
});

test("groups usage by provider and model while retaining exact cost strings", () => {
  const rows = [
    { vendorId: "v1", model: "m1", costMicro: "9007199254740993" },
    { vendorId: "v1", model: "m1", costMicro: "7" },
    { vendorId: "v2", model: "m1", costMicro: "11" },
  ];
  assert.deepEqual(groupUsageByProviderModel(rows), [
    { vendorId: "v1", model: "m1", calls: 2, costMicro: "9007199254741000" },
    { vendorId: "v2", model: "m1", calls: 1, costMicro: "11" },
  ]);
  assert.throws(() => groupUsageByProviderModel([{ vendorId: "v1", model: "m1", costMicro: Number.MAX_SAFE_INTEGER + 1 }]), /safe integer/);
});

test("account display state distinguishes loading, error, empty, and ready", () => {
  assert.equal(getAccountViewState({ loading: true, account: null, error: "" }), "loading");
  assert.equal(getAccountViewState({ loading: false, account: null, error: "offline" }), "error");
  assert.equal(getAccountViewState({ loading: false, account: null, error: "" }), "empty");
  assert.equal(getAccountViewState({ loading: false, account: { balanceMicro: "0" }, error: "" }), "ready");
});

test("pending manual recharge orders exclude confirmed orders and other channels", () => {
  const orders = [
    { id: 1, channel: "manual_admin", status: "pending" },
    { id: 2, channel: "manual_admin", status: "paid" },
    { id: 3, channel: "provider", status: "pending" },
  ];
  assert.deepEqual(getPendingManualOrders(orders).map((order) => order.id), [1]);
});

test("billing administration controls are visible only to admins", () => {
  assert.equal(canManageBilling("admin"), true);
  assert.equal(canManageBilling("user"), false);
});

test("available balance subtracts frozen micro-CNY exactly", () => {
  assert.equal(getAvailableBalanceMicro({ balanceMicro: "9007199254740995", frozenMicro: "9007199254740993" }), "2");
});

test("billing account loader publishes success, errors, and later refreshes", async () => {
  const state = { account: null, loading: false, error: "" };
  await loadBillingAccount(state, async () => ({ balanceMicro: "5000000", frozenMicro: "1000000" }));
  assert.deepEqual(state, { account: { balanceMicro: "5000000", frozenMicro: "1000000" }, loading: false, error: "" });

  await loadBillingAccount(state, async () => { throw new Error("网络不可用"); });
  assert.equal(state.loading, false);
  assert.equal(state.error, "网络不可用");

  await loadBillingAccount(state, async () => ({ balanceMicro: "9000000", frozenMicro: "0" }));
  assert.deepEqual(state, { account: { balanceMicro: "9000000", frozenMicro: "0" }, loading: false, error: "" });
});

test("billing empty states are hidden when the data request fails", async () => {
  const page = await readFile(new URL("../src/views/billing/index.vue", import.meta.url), "utf8");
  for (const rows of ["ledger", "usageSummary", "orders"]) {
    assert.match(page, new RegExp(`v-if=\\"!loading && !loadError && !billingAccount\\.error && ${rows}\\.length === 0\\"`));
  }
});

test("model pricing exposes a per-call unit and label", async () => {
  const component = await readFile(new URL("../src/components/setting/components/vendorConfig/ModelAccessPricing.vue", import.meta.url), "utf8");
  assert.match(component, /label: "每次调用", value: "call"/);
  assert.match(component, /unitLabel\(row\.unit\)/);
});

test("model pricing exposes distinct 480p and 720p video units", async () => {
  const component = await readFile(new URL("../src/components/setting/components/vendorConfig/ModelAccessPricing.vue", import.meta.url), "utf8");
  assert.match(component, /label: "每秒视频 480p", value: "video_second_480p"/);
  assert.match(component, /label: "每秒视频 720p", value: "video_second_720p"/);
});

test("recharge attempt reuses its idempotency key only for an unchanged form", () => {
  const createKey = () => "uuid-1";
  const first = getRechargeAttempt({ userId: "7", amount: "12.50", note: "测试充值" }, null, createKey);
  assert.equal(first.idempotencyKey, "uuid-1");
  assert.equal(getRechargeAttempt({ userId: "7", amount: "12.50", note: "测试充值" }, first, () => "uuid-2").idempotencyKey, "uuid-1");
  assert.equal(getRechargeAttempt({ userId: "8", amount: "12.50", note: "测试充值" }, first, () => "uuid-2").idempotencyKey, "uuid-2");
});
