import { defineConfig } from "tsup";

// 后端打包：src + 本地 lib/*.mjs 打成单文件 dist/server.js；node_modules 外置（运行时从依赖解析）。
// lib 已确认不依赖 import.meta/__dirname 做文件定位，打包安全。
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
