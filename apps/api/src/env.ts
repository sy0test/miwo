/**
 * Phase 0：配置已集中到 src/config.ts（spec §4.3）。
 * 本文件仅保留为兼容垫片，确保 app.ts 顶部 `import "./env"` 等既有引用不炸。
 * NODE_ENV 的派生由 config.ts 完成（dev -> development，prod -> production）。
 */
import "@/config";
