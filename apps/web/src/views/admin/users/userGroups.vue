<template>
  <section class="groupsPanel">
    <div class="panelHeader">
      <div><h2>用户组</h2><p>将用户组关联到模型组；历史授权组保持只读。</p></div>
      <t-button theme="primary" @click="openCreate"><template #icon><t-icon name="add" /></template>新建用户组</t-button>
    </div>
    <t-alert v-if="error" theme="error" :message="error" close @close="error = ''" />
    <t-loading :loading="loading">
      <t-table :data="groups" :columns="columns" row-key="id" size="small">
        <template #modelGroups="{ row }">{{ namesFor(row.modelGroupIds).join("、") || "无模型组" }}</template>
        <template #operation="{ row }">
          <t-space>
            <t-button variant="text" theme="primary" :disabled="row.isLegacy" @click="editGroup(row)">编辑</t-button>
            <t-button variant="text" theme="danger" :disabled="row.isLegacy" @click="deleteGroup(row)">删除</t-button>
          </t-space>
        </template>
      </t-table>
      <t-empty v-if="!loading && groups.length === 0" description="暂无用户组" />
    </t-loading>
    <t-dialog v-model:visible="editorVisible" :header="editing ? '编辑用户组' : '新建用户组'" :confirm-btn="'保存'" :loading="saving" @confirm="saveGroup">
      <t-form label-align="top">
        <t-form-item label="用户组名称"><t-input v-model="form.name" maxlength="128" /></t-form-item>
        <t-form-item label="关联模型组"><t-select v-model="form.modelGroupIds" multiple :options="modelGroupOptions" placeholder="选择一个或多个模型组" /></t-form-item>
      </t-form>
    </t-dialog>
    <t-dialog v-model:visible="deleteVisible" header="删除用户组" :confirm-btn="'删除'" theme="danger" :loading="saving" @confirm="confirmDelete">
      <p>确定删除“{{ deleting?.name }}”？仅可删除无成员且未关联模型组的用户组。</p>
    </t-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import axios from "@/utils/axios";
import { apiPayload } from "@/utils/apiResponse";

type UserGroup = { id: number; name: string; isLegacy: boolean; modelGroupIds: number[] };
type ModelGroup = { id: number; name: string; isLegacy: boolean; items: { vendorId: string; model: string; enabled: boolean }[] };
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const groups = ref<UserGroup[]>([]);
const modelGroups = ref<ModelGroup[]>([]);
const editorVisible = ref(false);
const deleteVisible = ref(false);
const editing = ref<UserGroup | null>(null);
const deleting = ref<UserGroup | null>(null);
const form = reactive({ name: "", modelGroupIds: [] as number[] });
const columns = [
  { colKey: "name", title: "用户组", ellipsis: true },
  { colKey: "modelGroups", title: "模型组", cell: "modelGroups", ellipsis: true },
  { colKey: "operation", title: "操作", cell: "operation", width: 180 },
];
const modelGroupOptions = computed(() => modelGroups.value.map((group) => ({ label: `${group.name}${group.isLegacy ? "（历史）" : ""}`, value: group.id })));
async function loadGroups() {
  loading.value = true;
  error.value = "";
  try {
    const data = apiPayload<{ userGroups: UserGroup[]; modelGroups: ModelGroup[] }>(await axios.get("/billing/admin/groups"));
    groups.value = data.userGroups;
    modelGroups.value = data.modelGroups;
  } catch (cause: any) { error.value = cause?.message || "分组加载失败"; }
  finally { loading.value = false; }
}
function namesFor(ids: number[]) { return modelGroups.value.filter((group) => ids.includes(group.id)).map((group) => group.name); }
function openCreate() {
  editing.value = null;
  form.name = "";
  form.modelGroupIds = [];
  editorVisible.value = true;
}
function editGroup(group: UserGroup) {
  editing.value = group;
  form.name = group.name;
  form.modelGroupIds = [...group.modelGroupIds];
  editorVisible.value = true;
}
async function saveGroup() {
  if (saving.value) return;
  const name = form.name.trim();
  if (!name || form.modelGroupIds.length === 0) { error.value = "请填写名称并至少关联一个模型组"; return; }
  saving.value = true;
  error.value = "";
  try {
    const payload = { name, modelGroupIds: [...new Set(form.modelGroupIds.map(Number))] };
    if (editing.value) await axios.patch(`/billing/admin/groups/user-groups/${editing.value.id}`, payload);
    else await axios.post("/billing/admin/groups/user-groups", payload);
    editorVisible.value = false;
    await loadGroups();
  } catch (cause: any) { error.value = cause?.message || "保存用户组失败"; }
  finally { saving.value = false; }
}
function deleteGroup(group: UserGroup) { deleting.value = group; deleteVisible.value = true; }
async function confirmDelete() {
  if (!deleting.value || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await axios.delete(`/billing/admin/groups/user-groups/${deleting.value.id}`);
    deleteVisible.value = false;
    await loadGroups();
  } catch (cause: any) { error.value = cause?.message || "删除用户组失败"; }
  finally { saving.value = false; }
}
onMounted(loadGroups);
</script>

<style scoped>
.groupsPanel { padding-top: 12px; }
.panelHeader { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.panelHeader h2 { margin: 0; font-size: 16px; }
.panelHeader p { margin: 4px 0 0; color: var(--td-text-color-secondary); font-size: 12px; }
</style>
