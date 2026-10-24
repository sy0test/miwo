/**
 * 转绘分镜层（M3-T12）：解析 + 校验 + prompt 的纯函数测试。
 *
 * 用生产解析器（`utils/shots/storyboardTable`，G9）解析同一份 markdown，因此这里同时钉住：
 *  · 转绘输出契约（两块 XML）能被生产解析器吃下；
 *  · 转绘规则（4..cap 秒、镜和=段头、资产名必须在已确认清单、≤3 镜）逐条生效；
 *  · videoDesc 是生产 v2 的管道格式（含「承接上镜」）。
 */
import { describe, expect, it } from "vitest";
import {
  StoryboardValidationError,
  attachVideoDesc,
  buildStoryboardPrompt,
  parseChangeSummary,
  parseStoryboardOutput,
  renderSourceStoryboard,
  validateRedrawStoryboard,
} from "@/redraw/storyboard";

export const VALID_REPLY = [
  "<redrawStoryboard>",
  "## 场1：圣修学院礼堂 ｜ 参演角色：Lucia、Saint Hall",
  "### 片段一（约11s）",
  "**引用资产名称**：[Lucia, Saint Hall]",
  "**引用资产ID**：[87, 17]",
  "| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 光影氛围 | 台词 | 音效 |",
  "|------|------|------|------|------|------|------|------|",
  "| 1 | 银发少女推开礼堂大门，尘土在光束里翻涌 | 4 | 全景 | 缓慢前移 | 冷调侧光 | Lucia says: \"So this is where it began.\"（这里就是一切的起点。） | 木门吱呀 |",
  "| 2 | 她停在账本前，指尖悬在封面上 | 3 | 近景 | 固定 | 顶光偏暗 | 无台词 | 呼吸声 |",
  "| 3 | 翻开账本，纸页发黄 | 4 | 特写 | 轻微推近 | 暖色台灯 | 无台词 | 翻页声 |",
  "### 片段二（约10s）",
  "**引用资产名称**：[Lucia]",
  "**引用资产ID**：[87]",
  "| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 光影氛围 | 台词 | 音效 |",
  "|------|------|------|------|------|------|------|------|",
  "| 1 | Lucia 抬头看向窗外 | 5 | 中景 | 横移 | 晨光 | 无台词 | 鸟鸣 |",
  "| 2 | 她合上账本离开 | 5 | 全景 | 后拉 | 冷调 | Lucia says: \"Not yet.\"（还没到时候。） | 脚步声 |",
  "</redrawStoryboard>",
  "<changeSummary>",
  "- 角色「沈公子」→「Lucia（女）」",
  "- 第 3 段由 12s 调整到 15s（适配单段上限）",
  "</changeSummary>",
].join("\n");

const CONFIRMED = new Map<string, number>([
  ["Lucia", 87],
  ["Saint Hall", 17],
]);

describe("parseStoryboardOutput", () => {
  it("解析两块：片段/镜/资产名 + 变更摘要", () => {
    const out = parseStoryboardOutput(VALID_REPLY);
    expect(out.parsed.segments.length).toBe(2);
    expect(out.parsed.shots.length).toBe(5);
    expect(out.parsed.segments[0].assetNames).toEqual(["Lucia", "Saint Hall"]);
    expect(out.parsed.segments[0].declaredSec).toBe(11);
    expect(out.changes).toEqual(["角色「沈公子」→「Lucia（女）」", "第 3 段由 12s 调整到 15s（适配单段上限）"]);
  });

  it("缺 <redrawStoryboard> / <changeSummary> → 422（缺一失败）", () => {
    expect(() => parseStoryboardOutput(VALID_REPLY.replace(/<redrawStoryboard>[\s\S]*?<\/redrawStoryboard>/, ""))).toThrow(StoryboardValidationError);
    expect(() => parseStoryboardOutput(VALID_REPLY.replace(/<changeSummary>[\s\S]*?<\/changeSummary>/, ""))).toThrow(/changeSummary/);
  });

  it("changeSummary 为空 → 422（不许交白卷）", () => {
    const empty = VALID_REPLY.replace(/<changeSummary>[\s\S]*?<\/changeSummary>/, "<changeSummary>\n</changeSummary>");
    expect(() => parseStoryboardOutput(empty)).toThrow(/没有任何变更条目/);
  });

  it("parseChangeSummary 容忍 - / * / 数字编号", () => {
    expect(parseChangeSummary("- a\n* b\n1. c\n\n")).toEqual(["a", "b", "c"]);
    expect(parseChangeSummary(null)).toEqual([]);
  });
});

describe("validateRedrawStoryboard", () => {
  it("合格产出 → 计划（时长/资产 ID 映射正确）", () => {
    const out = parseStoryboardOutput(VALID_REPLY);
    const plans = validateRedrawStoryboard(out.parsed, { segmentCap: 15, confirmedAssets: CONFIRMED });
    expect(plans.length).toBe(2);
    expect(plans[0]).toMatchObject({ segmentIndex: 1, duration: 11, assetNames: ["Lucia", "Saint Hall"], assetIds: [87, 17] });
    expect(plans[1].assetIds).toEqual([87]);
  });

  it("★ 段时长超上限 / 低于下限 → 422", () => {
    const out = parseStoryboardOutput(VALID_REPLY);
    expect(() => validateRedrawStoryboard(out.parsed, { segmentCap: 10, confirmedAssets: CONFIRMED })).toThrow(/超过单段上限/);
    // 构造 3s 的段（低于 4s 下限）
    const tiny = VALID_REPLY.replace("### 片段一（约11s）", "### 片段一（约3s）").replace(
      /\| 1 \| 银发少女[^\n]*\n\| 2 \| 她停在账本前[^\n]*\n\| 3 \| 翻开账本[^\n]*/,
      "| 1 | 开门 | 3 | 全景 | 固定 | 冷光 | 无台词 | 门声 |",
    );
    const tinyOut = parseStoryboardOutput(tiny);
    expect(() => validateRedrawStoryboard(tinyOut.parsed, { segmentCap: 15, confirmedAssets: CONFIRMED })).toThrow(/小于下限 4s/);
  });

  it("★ 镜时长之和 ≠ 段头声明 → 422", () => {
    const bad = VALID_REPLY.replace("### 片段一（约11s）", "### 片段一（约12s）");
    const out = parseStoryboardOutput(bad);
    expect(() => validateRedrawStoryboard(out.parsed, { segmentCap: 15, confirmedAssets: CONFIRMED })).toThrow(/镜时长之和/);
  });

  it("★ 引用了未确认资产名 → 422 并点名", () => {
    const bad = VALID_REPLY.replace("**引用资产名称**：[Lucia, Saint Hall]", "**引用资产名称**：[Lucia, 沈公子]");
    const out = parseStoryboardOutput(bad);
    try {
      validateRedrawStoryboard(out.parsed, { segmentCap: 15, confirmedAssets: CONFIRMED });
      throw new Error("应当抛错");
    } catch (e: any) {
      expect(e).toBeInstanceOf(StoryboardValidationError);
      expect(e.message).toContain("沈公子");
      expect(e.message).toContain("未确认");
    }
  });

  it("段内镜数 > 3 → 422（视频模型单条最多 3 个参考）", () => {
    const out = parseStoryboardOutput(VALID_REPLY);
    expect(() => validateRedrawStoryboard(out.parsed, { segmentCap: 15, confirmedAssets: CONFIRMED, maxShotsPerSegment: 2 })).toThrow(/超过单段上限 2 个/);
  });
});

describe("attachVideoDesc / prompt", () => {
  it("videoDesc 是生产 v2 管道格式：首段开场句、后续段「承接上镜」+ 表格行", () => {
    const out = parseStoryboardOutput(VALID_REPLY);
    const plans = attachVideoDesc(validateRedrawStoryboard(out.parsed, { segmentCap: 15, confirmedAssets: CONFIRMED }), out.parsed);
    expect(plans[0].videoDesc).toContain("本片段为开场");
    expect(plans[1].videoDesc).toContain("承接上镜：");
    expect(plans[1].videoDesc).toContain("| 1 |");
    expect(plans[1].videoDesc.split("\n").length).toBe(3); // 承接句 + 2 行镜
  });

  it("prompt 含已确认资产（名字+ID）、单段上限、剧本、源片分镜", () => {
    const source = renderSourceStoryboard(
      [{ segmentIndex: 1, sceneIndex: 1, sceneTitle: "旧礼堂", duration: 11, sourceRange: "0.000-11.000" }],
      [{ segmentIndex: 1, shotIndex: 1, duration: 4, shotSize: "全景", camera: "固定", light: "冷光", action: "推门", dialogue: "无台词", sfx: "门声", sourceRange: "0.000-4.000" }],
      new Map([[1, ["沈公子"]]]),
    );
    expect(source).toContain("### 片段1（约11s）");
    expect(source).toContain("引用资产名称");
    expect(source).toContain("推门");

    const prompt = buildStoryboardPrompt(
      {
        projectName: "p",
        targetCountry: "美国",
        segmentCap: 15,
        scriptContent: "剧本正文",
        directorPlan: "导演计划",
        sourceStoryboard: source,
        confirmedAssets: [{ id: 87, name: "Lucia", type: "role", describe: "银发" }],
      },
      { system: "技能正文占位" },
    );
    expect(prompt.system).toBe("技能正文占位");
    expect(prompt.user).toContain("[87] Lucia（role）：银发");
    expect(prompt.user).toContain("单段上限：15s");
    expect(prompt.user).toContain("剧本正文");
    expect(prompt.user).toContain("导演计划");
    expect(prompt.user).toContain("源片分镜");
  });
});