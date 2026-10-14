import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import isPathInside from "is-path-inside";
import u from "@/utils";
import p from "path";
import * as fs from "fs";
import { requireAdmin } from "@/middleware/tenant"; // Phase 1c Task 4：平台资产（技能库）写 ⇒ 仅 admin
import { AUDIT_ACTIONS, actorFromCtx, audit } from "@/utils/audit";

const router = express.Router();

/**
 * 写技能文本（`data/skills/**`）。
 *
 * ⚠ Phase 1c Task 4 的三处收紧（原实现只有"路径在 skillsRoot 内"一条）：
 *   1. **收权**：技能库是平台资产（与提示词同级），只有管理员能写（`requireAdmin`）；
 *   2. **路径白名单**：只接受 `skills/` 下的 **`.md`** 文件，且 `path` 必须是**相对**路径 ——
 *      `p.join`（不是 `p.resolve`）对绝对路径不会"重置"到根，靠它自己挡不住盘符路径；
 *      而 `is-path-inside` 对"同级前缀"（`skills-evil/`）也不会误判 —— 两条一起才闭合；
 *   3. **审计**：写盘是**平台资产的变更**，落 `o_auditLog`（spec Tier 1 #17）。
 *
 * ⚠ 判别力：把 `.md` 白名单拿掉 ⇒ 「非 .md 必须 400」的用例红；把 `requireAdmin` 拿掉 ⇒
 *   普通 token 直接 200 并把 `data/skills/*.md` 改掉（越权矩阵用例红）。
 */
export default router.post(
  "/",
  validateFields({
    path: z.string(),
    content: z.string(),
  }),
  requireAdmin,
  async (req, res) => {
    const { path, content } = req.body;
    const skillsRoot = u.getPath(["skills"]);

    // ① 必须是相对路径（`a/b.md` 或 `a\b.md`），不接受盘符/UNC/前导斜杠
    if (p.isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.startsWith("\\\\") || path.startsWith("//")) {
      return res.status(400).send(error("无效的路径：必须是 skills 下的相对路径"));
    }
    // ② 只允许 .md（`getSkillList` 也只列 `.md` ⇒ 这是同一份口径，不是额外限制）
    if (p.extname(path).toLowerCase() !== ".md") {
      return res.status(400).send(error("只允许写入 .md 技能文件"));
    }
    // ③ 解析到真实路径后再判"在不在 skills 里"（`..` / 符号链接前缀都在这一步被挡）
    const filePath = p.resolve(skillsRoot, path);
    if (!isPathInside(filePath, skillsRoot)) {
      return res.status(400).send(error("无效的路径"));
    }

    if (!fs.existsSync(filePath)) {
      return res.status(400).send(error("文件不存在"));
    }

    const raw = await fs.promises.writeFile(filePath, content, "utf-8");

    await audit(actorFromCtx(req.ip), AUDIT_ACTIONS.SKILL_WRITE, p.relative(skillsRoot, filePath), {
      bytes: Buffer.byteLength(String(content), "utf-8"),
    });
    res.status(200).send(success(raw));
  },
);
