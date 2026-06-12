// MCP 端点（架构 I，ADR-006）：把 knowledge_search 暴露给 openclaw 数字员工。
// openclaw 侧注册（yomakit，纯配置无需改源码，守 ADR-002）：
//   openclaw mcp add fastgpt --url http://127.0.0.1:18790/mcp/hr-employee \
//     --transport streamable-http --header "Authorization=Bearer <KNOWLEDGE_MCP_TOKEN>" \
//     --include knowledge_search
// 工具在 openclaw 侧命名空间化为 `fastgpt__knowledge_search`——hr-employee 的 tools.allow 用此名。
// 传输：streamable-http stateless（每请求新建 server+transport，无会话生命周期，最省心）。
// 鉴权：Bearer 令牌，fail-closed；与 /api 的 cookie/RBAC 是两套，故挂在 /api 鉴权之外。
import type { Express, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { KNOWLEDGE_MCP_TOKEN } from "./config.js";
import { KnowledgeUnavailableError, resolveDatasetIdsForAgent, search, type KbChunk } from "./services/knowledge.js";
import { log } from "./util.js";

// 路A引用：title 必有锚点，文档编号/版本 best-effort（无则省略，绝不编造）。
function citation(src: KbChunk["source"]): string {
  const parts = [src.filename];
  if (src.doc_id) parts.push(`文档编号: ${src.doc_id}`);
  if (src.version) parts.push(`版本: ${src.version}`);
  return `[来源: ${parts.join(", ")}]`;
}

// #45 多库路由：每 agent 一个 MCP 注册，agentId 走 URL 路径 `/mcp/:agentId`；据 knowledge.json 绑定
// 解析出该 agent 应检索的 datasetIds 传入 search。无 agentId 的旧调用方走默认单库，仅用于向后兼容。
function buildServer(datasetIds?: string[]): McpServer {
  const server = new McpServer({ name: "yomajia-knowledge", version: "1.0.0" });
  server.registerTool(
    "knowledge_search",
    {
      title: "HR 知识库检索",
      description:
        "检索 HR 制度知识库，返回最相关的政策片段及来源（文档编号/版本）。仅做检索、不生成答案——" +
        "答案与口径由调用方（hr-policy-qa）基于返回片段组织，并按片段附带的来源拼引用。",
      inputSchema: {
        query: z.string().describe("员工的政策问题或关键词"),
        topK: z.number().int().min(1).max(20).optional().describe("返回片段数，默认 5"),
      },
    },
    async ({ query, topK }) => {
      try {
        const chunks = await search(query, topK ?? 5, datasetIds);
        if (chunks.length === 0) {
          return { content: [{ type: "text", text: "知识库未命中相关内容。" }] };
        }
        const text = chunks
          .map((c, i) => `#${i + 1}（score ${c.score.toFixed(2)}）\n${c.text}\n${citation(c.source)}`)
          .join("\n\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        if (err instanceof KnowledgeUnavailableError) {
          // ADR-010：已弃本地回退（FastGPT 为唯一知识源）。不可达时诚实告知不可用、不要编造，
          // 引导用户稍后重试或联系 HR。
          return {
            content: [
              {
                type: "text",
                text:
                  `知识库平台暂时不可用（${err.message}）。请如实告知用户：` +
                  `「知识库平台暂时不可用，请稍后重试，或直接联系 HR」；不要编造政策内容。`,
              },
            ],
          };
        }
        throw err;
      }
    },
  );
  return server;
}

export function mountMcp(app: Express): void {
  app.all(["/mcp", "/mcp/:agentId"], async (req: Request, res: Response) => {
    // fail-closed：未配置令牌或不匹配一律拒绝。
    const expected = KNOWLEDGE_MCP_TOKEN ? `Bearer ${KNOWLEDGE_MCP_TOKEN}` : "";
    if (!expected || req.headers.authorization !== expected) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
      return;
    }
    // 路径带 agentId → 按其 knowledge.json 绑定解析 datasetIds；不带 → undefined（默认单库，向后兼容）。
    const agentId = typeof req.params.agentId === "string" ? req.params.agentId : undefined;
    const datasetIds = agentId ? resolveDatasetIdsForAgent(agentId) : undefined;
    const server = buildServer(datasetIds);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      // express.json() 已解析 body，须显式传入，否则 transport 等待已被读空的流而挂起。
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("ERROR", `/mcp handler error: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
      }
    }
  });
}
