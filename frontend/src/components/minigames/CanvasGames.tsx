import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, RotateCcw, Play } from 'lucide-react';

const BEST_PREFIX = 'wb:404:best:';
const readBest = (g: string) => {
  try { return Number(localStorage.getItem(BEST_PREFIX + g) || '0'); } catch { return 0; }
};
const writeBest = (g: string, s: number) => {
  try { if (s > readBest(g)) localStorage.setItem(BEST_PREFIX + g, String(s)); } catch {}
};

/* ----------------------------- 碎片贪吃蛇 ----------------------------- */

const CELL = 16;
const COLS = 24;
const ROWS = 14;

const DIRECTIONS = {
  ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
};
const WASD: Record<string, keyof typeof DIRECTIONS> = { w: 'ArrowUp', s: 'ArrowDown', a: 'ArrowLeft', d: 'ArrowRight' };
const SNAKE_CONTROLS = [
  { key: 'ArrowLeft', label: '向左', Icon: ArrowLeft },
  { key: 'ArrowUp', label: '向上', Icon: ArrowUp },
  { key: 'ArrowDown', label: '向下', Icon: ArrowDown },
  { key: 'ArrowRight', label: '向右', Icon: ArrowRight },
] as const;

type SnakeProps = {
  onRoundStart: () => Promise<void>;
  onScore: (score: number, durationMs: number, won: boolean) => void;
};

export const Snake: React.FC<SnakeProps> = ({ onRoundStart, onScore }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'playing' | 'over'>('idle');
  const starting = useRef(false);
  const mounted = useRef(false);
  const startedAt = useRef(0);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(() => readBest('snake'));
  const stateRef = useRef({
    snake: [{ x: 6, y: 7 }],
    dir: { x: 1, y: 0 },
    next: { x: 1, y: 0 },
    food: { x: 15, y: 7 },
    dead: false,
  });
  const timerRef = useRef<number>(0);

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const st = stateRef.current;

    ctx.fillStyle = '#0f1116';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let x = 0; x <= COLS; x++) {
      ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, ROWS * CELL); ctx.stroke();
    }
    for (let y = 0; y <= ROWS; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(COLS * CELL, y * CELL); ctx.stroke();
    }

    // 食物
    ctx.fillStyle = '#f2b95c';
    ctx.fillRect(st.food.x * CELL + 2, st.food.y * CELL + 2, CELL - 4, CELL - 4);

    // 蛇
    st.snake.forEach((seg, i) => {
      ctx.fillStyle = i === 0 ? '#7ee787' : 'rgba(126,231,135,0.65)';
      ctx.fillRect(seg.x * CELL + 1, seg.y * CELL + 1, CELL - 2, CELL - 2);
    });
  };

  const tick = useCallback(() => {
    const st = stateRef.current;
    st.dir = st.next;
    const head = { x: st.snake[0].x + st.dir.x, y: st.snake[0].y + st.dir.y };

    const eat = head.x === st.food.x && head.y === st.food.y;
    const body = eat ? st.snake : st.snake.slice(0, -1);
    const collided = head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS ||
      body.some((s) => s.x === head.x && s.y === head.y);
    if (!collided) st.snake = [head, ...body];
    if (collided || st.snake.length === COLS * ROWS) {
      st.dead = collided;
      window.clearInterval(timerRef.current);
      setPhase('over');
      const final = st.snake.length - 1;
      setScore(final);
      writeBest('snake', final);
      setBest((previous) => Math.max(previous, final));
      if (!collided) draw();
      onScore(final, Math.max(1, Math.round(performance.now() - startedAt.current)), !collided);
      return;
    }

    if (eat) {
      let fx = 0, fy = 0;
      do {
        fx = Math.floor(Math.random() * COLS);
        fy = Math.floor(Math.random() * ROWS);
      } while (st.snake.some((s) => s.x === fx && s.y === fy));
      st.food = { x: fx, y: fy };
    }
    setScore(st.snake.length - 1);
    draw();
  }, [onScore]);

  const start = async () => {
    if (starting.current) return;
    starting.current = true;
    setPhase('starting');
    await onRoundStart();
    starting.current = false;
    if (!mounted.current) return;
    startedAt.current = performance.now();
    stateRef.current = {
      snake: [{ x: 6, y: 7 }],
      dir: { x: 1, y: 0 },
      next: { x: 1, y: 0 },
      food: { x: 15, y: 7 },
      dead: false,
    };
    setScore(0);
    setPhase('playing');
    window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(tick, 130);
    tick();
  };

  const changeDirection = useCallback((key: keyof typeof DIRECTIONS) => {
    const st = stateRef.current;
    const next = DIRECTIONS[key];
    if (st.dir.x + next.x === 0 && st.dir.y + next.y === 0) return;
    st.next = next;
  }, []);

  useEffect(() => {
    if (phase !== 'playing') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const direction = Object.hasOwn(DIRECTIONS, e.key) ? e.key as keyof typeof DIRECTIONS : WASD[e.key.toLowerCase()];
      if (!direction) return;
      e.preventDefault();
      changeDirection(direction);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [changeDirection, phase]);

  useEffect(() => {
    mounted.current = true;
    draw();
    return () => {
      mounted.current = false;
      window.clearInterval(timerRef.current);
    };
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-2xs font-mono">
        <span className="text-wb-text-secondary">长度 <b className="text-wb-text-primary">{score + 1}</b></span>
        <span className="text-wb-text-muted">最高 {Math.max(best, score) + 1}</span>
      </div>

      <canvas
        ref={canvasRef}
        width={COLS * CELL}
        height={ROWS * CELL}
        className="w-full rounded-2xl border border-wb-border-subtle touch-none"
      />

      <p className="text-3xs text-wb-text-muted text-center">方向键、WASD 或屏幕方向按钮控制，吃黄色碎片变长</p>

      {phase === 'playing' && (
        <div role="group" aria-label="贪吃蛇方向控制" className="flex justify-center gap-2">
          {SNAKE_CONTROLS.map(({ key, label, Icon }) => (
            <button key={key} type="button" aria-label={label} onClick={() => changeDirection(key)}
              className="inline-flex size-11 touch-manipulation items-center justify-center rounded-xl border border-wb-border-subtle bg-wb-bg-subtle focus-visible:outline focus-visible:outline-wb-brand">
              <Icon className="size-4" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      {phase === 'over' ? (
        <div className="text-center space-y-2">
          <p className="text-xs font-semibold">{stateRef.current.dead ? '撞上了' : '棋盘已填满'}，长度 {score + 1}</p>
          <button type="button" onClick={start} className="inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-semibold">
            <RotateCcw className="w-3.5 h-3.5" /> 再来一局
          </button>
        </div>
      ) : phase === 'idle' ? (
        <button type="button" onClick={start} className="w-full py-2.5 min-h-[44px] rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-semibold inline-flex items-center justify-center gap-1.5">
          <Play className="w-3.5 h-3.5" /> 开始吞噬
        </button>
      ) : (
        <p className="text-3xs text-wb-text-muted text-center">{phase === 'starting' ? '正在开局…' : '正在进行…'}</p>
      )}
    </div>
  );
};
