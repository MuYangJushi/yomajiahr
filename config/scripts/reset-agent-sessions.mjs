#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chownSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const [stateDirArg, requestPathArg] = process.argv.slice(2);
if (!stateDirArg || !requestPathArg) {
  throw new Error("usage: reset-agent-sessions.mjs <state-dir> <apply-request.json>");
}

const stateDir = resolve(stateDirArg);
const request = JSON.parse(readFileSync(resolve(requestPathArg), "utf8"));
const agentIds = [...new Set(request.resetAgentIds ?? [])];
if (agentIds.some((id) => typeof id !== "string" || !/^[a-z0-9-]+$/.test(id))) {
  throw new Error("apply request contains an invalid resetAgentIds entry");
}

const plans = agentIds.map((agentId) => {
  const sessionsDir = join(stateDir, "agents", agentId, "sessions");
  const storePath = join(sessionsDir, "sessions.json");
  if (!existsSync(storePath)) return { agentId, sessionsDir, storePath, store: {}, entries: [] };

  const store = JSON.parse(readFileSync(storePath, "utf8"));
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    throw new Error(`${agentId}: sessions.json must contain an object`);
  }
  const entries = Object.values(store);
  for (const entry of entries) {
    if (entry?.sessionFile === undefined) continue;
    if (
      typeof entry.sessionFile !== "string" ||
      dirname(resolve(entry.sessionFile)) !== resolve(sessionsDir)
    ) {
      throw new Error(`${agentId}: sessions.json contains an unsafe sessionFile`);
    }
  }
  return { agentId, sessionsDir, storePath, store, entries };
});

const timestamp = new Date().toISOString().replace(/:/g, "-");
const results = [];
for (const plan of plans) {
  const { agentId, sessionsDir, storePath, entries } = plan;
  if (!existsSync(storePath)) {
    results.push({ agentId, sessionCount: 0 });
    continue;
  }

  for (const entry of entries) {
    if (typeof entry?.sessionFile !== "string" || !existsSync(entry.sessionFile)) continue;
    renameSync(entry.sessionFile, `${entry.sessionFile}.reset.${timestamp}`);
  }

  mkdirSync(sessionsDir, { recursive: true });
  const stat = lstatSync(storePath);
  const tmp = `${storePath}.tmp.${process.pid}`;
  writeFileSync(tmp, "{}\n", { mode: stat.mode });
  chmodSync(tmp, stat.mode);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    chownSync(tmp, stat.uid, stat.gid);
  }
  renameSync(tmp, storePath);
  results.push({ agentId, sessionCount: entries.length });
}

process.stdout.write(`${JSON.stringify(results)}\n`);
