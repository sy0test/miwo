import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { inspectConfig } from "@/utils/configHealth";

const router = express.Router();

/**
 * 配置体检（只读）。GET /api/other/configHealth
 *
 * 用途：一次请求回答「这份安装/这份库的配置有没有指向不存在的东西」。
 * dev 与用户机各调一次、对比 issues 即可定位「文件都是新的、功能却不对」。
 *
 * 查询参数：
 *   ?summary=1    只返回**最小信息**（文件数量 + error 计数），不含供应商 id / 模型名 / 路径。
 *                 这一种形式在 app.ts 里**免登录放行**，方便在用户机上直接看"装全没装全"。
 *   ?only=error   只返回 error 级问题
 *   ?format=text  返回纯文本，方便直接复制给别人看（需要登录）
 */
export default router.get("/", async (req, res) => {
  try {
    const result = await inspectConfig(u.db);
    const only = String(req.query.only ?? "");
    if (only === "error") {
      result.issues = result.issues.filter((i) => i.level === "error");
    }

    // 最小信息模式：只给数量与计数，便于免登录排查"配置数据装全没有"
    if (String(req.query.summary ?? "") === "1") {
      res.status(200).send(
        success({
          files: result.files,
          errorCount: result.errorCount,
          warnCount: result.issues.filter((i) => i.level === "warn").length,
          agentCount: Object.keys(result.agentModels).length,
          /** 未能解析到任何模型的 Agent 数量（>0 表示配置有缺口） */
          unconfiguredAgents: Object.values(result.agentModels).filter((m) => m === "（未配置）").length,
        }),
      );
      return;
    }

    if (String(req.query.format ?? "") === "text") {
      const lines: string[] = [];
      lines.push("=== 配置数据文件 ===");
      for (const [k, v] of Object.entries(result.files)) lines.push(`  ${k}: ${v}`);
      lines.push("");
      lines.push("=== 各 Agent 解析到的模型 ===");
      for (const [k, v] of Object.entries(result.agentModels)) lines.push(`  ${k} → ${v}`);
      lines.push("");
      lines.push(`=== 问题（error ${result.errorCount}）===`);
      if (!result.issues.length) lines.push("  （无）");
      for (const i of result.issues) lines.push(`  [${i.level}] ${i.where}：${i.message}${i.fix ? `\n        → ${i.fix}` : ""}`);
      res.type("text/plain; charset=utf-8").status(200).send(lines.join("\n"));
      return;
    }

    res.status(200).send(success(result));
  } catch (e: any) {
    res.status(500).send({ code: 500, message: `体检失败：${u.error(e).message}`, data: null });
  }
});
