import express from "express";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { analyzeRedrawAssets, sendRedrawError, persistStage } from "@/utils/redrawAnalyze";
import { config } from "@/config";

const router = express.Router();

/**
 * 出海转绘 · 第 3→4 步：「开始分析」按钮。源片来自 `o_script.sourceVideo`，
 * 路由先跑**预处理**（拼贴图 / 切点表 / 转写稿），再交给 `analyzeRedrawAssets` 解析。
 *
 * ⚠⚠ 这里的预处理是**开发期桥**：子进程调外部脚本 `redraw-prep.cjs`。
 *   交付前必须换成原生实现 —— 那个脚本依赖 hypit 仓库的 CLI 与本地 WhisperX 服务
 *   （见脚本自己的注释），把它当运行前提等于把 hypit 仓库和一套本地服务
 *   绑进产品里，与「私有化交付」冲突。原生重写没做的原因只有一个：
 *   切点检测器还没重写（native ffmpeg 复现不出同一批候选），
 *   而切点表是技能的铁律输入（「镜头边界一律取自切点表」），
 *   换检测器 = 分镜边界换一套，得重新验证一遍第 4~7 步。
 *   替换时：把 prepareSource() 换掉即可，下游一行不用动。
 *
 * 开跑就返回（`{started:true}`），状态写在 `o_script.extractState`：
 *   0 = 正在提取（前端转圈）→ 1 = 成功 / -1 = 失败（前端红叹号，errorReason 里是原因）
 * 预处理一次要跑几分钟（转写最慢），挂着 HTTP 等它必然超时。
 * 软件中途退出的话，`fixDB` 启动时会把还挂在 0 的行判成 -1，不会永远转圈。
 */

/** 外部预处理脚本。**唯一来源是 `config.redrawPrepScript`**（= `MIWO_REDRAW_PREP`，缺省与改动前的字面量逐字一致） */
const PREP_SCRIPT = config.redrawPrepScript;

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    /** 语种。默认 auto（脚本先本地检出再显式传）—— 给错语种 Whisper 会「翻译」而非转写 */
    lang: z.string().optional(),
    /** 源片没音轨时无所谓；开发期要跳过转写（很慢）时用 */
    skipTranscribe: z.boolean().optional(),
    /** 只跑预处理、不调模型解析。零成本，产物留着可以单跑 analyzeVideo */
    prepOnly: z.boolean().optional(),
    /** 覆盖已有分镜 */
    replace: z.boolean().optional(),
  }),
  async (req, res) => {
    try {
      const { projectId, scriptId, lang, skipTranscribe, prepOnly, replace } = req.body;

      const script = await u.db("o_script").where({ id: scriptId, projectId }).first();
      if (!script) return res.status(400).send(error(`项目 ${projectId} 下没有这条源片：scriptId=${scriptId}`));
      if (!script.sourceVideo?.trim()) return res.status(400).send(error(`这一集没有源片：scriptId=${scriptId}`));
      if (script.extractState === 0) return res.status(409).send(error(`这一集正在分析中，等它跑完`));

      const srcAbs = await u.oss.getAbsPath(script.sourceVideo);
      if (!fs.existsSync(srcAbs)) return res.status(400).send(error(`源片文件不在了：${script.sourceVideo}`));

      // 未配置 ≠ 配错：两种情况给不同报错，前者是"部署时漏了"，后者是"路径写错/文件被移走"。
      if (!PREP_SCRIPT.trim()) {
        return res
          .status(500)
          .send(
            error(
              `转绘预处理未配置：请设置环境变量 MIWO_REDRAW_PREP，指向 redraw-prep.cjs 的绝对路径。` +
                `预处理是**外部依赖**（切点检测 + 转写，见本文件顶部注释），没有它「开始分析」跑不了。`,
            ),
          );
      }
      if (!fs.existsSync(PREP_SCRIPT)) {
        return res
          .status(500)
          .send(
            error(
              `找不到预处理脚本：${PREP_SCRIPT}。` +
                `请检查 MIWO_REDRAW_PREP 是否指向本机真实存在的 redraw-prep.cjs（换机器/容器后原路径通常无效）。` +
                `这是**开发期桥**，交付前应改成原生实现。`,
            ),
          );
      }

      // 产物目录放在应用数据目录下（u.getPath 指向 data/ ），
      // 不放仓库外的脚本 out/ —— 交付换实现后这里依然是对的。
      const prepDir = u.getPath(["redraw-prep", String(projectId), String(scriptId)]);
      fs.mkdirSync(prepDir, { recursive: true });

      await u.db("o_script").where("id", scriptId).update({ extractState: 0, errorReason: null });
      res.status(200).send(success({ started: true, scriptId, prepDir, prepScript: PREP_SCRIPT }));

      // ---- 之后都在后台跑 ----
      const log = (msg: string) => console.log(`[redraw/analyzeSource] script ${scriptId} ${msg}`);
      void (async () => {
        try {
          const t0 = Date.now();
          await runPrep({ srcAbs, prepDir, lang, skipTranscribe });
          log(`预处理完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

          if (prepOnly) {
            // 产物留着，用户可以单跑 analyzeVideo（或不跑，先自己看看拼贴图和切点表）
            await u.db("o_script").where("id", scriptId).update({ extractState: 2 });
            log(`prepOnly：停在「等待提取」，产物在 ${prepDir}`);
            return;
          }

          const r = await analyzeRedrawAssets({ projectId, scriptId, assetDir: prepDir, replace });

          // 体检里 error 级的条目 = 这份产出**不能进下游**（区间解析不出、时间轴有缺口…），
          // 所以按失败报。放进 errorReason 是因为界面只在 -1 时才显示它；
          // 报成成功的话这些硬伤只能去日志里翻。warn 级的不拦，照常算成功。
          const hard = r.issues.filter((i) => i.level === "error").map((i) => `第${i.shotIndex ?? "-"}镜 ${i.message}`);
          if (hard.length) {
            await u.db("o_script").where("id", scriptId).update({
              extractState: -1,
              errorReason: `解析出了 ${r.assets} 个资产 / ${r.segments} 个片段 / ${r.storyboards} 个镜，但体检没过：\n${hard.join("\n")}`,
            });
            log(`体检没过（${hard.length} 条 error），已标记失败；原文 ${r.outputPath}`);
            return;
          }

          // 3 = 待对账：解析出来了，但还没跟用户的资产认过账、也还没出转绘分镜表。
          // 转绘层跑完才置 1。见 redraw 三层设计的 §8。
          await u.db("o_script").where("id", scriptId).update({ extractState: 3, errorReason: null });
          // 进度落库：决策层靠它判断「当前到哪一阶段」，不再只依赖会被清空的记忆
          await persistStage(projectId, scriptId, "analysis");
          log(`解析完成：${r.assets} 个资产 / ${r.storyboards} 个镜，${r.issues.length} 条 warn`);
        } catch (e: any) {
          const msg = `${u.error(e).message}`.slice(0, 1000);
          await u.db("o_script")
            .where("id", scriptId)
            .update({ extractState: -1, errorReason: msg })
            .catch(() => {});
          log(`失败：${msg}`);
        }
      })();
    } catch (e: any) {
      sendRedrawError(res, e);
    }
  },
);

/**
 * 跑预处理脚本，stdout/stderr 全量落 `prep.log`（出错时才有得复盘）。
 * 失败时抛出的消息带日志尾部 —— 客户看到的 errorReason 就是这一句，
 * 只说「退出码 1」等于什么都没说。
 */
function runPrep(opts: { srcAbs: string; prepDir: string; lang?: string; skipTranscribe?: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [PREP_SCRIPT, opts.srcAbs, "--out", opts.prepDir, "--lang", opts.lang || "auto"];
    if (opts.skipTranscribe) args.push("--skip-transcribe");

    const logPath = path.join(opts.prepDir, "prep.log");
    const stream = fs.createWriteStream(logPath, { flags: "w" });
    stream.write(`$ ${process.execPath} ${args.join(" ")}\n\n`);

    const child = spawn(process.execPath, args, { cwd: path.dirname(PREP_SCRIPT), env: process.env, windowsHide: true });
    child.stdout.on("data", (d) => stream.write(d));
    child.stderr.on("data", (d) => stream.write(d));
    child.on("error", (e) => {
      stream.end();
      reject(new Error(`预处理脚本跑不起来：${e.message}`));
    });
    child.on("close", (code) => {
      stream.end();
      if (code === 0) return resolve();
      // 脚本的 die() 把原因写在 stderr 最后几行，取出来当错误消息
      const tail = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(-4)
        .join(" | ");
      reject(new Error(`预处理失败（退出码 ${code}）：${tail || "日志里没有输出"}（完整日志 ${logPath}）`));
    });
  });
}
