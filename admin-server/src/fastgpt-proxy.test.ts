import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedFastgptProxyRequest } from "./fastgpt-proxy.js";

test("FastGPT proxy allows pages and read APIs (含 SPA 版本化读端点)", () => {
  assert.equal(isAllowedFastgptProxyRequest("GET", "/dataset/list"), true);
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/core/dataset/list"), true);
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/core/dataset/collection/detail?id=x"), true);
  // SPA 实际用的版本化读端点（旧白名单漏拦导致 iframe 403 的根因）。
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/core/dataset/collection/listV2"), true);
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/core/dataset/data/v2/list"), true);
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/core/dataset/searchTest"), true);
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/support/user/account/loginByPassword"), true);
});

test("FastGPT proxy blocks mutation APIs fail-closed", () => {
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/core/dataset/create"), false);
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/core/dataset/collection/create/text"), false);
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/core/dataset/data/insert"), false);
  assert.equal(isAllowedFastgptProxyRequest("POST", "/api/core/dataset/data/pushData"), false);
  assert.equal(isAllowedFastgptProxyRequest("DELETE", "/api/core/dataset/delete"), false);
  assert.equal(isAllowedFastgptProxyRequest("PATCH", "/api/core/dataset/update"), false);
});
