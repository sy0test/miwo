/**
 * ⚠ 占位实现 —— Task 3 会用真实的 27 张表 DDL 整体替换本文件。
 * 存在只是为了 Task 2 的迁移机制能独立跑起来（可测、可提交）。
 *
 * 本文件**故意不写任何真实 DDL**：Task 3 完成判据里有一条"占位实现已不存在"。
 */
import type { Knex } from "knex";

export default {
  name: "001_schema",
  async up(_knex: Knex): Promise<void> {
    // Task 3 在这里建全部表
  },
  async down(_knex: Knex): Promise<void> {
    // Task 3 在这里按逆序 drop 全部表
  },
};
