import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bug, RotateCcw, Trophy } from 'lucide-react';

export interface MiniGameProps {
  onScore: (score: number) => void;
}

const BEST_PREFIX = 'wb:404:best:';

const readBest = (game: string) => {
  try { return Number(localStorage.getItem(BEST_PREFIX + game) || '0'); } catch { return 0; }
};
const writeBest = (game: string, score: number) => {
  try {
    if (score > readBest(game)) localStorage.setItem(BEST_PREFIX + game, String(score));
  } catch {}
};

/** 捉 Bug：30 秒内点掉尽可能多的 bug。 */
export const BugCatch: React.FC<MiniGameProps> = ({ onScore }) => {
  const BUGS = ['🐛', '🕷️', '👾', '🦟', '🪲'];
  const [phase, setPhase] = useState<'idle' | 'playing' | 'over'>('idle');
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(() => readBest('bugcatch'));
  const [timeLeft, setTimeLeft] = useState(30);
  const [moles, setMoles] = useState<{ cell: number; icon: string; id: number }[]>([]);
  const seqRef = useRef(0);
  const timeLeftRef = useRef(30);
  const timersRef = useRef<number[]>([]);

  useEffect(() => { timeLeftRef.current = timeLeft; }, [timeLeft]);

  const clearTimers = () => {
    timersRef.current.forEach((t) => { window.clearTimeout(t); window.clearInterval(t); });
    timersRef.current = [];
  };

  const start = () => {
    clearTimers();
    setScore(0); setTimeLeft(30); timeLeftRef.current = 30; setMoles([]); setPhase('playing');
    const tick = window.setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          window.clearInterval(tick);
          setPhase('over');
          setMoles([]);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    timersRef.current.push(tick);
  };

  // 难度曲线：前 10 秒只有零星几只、存活久；之后逐步变密变快
  useEffect(() => {
    if (phase !== 'playing') return;
    let cancelled = false;
    let timer = 0;

    const spawnOnce = () => {
      const elapsed = Math.max(0, 30 - timeLeftRef.current);
      const life = Math.max(780, 1500 - elapsed * 24);
      const maxAlive = elapsed < 10 ? 2 : elapsed < 20 ? 3 : 4;
      setMoles((prev) => {
        const alive = new Set(prev.map((m) => m.cell));
        const empty = Array.from({ length: 9 }, (_, i) => i).filter((i) => !alive.has(i));
        if (!empty.length || prev.length >= maxAlive) return prev;
        const cell = empty[Math.floor(Math.random() * empty.length)];
        seqRef.current += 1;
        const id = seqRef.current;
        const t = window.setTimeout(() => setMoles((cur) => cur.filter((m) => m.id !== id)), life);
        timersRef.current.push(t);
        return [...prev, { cell, icon: BUGS[Math.floor(Math.random() * BUGS.length)], id }];
      });
    };

    const loop = () => {
      if (cancelled) return;
      const elapsed = Math.max(0, 30 - timeLeftRef.current);
      const interval = elapsed < 10 ? 1150 : elapsed < 20 ? 880 : 660;
      timer = window.setTimeout(() => {
        spawnOnce();
        loop();
      }, interval);
    };
    loop();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase]);

  useEffect(() => {
    if (phase === 'over') {
      setBest((b) => Math.max(b, score));
      writeBest('bugcatch', score);
      onScore(score);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => () => clearTimers(), []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-2xs font-mono">
        <span className="flex items-center gap-1 text-wb-text-secondary"><Bug className="w-3.5 h-3.5" /> 已抓 <b className="text-wb-text-primary">{score}</b></span>
        <span className="flex items-center gap-1 text-wb-text-muted"><Trophy className="w-3.5 h-3.5" /> 最高 {best}</span>
        <span className={timeLeft <= 5 && phase === 'playing' ? 'text-wb-danger font-bold' : 'text-wb-text-muted'}>
          {phase === 'idle' ? '30s' : `${timeLeft}s`}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 9 }).map((_, i) => {
          const mole = moles.find((m) => m.cell === i);
          return (
            <button
              key={i}
              type="button"
              aria-label={mole ? '抓住它' : '空格子'}
              onClick={() => {
                if (!mole) return;
                setMoles((prev) => prev.filter((m) => m.id !== mole.id));
                setScore((s) => s + 1);
              }}
              className={`aspect-square rounded-2xl border transition-all flex items-center justify-center text-2xl select-none ${
                mole ? 'bg-wb-warn/15 border-wb-warn/40 scale-105 cursor-pointer' : 'bg-wb-bg-subtle/60 border-wb-border-subtle'
              }`}
            >
              <span className={mole ? 'animate-bounce' : 'opacity-0'}>{mole?.icon || '🐛'}</span>
            </button>
          );
        })}
      </div>
      {phase === 'playing' ? (
        <p className="text-3xs text-wb-text-muted text-center">点击出现的 Bug，30 秒看你能抓几只</p>
      ) : phase === 'over' ? (
        <div className="text-center space-y-2">
          <p className="text-xs font-semibold">本轮 {score} 只</p>
          <button type="button" onClick={start} className="inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-semibold">
            <RotateCcw className="w-3.5 h-3.5" /> 再来一局
          </button>
        </div>
      ) : (
        <button type="button" onClick={start} className="w-full py-2.5 min-h-[44px] rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-semibold">
          开始抓 Bug
        </button>
      )}
    </div>
  );
};

/* ------------------------------- 2048 ------------------------------- */

type Board = number[][];

const emptyBoard = (): Board => Array.from({ length: 4 }, () => [0, 0, 0, 0]);

const addRandom = (board: Board): Board => {
  const empty: [number, number][] = [];
  board.forEach((row, r) => row.forEach((v, c) => { if (!v) empty.push([r, c]); }));
  if (!empty.length) return board;
  const [r, c] = empty[Math.floor(Math.random() * empty.length)];
  const next = board.map((row) => [...row]);
  next[r][c] = Math.random() < 0.9 ? 2 : 4;
  return next;
};

const slideRow = (row: number[]): { row: number[]; gained: number } => {
  const vals = row.filter(Boolean);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === vals[i + 1]) {
      out.push(vals[i] * 2);
      gained += vals[i] * 2;
      i++;
    } else {
      out.push(vals[i]);
    }
  }
  while (out.length < 4) out.push(0);
  return { row: out, gained };
};

const transpose = (b: Board): Board => b[0].map((_, c) => b.map((row) => row[c]));

const rotate = (b: Board): Board => transpose(b).map((row) => [...row].reverse());

const moveBoard = (board: Board, dir: 'left' | 'right' | 'up' | 'down') => {
  let work = board.map((r) => [...r]);
  let turns = 0;
  if (dir === 'right') turns = 2;
  if (dir === 'up') turns = 1;
  if (dir === 'down') turns = 3;
  for (let i = 0; i < turns; i++) work = rotate(work);

  let gained = 0;
  let changed = false;
  work = work.map((row) => {
    const r = slideRow(row);
    gained += r.gained;
    if (r.row.some((v, i) => v !== row[i])) changed = true;
    return r.row;
  });

  for (let i = 0; i < (4 - turns) % 4; i++) work = rotate(work);
  return { board: work, gained, changed };
};

const canMove = (b: Board) =>
  b.some((row) => row.includes(0)) ||
  b.some((row, r) => row.some((v, c) => (c < 3 && v === row[c + 1]) || (r < 3 && v === b[r + 1][c])));

// 高对比配色：浅色/深色主题下都能一眼看清数字
const TILE_STYLE: Record<number, string> = {
  2: 'bg-slate-200 text-slate-900',
  4: 'bg-slate-300 text-slate-900',
  8: 'bg-sky-300 text-sky-950',
  16: 'bg-sky-400 text-white',
  32: 'bg-teal-400 text-white',
  64: 'bg-emerald-500 text-white',
  128: 'bg-amber-400 text-amber-950',
  256: 'bg-orange-500 text-white',
  512: 'bg-rose-500 text-white',
  1024: 'bg-fuchsia-600 text-white',
  2048: 'bg-violet-600 text-white',
};

/** 数字迷途：2048。 */
export const Game2048: React.FC<MiniGameProps> = ({ onScore }) => {
  const [board, setBoard] = useState<Board>(() => addRandom(addRandom(emptyBoard())));
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);
  const best = useMemo(() => readBest('2048'), []);
  const touchRef = useRef<{ x: number; y: number } | null>(null);

  const reset = () => {
    setBoard(addRandom(addRandom(emptyBoard())));
    setScore(0);
    setOver(false);
  };

  const step = useCallback((dir: 'left' | 'right' | 'up' | 'down') => {
    setBoard((prev) => {
      const { board: moved, gained, changed } = moveBoard(prev, dir);
      if (!changed) return prev;
      const next = addRandom(moved);
      setScore((s) => s + gained);
      if (!canMove(next)) {
        setOver(true);
        onScore(score + gained);
        writeBest('2048', score + gained);
      }
      return next;
    });
  }, [onScore, score]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, 'left' | 'right' | 'up' | 'down'> = {
        ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
        a: 'left', d: 'right', w: 'up', s: 'down',
      };
      const dir = map[e.key];
      if (!dir || over) return;
      e.preventDefault();
      step(dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, over]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-2xs font-mono">
        <span className="text-wb-text-secondary">分数 <b className="text-wb-text-primary">{score}</b></span>
        <span className="text-wb-text-muted">最高 {Math.max(best, score)}</span>
      </div>

      <div
        className="grid grid-cols-4 gap-2 p-2 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle touch-none"
        onTouchStart={(e) => { const t = e.touches[0]; touchRef.current = { x: t.clientX, y: t.clientY }; }}
        onTouchEnd={(e) => {
          const start = touchRef.current;
          if (!start) return;
          const t = e.changedTouches[0];
          const dx = t.clientX - start.x;
          const dy = t.clientY - start.y;
          if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
          step(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
        }}
      >
        {board.flat().map((v, i) => (
          <div
            key={i}
            className={`aspect-square rounded-xl flex items-center justify-center font-black tracking-tight transition-all border ${
              v
                ? `${TILE_STYLE[v] || 'bg-violet-600 text-white'} border-black/10 shadow-sm ${
                    v >= 1000 ? 'text-sm sm:text-base' : v >= 100 ? 'text-base sm:text-lg' : 'text-lg sm:text-xl'
                  }`
                : 'bg-wb-bg-subtle/50 border-wb-border-subtle'
            }`}
          >
            {v || ''}
          </div>
        ))}
      </div>

      <p className="text-3xs text-wb-text-muted text-center">方向键 / WASD / 滑动合并相同数字</p>
      {over ? (
        <div className="text-center space-y-2">
          <p className="text-xs font-semibold">无路可走，本轮 {score} 分</p>
          <button type="button" onClick={reset} className="inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-semibold">
            <RotateCcw className="w-3.5 h-3.5" /> 再来一局
          </button>
        </div>
      ) : (
        <button type="button" onClick={reset} className="w-full py-2 min-h-[40px] rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-semibold text-wb-text-secondary">
          重新开始
        </button>
      )}
    </div>
  );
};
