/**
 * 本地 ASR 适配器：spawn 一个 Python 进程跑 faster-whisper（spec §5.3 / T2）。
 *
 * ── 为什么是「spawn CLI + 读 JSON」而不是 node 里调 Python 绑定 ──
 *  · 打包镜像里 Python 与 Node 是两个运行时，进程边界最省事、也最不容易把模型加载进 Node 堆；
 *  · 失败模式简单：退出码 + stderr + 产物文件，三样都能进 prep.log；
 *  · 单测可以注入 runner（不装 Python 也能测契约），真实转写验证留在部署机（见 T2 步骤 6）。
 *
 * ── 契约（与 asr/transcribe.py 一一对应）──
 *  · 退出码 0 = 成功，产物里 words 非空；
 *  · 退出码 3 = 没有词级时间戳 ⇒ AsrNoWordTimestampsError（**不许静默降级**：台词配额要词级时间）；
 *  · 超时 = AsrTimeoutError（20 分钟/集，CPU int8 medium 的实测上限留余量）；
 *  · 其它非 0 = AsrError（带 stderr 尾部，客户能看懂为什么）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "@/config";

export type AsrWord = { word: string; start: number; end: number };
export type AsrSegment = { start: number; end: number; text: string };
export type AsrTranscript = {
  language: string;
  duration: number;
  segments: AsrSegment[];
  words: AsrWord[];
};

/** 没有词级时间戳（words 为空）。**必须失败**：台词配额与逐镜的时间对齐都靠它。 */
export class AsrNoWordTimestampsError extends Error {
  name = "AsrNoWordTimestampsError";
}
export class AsrTimeoutError extends Error {
  name = "AsrTimeoutError";
}
export class AsrError extends Error {
  name = "AsrError";
}

export type AsrRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** spawn 自身失败（找不到 python / 脚本不存在）时带出来，便于翻成可操作报错。 */
  error?: Error;
};

export type AsrInvocation = {
  python: string;
  script: string;
  wav: string;
  outPath: string;
  model: string;
  compute: string;
  modelDir: string;
  language?: string;
  timeoutMs: number;
};

/** 测试注入点：给它一个会写 outPath 的假实现即可，不需要 Python。 */
export type AsrRunner = (inv: AsrInvocation) => Promise<AsrRunResult>;

export interface TranscribeOptions {
  model?: string;
  compute?: string;
  modelDir?: string;
  language?: string;
  timeoutMs?: number;
  pythonPath?: string;
  scriptPath?: string;
  /** 输出文件路径；缺省建在系统临时目录并在结束后删除。 */
  outPath?: string;
  runner?: AsrRunner;
}

/** 20 分钟/集（spec §5.3 的超时口径）。 */
export const DEFAULT_ASR_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * 找 transcribe.py 的真实位置。**两种布局都要能跑**（所以不写死一条路径）：
 *  · dev（tsx）：__dirname = apps/api/src/utils/asr ⇒ ../../../asr/transcribe.py；
 *  · 打包（esbuild 单文件 data/serve/app.js）：__dirname = apps/api/data/serve ⇒ ../../asr/transcribe.py；
 *  · 兜底：cwd/asr/transcribe.py（运维在 apps/api 下起进程）。
 */
export function resolveAsrScript(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  if (config.asr.scriptPath && config.asr.scriptPath.trim()) return config.asr.scriptPath.trim();
  const candidates = [
    path.resolve(__dirname, "../../../asr/transcribe.py"),
    path.resolve(__dirname, "../../asr/transcribe.py"),
    path.resolve(process.cwd(), "asr", "transcribe.py"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

/** python 解释器：显式配置 > 平台约定（venv 由部署脚本 / 镜像提供）。 */
export function resolvePython(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  if (config.asr.pythonPath && config.asr.pythonPath.trim()) return config.asr.pythonPath.trim();
  return process.platform === "win32" ? "python" : "python3";
}

/** 默认 runner：spawn python，超时强杀（协作式中断对 Python 子进程无效，必须 kill）。 */
export const defaultAsrRunner: AsrRunner = (inv) =>
  new Promise<AsrRunResult>((resolve) => {
    const args = [inv.script, "--wav", inv.wav, "--out", inv.outPath, "--model", inv.model, "--compute", inv.compute];
    if (inv.modelDir) args.push("--model-dir", inv.modelDir);
    if (inv.language) args.push("--language", inv.language);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(inv.python, args, {
        windowsHide: true,
        // PYTHONIOENCODING 避免 Windows 控制台默认 GBK 把中文 stderr 编坏；HF 离线由镜像保证
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
    } catch (e: any) {
      resolve({ code: null, stdout, stderr, error: e instanceof Error ? e : new Error(String(e)) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }, inv.timeoutMs);
    child.stdout?.on("data", (d) => { stdout += String(d); });
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, error: e });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

/** stderr 尾部（客户能看懂的那几行）；ffmpeg/python 的诊断都在末尾。 */
function tail(text: string, lines = 4): string {
  return String(text ?? "")
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-lines)
    .join(" | ");
}

/**
 * 解析 transcribe.py 的产物。**严格到「能进下游」为准**：
 *  · language 必须是字符串（空串可接受：源片无语音时下游仍需要 transcript 文件）；
 *  · duration / words[].start/end 必须是有限数字；坏条目丢弃而不是整份失败（个别空词常见）；
 *  · segments 缺了补空数组，但 words 缺了**抛错**（不是降级）。
 */
export function parseAsrOutput(raw: string): AsrTranscript {
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch (e: any) {
    throw new AsrError("ASR 产物不是合法 JSON：" + (e?.message ?? String(e)));
  }
  if (!json || typeof json !== "object") throw new AsrError("ASR 产物不是对象");
  const words: AsrWord[] = Array.isArray(json.words)
    ? json.words
        .map((w: any) => ({
          word: String(w?.word ?? "").trim(),
          start: Number(w?.start),
          end: Number(w?.end),
        }))
        .filter((w: AsrWord) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end))
    : [];
  const segments: AsrSegment[] = Array.isArray(json.segments)
    ? json.segments
        .map((s: any) => ({ start: Number(s?.start), end: Number(s?.end), text: String(s?.text ?? "").trim() }))
        .filter((s: AsrSegment) => Number.isFinite(s.start) && Number.isFinite(s.end))
    : [];
  const duration = Number(json.duration);
  return {
    language: typeof json.language === "string" ? json.language : "",
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    segments,
    words,
  };
}

/**
 * 转写一个 wav。**任何“没有词级时间戳”的路径都抛错**（退出码 3 / words 为空 / 产物缺失）。
 *
 * ⚠ 只在文件系统里读写产物；不碰数据库、不写工作区 —— 进度由调用方（prep handler）负责。
 */
export async function transcribe(wavAbs: string, o: TranscribeOptions = {}): Promise<AsrTranscript> {
  const cfg = config.asr;
  const model = o.model ?? cfg.model;
  const compute = o.compute ?? cfg.compute;
  const modelDir = o.modelDir ?? cfg.modelDir;
  const timeoutMs = o.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_ASR_TIMEOUT_MS;
  const runner = o.runner ?? defaultAsrRunner;
  const ownOut = !o.outPath;
  const outPath = o.outPath ?? path.join(os.tmpdir(), "miwo-asr-" + process.pid + "-" + Date.now().toString(36) + ".json");
  try {
    const res = await runner({
      python: resolvePython(o.pythonPath),
      script: resolveAsrScript(o.scriptPath),
      wav: wavAbs,
      outPath,
      model,
      compute,
      modelDir,
      language: o.language, // 只在显式给定时传；不给则脚本先 detect_language
      timeoutMs,
    });
    if (res.timedOut) {
      throw new AsrTimeoutError("ASR 超时（" + Math.round(timeoutMs / 1000) + "s）：" + tail(res.stderr));
    }
    if (res.code === 3) {
      throw new AsrNoWordTimestampsError("ASR 没有词级时间戳（words 为空）：" + tail(res.stderr));
    }
    if (res.code !== 0) {
      const reason = res.error ? res.error.message : "退出码 " + String(res.code);
      throw new AsrError("ASR 失败（" + reason + "）：" + (tail(res.stderr) || "没有 stderr 输出"));
    }
    if (!fs.existsSync(outPath)) {
      throw new AsrError("ASR 退出码 0 但没有产物文件：" + outPath);
    }
    const t = parseAsrOutput(fs.readFileSync(outPath, "utf8"));
    if (!t.words.length) {
      throw new AsrNoWordTimestampsError("ASR 产物里 words 为空：台词配额需要词级时间戳，不允许静默降级");
    }
    return t;
  } finally {
    if (ownOut) {
      try { fs.rmSync(outPath, { force: true }); } catch { /* 清理失败不影响结果 */ }
    }
  }
}
