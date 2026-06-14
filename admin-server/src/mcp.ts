// MCP 端点（架构 I，ADR-006/010）：把 knowledge_search（检索）+ knowledge_import（导入，仅 admin）暴露给数字员工。
// openclaw 侧注册由 config 生成器按 knowledge.json 绑定**自动派生**（ADR-011，纯配置守 ADR-002）——
// 不再手工 `openclaw mcp add`。每个有 FastGPT 绑定的 agent 一注册，名为 `kb-<agentId>`、URL 带 agentId：
//   员工（只读）：kb-hr-employee → http://127.0.0.1:18790/mcp/hr-employee，include [knowledge_search]
//   管理员（读+导入）：kb-hr-admin → http://127.0.0.1:18790/mcp/hr-admin，include [knowledge_search, knowledge_import]
// 工具因注册名而 per-agent 命名空间化为 `kb-<agentId>__knowledge_search` / `…__knowledge_import`；
//   agent 至多一个 `*__knowledge_search`，故 skill/workspace 文档泛指 knowledge_search 即可唯一定位。
// knowledge_import 双重门：生成器 toolFilter.include 软过滤 + 服务器侧 isAdminAgent(agentId) 硬闸。
// 传输：streamable-http stateless（每请求新建 server+transport，无会话生命周期，最省心）。
// 鉴权：Bearer 令牌，fail-closed；与 /api 的 cookie/RBAC 是两套，故挂在 /api 鉴权之外。
import type { Express, Request, Response } from "express";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { KNOWLEDGE_MCP_TOKEN } from "./config.js";
import {
  KnowledgeUnavailableError,
  importDocument,
  isConfigured,
  resolveDatasetIdsForAgent,
  resolveImportDatasetId,
  search,
  type KbChunk,
} from "./services/knowledge.js";
import { listAgents } from "./services/orchestrator.js";
import { appendAuditLog, log } from "./util.js";

// 路A引用：title 必有锚点，文档编号/版本 best-effort（无则省略，绝不编造）。
function citation(src: KbChunk["source"]): string {
  const parts = [src.filename];
  if (src.doc_id) parts.push(`文档编号: ${src.doc_id}`);
  if (src.version) parts.push(`版本: ${src.version}`);
  return `[来源: ${parts.join(", ")}]`;
}

/** agentId 是否为 admin 角色 agent（knowledge_import 的服务器侧硬闸，不只靠 openclaw --include 软过滤）。 */
function isAdminAgent(agentId?: string): boolean {
  if (!agentId) return false;
  return listAgents().some((a) => a.id === agentId && a.role === "admin");
}

// #45 多库路由：每 agent 一个 MCP 注册，agentId 走 URL 路径 `/mcp/:agentId`；据 knowledge.json 绑定
// 解析出该 agent 应检索的 datasetIds 传入 search。无 agentId 的旧调用方走默认单库，仅用于向后兼容。
function buildServer(datasetIds?: string[], agentId?: string): McpServer {
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

  // ADR-010 聊天导入：hr-admin agent 经此把管理员提供的服务器文件直传 FastGPT 原生解析导入。
  // 仅对 admin 角色 agent 开放（openclaw 侧 --include 控制可见性 + 此处服务器侧角色硬闸双保险）。
  server.registerTool(
    "knowledge_import",
    {
      title: "HR 知识库导入（管理员）",
      description:
        "把服务器上的文档文件导入 HR 知识库（交 FastGPT 原生解析/切片/向量化）。仅管理员可用。" +
        "filePath 为服务器可读的文件绝对路径（管理员提供，或渠道附件注入的 [media attached: /path]）。",
      inputSchema: {
        filePath: z.string().describe("服务器上待导入文档的绝对路径"),
        datasetId: z.string().optional().describe("目标知识库 datasetId；省略则导入默认库"),
      },
    },
    async ({ filePath, datasetId }) => {
      if (!isAdminAgent(agentId)) {
        return { content: [{ type: "text", text: "无权导入：knowledge_import 仅管理员数字员工可用。" }], isError: true };
      }
      if (!isConfigured()) {
        return { content: [{ type: "text", text: "知识库平台（FastGPT）未配置，无法导入。" }], isError: true };
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        return { content: [{ type: "text", text: `文件不存在或不是普通文件：${filePath}` }], isError: true };
      }
      let dsId: string;
      try {
        dsId = resolveImportDatasetId(datasetId);
      } catch (err) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
      const filename = basename(filePath);
      const operator = { id: agentId ?? "agent", name: agentId ?? "agent" };
      try {
        const { collectionId } = await importDocument(readFileSync(filePath), filename, dsId);
        appendAuditLog("IMPORT", filename, { status: "success", platform: "fastgpt", collectionId, kbId: dsId, via: "chat", operator });
        return { content: [{ type: "text", text: `已导入「${filename}」到知识库（collectionId=${collectionId}）。FastGPT 正在切片/向量化，稍后可在知识库页查看。` }] };
      } catch (err) {
        appendAuditLog("IMPORT", filename, { status: "failed", platform: "fastgpt", reason: (err as Error).message, kbId: dsId, via: "chat", operator });
        return { content: [{ type: "text", text: `导入失败：${(err as Error).message}` }], isError: true };
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
    const server = buildServer(datasetIds, agentId);
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
