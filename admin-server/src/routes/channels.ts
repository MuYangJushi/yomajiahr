// 渠道独立管理路由（ADR-013 §渠道独立）：
//   GET    /config/channels                 列出全部账号资产（含 health）
//   POST   /config/channels                 创建账号资产
//   DELETE /config/channels/:type/:id       删除账号资产（无 binding 时允许）
//   POST   /config/channels/probe           集中探活（force=true 强制刷新）
//   POST   /config/agents/:id/channels      bindAgentToChannel（见 agents.ts）
//   DELETE /config/agents/:id/channels/:domain/:accountId  unbindAgentFromChannel（见 agents.ts）
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireRole } from "../auth/rbac.js";
import { appendAuditLog } from "../util.js";
import { createChannelAsset, listChannelAssets, probeChannels } from "../services/channels.js";

export const channelsRouter = Router();

const PolicySchema = z
  .object({
    dmPolicy: z.enum(["open", "restricted"]).optional(),
    groupPolicy: z.enum(["open", "disabled"]).optional(),
    requireMention: z.boolean().optional(),
  })
  .optional();

const CreateSchema = z.object({
  id: z.string().trim().regex(/^[a-zA-Z0-9_-]+$/, "id 非法"),
  type: z.enum(["feishu", "dingtalk"]),
  displayName: z.string().trim().min(1).max(60),
  account: z.record(z.string(), z.unknown()).refine((o) => Object.keys(o).length > 0, "account 不能为空"),
  policy: PolicySchema,
  envKeys: z.array(z.string()).optional(),
});

channelsRouter.get("/config/channels", requireRole("ops"), async (_req: Request, res: Response) => {
  try {
    const assets = listChannelAssets();
    // 不强制刷新；首次列表让前端再点"探活"
    const health = await probeChannels(false);
    res.json({ channels: assets, health });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

channelsRouter.post("/config/channels", requireRole("ops"), async (req: Request, res: Response) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "入参非法" });
  try {
    const asset = createChannelAsset(parsed.data);
    appendAuditLog("channel.create", asset.id, {
      type: asset.type,
      id: asset.id,
      operator: req.user?.platformUserId || "",
    });
    res.status(201).json({ asset });
  } catch (err) {
    res.status(/已存在/.test((err as Error).message) ? 409 : 400).json({ error: (err as Error).message });
  }
});

channelsRouter.delete("/config/channels/:type/:id", requireRole("ops"), async (req: Request, res: Response) => {
  const type = String(req.params.type) as "feishu" | "dingtalk";
  const id = String(req.params.id);
  if (type !== "feishu" && type !== "dingtalk") return res.status(400).json({ error: "type 非法" });
  try {
    // 删除时若存在 binding 拒绝（避免悬空引用）
    const { readStore, writeStore } = await import("../services/store.js");
    const store = readStore();
    const asset = store.channels.find((c) => c.type === type && c.id === id);
    if (!asset) return res.status(404).json({ error: "账号不存在" });
    const occupied = store.bindings.find(
      (b) => b.match.accountId === id && b.match.channel === (type === "dingtalk" ? "dingtalk-connector" : type),
    );
    if (occupied) return res.status(409).json({ error: `账号被 ${occupied.agentId} 占用，请先解绑` });
    store.channels = store.channels.filter((c) => !(c.type === type && c.id === id));
    writeStore(store);
    appendAuditLog("channel.delete", id, { type, id, operator: req.user?.platformUserId || "" });
    res.json({ deleted: { type, id } });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

channelsRouter.post("/config/channels/probe", requireRole("ops"), async (_req: Request, res: Response) => {
  try {
    const health = await probeChannels(true);
    res.json({ health });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
