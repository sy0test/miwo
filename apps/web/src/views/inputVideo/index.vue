<template>
  <div class="inputVideo">
    <div class="actionBar f ac jb">
      <div class="actionBar-left f ac">
        <t-button theme="primary" :loading="uploading" @click="pickFiles">
          <template #icon><i-upload-one /></template>
          {{ $t("workbench.inputVideo.upload") }}
        </t-button>
        <span class="hint">{{ $t("workbench.inputVideo.uploadHint") }}</span>
      </div>
      <div class="actionBar-right f ac">
        <t-button theme="default" variant="outline" @click="fetchList">
          <template #icon><i-refresh /></template>
          {{ $t("workbench.inputVideo.refresh") }}
        </t-button>
      </div>
    </div>

    <!-- 正在上传的临时卡：传完就消失，那一集的正式卡片会自己出现在下面 -->
    <div class="uploadList f w" v-if="uploads.length">
      <t-card v-for="item in uploads" :key="item.uid" class="uploadCard" shadow>
        <div class="uploadHeader f ac jb">
          <span class="name">{{ item.name }}</span>
          <i-close size="14" class="del" @click="dropUpload(item.uid)" />
        </div>
        <t-progress v-if="!item.error" :percentage="item.percent" :label="`${item.percent}%`" />
        <div v-else class="uploadError">{{ item.error }}</div>
      </t-card>
    </div>

    <div class="contentArea">
      <div v-if="!sources.length && !uploads.length" class="emptyState">
        <t-empty :description="emptyText" />
      </div>
      <div v-else class="sourceList f w">
        <div v-for="item in sources" :key="item.id" class="sourceCard">
          <t-card shadow class="card">
            <div class="cover">
              <t-image v-if="item.coverUrl" :src="item.coverUrl" fit="cover" :lazy="true" class="coverImg" />
              <div v-else class="coverEmpty fc c">
                <i-picture size="22" />
                <span>{{ $t("workbench.inputVideo.noCover") }}</span>
              </div>
            </div>
            <div class="cardHeader f ac jb">
              <span class="cardTitle" :title="item.name">{{ item.name }}</span>
              <t-tag v-if="item.sortIndex" size="small" variant="light-outline" class="epTag">
                {{ $t("workbench.inputVideo.episode", { n: item.sortIndex }) }}
              </t-tag>
            </div>
            <div class="status f ac">
              <!-- extractState：0 正在提取 / 1 成功 / 2 等待提取 / 3 待对账 / -1 失败（3 是转绘新增档） -->
              <t-loading v-if="item.extractState === 0" size="small" :text="$t('workbench.inputVideo.analyzing')" />
              <t-tooltip
                v-else-if="item.extractState === -1"
                theme="light"
                placement="top-left"
                :overlay-style="{ maxWidth: '460px' }">
                <t-tag theme="danger" size="small">{{ $t("workbench.inputVideo.failed") }}</t-tag>
                <template #content>
                  <div class="errBox">{{ item.errorReason }}</div>
                </template>
              </t-tooltip>
              <!-- 3 = 解析完了，但资产还没跟用户认账、转绘分镜表也还没出。放在 analyzed 之前 —— 它会赢过那个分支。 -->
              <t-tag v-else-if="item.extractState === 3" theme="warning" variant="light">
                {{ $t("workbench.inputVideo.pendingReconcile") }}
              </t-tag>
              <t-tag v-else-if="item.analyzed" theme="success" variant="light">
                {{ $t("workbench.inputVideo.analyzed", { count: item.storyboards }) }}
              </t-tag>
              <t-tag v-else theme="default" variant="light">{{ $t("workbench.inputVideo.waitAnalyze") }}</t-tag>
            </div>
            <div class="cardFoot fc">
              <t-button
                v-if="item.analyzed"
                theme="default"
                variant="outline"
                block
                :disabled="item.extractState === 0"
                @click="startAnalyze(item, true)">
                {{ $t("workbench.inputVideo.reAnalyze") }}
              </t-button>
              <t-button v-else theme="primary" block :disabled="item.extractState === 0" @click="startAnalyze(item, false)">
                {{ $t("workbench.inputVideo.startAnalyze") }}
              </t-button>
            </div>
          </t-card>
        </div>
      </div>
    </div>

    <!-- 收**原始字节流**，不是 JSON/multipart：后端 body 上限 100mb，
         源视频走 base64 进 JSON 必然 413（见 redraw/uploadSource 的注释） -->
    <input ref="fileInput" class="fileInput" type="file" multiple accept="video/*" @change="onFilesPicked" />
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import projectStore from "@/stores/project";

const { project } = storeToRefs(projectStore());

interface SourceItem {
  id: number;
  name: string;
  sortIndex: number | null;
  sourceVideo: string | null;
  coverPath: string | null;
  coverUrl: string | null;
  videoUrl: string | null;
  extractState: number | null; // -1 失败 0 正在提取 1 成功 2 等待提取 3 待对账
  errorReason: string | null;
  createTime: number | null;
  storyboards: number;
  analyzed: boolean;
}
interface UploadItem {
  uid: number;
  name: string;
  percent: number;
  error: string;
}

const sources = ref<SourceItem[]>([]);
const uploads = ref<UploadItem[]>([]);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement>();
let uidSeq = 0;

const emptyText = computed(() =>
  project.value ? $t("workbench.inputVideo.empty") : $t("workbench.inputVideo.noProject"),
);

function errText(e: any): string {
  return e?.message ?? e?.data?.message ?? String(e);
}

async function fetchList() {
  if (!project.value) return;
  try {
    // projectId 必须是数字：路由用 z.number() 校验（`project.id` 在库里是整数，
    // 但 pinia 里存的是 string —— 别直接透传）
    const { data } = await axios.post("/redraw/getSourceList", { projectId: Number(project.value.id) });
    sources.value = data;
  } catch (e: any) {
    window.$message.error(errText(e) ?? $t("workbench.inputVideo.listFailed"));
  }
}
onMounted(fetchList);

// ---- 批量上传 ----
function pickFiles() {
  fileInput.value?.click();
}

function dropUpload(uid: number) {
  uploads.value = uploads.value.filter((u) => u.uid !== uid);
}

async function onFilesPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // 清空 value：不清的话再选同一批文件不会触发 change，用户会以为没反应
  input.value = "";
  if (!files.length) return;

  uploading.value = true;
  let ok = 0;
  // 一个一个传，不并发：一次几十上百 MB 同时打盘和网络，失败了也分不清是谁的错
  for (const file of files) {
    const item = reactive<UploadItem>({ uid: ++uidSeq, name: file.name, percent: 0, error: "" });
    uploads.value.push(item);
    try {
      await uploadOne(file, item);
      ok++;
      dropUpload(item.uid);
      await fetchList(); // 这一集的正式卡片自己冒出来（封面也一起回来）
    } catch (err) {
      item.error = errText(err); // 失败的留在列表里给人看原因，可以手动叉掉
    }
  }
  uploading.value = false;
  if (ok) window.$message.success($t("workbench.inputVideo.uploadSuccess", { count: ok }));
}

async function uploadOne(file: File, item: UploadItem) {
  const projectId = Number(project.value!.id);
  // 文件名走 query，body 就是文件本身
  const url = `/redraw/uploadSource?projectId=${projectId}&name=${encodeURIComponent(file.name)}`;
  const res: any = await axios.post(url, file, {
    headers: { "Content-Type": "application/octet-stream" },
    // 默认 10 分钟的超时对几百 MB 的源片不够用，这里不设上限
    timeout: 0,
    onUploadProgress: (p: any) => {
      if (p.total) item.percent = Math.round((p.loaded / p.total) * 100);
    },
  });
  // 抽封面失败不算上传失败（后端就是这么定的），但原因得说出来 ——
  // 不说的话卡片上只是一个「无封面」，人只会以为源片有问题
  if (res?.data?.coverError) {
    window.$message.warning($t("workbench.inputVideo.coverFailed", { name: res.data.name, msg: res.data.coverError }));
  }
}

// ---- 开始分析 ----
async function startAnalyze(item: SourceItem, replace: boolean) {
  if (replace) {
    // 重跑会把这一集已有的分镜整套换掉（后端的 writeRedraw 是删了重插），先问一句
    const dialog = DialogPlugin.confirm({
      header: $t("workbench.inputVideo.reAnalyzeHeader"),
      body: $t("workbench.inputVideo.reAnalyzeBody", { name: item.name, count: item.storyboards }),
      confirmBtn: $t("workbench.inputVideo.reAnalyzeConfirm"),
      cancelBtn: $t("workbench.script.msg.cancel"),
      theme: "warning",
      onConfirm: async () => {
        dialog.destroy();
        await doAnalyze(item, true);
      },
      onClose: () => dialog.destroy(),
    });
    return;
  }
  await doAnalyze(item, false);
}

async function doAnalyze(item: SourceItem, replace: boolean) {
  // 后台是「开跑就返回」，所以本地先置成正在提取 —— 按钮立刻变灰，
  // 轮询也立刻起来（后台确实在返回前就把 0 写进库了，两边一致）
  item.extractState = 0;
  item.errorReason = null;
  try {
    await axios.post("/redraw/analyzeSource", {
      projectId: Number(project.value!.id),
      scriptId: item.id,
      replace,
    });
    window.$message.success($t("workbench.inputVideo.analyzeStarted", { name: item.name }));
  } catch (e: any) {
    // 开跑前就被挡下（409 已在分析中 / 400 源片文件不在了）：这次没真开始，回读一次真实状态
    window.$message.error(errText(e));
    await fetchList();
  }
}

// ---- 轮询：只要还有卡在「正在提取」，就每 3 秒拉一次列表 ----
const analyzingCount = computed(() => sources.value.filter((s) => s.extractState === 0).length);
let pollingTimer: ReturnType<typeof setInterval> | null = null;

function startPolling() {
  if (pollingTimer) return;
  pollingTimer = setInterval(fetchList, 3000);
}
function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}
watch(analyzingCount, (n) => (n > 0 ? startPolling() : stopPolling()));
onUnmounted(stopPolling);

// 切项目时把上一份列表清掉，免得显示别人的源片
watch(
  () => project.value?.id,
  () => {
    sources.value = [];
    uploads.value = [];
    fetchList();
  },
);
</script>

<style lang="scss" scoped>
.inputVideo {
  .actionBar {
    margin-top: 1.25rem;
    margin-bottom: 20px;
    gap: 16px;
    .actionBar-left {
      gap: 12px;
    }
    .hint {
      color: var(--td-text-color-placeholder);
      font-size: 12px;
    }
  }
  .uploadList {
    gap: 20px;
    margin-bottom: 20px;
    .uploadCard {
      width: 400px;
      .uploadHeader {
        margin-bottom: 8px;
        .name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .del {
          flex-shrink: 0;
          margin-left: 12px;
          cursor: pointer;
          opacity: 0.6;
          &:hover {
            opacity: 1;
          }
        }
      }
      .uploadError {
        color: var(--td-error-color);
        font-size: 12px;
        word-break: break-all;
        max-height: 80px;
        overflow-y: auto;
      }
    }
  }
  .contentArea {
    .sourceList {
      gap: 20px;
      .sourceCard {
        width: 400px;
        .card {
          display: flex;
          flex-direction: column;
        }
      }
      .cover {
        width: 100%;
        aspect-ratio: 16 / 9;
        border-radius: 8px;
        overflow: hidden;
        background-color: var(--td-bg-color-secondarycontainer);
        margin-bottom: 12px;
        .coverImg {
          width: 100%;
          height: 100%;
          display: block;
        }
        .coverEmpty {
          width: 100%;
          height: 100%;
          gap: 6px;
          color: var(--td-text-color-placeholder);
          font-size: 12px;
        }
      }
      .cardHeader {
        margin-bottom: 8px;
        .cardTitle {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
          font-weight: 600;
        }
        .epTag {
          flex-shrink: 0;
          margin-left: 12px;
        }
      }
      .status {
        min-height: 24px;
        margin-bottom: 12px;
      }
      .cardFoot {
        width: 100%;
      }
    }
    .emptyState {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 500px;
    }
  }
  .fileInput {
    display: none;
  }
}
// 失败原因的 tooltip：后端给的是多行（「解析出了 N 个资产…但体检没过：」+ 每条一行）
.errBox {
  white-space: pre-line;
  max-height: 320px;
  overflow-y: auto;
}
</style>
