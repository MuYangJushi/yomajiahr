#!/usr/bin/env node

console.warn(
  "[deprecated] pdf-to-markdown.mjs is kept for compatibility. Prefer scripts/doc-to-markdown.mjs for multi-format imports.",
);
await import("./doc-to-markdown.mjs");
