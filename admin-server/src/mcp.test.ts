import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const stateDir = join(tmpdir(), `yomajiahr-mcp-test-${process.pid}`);
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(join(stateDir, "config-store"), { recursive: true });
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.KNOWLEDGE_PLATFORM = "fastgpt";
process.env.FASTGPT_BASE_URL = "http://10.99.0.1:3000";
process.env.FASTGPT_API_KEY = "test-fastgpt-secret";
process.env.FASTGPT_KB_ID = "ds_default";
process.env.KNOWLEDGE_MCP_TOKEN = "test-mcp-token";
writeFileSync(
  join(stateDir, "config-store", "agents.json"),
  JSON.stringify([
    { id: "agent-new", role: "employee", name: "新员工", workspace: "~/.openclaw/workspaces/agent-new", skills: [] },
    { id: "admin-agent", role: "admin", name: "管理员", workspace: "~/.openclaw/workspaces/admin-agent", skills: [] },
  ], null, 2) + "\n",
);
writeFileSync(join(stateDir, "config-store", "channels.json"), "[]\n");
writeFileSync(join(stateDir, "config-store", "bindings.json"), "[]\n");
writeFileSync(
  join(stateDir, "config-store", "knowledge.json"),
  JSON.stringify({
    platform: "fastgpt",
    knowledgeBases: [
      { id: "kb_default", name: "默认库", provider: "fastgpt", externalKbId: "ds_default", boundAgents: [] },
      { id: "kb_new", name: "新库", provider: "fastgpt", externalKbId: "ds_new", boundAgents: ["agent-new"] },
    ],
  }, null, 2) + "\n",
);

const { createApp } = await import("./app.js");
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function withMcpClient<T>(path: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const app = createApp();
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}${path}`),
    { requestInit: { headers: { Authorization: "Bearer test-mcp-token" } } },
  );
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("/mcp/:agentId 的 knowledge_search 只检索该 agent 绑定的新库", async () => {
  const searchedDatasetIds: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
    if (url.includes("/searchTest")) {
      const body = JSON.parse(String(init?.body || "{}"));
      searchedDatasetIds.push(body.datasetId);
      return new Response(JSON.stringify({ data: { list: [{ q: `${body.datasetId} 命中`, a: "", score: 0.9, sourceName: "制度.pdf" }] } }), { status: 200 });
    }
    if (url.includes("/collection/detail")) return new Response(JSON.stringify({ data: { name: "制度.pdf" } }), { status: 200 });
    throw new Error(`unexpected url ${url}`);
  };

  const result = await withMcpClient("/mcp/agent-new", (client) => client.callTool({ name: "knowledge_search", arguments: { query: "制度" } }));

  assert.deepEqual(searchedDatasetIds, ["ds_new"]);
  assert.match(JSON.stringify(result), /ds_new 命中/);
});

test("/mcp/:agentId 未绑定时 fail-closed，不回退默认库", async () => {
  let fetchCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
    fetchCount += 1;
    throw new Error("unbound agent should not call FastGPT");
  };

  const result = await withMcpClient("/mcp/unbound-agent", (client) => client.callTool({ name: "knowledge_search", arguments: { query: "制度" } }));

  assert.equal(fetchCount, 0);
  assert.match(JSON.stringify(result), /知识库未命中相关内容/);
});

test("legacy /mcp 仅兼容默认库", async () => {
  const searchedDatasetIds: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
    if (url.includes("/searchTest")) {
      const body = JSON.parse(String(init?.body || "{}"));
      searchedDatasetIds.push(body.datasetId);
      return new Response(JSON.stringify({ data: { list: [{ q: `${body.datasetId} 命中`, a: "", score: 0.8, sourceName: "默认.pdf" }] } }), { status: 200 });
    }
    if (url.includes("/collection/detail")) return new Response(JSON.stringify({ data: { name: "默认.pdf" } }), { status: 200 });
    throw new Error(`unexpected url ${url}`);
  };

  await withMcpClient("/mcp", (client) => client.callTool({ name: "knowledge_search", arguments: { query: "制度" } }));

  assert.deepEqual(searchedDatasetIds, ["ds_default"]);
});
