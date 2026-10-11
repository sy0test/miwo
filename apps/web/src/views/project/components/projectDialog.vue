<template>
  <div class="addProject">
    <t-dialog
      placement="center"
      v-model:visible="addProjectShow"
      :header="isEdit ? $t('workbench.project.dialog.editTitle') : $t('workbench.project.dialog.addTitle')"
      width="60%"
      @confirm="handleOk"
      @close-btn-click="handleCancel"
      @cancel="handleCancel"
      :confirm-btn="isEdit ? $t('workbench.project.dialog.save') : $t('workbench.project.dialog.ok')"
      :cancel-btn="$t('workbench.project.dialog.cancel')">
      <t-form :data="formState" label-align="top">
        <t-form-item :label="$t('workbench.project.dialog.projectType')">
          <t-select v-model="formState.projectType" :placeholder="$t('workbench.project.dialog.selectType')">
            <t-option key="基于小说原文" :label="$t('workbench.project.dialog.basedOnNovel')" value="novel" />
            <t-option key="基于剧本" :label="$t('workbench.project.dialog.basedOnScript')" value="script" />
            <t-option key="出海转绘" :label="$t('workbench.project.dialog.basedOnRedraw')" value="redraw" />
          </t-select>
        </t-form-item>
        <t-form-item :label="$t('workbench.project.dialog.projectName')">
          <t-input v-model="formState.name" :placeholder="$t('workbench.project.dialog.projectNamePh')" />
        </t-form-item>
        <!-- 转绘没有「小说类型」，只有「往哪个国家/语区转」。两个字段都存库：
             type 是基座各处的通用字段（留空），targetCountry 是转绘技能解析时的权威输入 -->
        <t-form-item v-if="isRedraw" :label="$t('workbench.project.dialog.targetCountry')">
          <t-input v-model="formState.targetCountry" :placeholder="$t('workbench.project.dialog.targetCountryPh')" />
        </t-form-item>
        <t-form-item v-else :label="$t('workbench.project.dialog.novelType')">
          <t-input v-model="formState.type" :placeholder="$t('workbench.project.dialog.novelTypePh')" />
        </t-form-item>
        <t-form-item :label="$t('workbench.project.dialog.modelData')">
          <div class="ac" style="gap: 5px; width: 100%">
            <modelSelect v-model="formState.imageModel" type="image" />
            <t-select v-model="formState.imageQuality" class="paramSelect ml-5" :placeholder="$t('workbench.production.editImage.quality')">
              <t-option value="1K" label="1K" />
              <t-option value="2K" label="2K" />
              <t-option value="4K" label="4K" />
            </t-select>
          </div>
        </t-form-item>
        <t-form-item :label="$t('workbench.project.dialog.videoModelData')">
          <div class="ac" style="gap: 5px; width: 100%">
            <modelSelect v-model="formState.videoModel" type="video" @change="changeFn" :changeConfig="true" />
            <t-select v-model="formState.mode" class="paramSelect ml-5" :placeholder="$t('workbench.production.editImage.mode')">
              <t-option v-for="value in mode" :key="value.value" :value="value.value" :label="value.label" />
            </t-select>
          </div>
        </t-form-item>
        <t-form-item :label="$t('workbench.project.dialog.videoRatio')">
          <t-select v-model="formState.videoRatio" :options="RATIO_OPTIONS" />
        </t-form-item>
        <t-form-item :label="$t('workbench.project.dialog.artStyle')">
          <t-input v-model="formState.artStyle" :placeholder="$t('workbench.project.dialog.artStylePh')" />
        </t-form-item>
        <t-form-item :label="$t('workbench.project.dialog.novelIntro')">
          <t-textarea v-model="formState.intro" :autosize="{ minRows: 3, maxRows: 6 }" :placeholder="$t('workbench.project.dialog.novelIntroPh')" />
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from "vue";
import axios from "@/utils/axios";
import modelSelect from "@/components/modelSelect.vue";

const addProjectShow = defineModel<boolean>();
const props = defineProps<{
  projectData?: ProjectData | null;
}>();
const emit = defineEmits<{
  (e: "add", data: ProjectFormData): void;
  (
    e: "edit",
    data: {
      id: string;
      name: string;
      intro: string;
      type: string;
      artStyle: string;
      videoRatio: string;
      imageModel: string;
      videoModel: string;
      projectType: string;
      imageQuality: "1K" | "2K" | "4K" | "";
      mode: string;
      targetCountry: string;
    },
  ): void;
}>();

// ===== 类型定义 =====
interface ProjectData {
  id: string;
  name: string;
  intro: string;
  type: string;
  artStyle: string | null;
  videoRatio: string | null;
  imageModel: string;
  videoModel: string;
  projectType: string;
  imageQuality: "1K" | "2K" | "4K" | "";
  mode: string;
  targetCountry?: string | null;
}

interface ProjectFormData {
  projectType: string;
  name: string;
  intro: string;
  type: string;
  artStyle: string;
  videoRatio: string;
  imageModel: string;
  videoModel: string;
  imageQuality: "1K" | "2K" | "4K" | "";
  mode: string;
  targetCountry: string;
}
const isEdit = computed(() => !!props.projectData);
/** 出海转绘：小说类型换成目标国家 */
const isRedraw = computed(() => formState.value.projectType === "redraw");

// ===== 常量 =====
const RATIO_OPTIONS = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
];

const DEFAULT_FORM: () => ProjectFormData & { id: number; era: string; createTime: number; userId: number } = () => ({
  id: 0,
  projectType: "novel",
  name: "",
  intro: "",
  type: "",
  artStyle: "",
  era: "",
  videoRatio: "16:9",
  createTime: 0,
  userId: 0,
  imageModel: "",
  videoModel: "",
  imageQuality: "",
  mode: "",
  targetCountry: "",
});

// ===== 表单 =====
const formState = ref(DEFAULT_FORM());

function resetForm() {
  formState.value = DEFAULT_FORM();
}

function handleCancel() {
  addProjectShow.value = false;
  resetForm();
}

function handleOk() {
  if (!formState.value.name) return window.$message.warning($t("workbench.project.msg.enterProjectName"));
  // 转绘不填小说类型，改必填目标国家（转绘技能解析时的权威输入，后端也会拦）
  if (isRedraw.value) {
    if (!formState.value.targetCountry) return window.$message.warning($t("workbench.project.msg.enterTargetCountry"));
  } else if (!formState.value.type) {
    return window.$message.warning($t("workbench.project.msg.enterProjectType"));
  }
  if (!formState.value.imageModel) return window.$message.warning($t("workbench.project.msg.enterImageModel"));
  if (!formState.value.videoModel) return window.$message.warning($t("workbench.project.msg.enterVideoModel"));
  if (!formState.value.artStyle) return window.$message.warning($t("workbench.project.msg.enterArtStyle"));
  if (!formState.value.videoRatio) return window.$message.warning($t("workbench.project.msg.enterVideoRatio"));
  if (!formState.value.intro) return window.$message.warning($t("workbench.project.msg.enterProjectIntro"));
  if (!formState.value.imageQuality) return window.$message.warning($t("workbench.project.msg.enterProjectQuality"));
  if (!formState.value.mode) return window.$message.warning($t("workbench.project.msg.selectMode"));
  if (isEdit.value) {
    emit("edit", {
      id: formState.value.id as unknown as string,
      name: formState.value.name,
      intro: formState.value.intro,
      type: formState.value.type,
      artStyle: formState.value.artStyle,
      videoRatio: formState.value.videoRatio,
      imageModel: formState.value.imageModel,
      videoModel: formState.value.videoModel,
      projectType: formState.value.projectType || "novel",
      imageQuality: formState.value.imageQuality,
      mode: formState.value.mode,
      targetCountry: formState.value.targetCountry,
    });
  } else {
    emit("add", {
      projectType: formState.value.projectType || "novel",
      name: formState.value.name,
      intro: formState.value.intro,
      type: formState.value.type,
      artStyle: formState.value.artStyle,
      videoRatio: formState.value.videoRatio || "16:9",
      imageModel: formState.value.imageModel,
      videoModel: formState.value.videoModel,
      imageQuality: formState.value.imageQuality,
      mode: formState.value.mode,
      targetCountry: formState.value.targetCountry,
    });
  }
  resetForm();
  addProjectShow.value = false;
}

watch(addProjectShow, async (visible) => {
  if (visible) {
    if (props.projectData) {
      formState.value = {
        ...DEFAULT_FORM(),
        id: props.projectData.id as unknown as number,
        name: props.projectData.name || "",
        intro: props.projectData.intro || "",
        type: props.projectData.type || "",
        artStyle: props.projectData.artStyle || "",
        videoRatio: props.projectData.videoRatio || "16:9",
        imageModel: props.projectData.imageModel || "",
        videoModel: props.projectData.videoModel || "",
        imageQuality: props.projectData.imageQuality || "",
        projectType: props.projectData.projectType || "novel",
        mode: props.projectData.mode || "text",
        targetCountry: props.projectData.targetCountry || "",
      };
      // 编辑模式下主动获取视频模型详情，填充 mode 列表以回显 label
      if (props.projectData.videoModel) {
        try {
          const { data } = await axios.post("/modelSelect/getModelDetail", {
            modelId: props.projectData.videoModel,
          });
          if (data?.mode) {
            mode.value = data.mode.map((item: any) => ({
              label: getModeLabel(item),
              value: modeToKey(item),
            }));
          }
        } catch (e) {
          // 获取失败不影响其他功能
        }
      }
    } else {
      resetForm();
    }
  }
});

type VideoMode =
  | "singleImage" //单图参考
  | "startEndRequired" //首尾帧（两张都得有）
  | "endFrameOptional" //首尾帧（尾帧可选）
  | "startFrameOptional" //首尾帧（首帧可选）
  | "text" //文本
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]; //多参考（数字代表限制数量）
const mode = ref<{ label: string; value: string }[]>([]);
const MODE_LABEL: Record<string, string> = {
  singleImage: $t("workbench.production.generate.modeSingleImage"),
  startEndRequired: $t("workbench.production.generate.modeStartEnd"),
  endFrameOptional: $t("workbench.production.generate.modeStartEnd"),
  startFrameOptional: $t("workbench.production.generate.modeStartEnd"),
  text: $t("workbench.production.generate.modeText"),
  videoReference: $t("workbench.production.generate.modeVideoRef"),
  imageReference: $t("workbench.production.generate.modeImageRef"),
  audioReference: $t("workbench.production.generate.modeAudioRef"),
};
// 模式转换为统一的 key 形式，方便后续处理
function getModeLabel(mode?: VideoMode): string {
  if (!mode) return "";
  if (Array.isArray(mode)) return mode.map((r) => MODE_LABEL[r.replace(/:.*$/, "")] ?? r).join("、");
  return MODE_LABEL[mode] ?? mode;
}
//模式数组转换为字符串 key，方便在前端使用和比较
function modeToKey(m: VideoMode): string {
  return Array.isArray(m) ? JSON.stringify(m) : m;
}
//获取模式
function changeFn(val: string, data: any) {
  mode.value = data.mode.map((item: any) => ({
    label: getModeLabel(item),
    value: modeToKey(item),
  }));
}
</script>
