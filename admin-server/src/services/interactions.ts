// 交互分析聚合（Sprint 10 #34，支柱三）。
//
// 消费 hook-logger（#31）产出的 $STATE_DIR/data/interactions/events-YYYYMMDD.jsonl，
// 按 runId 聚合成「一轮交互」，输出 dashboard 所需指标。
// 聚合口径与 scripts/analytics/interaction-report.py 保持一致（CLI 版为参照实现）。
//
// 只读服务：不写任何状态，文件缺失/行损坏一律跳过不抛。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../config.js";

const MISS_MARKERS = ["未命中", "未找到", "no results", "暂时不可用"];

interface SearchRecord {
  query: string | null;
  durationMs: number | null;
  resultText: string | null;
  error: string | null;
  closed: boolean;
}

interface RunAgg {
  day: string;
  agentId: string | null;
  channel: string | null;
  senderId: string | null;
  searches: SearchRecord[];
  success: boolean | null;
  turnDurationMs: number | null;
  tokensIn: number;
  tokensOut: number;
}

export interface InteractionSummary {
  turns: number;
  byAgent: Record<string, number>;
  byChannel: Record<string, number>;
  byDay: Array<{ day: string; turns: number }>;
  failedTurns: number;
  searches: number;
  searchHitRate: number | null;
  searchesPerTurn: number | null;
  turnDurationMs: { p50: number | null; p90: number | null; max: number | null };
  searchDurationMs: { p50: number | null; p90: number | null };
  tokens: { input: number; output: number };
  topQueryTerms: Array<{ term: string; count: number }>;
  misses: Array<{ runId: string; day: string; query: string | null; error: string | null }>;
  files: number;
}

function interactionsDir(): string {
  return join(STATE_DIR, "data", "interactions");
}

function pctl(values: number[], p: number): number | null {
  if (!values.length) return null;
  const vs = [...values].sort((a, b) => a - b);
  const idx = Math.min(vs.length - 1, Math.max(0, Math.round((p / 100) * (vs.length - 1))));
  return vs[idx];
}

function isHit(s: SearchRecord): boolean {
  if (s.error) return false;
  const text = s.resultText || "";
  if (!text.trim()) return false;
  return !MISS_MARKERS.some((m) => text.includes(m));
}

export function summarizeInteractions(sinceDay?: string): InteractionSummary {
  let files: string[] = [];
  try {
    files = readdirSync(interactionsDir())
      .filter((f) => /^events-\d{8}\.jsonl$/.test(f))
      .filter((f) => !sinceDay || f.slice(7, 15) >= sinceDay)
      .sort();
  } catch {
    files = [];
  }

  const runs = new Map<string, RunAgg>();
  for (const file of files) {
    const day = file.slice(7, 15);
    let content = "";
    try {
      content = readFileSync(join(interactionsDir(), file), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const rid = e.runId;
      if (!rid) continue;
      let r = runs.get(rid);
      if (!r) {
        r = { day, agentId: null, channel: null, senderId: null, searches: [], success: null, turnDurationMs: null, tokensIn: 0, tokensOut: 0 };
        runs.set(rid, r);
      }
      r.agentId = r.agentId ?? e.agentId ?? null;
      r.channel = r.channel ?? e.channel ?? null;
      switch (e.hook) {
        case "message_received":
          r.senderId = e.senderId ?? r.senderId;
          break;
        case "tool_call_start":
          if (e.query !== undefined && e.query !== null) {
            r.searches.push({ query: e.query, durationMs: null, resultText: null, error: null, closed: false });
          }
          break;
        case "tool_call_end": {
          if (e.resultText === undefined) break; // 非检索类工具（只记元数据）不计入检索指标
          const open = r.searches.find((s) => !s.closed);
          const rec: SearchRecord = open ?? { query: null, durationMs: null, resultText: null, error: null, closed: false };
          rec.durationMs = e.durationMs ?? null;
          rec.resultText = e.resultText ?? null;
          rec.error = e.error ?? null;
          rec.closed = true;
          if (!open) r.searches.push(rec);
          break;
        }
        case "agent_end":
          r.success = e.success ?? null;
          r.turnDurationMs = e.durationMs ?? null;
          break;
        case "llm_output":
          r.tokensIn += e.usage?.input || 0;
          r.tokensOut += e.usage?.output || 0;
          break;
      }
    }
  }

  const byAgent: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  const byDayMap = new Map<string, number>();
  const turnDurs: number[] = [];
  const searchDurs: number[] = [];
  const termCounter = new Map<string, number>();
  const misses: InteractionSummary["misses"] = [];
  let failedTurns = 0;
  let searchN = 0;
  let hitN = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  for (const [rid, r] of runs) {
    byAgent[r.agentId || "unknown"] = (byAgent[r.agentId || "unknown"] || 0) + 1;
    byChannel[r.channel || "local/web"] = (byChannel[r.channel || "local/web"] || 0) + 1;
    byDayMap.set(r.day, (byDayMap.get(r.day) || 0) + 1);
    if (r.success === false) failedTurns += 1;
    if (r.turnDurationMs) turnDurs.push(r.turnDurationMs);
    tokensIn += r.tokensIn;
    tokensOut += r.tokensOut;
    for (const s of r.searches) {
      searchN += 1;
      if (s.durationMs) searchDurs.push(s.durationMs);
      if (s.query) {
        for (const term of s.query.split(/\s+/).filter(Boolean)) {
          termCounter.set(term, (termCounter.get(term) || 0) + 1);
        }
      }
      if (isHit(s)) hitN += 1;
      else misses.push({ runId: rid, day: r.day, query: s.query, error: s.error });
    }
  }

  return {
    turns: runs.size,
    byAgent,
    byChannel,
    byDay: [...byDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, turns]) => ({ day, turns })),
    failedTurns,
    searches: searchN,
    searchHitRate: searchN ? Math.round((hitN / searchN) * 10000) / 10000 : null,
    searchesPerTurn: runs.size ? Math.round((searchN / runs.size) * 100) / 100 : null,
    turnDurationMs: { p50: pctl(turnDurs, 50), p90: pctl(turnDurs, 90), max: turnDurs.length ? Math.max(...turnDurs) : null },
    searchDurationMs: { p50: pctl(searchDurs, 50), p90: pctl(searchDurs, 90) },
    tokens: { input: tokensIn, output: tokensOut },
    topQueryTerms: [...termCounter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([term, count]) => ({ term, count })),
    misses: misses.slice(0, 20),
    files: files.length,
  };
}
