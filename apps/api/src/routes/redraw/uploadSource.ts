import express from "express";
import fs from "fs";
import path from "path";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { extractCover, probeVideo } from "@/utils/ffmpeg";
import { parseSortIndex } from "@/utils/redraw";

const router = express.Router();

/**
 * 出海转绘 · 第 2 步：上传源片。**一个源片 = 一集 = 一条 `o_script`**。
 *
 * ⚠ 这条路由收的是**原始字节流**（`Content-Type: application/octet-stream`，
 * 文件内容就是整个 body），不是 JSON / multipart。原因：
 * `app.ts` 的 body 上限是 100mb，而源视频按 base64 进 JSON 会再胖 33%，
 * 一部几百 MB 的短剧必然 413。绕开 body parser 直接流式落盘，多大都收得下，
 * 也不把整个文件读进内存。文件名等信息走 **query**（body 里没有位置放它们）。
 *
 * 命名与排序：客户上传前重命名（「第一集」「2-xxx」这类），路由从文件名里解出
 * `sortIndex` 写在 `o_script` 上 —— 界面按它排，**不按上传先后**（重传一个就乱了）。
 * 解不出序号时退回「上传顺序」（当前最大值 +1），不报错：序号只是排序，不是数据。
 *
 * 用法（前端）：POST /api/redraw/uploadSource?projectId=1&name=第一集.mp4
 *   body = 文件的原始字节
 */
export default router.post(
  "/",
  validateFields(
    {
      projectId: z.coerce.number(),
      /** 原始文件名（含扩展名）。集名与排序序号都从这里解 */
      name: z.string().min(1),
    },
    "query",
  ),
  async (req, res) => {
    /** 一旦盘上落了文件就记在这里：中途出错要把它删掉，不能留半截 */
    let written: { abs: string; rel: string } | null = null;
    try {
      const projectId = Number((req.query as any).projectId);
      const fileName = String((req.query as any).name).trim();

      const project = await u.db("o_project").where("id", projectId).first();
      if (!project) return res.status(400).send(error(`项目不存在：${projectId}`));

      // 扩展名白名单：body 是裸字节，没有任何东西替我们判断它是不是视频。
      // 放行任意扩展名等于给「往 OSS 里写任意文件」开了个口子。
      const ext = (fileName.split(".").pop() ?? "").toLowerCase();
      const EXTS = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "flv", "ts"];
      if (!EXTS.includes(ext)) {
        return res.status(400).send(error(`不支持的源片格式 .${ext}（支持：${EXTS.join(" / ")}）`));
      }
      // 集名 = 去掉扩展名的文件名。序号也在这一层解，扩展名不参与。
      const scriptName = fileName.replace(/\.[^.]+$/, "").trim() || fileName;

      // 同名重传：**幂等**，不新建第二条（客户网络中断后重传是常态，
      // 多出一条同名源片会让「按名字排序」彻底失效）。
      // 但已经解析出分镜的不能覆盖 —— 它的切片是按旧源片切的，换了源片就全对不上。
      const same = await u.db("o_script").where({ projectId, name: scriptName }).first();
      if (same) {
        const board = await u.db("o_storyboard").where("scriptId", same.id).first();
        if (board) {
          return res
            .status(409)
            .send(error(`已有同名源片「${scriptName}」且已解析出分镜。改名后再传，或先删掉那一集`));
        }
      }

      const relPath = `/${projectId}/source/${uuid()}.${ext}`;
      const absPath = await u.oss.getAbsPath(relPath);

      const bytes = await u.oss.writeStream(relPath, req);
      written = { abs: absPath, rel: relPath };
      if (!bytes) return res.status(400).send(error("收到的内容是空的（body 里没有字节）"));

      // 真的能读吗。客户改个扩展名就能把任意文件传上来，这里一探就知道；
      // 不探的话，坏文件要等第 4 步跑完预处理才暴露，那时已经白等一轮。
      let meta;
      try {
        meta = await probeVideo(absPath);
      } catch (e: any) {
        await u.oss.deleteFile(relPath).catch(() => {});
        written = null;
        return res.status(400).send(error(`这不是能读的视频：${u.error(e).message}`));
      }

      // ---- 落库 ----
      let scriptId: number;
      if (same) {
        scriptId = same.id as number;
        await u.db("o_script").where("id", scriptId).update({
          sourceVideo: relPath,
          extractState: 2,
          errorReason: null,
          coverPath: null,
        });
      } else {
        const sortIndex = parseSortIndex(scriptName) ?? (await nextSortIndex(projectId));
        const [id] = await u.db("o_script").insert({
          name: scriptName,
          content: "",
          projectId,
          sourceVideo: relPath,
          sortIndex,
          // 2 = 等待提取（与基座 extractAssets 的语义一致）：传上来但还没跑解析。
          // 用 0 会让界面显示「正在提取」的转圈，而实际上什么都没在跑。
          extractState: 2,
          createTime: Date.now(),
        });
        scriptId = id as number;
      }

      // ---- 首帧封面 ----
      // 封面失败**不算上传失败**：视频已经在盘上、行已经建好，
      // 为一张缩略图把整个上传判死，客户要重传一遍几百 MB。
      const coverRel = `/${projectId}/source/cover/${scriptId}.jpg`;
      let coverOk = false;
      /** 封面失败的原因。跟着响应回去 —— 只写服务端日志的话，前端只能显示一个空白框 */
      let coverError: string | null = null;
      try {
        const coverAbs = await u.oss.getAbsPath(coverRel);
        // **必须自己建目录**：ffmpeg 不会建父目录，而 getAbsPath 只是解析路径
        // （writeFile 会顺手建，这里走的是外部进程，没有那层）。
        await fs.promises.mkdir(path.dirname(coverAbs), { recursive: true });
        await extractCover(absPath, coverAbs);
        await u.oss.writeFile(coverRel, await fs.promises.readFile(coverAbs));
        await u.db("o_script").where("id", scriptId).update({ coverPath: coverRel });
        coverOk = true;
      } catch (e: any) {
        coverError = u.error(e).message;
        console.warn(`[redraw/uploadSource] 首帧封面没抽出来（不影响上传）：${coverError}`);
      }

      res.status(200).send(
        success({
          id: scriptId,
          name: scriptName,
          reused: Boolean(same),
          sourceVideo: relPath,
          coverPath: coverOk ? coverRel : null,
          coverError,
          bytes,
          duration: meta.duration ?? null,
          hasAudio: meta.hasAudio,
          width: meta.width ?? null,
          height: meta.height ?? null,
          sortIndex: (await u.db("o_script").where("id", scriptId).first())?.sortIndex ?? null,
        }),
      );
    } catch (e: any) {
      // 半截文件必须清掉：留着白占空间，而且这个路径已经写进 o_script 了（如果写到了那一步）
      if (written) await u.oss.deleteFile(written.rel).catch(() => fs.promises.unlink(written!.abs).catch(() => {}));
      res.status(500).send(error(u.error(e).message));
    }
  },
);

/** 上传顺序兜底：当前最大序号 +1。列表为空时从 1 开始 */
async function nextSortIndex(projectId: number): Promise<number> {
  const row: any = await u.db("o_script").where("projectId", projectId).max("sortIndex as m").first();
  return Number(row?.m ?? 0) + 1;
}
