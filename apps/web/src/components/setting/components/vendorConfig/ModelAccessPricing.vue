<template>
  <div class="accessPricing">
    <t-button size="small" variant="outline" @click="open"><template #icon><t-icon name="setting" /></template>授权分组与价格</t-button>
    <t-dialog v-model:visible="visible" :header="`${model.name} · 分组与价格`" width="min(760px, 94vw)" :footer="false">
      <t-loading :loading="loading">
        <t-alert v-if="error" theme="error" :message="error" close @close="error = ''" />
        <section class="section">
          <div class="sectionHeader"><h3>模型组授权</h3><t-button size="small" variant="outline" @click="createVisible = true">新建模型组</t-button></div>
          <p class="muted">此模型当前属于选中的模型组；用户组通过关联模型组获得授权。</p>
          <t-select v-model="selectedGroupIds" multiple :options="groupOptions" placeholder="选择模型组" />
          <div class="limitRow">
            <span class="muted">变更分组时会保留各组已有的调用上限。</span>
            <t-button theme="primary" :loading="saving" @click="saveGroups">保存模型组</t-button>
          </div>
        </section>
        <t-divider />
        <section class="section">
          <h3>价格历史（只追加）</h3>
          <t-table :data="prices" :columns="priceColumns" row-key="id" size="small">
            <template #effectiveFrom="{ row }">{{ dateTime(row.effectiveFrom) }}</template>
            <template #unitPriceMicro="{ row }">{{ formatPriceMicroToCny(row.unitPriceMicro) }} 元 / {{ unitLabel(row.unit) }}</template>
          </t-table>
          <t-empty v-if="prices.length === 0" description="暂无价格记录" />
          <div v-if="priceTotal > priceLimit" class="pager">
            <t-button size="small" variant="outline" :disabled="pricePage === 1" @click="changePricePage(-1)">上一页</t-button>
            <span>{{ pricePage }} / {{ Math.ceil(priceTotal / priceLimit) }}</span>
            <t-button size="small" variant="outline" :disabled="pricePage >= Math.ceil(priceTotal / priceLimit)" @click="changePricePage(1)">下一页</t-button>
          </div>
          <div class="priceForm">
            <label>计价单位<t-select v-model="priceForm.unit" :options="unitOptions" /></label>
            <label>单价（元）<t-input v-model="priceForm.price" inputmode="decimal" placeholder="0.000001" /></label>
            <label>生效时间<input v-model="priceForm.effectiveFrom" type="datetime-local" /></label>
            <t-button theme="primary" :loading="saving" @click="appendPrice">追加价格</t-button>
          </div>
        </section>
      </t-loading>
    </t-dialog>
    <t-dialog v-model:visible="createVisible" header="新建模型组" :confirm-btn="'创建并加入'" :loading="saving" @confirm="createGroup">
      <t-form label-align="top"><t-form-item label="模型组名称"><t-input v-model="newGroupName" maxlength="128" /></t-form-item></t-form>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import axios from "@/utils/axios";
import { apiPayload } from "@/utils/apiResponse";
import { formatPriceMicroToCny, getModelGroupError, parseCnyToMicro } from "@/views/billing/billingData";

type Model = { modelName: string; name: string };
type ModelGroupItem = { vendorId: string; model: string; enabled: boolean; dailyLimit: number | null };
type ModelGroup = { id: number; name: string; isLegacy: boolean; items: ModelGroupItem[] };
const props = defineProps<{ vendorId: string; model: Model }>();
const visible = ref(false);
const createVisible = ref(false);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const groups = ref<ModelGroup[]>([]);
const prices = ref<any[]>([]);
const priceTotal = ref(0);
const pricePage = ref(1);
const priceLimit = 50;
const selectedGroupIds = ref<number[]>([]);
const newGroupName = ref("");
const priceForm = reactive({ unit: "token", price: "", effectiveFrom: "" });
const unitOptions = [
  { label: "每个 Token", value: "token" },
  { label: "每次调用", value: "call" },
  { label: "每张图片", value: "image" },
  { label: "每秒视频", value: "video_second" },
  { label: "每秒视频 480p", value: "video_second_480p" },
  { label: "每秒视频 720p", value: "video_second_720p" },
  { label: "每个字符", value: "character" },
];
const priceColumns = [
  { colKey: "unit", title: "单位", width: 120 },
  { colKey: "unitPriceMicro", title: "单价", cell: "unitPriceMicro", ellipsis: true },
  { colKey: "effectiveFrom", title: "生效时间", cell: "effectiveFrom", width: 180 },
];
const groupOptions = computed(() => groups.value.map((group) => ({ label: `${group.name}${group.isLegacy ? "（只读）" : ""}`, value: group.id, disabled: group.isLegacy })));
const key = computed(() => ({ vendorId: props.vendorId, model: props.model.modelName }));
function dateTime(value: string | number) { return new Date(Number(value)).toLocaleString(); }
function unitLabel(unit: string) { return unitOptions.find((item) => item.value === unit)?.label ?? unit; }
async function loadData() {
  loading.value = true;
  error.value = "";
  try {
    const [groupResponse, priceResponse] = await Promise.all([
      axios.get("/billing/admin/groups"),
      axios.get("/billing/admin/prices", { params: { ...key.value, limit: priceLimit, offset: (pricePage.value - 1) * priceLimit } }),
    ]);
    groups.value = apiPayload<{ modelGroups: ModelGroup[] }>(groupResponse).modelGroups;
    const priceData = apiPayload<{ items: any[]; total: number }>(priceResponse);
    prices.value = priceData.items;
    priceTotal.value = Number(priceData.total);
    selectedGroupIds.value = groups.value.filter((group) => group.items.some((item) => item.vendorId === props.vendorId && item.model === props.model.modelName)).map((group) => group.id);
  } catch (cause: any) { error.value = cause?.message || "模型组或价格历史加载失败"; }
  finally { loading.value = false; }
}
async function open() { visible.value = true; pricePage.value = 1; await loadData(); }
async function changePricePage(delta: number) {
  const maxPage = Math.max(1, Math.ceil(priceTotal.value / priceLimit));
  pricePage.value = Math.min(maxPage, Math.max(1, pricePage.value + delta));
  await loadData();
}
async function saveGroups() {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const ids = new Set(selectedGroupIds.value.map(Number));
    for (const group of groups.value) {
      if (group.isLegacy) continue;
      const current = group.items.find((item) => item.vendorId === props.vendorId && item.model === props.model.modelName);
      const shouldInclude = ids.has(group.id);
      if (!!current === shouldInclude) continue;
      const items = group.items.filter((item) => !(item.vendorId === props.vendorId && item.model === props.model.modelName));
      if (shouldInclude) items.push({ vendorId: props.vendorId, model: props.model.modelName, enabled: true, dailyLimit: null });
      await axios.patch(`/billing/admin/groups/model-groups/${group.id}`, { items });
    }
    await loadData();
  } catch (cause: any) { error.value = getModelGroupError(cause); }
  finally { saving.value = false; }
}
async function createGroup() {
  if (saving.value) return;
  const name = newGroupName.value.trim();
  if (!name) { error.value = "请填写模型组名称"; return; }
  saving.value = true;
  error.value = "";
  try {
    await axios.post("/billing/admin/groups/model-groups", { name, items: [{ ...key.value, enabled: true, dailyLimit: null }] });
    newGroupName.value = "";
    createVisible.value = false;
    await loadData();
  } catch (cause: any) { error.value = getModelGroupError(cause); }
  finally { saving.value = false; }
}
async function appendPrice() {
  if (saving.value) return;
  error.value = "";
  try {
    const effectiveFrom = new Date(priceForm.effectiveFrom).getTime();
    const unitPriceMicro = parseCnyToMicro(priceForm.price);
    if (BigInt(unitPriceMicro) < 0n || !Number.isSafeInteger(effectiveFrom) || effectiveFrom < 0) throw new Error("价格或生效时间无效");
    saving.value = true;
    await axios.post("/billing/admin/prices", { ...key.value, unit: priceForm.unit, unitPriceMicro, effectiveFrom });
    priceForm.price = "";
    await loadData();
  } catch (cause: any) { error.value = cause?.message || "追加价格失败"; }
  finally { saving.value = false; }
}
</script>

<style scoped>
.accessPricing { display: inline-flex; }
.section h3 { margin: 0 0 8px; font-size: 15px; }
.sectionHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.muted { margin: 0 0 10px; color: var(--td-text-color-secondary); font-size: 12px; }
.limitRow { display: grid; grid-template-columns: minmax(160px, 260px) auto; align-items: end; gap: 12px; margin-top: 12px; }
.limitRow label, .priceForm label { display: grid; gap: 5px; color: var(--td-text-color-secondary); font-size: 12px; }
.priceForm { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)) auto; gap: 10px; align-items: end; margin-top: 14px; }
.pager { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 8px; font-size: 12px; }
@media (max-width: 700px) { .priceForm { grid-template-columns: 1fr; } .limitRow { grid-template-columns: 1fr; } }
</style>
