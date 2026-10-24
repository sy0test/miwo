import { EventEmitter } from "events";
import { o_novel } from "@/types/database";
import { currentAiBillingContext } from "@/billing/context";
import u from "@/utils";
import { stripThink } from "@/utils/stripThink";
export interface EventType {
  id: number;
  event: string;
}

/*  文本数据清洗
 * @param textData 需要清洗的文本
 * @param windowSize 每组数量 默认5
 * @param overlap 交叠数量 默认1
 * @returns {totalCharacter:所有人物角色卡,totalEvent:所有事件}
 */

class CleanNovel {
  emitter: EventEmitter;
  /** 最大并发数 */
  concurrency: number;

  constructor(concurrency: number = 5) {
    this.emitter = new EventEmitter();
    this.concurrency = concurrency;
  }

  private async processChapter(novel: o_novel): Promise<EventType | null> {
    try {
      const prompt = await u.getPrompts("event");
      const promptData = await u.db("o_prompt").where("type", "eventExtraction").first();
      let eventExtraction = "" as string | undefined;
      if (promptData && promptData.useData) {
        eventExtraction = promptData.useData;
      } else {
        eventExtraction = promptData?.data ?? undefined;
      }
      const resData = await u.Ai.Text("universalAi", currentAiBillingContext()).invoke({
        // ⚠ 不能 JSON.stringify。这里传的是**系统提示词正文**，而 initDB 已经 seed 了
        // type="eventExtraction" 的 promptData，所以 eventExtraction 分支必然命中；
        // JSON.stringify 会把整段提示词变成一个带 `\n` 转义的字符串字面量，
        // 模型看到的不再是分段的指令，指令遵循度**静默下降**（事件提取质量变差但不报错）。
        // 对照 extractAssets.ts 的同类写法：直接用原文。
        system: eventExtraction || (prompt as string),
        messages: [
          {
            role: "user",
            content:
              "请根据以下小说章节数：" +
              novel.chapterIndex +
              "小说章节券：" +
              novel.reel +
              "小说章节名称：" +
              novel.chapter +
              "、小说章节内容生成事件摘要：\n" +
              novel.chapterData!,
          },
        ],
      });
      const preData = stripThink(resData.text);
      this.emitter.emit("item", { id: novel.id, event: preData });
      return { id: novel.id!, event: preData };
    } catch (e) {
      this.emitter.emit("item", { id: novel.id, event: null, errorReason: u.error(e).message });
      return null;
    }
  }

  async start(allChapters: o_novel[], projectId: number): Promise<EventType[]> {
    const totalEvent: EventType[] = [];

    // 并发控制：通过信号量限制同时执行的任务数
    let running = 0;
    let index = 0;
    const results: Promise<void>[] = [];

    const runNext = (): Promise<void> => {
      if (index >= allChapters.length) return Promise.resolve();
      const novel = allChapters[index++];
      running++;

      return this.processChapter(novel).then((result) => {
        if (result) totalEvent.push(result);
        running--;
        return runNext();
      });
    };

    // 启动最多 concurrency 个并发任务
    const workers = Array.from({ length: Math.min(this.concurrency, allChapters.length) }, () => runNext());

    await Promise.all(workers);

    return totalEvent;
  }
}

export default CleanNovel;
