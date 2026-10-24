import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canAccessAdminUsers,
  normalizeUserSearch,
  validateGroupIds,
  buildUserRechargeAttempt,
  createRechargeIdempotencyKey,
  refreshSelectedUser,
} from "../src/views/admin/users/userManagement.ts";

test("admin user management is role-gated in the helper and router", async () => {
  assert.equal(canAccessAdminUsers("admin"), true);
  assert.equal(canAccessAdminUsers("user"), false);
  const router = await readFile(new URL("../src/router/index.ts", import.meta.url), "utf8");
  assert.match(router, /path: "\/admin\/users"[\s\S]*?adminOnly: true/);
  assert.match(router, /to\.meta\.adminOnly[\s\S]*?role !== "admin"[\s\S]*?\/workbench/);
});

test("user search trims whitespace and normalizes blank values", () => {
  assert.equal(normalizeUserSearch("  alpha  "), "alpha");
  assert.equal(normalizeUserSearch("  "), "");
});

test("group replacement requires distinct positive safe integer IDs", () => {
  assert.deepEqual(validateGroupIds([1, 3]), [1, 3]);
  assert.throws(() => validateGroupIds([1, 1]), /duplicate/);
  assert.throws(() => validateGroupIds([0]), /positive/);
});

test("recharge attempt is bound to the selected user and all changed form fields", () => {
  const makeKey = (value) => () => value;
  const firstInput = { userId: 12, amount: "12.50", note: "renewal" };
  const first = buildUserRechargeAttempt(firstInput, null, makeKey("key-1"));
  assert.equal(first.idempotencyKey, "key-1");
  assert.equal(buildUserRechargeAttempt(firstInput, first, makeKey("key-2")).idempotencyKey, "key-1");
  assert.equal(buildUserRechargeAttempt({ ...firstInput, userId: 13 }, first, makeKey("key-2")).idempotencyKey, "key-2");
  assert.equal(buildUserRechargeAttempt({ ...firstInput, note: "correction" }, first, makeKey("key-3")).idempotencyKey, "key-3");
});

test("recharge idempotency keys use randomUUID or a cryptographic UUID fallback", () => {
  assert.equal(createRechargeIdempotencyKey({ randomUUID: () => "native-uuid" }), "native-uuid");
  const fallbackCrypto = {
    getRandomValues(bytes) {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    },
  };
  assert.equal(createRechargeIdempotencyKey(fallbackCrypto), "00010203-0405-4607-8809-0a0b0c0d0e0f");
});

test("refreshed user rows replace the selected detail object", () => {
  const selected = { id: 12, balanceMicro: "1000000" };
  const refreshed = { id: 12, balanceMicro: "2500000" };
  assert.equal(refreshSelectedUser(selected, [refreshed]), refreshed);
  assert.equal(refreshSelectedUser(selected, [{ id: 13, balanceMicro: "0" }]), selected);
  assert.equal(refreshSelectedUser(null, [refreshed]), null);
});

test("billing page has no administrative billing forms", async () => {
  const page = await readFile(new URL("../src/views/billing/index.vue", import.meta.url), "utf8");
  assert.doesNotMatch(page, /billing\.admin|adminSection|createGrant|createPrice|createRecharge/);
  assert.match(page, /billing\.ledger/);
  assert.match(page, /billing\.usage/);
  assert.match(page, /billing\.orders/);
});

test("model configuration owns model groups and price history", async () => {
  const page = await readFile(new URL("../src/components/setting/components/vendorConfig.vue", import.meta.url), "utf8");
  const management = await readFile(new URL("../src/components/setting/components/vendorConfig/ModelAccessPricing.vue", import.meta.url), "utf8");
  assert.match(page, /ModelAccessPricing/);
  assert.match(management, /\/billing\/admin\/prices/);
  assert.match(management, /\/billing\/admin\/groups/);
  const saveGroups = management.match(/async function saveGroups\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(saveGroups, /getModelGroupError\(cause\)/);
});

test("API body envelope yields the payload already returned by the axios interceptor", async () => {
  const { apiPayload } = await import("../src/utils/apiResponse.ts");
  const body = {
    code: 200,
    data: { items: [{ id: 71, username: "18652066711" }], total: 1 },
    message: "用户列表已读取",
  };

  assert.deepEqual(apiPayload(body), { items: [{ id: 71, username: "18652066711" }], total: 1 });
});
