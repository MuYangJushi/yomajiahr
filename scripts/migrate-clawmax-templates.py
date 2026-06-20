#!/usr/bin/env python3
# ClawMax → yomajiahr agent 模板迁移脚本（一次性，非 git 资产）。
# 读 /Users/yangmu/Projects/clawmax/TEMPLATES/agents/<id>-template/template.json，
# 转 yomajiahr schema（id/role/profile/emoji/tags/source=clawmax），写入 worktree 的
# workspaces/_templates/agents/<id>-template/template.json。
#
# 字段映射：
#   id            ← clawmax agents[0].id
#   name          ← clawmax name（保留英文原名，便于溯源）
#   emoji         ← clawmax emoji
#   description   ← clawmax description
#   tags          ← clawmax tags
#   category      ← 由 tags 派生（engineering/research/event/data/product/leadership/general）
#   role          ← "employee"（ClawMax 无 admin 概念；yomajiahr admin 是 KB 管理员角色，不对应）
#   suggestedId   ← clawmax agents[0].id
#   profile.jobTitle       ← agents[0].role（取 "—" / "—" / ":" 前的短句）
#   profile.responsibilities ← metadata.aiPrompt
#   profile.personality    ← 由 aiPrompt 关键词派生的默认值
#   profile.tone           ← "专业、清晰、简洁"
#   profile.boundaries     ← 通用红线
#   suggestedSkills        ← []（ClawMax skills 如 github 在 yomajiahr 无对应技能）
#   source                 ← { type:"clawmax", template:<id>, version:"v1.8.7", attribution:"ClawMax (MIT)" }
#   status                 ← "active"
#   workflowHints          ← { suggestedWorkflowIds:[], targetTags:<tags>, defaultParticipation:"participant" }
import json, os, re, sys

SRC = os.environ.get("CLAWMAX_TEMPLATES_SRC", "/Users/yangmu/Projects/clawmax/TEMPLATES/agents")
DST = os.environ.get("YOMAJIAHR_TEMPLATES_DST",
                     os.path.join(os.path.dirname(__file__), "..", "workspaces", "_templates", "agents"))
CLAWMAX_VERSION = os.environ.get("CLAWMAX_VERSION", "v1.8.7")

CATEGORY_KEYWORDS = [
    ({"engineer", "developer", "qa", "release", "devops", "ci-cd", "github", "testing", "quality"}, "engineering"),
    ({"research", "literature", "evidence", "papers", "experiments"}, "research"),
    ({"event", "speakers", "agenda", "program", "operations", "logistics", "follow-up"}, "event"),
    ({"data", "analytics", "metrics", "pipelines", "infrastructure", "markets", "finance"}, "data"),
    ({"product", "customers", "competition", "strategy"}, "product"),
    ({"leadership", "executive", "ceo", "management"}, "leadership"),
    ({"writing", "briefing", "communication", "synthesis"}, "communication"),
    ({"astronomy", "education"}, "education"),
]

def derive_category(tags):
    ts = set(tags)
    for keys, cat in CATEGORY_KEYWORDS:
        if ts & keys:
            return cat
    return "general"

def short_role(role):
    if not role:
        return ""
    # 取 "—" / "—" / ":" / "—" 前的短句
    for sep in ["—", "—", ":", " - "]:
        if sep in role:
            return role.split(sep)[0].strip()
    return role.strip()

def derive_personality(ai_prompt):
    p = (ai_prompt or "").lower()
    traits = []
    if any(k in p for k in ["meticulous", "methodical", "patient", "careful", "precise", "precisely"]):
        traits += ["严谨", "细致"]
    if any(k in p for k in ["proactive", "bold", "resourceful", "decisive"]):
        traits += ["主动", "果断"]
    if any(k in p for k in ["concise", "clear", "clarity", "readable", "signal"]):
        traits += ["清晰"]
    if any(k in p for k in ["skeptical", "skeptical", "uncertainty", "evidence", "caveats"]):
        traits += ["审慎"]
    if any(k in p for k in ["helpful", "approachable", "practical", "exciting"]):
        traits += ["亲和", "务实"]
    if not traits:
        traits = ["严谨", "负责", "主动"]
    # 去重保序
    seen, out = set(), []
    for t in traits:
        if t not in seen:
            seen.add(t); out.append(t)
    return ", ".join(out)

BOUNDARIES = "不越权决策；不臆测无依据的内容；不外发敏感信息；写操作必须留审计"
TONE = "专业、清晰、简洁"

def migrate():
    if not os.path.isdir(SRC):
        print(f"[FAIL] ClawMax 源目录不存在: {SRC}", file=sys.stderr); sys.exit(1)
    os.makedirs(DST, exist_ok=True)
    count = 0
    for name in sorted(os.listdir(SRC)):
        if not name.endswith("-template"):
            continue
        src_file = os.path.join(SRC, name, "template.json")
        if not os.path.isfile(src_file):
            continue
        with open(src_file, encoding="utf-8") as f:
            cm = json.load(f)
        agents = cm.get("agents") or []
        if not agents:
            print(f"[SKIP] {name}: 无 agents"); continue
        a0 = agents[0]
        aid = a0.get("id") or name.replace("-template", "")
        tags = cm.get("tags") or []
        ai_prompt = (cm.get("metadata") or {}).get("aiPrompt", "")
        agent_role = a0.get("role", "")
        out = {
            "id": aid,
            "name": cm.get("name", aid),
            "emoji": cm.get("emoji", "🤖"),
            "description": cm.get("description", ""),
            "tags": tags,
            "category": derive_category(tags),
            "role": "employee",
            "suggestedId": aid,
            "profile": {
                "jobTitle": short_role(agent_role) or cm.get("name", aid),
                "responsibilities": ai_prompt,
                "personality": derive_personality(ai_prompt),
                "tone": TONE,
                "boundaries": BOUNDARIES,
            },
            "suggestedSkills": [],
            "defaultSkills": [],
            "status": "active",
            "source": {
                "type": "clawmax",
                "template": aid,
                "version": CLAWMAX_VERSION,
                "attribution": "ClawMax (MIT)",
            },
            "workflowHints": {
                "suggestedWorkflowIds": [],
                "targetTags": tags,
                "defaultParticipation": "participant",
            },
        }
        dst_dir = os.path.join(DST, name)
        os.makedirs(dst_dir, exist_ok=True)
        dst_file = os.path.join(dst_dir, "template.json")
        with open(dst_file, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
            f.write("\n")
        count += 1
        print(f"  {aid:24s} -> {name}")
    print(f"\n[OK] 迁移 {count} 个 ClawMax 模板到 {DST}")

if __name__ == "__main__":
    migrate()
