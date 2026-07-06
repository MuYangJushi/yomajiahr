// 异步 apply 任务管线（fix/usage-bugs #1）。
//
// 背景：渠道编辑、知识库绑定、招募数字员工等写操作过去都是"写 store + apply（重启 gateway + 探活）"
// 在同一 HTTP 请求里串行完成。triggerApply 在生产走 systemd helper，轮询 30s+ 才返回；
// 占位符渠道账号还会让 dingtalk-connector / lark-connector 401/400 退避循环延长 apply。
// 用户的体验是"保存按钮转圈半分钟"。
//
// 解法：HTTP 路由层把"保存到 store + 触发 apply"放到后台任务里跑，立刻返回 jobId；
// 前端轮询 GET /config/apply-jobs/:id 直到任务终态。
//
// 失败回滚（B1）：service 函数原子语义不变——apply 失败时仍由 service 内部回滚 store。
// 异步化只是把"等"挪到了后台 + 前端轮询；list/store 真相源跟着 service 终态。
//
// 持久化：jobs 缓存在进程内 Map（约 200 条上限 LRU）。任务完成 5 分钟后清理。
// 进程重启后已完成任务丢失（前端如果还没拿到结果会得到 404，与"未跑过"区分不开——
// 这是现状权衡：不引入额外存储；前端在 jobId 失踪时退化为"reload 列表看现状"）。

import { randomUUID } from "node:crypto";
import { hasPendingApply } from "./config-apply.js";

export type ApplyJobStatus = "queued" | "running" | "success" | "failed";

export interface ApplyJob {
  id: string;
  /** 业务标签（agent.create / agent.update / channel.bind / knowledge.bind 等），仅用于审计与前端展示。 */
  label: string;
  status: ApplyJobStatus;
  /** 终态时附上的可读消息：成功 = "已应用" / 失败 = service throw 出来的 message。 */
  message?: string;
  /** 业务结果：service 函数的 resolve 值；apply 失败时通常 service 已 throw，此字段为空。 */
  result?: unknown;
  startedAt: string;
  finishedAt?: string;
}

const jobs = new Map<string, ApplyJob>();
const MAX_JOBS = 200;
/** 任务完成后保留的时间窗（毫秒）；过期清理，腾出 jobId 空间。 */
const JOB_TTL_MS = 10 * 60_000;

function pruneJobs(now: number): void {
  // 清理过期的 + 把 Map 控制在 MAX_JOBS 内（FIFO 删旧）。
  const stale: string[] = [];
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - new Date(job.finishedAt).getTime() > JOB_TTL_MS) {
      stale.push(id);
    }
  }
  for (const id of stale) jobs.delete(id);
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value;
    if (!oldest) break;
    jobs.delete(oldest);
  }
}

/**
 * 入队一个写操作。返回 jobId 立刻；后台跑 work，落 status / result / message 到 jobs Map。
 *
 * `work` 内部预期：① 校验入参；② withConfigLock 包住"写 store + triggerApply"；③ apply 失败时回滚。
 * 也就是说现有 service 函数（createAgentProfile / bindAgentToChannel / writeKnowledgeStore + triggerApply）
 * 都符合直接当 work 用——HTTP 路由不需要拆 service，只需把 await 换成 enqueueApplyJob。
 */
export function enqueueApplyJob<T>(work: () => Promise<T>, label: string): { jobId: string; promise: Promise<T> } {
  pruneJobs(Date.now());
  const id = randomUUID();
  const job: ApplyJob = {
    id,
    label,
    status: "queued",
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  // 立即转 running——这里没有跨任务串行队列（withConfigLock 已在 service 内串行）；
  // 上层路由层并发提交多个 apply job，service 里的锁保证它们排队。
  job.status = "running";
  const promise = work().then(
    (result) => {
      job.status = "success";
      // pending 语义收口：service 放行了 pending apply（store 已写入、配置应用终态未知），
      // 如实告知「应用中」而非假装「已应用」；终态由 trackPendingApply 后台落日志。
      job.message = hasPendingApply(result) ? "已保存，配置应用中（请稍后刷新确认生效）" : "已应用";
      job.result = result;
      job.finishedAt = new Date().toISOString();
      return result;
    },
    (err: Error) => {
      job.status = "failed";
      job.message = err.message;
      job.finishedAt = new Date().toISOString();
      throw err;
    },
  );
  // 防止未捕获 rejection 让 Node 退出（业务错已在 job.status=failed 记录，调用方不再 await）。
  promise.catch(() => {});
  return { jobId: id, promise };
}

export function getApplyJob(id: string): ApplyJob | undefined {
  return jobs.get(id);
}

/** 仅测试用：清空 jobs Map。 */
export function _resetApplyJobs(): void {
  jobs.clear();
}
