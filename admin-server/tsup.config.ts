import { defineConfig } from "tsup";

// 后端打包：src（全 TS）打成单文件 dist/server.js；node_modules 外置（运行时从依赖解析）。
// ADR-010 步骤6：原 lib/*.mjs 已全部 ts化迁入 src/，lib/ 目录移除。
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  splitting: false,
  bundle: true,
  shims: false,
  dts: false,
});
