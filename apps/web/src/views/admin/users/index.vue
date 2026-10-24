<template>
  <main class="adminUsers">
    <header class="pageHeader">
      <div><h1>用户管理</h1><p>账号、分组与账户调整</p></div>
      <t-button variant="outline" :loading="loading" @click="loadUsers"><template #icon><t-icon name="refresh" /></template>刷新</t-button>
    </header>
    <t-tabs v-model:value="activeTab">
      <t-tab-panel value="users" label="用户">
        <div class="toolbar">
          <t-input v-model="searchInput" clearable placeholder="用户名或用户 ID" @enter="searchUsers" @clear="searchUsers" />
          <t-button theme="primary" @click="searchUsers">查询</t-button>
        </div>
        <t-alert v-if="error" theme="error" :message="error" close @close="error = ''" />
        <t-loading :loading="loading" size="small">
          <t-table :data="users" :columns="columns" row-key="id" size="small" :pagination="pagination" @page-change="onPageChange">
            <template #balanceMicro="{ row }">{{ formatMicroToCny(row.balanceMicro) }} 元</template>
            <template #groups="{ row }"><span>{{ row.groupNames.join("、") || "未分组" }}</span></template>
            <template #operation="{ row }"><t-button variant="text" theme="primary" @click="openUser(row)">管理</t-button></template>
          </t-table>
          <t-empty v-if="!loading && !error && users.length === 0" description="没有匹配的用户" />
        </t-loading>
      </t-tab-panel>
      <t-tab-panel value="groups" label="用户组"><user-groups /></t-tab-panel>
    </t-tabs>

    <t-dialog v-model:visible="detailVisible" :header="selectedUser ? `用户 ${selectedUser.username}（#${selectedUser.id}）` : '用户详情'" width="min(720px, 92vw)" :footer="false">
      <t-loading :loading="detailLoading">
        <template v-if="selectedUser">
          <dl class="summary">
            <div><dt>角色</dt><dd>{{ selectedUser.role }}</dd></div>
            <div><dt>状态</dt><dd>{{ selectedUser.status }}</dd></div>
            <div><dt>账户余额</dt><dd>{{ formatMicroToCny(selectedUser.balanceMicro) }} 元</dd></div>
            <div><dt>冻结金额</dt><dd>{{ formatMicroToCny(selectedUser.frozenMicro) }} 元</dd></div>
          </dl>
          <t-form label-align="top" @submit="saveMembership">
            <t-form-item label="用户组">
              <t-select v-model="selectedGroupIds" multiple clearable :options="groupOptions" placeholder="选择用户组" />
            </t-form-item>
            <t-button theme="primary" :loading="detailBusy" @click="saveMembership">保存分组</t-button>
          </t-form>
          <t-divider />
          <h2>管理员充值</h2>
          <div class="rechargeForm">
            <label>充值金额（元）<t-input v-model="rechargeForm.amount" type="number" min="0.01" step="0.01" /></label>
            <label>原因<t-textarea v-model="rechargeForm.note" maxlength="500" /></label>
            <t-button theme="primary" :loading="detailBusy" @click="openRechargeConfirm">确认充值</t-button>
          </div>
          <t-alert v-if="detailMessage" :theme="detailError ? 'error' : 'success'" :message="detailMessage" />
        </template>
      </t-loading>
    </t-dialog>
    <t-dialog v-model:visible="rechargeConfirmVisible" header="确认管理员充值" :confirm-btn="'确认充值'" :loading="detailBusy" @confirm="submitRecharge">
      <template v-if="selectedUser">
        <p>将向 {{ selectedUser.username }}（#{{ selectedUser.id }}）充值 {{ rechargeForm.amount }} 元。</p>
        <p>原因：{{ rechargeForm.note }}</p>
      </template>
    </t-dialog>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import axios from "@/utils/axios";
import { apiPayload } from "@/utils/apiResponse";
import userStore from "@/stores/user";
import { formatMicroToCny, parseCnyToMicro, type RechargeAttempt } from "@/views/billing/billingData";
import { buildUserRechargeAttempt, canAccessAdminUsers, createRechargeIdempotencyKey, normalizeUserSearch, refreshSelectedUser, validateGroupIds } from "./userManagement";
import userGroups from "./userGroups.vue";

const role = userStore().role;
if (!canAccessAdminUsers(role)) throw new Error("管理员权限不足");
type UserRow = { id: number; username: string; role: string; status: string; balanceMicro: string; frozenMicro: string; groupIds: number[]; groupNames: string[] };
type Group = { id: number; name: string };
const activeTab = ref("users");
const loading = ref(false);
const error = ref("");
const users = ref<UserRow[]>([]);
const groups = ref<Group[]>([]);
const searchInput = ref("");
const search = ref("");
const offset = ref(0);
const total = ref(0);
const pageSize = 50;
const pagination = computed(() => ({ current: Math.floor(offset.value / pageSize) + 1, pageSize, total: total.value }));
const columns = [
  { colKey: "id", title: "用户 ID", width: 90 },
  { colKey: "username", title: "用户名", ellipsis: true },
  { colKey: "role", title: "角色", width: 90 },
  { colKey: "status", title: "状态", width: 90 },
  { colKey: "balanceMicro", title: "余额（元）", cell: "balanceMicro", width: 120 },
  { colKey: "groups", title: "用户组", cell: "groups", ellipsis: true },
  { colKey: "operation", title: "操作", cell: "operation", width: 90, fixed: "right" as const },
];
const detailVisible = ref(false);
const detailLoading = ref(false);
const detailBusy = ref(false);
const selectedUser = ref<UserRow | null>(null);
const selectedGroupIds = ref<number[]>([]);
const groupOptions = computed(() => groups.value.map((group) => ({ label: group.name, value: group.id })));
const detailMessage = ref("");
const detailError = ref(false);
const rechargeConfirmVisible = ref(false);
const rechargeForm = reactive({ amount: "", note: "" });
const rechargeAttempt = ref<RechargeAttempt | null>(null);

async function loadGroups() {
  const data = apiPayload<{ userGroups: Group[] }>(await axios.get("/billing/admin/groups"));
  groups.value = data.userGroups;
}
async function loadUsers() {
  loading.value = true;
  error.value = "";
  try {
    const data = apiPayload<{ items: UserRow[]; total: number }>(await axios.get("/billing/admin/users", { params: { search: search.value, offset: offset.value, limit: pageSize } }));
    users.value = data.items;
    selectedUser.value = refreshSelectedUser(selectedUser.value, users.value);
    total.value = data.total;
  } catch (cause: any) {
    error.value = cause?.message || "用户列表加载失败";
  } finally { loading.value = false; }
}
function searchUsers() {
  search.value = normalizeUserSearch(searchInput.value);
  offset.value = 0;
  loadUsers();
}
function onPageChange(page: { current: number; pageSize: number }) {
  offset.value = (page.current - 1) * page.pageSize;
  loadUsers();
}
async function openUser(user: UserRow) {
  selectedUser.value = user;
  selectedGroupIds.value = [...user.groupIds];
  rechargeForm.amount = "";
  rechargeForm.note = "";
  detailMessage.value = "";
  rechargeAttempt.value = null;
  detailVisible.value = true;
  detailLoading.value = true;
  try { await loadGroups(); }
  catch (cause: any) { detailMessage.value = cause?.message || "用户组加载失败"; detailError.value = true; }
  finally { detailLoading.value = false; }
}
async function saveMembership() {
  if (!selectedUser.value || detailBusy.value) return;
  detailBusy.value = true;
  detailMessage.value = "";
  try {
    const groupIds = validateGroupIds(selectedGroupIds.value.map(Number));
    await axios.put(`/billing/admin/users/${selectedUser.value.id}/groups`, { groupIds });
    detailMessage.value = "用户组已更新";
    detailError.value = false;
    await loadUsers();
    selectedUser.value.groupIds = groupIds;
    selectedUser.value.groupNames = groups.value.filter((group) => groupIds.includes(group.id)).map((group) => group.name);
  } catch (cause: any) {
    detailMessage.value = cause?.message || "保存用户组失败";
    detailError.value = true;
  } finally { detailBusy.value = false; }
}
function openRechargeConfirm() {
  detailMessage.value = "";
  try {
    if (!selectedUser.value) throw new Error("请选择充值用户");
    if (BigInt(parseCnyToMicro(rechargeForm.amount)) <= 0n) throw new Error("充值金额必须大于零");
    if (!rechargeForm.note.trim()) throw new Error("请填写充值原因");
    rechargeConfirmVisible.value = true;
  } catch (cause: any) {
    detailMessage.value = cause?.message || "充值信息无效";
    detailError.value = true;
  }
}
async function submitRecharge() {
  const user = selectedUser.value;
  if (!user || detailBusy.value) return;
  detailBusy.value = true;
  try {
    const input = { userId: user.id, amount: String(rechargeForm.amount).trim(), note: rechargeForm.note.trim() };
    const attempt = buildUserRechargeAttempt(input, rechargeAttempt.value, createRechargeIdempotencyKey);
    rechargeAttempt.value = attempt;
    const data = apiPayload<{ balanceMicro?: string }>(await axios.post("/billing/admin/recharges", { ...input, idempotencyKey: attempt.idempotencyKey }));
    user.balanceMicro = String(data.balanceMicro ?? user.balanceMicro);
    rechargeAttempt.value = null;
    rechargeConfirmVisible.value = false;
    detailMessage.value = "充值成功";
    detailError.value = false;
    await loadUsers();
  } catch (cause: any) {
    detailMessage.value = cause?.message || "充值失败";
    detailError.value = true;
  } finally { detailBusy.value = false; }
}
onMounted(async () => { await loadGroups(); await loadUsers(); });
</script>

<style scoped>
.adminUsers { min-height: 100%; padding: 16px 0 32px; color: var(--td-text-color-primary); }
.pageHeader { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.pageHeader h1 { margin: 0; font-size: 22px; font-weight: 600; }
.pageHeader p { margin: 4px 0 0; color: var(--td-text-color-secondary); }
.toolbar { display: flex; gap: 8px; max-width: 520px; margin: 14px 0; }
.summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0 0 18px; }
.summary div { border-bottom: 1px solid var(--td-border-level-1-color); padding: 8px 0; }
.summary dt { color: var(--td-text-color-secondary); font-size: 12px; }
.summary dd { margin: 5px 0 0; font-variant-numeric: tabular-nums; }
h2 { font-size: 16px; margin: 0 0 12px; }
.rechargeForm { display: grid; grid-template-columns: 1fr 2fr auto; align-items: end; gap: 12px; margin-bottom: 12px; }
.rechargeForm label { display: grid; gap: 6px; color: var(--td-text-color-secondary); font-size: 12px; }
@media (max-width: 700px) { .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } .rechargeForm { grid-template-columns: 1fr; } }
</style>
