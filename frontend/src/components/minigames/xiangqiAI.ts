/**
 * 中国象棋练习模式 AI（纯 TypeScript，无 React / DOM 依赖，可在 Worker / Node 中运行）。
 *
 * 算法参考了 JimmyFromSYSU/ChineseChess 的思路（更深搜索 + 逐子位置表 PST +
 * 将帅照面判定），但代码与位置表均为本项目独立实现，未复制该仓库源码
 * —— 该仓库没有 LICENSE，直接引入存在授权风险。
 *
 * 相比原先的「2 层 + 材料差」实现，以及参考仓库的「固定 4 层 + 同步全宽搜索」：
 *  - 迭代加深 1→N 层 + 时间预算，任何时刻超时都能返回上一层的完整结果
 *  - 置换表（局面 key + 深度 + 上下界），避免重复搜索
 *  - 着法排序（吃子 MVV-LVA + 位置增益）+ 分节点限宽，把预算用在有价值的分支
 *  - 将帅照面作为非法着法直接过滤，而不是等评估函数事后扣分
 *  - 同分随机，避免每局走出完全一样的棋
 *  - 难度分级：1=2 层 / 2=3 层 / 3=4 层
 */
export type Cells = Record<string, string | number>;
export type XQMove = { from: [number, number]; to: [number, number] };
export type XQLevel = 1 | 2 | 3;

export const XIANGQI_X = 9;
export const XIANGQI_Y = 10;

/** 基础子力价值（将单独按胜负处理） */
const VALUE: Record<string, number> = {
  K: 100000, R: 900, C: 450, H: 400, E: 200, A: 200, P: 100,
};

const MATE = 1_000_000;

function countBetween(cells: Cells, x1: number, y1: number, x2: number, y2: number): number {
  let n = 0;
  // 必须写花括号：单行 `if (...) for (...) if (...) n++; else if (...)`
  // 在 JS 里 else 会绑定到内层 if（悬空 else），导致横向走法完全不数中间棋子，
  // 炮能穿过自家炮、车能穿墙，AI 因此会走出非法着法
  if (x1 === x2) {
    for (let y = Math.min(y1, y2) + 1; y < Math.max(y1, y2); y++) {
      if (cells[`${x1},${y}`]) n++;
    }
  } else if (y1 === y2) {
    for (let x = Math.min(x1, x2) + 1; x < Math.max(x1, x2); x++) {
      if (cells[`${x},${y1}`]) n++;
    }
  }
  return n;
}

/** 单步走法合法性（与后端 XiangqiRules 对齐；不含照面，由 genMoves 过滤） */
export function xiangqiLegal(cells: Cells, piece: string,
                             x1: number, y1: number, x2: number, y2: number): boolean {
  if (x2 < 0 || x2 >= XIANGQI_X || y2 < 0 || y2 >= XIANGQI_Y) return false;
  const target = cells[`${x2},${y2}`];
  if (target && String(target)[0] === piece[0]) return false;
  const side = piece[0], t = piece[1];
  const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
  const palace = (s: string, x: number, y: number) =>
    x >= 3 && x <= 5 && (s === 'b' ? y <= 2 : y >= 7);
  const ownRiver = (s: string, y: number) => (s === 'b' ? y <= 4 : y >= 5);
  const between = countBetween(cells, x1, y1, x2, y2);
  if (t === 'R') return (x1 === x2 || y1 === y2) && between === 0;
  if (t === 'C') {
    if (x1 !== x2 && y1 !== y2) return false;
    return target ? between === 1 : between === 0;
  }
  if (t === 'H') {
    if (!((dx === 1 && dy === 2) || (dx === 2 && dy === 1))) return false;
    const lx = dy === 2 ? x1 : x1 + (x2 > x1 ? 1 : -1);
    const ly = dy === 2 ? y1 + (y2 > y1 ? 1 : -1) : y1;
    return !cells[`${lx},${ly}`];
  }
  if (t === 'E') {
    if (dx !== 2 || dy !== 2 || !ownRiver(side, y2)) return false;
    return !cells[`${(x1 + x2) / 2},${(y1 + y2) / 2}`];
  }
  if (t === 'A') return dx === 1 && dy === 1 && palace(side, x2, y2);
  if (t === 'K') return ((dx === 1 && dy === 0) || (dx === 0 && dy === 1)) && palace(side, x2, y2);
  if (t === 'P') {
    const fwd = side === 'b' ? 1 : -1;
    if (dx === 0 && y2 - y1 === fwd) return true;
    const crossed = side === 'b' ? y1 >= 5 : y1 <= 4;
    return crossed && dy === 0 && dx === 1;
  }
  return false;
}

/** 将帅照面（同列且中间无子）→ 该局面非法 */
function generalsFace(cells: Cells): boolean {
  let bx = -1, by = -1, rx = -1, ry = -1;
  for (const [k, v] of Object.entries(cells)) {
    const p = String(v);
    if (p[1] !== 'K') continue;
    const [x, y] = k.split(',').map(Number);
    if (p[0] === 'b') { bx = x; by = y; } else { rx = x; ry = y; }
  }
  if (bx < 0 || rx < 0) return false;   // 有一方将已被吃
  return bx === rx && countBetween(cells, bx, by, rx, ry) === 0;
}

/** side 的将是否正被对方攻击（被将军）。用于过滤自杀/不应将的着法。 */
function inCheck(cells: Cells, side: 'b' | 'r'): boolean {
  let kx = -1, ky = -1;
  const king = side + 'K';
  for (const [k, v] of Object.entries(cells)) {
    if (String(v) === king) { [kx, ky] = k.split(',').map(Number); break; }
  }
  if (kx < 0) return false;
  const opp = side === 'b' ? 'r' : 'b';
  for (const [k, v] of Object.entries(cells)) {
    const p = String(v);
    if (p[0] !== opp) continue;
    const [x1, y1] = k.split(',').map(Number);
    if (xiangqiLegal(cells, p, x1, y1, kx, ky)) return true;
  }
  return false;
}

function applyMove(cells: Cells, m: XQMove): Cells {
  const next = { ...cells };
  const p = next[m.from.join(',')];
  delete next[m.from.join(',')];
  next[m.to.join(',')] = p;
  return next;
}

/**
 * 位置增益：按通用象棋理论用公式生成（不复制任何第三方数值表）。
 * d = 从自家底线向对方推进的距离 0..9；cx = 中心度 0..4。
 */
function positionBonus(type: string, side: 'b' | 'r', x: number, y: number): number {
  const d = side === 'b' ? y : 9 - y;
  const cx = 4 - Math.abs(x - 4);
  switch (type) {
    case 'P': {
      // 过河兵越深入、越靠中路价值越高
      if (d < 5) return 8 + cx * 2;
      return 70 + (d - 5) * 26 + cx * 10;
    }
    case 'H': {
      // 马忌边角，过河后威胁大增
      const edge = x === 0 || x === 8 ? -28 : 0;
      return cx * 10 + (d >= 5 ? (d - 4) * 12 : d * 2) + edge;
    }
    case 'R': {
      // 车控中线、沉底/占对方卒林线加分
      return cx * 7 + (d >= 7 ? 34 : d >= 5 ? 14 : 0);
    }
    case 'C': {
      // 炮居中、架在己方河界附近更有用
      return cx * 9 + (d >= 3 && d <= 6 ? 18 : 0);
    }
    case 'E':
    case 'A':
      return d <= 2 ? 12 : -20;   // 防守子离位要扣分
    case 'K':
      return d === 0 ? 10 : 0;     // 将宜守在底线
    default:
      return 0;
  }
}

/**
 * 对外统一的「这一步能不能走」：单步走法 + 将帅照面 + 自杀/不应将。
 * 练习模式的玩家落子与 AI 生成共用这一份，避免两套规则各自漂移。
 */
export function xiangqiCanMove(cells: Cells, from: [number, number], to: [number, number]): boolean {
  const piece = String(cells[from.join(',')] || '');
  if (piece.length < 2) return false;
  const side = piece[0] as 'b' | 'r';
  if (!xiangqiLegal(cells, piece, from[0], from[1], to[0], to[1])) return false;
  const next = applyMove(cells, { from, to });
  if (generalsFace(next)) return false;
  if (inCheck(next, side)) return false;
  return true;
}

/** 局面评估：黑方（AI）视角。材料 + 位置 + 将帅照面，对方子力略折扣防无脑兑子 */
function evaluate(cells: Cells): number {
  let score = 0;
  let blackKing = false, redKing = false;
  for (const [key, v] of Object.entries(cells)) {
    const p = String(v);
    if (p.length < 2) continue;
    const side = p[0] as 'b' | 'r';
    const type = p[1];
    if (type === 'K') { if (side === 'b') blackKing = true; else redKing = true; }
    const [x, y] = key.split(',').map(Number);
    const val = (VALUE[type] || 0) + positionBonus(type, side, x, y);
    // 双方同一套价值，保证对称局面评估为 0；不对称折扣会让整个搜索带系统性偏置
    score += side === 'b' ? val : -val;
  }
  if (!blackKing) return -MATE;
  if (!redKing) return MATE;
  return score;
}

/** 生成合法着法：伪合法 → 过滤照面自杀 */
export function genXiangqiMoves(cells: Cells, side: 'b' | 'r'): XQMove[] {
  const out: XQMove[] = [];
  // 先算一次两将位置：非将走法只有在「两将同列且动了中间的子」时才可能造成照面，
  // 其余绝大多数走法可跳过全盘扫描，走法生成从 ~5ms 降到 <1ms
  let bkx = -1, bky = -1, rkx = -1, rky = -1;
  for (const [k, v] of Object.entries(cells)) {
    const p = String(v);
    if (p[1] !== 'K') continue;
    const [x, y] = k.split(',').map(Number);
    if (p[0] === 'b') { bkx = x; bky = y; } else { rkx = x; rky = y; }
  }
  const sameFile = bkx >= 0 && rkx >= 0 && bkx === rkx;
  const fileX = bkx;
  const segLo = Math.min(bky, rky) + 1, segHi = Math.max(bky, rky) - 1;
  const onSegment = (x: number, y: number) =>
    sameFile && x === fileX && y >= segLo && y <= segHi;
  const mayFace = (piece: string, x1: number, y1: number, x2: number, y2: number) =>
    piece[1] === 'K' || onSegment(x1, y1) || onSegment(x2, y2);

  for (const [key, v] of Object.entries(cells)) {
    const piece = String(v);
    if (piece[0] !== side) continue;
    const [x1, y1] = key.split(',').map(Number);
    for (let x2 = 0; x2 < XIANGQI_X; x2++) {
      for (let y2 = 0; y2 < XIANGQI_Y; y2++) {
        if (x1 === x2 && y1 === y2) continue;
        if (!xiangqiLegal(cells, piece, x1, y1, x2, y2)) continue;
        const m: XQMove = { from: [x1, y1], to: [x2, y2] };
        if (mayFace(piece, x1, y1, x2, y2) && generalsFace(applyMove(cells, m))) continue;
        out.push(m);
      }
    }
  }
  return out;
}

function moveScore(cells: Cells, m: XQMove): number {
  const target = cells[m.to.join(',')];
  const mover = String(cells[m.from.join(',')] || '');
  let s = 0;
  if (target) {
    const victim = VALUE[String(target)[1]] || 0;
    const attacker = VALUE[mover[1]] || 0;
    s += victim * 10 - attacker;              // MVV-LVA
  }
  // 和平着法也要区分好坏：走向更好位置的着法排前面，
  // 否则开局几十个着法全是 0 分，限宽会按生成顺序砍掉一整批合理着法
  if (mover.length >= 2) {
    const side = mover[0] as 'b' | 'r';
    s += positionBonus(mover[1], side, m.to[0], m.to[1])
       - positionBonus(mover[1], side, m.from[0], m.from[1]);
  }
  return s;
}

function boardKey(cells: Cells, side: 'b' | 'r'): string {
  // 稀疏局面：只拼有子的格（最多 32 个），比扫 90 格快得多
  const keys = Object.keys(cells).sort();
  let out = side;
  for (const k of keys) out += `|${k}${String(cells[k])}`;
  return out;
}

type TTEntry = { depth: number; score: number; flag: 'exact' | 'lower' | 'upper'; move?: XQMove };

class Engine {
  private tt = new Map<string, TTEntry>();
  private deadline = 0;
  private nodes = 0;
  private aborted = false;
  private maxWidth = 16;

  private search(cells: Cells, depth: number, alpha: number, beta: number,
                 side: 'b' | 'r'): number {
    this.nodes++;
    if ((this.nodes & 63) === 0 && Date.now() > this.deadline) this.aborted = true;
    if (this.aborted) return evaluate(cells);

    const useTT = depth >= 2;
    const key = useTT ? boardKey(cells, side) : '';
    const hit = useTT ? this.tt.get(key) : undefined;
    if (hit && hit.depth >= depth) {
      if (hit.flag === 'exact') return hit.score;
      if (hit.flag === 'lower' && hit.score >= beta) return hit.score;
      if (hit.flag === 'upper' && hit.score <= alpha) return hit.score;
    }

    if (depth <= 0) return evaluate(cells);
    let moves = genXiangqiMoves(cells, side);
    if (!moves.length) return side === 'b' ? -MATE : MATE;  // 困毙
    moves.sort((a, b) => {
      if (hit?.move) {
        const k = (m: XQMove) => (m.from[0] === hit.move!.from[0] && m.from[1] === hit.move!.from[1]
          && m.to[0] === hit.move!.to[0] && m.to[1] === hit.move!.to[1]) ? 1e7 : 0;
        const pv = k(b) - k(a);
        if (pv) return pv;
      }
      return moveScore(cells, b) - moveScore(cells, a);
    });
    const width = depth >= 3 ? this.maxWidth : 32;
    if (moves.length > width) moves = moves.slice(0, width);

    const alpha0 = alpha, beta0 = beta;
    let best = side === 'b' ? -Infinity : Infinity;
    let bestMove: XQMove | undefined;
    for (const m of moves) {
      const next = applyMove(cells, m);
      const v = this.search(next, depth - 1, alpha, beta, side === 'b' ? 'r' : 'b');
      if (this.aborted) return evaluate(cells);
      if (side === 'b') {
        if (v > best) { best = v; bestMove = m; }
        if (best > alpha) alpha = best;
      } else {
        if (v < best) { best = v; bestMove = m; }
        if (best < beta) beta = best;
      }
      if (alpha >= beta) break;
    }
    const flag: TTEntry['flag'] = best <= alpha0 ? 'upper' : best >= beta0 ? 'lower' : 'exact';
    if (useTT && this.tt.size < 60000) this.tt.set(key, { depth, score: best, flag, move: bestMove });
    return best;
  }

  /** 根节点：迭代加深，超时返回上一层已完整算出的结果 */
  run(cells: Cells, side: 'b' | 'r', maxDepth: number, budgetMs: number,
      width: number): { move: XQMove | null; depth: number; nodes: number } {
    this.deadline = Date.now() + budgetMs;
    this.nodes = 0;
    this.aborted = false;
    this.maxWidth = width;
    let moves = genXiangqiMoves(cells, side);
    if (!moves.length) return { move: null, depth: 0, nodes: 0 };

    // 一步吃将直接结束
    const kill = moves.find((m) => String(cells[m.to.join(',')] || '')[1] === 'K');
    if (kill) return { move: kill, depth: 0, nodes: 1 };

    // 过滤自杀着法：走完之后自己的将仍被攻击 = 非法。
    // 被将军时这一步同时保证「必须应将」，不会再出现送将 / 无视将军的乱下
    const safe = moves.filter((m) => !inCheck(applyMove(cells, m), side));
    if (safe.length) moves = safe;

    moves.sort((a, b) => moveScore(cells, b) - moveScore(cells, a));
    const root = moves.slice(0, 32);
    let chosen = root[0];
    let reached = 0;

    const maximizing = side === 'b';   // evaluate() 固定黑方视角
    for (let depth = 1; depth <= maxDepth; depth++) {
      // PVS：首个候选全窗口，其余零窗口探测，只有可能更优的才全窗口重搜。
      // 既不牺牲剪枝效率，又保证参与比较的分数都是真实值（窄窗口返回的是
      // fail-low / fail-high 边界伪值，拿去「同分随机」会选到烂着）
      const scored: { m: XQMove; v: number; exact: boolean }[] = [];
      let alpha = -Infinity, beta = Infinity;
      let ok = true;
      const ordered = [chosen, ...root.filter((m) => m !== chosen)];
      const other = side === 'b' ? 'r' : 'b';
      for (let i = 0; i < ordered.length; i++) {
        if (Date.now() > this.deadline) { this.aborted = true; ok = false; break; }
        const m = ordered[i];
        const next = applyMove(cells, m);
        let v: number;
        let exact: boolean;
        if (i === 0) {
          v = this.search(next, depth - 1, -Infinity, Infinity, other);
          exact = true;
        } else {
          const a = maximizing ? alpha : beta - 1;
          const b = maximizing ? alpha + 1 : beta;
          const probe = this.search(next, depth - 1, a, b, other);
          const promising = maximizing ? probe > alpha : probe < beta;
          if (promising) {
            v = this.search(next, depth - 1, -Infinity, Infinity, other);
            exact = true;
          } else {
            v = probe;
            exact = false;
          }
        }
        if (this.aborted) { ok = false; break; }
        scored.push({ m, v, exact });
        if (exact) {
          if (maximizing && v > alpha) alpha = v;
          if (!maximizing && v < beta) beta = v;
        }
      }
      if (!ok || Date.now() > this.deadline) break;
      // 只有全窗口重搜过的候选才参与最终选择
      const exact = scored.filter((s) => s.exact);
      if (!exact.length) break;
      let bestV = maximizing ? -Infinity : Infinity;
      for (const s of exact) {
        if (maximizing ? s.v > bestV : s.v < bestV) bestV = s.v;
      }
      // 只在「与最优分差极小」的前 3 个候选里随机，且浅层搜索不随机
      const near = exact.filter((s) => Math.abs(s.v - bestV) <= 8).slice(0, 3);
      const pick = depth >= 2 && near.length > 0
        ? near[Math.floor(Math.random() * near.length)].m
        : exact.reduce((a, b) => (maximizing ? (b.v > a.v ? b : a) : (b.v < a.v ? b : a)),
                       exact[0]).m;
      if (pick) chosen = pick;
      reached = depth;
      if (Math.abs(bestV) > MATE / 2) break;   // 已经看到杀棋，不必再深挖
    }
    return { move: chosen, depth: reached, nodes: this.nodes };
  }
}

export interface AIResult {
  move: XQMove | null;
  depth: number;
  nodes: number;
  elapsed: number;
}

/**
 * 主入口。side 固定 'b'（练习模式 AI 执黑）；难度 1/2/3 → 2/3/4 层迭代加深。
 * budgetMs 是总时间预算，超时自动返回上一层的完整结果，绝不会返回半成品。
 */
export function xiangqiAiMove(cells: Cells, level: XQLevel = 2,
                              budgetMs = 900, side: 'b' | 'r' = 'b'): AIResult {
  const started = Date.now();
  const maxDepth = level === 1 ? 2 : level === 2 ? 3 : 4;
  const width = level === 1 ? 10 : level === 2 ? 14 : 18;
  const engine = new Engine();
  const r = engine.run(cells, side, maxDepth, Math.max(60, budgetMs), width);
  return { move: r.move, depth: r.depth, nodes: r.nodes, elapsed: Date.now() - started };
}

/** 供对弈基准使用：评估某个局面（黑方视角） */
export function xiangqiEvaluate(cells: Cells): number { return evaluate(cells); }
export function xiangqiApplyMove(cells: Cells, m: XQMove): Cells { return applyMove(cells, m); }
