/**
 * 原生切点检测（M1-T1）的纯函数单测。
 *
 * 覆盖 spec §5.2 的四条约束：
 *   ① 同一次过渡的多候选合并取最高分；
 *   ② gapSec=0.25 边界（≤0.25 同簇、>0.25 分簇）；
 *   ③ 距片头/片尾 0.2s 内丢弃；
 *   ④ 最短镜 0.4s（含首镜从 0 起算）；
 * 外加：乱序输入、空输入、重复候选、ffmpeg 输出解析（含杂音行）、detectCuts 的参数与错误翻译。
 * 没有样本视频也能跑 —— 这正是把「聚类」与「跑 ffmpeg」分开的原因。
 */
import { describe, expect, it } from "vitest";
import { clusterCuts, detectCuts, detectCutCandidates, parseSceneScores } from "@/redraw/prep/cuts";

describe("clusterCuts：同一次过渡合并", () => {
  it("0.25s 内的多帧候选合成一个切点，取分数最高者", () => {
    const cuts = clusterCuts([
      { at: 5.0, score: 0.31 },
      { at: 5.12, score: 0.72 },
      { at: 5.24, score: 0.45 },
    ]);
    expect(cuts).toEqual([5.12]);
  });

  it("★ gap=0.25 是闭区间：恰好 0.25 同簇，0.251 分簇（边界不能靠感觉）", () => {
    expect(clusterCuts([{ at: 5.0, score: 0.5 }, { at: 5.25, score: 0.9 }])).toEqual([5.25]);
    // 把最短镜降到 0.1 以**只**检验 gap 的边界语义（默认 0.4 会先把这个切点按最短镜丢掉）
    expect(clusterCuts([{ at: 5.0, score: 0.5 }, { at: 5.251, score: 0.9 }], { minShotSec: 0.1 })).toEqual([5.0, 5.251]);
  });

  it("同分取更早的那一个（镜序语义：不让后一簇顶掉前一簇）", () => {
    expect(clusterCuts([{ at: 5.0, score: 0.5 }, { at: 5.2, score: 0.5 }])).toEqual([5.0]);
  });

  it("乱序输入先排序；重复候选不会重复输出", () => {
    const cuts = clusterCuts([
      { at: 12.5, score: 0.4 },
      { at: 5.0, score: 0.8 },
      { at: 5.0, score: 0.8 },
      { at: 20.0, score: 0.5 },
    ]);
    expect(cuts).toEqual([5.0, 12.5, 20.0]);
  });
});

describe("clusterCuts：首尾与最短镜约束", () => {
  it("片头 0.2s 内、片尾 0.2s 内的候选丢弃", () => {
    const cands = [
      { at: 0.1, score: 0.9 },
      { at: 5.0, score: 0.8 },
      { at: 9.9, score: 0.9 },
    ];
    expect(clusterCuts(cands, { duration: 10 })).toEqual([5.0]);
    // 没有 duration 时只做片头约束（tail 无从判断）
    expect(clusterCuts(cands)).toEqual([5.0, 9.9]);
  });

  it("最短镜 0.4s：首个切点必须距片头 ≥0.4s", () => {
    expect(clusterCuts([{ at: 0.2, score: 0.9 }, { at: 3.0, score: 0.9 }])).toEqual([3.0]);
    expect(clusterCuts([{ at: 0.39, score: 0.9 }])).toEqual([]);
    expect(clusterCuts([{ at: 0.4, score: 0.9 }])).toEqual([0.4]);
  });

  it("最短镜 0.4s：相邻切点间距不足时保留前一个（时间顺序优先）", () => {
    const cuts = clusterCuts([
      { at: 5.0, score: 0.3 },
      { at: 5.35, score: 0.9 }, // 距 5.0 只有 0.35s → 丢
      { at: 6.0, score: 0.4 },
    ]);
    expect(cuts).toEqual([5.0, 6.0]);
  });

  it("末镜短于 0.4s 的切点丢弃（有 duration 时）", () => {
    expect(clusterCuts([{ at: 9.8, score: 0.9 }], { duration: 10 })).toEqual([]);
    expect(clusterCuts([{ at: 9.5, score: 0.9 }], { duration: 10 })).toEqual([9.5]);
  });

  it("空输入 / 全非法输入 → []（不抛错）", () => {
    expect(clusterCuts([])).toEqual([]);
    expect(clusterCuts([{ at: Number.NaN, score: 1 }, { at: 3, score: -1 }])).toEqual([]);
  });
});

describe("parseSceneScores：ffmpeg metadata=print 的输出", () => {
  it("成对的 pts_time + scene_score → 候选；乱序与杂音行被容忍", () => {
    const text = [
      "ffmpeg version 6.0 Copyright (c) 2000-2023",
      "[Parsed_metadata_2 @ 000001] frame:12   pts:512   pts_time:0.512",
      "[Parsed_metadata_2 @ 000001] lavfi.scene_score=0.184219",
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':",
      "[Parsed_metadata_2 @ 000001] frame:60   pts:2560  pts_time:2.560",
      "[Parsed_metadata_2 @ 000001] lavfi.scene_score=0.812500",
      "[Parsed_metadata_2 @ 000001] frame:10   pts:400   pts_time:0.400",
      "[Parsed_metadata_2 @ 000001] lavfi.scene_score=0.300000",
    ].join("\n");
    expect(parseSceneScores(text)).toEqual([
      { at: 0.4, score: 0.3 },
      { at: 0.512, score: 0.184219 },
      { at: 2.56, score: 0.8125 },
    ]);
  });

  it("只有 pts 没有 score（或反之）不产出候选", () => {
    expect(parseSceneScores("[x] pts_time:1.0\n[x] scene_score=0.5")).toEqual([{ at: 1.0, score: 0.5 }]);
    expect(parseSceneScores("[x] pts_time:1.0")).toEqual([]);
    expect(parseSceneScores("[x] scene_score=0.5")).toEqual([]);
    expect(parseSceneScores("")).toEqual([]);
  });
});

describe("detectCuts：ffmpeg 调用与错误翻译", () => {
  it("传给 ffmpeg 的滤镜是 select='gt(scene,0.3)',metadata=print；返回解析后的候选", async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const cands = await detectCuts("/tmp/a.mp4", {
      threshold: 0.3,
      exec: async (bin, args) => {
        calls.push({ bin, args });
        return {
          stdout: "",
          stderr: "[x] pts_time:3.0\n[x] lavfi.scene_score=0.9\n[x] pts_time:6.5\n[x] lavfi.scene_score=0.5",
        };
      },
    });
    expect(cands).toEqual([{ at: 3.0, score: 0.9 }, { at: 6.5, score: 0.5 }]);
    expect(calls.length).toBe(1);
    const filter = calls[0].args[calls[0].args.indexOf("-vf") + 1];
    expect(filter).toBe("select='gt(scene,0.3)',metadata=print");
    expect(calls[0].args).toContain("-an");
    expect(calls[0].args.slice(-2)).toEqual(["null", "-"]);
  });

  it("ENOENT → 明确的「找不到 ffmpeg」文案（不是裸 spawn 错误）", async () => {
    const err: any = new Error("spawn ffmpeg ENOENT");
    err.code = "ENOENT";
    await expect(detectCuts("/tmp/a.mp4", { exec: async () => { throw err; } })).rejects.toThrow(/找不到 ffmpeg|安装 ffmpeg/);
  });

  it("ffmpeg 失败 → 带上 stderr 尾部（客户要能看懂为什么）", async () => {
    const err: any = new Error("Command failed");
    err.stderr = "a.mp4: Invalid data found when processing input\nConversion failed!";
    await expect(detectCutCandidates("/tmp/a.mp4", { exec: async () => { throw err; } })).rejects.toThrow(/Invalid data found/);
  });
});