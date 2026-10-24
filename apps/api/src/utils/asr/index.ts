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
import { spawn, spawnSync } from "node:child_process";
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

/**
 * python 解释器解析顺序：
 *   1. 显式参数 / MIWO_ASR_PYTHON；
 *   2. **仓库内的 dev venv**（apps/api/asr/.venv，本地开发按 requirements 建一次就能用）；
 *   3. 打包布局里的镜像 venv（apps/api/asr/.venv，Dockerfile 拷进来的）；
 *   4. 平台约定（python / python3）。
 * 第 2/3 步是"本地能跑起来"的关键：否则手工 `pnpm dev` 会落到系统 Python，
 * 报 “No module named faster_whisper” 而启动时又看不出来（见 app.ts 的 ASR 自检）。
 */
export function resolvePython(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  if (config.asr.pythonPath && config.asr.pythonPath.trim()) return config.asr.pythonPath.trim();
  const venvPython = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
  const candidates = [
    path.resolve(__dirname, "../../../asr/.venv", venvPython), // dev: apps/api/src/utils/asr -> apps/api/asr/.venv
    path.resolve(__dirname, "../../asr/.venv", venvPython), // packed: apps/api/data/serve -> apps/api/asr/.venv
    path.resolve(process.cwd(), "asr", ".venv", venvPython),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return process.platform === "win32" ? "python" : "python3";
}

/** 启动自检：python 能不能 import faster_whisper。失败时返回可操作的原因（app.ts 打印）。 */
export function checkAsrRuntime(timeoutMs = 8000): {
  okay: boolean;
  python: string;
  script: string;
  modelDir: string;
  message: string;
} {
  const python = resolvePython();
  const script = resolveAsrScript();
  const modelDir = path.join(config.asr.modelDir, config.asr.model);
  // 模型必须已经落在本地目录里：离线模式下 faster-whisper 不会回退去网上下载，
  // 缺模型时的真实报错是难读的 LocalEntryNotFoundError，这里提前说清楚。
  const hasModel =
    fs.existsSync(path.join(modelDir, "model.bin")) || fs.existsSync(path.join(modelDir, "model.safetensors"));
  if (!hasModel) {
    return {
      okay: false,
      python,
      script,
      modelDir,
      message:
        "ASR 模型缺失：" +
        modelDir +
        "（运行 node scripts/fetch-asr-model.cjs --model " +
        config.asr.model +
        " 下载，或把已下载的模型目录拷到这里）",
    };
  }
  try {
    const r = spawnSync(python, ["-c", "import faster_whisper"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    if (r.error) return { okay: false, python, script, modelDir, message: r.error.message };
    if (r.status !== 0) {
      const detail = String(r.stderr || r.stdout || "")
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(-3)
        .join(" | ");
      return { okay: false, python, script, modelDir, message: detail || ("退出码 " + String(r.status)) };
    }
    return { okay: true, python, script, modelDir, message: "" };
  } catch (e: any) {
    return { okay: false, python, script, modelDir, message: e?.message ?? String(e) };
  }
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
        // PYTHONIOENCODING 避免 Windows 控制台默认 GBK 把中文 stderr 编坏。
        // HF_HUB_OFFLINE 默认开：模型由 fetch-asr-model.cjs / 镜像固化在本地目录，
        // 运行时**不应该**再访问 HuggingFace（国内网络会 10060 超时，表现为"转写失败"）。
        // 想临时联网下载可显式设 HF_HUB_OFFLINE=0。
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? "1",
          HF_HUB_DISABLE_TELEMETRY: "1",
        },
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
      // 把实际用的 python 带进错误里：本机最坑的一种失败是"启动看起来正常，分析时才发现
      // python 落到系统解释器、没有 faster_whisper"，只报 stderr 会让人以为是代码问题。
      const python = resolvePython(o.pythonPath);
      throw new AsrError("ASR 失败（" + reason + "，python=" + python + "）：" + (tail(res.stderr) || "没有 stderr 输出"));
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
