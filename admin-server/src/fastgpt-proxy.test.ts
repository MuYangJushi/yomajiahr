import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedFastgptProxyRequest } from "./fastgpt-proxy.js";

test("FastGPT proxy allows pages and explicitly read-only APIs", () => {
  assert.equal(isAllowedFastgptProxyRequest("GET", "/dataset/list"), true);
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/core/dataset/list"), true);
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/core/dataset/collection/detail?id=x"), true);
});

test("FastGPT proxy blocks mutation APIs fail-closed", () => {
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/core/dataset/create"), false);
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/core/dataset/collection/create/text"), false);
  assert.equal(isAllowedFastgptProxyRequest("DELETE", "/api/core/dataset/delete"), false);
  assert.equal(isAllowedFastgptProxyRequest("PATCH", "/api/core/dataset/update"), false);
});
