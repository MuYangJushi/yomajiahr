// 交互分析页（Sprint 10 #34，支柱三「绩效考核」）。
// 消费 GET /api/interactions/summary（hook-logger 事件库聚合），audit 级可见。
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Select, Spin, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "./api";
import { PageTopbar, TableCard } from "./shell";

interface Summary {
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

const RANGE_OPTIONS = [
  { label: "近 7 天", value: 7 },
  { label: "近 30 天", value: 30 },
  { label: "全部", value: 0 },
];

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e3e3e6", borderRadius: 12, padding: "16px 20px", flex: "1 1 150px", minWidth: 150 }}>
      <div style={{ fontSize: 13, color: "#86868b" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, color: "#1d1d1f", marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#86868b", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function ms(v: number | null): string {
  if (v == null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
}

export default function Interactions() {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rangeDays, setRangeDays] = useState(7);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const since = rangeDays > 0 ? dayjs().subtract(rangeDays - 1, "day").format("YYYYMMDD") : undefined;
      const res = await api.get<Summary>("/interactions/summary", { params: { since } });
      setData(res.data);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [rangeDays]);

  useEffect(() => {
    void load();
  }, [load]);

  const missColumns: ColumnsType<Summary["misses"][number]> = [
    { title: "日期", dataIndex: "day", width: 100, render: (d: string) => `${d.slice(4, 6)}-${d.slice(6, 8)}` },
    { title: "检索词", dataIndex: "query", render: (q) => q || <span style={{ color: "#86868b" }}>（无）</span> },
    { title: "错误", dataIndex: "error", render: (e) => (e ? <Tag color="red">{e}</Tag> : <Tag>未命中</Tag>) },
  ];

  const maxDayTurns = Math.max(1, ...(data?.byDay.map((d) => d.turns) ?? [1]));

  return (
    <div>
      <PageTopbar
        title="交互分析"
        sub="员工与数字员工的交互质量画像：检索命中率、时延、成本与未命中反哺清单（数据来自交互事件库，每轮对话自动采集）"
        right={
          <div style={{ display: "flex", gap: 8 }}>
            <Select options={RANGE_OPTIONS} value={rangeDays} onChange={setRangeDays} style={{ width: 110 }} />
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
          </div>
        }
      />
      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
      <Spin spinning={loading}>
        {data && (
          <>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              <StatCard label="对话轮次" value={String(data.turns)} sub={data.failedTurns ? `含失败 ${data.failedTurns} 轮` : "无失败轮次"} />
              <StatCard
                label="检索命中率"
                value={data.searchHitRate == null ? "—" : `${(data.searchHitRate * 100).toFixed(1)}%`}
                sub={`${data.searches} 次检索 · 每轮 ${data.searchesPerTurn ?? "—"} 次`}
              />
              <StatCard label="整轮时延 p50" value={ms(data.turnDurationMs.p50)} sub={`p90 ${ms(data.turnDurationMs.p90)} · 最慢 ${ms(data.turnDurationMs.max)}`} />
              <StatCard label="检索时延 p50" value={ms(data.searchDurationMs.p50)} sub={`p90 ${ms(data.searchDurationMs.p90)}`} />
              <StatCard label="token 消耗" value={`${((data.tokens.input + data.tokens.output) / 1000).toFixed(1)}k`} sub={`入 ${data.tokens.input} · 出 ${data.tokens.output}`} />
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              <div style={{ background: "#fff", border: "1px solid #e3e3e6", borderRadius: 12, padding: "16px 20px", flex: "2 1 320px" }}>
                <div style={{ fontSize: 13, color: "#86868b", marginBottom: 10 }}>按天轮次</div>
                {data.byDay.length === 0 && <div style={{ color: "#86868b", fontSize: 13 }}>暂无数据</div>}
                {data.byDay.map((d) => (
                  <div key={d.day} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 12, color: "#86868b", width: 46 }}>{`${d.day.slice(4, 6)}-${d.day.slice(6, 8)}`}</span>
                    <div style={{ flex: 1, background: "#f5f5f7", borderRadius: 4, height: 16 }}>
                      <div style={{ width: `${(d.turns / maxDayTurns) * 100}%`, background: "#0071e3", height: 16, borderRadius: 4, minWidth: 4 }} />
                    </div>
                    <span style={{ fontSize: 12, width: 32, textAlign: "right" }}>{d.turns}</span>
                  </div>
                ))}
              </div>
              <div style={{ background: "#fff", border: "1px solid #e3e3e6", borderRadius: 12, padding: "16px 20px", flex: "1 1 240px" }}>
                <div style={{ fontSize: 13, color: "#86868b", marginBottom: 10 }}>高频检索词</div>
                {data.topQueryTerms.length === 0 && <div style={{ color: "#86868b", fontSize: 13 }}>暂无数据</div>}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {data.topQueryTerms.map((t) => (
                    <Tag key={t.term}>
                      {t.term} × {t.count}
                    </Tag>
                  ))}
                </div>
                <div style={{ fontSize: 12, color: "#86868b", marginTop: 12 }}>
                  按数字员工：{Object.entries(data.byAgent).map(([k, v]) => `${k} ${v}`).join("，") || "—"}
                  <br />
                  按渠道：{Object.entries(data.byChannel).map(([k, v]) => `${k} ${v}`).join("，") || "—"}
                </div>
              </div>
            </div>

            <div style={{ fontSize: 13, color: "#86868b", margin: "0 0 8px 2px" }}>未命中/异常检索（反哺知识库的输入，最多展示 20 条）</div>
            <TableCard>
              <Table rowKey={(r) => `${r.runId}-${r.query}`} columns={missColumns} dataSource={data.misses} pagination={false} size="small" locale={{ emptyText: "没有未命中检索 🎉" }} />
            </TableCard>
          </>
        )}
      </Spin>
    </div>
  );
}
