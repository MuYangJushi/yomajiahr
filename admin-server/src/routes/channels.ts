// 渠道独立管理路由（ADR-013 §渠道独立）：
//   GET    /config/channel-assets                 列出全部账号资产（含 health）
//   POST   /config/channel-assets                 创建账号资产
//   DELETE /config/channel-assets/:type/:id       删除账号资产（无 binding 时允许）
//   POST   /config/channel-assets/probe           集中探活（force=true 强制刷新）
//   POST   /config/agents/:id/channels      bindAgentToChannel（见 agents.ts）
//   DELETE /config/agents/:id/channels/:domain/:accountId  unbindAgentFromChannel（见 agents.ts）
//
// 注意：账号资产视图走 /config/channel-assets，与 agents.ts 的 GET /config/channels
// （渠道占用视图，给绑定下拉用）是两个不同资源——勿合并，否则路由先注册者会遮蔽另一个。
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireRole } from "../auth/rbac.js";
import { appendAuditLog } from "../util.js";
import { bindAgentToChannel, unbindAgentFromChannel } from "../services/orchestrator.js";
import {
  cancelChannelOnboarding, createChannelAsset, deleteChannelAsset, getChannelOnboarding,
  listChannelAssets, probeChannels, startChannelOnboarding, updateChannelAsset,
} from "../services/channels.js";

export const channelsRouter = Router();

const PolicySchema = z
  .object({
    dmPolicy: z.enum(["open", "restricted"]).optional(),
    groupPolicy: z.enum(["open", "disabled"]).optional(),
    requireMention: z.boolean().optional(),
  })
  .optional();

const CreateBaseSchema = z.object({
  id: z.string().trim().regex(/^[a-zA-Z0-9_-]+$/, "id 非法"),
  type: z.enum(["feishu", "dingtalk"]),
  displayName: z.string().trim().min(1).max(60),
  policy: PolicySchema,
});
const CreateSchema = z.discriminatedUnion("mode", [
  CreateBaseSchema.extend({ mode: z.literal("manual"), clientId: z.string().trim().min(1), secret: z.string().min(1) }),
  CreateBaseSchema.extend({ mode: z.literal("qrcode") }),
]);
const UpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  clientId: z.string().trim().optional(),
  secret: z.string().optional(),
  policy: PolicySchema,
});
const BindSchema = z.object({ agentId: z.string().trim().min(1) });

channelsRouter.get("/config/channel-assets", requireRole("ops"), async (_req: Request, res: Response) => {
  try {
    // 不强制刷新；缓存过期时由服务端集中探活，避免每个浏览器启动进程。
    const health = await probeChannels(false);
    const assets = listChannelAssets();
    res.json({ channels: assets, health });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

channelsRouter.post("/config/channel-assets", requireRole("ops"), async (req: Request, res: Response) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "入参非法" });
  try {
    if (parsed.data.mode === "qrcode") {
      return res.status(202).json(startChannelOnboarding(req.user!.platformUserId, parsed.data));
    }
    const asset = await createChannelAsset(parsed.data);
    appendAuditLog("channel.create", asset.id, {
      type: asset.type,
      id: asset.id,
      operator: req.user?.platformUserId || "",
    });
    res.status(201).json({ asset: listChannelAssets().find((item) => item.type === asset.type && item.id === asset.id) });
  } catch (err) {
    res.status(/已存在/.test((err as Error).message) ? 409 : 400).json({ error: (err as Error).message });
  }
});

channelsRouter.get("/config/channel-assets/onboarding/:id", requireRole("ops"), (req: Request, res: Response) => {
  const session = getChannelOnboarding(req.user!.platformUserId, String(req.params.id));
  if (!session) return res.status(404).json({ error: "会话不存在或已过期" });
  res.json(session);
});

channelsRouter.delete("/config/channel-assets/onboarding/:id", requireRole("ops"), (req: Request, res: Response) => {
  const session = cancelChannelOnboarding(req.user!.platformUserId, String(req.params.id));
  if (!session) return res.status(404).json({ error: "会话不存在或已过期" });
  res.json(session);
});

channelsRouter.patch("/config/channel-assets/:type/:id", requireRole("ops"), async (req: Request, res: Response) => {
  const type = String(req.params.type) as "feishu" | "dingtalk";
  const id = String(req.params.id);
  const parsed = UpdateSchema.safeParse(req.body);
  if ((type !== "feishu" && type !== "dingtalk") || !parsed.success) return res.status(400).json({ error: parsed.success ? "type 非法" : parsed.error.issues[0]?.message });
  try {
    await updateChannelAsset(type, id, parsed.data);
    appendAuditLog("channel.update", id, { type, id, operator: req.user?.platformUserId || "" });
    res.json({ asset: listChannelAssets().find((item) => item.type === type && item.id === id) });
  } catch (err) {
    res.status((err as Error).message === "账号不存在" ? 404 : 400).json({ error: (err as Error).message });
  }
});

channelsRouter.delete("/config/channel-assets/:type/:id", requireRole("ops"), async (req: Request, res: Response) => {
  const type = String(req.params.type) as "feishu" | "dingtalk";
  const id = String(req.params.id);
  if (type !== "feishu" && type !== "dingtalk") return res.status(400).json({ error: "type 非法" });
  try {
    await deleteChannelAsset(type, id);
    appendAuditLog("channel.delete", id, { type, id, operator: req.user?.platformUserId || "" });
    res.json({ deleted: { type, id } });
  } catch (err) {
    const message = (err as Error).message;
    res.status(message === "CHANNEL_IN_USE" ? 409 : message === "账号不存在" ? 404 : 500).json({ error: message });
  }
});

channelsRouter.post("/config/channel-assets/:type/:id/bind", requireRole("ops"), async (req: Request, res: Response) => {
  const type = String(req.params.type) as "feishu" | "dingtalk";
  const id = String(req.params.id);
  const parsed = BindSchema.safeParse(req.body);
  if (!parsed.success || (type !== "feishu" && type !== "dingtalk")) return res.status(400).json({ error: "入参非法" });
  try {
    await bindAgentToChannel({ agentId: parsed.data.agentId, domain: type === "dingtalk" ? "dingtalk-connector" : "feishu", accountId: id, existing: true });
    appendAuditLog("channel.bind", id, { type, id, agent_id: parsed.data.agentId, operator: req.user?.platformUserId || "" });
    res.json({ asset: listChannelAssets().find((item) => item.type === type && item.id === id) });
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

channelsRouter.post("/config/channel-assets/:type/:id/unbind", requireRole("ops"), async (req: Request, res: Response) => {
  const type = String(req.params.type) as "feishu" | "dingtalk";
  const id = String(req.params.id);
  const asset = listChannelAssets().find((item) => item.type === type && item.id === id);
  if (!asset) return res.status(404).json({ error: "账号不存在" });
  if (!asset.occupiedBy) return res.status(409).json({ error: "账号未绑定" });
  try {
    await unbindAgentFromChannel(asset.occupiedBy.agentId, type === "dingtalk" ? "dingtalk-connector" : "feishu", id);
    appendAuditLog("channel.unbind", id, { type, id, agent_id: asset.occupiedBy.agentId, operator: req.user?.platformUserId || "" });
    res.json({ asset: listChannelAssets().find((item) => item.type === type && item.id === id) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

channelsRouter.post("/config/channel-assets/probe", requireRole("ops"), async (req: Request, res: Response) => {
  try {
    const health = await probeChannels(true);
    appendAuditLog("channel.probe", "all", { operator: req.user?.platformUserId || "" });
    res.json({ health });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

channelsRouter.post("/config/channel-assets/:type/:id/probe", requireRole("ops"), async (req: Request, res: Response) => {
  const type = String(req.params.type);
  const id = String(req.params.id);
  try {
    await probeChannels(true);
    appendAuditLog("channel.probe", id, { type, id, operator: req.user?.platformUserId || "" });
    const asset = listChannelAssets().find((item) => item.type === type && item.id === id);
    if (!asset) return res.status(404).json({ error: "账号不存在" });
    res.json({ health: asset.health });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
