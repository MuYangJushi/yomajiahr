#!/usr/bin/env python3
"""Yoma+HR 交互分析报告（Sprint 10 #34 地基，CLI 版）。

消费 hook-logger（#31）产出的交互事件库，按 runId 聚合出一轮=一条交互记录，
输出核心指标：轮次数、检索命中率、时延分位、token 成本、高频查询、未命中清单。
web dashboard（#34 完整版）复用本文件的聚合逻辑。

用法（在 yomakit 上，或把 events 文件取到本地）：
  python3 interaction-report.py [--dir ~/.openclaw/data/interactions] \
      [--since 20260706] [--json out.json]

只读，无副作用。
"""
import argparse
import glob
import json
import os
import re
import statistics
from collections import Counter, defaultdict

MISS_MARKERS = ("未命中", "未找到", "no results", "暂时不可用")


def load_events(dir_path, since):
    for path in sorted(glob.glob(os.path.join(dir_path, "events-*.jsonl"))):
        day = re.search(r"events-(\d{8})\.jsonl$", path)
        if since and day and day.group(1) < since:
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue


def build_runs(events):
    """按 runId 聚合。无 runId 的事件（如 session_start）单独归档，不计入轮次。"""
    runs = defaultdict(lambda: {"searches": [], "agent_end": None, "usage": None,
                                "agentId": None, "channel": None, "senderId": None,
                                "question": None, "ts": None})
    orphan = []
    for e in events:
        rid = e.get("runId")
        if not rid:
            orphan.append(e)
            continue
        r = runs[rid]
        r["ts"] = r["ts"] or e.get("ts")
        r["agentId"] = r["agentId"] or e.get("agentId")
        r["channel"] = r["channel"] or e.get("channel")
        h = e.get("hook")
        if h == "message_received":
            r["senderId"] = e.get("senderId")
            r["question"] = e.get("content")
        elif h == "tool_call_start" and e.get("query") is not None:
            r["searches"].append({"query": e.get("query"), "end": None})
        elif h == "tool_call_end" and e.get("resultText") is not None:
            # 与最近一个未闭合的 search 配对；无配对则独立记录
            open_slots = [s for s in r["searches"] if s["end"] is None]
            slot = open_slots[0] if open_slots else None
            entry = {"durationMs": e.get("durationMs"), "resultText": e.get("resultText"),
                     "error": e.get("error")}
            if slot:
                slot["end"] = entry
            else:
                r["searches"].append({"query": None, "end": entry})
        elif h == "agent_end":
            r["agent_end"] = {"success": e.get("success"), "durationMs": e.get("durationMs"),
                              "replyText": e.get("replyText")}
        elif h == "llm_output":
            r["usage"] = e.get("usage")
    return runs, orphan


def search_hit(end):
    if not end or end.get("error"):
        return False
    text = end.get("resultText") or ""
    if not text.strip():
        return False
    return not any(m in text for m in MISS_MARKERS)


def pctl(values, p):
    if not values:
        return None
    vs = sorted(values)
    idx = min(len(vs) - 1, max(0, round(p / 100 * (len(vs) - 1))))
    return vs[idx]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.expanduser("~/.openclaw/data/interactions"))
    ap.add_argument("--since", help="YYYYMMDD，只统计该日期（含）之后的文件")
    ap.add_argument("--json", help="同时输出完整 JSON 到该路径")
    ap.add_argument("--top", type=int, default=10)
    args = ap.parse_args()

    runs, orphan = build_runs(load_events(args.dir, args.since))
    if not runs:
        print("交互库暂无带 runId 的事件（目录：%s）" % args.dir)
        return

    turn_durs, search_durs, queries, misses, fails = [], [], [], [], []
    tokens_in = tokens_out = 0
    hit_n = search_n = 0
    by_agent = Counter()
    by_channel = Counter()

    for rid, r in runs.items():
        by_agent[r["agentId"] or "unknown"] += 1
        by_channel[r["channel"] or "local/web"] += 1
        ae = r["agent_end"]
        if ae:
            if ae.get("durationMs"):
                turn_durs.append(ae["durationMs"])
            if ae.get("success") is False:
                fails.append(rid)
        u = r["usage"] or {}
        tokens_in += u.get("input") or 0
        tokens_out += u.get("output") or 0
        for s in r["searches"]:
            search_n += 1
            if s.get("query"):
                queries.append(s["query"])
            end = s.get("end")
            if end and end.get("durationMs"):
                search_durs.append(end["durationMs"])
            if search_hit(end):
                hit_n += 1
            else:
                misses.append({"runId": rid, "query": s.get("query"),
                               "error": (end or {}).get("error")})

    summary = {
        "turns": len(runs),
        "byAgent": dict(by_agent),
        "byChannel": dict(by_channel),
        "failedTurns": fails,
        "searches": search_n,
        "searchHitRate": round(hit_n / search_n, 4) if search_n else None,
        "searchesPerTurn": round(search_n / len(runs), 2),
        "turnDurationMs": {"p50": pctl(turn_durs, 50), "p90": pctl(turn_durs, 90), "max": max(turn_durs, default=None)},
        "searchDurationMs": {"p50": pctl(search_durs, 50), "p90": pctl(search_durs, 90)},
        "tokens": {"input": tokens_in, "output": tokens_out},
        "topQueryTerms": Counter(" ".join(queries).split()).most_common(args.top),
        "misses": misses[: args.top],
        "orphanEvents": len(orphan),
    }

    print(f"轮次: {summary['turns']}（按 agent: {summary['byAgent']}；按渠道: {summary['byChannel']}）")
    print(f"失败轮次: {len(fails)}")
    print(f"检索: {search_n} 次，命中率 {summary['searchHitRate']}，平均每轮 {summary['searchesPerTurn']} 次")
    print(f"整轮时延 ms: p50={summary['turnDurationMs']['p50']} p90={summary['turnDurationMs']['p90']} max={summary['turnDurationMs']['max']}")
    print(f"检索时延 ms: p50={summary['searchDurationMs']['p50']} p90={summary['searchDurationMs']['p90']}")
    print(f"token: in={tokens_in} out={tokens_out}")
    print(f"高频查询词 top{args.top}: {summary['topQueryTerms']}")
    if misses:
        print(f"未命中/异常检索（前 {args.top} 条，反哺知识库输入）:")
        for m in misses[: args.top]:
            print(f"  run={m['runId'][:8]} query={m['query']} error={m['error']}")
    if args.json:
        json.dump(summary, open(args.json, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"完整 JSON → {args.json}")


if __name__ == "__main__":
    main()
