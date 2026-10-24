<template>
  <div class="imageUploadBox" ref="uploadBoxRef">
    <!--
      单图 / 多参模式。
      多参模式下这一排就是「发送顺序」本身：数组先后 = uploadData 顺序 = 供应商侧
      `@图N` 的编号，所以这里可以拖动排序；单图模式槽位只有一个，禁用拖动。
    -->
    <VueDraggable
      v-if="mode == 'singleImage' || isDragMode"
      v-model="imageList"
      :class="['slotList', isDragMode ? 'slotDraggable' : '']"
      :disabled="!isDragMode"
      :animation="150"
      ghostClass="slotGhost"
      dragClass="slotDrag"
      :forceFallback="true"
      :scroll="uploadBoxRef!"
      :scrollSensitivity="80"
      :scrollSpeed="10"
      :filter="dragIgnoreSelector"
      :preventOnFilter="false">
      <div class="slotWrap" v-for="(item, index) in displayItems" :key="index">
        <div class="uploadBtn c fc">
          <template v-if="item.src">
            <t-image v-if="item.fileType == 'image'" :src="item.src" fit="contain" class="uploadPreview">
              <template #overlayContent>
                <div class="imageToolsWrap">
                  <ImageTools :src="item.src!" position="br" />
                </div>
              </template>
            </t-image>
            <t-tooltip theme="primary" v-else-if="item.fileType == 'audio'" :content="item?.prompt || ''">
              <div class="mediaPreview audioPreview">
                <i-acoustic size="20" />
                <span class="mediaLabel">音频</span>
              </div>
            </t-tooltip>
            <div v-else-if="item.fileType == 'video'" class="mediaPreview videoPreview" @click.stop="openVideoPreview(item.src)">
              <video class="uploadPreview" :src="item.src" preload="metadata" muted />
              <div class="playHint">▶ 预览</div>
            </div>
          </template>
          <template v-else>
            <!--
              未生图的素材只有一个"文"框（真机反馈：没有任何提示）。
              这里 hover 显示**资产的分类与名称**（如「角色：莉迪亚」「场景：地下室」）；
              资产素材本身就带 type/name（getGenerateData 给的），不需要额外请求。
            -->
            <t-tooltip theme="primary">
              <div class="mediaPreview noImgPreview">
                <span style="font-size: 20px">文</span>
                <span v-if="cardName(item)" class="noImgName">{{ cardName(item) }}</span>
              </div>
              <template #content>
                <div v-if="cardName(item)">{{ cardName(item) }}</div>
                <div v-if="item?.prompt" class="tipPrompt">{{ item.prompt }}</div>
              </template>
            </t-tooltip>
          </template>
          <div class="imageTitleWrap" v-if="item.sources == 'storyboard' && item.index != null">
            {{ `P${item.index + 1}` }}
          </div>
          <!--
            ⚠ 这里必须 `.stop` 掉 mousedown 与 click（原来只有 click、且没有 .stop）：
            这一排是 VueDraggable + forceFallback 的拖拽容器，Sortable 会在 mousedown 阶段接管，
            随后的 click 会被吞掉 —— 表现就是「× 按钮点不动」（鼠标移到卡片上是拖动用的手型）。
          -->
          <div class="clearBtn" @mousedown.stop @click.stop="splitImage(index)">
            <i-close size="12" />
          </div>
          <div class="source">
            <t-tag size="small">
              {{ item.sources == "storyboard" ? $t("workbench.generate.storyboard") : item.sources == "clip" ? "原片" : $t("workbench.generate.assets") }}
            </t-tag>
          </div>
        </div>
        <!-- 只看资产来源的格子给替换入口：分镜格 / 原片参考片的来源是分镜弹窗，不在这里换 -->
        <div class="replaceBtn" v-if="item.sources === 'assets'" @click.stop="handleReplace(index)">{{ replaceLabel }}</div>
      </div>
    </VueDraggable>
    <template v-else-if="mode == 'endFrameOptional' || mode == 'startFrameOptional' || mode == 'startEndRequired'">
      <div class="slotWrap" v-for="(item, index) in buildLabel" :key="item.value">
        <div class="uploadBtn c fc" @click="handleMixedAdd(item.value as 'start' | 'end')">
          <div v-if="!isEmptySlot(imageList?.[index])" style="flex: 1; width: 100%" class="ac">
            <template v-if="imageList?.[index]?.src">
              <t-image v-if="imageList?.[index]?.fileType == 'image'" :src="imageList?.[index]!.src" fit="contain" class="uploadPreview">
                <template #overlayContent>
                  <div class="imageToolsWrap">
                    <ImageTools :src="imageList?.[index]!.src" position="br" />
                  </div>
                </template>
              </t-image>
              <div v-else-if="imageList?.[index]?.fileType == 'audio'" class="mediaPreview audioPreview">
                <i-acoustic size="20" />
                <span class="mediaLabel">音频</span>
              </div>
              <div v-else-if="imageList?.[index]?.fileType == 'video'" class="mediaPreview videoPreview" @click.stop="openVideoPreview(imageList?.[index]!.src!)">
                <video class="uploadPreview" :src="imageList?.[index]!.src" preload="metadata" muted />
                <div class="playHint">▶ 预览</div>
              </div>
            </template>
            <template v-else>
              <!-- 选择器里未生图的项：hover 也显示「分类：名称」+ 提示词 -->
              <t-tooltip theme="primary">
                <div class="mediaPreview noImgPreview">
                  <span style="font-size: 20px">文</span>
                  <span v-if="cardName(imageList?.[index])" class="noImgName">{{ cardName(imageList?.[index]) }}</span>
                </div>
                <template #content>
                  <div v-if="cardName(imageList?.[index])">{{ cardName(imageList?.[index]) }}</div>
                  <div v-if="imageList?.[index]?.prompt" class="tipPrompt">{{ imageList?.[index]?.prompt }}</div>
                </template>
              </t-tooltip>
            </template>
            <div class="imageTitleWrap" v-if="imageList?.[index]?.sources == 'storyboard' && imageList?.[index]?.index != null">
              {{ `P${imageList[index]?.index! + 1}` }}
            </div>
            <div class="clearBtn" @mousedown.stop @click.stop="clearImage(index)">
              <i-close size="12" />
            </div>
            <div class="source">
              <t-tag size="small">
                {{ imageList?.[index]?.sources == "storyboard" ? $t("workbench.generate.storyboard") : imageList?.[index]?.sources == "clip" ? "原片" : $t("workbench.generate.assets") }}
              </t-tag>
            </div>
          </div>
          <template v-else>
            <i-plus size="24"></i-plus>
            {{ item.label }}
          </template>
        </div>
        <div class="replaceBtn" v-if="imageList?.[index]?.sources === 'assets'" @click.stop="handleReplace(index)">{{ replaceLabel }}</div>
      </div>
    </template>
    <div class="uploadBtn c fc addBtn" v-if="isShowAddImage" @click="handleMixedAdd()">
      <i-plus size="24"></i-plus>
      {{ $t("workbench.generate.addReference") }}
    </div>

    <!-- 分镜选择弹窗 -->
    <t-dialog
      v-model:visible="storyboardDialogVisible"
      :header="$t('workbench.generate.selectStoryboard')"
      :footer="false"
      width="800px"
      placement="center">
      <div class="storyboardGrid">
        <!-- v2：一条 = 一个分镜（= 分镜面板一张卡 = 工作台的一段）；不再按"段内镜"列条目 -->
        <div class="storyboardItem" v-for="sb in storyboardList" :key="sb.id" @click="pickStoryboard(sb)">
          <div class="imageTitleWrap" v-if="sb?.index != null">
            {{ `分镜 ${sb?.index + 1}` }}
          </div>
          <img v-if="sb.src" :src="sb.src" />
          <div v-else class="textBox ac jc">
            <t-tooltip theme="primary" :content="sb?.videoDesc || ''">
              <div class="storyboardPlaceholder">
                <span style="font-size: 18px">{{ `分镜 ${sb?.index != null ? sb.index + 1 : ""}` }}</span>
                <span v-if="sb.shotCount || sb.duration" class="storyboardMeta">
                  {{ [sb.duration ? `约 ${sb.duration}s` : "", sb.shotCount ? `${sb.shotCount} 镜` : ""].filter(Boolean).join(" · ") }}
                </span>
              </div>
            </t-tooltip>
          </div>
        </div>
      </div>
    </t-dialog>

    <!-- 视频参考素材预览：卡片上的 <video> 是静音静帧，没有控制条；点卡片在这里播放 -->
    <t-dialog v-model:visible="videoPreviewVisible" :header="false" :footer="false" width="720px" placement="center" destroy-on-close>
      <video :src="videoPreviewSrc" controls autoplay style="width: 100%; max-height: 70vh; background: #000" />
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { VueDraggable } from "vue-draggable-plus";
import "@/views/production/components/workbench/type/type";
import assetsCheck, { type AssetType, type ClipMediaType } from "@/utils/assetsCheck";
import axios from "@/utils/axios";

const props = defineProps<{
  mode: VideoMode;
  storyboardList: StoryboardItem[];
}>();
const imageList = defineModel<UploadItem[]>({
  default: () => [],
});
//分镜选择弹窗
const storyboardDialogVisible = ref(false);
//视频参考素材预览弹窗
const videoPreviewVisible = ref(false);
const videoPreviewSrc = ref("");
function openVideoPreview(src?: string | null) {
  if (!src) return;
  videoPreviewSrc.value = src;
  videoPreviewVisible.value = true;
}
//拖动排序时给 Sortable 用的横向滚动容器
const uploadBoxRef = ref<HTMLDivElement | null>(null);

/** 空占位项，用于首尾帧模式中未设置的槽位 */
const EMPTY_SLOT: UploadItem = { fileType: "image", id: null, src: "" } as any;
function isEmptySlot(item: UploadItem | undefined): boolean {
  return !item || !item.id;
}

/** 多参模式：mode 是 JSON 数组字符串（如 ["imageReference:3"]），此时才允许拖动排序 */
const isDragMode = computed(() => Array.isArray(parseMode(props.mode as string)));

/**
 * 拖动排序时**要忽略的区域**：删除按钮、图片工具条。
 *
 * 为什么需要：`forceFallback: true` 时 Sortable 在 `mousedown` 阶段就接管指针，
 * 卡片里的按钮点击会被吞掉（真机表现：鼠标悬停是拖动用的手型，× 点不动删不掉资产）。
 * 配合 `:preventOnFilter="false"`，被忽略区域的点击照常触发。
 */
const dragIgnoreSelector = ".clearBtn, .imageToolsWrap, .mediaPreview";

/** 实际渲染的槽位：单图模式只渲染第一格，多参模式全渲染 */
const displayItems = computed<UploadItem[]>(() => (props.mode == "singleImage" ? imageList.value.slice(0, 1) : imageList.value));

/**
 * 未生图素材的 hover 文案：**分类 + 名称**（"角色：莉迪亚" / "场景：地下室"）。
 * 真机反馈：未生图的资产只有一个"文"框，没有任何提示，认不出是哪个资产。
 * 数据来源就是素材项自带的 `type`/`name`（getGenerateData 给的），不需额外请求。
 */
const ASSET_TYPE_LABEL: Record<string, string> = { role: "角色", tool: "道具", scene: "场景", clip: "素材", audio: "音频" };
function cardName(item?: UploadItem | null): string {
  if (!item) return "";
  if (item.sources !== "assets") {
    // 分镜项：v2 下一条 = 一个片段（分镜），直接按顺序叫「分镜 n」
    return item.index != null ? `分镜 ${item.index + 1}` : "分镜";
  }
  const label = ASSET_TYPE_LABEL[String((item as any).type ?? "")] ?? "资产";
  const name = String((item as any).name ?? "").trim();
  return name ? `${label}：${name}` : label;
}

/** 「替换」按钮文案：只维护中文词条，缺词条的语言直接兜底中文，避免露出 i18n key */
const replaceLabel = computed(() => {
  const label = $t("workbench.generate.replace");
  return label === "workbench.generate.replace" ? "替换" : label;
});

const buildLabel = computed(() => {
  const startOptional = props.mode === "startFrameOptional";
  const endOptional = props.mode === "endFrameOptional";
  return [
    { label: startOptional ? "首帧(可选)" : "首帧", value: "start" },
    { label: endOptional ? "尾帧(可选)" : "尾帧", value: "end" },
  ];
});

/** 确保 imageList 始终有两个槽位（首帧 index=0，尾帧 index=1） */
function ensureFrameSlots(): UploadItem[] {
  const list = [...imageList.value];
  while (list.length < 2) list.push({ ...EMPTY_SLOT });
  return list;
}

/** 将 item 设置到首帧或尾帧槽位 */
function setFrameSlot(slot: "start" | "end", item: UploadItem) {
  const list = ensureFrameSlots();
  list[slot === "start" ? 0 : 1] = item;
  imageList.value = list;
}

/** 解析模式值（字符串或 JSON 数组） */
function parseMode(value: string): VideoMode | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as ReferenceType[];
  } catch {
    return value as Exclude<VideoMode, ReferenceType[]>;
  }
  return value as Exclude<VideoMode, ReferenceType[]>;
}

//判断是否显示添加参考图
const isShowAddImage = computed(() => {
  const mode = props.mode;
  if (mode == "singleImage" && imageList.value.length >= 1) {
    return false;
  }
  if (mode == "endFrameOptional" || mode == "startEndRequired" || mode == "startFrameOptional") {
    return false;
  }
  if (mode == "text") return false;
  //多参模式默认 true
  return true;
});

/** 根据文件扩展名推断媒体类型 */
function getFileTypeByExt(src: string | undefined): "image" | "video" | "audio" {
  // ⚠ 先剥掉 query/hash：素材 URL 是带签名的（`.mp4?exp=...&sig=...`），
  // 直接 split(".").pop() 会得到 "mp4?exp=..."，判成 image —— 真机症状：
  // 从「素材」里选原片视频，卡片显示「图片无法显示」。
  const clean = (src ?? "").split(/[?#]/)[0];
  const ext = clean.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(ext)) return "audio";
  return "image";
}
/** 根据混合模式推导当前允许的 clip 媒体类型 */
const mixedClipMediaTypes = computed<ClipMediaType[]>(() => {
  const mode = props.mode;
  if (!Array.isArray(mode)) return [];
  const map: Record<string, ClipMediaType> = { audioReference: "audio", imageReference: "image", videoReference: "video" };
  return mode.filter((m) => m in map).map((m) => map[m]);
});

/**
 * 资产面板选中结果 → 参考项。
 * 「添加参考」和「替换」共用这一套展开规则：音频资产带子资产（变体）时逐个展开成多条。
 */
function toUploadItems(assets: any[]): UploadItem[] {
  return assets.flatMap((asset) => {
    if (asset.type === "audio" && asset?.sonAssets?.length) {
      return asset.sonAssets.map((sub: any) => {
        const fileType = getFileTypeByExt(sub.src);
        return {
          fileType,
          sources: "assets",
          src: sub.src,
          id: sub.id,
          prompt: sub.prompt,
        } as UploadItem;
      });
    }
    const fileType = getFileTypeByExt(asset.src);
    return [
      {
        fileType,
        sources: "assets",
        src: asset.src,
        id: asset.id,
        prompt: asset.prompt,
      } as UploadItem,
    ];
  });
}

let currentSlot: "start" | "end" | "" = "";
function handleMixedAdd(slot: "start" | "end" | "" = "") {
  if (!props.mode) return window.$message.error($t("workbench.generate.notSelectMode"));
  currentSlot = slot;
  const multiple = Array.isArray(parseMode(props.mode as string));
  const dlg = DialogPlugin.confirm({
    header: $t("workbench.generate.selectSource"),
    confirmBtn: $t("workbench.generate.confirm"),
    cancelBtn: $t("workbench.generate.cancel"),
    onConfirm: async () => {
      dlg.destroy();
      const assets = await assetsCheck({ types: ["role", "tool", "scene", "clip", "audio"], clipMediaTypes: mixedClipMediaTypes.value, multiple });

      if (!assets.length) return;

      const newItems: UploadItem[] = toUploadItems(assets);
      if (slot === "start" || slot === "end") {
        setFrameSlot(slot, newItems[0]);
      } else if (props.mode === "singleImage") {
        imageList.value = [newItems[0]];
      } else {
        const assetsNotAudioIds = newItems.filter((i) => i.fileType !== "audio");
        const { data } = await axios.post("/production/workbench/getAudioBindAssetsList", {
          assetsIds: assetsNotAudioIds.map((i) => i.id),
        });
        imageList.value = [...imageList.value, ...newItems, ...(data ?? [])];
      }
    },
    onCancel: () => {
      dlg.destroy();
      storyboardDialogVisible.value = true;
    },
  });
}

/**
 * 替换指定槽位上的资产：走与「添加参考」同一套弹窗与展开逻辑（单选），
 * 选中的素材**原地覆盖那一格** —— 位置不变，于是 `@图N` 的编号也不变，
 * 提示词一个字都不用改。
 */
async function handleReplace(index: number) {
  if (!props.mode) return window.$message.error($t("workbench.generate.notSelectMode"));
  const assets = await assetsCheck({
    types: ["role", "tool", "scene", "clip", "audio"],
    clipMediaTypes: mixedClipMediaTypes.value,
    multiple: false,
  });
  if (!assets.length) return;
  const newItems = toUploadItems(assets);
  if (!newItems.length) return;

  const frameMode = props.mode === "endFrameOptional" || props.mode === "startFrameOptional" || props.mode === "startEndRequired";
  if (frameMode) {
    // 首尾帧的槽位语义固定，只能一格换一格，不能增删槽位
    const list = ensureFrameSlots();
    list[index] = newItems[0];
    imageList.value = list;
    return;
  }
  if (props.mode === "singleImage") {
    imageList.value = [newItems[0]];
    return;
  }
  // 多参：原地替换；极端情况下（音频资产的多个变体）多出来的排在它后面，整体顺序不乱
  const list = [...imageList.value];
  list.splice(index, 1, ...newItems);
  imageList.value = list;
}

function clearImage(index: number) {
  const list = ensureFrameSlots();
  list[index] = { ...EMPTY_SLOT };
  imageList.value = list;
}
/** 分镜弹窗选中回调 */
function pickStoryboard(sb: StoryboardItem) {
  storyboardDialogVisible.value = false;
  const fileType = "image";
  const newItem = {
    fileType,
    sources: "storyboard",
    src: sb.src,
    id: sb.id,
    prompt: sb.videoDesc ?? undefined,
    index: sb.index,
  } as UploadItem;

  if (currentSlot === "start" || currentSlot === "end") {
    setFrameSlot(currentSlot, newItem);
  } else {
    imageList.value = [...imageList.value, newItem];
  }
}
function splitImage(index: number) {
  const list = [...imageList.value];
  list.splice(index, 1);
  imageList.value = list;
}
</script>

<style lang="scss" scoped>
.tipPrompt {
  max-width: 320px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 分镜选择弹窗里没图的项：显示「分镜 n」+ 约 Xs · N 镜 */
.storyboardPlaceholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  .storyboardMeta {
    font-size: 11px;
    color: var(--td-text-color-placeholder);
  }
}

.imageUploadBox {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  overflow-x: auto;
  flex-wrap: nowrap;
  padding-bottom: 6px;
  &::-webkit-scrollbar {
    height: 6px;
  }
  &::-webkit-scrollbar-thumb {
    background: #696969;
    border-radius: 4px;
  }
  &::-webkit-scrollbar-track {
    background-color: var(--td-bg-color-secondarycontainer);
    border-radius: 4px;
  }
  .slotList {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    flex-shrink: 0;
  }
  .slotWrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .replaceBtn {
    width: 80px;
    font-size: 11px;
    line-height: 18px;
    text-align: center;
    color: var(--td-text-color-secondary);
    background: var(--td-bg-color-container);
    border: 1px solid var(--td-component-border);
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
    transition:
      color 0.2s,
      border-color 0.2s;
    &:hover {
      color: var(--td-brand-color);
      border-color: var(--td-brand-color);
    }
  }
  .imageTitleWrap {
    z-index: 999;
    position: absolute;
    left: 4px;
    top: 4px;
    padding: 0 5px;
    font-size: 11px;
    line-height: 18px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    border-radius: 4px;
    backdrop-filter: blur(4px);
    user-select: none;
    white-space: nowrap;
  }
  /* 多参模式的这一排是拖动排序用的：整卡给"抓取"手型，
     否则和普通可点卡片一样显示 pointer，会让人以为点卡片有反应（真机反馈过这个误解）。 */
  .slotDraggable {
    .uploadBtn {
      cursor: grab;
      &:hover {
        cursor: grab;
      }
      &:active {
        cursor: grabbing;
      }
      /* × 仍明确是"可点"（且已在模板里 stop 掉 mousedown，不会被拖拽吞掉） */
      .clearBtn {
        cursor: pointer;
      }
    }
  }

  .uploadBtn {
    width: 80px;
    min-width: 80px;
    height: 80px;
    flex-shrink: 0;
    position: relative;
    border: 1px dashed var(--td-component-border);
    border-radius: 8px;
    &:hover {
      border-color: var(--td-text-color);
      cursor: pointer;
    }


    .uploadPreview {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 8px;
      position: relative;
      .imageToolsWrap {
        height: 100%;
        transform: scale(0.6);
        transform-origin: bottom right;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }
      &:hover {
        .imageToolsWrap {
          opacity: 1;
          pointer-events: auto;
        }
      }
    }
    .mediaPreview {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      gap: 4px;
      .mediaLabel {
        font-size: 11px;
        color: var(--td-text-color-secondary);
      }
      &.audioPreview {
        background: var(--td-bg-color-secondarycontainer);
        color: var(--td-brand-color);
      }
      /* 未生图素材：名字压在"文"下面，认得出是哪个资产（长名字两行截断） */
      &.noImgPreview {
        padding: 2px 3px;
        box-sizing: border-box;
        .noImgName {
          font-size: 10px;
          line-height: 1.15;
          color: var(--td-text-color-placeholder);
          text-align: center;
          word-break: break-all;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          max-width: 100%;
        }
      }
      &.videoPreview {
        position: relative;
        background: #000;
        overflow: hidden;
        cursor: pointer;
        .playHint {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          padding: 2px 8px;
          border-radius: 10px;
          background: rgba(0, 0, 0, 0.55);
          color: #fff;
          font-size: 11px;
          pointer-events: none;
        }
      }
    }
    .clearBtn {
      z-index: 999999999999999;
      position: absolute;
      top: 2px;
      right: 2px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.6);
      color: #fff;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      &:hover {
        background: rgba(0, 0, 0, 0.85);
      }
    }
    &:hover .clearBtn {
      display: flex;
    }
    .source {
      position: absolute;
      bottom: 2px;
      right: 2px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.6);
      color: #fff;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      &:hover {
        background: rgba(0, 0, 0, 0.85);
      }
    }
    &:hover .source {
      display: flex;
    }
  }
  .storyboardGrid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    max-height: 60vh;
    overflow-y: auto;
    padding: 4px;
    .storyboardItem {
      cursor: pointer;
      position: relative;
      border-radius: 8px;
      overflow: hidden;
      border: 2px solid transparent;
      transition:
        border-color 0.2s,
        box-shadow 0.2s;
      &:hover {
        border-color: var(--td-brand-color);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
      }
      img {
        width: 100%;
        aspect-ratio: 16/9;
        object-fit: cover;
        display: block;
      }
      .textBox {
        aspect-ratio: 16/9;
        width: 100%;
        text-align: center;
        border: 1px solid #ccc;
      }
    }
  }
}
</style>

<!-- Sortable.js 动态添加的 class 不受 scoped 影响，需要全局样式 -->
<style lang="scss">
.slotGhost {
  opacity: 0.4;
  border: 1px dashed var(--td-brand-color) !important;
  border-radius: 8px;
}

.slotDrag {
  opacity: 0.9;
  transform: scale(1.04);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}
</style>
