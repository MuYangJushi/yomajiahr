#!/usr/bin/env python3
"""Yoma+HR 盲测集检索层评估（Sprint 10 #77）。

对题集逐题调 FastGPT searchTest（对全部绑定 dataset 各搜一次，按 score 合并
取 top-N，模拟 per-agent 多库可搜行为），输出逐题判定与汇总报告数据。

判定指标：
  - retrieval_hit：top-N 结果中任一 chunk 的 collectionId 命中题目 expected 出处
  - keyword_ratio：top-N 文本拼接后命中题目 keywords 的比例（内容层参考指标）

用法（在能访问 FastGPT 的机器上，如 yomakit）：
  FASTGPT_BASE_URL=... FASTGPT_API_KEY=... python3 run-blind-test.py \
      --set blind-test-set-v1.json --out results.json [--top 5]

只读评估：仅调 searchTest，不写任何数据，不触碰生产配置。
"""
import argparse
import json
import os
import sys
import time
import urllib.request


def api_search(base, key, dataset_id, text, retries=3):
    payload = json.dumps({"datasetId": dataset_id, "text": text, "limit": 5000}).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/api/core/dataset/searchTest",
        data=payload,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    for attempt in range(retries):
        try:
            resp = json.load(urllib.request.urlopen(req, timeout=30))
            data = resp.get("data", {})
            return data.get("list", data if isinstance(data, list) else [])
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    return []


def item_score(item):
    s = item.get("score")
    if isinstance(s, list):  # 4.8.x: [{type, value, index}]
        vals = [x.get("value", 0) for x in s if isinstance(x, dict)]
        return max(vals) if vals else 0
    return s or 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--top", type=int, default=5)
    args = ap.parse_args()

    base = os.environ.get("FASTGPT_BASE_URL")
    key = os.environ.get("FASTGPT_API_KEY")
    if not base or not key:
        sys.exit("缺少 FASTGPT_BASE_URL / FASTGPT_API_KEY 环境变量")

    spec = json.load(open(args.set, encoding="utf-8"))
    datasets = spec["meta"]["datasets"]
    col_by_code = {c: v["id"] for c, v in spec["meta"]["collections"].items()}

    results = []
    for q in spec["questions"]:
        if q.get("negative"):
            results.append({"id": q["id"], "category": q["category"], "skipped": "negative（留端到端评估）"})
            continue
        merged = []
        for ds in datasets:
            for item in api_search(base, key, ds, q["q"]):
                merged.append(item)
        merged.sort(key=item_score, reverse=True)
        top = merged[: args.top]
        top_cols = [t.get("collectionId") for t in top]
        expected_ids = {col_by_code[c] for c in q["expected"]}
        hit = any(c in expected_ids for c in top_cols)
        text_blob = "\n".join((t.get("q") or "") + (t.get("a") or "") for t in top)
        kws = q.get("keywords", [])
        kw_hits = [k for k in kws if k.replace(" ", "") in text_blob.replace(" ", "")]
        results.append({
            "id": q["id"],
            "category": q["category"],
            "q": q["q"],
            "retrieval_hit": hit,
            "keyword_ratio": round(len(kw_hits) / len(kws), 2) if kws else None,
            "missing_keywords": [k for k in kws if k not in kw_hits],
            "top_collections": top_cols,
            "expected": sorted(expected_ids),
            "top1_score": round(item_score(top[0]), 4) if top else 0,
        })
        print(f"#{q['id']:>3} [{q['category']}] hit={hit} kw={len(kw_hits)}/{len(kws)}", flush=True)
        time.sleep(0.3)  # 频控，避免打爆 FastGPT

    scored = [r for r in results if "retrieval_hit" in r]
    by_cat = {}
    for r in scored:
        by_cat.setdefault(r["category"], []).append(r)
    summary = {
        "total": len(scored),
        "hits": sum(1 for r in scored if r["retrieval_hit"]),
        "hit_rate": round(sum(1 for r in scored if r["retrieval_hit"]) / len(scored), 4) if scored else 0,
        "avg_keyword_ratio": round(
            sum(r["keyword_ratio"] for r in scored if r["keyword_ratio"] is not None)
            / max(1, sum(1 for r in scored if r["keyword_ratio"] is not None)), 4),
        "by_category": {
            cat: {"total": len(rs), "hits": sum(1 for r in rs if r["retrieval_hit"]),
                  "hit_rate": round(sum(1 for r in rs if r["retrieval_hit"]) / len(rs), 4)}
            for cat, rs in sorted(by_cat.items())
        },
        "misses": [{"id": r["id"], "category": r["category"], "q": r["q"], "top_collections": r["top_collections"]}
                   for r in scored if not r["retrieval_hit"]],
    }
    json.dump({"summary": summary, "results": results}, open(args.out, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
