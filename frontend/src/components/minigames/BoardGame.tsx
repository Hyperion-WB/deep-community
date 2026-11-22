import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiClient } from '../../api/client';
import { ChineseChessBoard } from './ChineseChessBoard';
import { genXiangqiMoves, xiangqiCanMove, xiangqiAiMove, type XQLevel } from './xiangqiAI';

type Code = 'gomoku' | 'xiangqi' | 'tictactoe';
type Cells = Record<string, number | string>;

interface Props {
  gameCode: Code;
  loggedIn: boolean;
  myId: string;
  matches: Match[];
  activeSnapshot?: Match | null;
  initialMatch?: Match;
  onActiveMatch: (id: string | null) => void;
  onResult: (id: string) => void;
  refreshBattles: () => void;
}

const GOMOKU_N = 15;
const TTT_N = 3;
const XIANGQI_X = 9;
const XIANGQI_Y = 10;
const GAME_LABELS: Record<string, string> = { gomoku: '五子棋', xiangqi: '中国象棋', tictactoe: '井字棋' };

function initialXiangqi(): Cells {
  const back = ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'];
  const c: Cells = {};
  back.forEach((t, x) => { c[`${x},0`] = 'b' + t; c[`${x},9`] = 'r' + t; });
  [1, 7].forEach((x) => { c[`${x},2`] = 'bC'; c[`${x},7`] = 'rC'; });
  for (let x = 0; x < 9; x += 2) { c[`${x},3`] = 'bP'; c[`${x},6`] = 'rP'; }
  return c;
}

function xiangqiLost(cells: Cells, side: "r" | "b"): boolean {
  return !Object.values(cells).includes(side + "K") ||
    !genXiangqiMoves(cells, side).some(({ from, to }) => xiangqiCanMove(cells, from, to));
}

function hasFive(cells: Cells, x: number, y: number, side: number): boolean {
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let n = 1;
    for (const sign of [1, -1]) {
      for (let k = 1; k < 5; k++) {
        if (cells[`${x + dx * k * sign},${y + dy * k * sign}`] !== side) break;
        n += 1;
      }
    }
    if (n >= 5) return true;
  }
  return false;
}

const TTT_LINES = [
  [[0, 0], [0, 1], [0, 2]], [[1, 0], [1, 1], [1, 2]], [[2, 0], [2, 1], [2, 2]],
  [[0, 0], [1, 0], [2, 0]], [[0, 1], [1, 1], [2, 1]], [[0, 2], [1, 2], [2, 2]],
  [[0, 0], [1, 1], [2, 2]], [[0, 2], [1, 1], [2, 0]],
];

function tttWinner(cells: Cells, side: number): boolean {
  return TTT_LINES.some((line) => line.every(([a, b]) => cells[`${a},${b}`] === side));
}

function tttAiMove(cells: Cells): [number, number] | null {
  const empty: [number, number][] = [];
  for (let x = 0; x < TTT_N; x++) for (let y = 0; y < TTT_N; y++) {
    if (!cells[`${x},${y}`]) empty.push([x, y]);
  }
  if (!empty.length) return null;
  // 自己能赢就赢，对手能赢就堵，否则优先中心/角
  for (const side of [2, 1]) {
    for (const [x, y] of empty) {
      const probe = { ...cells, [`${x},${y}`]: side };
      if (tttWinner(probe, side)) return [x, y];
    }
  }
  const center: [number, number] = [1, 1];
  if (!cells['1,1']) return center;
  const corners: [number, number][] = [[0, 0], [0, 2], [2, 0], [2, 2]];
  const free = corners.find(([x, y]) => !cells[`${x},${y}`]);
  return free || empty[0];
}

// 象棋走法合法性复用 ./xiangqiAI（与后端规则对齐），避免两份实现漂移


function gomokuAiMove(cells: Cells): [number, number] | null {
  const candidates = new Set<string>();
  Object.keys(cells).forEach((k) => {
    const [x, y] = k.split(',').map(Number);
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < GOMOKU_N && ny >= 0 && ny < GOMOKU_N && !cells[`${nx},${ny}`]) candidates.add(`${nx},${ny}`);
    }
  });
  if (!candidates.size) return [7, 7];
  const score = (x: number, y: number, side: number) => {
    let best = 0;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      let n = 1;
      for (const sign of [1, -1]) for (let k = 1; k < 5; k++) {
        if (cells[`${x + dx * k * sign},${y + dy * k * sign}`] !== side) break;
        n++;
      }
      best = Math.max(best, n);
    }
    return best;
  };
  let pick: [number, number] | null = null, top = -1;
  candidates.forEach((k) => {
    const [x, y] = k.split(',').map(Number);
    const v = Math.max(score(x, y, 2) * 1.2, score(x, y, 1));
    if (v > top) { top = v; pick = [x, y]; }
  });
  return pick;
}

// 象棋 AI 已抽到 ./xiangqiAI.ts（迭代加深 + 置换表 + 位置表 + Web Worker），
// 这里只保留交互层，搜索时主线程完全不阻塞。


/** 最近一手：双方高亮的唯一依据（服务端写入 board_state.last_move） */
export interface BattleLastMove {
  seq: number;
  x: number;
  y: number;
  from_x?: number | null;
  from_y?: number | null;
  actor_id: string;
  at: string;
}

/** 互动提醒 / 嘲讽：服务端预置文案，双方都会收到 */
export interface BattleNudge {
  preset_id: string;
  kind: 'remind' | 'taunt';
  emoji: string;
  text: string;
  from_id: string;
  from_name: string;
  at: string;
}

export interface Match {
  id: string;
  game_code: string;
  status: string;
  created_at: string | null;
  board_state: {
    cells?: Cells;
    turn?: string | null;
    result?: string;
    winner?: string | null;
    red?: string;
    black?: string;
    started_at?: string;
    last_move?: BattleLastMove | null;
    last_nudge?: BattleNudge | null;
  };
  move_seq: number;
  turn_user_id: string | null;
  winner_id: string | null;
  result: string | null;
  inviter_id: string;
  invitee_id: string;
  inviter_name?: string;
  invitee_name?: string;
  first_player_id?: string | null;
  red_id?: string | null;
  black_id?: string | null;
  last_move?: BattleLastMove | null;
  last_move_at?: string | null;
  last_nudge?: BattleNudge | null;
  server_now?: string;
  nudge_idle_seconds?: number;
  nudge_cooldown_seconds?: number;
  finished_at?: string | null;
}

export const BoardGame: React.FC<Props> = ({
  gameCode, loggedIn, myId, matches, activeSnapshot, initialMatch, onActiveMatch, onResult, refreshBattles,
}) => {
  const [mode, setMode] = useState<'online' | 'practice'>(loggedIn ? 'online' : 'practice');
  const [active, setActive] = useState<Match | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [notice, setNotice] = useState('');
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [practice, setPractice] = useState<{ cells: Cells; winner: string | null }>(() => ({
    cells: gameCode === "xiangqi" ? initialXiangqi() : {}, winner: null,
  }));
  // 象棋 AI：Worker 异步搜索，避免主线程卡顿；支持难度与过期结果丢弃
  const workerRef = useRef<Worker | null>(null);
  const reqSeqRef = useRef(0);
  const [aiThinking, setAiThinking] = useState(false);
  const [aiLevel, setAiLevel] = useState<XQLevel>(2);
  const [aiInfo, setAiInfo] = useState('');
  const busy = useRef(false);
  const activeRef = useRef<Match | null>(null);

  // ---------- 棋局互动：催一催 / 嘲讽 ----------
  const [nudgePresets, setNudgePresets] = useState<{ id: string; kind: string; emoji: string; text: string }[]>([]);
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [nudgeBanner, setNudgeBanner] = useState<(BattleNudge & { mine: boolean }) | null>(null);
  const [nudgeHistory, setNudgeHistory] = useState<(BattleNudge & { mine: boolean })[]>([]);
  // 嘲讽以「卡片」形式当面闪出（类似每日求签卡片，但自动收起、不挡操作）
  const [nudgeCard, setNudgeCard] = useState<(BattleNudge & { mine: boolean }) | null>(null);
  // 对局结束的胜负卡片
  const [resultCard, setResultCard] = useState<Match | null>(null);
  const [nudging, setNudging] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const seenNudgesRef = useRef<Set<string>>(new Set());
  const seenResultsRef = useRef<Set<string>>(new Set());
  const bannerTimerRef = useRef<number | null>(null);
  const cardTimerRef = useRef<number | null>(null);
  const nudgeMenuRef = useRef<HTMLDivElement | null>(null);
  // 服务端给出的「对方已思考秒数」+ 本地时钟起点：
  // 避免本机时钟与服务端有偏差时倒计时乱跳，同时每秒本地自增。
  const idleBaseRef = useRef<{ seconds: number; wall: number }>({ seconds: 0, wall: Date.now() });

  const openMatch = useCallback((match: Match | null) => {
    activeRef.current = match;
    setActive(match);
    setSel(null);
    onActiveMatch(match && (match.status === "playing" || match.status === "pending") ? match.id : null);
  }, [onActiveMatch]);

  const syncActive = useCallback((next: Match) => {
    const prev = activeRef.current;
    if (!prev || prev.id !== next.id || next.move_seq < prev.move_seq || prev.status === "finished") return;
    if (next.status === "pending" && prev.status !== "pending") return;

    const sameSeq = next.move_seq === prev.move_seq && next.status === prev.status;
    const sameNudge = (next.last_nudge?.at || "") === (prev.last_nudge?.at || "");
    if (sameSeq && sameNudge) return;

    if (sameSeq) {
      // 只有互动提醒变化（没有新落子）：就地合并，不能走 openMatch —— 否则会清掉
      // 玩家已经选中的棋子，轮到一半被人催一下就前功尽弃。
      const merged = { ...prev, ...next };
      activeRef.current = merged;
      setActive(merged);
      return;
    }
    openMatch({ ...prev, ...next });
    if (next.status === "finished") onResult(next.id);
  }, [openMatch, onResult]);

  useEffect(() => () => { activeRef.current = null; onActiveMatch(null); }, [onActiveMatch]);

  // 每秒走一次：驱动「对方思考 N 秒」与提醒冷却倒计时
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 互动预置文案只拉一次（服务端校验 preset_id，前端不做自由输入）
  useEffect(() => {
    if (!loggedIn || nudgePresets.length) return;
    apiClient.get('/battles/nudge-presets')
      .then((res) => setNudgePresets(Array.isArray(res.data?.items) ? res.data.items : []))
      .catch(() => undefined);
  }, [loggedIn, nudgePresets.length]);

  // 用服务端的 server_now / last_move_at 校准“对方已思考多久”，轮询回来即校正漂移
  useEffect(() => {
    if (mode !== 'online' || !active) {
      idleBaseRef.current = { seconds: 0, wall: Date.now() };
      setClock(Date.now());
      return;
    }
    const serverNow = active.server_now ? new Date(active.server_now).getTime() : Date.now();
    const lastAt = active.last_move_at || active.board_state?.last_move?.at;
    const last = lastAt ? new Date(lastAt).getTime() : serverNow;
    idleBaseRef.current = {
      seconds: Math.max(0, (serverNow - last) / 1000),
      wall: Date.now(),
    };
    setClock(Date.now());
  }, [mode, active?.id, active?.status, active?.move_seq, active?.server_now, active?.last_move_at]);

  /**
   * 展示一条互动：去重（同一 at 只播一次）、进最近 5 条记录。
   * 提醒 = 顶部提示条（8s）；嘲讽 = 当面闪出的卡片（约 2.6s 自动淡出）。
   */
  const showNudge = useCallback((n?: BattleNudge | null) => {
    if (!n || !n.at || seenNudgesRef.current.has(n.at)) return;
    seenNudgesRef.current.add(n.at);
    const item = { ...n, mine: n.from_id === myId };
    setNudgeHistory((prev) => [item, ...prev].slice(0, 5));
    if (n.kind === 'taunt') {
      setNudgeCard(item);
      if (cardTimerRef.current) window.clearTimeout(cardTimerRef.current);
      // 动画：0.42s 闪入 + 2.5s 停留 + 0.34s 淡出，2.9s 后卸载
      cardTimerRef.current = window.setTimeout(() => setNudgeCard(null), 2900);
      return;
    }
    setNudgeBanner(item);
    if (bannerTimerRef.current) window.clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = window.setTimeout(() => setNudgeBanner(null), 8000);
  }, [myId]);

  // 对手的互动可能来自轮询（2.5s）也可能来自 WS 推送，这里统一按 last_nudge 驱动
  useEffect(() => {
    const n = active?.last_nudge || active?.board_state?.last_nudge;
    if (!n || !n.at) return;
    const serverNow = active?.server_now ? new Date(active.server_now).getTime() : Date.now();
    const at = new Date(n.at).getTime();
    // 刷新后不重放很久以前的旧提醒
    if (Number.isFinite(at) && serverNow - at > 90_000) {
      seenNudgesRef.current.add(n.at);
      return;
    }
    showNudge(n);
  }, [active?.last_nudge?.at, active?.server_now, showNudge]);

  // 对局结束：弹一张胜负卡片（胜利/失败/和棋），与求签卡片同一套视觉语言。
  // 只对「刚结束」的对局弹，避免从列表点开陈年旧局也弹。
  useEffect(() => {
    if (mode !== 'online' || !active) {
      setResultCard(null);
      return;
    }
    if (active.status !== 'finished') {
      setResultCard(null);
      return;
    }
    const key = `${active.id}:${active.finished_at || active.move_seq}`;
    if (seenResultsRef.current.has(key)) return;
    seenResultsRef.current.add(key);
    const finishedAt = active.finished_at ? new Date(active.finished_at).getTime() : 0;
    if (finishedAt && Date.now() - finishedAt > 10 * 60 * 1000) return;
    setResultCard(active);
  }, [mode, active?.id, active?.status, active?.finished_at, active?.move_seq]);

  useEffect(() => {
    setNudgeBanner(null);
    setNudgeCard(null);
    setNudgeHistory([]);
    setNudgeOpen(false);
    setCooldownUntil(0);
  }, [active?.id]);

  // 点面板外 / Esc 收起互动面板
  useEffect(() => {
    if (!nudgeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!nudgeMenuRef.current?.contains(e.target as Node)) setNudgeOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNudgeOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [nudgeOpen]);

  useEffect(() => () => {
    if (bannerTimerRef.current) window.clearTimeout(bannerTimerRef.current);
    if (cardTimerRef.current) window.clearTimeout(cardTimerRef.current);
  }, []);

  useEffect(() => {
    if (!loggedIn || initialMatch?.game_code !== gameCode) return;
    setMode("online");
    openMatch(initialMatch);
  }, [initialMatch, gameCode, loggedIn, openMatch]);

  useEffect(() => {
    if (mode !== "online" || !active) return;
    const next = activeSnapshot?.id === active.id ? activeSnapshot : matches.find((match) => match.id === active.id);
    if (next) syncActive(next);
  }, [active, activeSnapshot, matches, mode, syncActive]);

  useEffect(() => {
    if (gameCode !== 'xiangqi') return;
    let w: Worker | null = null;
    try {
      w = new Worker(new URL('./xiangqiAI.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<any>) => {
        const { reqId, move, depth, nodes, elapsed } = e.data || {};
        if (reqId !== reqSeqRef.current) return;   // 用户已重新开局/走子，丢弃过期结果
        setAiThinking(false);
        setAiInfo(`搜索 ${depth} 层 · ${nodes} 节点 · ${elapsed}ms`);
        if (!move) return;
        setPractice((prev) => {
          if (prev.winner) return prev;
          const next = { ...prev.cells };
          const p = next[move.from.join(',')];
          delete next[move.from.join(',')];
          next[move.to.join(',')] = p;
          return { cells: next, winner: xiangqiLost(next, 'r') ? 'AI 赢了' : null };
        });
      };
      workerRef.current = w;
    } catch {
      workerRef.current = null;                   // 不支持 Worker 时回退到主线程低预算
    }
    return () => { w?.terminate(); workerRef.current = null; };
  }, [gameCode]);

  const doSearch = async () => {
    const q = query.trim();
    if (!q) { setResults([]); return; }
    try {
      const res = await apiClient.get('/battles/search-users', { params: { q } });
      setResults(res.data?.items || []);
    } catch { setResults([]); }
  };

  const invite = async (uid: string) => {
    try {
      await apiClient.post('/battles', { game_code: gameCode, invitee_id: uid });
      setNotice('邀请已发出，等待对方接受');
      setQuery(''); setResults([]);
      refreshBattles();
    } catch (err: any) { setNotice(err?.response?.data?.detail || '邀请失败'); }
  };

  const respond = async (m: Match, action: 'accept' | 'decline' | 'cancel') => {
    try {
      const res = await apiClient.post(`/battles/${m.id}/${action}`);
      if (action === 'accept') openMatch({ ...m, ...res.data });
      else if (activeRef.current?.id === m.id) openMatch(null);
      refreshBattles();
    } catch (err: any) { setNotice(err?.response?.data?.detail || '操作失败'); }
  };

  const moveOnline = async (x: number, y: number, from?: [number, number]) => {
    if (!active || busy.current) return;
    busy.current = true;
    try {
      const res = await apiClient.post(`/battles/${active.id}/move`, {
        expected_seq: active.move_seq, x, y,
        from_x: from?.[0], from_y: from?.[1],
      });
      syncActive(res.data);
      if (res.data.status === "finished") onResult(res.data.id);
      refreshBattles();
    } catch (err: any) { setNotice(err?.response?.data?.detail || '走子失败'); }
    finally { busy.current = false; }
  };

  const resign = async () => {
    if (!active || busy.current) return;
    busy.current = true;
    try {
      const res = await apiClient.post(`/battles/${active.id}/resign`);
      syncActive(res.data);
      if (res.data.status === "finished") onResult(res.data.id);
      setNotice("已认输，本局计负");
      refreshBattles();
    } catch (err: any) { setNotice(err?.response?.data?.detail || "操作失败"); }
    finally { busy.current = false; }
  };

  const removeMatch = async (m: Match) => {
    try {
      await apiClient.delete(`/battles/${m.id}`);
      if (activeRef.current?.id === m.id) openMatch(null);
      setNotice('对局记录已删除');
      refreshBattles();
    } catch (err: any) {
      setNotice(err?.response?.data?.detail || '删除失败');
    }
  };

  // 发送互动：服务端会再次校验轮次/30 秒/10 秒冷却，这里只负责即时反馈
  const sendNudge = async (presetId: string) => {
    if (!active || nudging) return;
    setNudging(true);
    setNudgeOpen(false);
    try {
      const res = await apiClient.post(`/battles/${active.id}/nudge`, { preset_id: presetId });
      showNudge(res.data?.nudge);
      setCooldownUntil(Date.now() + Number(res.data?.cooldown_seconds || 5) * 1000);
      setNotice('已发送互动，等对方落子');
    } catch (err: any) {
      setNotice(err?.response?.data?.detail || '发送失败');
    } finally {
      setNudging(false);
    }
  };

  // 胜负卡片上的「再来一局」：向同一对手重新发起邀请
  const rematch = async () => {
    if (!active) return;
    const opponent = active.inviter_id === myId ? active.invitee_id : active.inviter_id;
    try {
      await apiClient.post('/battles', { game_code: active.game_code, invitee_id: opponent });
      setNotice('已再次邀请对手，等对方接受');
      setResultCard(null);
      refreshBattles();
    } catch (err: any) {
      // 卡片会盖住顶部提示，失败时先收起卡片，让用户看到具体原因（例如已有待接受邀请）
      setResultCard(null);
      setNotice(err?.response?.data?.detail || '再次邀请失败');
    }
  };

  // 练习模式：本地棋盘 + 简易 AI，完全不请求后端、不入库
  const practiceMove = (x: number, y: number, from?: [number, number]) => {
    if (practice.winner) return;
    const cells = { ...practice.cells };
    if (gameCode === 'tictactoe') {
      const key = `${x},${y}`;
      if (cells[key]) return;
      cells[key] = 1;
      if (tttWinner(cells, 1)) { setPractice({ cells, winner: '你赢了' }); return; }
      if (Object.keys(cells).length >= 9) { setPractice({ cells, winner: '和棋' }); return; }
      const ai = tttAiMove(cells);
      if (ai) {
        const [ax, ay] = ai;
        cells[`${ax},${ay}`] = 2;
        if (tttWinner(cells, 2)) { setPractice({ cells, winner: 'AI 赢了' }); return; }
        if (Object.keys(cells).length >= 9) { setPractice({ cells, winner: '和棋' }); return; }
      }
    } else if (gameCode === 'gomoku') {
      const key = `${x},${y}`;
      if (cells[key]) return;
      cells[key] = 1;
      if (hasFive(cells, x, y, 1)) { setPractice({ cells, winner: '你赢了' }); return; }
      const ai = gomokuAiMove(cells);
      if (ai) {
        const [ax, ay] = ai;
        cells[`${ax},${ay}`] = 2;
        if (hasFive(cells, ax, ay, 2)) { setPractice({ cells, winner: 'AI 赢了' }); return; }
      }
    } else {
      if (!from) return;
      if (aiThinking) return;                       // AI 思考中禁止连点
      const piece = cells[from.join(',')];
      if (!piece || String(piece)[0] !== 'r') return;
      if (!xiangqiCanMove(cells, from, [x, y])) { setNotice('这一步不符合规则（不能送将或将帅照面）'); return; }
      delete cells[from.join(',')];
      cells[`${x},${y}`] = piece;
      if (xiangqiLost(cells, 'b')) { setPractice({ cells, winner: '你赢了' }); return; }
      // 先呈现玩家着法，再把搜索交给 Worker（或低预算同步兜底）
      setPractice({ cells, winner: null });
      setAiThinking(true);
      const reqId = ++reqSeqRef.current;
      const w = workerRef.current;
      if (w) {
        // 难度同时调搜索层数与时间预算；Worker 里跑，再长也不阻塞界面
        const budgetMs = aiLevel === 1 ? 400 : aiLevel === 2 ? 900 : 1600;
        w.postMessage({ reqId, cells, level: aiLevel, budgetMs });
      } else {
        window.setTimeout(() => {
          if (reqId !== reqSeqRef.current) return;
          const r = xiangqiAiMove(cells, aiLevel, 180);
          setAiThinking(false);
          setAiInfo(`搜索 ${r.depth} 层 · ${r.nodes} 节点 · ${r.elapsed}ms`);
          if (!r.move) return;
          setPractice((prev) => {
            if (prev.winner) return prev;
            const next = { ...prev.cells };
            const p2 = next[r.move!.from.join(',')];
            delete next[r.move!.from.join(',')];
            next[r.move!.to.join(',')] = p2;
            return { cells: next, winner: xiangqiLost(next, 'r') ? 'AI 赢了' : null };
          });
        }, 0);
      }
      return;
    }
    setPractice({ cells, winner: null });
  };

  const onCell = (x: number, y: number) => {
    if (gameCode !== 'xiangqi') {
      if (mode === 'practice') practiceMove(x, y);
      else if (active?.status === 'playing' && active.turn_user_id === myId) void moveOnline(x, y);
      return;
    }
    // 练习模式玩家固定执红、不翻转；在线对局按服务端分配的阵营
    const ownSide: 'r' | 'b' = mode === 'practice' ? 'r' : mySide;
    const source = mode === 'practice'
      ? practice.cells
      : (active?.board_state?.cells || {});

    if (mode === 'practice') {
      const piece = source[`${x},${y}`];
      const mine = piece && String(piece)[0] === ownSide;
      if (mine) { setSel([x, y]); return; }        // 点自己棋子＝选中/改选
      if (sel) { practiceMove(x, y, sel); setSel(null); }
      return;
    }
    if (!myId || active?.status !== 'playing' || active.turn_user_id !== myId) return;
    const piece = source[`${x},${y}`];
    const mine = piece && String(piece)[0] === ownSide;
    if (mine) { setSel([x, y]); return; }          // 对方棋子无法选中
    if (sel) { void moveOnline(x, y, sel); setSel(null); }
  };

  const gameMatches = matches.filter((match) => match.game_code === gameCode);
  const cells: Cells = mode === 'practice' ? practice.cells : (active?.board_state?.cells || {});
  const isXiangqi = gameCode === 'xiangqi';
  // 服务端 board_state.red/black 是权威阵营；练习模式玩家固定执红
  const boardRed = (mode === 'practice' ? '' : (active?.board_state?.red || active?.red_id || ''));
  const boardBlack = (mode === 'practice' ? '' : (active?.board_state?.black || active?.black_id || ''));
  const mySide: 'r' | 'b' = (mode === 'practice' || !boardRed || !myId)
    ? 'r'
    : (boardRed === myId ? 'r' : 'b');
  const flipped = isXiangqi && mySide === 'b' && mode !== 'practice';
  const turnUid = active?.turn_user_id || active?.board_state?.turn || '';
  const turnSide: 'r' | 'b' | null = !isXiangqi || mode === 'practice' || !boardRed
    ? null
    : (turnUid === boardRed ? 'r' : turnUid === boardBlack ? 'b' : null);
  const sideName = (side: string) => side === 'r' ? '红方' : '黑方';
  const isTicTacToe = gameCode === 'tictactoe';
  const cols = isXiangqi ? XIANGQI_X : isTicTacToe ? TTT_N : GOMOKU_N;
  const rows = isXiangqi ? XIANGQI_Y : isTicTacToe ? TTT_N : GOMOKU_N;
  const myTurn = mode === 'practice' || !active || active.status !== 'playing'
    ? true : active.turn_user_id === myId;

  // 最近一手：对方刚落的高亮闪 3 次后保持静态，直到自己落子把它“顶掉”
  const lastMove: BattleLastMove | null = mode === 'online'
    ? (active?.last_move || active?.board_state?.last_move || null)
    : null;
  const lastMoveMine = Boolean(lastMove && lastMove.actor_id === myId);
  const lastMoveKey = lastMove ? `${lastMove.seq}-${lastMove.actor_id}` : '';
  const idleSeconds = idleBaseRef.current.seconds + Math.max(0, clock - idleBaseRef.current.wall) / 1000;
  const nudgeIdleNeed = active?.nudge_idle_seconds ?? 10;
  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - clock) / 1000));
  const canNudge = mode === 'online' && active?.status === 'playing' && !myTurn
    && idleSeconds >= nudgeIdleNeed && cooldownLeft <= 0 && !nudging;

  // 胜负卡片文案：胜利 / 失败 / 和棋
  const resultIsDraw = resultCard?.result === 'draw';
  const resultIsWin = Boolean(resultCard?.winner_id && resultCard.winner_id === myId);
  const resultOpponent = resultCard
    ? (resultCard.inviter_id === myId ? resultCard.invitee_name : resultCard.inviter_name) || ''
    : '';
  const resultTitle = resultIsDraw ? '和棋' : resultIsWin ? '胜利' : '失败';
  const resultEmoji = resultIsDraw ? '🤝' : resultIsWin ? '🏆' : '💀';
  const resultClass = resultIsDraw ? 'battle-card--draw' : resultIsWin ? 'battle-card--win' : 'battle-card--lose';
  const resultSubtitle = resultIsDraw
    ? '势均力敌，这局谁也没占到便宜'
    : resultIsWin
      ? (resultCard?.result === 'resign' ? '对手认输，你拿下了这一局' : '对手无路可走，这局归你')
      : (resultCard?.result === 'resign' ? '你已认输，下一局赢回来' : '这一局被对手拿下了，再来一局？');

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => {
          setMode('online'); setSel(null); setAiThinking(false); reqSeqRef.current++;
        }}
          className={`h-8 px-3 rounded-capsule text-2xs font-semibold ${mode === 'online' ? 'bg-wb-text-primary text-wb-bg-page' : 'bg-wb-bg-subtle text-wb-text-secondary'}`}>
          邀请对战
        </button>
        <button type="button" onClick={() => {
          setMode('practice'); openMatch(null); setAiThinking(false); reqSeqRef.current++;
          setPractice({ cells: gameCode === 'xiangqi' ? initialXiangqi() : {}, winner: null });
        }}
          className={`h-8 px-3 rounded-capsule text-2xs font-semibold ${mode === 'practice' ? 'bg-wb-text-primary text-wb-bg-page' : 'bg-wb-bg-subtle text-wb-text-secondary'}`}>
          AI 练习（不计分）
        </button>
        {mode === 'practice' && gameCode === 'xiangqi' && (
          <div className="inline-flex items-center gap-1 p-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle">
            {([['简单', 1], ['普通', 2], ['困难', 3]] as const).map(([label, lv]) => (
              <button key={lv} type="button" disabled={aiThinking} onClick={() => setAiLevel(lv)}
                className={`px-2 py-1 rounded-capsule text-3xs font-semibold transition-colors disabled:opacity-50 ${
                  aiLevel === lv ? 'bg-wb-text-primary text-wb-bg-page' : 'text-wb-text-secondary hover:text-wb-text-primary'}`}>
                {label}
              </button>
            ))}
          </div>
        )}
        {notice && <span className="text-3xs text-wb-text-muted">{notice}</span>}
      </div>

      {mode === 'online' && (
        <div className="space-y-2">
          {!loggedIn ? (
            <p className="text-2xs text-wb-text-muted">登录后才能邀请站内用户对战</p>
          ) : !active ? (
            <>
              <div className="flex gap-2">
                <input value={query} onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void doSearch(); }}
                  placeholder="输入昵称或唯一 ID 搜索用户"
                  className="h-9 flex-1 px-3 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong" />
                <button type="button" onClick={() => void doSearch()}
                  className="h-9 px-3 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold">搜索</button>
              </div>
              {results.length > 0 && (
                <div className="space-y-1">
                  {results.map((r) => (
                    <div key={r.user_id} className="flex items-center gap-2 px-2 py-1.5 rounded-xl bg-wb-bg-subtle text-2xs">
                      <span className="flex-1 truncate">{r.nickname} <span className="text-wb-text-muted">@{r.username}</span></span>
                      {r.online && <span className="text-wb-success">在线</span>}
                      <button type="button" onClick={() => void invite(r.user_id)}
                        className="px-2 py-1 rounded-capsule bg-wb-info text-white font-semibold">邀请</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="space-y-1 pt-1">
                <p className="text-3xs text-wb-text-muted">我的对局</p>
                {gameMatches.length === 0 && <p className="text-3xs text-wb-text-muted">暂无对局，搜个朋友开一局吧</p>}
                {gameMatches.slice(0, 8).map((m) => (
                  <div key={m.id} className="flex items-center gap-2 px-2 py-1.5 rounded-xl border border-wb-border-subtle text-2xs">
                    <span className="flex-1 truncate">
                      {m.inviter_id === myId ? `vs ${m.invitee_name || '对方'}` : `来自 ${m.inviter_name || '对方'}`}
                      <span className="text-wb-text-muted ml-1">
                        {m.status === 'pending' ? '待接受' : m.status === 'playing' ? '进行中' : '已结束'}
                      </span>
                    </span>
                    {m.invitee_id === myId && m.status === 'pending' && (
                      <>
                        <button onClick={() => { setSel(null); void respond(m, 'accept'); }} className="px-2 py-1 rounded-capsule bg-wb-success text-white">接受</button>
                        <button onClick={() => void respond(m, 'decline')} className="px-2 py-1 rounded-capsule bg-wb-bg-subtle">拒绝</button>
                      </>
                    )}
                    {(m.status === 'playing' || m.status === 'finished') && (
                      <button onClick={() => openMatch(m)} className="px-2 py-1 rounded-capsule bg-wb-bg-subtle">查看</button>
                    )}
                    {m.inviter_id === myId && m.status === "pending" && (
                      <button onClick={() => void respond(m, "cancel")} className="px-2 py-1 rounded-capsule bg-wb-bg-subtle">取消邀请</button>
                    )}
                    {m.status !== "playing" && m.status !== "pending" && (
                      <button onClick={() => void removeMatch(m)} title="删除这条对局记录"
                        className="px-2 py-1 rounded-capsule text-wb-danger hover:bg-wb-danger/10">删除</button>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-2xs flex-wrap">
                <span className="font-semibold">
                  {active.status === "finished" ? `对局结束（${active.result === "draw" ? "和棋" : active.winner_id === myId ? "你赢了" : "你输了"}）`
                    : active.status === "pending" ? "待接受"
                    : active.status !== "playing" ? "邀请已结束"
                    : myTurn ? `轮到你${isXiangqi ? `（${sideName(mySide)}）` : ""}` : "等待对方走棋"}
                </span>
                <span className="text-wb-text-muted">第 {active.move_seq} 手</span>
                {active.status === 'playing' && lastMove && (
                  <span
                    className={`px-1.5 py-0.5 rounded-capsule text-3xs font-semibold ${
                      lastMoveMine ? 'bg-wb-brand/10 text-wb-brand' : 'bg-wb-warn/15 text-wb-warn'
                    }`}
                    title={lastMoveMine ? '你最近一手已在棋盘上标记' : '对方最近一手正在高亮，落子后自动换到你的这一步'}
                  >
                    {lastMoveMine ? '你最近一手已标记' : '对方最近一手高亮中'}
                  </span>
                )}
                {isXiangqi && myId && active.status === 'playing' && (
                  <span className={`px-1.5 py-0.5 rounded-capsule text-3xs font-semibold ${turnSide === 'r' ? 'bg-wb-danger/10 text-wb-danger' : 'bg-wb-text-primary/10 text-wb-text-primary'}`}>
                    当前 {sideName(turnSide || 'r')} 走棋 · 你执{mySide === 'r' ? '红' : '黑'}
                  </span>
                )}
                {active.status === 'playing' && active.first_player_id && (
                  <span className="text-wb-text-muted">
                    本局{active.first_player_id === myId ? '你' : '对方'}先手
                  </span>
                )}
                <button onClick={() => openMatch(null)} className="ml-auto px-2 py-1 rounded-capsule bg-wb-bg-subtle">返回列表</button>
                {active.status === "pending" && active.invitee_id === myId && (
                  <>
                    <button onClick={() => void respond(active, "accept")} className="px-2 py-1 rounded-capsule bg-wb-success text-white">接受</button>
                    <button onClick={() => void respond(active, "decline")} className="px-2 py-1 rounded-capsule bg-wb-bg-subtle">拒绝</button>
                  </>
                )}
                {active.status === "pending" && active.inviter_id === myId && (
                  <button onClick={() => void respond(active, "cancel")} className="px-2 py-1 rounded-capsule bg-wb-bg-subtle">取消邀请</button>
                )}
                {active.status === 'playing' && (
                  <button onClick={() => void resign()} className="px-2 py-1 rounded-capsule text-wb-danger border border-wb-danger/30">认输</button>
                )}
              </div>

              {/* 互动提示条：双方都能看到同一条内容，发送方显示“你” */}
              {nudgeBanner && (
                <div
                  role="status"
                  className={`flex items-start gap-2 px-3 py-2 rounded-xl border text-xs animate-[wb-pop_.28s_ease-out] ${
                    nudgeBanner.kind === 'taunt'
                      ? 'bg-wb-warn/10 border-wb-warn/30 text-wb-warn'
                      : 'bg-wb-info/10 border-wb-info/30 text-wb-info'
                  }`}
                >
                  <span className="text-base leading-none">{nudgeBanner.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold truncate">
                      {nudgeBanner.mine ? '你' : nudgeBanner.from_name}：
                      <span className="font-normal">{nudgeBanner.text}</span>
                    </p>
                    <p className="text-3xs opacity-75 mt-0.5">
                      {nudgeBanner.mine ? '已提醒对手，等对方落子' : '对方在催你落子，轮到你了'}
                    </p>
                  </div>
                  <button type="button" onClick={() => setNudgeBanner(null)} aria-label="关闭提示"
                    className="shrink-0 p-0.5 rounded opacity-70 hover:opacity-100">✕</button>
                </div>
              )}

              {/* 催促入口：只有“等对方落子”的一方才出现，满 30s 才可点 */}
              {active.status === 'playing' && !myTurn && (
                <div className="flex items-center gap-2 flex-wrap text-3xs">
                  <span className="text-wb-text-muted">对方已思考 {Math.floor(idleSeconds)}s</span>
                  <div className="relative" ref={nudgeMenuRef}>
                    <button
                      type="button"
                      disabled={!canNudge}
                      onClick={() => setNudgeOpen((v) => !v)}
                      aria-haspopup="menu"
                      aria-expanded={nudgeOpen}
                      title={
                        canNudge
                          ? '催一催对手 / 发表情'
                          : cooldownLeft > 0
                            ? `刚刚提醒过，${cooldownLeft}s 后可再提醒`
                            : `对方思考满 ${nudgeIdleNeed}s 后可提醒`
                      }
                      className={`h-7 px-2.5 rounded-capsule text-2xs font-semibold border transition-colors ${
                        canNudge
                          ? 'bg-wb-warn/10 text-wb-warn border-wb-warn/30 hover:bg-wb-warn/20'
                          : 'bg-wb-bg-subtle text-wb-text-muted border-wb-border-subtle'
                      }`}
                    >
                      {cooldownLeft > 0 ? `冷却 ${cooldownLeft}s` : '催一催'}
                      <span className="ml-1">▾</span>
                    </button>
                    {nudgeOpen && (
                      <div
                        role="menu"
                        className="absolute bottom-full left-0 mb-1.5 z-30 w-60 max-h-[46vh] overflow-y-auto p-1.5 rounded-xl bg-wb-bg-surface border border-wb-border-strong shadow-2xl space-y-1"
                      >
                        {nudgePresets.length === 0 && (
                          <p className="px-1.5 py-1 text-3xs text-wb-text-muted">互动文案加载中…</p>
                        )}
                        {(['remind', 'taunt'] as const).map((kind) => {
                          const items = nudgePresets.filter((p) => p.kind === kind);
                          if (!items.length) return null;
                          return (
                            <div key={kind}>
                              <p className="px-1.5 pt-1 pb-0.5 text-[10px] font-semibold text-wb-text-muted">
                                {kind === 'remind' ? '提醒' : '嘲讽'}
                              </p>
                              {items.map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  role="menuitem"
                                  disabled={nudging}
                                  onClick={() => void sendNudge(p.id)}
                                  className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-lg text-2xs text-left text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle disabled:opacity-50"
                                >
                                  <span className="text-sm">{p.emoji}</span>
                                  <span className="truncate">{p.text}</span>
                                </button>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {cooldownLeft > 0 && <span className="text-wb-text-muted">刚刚提醒过，稍等一下</span>}
                </div>
              )}

              {/* 本局互动记录：最多 5 条，双方的内容都在这里 */}
              {nudgeHistory.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {nudgeHistory.map((h, i) => (
                    <span
                      key={`${h.at}-${i}`}
                      className="px-1.5 py-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-[10px] text-wb-text-muted"
                    >
                      {h.emoji} {h.mine ? '你' : h.from_name}：{h.text}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'practice' && (
        <p className="text-3xs text-wb-text-muted">
          练习模式只在本地运行，不产生对局记录、不计分、不进任何榜。{isXiangqi && '你执红（下方），AI 执黑（上方）。'}
          {isXiangqi && aiThinking && <span className="ml-1 font-semibold text-wb-brand">AI 正在思考…</span>}
          {isXiangqi && !aiThinking && aiInfo && <span className="ml-1 font-mono text-wb-text-muted">{aiInfo}</span>}
          {practice.winner && <span className="ml-1 font-semibold text-wb-text-primary">{practice.winner}</span>}
        </p>
      )}

      {(mode === 'practice' || active?.status === 'playing' || active?.status === 'finished') && (
        <>
        <div className="rounded-2xl border border-wb-border-subtle bg-wb-bg-surface p-2 overflow-x-auto">
          {isXiangqi ? (
            <ChineseChessBoard
              cells={cells}
              onCell={onCell}
              selected={sel}
              flipped={flipped}
              turnSide={turnSide}
              lastMove={lastMove}
              highlightMine={lastMoveMine}
            />
          ) : (
            <div className="grid gap-0 mx-auto rounded-lg overflow-hidden border-2 border-wb-border-strong" style={{
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              width: isTicTacToe ? 260 : 420,
              background: '#e8c98f',
            }}>
              {Array.from({ length: rows * cols }, (_, i) => {
                const x = i % cols, y = Math.floor(i / cols);
                const v = cells[`${x},${y}`];
                const selected = sel && sel[0] === x && sel[1] === y;
                const isLast = Boolean(lastMove && lastMove.x === x && lastMove.y === y);
                return (
                  <button key={`${x},${y}`} type="button" onClick={() => onCell(x, y)}
                    className={`relative aspect-square flex items-center justify-center font-bold border border-wb-text-muted/50 rounded-none transition-colors ${selected ? 'bg-wb-info/30' : 'bg-wb-bg-subtle/40 hover:bg-wb-bg-page'}`}>
                    {isTicTacToe ? (
                      v ? <span className={`text-2xl font-black ${v === 1 ? 'text-wb-brand' : 'text-wb-danger'}`}>{v === 1 ? 'X' : 'O'}</span> : null
                    ) : (
                      v ? <span className={`w-3/4 h-3/4 rounded-full shadow-md border-2 ${v === 1 ? 'bg-wb-text-primary border-wb-text-secondary' : 'bg-wb-bg-page border-wb-border-strong'}`} /> : null
                    )}
                    {/* 最近一手：对方落子闪 3 次后保持静态，直到自己落子；自己的落子短闪一次 */}
                    {isLast && (
                      <span key={lastMoveKey} className="pointer-events-none absolute inset-0">
                        <span
                          className={`absolute inset-[8%] rounded-[4px] border-2 ${
                            lastMoveMine ? 'border-wb-brand' : 'border-wb-warn'
                          } ${
                            lastMoveMine
                              ? 'animate-[battle-lastmove_.45s_ease-out_1]'
                              : 'animate-[battle-lastmove_.55s_ease-in-out_3]'
                          }`}
                        />
                        {!lastMoveMine && (
                          <span className="absolute right-1 bottom-1 w-1.5 h-1.5 rounded-full bg-wb-warn" />
                        )}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 高亮图例：让双方都能确认“这圈标记是谁的哪一步” */}
        {mode === 'online' && lastMove && active && (
          <p aria-live="polite" className="text-3xs text-wb-text-muted flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 rounded-full ${lastMoveMine ? 'bg-wb-brand' : 'bg-wb-warn'}`} />
            {lastMoveMine
              ? `你最近一手落点已标记（第 ${lastMove.seq} 手）`
              : `对方最近一手落点高亮中（第 ${lastMove.seq} 手），你落子后自动切到你的这一步`}
          </p>
        )}
        </>
      )}

      {/* 嘲讽卡片：当面闪出，pointer-events-none，不挡棋盘操作 */}
      {nudgeCard && createPortal(
        <div className="pointer-events-none fixed inset-0 z-[230] flex items-center justify-center p-4">
          <div className="battle-card battle-card--taunt battle-taunt-pop">
            <div className="battle-card__inner">
              <span className="battle-card__emoji">{nudgeCard.emoji}</span>
              <p className="text-[10px] font-mono tracking-[0.28em] opacity-60">TAUNT · 棋局嘲讽</p>
              <h3 className="text-lg font-black mt-1 leading-snug">{nudgeCard.text}</h3>
              <p className="text-2xs opacity-70 mt-2">
                {nudgeCard.mine ? '你朝对手丢出了一张嘲讽卡' : `${nudgeCard.from_name} 朝你丢来一张嘲讽卡`}
              </p>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 胜负卡片：与每日求签卡片同一套视觉语言，双方各自看到胜利/失败 */}
      {resultCard && createPortal(
        <div
          className="fixed inset-0 z-[240] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4"
          onClick={() => setResultCard(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={resultTitle}
            className={`battle-card battle-result-pop ${resultClass}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="battle-card__inner">
              <p className="text-[10px] font-mono tracking-[0.3em] opacity-60">BATTLE RESULT</p>
              <span className="battle-card__emoji">{resultEmoji}</span>
              <h3 className="text-2xl font-black">{resultTitle}</h3>
              <p className="text-2xs opacity-80 mt-1">{resultSubtitle}</p>
              <p className="text-3xs opacity-60 mt-2">
                {GAME_LABELS[resultCard.game_code] || '棋局'} · 第 {resultCard.move_seq} 手
                {resultOpponent ? ` · 对手 ${resultOpponent}` : ''}
              </p>
              <div className="flex items-center justify-center gap-2 mt-4">
                <button
                  type="button"
                  onClick={() => void rematch()}
                  className="h-9 px-4 rounded-capsule bg-[#23262b] text-white text-xs font-bold"
                >
                  再来一局
                </button>
                <button
                  type="button"
                  onClick={() => setResultCard(null)}
                  className="h-9 px-4 rounded-capsule bg-black/5 text-[#23262b] text-xs font-semibold border border-black/10"
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
