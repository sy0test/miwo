/**
 * 队列策略常量（spec §9.3 + 控制器口径）—— **O10 的唯一落点**。
 *
 * ⚠ **为什么不做成环境变量**：本阶段的硬约束是"不新增任何 `MIWO_*` 变量"（新增要同时改
 *   `deploy/.env.example`、`apps/api/.env.example` 与 `tools/check-deploy-config.cjs` 的白名单
 *   三处，收益为零）。这些值是**项目策略**而不是部署旋钮；集中在这一个文件里，改口径只改这里。
 *
 * ⚠ **O10 未定**（spec §15：100 并发指"注册用户 / 日活 / 同时在线 / 同时生成"中的哪一种）。
 *   下面这组数是**按"100 = 注册用户"取的保守默认**（最不容易把服务器与厂商配额打挂）。
 *   口径一旦确定，只需改三个值：`globalMaxRunning` / `perUserMaxRunning` /（Task 9 的）池上限。
 *
 * ⚠ 改这里的值会改变**并发正确性用例的边界**（`tests/job-store.test.ts` 用 `{...JOB_POLICY, ...}`
 *   覆盖单个字段，所以不受影响）；但 `heartbeatMs * 4 <= leaseMs` 这条不变式有断言守。
 */
export const JOB_POLICY = {
  /** 租约：领取时写 `now + leaseMs`，心跳每次续租。 */
  leaseMs: 60_000,
  /** 心跳间隔：必须显著小于 `leaseMs`（1/4），否则一次长 GC 就会被误判成死亡。 */
  heartbeatMs: 15_000,
  /** 每个 worker 进程内同时在跑的任务数上限（全局口径）。 */
  globalMaxRunning: 8,
  /** 每个用户同时可占的额度（按用户口径；多 worker 时为"每 worker 一份"，见组报告）。 */
  perUserMaxRunning: 2,
  /** 一次领取最多扫多少条候选（按用户上限的过滤发生在 JS 侧，所以要一次多扫几条）。 */
  claimBatch: 64,
  /** 队列空 / 候选都在退避时的轮询间隔。 */
  idlePollMs: 1_000,
  /** 还有活干但没空槽时的轮询间隔。 */
  busyPollMs: 200,
  /** payload 上限：只存引用 id，不该有大对象（base64 一律不进队列）。 */
  maxPayloadBytes: 64 * 1024,
  /** 失败退避：`base * 2^(attempts-1)`，封顶 `retryMaxMs`。 */
  retryBaseMs: 30_000,
  retryMaxMs: 600_000,
  /** SIGTERM 后等在跑任务收尾的时间；超时则 abort。 */
  shutdownGraceMs: 25_000,
  /** 租约到期回收后，若该 job 已死且产物仍是"生成中"，对账器的宽限期。 */
  stuckGraceMs: 1_800_000,
  /** api 侧进度 relay：轮询间隔与每轮条数。 */
  relayPollMs: 1_000,
  relayBatch: 200,
  /** `o_gate` 槽位：等待上限 / 槽位租约 / 轮询间隔。 */
  gateWaitMs: 120_000,
  gateLeaseMs: 300_000,
  gatePollMs: 200,
  /** `selftest.sleep` 的睡眠时长（运维冒烟 + chaos）。 */
  selftestSleepMs: 1_500,
} as const;

export type JobPolicy = typeof JOB_POLICY;

/**
 * 指数退避（`attempt` 是**已经失败**的那一次的次数，1 基）。
 * 与 `store.fail()` 里的实现必须一致 —— 后者直接调它，不另写一份公式。
 */
export function backoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(JOB_POLICY.retryBaseMs * Math.pow(2, n - 1), JOB_POLICY.retryMaxMs);
}
