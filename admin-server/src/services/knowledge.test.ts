import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = join(tmpdir(), `yomajiahr-knowledge-test-${process.pid}`);
mkdirSync(stateDir, { recursive: true });
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.KNOWLEDGE_PLATFORM = "fastgpt";
process.env.FASTGPT_BASE_URL = "http://10.99.0.1:3000/";
process.env.FASTGPT_API_KEY = "test-fastgpt-secret";
process.env.FASTGPT_KB_ID = "test-kb-id";
process.env.FASTGPT_EMBEDDING_MODEL = "text-embedding-v4";

const { KnowledgeUnavailableError, health, search, importDocument, updateKnowledgeConfig, resolveDatasetIdsForAgent, writeKnowledgeStore, listCollections, removeCollection, listChunks, isCollectionRestricted } = await import("./knowledge.js");
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("health reports FastGPT connectivity without claiming the KB index is ready", async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "http://10.99.0.1:3000/api/common/system/getInitData");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-fastgpt-secret");
    return new Response("{}", { status: 200 });
  };

  const result = await health();

  assert.equal(result.platform, "fastgpt");
  assert.equal(result.configured, true);
  assert.equal(result.reachable, true);
  assert.equal(result.kbId, "test-kb-id");
  assert.equal(result.embeddingModel, "text-embedding-v4");
  assert.equal(result.baseUrlHint, "10.99.0.1:3000");
  assert.equal(result.indexStatus, "unknown");
  assert.equal(result.message, "FastGPT 可达");
  assert.equal(JSON.stringify(result).includes("test-fastgpt-secret"), false);
});

test("health distinguishes an HTTP error from a network outage", async () => {
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });

  const result = await health();

  assert.equal(result.reachable, true);
  assert.equal(result.indexStatus, "unknown");
  assert.equal(result.message, "FastGPT 可达，但探活返回 401");
});

test("health reports unavailable (no fallback) when FastGPT cannot be reached", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed: test-fastgpt-secret");
  };

  const result = await health();

  assert.equal(result.reachable, false);
  assert.equal(result.indexStatus, "unknown");
  assert.equal(result.fallback, "none"); // ADR-010：已弃本地回退
  assert.equal(result.message, "FastGPT 不可达（TypeError）—— 知识库暂时不可用");
  assert.equal(JSON.stringify(result).includes("test-fastgpt-secret"), false);
});

test("search converts a FastGPT network failure into an explicit fallback signal", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(search("年假怎么申请？"), (err: unknown) => {
    assert.equal(err instanceof KnowledgeUnavailableError, true);
    assert.match((err as Error).message, /FastGPT 不可达/);
    return true;
  });
});

test("search backfills doc_id/version from collection metadata (searchTest doesn't flatten them)", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/searchTest")) {
      return new Response(
        JSON.stringify({
          data: {
            list: [
              { q: "年假最小单位 0.5 小时", a: "", score: [{ type: "embedding", value: 0.8 }], sourceName: "[HR-LEAVE-001] 年假规则", collectionId: "col_x" },
            ],
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/collection/detail")) {
      return new Response(
        JSON.stringify({
          data: { name: "[HR-LEAVE-001] 年假规则", sourceName: "[HR-LEAVE-001] 年假规则", metadata: { doc_id: "HR-LEAVE-001", version: "2.1", source_file: "年假规则.pdf" } },
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected url ${url}`);
  };

  const hits = await search("年假最小单位", 5);

  assert.equal(hits.length, 1);
  assert.equal(hits[0].source.doc_id, "HR-LEAVE-001");
  assert.equal(hits[0].source.version, "2.1");
  assert.equal(hits[0].source.filename, "年假规则.pdf"); // 优先 source_file，回退去前缀的 name
  assert.equal(hits[0].source.collectionId, "col_x");
});

test("search degrades gracefully when collection metadata cannot be resolved", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/searchTest")) {
      return new Response(
        JSON.stringify({ data: { list: [{ q: "片段", a: "", score: 0.5, sourceName: "新员工须知.pdf", collectionId: "col_ui" }] } }),
        { status: 200 },
      );
    }
    if (url.includes("/collection/detail")) return new Response("err", { status: 500 });
    throw new Error(`unexpected url ${url}`);
  };

  const hits = await search("年假", 5);

  assert.equal(hits.length, 1);
  assert.equal(hits[0].source.doc_id, undefined); // 解析失败 → best-effort 省略，不编造
  assert.equal(hits[0].source.version, undefined);
  assert.equal(hits[0].source.filename, "新员工须知.pdf"); // 回退 sourceName
});

test("importDocument converts a FastGPT network failure into an explicit fallback signal", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed: test-fastgpt-secret");
  };

  await assert.rejects(
    importDocument(Buffer.from("年假最小单位 0.5 小时。"), "测试.txt"),
    (err: unknown) => {
      assert.equal(err instanceof KnowledgeUnavailableError, true);
      assert.match((err as Error).message, /FastGPT 导入不可达/);
      assert.equal((err as Error).message.includes("test-fastgpt-secret"), false);
      return true;
    },
  );
});

test("importDocument forwards the raw file to create/localFile and returns collectionId (ADR-010)", async () => {
  let calledUrl = "";
  let bodyIsFormData = false;
  globalThis.fetch = async (input, init) => {
    calledUrl = String(input);
    bodyIsFormData = init?.body instanceof FormData;
    return new Response(JSON.stringify({ code: 200, data: { collectionId: "col_abc123" } }), { status: 200 });
  };

  const result = await importDocument(Buffer.from("年假最小单位 0.5 小时。"), "年假规则.pdf", "test-kb-id");

  assert.equal(result.collectionId, "col_abc123");
  assert.equal(result.externalDocId, "col_abc123");
  // 走文件导入端点、multipart（FastGPT 原生解析）；不再注入 doc_id/metadata。
  assert.equal(calledUrl, "http://10.99.0.1:3000/api/core/dataset/collection/create/localFile");
  assert.equal(bodyIsFormData, true);
});

test("search merges multiple datasets by score and tolerates one failing (allSettled)", async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/searchTest")) {
      const body = JSON.parse(String(init?.body));
      if (body.datasetId === "ds_bad") return new Response("err", { status: 500 });
      const score = body.datasetId === "ds_hi" ? 0.95 : 0.6;
      return new Response(
        JSON.stringify({ data: { list: [{ q: `chunk-${body.datasetId}`, a: "", score, sourceName: `${body.datasetId}.md` }] } }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected url ${url}`);
  };

  const hits = await search("q", 5, ["ds_lo", "ds_hi", "ds_bad"]);

  assert.equal(hits.length, 2); // ds_bad 被容忍，其余两库各 1 条
  assert.equal(hits[0].text, "chunk-ds_hi"); // 高分在前
  assert.equal(hits[1].text, "chunk-ds_lo");
});

test("search throws (triggers local fallback) only when every dataset fails", async () => {
  globalThis.fetch = async () => new Response("err", { status: 500 });
  await assert.rejects(search("q", 5, ["a", "b"]), (err: unknown) => err instanceof KnowledgeUnavailableError);
});

test("resolveDatasetIdsForAgent: default KB when no fastgpt binding, bound datasets otherwise", () => {
  // 无 knowledge.json（默认 local store）→ 退默认 FASTGPT_KB_ID。
  assert.deepEqual(resolveDatasetIdsForAgent("hr-assistant"), ["test-kb-id"]);

  mkdirSync(join(stateDir, "config-store"), { recursive: true });
  writeKnowledgeStore({
    platform: "fastgpt",
    knowledgeBases: [
      { id: "kb_a", name: "A", provider: "fastgpt", externalKbId: "ds_a", boundAgents: ["hr-assistant"] },
      { id: "kb_b", name: "B", provider: "fastgpt", externalKbId: "ds_b", boundAgents: ["other"] },
      { id: "kb_l", name: "L", provider: "local", boundAgents: ["hr-assistant"] },
    ],
  });

  assert.deepEqual(resolveDatasetIdsForAgent("hr-assistant"), ["ds_a"]); // 只取 fastgpt 且绑定该 agent
  assert.deepEqual(resolveDatasetIdsForAgent("other"), ["ds_b"]);
  assert.deepEqual(resolveDatasetIdsForAgent("nobody"), []); // 显式配置存在但未绑定 → fail-closed
});

test("search with an explicit empty dataset list returns no hits without falling back to default", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("must not fetch");
  };
  assert.deepEqual(await search("q", 5, []), []);
  assert.equal(called, false);
});

test("knowledge store validation rejects malformed bindings and unknown agents", async () => {
  const { validateKnowledgeStore } = await import("./knowledge.js");
  assert.throws(
    () => validateKnowledgeStore({ platform: "fastgpt", knowledgeBases: [{ id: "a", name: "A", provider: "fastgpt", externalKbId: "ds", boundAgents: ["unknown"] }] }, ["hr-assistant"]),
    /未知 Agent/,
  );
  assert.throws(
    () => validateKnowledgeStore({ platform: "fastgpt", knowledgeBases: [{ id: "a", name: "A", provider: "fastgpt" }] }, ["hr-assistant"]),
    /externalKbId/,
  );
  assert.deepEqual(
    validateKnowledgeStore(
      { platform: "fastgpt", knowledgeBases: [{ id: "a", name: "A", provider: "fastgpt", externalKbId: "ds", boundAgents: ["hr-assistant", "hr-assistant"] }] },
      ["hr-assistant"],
    ).knowledgeBases[0].boundAgents,
    ["hr-assistant"],
  );
});

test("knowledge config uses key-level secret upsert and returns key names only", () => {
  const updatedKeys = updateKnowledgeConfig({
    platform: "fastgpt",
    baseUrl: "http://10.99.0.1:3000/",
    apiKey: "new-fastgpt-secret",
    kbId: "new-kb-id",
    embeddingModel: "text-embedding-v4",
  });
  const envFile = readFileSync(join(stateDir, ".env"), "utf-8");

  assert.deepEqual(updatedKeys, [
    "KNOWLEDGE_PLATFORM",
    "FASTGPT_BASE_URL",
    "FASTGPT_API_KEY",
    "FASTGPT_KB_ID",
    "FASTGPT_EMBEDDING_MODEL",
  ]);
  assert.match(envFile, /^KNOWLEDGE_PLATFORM=fastgpt$/m);
  assert.match(envFile, /^FASTGPT_BASE_URL=http:\/\/10\.99\.0\.1:3000$/m);
  assert.match(envFile, /^FASTGPT_API_KEY=new-fastgpt-secret$/m);
  assert.equal(JSON.stringify(updatedKeys).includes("new-fastgpt-secret"), false);
});

test("knowledge config rejects unsupported URLs and empty updates", () => {
  assert.throws(() => updateKnowledgeConfig({ baseUrl: "file:///tmp/fastgpt" }), /仅支持 http\/https/);
  assert.throws(() => updateKnowledgeConfig({ apiKey: "secret\nINJECTED=value" }), /不能包含换行/);
  assert.throws(() => updateKnowledgeConfig({ baseUrl: "http://user:password@10.99.0.1:3000" }), /不能包含用户名或密码/);
  assert.throws(() => updateKnowledgeConfig({}), /至少提供一个/);
});

test("listCollections maps listV2 + derives index status from trainingAmount (ADR-009)", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    assert.ok(url.includes("/api/core/dataset/collection/listV2"));
    return new Response(
      JSON.stringify({
        code: 200,
        data: {
          total: 3,
          list: [
            { _id: "c1", name: "[HR-LEAVE-001] 年假制度", dataAmount: 9, trainingAmount: 0 }, // 训练完 → ready
            { _id: "c2", name: "考勤制度", dataAmount: 5, trainingAmount: 2 }, // 队列剩余 → indexing
            { _id: "c3", name: "空集合", dataAmount: 0, trainingAmount: 0 }, // 无切片 → unknown
          ],
        },
      }),
      { status: 200 },
    );
  };
  const cols = await listCollections("ds_x");
  assert.equal(cols.length, 3);
  assert.deepEqual(
    cols.map((c) => [c.externalDocId, c.title, c.chunkCount, c.indexStatus, c.source]),
    [
      ["c1", "年假制度", 9, "ready", "fastgpt"], // doc_id 前缀已剥离
      ["c2", "考勤制度", 5, "indexing", "fastgpt"],
      ["c3", "空集合", 0, "unknown", "fastgpt"],
    ],
  );
});

test("listCollections converts a FastGPT failure into an explicit fallback signal", async () => {
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  await assert.rejects(listCollections("ds_x"), KnowledgeUnavailableError);
});

test("removeCollection issues DELETE to collection/delete with the id, throws on failure", async () => {
  let seen = "";
  globalThis.fetch = async (input, init) => {
    seen = `${(init?.method ?? "GET")} ${String(input)}`;
    return new Response(JSON.stringify({ code: 200, data: null }), { status: 200 });
  };
  await removeCollection("col_abc123");
  assert.match(seen, /^DELETE .*\/api\/core\/dataset\/collection\/delete\?id=col_abc123$/);

  globalThis.fetch = async () => new Response("nope", { status: 404 });
  await assert.rejects(removeCollection("col_abc123"), KnowledgeUnavailableError);
});

test("listChunks maps data/v2/list items (id/q/a/chunkIndex) + total", async () => {
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).includes("/api/core/dataset/data/v2/list"));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.collectionId, "col_x");
    return new Response(
      JSON.stringify({
        code: 200,
        data: {
          total: 2,
          list: [
            { _id: "d1", q: "年假最小单位 0.5 小时", a: "", chunkIndex: 0 },
            { _id: "d2", q: "病假需提供证明", a: "答案侧", chunkIndex: 1 },
          ],
        },
      }),
      { status: 200 },
    );
  };
  const { chunks, total } = await listChunks("col_x", 0, 20);
  assert.equal(total, 2);
  assert.deepEqual(chunks, [
    { id: "d1", q: "年假最小单位 0.5 小时", a: "", chunkIndex: 0 },
    { id: "d2", q: "病假需提供证明", a: "答案侧", chunkIndex: 1 },
  ]);
});

test("listChunks converts a FastGPT failure into an explicit fallback signal", async () => {
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  await assert.rejects(listChunks("col_x"), KnowledgeUnavailableError);
});

test("isCollectionRestricted reflects the owning KB's restricted flag (ADR-010 KB 级)", async () => {
  mkdirSync(join(stateDir, "config-store"), { recursive: true });
  writeKnowledgeStore({
    platform: "fastgpt",
    knowledgeBases: [
      { id: "kb_pub", name: "公开", provider: "fastgpt", externalKbId: "ds_pub", boundAgents: [] },
      { id: "kb_comp", name: "薪酬", provider: "fastgpt", externalKbId: "ds_comp", boundAgents: [], restricted: true },
    ],
  });
  // collection/detail 回吐归属 datasetId。
  const detail = (datasetId: string) =>
    new Response(JSON.stringify({ data: { name: "n", sourceName: "n", datasetId, metadata: {} } }), { status: 200 });

  globalThis.fetch = async () => detail("ds_comp");
  assert.equal(await isCollectionRestricted("c_comp"), true); // 归属受限库

  globalThis.fetch = async () => detail("ds_pub");
  assert.equal(await isCollectionRestricted("c_pub_x"), false); // 归属公开库
});

test("isCollectionRestricted is fail-closed when the owning KB cannot be resolved (ADR-010)", async () => {
  mkdirSync(join(stateDir, "config-store"), { recursive: true });
  writeKnowledgeStore({
    platform: "fastgpt",
    knowledgeBases: [{ id: "kb_pub", name: "公开", provider: "fastgpt", externalKbId: "ds_pub", boundAgents: [] }],
  });
  // detail 无 datasetId → 无法解析归属库 → 受限
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { name: "n", sourceName: "n", metadata: {} } }), { status: 200 });
  assert.equal(await isCollectionRestricted("c_nods"), true);
  // detail 失败 → {} → 受限
  globalThis.fetch = async () => new Response("err", { status: 500 });
  assert.equal(await isCollectionRestricted("c_err"), true);
  // datasetId 指向未登记的库 → fail-closed 受限
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { name: "n", sourceName: "n", datasetId: "ds_unknown", metadata: {} } }), { status: 200 });
  assert.equal(await isCollectionRestricted("c_unknown"), true);
});
