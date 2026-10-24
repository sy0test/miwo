/**
 * 预处理编排 + `redraw.prepare` job（M1-T3）的测试。
 *
 * 分两段：
 *   A. `runPrep` —— 注入假依赖，断言**产物契约**与阶段顺序（不需要 ffmpeg/Python/样本视频）；
 *   B. `runRedrawPrepare` —— 对着真 SQLite（跑全量迁移）断言状态转移：
 *      成功 `extractState=1` + `redrawState=1`；失败 `-1` + errorReason 含原因；体检 error 级整集失败。
 *
 * ⚠ 这两段合在一个文件里是刻意的：M1 的验收口径就是"产物齐全 + 状态正确"，
 *   拆开会让"runPrep 成功但 handler 没置状态"这种缺口分别绿。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { MIGRATIONS, makeMigrationSource } from "@/db/migrations";
import { runPrep, type PrepDeps } from "@/redraw/prep/prep";
import { runRedrawPrepare, redrawPrepare, type RedrawPrepareDeps } from "@/jobs/handlers/redrawPrepare";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-redraw-prep-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function freshPrepDir(): string {
  const dir = path.join(TMP, "prep-" + ++seq);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ============================================================
// A. runPrep（注入依赖）
// ============================================================

type FakeState = {
  gridFiles: number;
  cuts: Array<{ at: number; score: number }>;
  transcript: { language: string; duration: number; segments: any[]; words: any[] };
  hasAudio: boolean;
  duration?: number;
  failProbe?: boolean;
  failTranscribe?: boolean;
};

function fakeDeps(s: FakeState): { deps: PrepDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: PrepDeps = {
    probe: async () => {
      calls.push("probe");
      if (s.failProbe) throw new Error("ffprobe 读到坏文件");
      return { duration: s.duration, hasAudio: s.hasAudio };
    },
    renderGrid: async (_video, gridDir, o) => {
      calls.push("grid");
      // 按每页行列算页数（与生产实现同口径），但只写空文件
      const span = o.cols * o.rowsPerPage * o.intervalSec;
      const pages = Math.max(1, Math.ceil((o.duration || span) / span));
      const out: string[] = [];
      for (let i = 0; i < Math.min(pages, s.gridFiles); i += 1) {
        const f = path.join(gridDir, "grid-" + String(i + 1).padStart(2, "0") + ".jpg");
        fs.mkdirSync(gridDir, { recursive: true });
        fs.writeFileSync(f, "jpg");
        out.push(f);
      }
      return out;
    },
    detectCuts: async () => {
      calls.push("cuts");
      return s.cuts;
    },
    extractWav: async (_video, wavAbs) => {
      calls.push("wav");
      fs.writeFileSync(wavAbs, "wav");
    },
    transcribe: async () => {
      calls.push("transcribe");
      if (s.failTranscribe) throw new Error("ASR 模型加载失败");
      return s.transcript;
    },
  };
  return { deps, calls };
}

const WORDS = [
  { word: "第一句", start: 0.1, end: 0.8 },
  { word: "第二句", start: 4.2, end: 5.0 },
];
const TRANSCRIPT = {
  language: "zh",
  duration: 10,
  segments: [
    { start: 0, end: 2.5, text: "第一句" },
    { start: 4, end: 5.5, text: "第二句" },
  ],
  words: WORDS,
};

describe("runPrep：产物契约（spec §5.1）", () => {
  it("写齐 grid / cuts.json / cuts.txt / transcript.json / MANIFEST / prep.log，并按阶段回调", async () => {
    const prepDir = freshPrepDir();
    const stages: string[] = [];
    const { deps, calls } = fakeDeps({
      gridFiles: 99,
      cuts: [{ at: 3, score: 0.9 }, { at: 6.5, score: 0.8 }],
      transcript: TRANSCRIPT,
      hasAudio: true,
      duration: 10,
    });
    const r = await runPrep("/tmp/a.mp4", prepDir, deps, {
      onStage: (stage, percent) => {
        stages.push(stage + ":" + percent);
      },
    });

    // 产物
    expect(r.grids.length).toBe(1); // 10s / (12*12*1) = 1 页
    expect(fs.existsSync(path.join(prepDir, "cuts.json"))).toBe(true);
    expect(fs.existsSync(path.join(prepDir, "cuts.txt"))).toBe(true);
    expect(fs.existsSync(path.join(prepDir, "transcript.json"))).toBe(true);
    expect(fs.existsSync(path.join(prepDir, "MANIFEST.md"))).toBe(true);
    expect(fs.existsSync(path.join(prepDir, "prep.log"))).toBe(true);

    // 切点：3 / 6.5（最短镜 0.4 都满足）
    expect(r.cuts).toEqual([3, 6.5]);
    const cutsJson = JSON.parse(fs.readFileSync(path.join(prepDir, "cuts.json"), "utf8"));
    expect(cutsJson.cuts).toEqual([3, 6.5]);
    expect(cutsJson.shots.length).toBe(3);
    expect(fs.readFileSync(path.join(prepDir, "cuts.txt"), "utf8")).toContain("镜 1: 0.000 - 3.000");

    // transcript.json：**同时**有 passages（下游读）与 words（新形状）
    const tr = JSON.parse(fs.readFileSync(path.join(prepDir, "transcript.json"), "utf8"));
    expect(tr.words.length).toBe(2);
    expect(tr.passages.length).toBe(2);
    expect(tr.passages[0].words[0]).toMatchObject({ text: "第一句", start_seconds: 0.1 });
    expect(tr.language).toBe("zh");

    // MANIFEST：analyze 的解析正则要能抠出采样密度与时长
    const manifest = fs.readFileSync(path.join(prepDir, "MANIFEST.md"), "utf8");
    expect(manifest).toMatch(/\*\*采样密度：(\d+(?:\.\d+)?)s\/格\*\*/);
    expect(manifest).toMatch(/时长：(\d+(?:\.\d+)?)s/);
    expect(manifest).toContain("切点数：2");

    // 阶段顺序：grid → cut → transcribe（末尾 90）→ 不是乱序
    expect(stages).toEqual(["grid:5", "cut:30", "transcribe:55", "transcribe:90"]);
    expect(calls).toEqual(["probe", "grid", "cuts", "wav", "transcribe"]);
    expect(r.wordCount).toBe(2);
    expect(r.videoSec).toBe(10);
  });

  it("无音轨：跳过转写、写空转写稿、给 warning（不是失败）", async () => {
    const prepDir = freshPrepDir();
    const { deps, calls } = fakeDeps({
      gridFiles: 99,
      cuts: [{ at: 3, score: 0.9 }],
      transcript: { language: "", duration: 0, segments: [], words: [] },
      hasAudio: false,
      duration: 10,
    });
    const r = await runPrep("/tmp/a.mp4", prepDir, deps);
    expect(calls).not.toContain("transcribe");
    expect(calls).not.toContain("wav");
    expect(r.warnings.join(" ")).toContain("没有音轨");
    const tr = JSON.parse(fs.readFileSync(path.join(prepDir, "transcript.json"), "utf8"));
    expect(tr.words).toEqual([]);
    expect(tr.passages).toEqual([]);
  });

  it("读不到时长：给出 warning 但继续（拼贴图 1 页）", async () => {
    const prepDir = freshPrepDir();
    const { deps } = fakeDeps({
      gridFiles: 99,
      cuts: [{ at: 3, score: 0.9 }],
      transcript: TRANSCRIPT,
      hasAudio: true,
      duration: undefined,
    });
    const r = await runPrep("/tmp/a.mp4", prepDir, deps);
    expect(r.warnings.join(" ")).toContain("读不到源片时长");
    expect(r.videoSec).toBeNull();
  });

  it("★ 切点候选 0 个 → 报错（不生成空切点表）", async () => {
    const prepDir = freshPrepDir();
    const { deps } = fakeDeps({ gridFiles: 99, cuts: [], transcript: TRANSCRIPT, hasAudio: true, duration: 10 });
    await expect(runPrep("/tmp/a.mp4", prepDir, deps)).rejects.toThrow(/切点检测 0 个候选/);
    expect(fs.existsSync(path.join(prepDir, "cuts.txt"))).toBe(false);
  });

  it("★ 转写没有词级时间戳 → 报错（不静默降级）", async () => {
    const prepDir = freshPrepDir();
    const { deps } = fakeDeps({
      gridFiles: 99,
      cuts: [{ at: 3, score: 0.9 }],
      transcript: { language: "zh", duration: 10, segments: [], words: [] },
      hasAudio: true,
      duration: 10,
    });
    await expect(runPrep("/tmp/a.mp4", prepDir, deps)).rejects.toThrow(/词级时间戳/);
  });

  it("转写抛错 → 错误消息带「转写失败」前缀与原因", async () => {
    const prepDir = freshPrepDir();
    const { deps } = fakeDeps({
      gridFiles: 99,
      cuts: [{ at: 3, score: 0.9 }],
      transcript: TRANSCRIPT,
      hasAudio: true,
      duration: 10,
      failTranscribe: true,
    });
    await expect(runPrep("/tmp/a.mp4", prepDir, deps)).rejects.toThrow(/转写失败：ASR 模型加载失败/);
  });

  it("拼贴图 0 张 → 报错（不产出空产物目录）", async () => {
    const prepDir = freshPrepDir();
    const { deps } = fakeDeps({ gridFiles: 0, cuts: [{ at: 3, score: 0.9 }], transcript: TRANSCRIPT, hasAudio: true, duration: 10 });
    await expect(runPrep("/tmp/a.mp4", prepDir, deps)).rejects.toThrow(/拼贴图 0 张/);
  });
});

// ============================================================
// B. runRedrawPrepare（真 SQLite + 假预处理/假解析）
// ============================================================

const DB_DIR = path.join(TMP, "db");
fs.mkdirSync(DB_DIR, { recursive: true });
let db: Knex;
let projectId = 0;

beforeAll(async () => {
  const cfg = {
    env: "dev",
    port: 10599,
    host: "127.0.0.1",
    dataDir: TMP,
    mediaDir: path.join(TMP, "oss"),
    storageDriver: "local",
    publicBaseUrl: "http://127.0.0.1:10599",
    trustProxy: 0,
    jwtSecret: "x".repeat(48),
    db: { driver: "sqlite", file: path.join(DB_DIR, "prep.sqlite") },
  } as MiwoConfig;
  db = createKnex(cfg);
  await db.migrate.latest({ migrationSource: makeMigrationSource(MIGRATIONS) });
  // ⚠ o_project.id 是 bigInteger primary（**不是自增**：生产代码用 Date.now() 显式给），必须显式指定
  projectId = 9001;
  await db("o_project").insert({ id: projectId, name: "转绘项目", projectType: "redraw", targetCountry: "美国" });
});

afterAll(async () => {
  await db.destroy().catch(() => {});
});

let sidSeq = 0;
async function newScript(init: Record<string, unknown> = {}): Promise<number> {
  const [id] = await db("o_script").insert({
    name: "第" + ++sidSeq + "集",
    projectId,
    sourceVideo: "/" + projectId + "/source/a.mp4",
    extractState: 0,
    redrawState: 0,
    ...init,
  });
  return Number(id);
}

function fakeDeps2(o: {
  stages: string[];
  prepThrows?: Error;
  analyzeResult?: any;
  analyzeThrows?: Error;
}): RedrawPrepareDeps {
  return {
    resolveVideo: async () => "/tmp/source.mp4",
    prepDirOf: () => freshPrepDir(),
    runPrep: async (_v, _dir, onStage) => {
      await onStage("grid", 5);
      await onStage("cut", 30);
      await onStage("transcribe", 90);
      if (o.prepThrows) throw o.prepThrows;
      return { cuts: [3, 6], wordCount: 2, grids: ["g"], warnings: [] };
    },
    analyze: async () => {
      if (o.analyzeThrows) throw o.analyzeThrows;
      return (
        o.analyzeResult ?? {
          scriptId: 0,
          assets: 2,
          writtenAssets: 0,
          segments: 3,
          storyboards: 5,
          missingAssetNames: [],
          issues: [],
          outputPath: "",
          grids: 1,
          promptChars: 0,
          systemChars: 0,
          scriptBodyChars: 0,
          directorPlanChars: 0,
        }
      );
    },
    reportStage: async (stage, percent) => {
      o.stages.push(stage + ":" + percent);
    },
  };
}

const OK_RESULT = {
  scriptId: 0,
  assets: 2,
  writtenAssets: 0,
  segments: 3,
  storyboards: 5,
  missingAssetNames: [],
  issues: [],
  outputPath: "",
  grids: 1,
  promptChars: 0,
  systemChars: 0,
  scriptBodyChars: 0,
  directorPlanChars: 0,
};

describe("runRedrawPrepare：状态转移", () => {
  it("★ 成功：extractState=1 + redrawState=1 + errorReason 清空；grid 阶段折成前端的 cut", async () => {
    const scriptId = await newScript({ extractState: 0, redrawState: 1, errorReason: "上一次的错" });
    const stages: string[] = [];
    const r = await runRedrawPrepare(db, { projectId, scriptId }, fakeDeps2({ stages }));

    const row = await db("o_script").where("id", scriptId).first();
    expect(Number(row.extractState)).toBe(1);
    expect(Number(row.redrawState)).toBe(1);
    expect(row.errorReason).toBeNull();
    expect(r.segments).toBe(3);
    expect(r.assets).toBe(2);
    // 阶段：prep 的 grid 必须折成 cut（前端契约只有 cut/transcribe/analyze），最后 analysis 100
    expect(stages).toEqual(["cut:5", "cut:30", "transcribe:90", "analysis:92", "analysis:100"]);
  });

  it("★ 重新分析：redrawState=4/2 时解析成功 → 1（spec §4.2 的 2/3/4 → 1）", async () => {
    for (const from of [2, 4]) {
      const scriptId = await newScript({ extractState: 1, redrawState: from });
      await runRedrawPrepare(db, { projectId, scriptId, replace: true }, fakeDeps2({ stages: [] }));
      expect(Number((await db("o_script").where("id", scriptId).first()).redrawState), "from=" + from).toBe(1);
    }
  });

  it("★ 解析失败：extractState=-1、redrawState=-1、errorReason 带原原因；旧状态不丢成 0", async () => {
    const scriptId = await newScript({ extractState: 1, redrawState: 2 });
    const stages: string[] = [];
    const deps = fakeDeps2({ stages, analyzeThrows: new Error("模型回复里缺块：<storyboardTable>") });
    await expect(runRedrawPrepare(db, { projectId, scriptId }, deps)).rejects.toThrow(/缺块/);

    const row = await db("o_script").where("id", scriptId).first();
    expect(Number(row.extractState)).toBe(-1);
    expect(Number(row.redrawState)).toBe(-1);
    expect(row.errorReason).toContain("缺块");
    // 进度停在最后成功的阶段（前端能看出卡在哪）
    expect(stages).toContain("transcribe:90");
  });

  it("★ 体检 error 级 → 整集失败（与旧 analyzeSource 的口径一致）", async () => {
    const scriptId = await newScript({ extractState: 0, redrawState: 1 });
    const deps = fakeDeps2({
      stages: [],
      analyzeResult: { ...OK_RESULT, issues: [{ level: "error", shotIndex: 2, message: "区间解析不出来" }] },
    });
    await expect(runRedrawPrepare(db, { projectId, scriptId }, deps)).rejects.toThrow(/体检没过/);
    const row = await db("o_script").where("id", scriptId).first();
    expect(Number(row.extractState)).toBe(-1);
    expect(row.errorReason).toContain("区间解析不出来");
  });

  it("预处理失败：同样落 -1（原因带「转写失败」）", async () => {
    const scriptId = await newScript({ extractState: 0, redrawState: 1 });
    const deps = fakeDeps2({ stages: [], prepThrows: new Error("转写失败：没有词级时间戳") });
    await expect(runRedrawPrepare(db, { projectId, scriptId }, deps)).rejects.toThrow(/转写失败/);
    const row = await db("o_script").where("id", scriptId).first();
    expect(Number(row.extractState)).toBe(-1);
    expect(Number(row.redrawState)).toBe(-1);
    expect(row.errorReason).toContain("词级时间戳");
  });

  it("没有源片 / 跨项目的集：直接抛错，不把 extractState 改成 0", async () => {
    const noSource = await newScript({ sourceVideo: null });
    await expect(runRedrawPrepare(db, { projectId, scriptId: noSource }, fakeDeps2({ stages: [] }))).rejects.toThrow(/没有源片/);
    expect(Number((await db("o_script").where("id", noSource).first()).extractState)).toBe(0);

    // 跨项目：集存在，但不属于这个项目 → 查不到（报"没有这条源片"，不是"项目不存在"）
    const otherProject = 9002;
    await db("o_project").insert({ id: otherProject, name: "另一个项目" });
    const [otherScript] = await db("o_script").insert({ name: "别人的集", projectId: otherProject, sourceVideo: "/x.mp4", extractState: 1 });
    await expect(
      runRedrawPrepare(db, { projectId, scriptId: Number(otherScript) }, fakeDeps2({ stages: [] })),
    ).rejects.toThrow(/没有这条源片/);
  });
});

describe("redraw.prepare 任务定义（R1-G2 / G7）", () => {
  it("类型 / 超时 / 重试 / 池", () => {
    expect(redrawPrepare.type).toBe("redraw.prepare");
    expect(redrawPrepare.timeoutMs).toBe(30 * 60 * 1000);
    // 解析调模型（计费）⇒ 自动重试 = 自动重复扣费，必须 1
    expect(redrawPrepare.maxAttempts).toBe(1);
    expect(redrawPrepare.pool).toBe("vendor:text");
  });

  it("parse：合法 payload 通过；缺 id / 非整数 / 字符串一律拒绝", () => {
    expect(redrawPrepare.parse({ projectId: 1, scriptId: 2 })).toEqual({ projectId: 1, scriptId: 2 });
    expect(redrawPrepare.parse({ projectId: 1, scriptId: 2, replace: true, lang: " zh " })).toEqual({
      projectId: 1,
      scriptId: 2,
      replace: true,
      lang: "zh",
    });
    for (const bad of [null, {}, { projectId: 1 }, { projectId: "1", scriptId: 2 }, { projectId: 1, scriptId: 0 }]) {
      expect(() => redrawPrepare.parse(bad as any), JSON.stringify(bad)).toThrow();
    }
  });

  it("★ 幂等键：redraw.prepare:{projectId}:{scriptId}:{replace?1:0}", () => {
    expect(redrawPrepare.dedupeKey({ projectId: 7, scriptId: 9 }, 1)).toBe("redraw.prepare:7:9:0");
    expect(redrawPrepare.dedupeKey({ projectId: 7, scriptId: 9, replace: true }, 1)).toBe("redraw.prepare:7:9:1");
  });
});