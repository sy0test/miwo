/**
 * 预处理编排（M1-T3）：拼贴图 + 切点表 + 转写稿 + MANIFEST，产物契约与旧外部脚本**完全一致**
 * （spec §5.1），所以下游 `utils/redrawAnalyze.ts` 与技能一行不改。
 *
 * ── 产物 ──
 *   <prepDir>/grid/grid-01.jpg …  拼贴图（带全局编号 #N；时刻 = (N-1) × 采样密度，见 MANIFEST）
 *   <prepDir>/cuts.json           切点候选 + 聚类后的切点（排查用）
 *   <prepDir>/cuts.txt            切点表（进模型 prompt 的那份）
 *   <prepDir>/transcript.json     转写稿（**同时**写 `passages` 旧形状与 `words` 新形状）
 *   <prepDir>/MANIFEST.md         采样密度 / 时长 / 语种 / 数量
 *   <prepDir>/prep.log            全量日志
 *
 * ── 为什么 transcript.json 要写两种形状 ──
 * 旧外部脚本产出的是 WhisperX 形状（`passages[].words[].{text,start_seconds,end_seconds}`），
 * `redrawAnalyze.formatTranscript` 按它读。ASR 适配器的原生形状是 `words[]/segments[]`。
 * 为了"下游一行不改"，这里把两者都写进同一个文件：下游读 passages，新代码/排查读 words。
 *
 * ── 依赖注入 ──
 * 五个重活（probe / grid / cuts / wav / transcribe）都能注入：单测用假实现即可断言产物与阶段转移，
 * 不需要 ffmpeg、Python、样本视频。生产用 `createDefaultPrepDeps()`（真 ffmpeg + 真 ASR 适配器）。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "@/config";
import { clusterCuts, detectCutCandidates, type CutCandidate } from "@/redraw/prep/cuts";
import { probeVideo } from "@/utils/ffmpeg";
import { transcribe as defaultTranscribe, type AsrTranscript } from "@/utils/asr";

const run = promisify(execFile);

export type PrepVideoMeta = { duration?: number; hasAudio: boolean };

export type GridOptions = {
  duration: number;
  /** 每格覆盖多少秒（旧口径 1s） */
  intervalSec: number;
  cols: number;
  rowsPerPage: number;
  tileWidth: number;
};

export type PrepDeps = {
  probe(videoAbs: string): Promise<PrepVideoMeta>;
  renderGrid(videoAbs: string, gridDir: string, o: GridOptions): Promise<string[]>;
  detectCuts(videoAbs: string): Promise<CutCandidate[]>;
  extractWav(videoAbs: string, wavAbs: string): Promise<void>;
  transcribe(wavAbs: string, o: { language?: string }): Promise<AsrTranscript>;
};

export type PrepStageName = "grid" | "cut" | "transcribe";

export type PrepOptions = {
  lang?: string;
  /** 阶段回调（写 redrawStage 与 job 进度）。抛错会被透传 —— 进度写不进去就别继续跑。 */
  onStage?: (stage: PrepStageName, percent: number) => void | Promise<void>;
  /** 场景阈值（默认 0.3） */
  threshold?: number;
};

export type PrepResult = {
  prepDir: string;
  videoSec: number | null;
  hasAudio: boolean;
  language: string;
  wordCount: number;
  cuts: number[];
  grids: string[];
  transcriptPath: string;
  cutsJsonPath: string;
  cutsTxtPath: string;
  manifestPath: string;
  logPath: string;
  warnings: string[];
};

/** 采样参数（spec §5.4：1s/格、12 列、格宽 120px、每页最多 12 行） */
export const GRID_DEFAULTS = { intervalSec: 1, cols: 12, rowsPerPage: 12, tileWidth: 120 } as const;

/** 仓库内自带字体的目录（CJK 字体二进制不进 git，缺字体时拼贴图只是没有编号，不失败）。 */
export const FONT_DIR = ["assets", "fonts"];

/**
 * 拼贴图标签字体：`config.gridFont`（缺省 = 镜像里的 DejaVuSans，G10）优先；
 * 其次仓库内 `apps/api/assets/fonts/`（本机开发用，字体二进制不进 git）；都没有返回 null。
 * 返回 null 时拼贴图**不加编号**（不因此失败）—— 采样密度公式写在 MANIFEST 里。
 */
export function findGridFont(): string | null {
  const wanted = config.gridFont?.trim();
  if (wanted && fs.existsSync(wanted)) return wanted;
  try {
    const dir = path.resolve(__dirname, "../../assets/fonts");
    if (!fs.existsSync(dir)) return null;
    const hit = fs.readdirSync(dir).find((f) => /\.(ttf|otf|ttc)$/i.test(f));
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

/**
 * 拼贴图渲染（真 ffmpeg）：每页 `cols × rowsPerPage` 格，每格 = `intervalSec` 秒。
 * 画面上叠全局编号 #N（N 从 1 起、跨页连续）—— 模型被要求「第 n 格 = (n-1)×采样密度 秒」，
 * 所以编号**必须全局**，不能每页从 1 重来。
 */
async function renderGridWithFfmpeg(videoAbs: string, gridDir: string, o: GridOptions): Promise<string[]> {
  fs.mkdirSync(gridDir, { recursive: true });
  const spanSec = o.cols * o.rowsPerPage * o.intervalSec;
  const duration = Number.isFinite(o.duration) && o.duration > 0 ? o.duration : spanSec;
  const pages = Math.max(1, Math.ceil(duration / spanSec));
  const font = findGridFont();
  const interval = Number.isInteger(o.intervalSec) ? o.intervalSec : null;
  const files: string[] = [];
  for (let page = 0; page < pages; page += 1) {
    const start = page * spanSec;
    const offset = page * o.cols * o.rowsPerPage;
    const out = path.join(gridDir, "grid-" + String(page + 1).padStart(2, "0") + ".jpg");
    // 编号与时间码都靠 drawtext；没有字体就**不加**（不因此判失败，MANIFEST 里说明了编号/时刻公式）
    const label = font
      ? ",drawtext=fontfile='" + font.replace(/\\/g, "/").replace(/:/g, "\\:") + "'" +
        ":text='#%{eif\\:n+" + offset + "\\:d}" +
        (interval !== null ? " %{eif\\:(n+" + offset + ")*" + interval + "\\:d}s" : "") + "'" +
        ":x=4:y=4:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55"
      : "";
    const vf = "fps=1/" + o.intervalSec + ",scale=" + o.tileWidth + ":-2" + label +
      ",tile=" + o.cols + "x" + o.rowsPerPage + ":padding=4:margin=0";
    await run(
      config.ffmpeg.path,
      ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(start), "-t", String(spanSec), "-i", videoAbs,
       "-vf", vf, "-frames:v", "1", "-q:v", "3", out],
      { timeout: config.ffmpeg.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    ).catch((e: any) => {
      const tail = String(e?.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" | ");
      throw new Error("拼贴图第 " + (page + 1) + " 页渲染失败：" + (tail || e?.message || e));
    });
    files.push(out);
  }
  return files;
}

/** 抽 16k 单声道 wav（faster-whisper 的输入口径）。 */
async function extractWavWithFfmpeg(videoAbs: string, wavAbs: string): Promise<void> {
  fs.mkdirSync(path.dirname(wavAbs), { recursive: true });
  await run(
    config.ffmpeg.path,
    ["-y", "-hide_banner", "-loglevel", "error", "-i", videoAbs, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wavAbs],
    { timeout: config.ffmpeg.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  ).catch((e: any) => {
    const tail = String(e?.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" | ");
    throw new Error("抽音轨失败：" + (tail || e?.message || e));
  });
}

/** 生产依赖（真 ffmpeg + 真本地 ASR）。测试请注入假实现。 */
export function createDefaultPrepDeps(): PrepDeps {
  return {
    probe: (videoAbs) => probeVideo(videoAbs),
    renderGrid: renderGridWithFfmpeg,
    detectCuts: (videoAbs) => detectCutCandidates(videoAbs),
    extractWav: extractWavWithFfmpeg,
    transcribe: (wavAbs, o) => defaultTranscribe(wavAbs, { model: config.asr.model, compute: config.asr.compute, modelDir: config.asr.modelDir, language: o.language }),
  };
}

/** 追加一行日志到 prep.log（每次调用都 append，不持有流 —— 失败时日志也在盘上）。 */
function logTo(logPath: string, msg: string): void {
  try {
    fs.appendFileSync(logPath, "[" + new Date().toISOString() + "] " + msg + "\n");
  } catch {
    // 日志写不进去不影响主流程
  }
}

/** 把切点数组转成「镜」列表（切点 = 镜头边界，最后一段到片尾） */
function toShots(cuts: number[], duration: number | null): Array<{ index: number; start: number; end: number }> {
  const bounds = [0, ...cuts];
  const shots = bounds.map((start, i) => ({
    index: i + 1,
    start,
    end: i + 1 < bounds.length ? bounds[i + 1] : (duration ?? start + 1),
  }));
  return shots;
}

/** cuts.txt：模型读的那份（sanitizeCuts 会剥掉 "# 来源"/"# 采样" 开头的内部注释）。 */
function renderCutsTxt(cuts: number[], duration: number | null, threshold: number): string {
  const shots = toShots(cuts, duration);
  const lines = [
    "# 切点表（原生 ffmpeg scene 检测）",
    "# 来源：detectCutCandidates threshold=" + threshold.toFixed(2),
    "# 镜号  起-止（秒）",
  ];
  for (const s of shots) lines.push("镜 " + s.index + ": " + s.start.toFixed(3) + " - " + s.end.toFixed(3));
  return lines.join("\n") + "\n";
}

/**
 * 转写稿 → 下游兼容形状。
 * passages 按 segment 分组（每个 segment 收集时间上落在它里面的词）；没有 segment 时全部塞进一个 passage。
 */
function buildTranscriptJson(t: AsrTranscript, videoSec: number | null): string {
  // 无语音（无声源片）：segments/passages 都是空，**不**造假条目
  if (!t.words.length && !t.segments.length) {
    return JSON.stringify({ language: t.language, duration: t.duration || videoSec || 0, segments: [], words: [], passages: [] }, null, 2);
  }
  const segs = t.segments.length
    ? t.segments
    : [{ start: 0, end: t.words[t.words.length - 1].end, text: t.words.map((w) => w.word).join("") }];
  const passages = segs.map((s) => ({
    start_seconds: s.start,
    end_seconds: s.end,
    text: s.text,
    words: t.words
      .filter((w) => w.start >= s.start - 0.001 && w.start < s.end + 0.001)
      .map((w) => ({ text: w.word, start_seconds: w.start, end_seconds: w.end })),
  }));
  return JSON.stringify({ language: t.language, duration: t.duration || videoSec || 0, segments: t.segments, words: t.words, passages }, null, 2);
}

function renderManifest(o: {
  videoName: string;
  videoSec: number | null;
  hasAudio: boolean;
  language: string;
  wordCount: number;
  cutCount: number;
  gridCount: number;
  threshold: number;
  warnings: string[];
}): string {
  const lines = [
    "# 预处理清单（MANIFEST）",
    "",
    "- 源片：" + o.videoName,
    "- **采样密度：" + GRID_DEFAULTS.intervalSec + "s/格**",
    "- 时长：" + (o.videoSec === null ? "未知" : o.videoSec.toFixed(3) + "s"),
    "- 拼贴图：" + o.gridCount + " 张（" + GRID_DEFAULTS.cols + " 列 × " + GRID_DEFAULTS.rowsPerPage + " 行/页，格宽 " + GRID_DEFAULTS.tileWidth + "px）",
    "- 切点数：" + o.cutCount + "（阈值 " + o.threshold.toFixed(2) + "）",
    "- 语种：" + (o.language || "未知"),
    "- 词级时间戳： " + o.wordCount + " 个词",
    "- 音轨：" + (o.hasAudio ? "有" : "无（本集不做转写）"),
    "- 第 n 格的时刻 = (n-1) × " + GRID_DEFAULTS.intervalSec + " 秒（编号跨页连续，印在格子上）",
    "",
  ];
  if (o.warnings.length) lines.push("## 警告", "", ...o.warnings.map((w) => "- " + w), "");
  return lines.join("\n");
}

/**
 * 跑完整预处理。失败时抛错（消息里带阶段名），已产出的文件留在盘上供复盘。
 *
 * 阶段：grid（含 probe）→ cut → transcribe。无音轨时跳过 transcribe 并写空转写稿
 * （下游 `analyzeRedrawAssets` 要求 transcript.json 存在；无语音的源片是合法输入，不是错误）。
 */
export async function runPrep(
  videoAbs: string,
  prepDir: string,
  deps: PrepDeps,
  opts: PrepOptions = {},
): Promise<PrepResult> {
  const threshold = opts.threshold ?? 0.3;
  const prepLogPath = path.join(prepDir, "prep.log");
  const gridDir = path.join(prepDir, "grid");
  const warnings: string[] = [];
  fs.mkdirSync(prepDir, { recursive: true });
  fs.mkdirSync(gridDir, { recursive: true });
  logTo(prepLogPath, "开始预处理：" + videoAbs + " → " + prepDir);

  const stage = async (name: PrepStageName, percent: number): Promise<void> => {
    logTo(prepLogPath, "阶段 " + name + " " + percent + "%");
    if (opts.onStage) await opts.onStage(name, percent);
  };

  // ---- 1. probe + 拼贴图 ----
  await stage("grid", 5);
  let meta: PrepVideoMeta;
  try {
    meta = await deps.probe(videoAbs);
  } catch (e: any) {
    logTo(prepLogPath, "probe 失败：" + (e?.message ?? e));
    throw new Error("读不到源片信息：" + (e?.message ?? e));
  }
  if (meta.duration === undefined) warnings.push("读不到源片时长：拼贴图按 1 页渲染、区间越界体检会被跳过");
  logTo(prepLogPath, "时长 " + (meta.duration ?? "未知") + "s，音轨 " + (meta.hasAudio ? "有" : "无"));

  let grids: string[];
  try {
    grids = await deps.renderGrid(videoAbs, gridDir, {
      duration: meta.duration ?? 0,
      intervalSec: GRID_DEFAULTS.intervalSec,
      cols: GRID_DEFAULTS.cols,
      rowsPerPage: GRID_DEFAULTS.rowsPerPage,
      tileWidth: GRID_DEFAULTS.tileWidth,
    });
  } catch (e: any) {
    logTo(prepLogPath, "拼贴图失败：" + (e?.message ?? e));
    throw new Error("拼贴图失败：" + (e?.message ?? e));
  }
  if (!grids.length) {
    logTo(prepLogPath, "拼贴图 0 张");
    throw new Error("拼贴图 0 张：源片读不出任何画面（文件可能损坏）");
  }
  logTo(prepLogPath, "拼贴图 " + grids.length + " 张");

  // ---- 2. 切点 ----
  await stage("cut", 30);
  let candidates: CutCandidate[] = [];
  try {
    candidates = await deps.detectCuts(videoAbs);
  } catch (e: any) {
    logTo(prepLogPath, "切点检测失败：" + (e?.message ?? e));
    throw new Error("切点检测失败：" + (e?.message ?? e));
  }
  // 0 个候选 = 整条片是一个镜头，还是检测器/阈值不对？**报错**并附诊断，不生成空切点表
  if (!candidates.length) {
    const msg =
      "切点检测 0 个候选（阈值 " + threshold + "，时长 " + (meta.duration ?? "未知") + "s）。" +
      "可能原因：整条片没有场景切换 / 阈值过高 / 视频解码异常。请调阈值或检查源片，不要生成空分镜。";
    logTo(prepLogPath, msg);
    throw new Error(msg);
  }
  const cuts = clusterCuts(candidates, { duration: meta.duration });
  if (!cuts.length) {
    const msg = "切点候选 " + candidates.length + " 个，但最短镜 " + 0.4 + "s / 首尾 0.2s 约束后一个都不剩（阈值 " + threshold + "）。";
    logTo(prepLogPath, msg);
    throw new Error(msg);
  }
  const shots = toShots(cuts, meta.duration ?? null);
  const cutsJsonPath = path.join(prepDir, "cuts.json");
  const cutsTxtPath = path.join(prepDir, "cuts.txt");
  fs.writeFileSync(
    cutsJsonPath,
    JSON.stringify({ threshold, candidates, cuts, shots }, null, 2),
    "utf8",
  );
  fs.writeFileSync(cutsTxtPath, renderCutsTxt(cuts, meta.duration ?? null, threshold), "utf8");
  logTo(prepLogPath, "切点 " + cuts.length + " 个 → " + shots.length + " 个镜");

  // ---- 3. 转写 ----
  await stage("transcribe", 55);
  let transcript: AsrTranscript;
  if (!meta.hasAudio) {
    warnings.push("源片没有音轨：跳过转写，脚本/台词会是空的（不是错误）");
    transcript = { language: "", duration: meta.duration ?? 0, segments: [], words: [] };
    logTo(prepLogPath, "无音轨，跳过转写");
  } else {
    const wavAbs = path.join(prepDir, "audio-16k.wav");
    try {
      await deps.extractWav(videoAbs, wavAbs);
      logTo(prepLogPath, "抽音轨完成：" + wavAbs);
      transcript = await deps.transcribe(wavAbs, { language: opts.lang });
    } catch (e: any) {
      logTo(prepLogPath, "转写失败：" + (e?.message ?? e));
      throw new Error("转写失败：" + (e?.message ?? e));
    }
    if (!transcript.words.length) {
      // 适配器已保证这一点，但注入的 deps 也可能给空 —— 这里是"下游能不能用"的最后一道闸
      logTo(prepLogPath, "转写稿 words 为空");
      throw new Error("转写稿没有词级时间戳（words 为空）：台词配额需要词级时间戳，不允许静默降级");
    }
    logTo(prepLogPath, "转写完成：语种 " + (transcript.language || "未知") + "，词 " + transcript.words.length);
  }
  await stage("transcribe", 90);

  const transcriptPath = path.join(prepDir, "transcript.json");
  fs.writeFileSync(transcriptPath, buildTranscriptJson(transcript, meta.duration ?? null), "utf8");

  const manifestPath = path.join(prepDir, "MANIFEST.md");
  fs.writeFileSync(
    manifestPath,
    renderManifest({
      videoName: path.basename(videoAbs),
      videoSec: meta.duration ?? null,
      hasAudio: meta.hasAudio,
      language: transcript.language,
      wordCount: transcript.words.length,
      cutCount: cuts.length,
      gridCount: grids.length,
      threshold,
      warnings,
    }),
    "utf8",
  );
  logTo(prepLogPath, "MANIFEST 写好：" + manifestPath);

  return {
    prepDir,
    videoSec: meta.duration ?? null,
    hasAudio: meta.hasAudio,
    language: transcript.language,
    wordCount: transcript.words.length,
    cuts,
    grids,
    transcriptPath,
    cutsJsonPath,
    cutsTxtPath,
    manifestPath,
    logPath: prepLogPath,
    warnings,
  };
}