import { xiangqiAiMove, type Cells, type XQLevel } from './xiangqiAI';

/** 在 Worker 线程跑搜索，主线程完全不阻塞（旧实现会同步卡最多 700ms）。 */
interface Req {
  reqId: number;
  cells: Cells;
  level: XQLevel;
  budgetMs: number;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Req>) => void) | null;
  postMessage: (msg: unknown) => void;
};

ctx.onmessage = (e) => {
  const { reqId, cells, level, budgetMs } = e.data || ({} as Req);
  const result = xiangqiAiMove(cells, level, budgetMs);
  ctx.postMessage({ reqId, ...result });
};

export {};
