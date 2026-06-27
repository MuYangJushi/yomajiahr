import assert from "node:assert/strict";
import { test } from "node:test";
import { applyModeForOperation } from "./config-apply.js";

test("applyModeForOperation keeps runtime-only for agent-only changes", () => {
  assert.equal(applyModeForOperation("agent.create"), "runtime-only");
  assert.equal(applyModeForOperation("agent.update.profile"), "runtime-only");
  assert.equal(applyModeForOperation("agent.skill.update"), "runtime-only");
  assert.equal(applyModeForOperation("agent.delete", { agentHasChannels: false }), "runtime-only");
});

test("applyModeForOperation restarts for knowledge MCP and channel changes", () => {
  assert.equal(applyModeForOperation("knowledge.bind"), "restart");
  assert.equal(applyModeForOperation("knowledge.unbind"), "restart");
  assert.equal(applyModeForOperation("knowledge.delete"), "restart");
  assert.equal(applyModeForOperation("knowledge.base.create"), "restart");
  assert.equal(applyModeForOperation("agent.delete", { agentHasChannels: true }), "restart");
  assert.equal(applyModeForOperation("agent.channel.bind"), "restart");
  assert.equal(applyModeForOperation("agent.channel.unbind"), "restart");
  assert.equal(applyModeForOperation("knowledge.config"), "restart");
  assert.equal(applyModeForOperation("gateway.restart"), "restart");
  assert.equal(applyModeForOperation(undefined), "restart");
  assert.equal(applyModeForOperation("unknown"), "restart");
});
