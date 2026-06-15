#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [stateDirArg, requestPathArg] = process.argv.slice(2);
if (!stateDirArg || !requestPathArg) {
  throw new Error("usage: verify-knowledge-revocation.mjs <state-dir> <apply-request.json>");
}

const stateDir = resolve(stateDirArg);
const request = JSON.parse(readFileSync(resolve(requestPathArg), "utf8"));
const agentIds = [...new Set(request.revokedKnowledgeAgentIds ?? [])];
if (agentIds.some((id) => typeof id !== "string" || !/^[a-z0-9-]+$/.test(id))) {
  throw new Error("apply request contains an invalid revokedKnowledgeAgentIds entry");
}
if (agentIds.length === 0) process.exit(0);

const knowledge = JSON.parse(readFileSync(join(stateDir, "config-store", "knowledge.json"), "utf8"));
const runtime = JSON.parse(readFileSync(join(stateDir, "openclaw.json"), "utf8"));
const failures = [];

for (const agentId of agentIds) {
  const stillBound = (knowledge.knowledgeBases ?? []).some(
    (kb) =>
      kb?.provider === "fastgpt" &&
      typeof kb.externalKbId === "string" &&
      kb.externalKbId.length > 0 &&
      Array.isArray(kb.boundAgents) &&
      kb.boundAgents.includes(agentId),
  );
  if (stillBound) failures.push(`${agentId}: still bound to a FastGPT knowledge base`);

  const agent = (runtime.agents?.list ?? []).find((item) => item?.id === agentId);
  const allowed = Array.isArray(agent?.tools?.allow) ? agent.tools.allow : [];
  if (allowed.some((tool) => /(?:^|__)knowledge_(?:search|import)$/.test(tool))) {
    failures.push(`${agentId}: runtime still exposes a knowledge tool`);
  }

  const mcpServers = Object.entries(runtime.mcp?.servers ?? {});
  if (
    mcpServers.some(
      ([name, server]) => name === `kb-${agentId}` || JSON.stringify(server).includes(`/mcp/${agentId}`),
    )
  ) {
    failures.push(`${agentId}: runtime still registers a knowledge MCP server`);
  }
}

if (failures.length > 0) throw new Error(failures.join("; "));
