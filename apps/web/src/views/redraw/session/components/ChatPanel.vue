<template>
  <div class="chatPanel fc">
    <div class="head f ac jb">
      <span class="title">转绘助手</span>
      <span class="dot" :class="{ on: connected }">{{ connected ? "在线" : "未连接" }}</span>
    </div>
    <div ref="listRef" class="list">
      <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
        <div class="bubble">{{ textOf(m) }}</div>
      </div>
      <div v-if="!messages.length" class="empty">
        可以告诉助手：要替换哪些角色、改成什么名字/性别，或者直接问下一步该做什么。
      </div>
    </div>
    <div class="quick f ac">
      <t-button size="small" variant="outline" @click="send('请逐条列出还没确认的资产')">列出未确认资产</t-button>
      <t-button size="small" variant="outline" @click="send('剧本我先不改，继续下一步')">剧本不改</t-button>
    </div>
    <div class="sender f ac">
      <input v-model="input" class="input" placeholder="和转绘助手说…" :disabled="!connected" @keydown.enter="onEnter" />
      <t-button size="small" theme="primary" :disabled="!connected || !input.trim()" @click="send(input)">发送</t-button>
    </div>
    <div v-if="!connected" class="offline">对话服务未连接，面板操作仍可用；连接恢复后会自动重连。</div>
  </div>
</template>

<script setup lang="ts">
import settingStore from "@/stores/setting";
import { useChat } from "@/utils/useChat";

const props = defineProps<{ projectId: number; scriptId: number }>();
const setting = settingStore();
const input = ref("");
const listRef = ref<HTMLElement>();

const { connected, messages, chat, connect } = useChat({
  url: `${setting.baseUrl}/socket/redrawAgent`,
  auth: () => ({
    isolationKey: `${props.projectId}:redrawAgent:${props.scriptId}`,
    projectId: String(props.projectId),
    scriptId: props.scriptId,
  }),
  autoConnect: false,
  manageLifecycle: false,
  xmlTags: [],
});

onMounted(() => connect());
onUnmounted(() => {
  // useChat 内部会在 manageLifecycle 为 false 时由调用方负责；这里不强行断开，避免切页闪断
});

function textOf(m: any): string {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (b?.type === "text" || b?.type === "markdown") return String(b.data ?? b.text ?? "");
      return "";
    })
    .join("")
    .trim();
}

function send(text: string) {
  const t = String(text ?? "").trim();
  if (!t) return;
  chat(t);
  input.value = "";
}
function onEnter() {
  send(input.value);
}
</script>

<style lang="scss" scoped>
.chatPanel {
  border-left: 1px solid var(--td-component-border);
  height: 100%;
  min-width: 320px;
  .head {
    padding: 12px 16px;
    border-bottom: 1px solid var(--td-component-border);
    .title {
      font-weight: 600;
    }
    .dot {
      font-size: 12px;
      color: var(--td-text-color-placeholder);
    }
    .dot.on {
      color: var(--td-success-color);
    }
  }
  .list {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    .msg {
      display: flex;
      margin-bottom: 8px;
      .bubble {
        max-width: 86%;
        padding: 8px 10px;
        border-radius: 10px;
        background: var(--td-bg-color-secondarycontainer);
        font-size: 13px;
        line-height: 1.6;
        white-space: pre-wrap;
      }
    }
    .msg.user {
      justify-content: flex-end;
      .bubble {
        background: var(--td-brand-color-light);
      }
    }
    .empty {
      font-size: 12px;
      color: var(--td-text-color-placeholder);
      line-height: 1.8;
    }
  }
  .quick {
    gap: 8px;
    padding: 8px 12px;
    flex-wrap: wrap;
  }
  .sender {
    gap: 8px;
    padding: 8px 12px 12px;
    .input {
      flex: 1;
      border: 1px solid var(--td-component-border);
      border-radius: 6px;
      padding: 6px 8px;
      background: var(--td-bg-color-container);
      color: var(--td-text-color-primary);
      font-size: 13px;
    }
  }
  .offline {
    padding: 0 12px 10px;
    font-size: 12px;
    color: var(--td-warning-color);
  }
}
</style>