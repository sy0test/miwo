import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { useChat } from "@/utils/useChat";
import type { FlowData, Storyboard } from "@/views/production/utils/flowBuilder";
import type { ChatMessagesData } from "@tdesign-vue-next/chat";
import { useThrottleFn } from "@vueuse/core";

function makeProductionAgentStore(projectId: string) {
  return defineStore(`productionAgent-${projectId}`, () => {
    const defMsg: ChatMessagesData[] = [
      {
        id: "welcome",
        role: "assistant",
        content: [
          { type: "text", status: "complete", data: $t("workbench.production.chatBox.welcomeMessage") },
          {
            type: "suggestion",
            status: "complete",
            data: [{ title: $t("workbench.production.chatBox.startMakingVideo"), prompt: $t("workbench.production.chatBox.startMakingVideoPrompt") }],
          },
        ],
      },
    ];
    onMounted(() => {
      if (messages.value.length <= 0) messages.value = [...defMsg, ...messages.value];
    });

    const flowData = ref<FlowData>({
      script: "", // 剧本
      scriptPlan: "", //导演计划
      storyboardTable: "", //分镜表
      assets: [], // 衍生资产
      storyboard: [], //分镜面板
      workbench: {
        videoList: [],
      }, // 工作台数据
    });

    const episodesId = ref<number>();

    const { connected, messages, chat, stopGenerate, socket, status, reconnect, connect, disconnect } = useChat({
      url: `${settingStore().baseUrl}/socket/productionAgent`,
      auth: () => ({
        isolationKey: `${projectId}:productionAgent:${episodesId.value}`,
        projectId: projectId,
        scriptId: episodesId.value,
      }),
      manageLifecycle: false,
      autoConnect: false,
      xmlTags: [
        { tag: "script", keepInMessage: false },
        { tag: "scriptPlan", keepInMessage: false },
        { tag: "storyboardTable", keepInMessage: false },
        { tag: "storyboardItem", keepInMessage: false },
      ],
      onXmlTag: async (data) => {
        const { tag, value, children, attrs, status } = data;
        if (tag === "script") {
          flowData.value.script = value ?? "";
        } else if (tag === "scriptPlan") {
          flowData.value.scriptPlan = value ?? "";
        } else if (tag === "storyboardTable") {
          flowData.value.storyboardTable = value ?? "";
        }
        // else if (tag === "storyboardItem") {
        //   if (status === "complete") {
        //     const prompt = attrs.prompt ?? "";
        //     const duration = Number(attrs.duration) || 0;
        //     const track = attrs.track || "";
        //     const shouldGenerateImage =
        //       (typeof attrs.shouldGenerateImage == "boolean" && attrs.shouldGenerateImage) ||
        //       String(attrs.shouldGenerateImage).toLowerCase() == "true"
        //         ? 1
        //         : 0;

        //     const videoDesc = attrs?.videoDesc ?? "";
        //     const existingIndex = flowData.value.storyboard.findIndex(
        //       (s) => s.prompt == prompt && s.duration == duration && videoDesc == s.videoDesc,
        //     );
        //     if (existingIndex !== -1) {
        //       // 已存在则更新 content，保留 id
        //       flowData.value.storyboard[existingIndex].prompt = prompt;
        //     } else {
        //       // 不存在则追加新条目
        //       flowData.value.storyboard.push({
        //         prompt: prompt || "",
        //         duration: Number(duration) || 0,
        //         state: "未生成" as "未生成" | "生成中" | "已完成" | "生成失败",
        //         src: null,
        //         associateAssetsIds: JSON.parse(attrs.associateAssetsIds) || [],
        //         videoDesc: videoDesc,
        //         shouldGenerateImage: shouldGenerateImage,
        //       });
        //       await addStoryboardInfo([
        //         {
        //           prompt: prompt || "",
        //           duration: Number(duration) || 0,
        //           track: track || "",
        //           state: "未生成" as "未生成" | "生成中" | "已完成" | "生成失败",
        //           src: null,
        //           videoDesc,
        //           shouldGenerateImage,
        //           associateAssetsIds: JSON.parse(attrs.associateAssetsIds) || [],
        //         },
        //       ]);
        //     }
        //   }
        // }
        if (status == "complete") {
          throttledFn();
        }
      },
    });

    // 实际的节流方法
    const throttledFn = useThrottleFn(
      () => {
        setFlowData(episodesId.value);
      },
      500,
      true,
      true,
    );
    /**
     * 把 axios / 普通异常统一成一句给用户和后端看的话。
     * socket 的失败 ack 必须带可读原因 —— 后端会把它转成「生成失败：<原因>」回给模型，
     * 模型据此才能自愈；只说「失败了」等于把真因丢掉。
     */
    function errText(e: any): string {
      return e?.message ?? e?.data?.message ?? String(e);
    }
    // 注册 getPlanData 事件（无需依赖组件生命周期）
    watch(
      socket,
      (s) => {
        if (s) {
          s.on("connect", () => {
            getHistory();
          });
          s.on("getFlowData", (_, callback) => {
            const returnData = JSON.parse(JSON.stringify(flowData.value));
            returnData.assets.forEach((item: any) => {
              delete item.prompt;
              delete item.flowId;
              delete item.src;
              if (item.derive && item.derive.length) {
                item.derive.forEach((deriveItem: any) => {
                  delete deriveItem.prompt;
                  delete deriveItem.flowId;
                  delete deriveItem.src;
                });
              }
            });
            returnData.storyboard.forEach((item: any) => {
              delete item.prompt;
              delete item.src;
              delete item.flowId;
            });
            callback(returnData);
          });
          s.on("addDeriveAsset", async (data, callback) => {
            const assets = flowData.value.assets.find((a) => a.id === data.assetsId);
            if (!assets) return callback({ success: false, message: $t("storyboard.assets.notExist") });
            const deriveAssetList = assets.derive || [];
            const item = deriveAssetList.find((d) => d.id === data.id);
            if (item) {
              if (!item) return callback({ success: false, message: $t("storyboard.assets.notDerivativeExist") });
              item.name = data.name;
              item.type = assets.type;
              callback({ success: true, message: $t("storyboard.assets.derivativeUpdateSuccess") });
            } else {
              deriveAssetList.push({
                assetsId: data.assetsId,
                id: data.id,
                name: data.name,
                type: assets.type,
                desc: data.describe,
                prompt: "",
                state: "未生成" as "未生成" | "生成中" | "已完成" | "生成失败",
                src: "",
              });
              callback({ success: true, message: $t("storyboard.assets.derivativeAddSuccess") });
            }
          });
          s.on("delDeriveAsset", async (data, callback) => {
            const assets = flowData.value.assets.find((a) => a.id === data.assetsId);
            if (!assets) return callback({ success: false, message: $t("storyboard.assets.notExist") });
            const deriveAssetList = assets.derive || [];
            const index = deriveAssetList.findIndex((d) => d.id === data.id);
            if (index === -1) return callback({ success: false, message: $t("storyboard.assets.notDerivativeExist") });
            deriveAssetList.splice(index, 1);
            callback({ success: true, message: $t("storyboard.assets.derivativeDelSuccess") });
          });
          s.on("generateDeriveAsset", async (data, callback) => {
            try {
              const assetsData = await batchGenerateAssets(data.ids);
              callback({ success: true, message: assetsData });
            } catch (e: any) {
              // ⚠ 必须回一个**失败的 ack**：不回 ack 的话后端 generate_deriveAsset 工具
              // 会一直等前端（它有 30s 超时），用户看到的是「点了生成、卡住、最后说前端未响应」。
              callback({ success: false, error: errText(e) });
            }
          });
          s.on("generateStoryboard", async (data, callback) => {
            try {
              const storyData = await batchGenerateStoryboard(data.ids);
              callback({ success: true, message: storyData });
            } catch (e: any) {
              // 同上：出图失败必须**明确回失败**，否则后端误判成功、用户以为在生成
              callback({ success: false, error: errText(e) });
            }
          });
          s.on("addStoryboard", async (data, callback) => {
            const insertVal = {
              prompt: data.prompt || "",
              duration: Number(data.duration) || 0,
              track: data.track || "",
              state: "未生成" as "未生成" | "生成中" | "已完成" | "生成失败",
              src: null,
              videoDesc: data.videoDesc,
              shouldGenerateImage:
                (typeof data.shouldGenerateImage == "boolean" && data.shouldGenerateImage) || String(data.shouldGenerateImage).toLowerCase() == "true"
                  ? 1
                  : 0,
              associateAssetsIds: data.associateAssetsIds || [],
            };
            flowData.value.storyboard.push(insertVal);
            try {
              await addStoryboardInfo([insertVal]);
            } catch (e: any) {
              // ⚠ 这里原来没有 catch：axios 一抛错，callback 就永远不被调用，
              // 后端每条等 30s 超时才超时（一集 30 镜 = 15 分钟假死），且真实原因丢失。
              // 现在回失败 ack + 把本地那条「无 id 的幽灵行」回滚掉，避免面板与库不一致。
              const idx = flowData.value.storyboard.indexOf(insertVal);
              if (idx >= 0) flowData.value.storyboard.splice(idx, 1);
              callback({ success: false, error: errText(e) });
              return;
            }
            throttledFn();
            callback({ success: true, message: $t("storyboard.assets.derivativeAddSuccess") });
          });
        }
      },
      { immediate: true },
    );

    async function setFlowData(scriptId?: number) {
      // ⚠ 这个函数被节流回调直接调用，**必须自己吃掉异常**：否则 axios 400（例如没有有效
      // 集号时 episodesId 为 undefined）会变成未处理的 rejection，用户看到的是「改了没生效」
      // 而控制台之外没有任何提示。
      try {
        const { data } = await axios.post("/production/saveFlowData", {
          projectId: projectId,
          data: flowData.value,
          episodesId: scriptId || episodesId.value,
        });
        // 阶段2：v2 下保存分镜表会**自动再解析 + 事务落库**，后端把结果放在 `shotsNote` 里
        //（形如「影子落库完成：片段 30 / 镜 78 …；校验 error 0 / warning 2」）。
        // 成功时静默（节流保存会很频繁，每次都弹会吵），**有问题才提示** —— 否则用户根本不知道
        // "文本改了、结构是否跟上"，更看不到校验挑出的违规。
        const note = (data as { shotsNote?: string } | undefined)?.shotsNote;
        if (note) {
          console.info("[productionAgent] 分镜表已同步结构化：", note);
          // 结构化同步结果：也给节点用（分镜表节点会在编辑区下方内联显示）
          shotsSync.value = {
            note,
            errors: (data as any)?.shotsValidateErrors ?? [],
            warnings: (data as any)?.shotsWarnings ?? [],
            at: Date.now(),
          };
          if (/解析失败/.test(note)) window.$message?.warning?.(note, 8);
          else if (/校验 error [1-9]/.test(note)) window.$message?.warning?.(note, 8);
          // 覆盖度不完整（真机出现过"只写了场1片段一就收尾"）：必须显式提醒，
          // 否则用户以为"阶段4 跑完了"，实际只做了一小段。
          else if (/疑似不完整/.test(note)) window.$message?.warning?.(note, 8);
        }
      } catch (e: any) {
        console.warn("[productionAgent] 工作区保存失败：", errText(e));
      }
    }

    async function getFlowData() {
      const { data } = await axios.post("/production/getFlowData", {
        projectId: projectId,
        episodesId: episodesId.value,
      });
      flowData.value = data;
    }
    async function batchGenerateStoryboard(allIds: number[], compulsory: boolean = false) {
      try {
        const { data } = await axios.post("/production/storyboard/batchGenerateImage", {
          scriptId: episodesId.value,
          projectId: projectId,
          storyboardIds: allIds,
          concurrentCount: settingStore().otherSetting.assetsBatchGenereateSize,
          compulsory,
        });
        if (data) {
          if (flowData.value.storyboard.length === 0) {
            flowData.value.storyboard = data;
            return data;
          } else {
            flowData.value.storyboard.forEach((item) => {
              const findData = data.find((i: any) => i.id == item.id);
              if (findData) {
                item.state = findData.state;
                item.src = findData.src;
              }
            });
          }
        }
        return data;
      } catch (e: any) {
        // ⚠ 原来这里只弹一个 message 然后 return undefined，上层 handler 仍回 success:true
        // → 用户以为图片在生成。改成抛出去，由 handler 回明确的失败 ack。
        window.$message.error(errText(e));
        throw e;
      }
    }
    async function batchGenerateAssets(allIds: number[]) {
      flowData.value.assets.forEach((asset) => {
        if (asset.derive) {
          asset.derive.forEach((derive) => {
            if (allIds.includes(derive.id)) {
              derive.state = "生成中" as "未生成" | "生成中" | "已完成" | "生成失败";
            }
          });
        }
      });
      try {
        const { data } = await axios.post("/production/assets/batchGenerateAssetsImage", {
          assetIds: allIds,
          projectId: projectId,
          scriptId: episodesId.value,
          concurrentCount: settingStore().otherSetting.assetsBatchGenereateSize,
        });
        if (data) {
          data.forEach((record: { id: number; state: "未生成" | "生成中" | "已完成" | "生成失败"; src: string }) => {
            flowData.value.assets.forEach((asset) => {
              if (asset.derive) {
                asset.derive.forEach((derive) => {
                  if (derive.id === record.id) {
                    derive.state = record.state;
                    derive.src = record.src;
                  }
                });
              }
            });
          });
        }
        return data;
      } catch (e: any) {
        // ⚠ 原来是空的 `catch (e) {}` —— 资产出图失败被彻底吞掉，用户界面只看到状态卡在
        // 「生成中」，永远不会变成失败。改成上抛，由 handler 回失败 ack。
        window.$message.error(errText(e));
        throw e;
      }
    }
    const assetsNotStateImageIds = computed(() => {
      const ids: number[] = [];
      flowData.value.assets.forEach((asset) => {
        if (asset.derive) {
          asset.derive.forEach((derive) => {
            if (derive.state == ("生成中" as "未生成" | "生成中" | "已完成" | "生成失败")) {
              ids.push(derive.id);
            }
          });
        }
      });
      return ids;
    });
    const storyboardNotStateImageIds = computed(() => {
      const ids: number[] = [];
      // 阶段2：v2（多参模式）不出分镜图 —— 也没有这个概念。
      // ⚠ 不拦的话，卡片 state（片段/视频状态）会被当成"分镜图生成中"，
      // 去轮询 /production/storyboard/pollingImage（那边按 o_storyboard id 查，会返回编号撞上的历史行），
      // 回来还会把别人的 state 写到卡片上。
      if ((flowData.value as { shotsEngine?: string }).shotsEngine === "v2") return ids;
      flowData.value.storyboard.forEach((asset) => {
        if (asset.state == "生成中" && asset.id) {
          ids.push(asset.id);
        }
      });
      return ids;
    });
    // ---- 资产图片轮询 ----
    let assetsPollingTimer: number | null = null;
    let assetsPollingInFlight = false;

    async function pollAssetsImages() {
      const ids = assetsNotStateImageIds.value;
      if (ids.length === 0 || assetsPollingInFlight) return;
      assetsPollingInFlight = true;
      try {
        const { data } = await axios.post("/production/assets/pollingImage", {
          ids: ids,
        });
        if (!data || data.length === 0) return;
        const records = data as Array<{ id: number; state: string; src?: string; errorReason?: string; prompt?: string }>;
        records.forEach((record) => {
          flowData.value.assets.forEach((asset) => {
            if (!asset.derive) return;
            asset.derive.forEach((derive) => {
              if (derive.id === record.id) {
                derive.state = record.state as "未生成" | "生成中" | "已完成" | "生成失败";
                if (record.src) derive.src = record.src;
                derive.errorReason = record?.errorReason ?? "";
                derive.prompt = record?.prompt ?? "";
              }
            });
          });
        });
      } catch (e) {
        console.error("[assetsPolling] error", e);
      } finally {
        assetsPollingInFlight = false;
      }
    }

    function startAssetsPolling() {
      if (assetsPollingTimer) return;
      assetsPollingTimer = window.setInterval(async () => {
        if (assetsNotStateImageIds.value.length === 0) {
          stopAssetsPolling();
          return;
        }
        await pollAssetsImages();
      }, 5000);
      // 立即执行一次
      pollAssetsImages();
    }

    function stopAssetsPolling() {
      if (assetsPollingTimer) {
        clearInterval(assetsPollingTimer);
        assetsPollingTimer = null;
      }
    }

    watch(
      () => assetsNotStateImageIds.value,
      (ids) => {
        if (ids.length > 0) {
          startAssetsPolling();
        } else {
          stopAssetsPolling();
        }
      },
    );

    // ---- 分镜图片轮询 ----
    let storyboardPollingTimer: number | null = null;
    let storyboardPollingInFlight = false;

    async function pollStoryboardImages() {
      const ids = storyboardNotStateImageIds.value;
      if (ids.length === 0 || storyboardPollingInFlight) return;
      storyboardPollingInFlight = true;
      try {
        const { data } = await axios.post("/production/storyboard/pollingImage", {
          ids: ids,
        });
        if (!data || data.length === 0) return;
        const records = data as Array<{ id: number; state: string; src?: string; reason?: string }>;
        records.forEach((record) => {
          const item = flowData.value.storyboard.find((s) => s.id === record.id);
          if (item) {
            item.state = record.state as "未生成" | "生成中" | "已完成" | "生成失败";
            if (record.src) item.src = record.src;
            item.reason = record?.reason ?? "";
          }
        });
      } catch (e) {
        console.error("[storyboardPolling] error", e);
      } finally {
        storyboardPollingInFlight = false;
      }
    }

    function startStoryboardPolling() {
      if (storyboardPollingTimer) return;
      storyboardPollingTimer = window.setInterval(async () => {
        if (storyboardNotStateImageIds.value.length === 0) {
          stopStoryboardPolling();
          return;
        }
        await pollStoryboardImages();
      }, 5000);
      // 立即执行一次
      pollStoryboardImages();
    }

    function stopStoryboardPolling() {
      if (storyboardPollingTimer) {
        clearInterval(storyboardPollingTimer);
        storyboardPollingTimer = null;
      }
    }

    watch(
      () => storyboardNotStateImageIds.value,
      (ids) => {
        if (ids.length > 0) {
          startStoryboardPolling();
        } else {
          stopStoryboardPolling();
        }
      },
    );

    function updateContext() {
      if (episodesId.value! < 0) return;
      const ctx = {
        isolationKey: `${projectId}:productionAgent:${episodesId.value}`,
        projectId: projectId,
        scriptId: episodesId.value,
      };
      if (!connected.value) connect();
      socket.value!.emit("updateContext", ctx);
    }
    async function addStoryboardInfo(items: any[]) {
      const { data } = await axios.post("/production/storyboard/batchAddStoryboardInfo", {
        scriptId: episodesId.value,
        data: items,
        projectId: projectId,
      });

      flowData.value.storyboard.forEach((item) => {
        const updated = data.find((d: Storyboard) => d.prompt == item.prompt && d.duration == item.duration && d.videoDesc == item.videoDesc);
        if (updated) {
          item.id = updated.id;
          item.trackId = updated.trackId;
          item.src = updated.src;
          item.state = updated.state;
          item.associateAssetsIds = updated.associateAssetsIds;
        }
      });
    }

    const loadingHistory = ref(false);
    /**
     * 结构化同步结果（阶段2）：手改分镜表保存后，后端会**再解析 + 事务落库**并把结果回传。
     * 这里存下来给分镜表节点内联展示 —— 否则用户只能从控制台/日志里猜"结构有没有跟上"。
     */
    const shotsSync = ref<{ note: string; errors: string[]; warnings: string[]; at: number } | null>(null);
    /** 拉历史的请求序号：只认最后一次请求的结果，丢弃过期响应（快速连切集时后到的旧响应会把界面写回旧集） */
    let historySeq = 0;
    /**
     * 重新拉取会话历史。
     *
     * ⚠ 这里有四条**必须留住**的护栏，都是真跑踩过的：
     *   1. `episodesId` 无效时后端按 `projectId:productionAgent`（少一截）查库，必然查空 →
     *      界面被清空。所以没有有效集号时**直接不发请求**。
     *   2. 正跑着（pending/streaming）时拉历史会把「正在流式输出的那条」连同它已渲染的
     *      内容一起顶掉 —— 「分镜表跑着跑着对话就空了」就是这么来的。跑动中一律不覆盖。
     *   3. 后端返回空数组时**不拿它清空界面**：记忆可能只是还没落库（本轮对话刚写入），
     *      或读错了 isolationKey。清空是有损操作，只有用户主动清记忆才允许（`allowEmpty`）。
     *      ⚠ 但**用户主动切集**必须传 `allowEmpty: true`：新集的记忆本来就是空的，
     *      如果沿用护栏，界面会一直留着上一集的对话（「切到新集还是旧对话」就是这个原因）。
     *   4. 响应必须**校验请求序号与集号**：切集是异步的，旧请求后到会覆盖新集的内容。
     */
    async function getHistory(options: { allowEmpty?: boolean } = {}) {
      const { allowEmpty = false } = options;
      if (episodesId.value == null || episodesId.value < 0) {
        console.warn("[productionAgent] 跳过拉取历史：当前没有有效的集号");
        return;
      }
      if (status.value === "pending" || status.value === "streaming") {
        console.warn("[productionAgent] 跳过拉取历史：正在跑，覆盖会打断流式输出");
        return;
      }
      const seq = ++historySeq;
      const reqEpisodesId = episodesId.value;
      loadingHistory.value = true;
      try {
        const { data } = await axios.post(`/agents/getMemory`, {
          projectId: projectId,
          episodesId: reqEpisodesId,
          agentType: "productionAgent",
        });
        // 过期响应（期间又切了集 / 又发起了新的拉取）一律丢弃
        if (seq !== historySeq || reqEpisodesId !== episodesId.value) {
          console.warn("[productionAgent] 丢弃过期的历史响应", { reqEpisodesId, currentEpisodesId: episodesId.value });
          return;
        }
        const history = (data ?? []) as ChatMessagesData[];
        if (!history.length && !allowEmpty && messages.value.length > defMsg.length) {
          console.warn("[productionAgent] 后端没返回记忆，保留界面上的既有对话（不清空）");
          return;
        }
        messages.value = [];
        messages.value = [...defMsg, ...history];
      } finally {
        if (seq === historySeq) loadingHistory.value = false;
      }
    }

    const thinkLevel = ref(0);

    function updateThinkConfig(value: number) {
      thinkLevel.value = value;
      if (socket.value) {
        socket.value.emit("updateThinkConfig", { think: value > 0, thinlLevel: value });
      }
    }

    return {
      connected,
      messages,
      chat,
      stopGenerate,
      socket,
      status,
      flowData,
      setFlowData,
      getFlowData,
      episodesId,
      stopAssetsPolling,
      stopStoryboardPolling,
      updateContext,
      getHistory,
      loadingHistory,
      shotsSync,
      batchGenerateStoryboard,
      reconnect,
      thinkLevel,
      updateThinkConfig,
    };
  });
}
const storeMap = new Map<string, ReturnType<typeof makeProductionAgentStore>>();

function createProductionAgentStore(projectId: string) {
  if (!storeMap.has(projectId)) {
    storeMap.set(projectId, makeProductionAgentStore(projectId));
  }
  return storeMap.get(projectId)!;
}

export default function useProductionAgentStore(): ReturnType<ReturnType<typeof makeProductionAgentStore>> {
  const id = projectStore().project?.id;
  if (!id) throw new Error("No project selected");
  return createProductionAgentStore(id)();
}
