/**
 * 测试夹具的共享 helper。
 *
 * ── 为什么需要它（Phase 1c Task 10 的教训）──
 * `MiwoConfig` 是**结构化类型**，所以单测里手写的配置字面量必须逐字跟住接口。
 * Task 10 给接口加了 4 个字段（`ossUrl` / `ffmpeg` / `redrawPrepScript` / `proxyUrl`），
 * 立刻有 4 个测试文件 `tsc --noEmit` 报 TS2739 —— 每个都得手工补一次。
 * 下一个加字段的人会再踩一遍。
 *
 * 这里把"新字段的默认值"绑到**产品代码自己的默认值**上（`loadConfig({})` 会抛，
 * 所以传一份最小 env），于是：
 *   · 将来再加必填字段 ⇒ 单测**不用改**（新字段自动带上产品默认值）；
 *   · 默认值本身被改坏 ⇒ 单测仍然会捕捉到（因为它来自产品代码，不是这里手抄的第二份真相）。
 */
import { loadConfig, type MiwoConfig } from "@/config";

/** 最小合法 env（与 `tests/config.test.ts` 的 `base` 同形）。 */
const MINIMAL_ENV = {
  MIWO_ENV: "dev",
  MIWO_PORT: "10599",
  MIWO_HOST: "127.0.0.1",
  MIWO_DATA_DIR: "D:\\tmp\\miwo-test-helper",
  MIWO_JWT_SECRET: "x".repeat(48),
} as NodeJS.ProcessEnv;

/**
 * 取一份"产品代码的默认值"快照，只留与路径/库无关的那些字段。
 *
 * ⚠ 刻意**不**返回 `dataDir`/`mediaDir`/`db`/`port`/`host`：这些是每个测试自己的夹具要控制的，
 *   用产品默认值会把测试绑到 vitest 的环境变量上（不可预测）。调用方显式给它们。
 */
export function configDefaults(): Pick<
  MiwoConfig,
  "env" | "storageDriver" | "publicBaseUrl" | "trustProxy" | "jwtSecret" | "ossUrl" | "ffmpeg" | "redrawPrepScript" | "proxyUrl"
> {
  const c = loadConfig({ ...MINIMAL_ENV });
  return {
    env: c.env,
    storageDriver: c.storageDriver,
    publicBaseUrl: c.publicBaseUrl,
    trustProxy: c.trustProxy,
    jwtSecret: c.jwtSecret,
    ossUrl: c.ossUrl,
    ffmpeg: { ...c.ffmpeg },
    redrawPrepScript: c.redrawPrepScript,
    proxyUrl: c.proxyUrl,
  };
}
