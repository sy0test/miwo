import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * ffmpeg / ffprobe 的薄封装。出海转绘第 5 步（按源片区间切原片片段）用。
 *
 * 为什么走外部进程而不是 npm 包：切片段只用得到 trim/concat 两个滤镜，
 * 装 fluent-ffmpeg 只是多一层壳，还要额外的 postinstall。
 *
 * 二进制路径可用 `FFMPEG_PATH` / `FFPROBE_PATH` 覆盖 —— Electron 打包后
 * PATH 与开发机不同，写死 "ffmpeg" 在那边会找不到。
 */
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

/** 单条命令的超时。切片是纯本地转码，正常几秒；卡住多半是文件坏了 */
const TIMEOUT = Number(process.env.FFMPEG_TIMEOUT || 10 * 60 * 1000);

async function exec(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(bin, args, { timeout: TIMEOUT, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new Error(`找不到 ${bin}，请确认已安装并加入 PATH（或用环境变量指定路径）`);
    // ffmpeg 的错误全在 stderr，execFile 的 error 对象上只有 message（含 stderr 尾部）
    const tail = (e?.stderr ?? "").toString().trim().split(/\r?\n/).slice(-3).join(" | ");
    throw new Error(`${bin} 失败：${tail || e?.message || e}`);
  }
}

export type VideoMeta = {
  /** 秒。取不到（容器没写时长）时为 undefined */
  duration?: number;
  hasAudio: boolean;
  width?: number;
  height?: number;
};

/** 读源片元信息。timeout 之外还兜住「文件不是视频」—— ffprobe 会直接报错 */
export async function probeVideo(file: string): Promise<VideoMeta> {
  const out = await exec(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    throw new Error(`ffprobe 输出解析不了：${out.slice(0, 200)}`);
  }
  const streams: any[] = json?.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const duration = Number(json?.format?.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    width: video?.width,
    height: video?.height,
  };
}

/**
 * 抽一帧存成封面图。出海转绘的源片列表卡要显示「首帧封面」。
 *
 * `force_original_aspect_ratio=decrease` 是刻意的：不用 min(...) 那种表达式，
 * 免得逗号被 ffmpeg 的滤镜解析器当成滤镜分隔符（写对了也难读）。
 *
 * 时间点取 0 但**不保证 0 处有帧**（个别容器首帧在 0 之外），失败时退到 1s 再试一次；
 * 还不行就抛错 —— 封面不是关键路径，调用方自己决定要不要因此判失败。
 */
export async function extractCover(srcFile: string, outFile: string, atSec = 0): Promise<void> {
  const grab = (t: number) =>
    exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", String(t), "-i", srcFile,
      "-frames:v", "1",
      "-vf", "scale=640:640:force_original_aspect_ratio=decrease",
      "-q:v", "3",
      outFile,
    ]);
  try {
    await grab(atSec);
  } catch (e) {
    if (atSec !== 0) throw e;
    await grab(1);
  }
}

/**
 * 切一个片段。多段时用 trim→concat 合并成一条。
 *
 * `-ss` 放 `-i` 前只作定位优化（不写 `-copyts`，时间戳被归零，故 trim 用相对值），
 * ffmpeg 在重编码路径下会解码到精确位置 —— 这点比 `-ss/-t` 直接输出可靠：
 * 后者在关键帧对齐时会把边界挪到最近的关键帧上，而我们的区间是从切点表来的帧级位置。
 *
 * 用 `trim` 而不是 `-ss/-t` 的另一个原因：源片区间的「多段合并」形式
 * （`118.167-121.750 + 121.750-131.750`）只有在 filter_complex 里才能一次成片。
 */
export async function cutClip(srcFile: string, ranges: [number, number][], outFile: string, withAudio: boolean): Promise<void> {
  if (!ranges.length) throw new Error("区间为空");

  // 统一以最早的一段为基准做相对偏移；`-ss ss0` 已经把时间轴前移到 ss0
  const ss0 = Math.min(...ranges.map((r) => r[0]));
  const fc: string[] = [];
  // 源片是奇数尺寸时 yuv420p 会直接失败（chroma 不能对半切）。缩放写进每一条视频链
  // 而不是用 `-vf`：`-vf` 和 `-filter_complex` + `-map` 同时出现时作用对象要靠 ffmpeg 猜，
  // 而且 concat 要求各段尺寸一致，逐段对齐最省事。
  const even = ",scale=trunc(iw/2)*2:trunc(ih/2)*2";
  ranges.forEach(([a, b], i) => {
    const s = (a - ss0).toFixed(3);
    const e = (b - ss0).toFixed(3);
    fc.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS${even}[v${i}]`);
    if (withAudio) fc.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
  });

  let vmap = "[v0]";
  let amap: string | null = withAudio ? "[a0]" : null;
  if (ranges.length > 1) {
    const n = ranges.length;
    const ins = ranges.map((_, i) => (withAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join("");
    fc.push(`${ins}concat=n=${n}:v=1:a=${withAudio ? 1 : 0}[vout]${withAudio ? "[aout]" : ""}`);
    vmap = "[vout]";
    amap = withAudio ? "[aout]" : null;
  }

  const args = ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(ss0), "-i", srcFile, "-filter_complex", fc.join(";"), "-map", vmap];
  if (amap) args.push("-map", amap);
  // 参考视频要的是动作与节奏，不追求画质；crf 18 已经比源片损失小得多
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-b:a", "128k");
  else args.push("-an");
  args.push("-movflags", "+faststart", outFile);

  await exec(FFMPEG, args);
}
