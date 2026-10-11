import fs from "fs";
import path from "path";
import u from "@/utils";

/**
 * 配置体检（只读）。
 *
 * 由来：配置数据有**两套来源、两条更新路径** ——
 *   · 文件系统 `data/{skills,vendor,modelPrompt,models,web}`：随安装包**整目录覆盖**，升级后与 dev 一致；
 *   · 数据库 `o_agentDeploy` / `o_vendorConfig` / `o_setting` / `o_prompt` / `o_modelPrompt`：
 *     属于用户数据，**升级不覆盖**，`fixDB` 只做「缺了才补一行空值」，**从不清理**。
 *
 * 于是升级后常见「文件都是新的、功能却不对」：库里还留着老版本的 Agent 行/供应商行，
 * 指向已经不存在的供应商适配器或模型名 → 调用时 throw，而错误在界面上未必看得出来。
 *
 * 这个模块把这类"库配置指向不存在的东西"一次性扫出来，dev 与用户机各跑一次对比即可定位。
 */

export interface ConfigHealthIssue {
  /** error = 会导致调用失败；warn = 需要留意但不一定失败；info = 仅告知 */
  level: "error" | "warn" | "info";
  /** 问题所在：file / o_agentDeploy / o_vendorConfig / o_prompt / o_skillList */
  where: string;
  message: string;
  /** 建议动作 */
  fix?: string;
}

export interface ConfigHealthResult {
  /** 配置数据文件清单（与安装包里的数量对照） */
  files: Record<string, number | string>;
  /** 每个 Agent key 最终解析到的模型（简易模式看主键、高级模式看本行） */
  agentModels: Record<string, string>;
  issues: ConfigHealthIssue[];
  /** error 级问题数量：>0 表示这份配置一定会出问题 */
  errorCount: number;
}

/** 数目录下的文件（按扩展名过滤；目录不存在返回 -1，便于区分"空"和"没有"） */
function countFiles(dir: string, ext?: string): number {
  if (!fs.existsSync(dir)) return -1;
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!ext || e.name.toLowerCase().endsWith(ext)) n++;
    }
  };
  walk(dir);
  return n;
}

/** `data/vendor/` 下可用的供应商模板 id（去扩展名） */
export function listVendorTemplates(): string[] {
  const dir = u.getPath("vendor");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/i, ""))
    .sort();
}

export async function inspectConfig(db: any): Promise<ConfigHealthResult> {
  const issues: ConfigHealthIssue[] = [];

  // ---------- 1. 文件类配置清单 ----------
  const files: ConfigHealthResult["files"] = {
    skills: countFiles(u.getPath("skills"), ".md"),
    vendor: countFiles(u.getPath("vendor"), ".ts"),
    modelPrompt: countFiles(u.getPath("modelPrompt"), ".md"),
    webFiles: countFiles(u.getPath("web")),
    serveApp: fs.existsSync(u.getPath(["serve", "app.js"])) ? 1 : 0,
  };

  // ---------- 2. Agent 部署：每行是否解析得到存在的供应商与模型 ----------
  const deployRows = await db("o_agentDeploy").select("id", "key", "vendorId", "model", "modelName", "disabled");
  const vendorTemplates = new Set(listVendorTemplates());
  const vendorRowIds = new Set<string>((await db("o_vendorConfig").select("id")).map((r: any) => String(r.id)));

  // 每个供应商的可用模型名（合并模板 + 库内手加），按供应商缓存一次
  const modelsByVendor = new Map<string, Set<string>>();
  const loadModels = async (vid: string): Promise<Set<string>> => {
    if (modelsByVendor.has(vid)) return modelsByVendor.get(vid)!;
    const set = new Set<string>();
    try {
      const list = await u.vendor.getModelList(vid);
      for (const m of list) if (m?.modelName) set.add(String(m.modelName));
    } catch (e: any) {
      issues.push({
        level: "error",
        where: `o_vendorConfig/${vid}`,
        message: `读取供应商「${vid}」的模型清单失败：${e?.message ?? e}`,
        fix: "确认 data/vendor/" + vid + ".ts 存在且格式正确",
      });
    }
    modelsByVendor.set(vid, set);
    return set;
  };

  const agentModels: Record<string, string> = {};
  const modeRow = await db("o_setting").where("key", "agentUseMode").first();
  const agentUseMode = String(modeRow?.value ?? "");
  const deployByKey = new Map<string, any>(deployRows.map((r: any) => [String(r.key), r]));

  /** 按 ai.ts 的规则算某 key 最终用哪个模型 */
  const resolveKey = (key: string): { modelName: string; via: string } => {
    const row = deployByKey.get(key);
    if (agentUseMode === "1") {
      return { modelName: row?.modelName || "", via: "本行（高级配置）" };
    }
    // 简易模式 / 未设置：回退到主键（冒号前半段）
    const main = key.split(":")[0];
    const mainRow = deployByKey.get(main);
    return { modelName: row?.modelName || mainRow?.modelName || "", via: row?.modelName ? "本行" : `主键 ${main}` };
  };

  for (const row of deployRows) {
    const key = String(row.key);
    const { modelName, via } = resolveKey(key);
    agentModels[key] = modelName || "（未配置）";
    if (row.disabled) continue;

    // 空模型：简易模式下若主键有值则实际可用，只提示；高级模式下必失败
    if (!modelName) {
      issues.push({
        level: agentUseMode === "1" ? "error" : "warn",
        where: `o_agentDeploy/${key}`,
        message: agentUseMode === "1" ? "高级配置模式下本行未配置模型，调用会直接报错" : `未配置模型，且主键 ${key.split(":")[0]} 也没有可用模型`,
        fix: "在「设置 → Agent 配置」里给它选一个模型",
      });
      continue;
    }

    const vid = modelName.split(/:(.+)/)[0];
    const mname = modelName.split(/:(.+)/)[1];
    if (!vid || !mname) {
      issues.push({
        level: "error",
        where: `o_agentDeploy/${key}`,
        message: `modelName 格式不对（应为「供应商id:模型名」）：${modelName}`,
        fix: "重新选择模型",
      });
      continue;
    }
    if (!vendorTemplates.has(vid)) {
      issues.push({
        level: "error",
        where: `o_agentDeploy/${key}`,
        message: `指向的供应商「${vid}」没有适配器文件（data/vendor/${vid}.ts 不存在）。模型经 ${via} 解析`,
        fix: `改选一个存在的供应商：${[...vendorTemplates].join(", ")}`,
      });
      continue;
    }
    if (!vendorRowIds.has(vid)) {
      issues.push({
        level: "error",
        where: `o_agentDeploy/${key}`,
        message: `指向的供应商「${vid}」在 o_vendorConfig 里没有配置行`,
        fix: "在「设置 → 模型服务」里重新保存该供应商配置",
      });
      continue;
    }
    const models = await loadModels(vid);
    if (models.size && !models.has(mname)) {
      issues.push({
        level: "error",
        where: `o_agentDeploy/${key}`,
        message: `模型「${mname}」不在供应商「${vid}」的清单里（该供应商现有 ${models.size} 个模型）`,
        fix: "重新选择模型；若是自加模型，请到「模型服务」里补上",
      });
    }
  }
  // ---------- 3. 供应商：孤儿行（有配置行、没有适配器文件） ----------
  const vendorRows = await db("o_vendorConfig").select("id", "enable");
  const vendorTemplatesArr = [...vendorTemplates];
  for (const v of vendorRows) {
    const vid = String(v.id);
    if (!vendorTemplates.has(vid)) {
      issues.push({
        level: Number(v.enable) === 1 ? "warn" : "info",
        where: `o_vendorConfig/${vid}`,
        message: `有配置行但没有适配器文件（data/vendor/${vid}.ts 不存在）${Number(v.enable) === 1 ? "，且处于启用状态" : ""}`,
        fix: `若不再使用可在「模型服务」里停用；这不影响当前 Agent 选用的供应商（现有适配器：${vendorTemplatesArr.join(", ")}）`,
      });
    }
  }

  // ---------- 4. 提示词：4 条基础提示词是否齐全 ----------
  const REQUIRED_PROMPTS = ["eventExtraction", "scriptAssetExtraction", "videoPromptGeneration", "audioBindPrompt"];
  const promptTypes = new Set<string>((await db("o_prompt").select("type")).map((r: any) => String(r.type)));
  for (const t of REQUIRED_PROMPTS) {
    if (!promptTypes.has(t)) {
      issues.push({
        level: "error",
        where: `o_prompt/${t}`,
        message: `缺少基础提示词「${t}」`,
        fix: "重启一次应用（fixDB 会补种）；若仍缺失，检查「提示词管理」页",
      });
    }
  }

  // ---------- 5. 废弃表提醒（不参与判断，仅避免误读） ----------
  try {
    const skillRows = await db("o_skillList").select("state");
    const dead = skillRows.filter((r: any) => Number(r.state) === -4).length;
    if (skillRows.length) {
      issues.push({
        level: "info",
        where: "o_skillList",
        message: `该表已废弃（代码不读它）：共 ${skillRows.length} 条，其中 ${dead} 条标记为「文件不存在」。判断有哪些技能请看 data/skills 目录`,
      });
    }
  } catch {
    // 表可能不存在（老库），忽略
  }

  return {
    files,
    agentModels,
    issues,
    errorCount: issues.filter((i) => i.level === "error").length,
  };
}
