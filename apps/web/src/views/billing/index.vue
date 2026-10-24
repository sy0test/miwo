<template>
  <main class="billingPage">
    <header class="pageHeader">
      <div>
        <h1>{{ $t("billing.title") }}</h1>
        <p>{{ $t("billing.description") }}</p>
      </div>
      <t-button variant="outline" :loading="loading" @click="loadBilling">{{ $t("billing.refresh") }}</t-button>
    </header>

    <t-alert v-if="loadError || billingAccount.error" theme="error" :message="loadError || billingAccount.error" close @close="loadError = ''; billingAccount.error = ''" />
    <t-loading :loading="loading" size="small">
      <template v-if="!loadError && accountState === 'empty'">
        <t-empty :description="$t('billing.accountUnavailable')" />
      </template>
      <template v-else-if="accountState === 'ready'">
        <t-alert v-if="insufficientBalance" theme="warning" :message="$t('billing.insufficientBalance')" />
        <section class="balanceSection" :aria-label="$t('billing.accountBalances')">
          <div class="balanceItem">
            <span>{{ $t("billing.availableBalance") }}</span>
            <strong>{{ money(availableMicro) }} {{ $t("billing.cny") }}</strong>
          </div>
          <div class="balanceItem">
            <span>{{ $t("billing.frozenBalance") }}</span>
            <strong>{{ money(account!.frozenMicro) }} {{ $t("billing.cny") }}</strong>
          </div>
        </section>

        <section class="dataSection">
          <h2>{{ $t("billing.ledger") }}</h2>
          <t-table :data="ledger" :columns="ledgerColumns" row-key="id" size="small" :pagination="ledgerPagination" @page-change="onLedgerPageChange">
            <template #createdAt="{ row }">{{ dateTime(row.createdAt) }}</template>
            <template #type="{ row }">{{ ledgerType(row.type) }}</template>
            <template #amountMicro="{ row }">{{ money(row.amountMicro) }} {{ $t("billing.cny") }}</template>
            <template #balanceAfter="{ row }">{{ money(row.balanceAfter) }} {{ $t("billing.cny") }}</template>
            <template #frozenAfterMicro="{ row }">{{ money(row.frozenAfterMicro) }} {{ $t("billing.cny") }}</template>
          </t-table>
          <t-empty v-if="!loading && !loadError && !billingAccount.error && ledger.length === 0" :description="$t('billing.noLedger')" />
        </section>

        <section class="dataSection">
          <h2>{{ $t("billing.usage") }}</h2>
          <t-table :data="usageSummary" :columns="usageColumns" row-key="model" size="small">
            <template #costMicro="{ row }">{{ money(row.costMicro) }} {{ $t("billing.cny") }}</template>
          </t-table>
          <t-empty v-if="!loading && !loadError && !billingAccount.error && usageSummary.length === 0" :description="$t('billing.noUsage')" />
        </section>

        <section class="dataSection">
          <h2>{{ $t("billing.orders") }}</h2>
          <t-table :data="orders" :columns="orderColumns" row-key="id" size="small">
            <template #createdAt="{ row }">{{ dateTime(row.createdAt) }}</template>
            <template #paidAt="{ row }">{{ row.paidAt ? dateTime(row.paidAt) : "-" }}</template>
            <template #amountMicro="{ row }">{{ money(row.amountMicro) }} {{ $t("billing.cny") }}</template>
            <template #status="{ row }"><t-tag :theme="row.status === 'paid' ? 'success' : row.status === 'pending' ? 'warning' : 'default'">{{ orderStatus(row.status) }}</t-tag></template>
            <template #channel="{ row }">{{ orderChannel(row.channel) }}</template>
          </t-table>
          <t-empty v-if="!loading && !loadError && !billingAccount.error && orders.length === 0" :description="$t('billing.noOrders')" />
        </section>
      </template>
    </t-loading>

  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import axios from "@/utils/axios";
import billingStore from "@/stores/billing";
import {
  formatMicroToCny,
  getAccountViewState,
  getAvailableBalanceMicro,
  hasInsufficientBalance,
  groupUsageByProviderModel,
  sortLedgerEntries,
} from "./billingData";

type LedgerRow = { id: string | number; createdAt: string | number; amountMicro: string | number; balanceAfter: string | number; frozenAfterMicro: string | number; type: string; refType: string | null; refId: string | null };
type UsageRow = { vendorId: string; model: string; costMicro: string | number };
type OrderRow = { id: string | number; userId: number; amountMicro: string | number; status: string; channel: string; paidAt?: string | number | null; operatorNote?: string; confirmTradeId?: string };

const billingAccount = billingStore();
const account = computed(() => billingAccount.account);
const loading = ref(false);
const loadError = ref("");
const ledger = ref<LedgerRow[]>([]);
const usageRows = ref<UsageRow[]>([]);
const orders = ref<OrderRow[]>([]);
const ledgerOffset = ref(0);
const ledgerPagination = computed(() => ({ current: Math.floor(ledgerOffset.value / 50) + 1, pageSize: 50, total: ledgerOffset.value + ledger.value.length }));

const accountState = computed(() => getAccountViewState({ loading: billingAccount.loading, account: account.value, error: billingAccount.error }));
const availableMicro = computed(() => account.value ? getAvailableBalanceMicro(account.value) : "0");
const usageSummary = computed(() => groupUsageByProviderModel(usageRows.value));
const insufficientBalance = computed(() => account.value ? hasInsufficientBalance(account.value) : false);
const ledgerColumns = [
  { colKey: "createdAt", title: window.$t("billing.columns.createdAt"), width: 170 },
  { colKey: "type", title: window.$t("billing.columns.ledgerType"), width: 120 },
  { colKey: "amountMicro", title: window.$t("billing.columns.amount"), cell: "amountMicro", width: 170 },
  { colKey: "balanceAfter", title: window.$t("billing.columns.balanceAfter"), cell: "balanceAfter", width: 170 },
  { colKey: "frozenAfterMicro", title: window.$t("billing.columns.frozenAfter"), cell: "frozenAfterMicro", width: 170 },
  { colKey: "refType", title: window.$t("billing.columns.referenceType"), width: 130 },
  { colKey: "refId", title: window.$t("billing.columns.referenceId"), ellipsis: true },
];
const usageColumns = [
  { colKey: "vendorId", title: window.$t("billing.columns.provider"), width: 180 },
  { colKey: "model", title: window.$t("billing.columns.model"), ellipsis: true },
  { colKey: "calls", title: window.$t("billing.columns.calls"), width: 100 },
  { colKey: "costMicro", title: window.$t("billing.columns.cost"), cell: "costMicro", width: 180 },
];
const orderColumns = [
  { colKey: "id", title: window.$t("billing.columns.orderId"), width: 100 },
  { colKey: "channel", title: window.$t("billing.columns.channel"), width: 150 },
  { colKey: "amountMicro", title: window.$t("billing.columns.amount"), cell: "amountMicro", width: 180 },
  { colKey: "status", title: window.$t("billing.columns.status"), cell: "status", width: 120 },
  { colKey: "createdAt", title: window.$t("billing.columns.createdAt"), width: 180 },
  { colKey: "paidAt", title: window.$t("billing.columns.paidAt"), width: 180 },
];

function money(value: string | number | bigint): string {
  return formatMicroToCny(value);
}

function unwrap<T>(response: any): T {
  return response?.data as T;
}

async function loadBilling() {
  loading.value = true;
  loadError.value = "";
  try {
    const [, ledgerResponse, usageResponse, orderResponse] = await Promise.all([
      billingAccount.refreshAccount(),
      axios.get("/billing/ledger", { params: { limit: 50, offset: ledgerOffset.value } }),
      axios.get("/billing/usage", { params: { limit: 200, offset: 0 } }),
      axios.get("/billing/orders", { params: { limit: 50, offset: 0 } }),
    ]);
    ledger.value = sortLedgerEntries(unwrap<LedgerRow[]>(ledgerResponse) ?? []);
    usageRows.value = unwrap<UsageRow[]>(usageResponse) ?? [];
    orders.value = unwrap<OrderRow[]>(orderResponse) ?? [];
  } catch (error: any) {
    loadError.value = error?.message || window.$t("billing.loadFailed");
  } finally {
    loading.value = false;
  }
}

function onLedgerPageChange(page: { current: number; pageSize: number }) {
  ledgerOffset.value = (page.current - 1) * page.pageSize;
  loadBilling();
}

function ledgerType(value: string): string {
  const labels: Record<string, string> = {
    freeze: window.$t("billing.ledgerTypes.freeze"),
    recharge: window.$t("billing.ledgerTypes.recharge"),
    consume: window.$t("billing.ledgerTypes.consume"),
    release: window.$t("billing.ledgerTypes.release"),
    debt_adjustment: window.$t("billing.ledgerTypes.adjustment"),
  };
  return labels[value] ?? window.$t("billing.ledgerTypes.other");
}

function orderStatus(value: string): string {
  const labels: Record<string, string> = {
    paid: window.$t("billing.status.paid"),
    pending: window.$t("billing.status.pending"),
    failed: window.$t("billing.status.failed"),
    canceled: window.$t("billing.status.canceled"),
  };
  return labels[value] ?? window.$t("billing.status.other");
}

function orderChannel(value: string): string {
  return value === "manual_admin" ? window.$t("billing.channels.admin") : window.$t("billing.channels.other");
}

function dateTime(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN");
}

onMounted(loadBilling);
</script>

<style lang="scss" scoped>
.billingPage { width: 100%; min-height: 100%; padding: 16px 0 32px; color: var(--td-text-color-primary); }
.pageHeader { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.pageHeader h1 { margin: 0; font-size: 22px; font-weight: 600; }
.pageHeader p { margin: 4px 0 0; color: var(--td-text-color-secondary); }
.balanceSection { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid var(--td-border-level-1-color); margin: 12px 0 20px; }
.balanceItem { padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; }
.balanceItem + .balanceItem { border-left: 1px solid var(--td-border-level-1-color); }
.balanceItem span { color: var(--td-text-color-secondary); font-size: 13px; }
.balanceItem strong { font-size: 21px; font-variant-numeric: tabular-nums; }
.dataSection { margin-top: 22px; }
.dataSection h2 { margin: 0 0 10px; font-size: 16px; font-weight: 600; }
.pendingOrder { display: flex; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--td-border-level-1-color); }
.pendingOrder > div { display: flex; flex-direction: column; gap: 4px; }
.pendingOrder small { color: var(--td-text-color-secondary); }
@media (max-width: 700px) {
  .balanceSection { grid-template-columns: 1fr; }
  .balanceItem + .balanceItem { border-left: 0; border-top: 1px solid var(--td-border-level-1-color); }
  .pendingOrder { flex-direction: column; }
}
</style>
