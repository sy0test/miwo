/**
 * 本地 ASR 适配器（M1-T2）的契约单测。
 *
 * 不装 Python、不需要模型：注入一个 runner 让它按约定写产物文件，就能把四条契约钉住：
 *   ① 正常 JSON → AsrTranscript（并把 model/compute/modelDir/language 如实传给子进程）；
 *   ② 退出码 3 或 words 为空 → AsrNoWordTimestampsError（**不许静默降级**）；
 *   ③ 超时 → AsrTimeoutError；
 *   ④ 其它失败 → AsrError 带 stderr 尾部（客户能看懂）。
 * 真实转写验证在部署机做（见实施计划 T2 步骤 6 与交付说明）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AsrError,
  AsrNoWordTimestampsError,
  AsrTimeoutError,
  parseAsrOutput,
  resolveAsrScript,
  resolvePython,
  transcribe,
  type AsrInvocation,
  type AsrRunResult,
} from "@/utils/asr";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-asr-test-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const WAV = path.join(TMP, "a.wav");
fs.writeFileSync(WAV, "RIFF...");

/** 造一个 runner：把 payload 写到 inv.outPath，并返回指定的退出码。 */
function runnerWriting(payload: unknown, result: Partial<AsrRunResult> = {}): (inv: AsrInvocation) => Promise<AsrRunResult> {
  return async (inv) => {
    fs.writeFileSync(inv.outPath, JSON.stringify(payload));
    return { code: 0, stdout: "", stderr: "", ...result };
  };
}

const GOOD = {
  language: "zh",
  duration: 132.4,
  segments: [{ start: 0, end: 2.3, text: "第一句" }],
  words: [{ word: "第一句", start: 0.12, end: 0.86 }],
};

describe("transcribe：正常路径", () => {
  it("读产物 / 返回词级结果；把 model·compute·modelDir 传给子进程", async () => {
    const seen: AsrInvocation[] = [];
    const run = async (inv: AsrInvocation): Promise<AsrRunResult> => {
      seen.push(inv);
      fs.writeFileSync(inv.outPath, JSON.stringify(GOOD));
      return { code: 0, stdout: "", stderr: "" };
    };
    const t = await transcribe(WAV, { runner: run, model: "small", compute: "int8", modelDir: "/opt/models" });
    expect(t).toEqual(GOOD);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ wav: WAV, model: "small", compute: "int8", modelDir: "/opt/models", script: expect.stringContaining("transcribe.py") });
    expect(seen[0].timeoutMs).toBeGreaterThan(0);
    // 没给 language ⇒ **不传**（让脚本先 detect_language，再显式转写）
    expect(seen[0].language).toBeUndefined();
  });

  it("显式给 language 时原样传给子进程（给错语种 Whisper 会翻译而非转写）", async () => {
    const seen: AsrInvocation[] = [];
    const t = await transcribe(WAV, {
      language: "en",
      runner: async (inv) => {
        seen.push(inv);
        fs.writeFileSync(inv.outPath, JSON.stringify({ ...GOOD, language: "en" }));
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(seen[0].language).toBe("en");
    expect(t.language).toBe("en");
  });

  it("自己建的临时产物会在结束后清掉（不留垃圾文件）", async () => {
    let outPath = "";
    await transcribe(WAV, {
      runner: async (inv) => {
        outPath = inv.outPath;
        fs.writeFileSync(inv.outPath, JSON.stringify(GOOD));
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(outPath).not.toBe("");
    expect(fs.existsSync(outPath)).toBe(false);
  });
});

describe("transcribe：没有词级时间戳必须失败（不许静默降级）", () => {
  it("退出码 3 → AsrNoWordTimestampsError", async () => {
    await expect(
      transcribe(WAV, {
        runner: async (inv) => {
          fs.writeFileSync(inv.outPath, JSON.stringify({ ...GOOD, words: [] }));
          return { code: 3, stdout: "", stderr: "没有词级时间戳" };
        },
      }),
    ).rejects.toBeInstanceOf(AsrNoWordTimestampsError);
  });

  it("退出码 0 但产物 words 为空 → 同样失败（退出码不是唯一判据）", async () => {
    await expect(transcribe(WAV, { runner: runnerWriting({ ...GOOD, words: [] }) })).rejects.toBeInstanceOf(AsrNoWordTimestampsError);
  });

  it("产物缺失（退出码 0 却没文件）→ AsrError，不返回空结果", async () => {
    await expect(transcribe(WAV, { runner: async () => ({ code: 0, stdout: "", stderr: "" }) })).rejects.toBeInstanceOf(AsrError);
  });
});

describe("transcribe：失败翻译", () => {
  it("超时 → AsrTimeoutError（20min 上限）", async () => {
    await expect(
      transcribe(WAV, { timeoutMs: 5000, runner: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) }),
    ).rejects.toBeInstanceOf(AsrTimeoutError);
  });

  it("非 0 退出码 → AsrError 带 stderr 尾部（客户能看懂）", async () => {
    const err = await transcribe(WAV, {
      runner: async () => ({ code: 1, stdout: "", stderr: "Traceback...\\nCUDA error: out of memory\\n模型加载失败" }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AsrError);
    expect(err.message).toContain("模型加载失败");
  });

  it("spawn 自身失败（找不到 python）→ AsrError 带原因", async () => {
    const err = await transcribe(WAV, {
      runner: async () => ({ code: null, stdout: "", stderr: "", error: new Error("spawn python ENOENT") }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AsrError);
    expect(err.message).toContain("ENOENT");
  });
});

describe("parseAsrOutput：宽容但能进下游", () => {
  it("过滤坏 word/segment（空词、非数字时间），保留可用条目", () => {
    const t = parseAsrOutput(
      JSON.stringify({
        language: "zh",
        duration: 10,
        segments: [{ start: 0, end: 1, text: " a " }, { start: "x", end: 2, text: "bad" }],
        words: [{ word: "a", start: 0, end: 0.5 }, { word: "  ", start: 0.5, end: 1 }, { word: "b", start: "x", end: 2 }],
      }),
    );
    expect(t.segments).toEqual([{ start: 0, end: 1, text: "a" }]);
    expect(t.words).toEqual([{ word: "a", start: 0, end: 0.5 }]);
  });

  it("缺字段时给安全缺省（language 空串 / duration 0 / segments 空）", () => {
    const t = parseAsrOutput(JSON.stringify({ words: [{ word: "a", start: 0, end: 1 }] }));
    expect(t.language).toBe("");
    expect(t.duration).toBe(0);
    expect(t.segments).toEqual([]);
    expect(t.words.length).toBe(1);
  });

  it("坏 JSON / 非对象 → AsrError", () => {
    expect(() => parseAsrOutput("not json")).toThrow(AsrError);
    expect(() => parseAsrOutput("null")).toThrow(AsrError);
  });
});

describe("路径解析", () => {
  it("resolveAsrScript：显式值优先；否则按布局找到一个真实存在的 transcribe.py", () => {
    expect(resolveAsrScript("/x/transcribe.py")).toBe("/x/transcribe.py");
    const found = resolveAsrScript();
    expect(found.endsWith(path.join("asr", "transcribe.py"))).toBe(true);
    // 仓库里 asr/transcribe.py 必须真实存在（缺了就是打包漏文件）
    expect(fs.existsSync(found)).toBe(true);
  });

  it("resolvePython：显式值优先；有仓库 venv 用它；都没有才按平台给 python/python3", () => {
    expect(resolvePython("/opt/venv/bin/python")).toBe("/opt/venv/bin/python");
    const venvPython = path.resolve(
      __dirname,
      "..",
      "asr",
      ".venv",
      process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"),
    );
    if (fs.existsSync(venvPython)) {
      // 本地开发机按 requirements 建过 venv ⇒ 必须优先用它（否则手工 pnpm dev 会落到系统 Python）
      expect(resolvePython()).toBe(venvPython);
    } else {
      expect(resolvePython()).toBe(process.platform === "win32" ? "python" : "python3");
    }
  });
});
