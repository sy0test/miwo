import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { maskSecrets } from "@/utils/secrets";
import { requireAdmin } from "@/middleware/tenant";

// Phase 1c Task 4：整族 13 个端点收权。
// Phase 1c Task 9（Tier 0 #2）：**即使 admin 也不回传凭据明文** —— 本文件原本把
//   `o_vendorConfig.inputValues` 原样 `JSON.parse` 后回给前端，那是供应商 API key 的明文；
//   现在值一律经 `maskSecrets`（命中 `key/token/secret/password` 这类**键名**的换成 `"***"`），
//   并把"填过没填过"单独放进 `__configured`。`code`（适配器源码整份）字段**整块删掉**：
//   适配器已编译期内置（Task 8），前端编辑器的那条路归 Task 11。
const router = express.Router();

/**
 * ⚠ 这里**刻意不做"只回适配器声明过的键"的白名单过滤**（第一版做了，当场发现是行为回归）：
 * `inputValues` 里除凭据外还有 `baseUrl` / `chatBaseUrl` / `mediaBaseUrl` 这类**非凭据**配置，
 * 它们是前端表单要显示与编辑的（老实现把整个 `inputValues` 回传，前端就靠它填输入框）。
 * 用 `vendor.inputs[].key` 过滤会把这些键一起丢掉 —— 那是**功能回归**，不是安全收益：
 * 安全性由"值掩码"（`maskSecrets`，**按键名**，不依赖适配器声明）保证，
 * 与"键要不要回传"是两件事。
 */

export default router.post("/", requireAdmin, async (req, res) => {
  const data = await u.db("o_vendorConfig").select("*");

  const list = (
    await Promise.all(
      data.map(async (item) => {
        const vendor = u.vendor.getVendor(item.id!);
        if (!vendor) {
          await u.db("o_vendorConfig").where("id", item.id).delete();
          return null;
        }
        // ⚠ 必须真的把原始列**剔除**（而不是"覆盖"）：`...item` 会把 `inputValues` 这个
        //   **原始列**（含明文 key 的 JSON 字符串）一起带出来 —— 只覆盖 `inputValues` 字段
        //   是不够的，同名键会打架。这里先解构丢弃，再显式给掩码后的形状。
        const { inputValues: rawInputValues, ...rest } = item;
        const masked = maskSecrets(JSON.parse(rawInputValues ?? "{}"));
        return {
          ...rest,
          // 值：命中凭据键名的一律 `"***"`；其余（baseUrl 等）原样，老形状不变。
          inputValues: masked.values,
          // 存在性：`{键名: 是否非空}`（**不给值**），前端据此显示"已配置/未配置"。
          __configured: masked.configured,
          models: await u.vendor.getModelList(item.id!),
          description: vendor.description ?? "",
          inputs: vendor.inputs,
          author: vendor.author,
          name: vendor.name,
          version: vendor.version ?? "1.0",
        };
      }),
    )
  ).filter((i) => Boolean(i));

  list.sort((a, b) => (a!.id === "miwo" ? -1 : b!.id === "miwo" ? 1 : 0));
  res.status(200).send(success(list));
});
