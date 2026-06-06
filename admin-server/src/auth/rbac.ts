// RBAC 守卫（决策六）：requireRole(min) + Express Request 上的 req.user。
import type { NextFunction, Request, Response } from "express";
import { ROLE_RANK, isPlatformRole, type PlatformRole, type PlatformUser } from "./types.js";

// 在 Express Request 上挂 user（由 authMiddleware 填充）。
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PlatformUser;
    }
  }
}

/** 要求至少 min 角色（admin>ops>audit）；不足返回 403，未认证返回 401。 */
export function requireRole(min: PlatformRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "未认证" });
      return;
    }
    // fail-closed：未知/非法角色一律拒绝（ROLE_RANK[未知] 为 undefined，不能让其漏过比较）。
    if (!isPlatformRole(user.platformRole) || ROLE_RANK[user.platformRole] < ROLE_RANK[min]) {
      res.status(403).json({ error: `权限不足：需要 ${min}，当前 ${user.platformRole}` });
      return;
    }
    next();
  };
}
