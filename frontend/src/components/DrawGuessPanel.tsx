import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Brush, Clock, Eraser, History, Lightbulb, Loader2, Play, Send, Trophy, Undo2, Users } from 'lucide-react';
import { apiClient } from '../api/client';

interface Point {
  x: number;
  y: number;
}

interface Stroke {
  color: string;
  width: number;
  points: Point[];
}

interface BoardSummary {
  board_id: string;
  drawer_name: string | null;
  status: 'drawing' | 'finished';
  participant_count: number;
  ends_at: number | null;
}

interface DrawGuessState {
  board_id: string;
  round_id: string | null;
  status: BoardSummary['status'];
  drawer_name: string | null;
  answer: string | null;
  hint: string | null;
  answer_length: number | null;
  ends_at: number | null;
  server_time: number;
  canvas_version: number;
  strokes: Stroke[];
  winner_name: string | null;
  joined: boolean;
  can_end: boolean;
  ended_reason: 'guessed' | 'manual' | 'timeout' | 'all_guessed' | null;
  round_no?: number;
  duration_seconds?: number;
  is_drawer?: boolean;
  my_guessed?: boolean;
  guessed_names?: string[];
  answer_mask?: string | null;
  hint_revealed?: number;
  hint_requests?: string[];
  can_request_hint?: boolean;
  can_reveal_hint?: boolean;
  guesses: { user_id: string; name: string | null; text: string; ts: number; correct: boolean }[];
  scores: { user_id: string; name: string | null; score: number }[];
}

interface GroupExpReward {
  exp_gained: number;
  group_level: number;
  level_up: boolean;
  daily_exp_left: number;
}

type GuessResponse = DrawGuessState & Partial<GroupExpReward>;

interface ActiveStroke extends Stroke {
  roundId: string;
  canvasVersion: number;
  uploadedThrough: number;
}

interface Props {
  roomId: string;
  onGroupExp: (data: GroupExpReward) => void;
}

const LOGICAL_WIDTH = 1600;
const LOGICAL_HEIGHT = 1000;
const STROKE_BATCH_SIZE = 32;
const POLL_INTERVAL_MS = 1000;
const HISTORY_LIMIT = 50;
const ROUND_DURATIONS = [30, 60, 90, 120, 180, 300];
const ROUND_PRESETS = [
  { label: '闪电局', duration: 60, custom: false, category: 'everyday' as const, detail: '60 秒 · 日常主题' },
  { label: '标准局', duration: 120, custom: false, category: null, detail: '120 秒 · 不限主题' },
  { label: '自出题', duration: 180, custom: true, category: null, detail: '180 秒 · 自定义题目' },
];
const DRAW_CATEGORIES = [
  { value: 'everyday', label: '日常生活' },
  { value: 'nature', label: '自然动物' },
  { value: 'adventure', label: '奇妙冒险' },
] as const;
const MAX_ANSWER_LENGTH = 8;
const MAX_HINT_LENGTH = 30;
const PALETTE = ['#111827', '#EF4444', '#F97316', '#EAB308', '#22C55E', '#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899', '#FFFFFF'];

const strokeSignature = (stroke: Stroke) => [
  stroke.color.toLowerCase(),
  Number(stroke.width).toFixed(2),
  stroke.points.map((point) => `${Number(point.x).toFixed(5)},${Number(point.y).toFixed(5)}`).join(';'),
].join('|');

const errorMessage = (error: unknown): string => {
  const response = (error as { response?: { status?: number; data?: { detail?: unknown; message?: unknown } } })?.response;
  if (response?.status === 403) return '你需要是该群成员才能参与游戏。';
  if (response?.status === 404) return '未找到该群或游戏房间。';
  if (response?.status === 409) return '回合或画板已更新，已重新同步。';
  const detail = response?.data?.detail ?? response?.data?.message;
  if (typeof detail === 'string' && detail.length < 180) return detail;
  if (detail && typeof detail === 'object' && 'msg' in detail && typeof detail.msg === 'string') return detail.msg;
  return '操作失败，请检查网络后重试。';
};

export const DrawGuessPanel: React.FC<Props> = ({ roomId, onGroupExp }) => {
  const endpoint = `/chat/groups/${encodeURIComponent(roomId)}/draw-guess/boards`;
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [view, setView] = useState<'drawing' | 'finished'>('drawing');
  const [selected, setSelected] = useState<{ id: string; initial?: DrawGuessState } | null>(null);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [duration, setDuration] = useState(120);
  const [customAnswer, setCustomAnswer] = useState(false);
  const [category, setCategory] = useState<(typeof DRAW_CATEGORIES)[number]['value'] | null>(null);
  const [answer, setAnswer] = useState('');
  const [hint, setHint] = useState('');
  const [listError, setListError] = useState('');
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const poll = async () => {
      const { signal } = controller;
      try {
        const { data } = await apiClient.get<{ boards: BoardSummary[] }>(endpoint, { signal });
        if (signal.aborted) return;
        setBoards(data.boards);
        setListError('');
      } catch (error) {
        if (!signal.aborted) setListError(errorMessage(error));
      } finally {
        if (!signal.aborted) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [endpoint]);

  const cleanAnswer = answer.trim();
  const cleanHint = hint.trim();
  const invalidAnswer = customAnswer && (!cleanAnswer || [...cleanAnswer].length > MAX_ANSWER_LENGTH);
  const invalidHint = [...cleanHint].length > MAX_HINT_LENGTH;

  const handleCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creating || invalidAnswer || invalidHint) return;
    setCreating(true);
    setCreateError('');
    try {
      const { data } = await apiClient.post<DrawGuessState>(endpoint, {
        duration_seconds: duration,
        ...(customAnswer ? { answer: cleanAnswer } : category ? { category } : {}),
        ...(cleanHint ? { hint: cleanHint } : {}),
      });
      setShowCreate(false);
      setAnswer('');
      setHint('');
      setView('drawing');
      setSelected({ id: data.board_id, initial: data });
    } catch (error) {
      setCreateError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  const activeBoards = boards?.filter(board => board.status === 'drawing');
  const historyBoards = boards?.filter(board => board.status === 'finished').slice(0, HISTORY_LIMIT);
  const visibleBoards = view === 'drawing' ? activeBoards : historyBoards;

  if (selected) {
    return <DrawGuessBoard key={selected.id} boardId={selected.id} endpoint={`${endpoint}/${encodeURIComponent(selected.id)}`}
      initial={selected.initial} onBack={() => setSelected(null)} onGroupExp={onGroupExp} />;
  }

  return (
    <section className="mx-auto w-full max-w-4xl space-y-4 text-wb-text-primary">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-wb-border-subtle px-1 pb-4 sm:px-0">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-wb-brand/10 text-wb-brand"><Brush className="h-6 w-6" aria-hidden="true" /></span>
          <div className="min-w-0">
            <h4 className="text-lg font-bold">画板大厅</h4>
            <p className="mt-0.5 text-xs text-wb-text-secondary">{activeBoards ? `${activeBoards.length} 局正在进行` : '群内限时画猜'}</p>
          </div>
        </div>
        <button type="button" aria-expanded={showCreate} onClick={() => { setCreateError(''); setShowCreate((open) => !open); }} disabled={creating}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-wb-brand px-3 text-xs font-semibold text-white disabled:opacity-50">
          <Play className="h-4 w-4" aria-hidden="true" />{showCreate ? '收起开局设置' : '创建画板'}
        </button>
      </header>
      {showCreate && (
        <form onSubmit={(event) => void handleCreate(event)} className="grid gap-4 rounded-xl border border-wb-border-subtle bg-wb-bg-surface p-4 sm:grid-cols-2">
          <fieldset disabled={creating} className="min-w-0 sm:col-span-2">
            <legend className="mb-2 text-xs font-semibold">玩法预设</legend>
            <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
              {ROUND_PRESETS.map(preset => {
                const matches = preset.duration === duration && preset.custom === customAnswer && (preset.custom || preset.category === category);
                return <button key={preset.label} type="button" aria-pressed={matches} onClick={() => {
                  setDuration(preset.duration);
                  setCustomAnswer(preset.custom);
                  if (!preset.custom) setCategory(preset.category);
                }}
                  className={`min-w-0 rounded-lg border px-1.5 py-2.5 text-left hover:bg-wb-bg-subtle sm:px-3 ${matches ? 'border-wb-brand/40 bg-wb-brand/10' : 'border-wb-border-subtle'}`}>
                  <span className={`block text-xs font-semibold ${matches ? 'text-wb-brand' : ''}`}>{preset.label}</span>
                  <span className="mt-0.5 block text-2xs leading-relaxed text-wb-text-secondary">{preset.detail}</span>
                </button>;
              })}
            </div>
          </fieldset>
          <label className="grid gap-1.5 text-xs font-semibold">
            回合时长
            <select value={duration} onChange={(event) => setDuration(Number(event.target.value))} disabled={creating}
              className="h-10 w-full rounded-lg border border-wb-border-subtle bg-wb-bg-page px-3 text-base sm:text-sm">
              {ROUND_DURATIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒</option>)}
            </select>
          </label>
          <fieldset disabled={creating} className="min-w-0">
            <legend className="mb-1.5 text-xs font-semibold">题目来源</legend>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-wb-border-subtle bg-wb-bg-page p-1">
              {[{ value: false, label: '随机题目' }, { value: true, label: '自定义题目' }].map(({ value, label }) => (
                <label key={label} className={`rounded-md text-center text-xs ${customAnswer === value ? 'bg-wb-brand font-semibold text-white' : 'text-wb-text-secondary'}`}>
                  <input type="radio" name="draw-guess-source" checked={customAnswer === value} onChange={() => setCustomAnswer(value)} className="peer sr-only" />
                  <span className="block cursor-pointer rounded-md px-2 py-2 peer-focus-visible:outline peer-focus-visible:outline-wb-brand">{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {customAnswer ? (
            <label className="grid min-w-0 gap-1.5 text-xs font-semibold">
              自定义题目（1–8 字）
              <input value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={creating} required autoComplete="off"
                aria-invalid={invalidAnswer && !!answer} placeholder="仅画手可见"
                className="min-h-10 rounded-lg border border-wb-border-subtle bg-wb-bg-page px-3 text-base font-normal sm:text-sm" />
              {invalidAnswer && !!answer && <span className="text-wb-danger">请输入 1–8 字的题目。</span>}
            </label>
          ) : (
            <label className="grid min-w-0 gap-1.5 text-xs font-semibold">
              随机主题
              <select value={category ?? ''} onChange={(event) => setCategory(DRAW_CATEGORIES.find(option => option.value === event.target.value)?.value ?? null)} disabled={creating}
                className="h-10 w-full rounded-lg border border-wb-border-subtle bg-wb-bg-page px-3 text-base font-normal sm:text-sm">
                <option value="">不限主题</option>
                {DRAW_CATEGORIES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          )}
          <label className="grid min-w-0 gap-1.5 text-xs font-semibold">
            提示（可选，最多 30 字）
            <input value={hint} onChange={(event) => setHint(event.target.value)} disabled={creating} autoComplete="off"
              aria-invalid={invalidHint} placeholder="群友可见，请不要写出答案"
              className="min-h-10 rounded-lg border border-wb-border-subtle bg-wb-bg-page px-3 text-base font-normal sm:text-sm" />
            {invalidHint && <span className="text-wb-danger">提示不能超过 30 字。</span>}
          </label>
          <div className="flex items-center justify-end gap-3 sm:col-span-2">
            {createError && <p role="alert" className="mr-auto text-xs text-wb-danger">{createError}</p>}
            <button type="submit" disabled={creating || invalidAnswer || invalidHint}
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-wb-brand px-4 text-xs font-semibold text-white disabled:opacity-50">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}开始游戏
            </button>
          </div>
        </form>
      )}
      <nav aria-label="画板视图" className="grid grid-cols-2 gap-1 rounded-lg bg-wb-bg-subtle p-1 sm:inline-grid">
        {([['drawing', '进行中', Clock], ['finished', '历史回顾', History]] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}
            className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3 text-xs font-semibold ${view === id ? 'bg-wb-bg-elevated text-wb-brand shadow-sm' : 'text-wb-text-secondary hover:bg-wb-bg-surface'}`}>
            <Icon className="h-4 w-4" aria-hidden="true" />{label}
          </button>
        ))}
      </nav>
      {view === 'finished' && <p className="px-1 text-xs text-wb-text-secondary">最近 {HISTORY_LIMIT} 局已结束的画板</p>}
      {listError && <p role="alert" className="rounded-lg bg-wb-danger/5 px-3 py-2 text-xs text-wb-danger">{listError} 正在重试。</p>}
      {visibleBoards?.length ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {visibleBoards.map(board => (
            <li key={board.board_id} className="min-w-0">
              <button type="button" disabled={creating} onClick={() => { setCreateError(''); setSelected({ id: board.board_id }); }}
                className="flex w-full items-center gap-3 rounded-xl border border-wb-border-subtle bg-wb-bg-surface px-3 py-3 text-left hover:border-wb-brand/40 hover:bg-wb-bg-subtle disabled:opacity-50">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${view === 'drawing' ? 'bg-wb-brand/10 text-wb-brand' : 'bg-wb-bg-subtle text-wb-text-secondary'}`}>
                  {view === 'drawing' ? <Brush className="h-4 w-4" aria-hidden="true" /> : <History className="h-4 w-4" aria-hidden="true" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{board.drawer_name || '群友'}的画板</span>
                  <span className="mt-1 flex items-center gap-1 text-2xs text-wb-text-secondary"><Users className="h-3 w-3" aria-hidden="true" />{board.participant_count} 人参与</span>
                </span>
                <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-semibold ${view === 'drawing' ? 'text-wb-brand' : 'text-wb-text-secondary'}`}>
                  {view === 'drawing' ? '查看' : '看结果'}<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : !listError && (
        <p className="rounded-lg border border-dashed border-wb-border-subtle px-4 py-8 text-center text-xs text-wb-text-secondary">
          {boards ? view === 'drawing' ? '暂无进行中的画板。' : '暂无已结束的画板。' : '正在加载画板…'}
        </p>
      )}
    </section>
  );
};

interface BoardProps {
  boardId: string;
  endpoint: string;
  initial?: DrawGuessState;
  onBack: () => void;
  onGroupExp: Props['onGroupExp'];
}

const DrawGuessBoard: React.FC<BoardProps> = ({ boardId, endpoint, initial, onBack, onGroupExp }) => {
  const [game, setGame] = useState<DrawGuessState | null>(initial ?? null);
  const [now, setNow] = useState(Date.now());
  const [color, setColor] = useState('#111827');
  const [brushWidth, setBrushWidth] = useState(5);
  const [guess, setGuess] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendingStrokes, setSendingStrokes] = useState(false);
  const [error, setError] = useState('');
  const [missedGuess, setMissedGuess] = useState(false);
  const [reward, setReward] = useState<GroupExpReward | null>(null);
  const [nextAnswer, setNextAnswer] = useState('');
  const [nextDuration, setNextDuration] = useState(120);
  const [nextHint, setNextHint] = useState('');
  const [pendingStrokes, setPendingStrokes] = useState<Stroke[]>([]);
  const [activePreview, setActivePreview] = useState<Stroke | null>(null);
  const [pointerDown, setPointerDown] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderedStrokesRef = useRef<Stroke[]>([]);
  const redrawRef = useRef<() => void>(() => {});
  const redrawFrameRef = useRef(0);
  const snapshotRef = useRef<DrawGuessState | null>(initial ?? null);
  const activeStrokeRef = useRef<ActiveStroke | null>(null);
  const activePointerRef = useRef<number | null>(null);
  const pendingStrokesRef = useRef<Stroke[]>([]);
  const strokeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRequestsRef = useRef(0);
  const requestSequenceRef = useRef(0);
  const appliedSequenceRef = useRef(0);
  const appliedServerTimeRef = useRef(initial?.server_time ?? 0);
  const serverOffsetRef = useRef(initial ? now - initial.server_time : 0);
  const mountedRef = useRef(false);
  const clearRequestedRef = useRef(false);

  const applySnapshot = useCallback((next: DrawGuessState, sequence: number) => {
    if (!mountedRef.current || next?.board_id !== boardId || !Number.isFinite(next.server_time)) return false;
    if (next.server_time < appliedServerTimeRef.current ||
      (next.server_time === appliedServerTimeRef.current && sequence < appliedSequenceRef.current)) return false;

    const previous = snapshotRef.current;
    const boardChanged = Boolean(previous && (
      previous.round_id !== next.round_id || previous.canvas_version !== next.canvas_version ||
      (previous.status === 'drawing' && next.status === 'finished')
    ));
    if (boardChanged) {
      if (previous?.round_id !== next.round_id) setNextDuration(next.duration_seconds || 120);
      activeStrokeRef.current = null;
      activePointerRef.current = null;
      pendingStrokesRef.current = [];
      setActivePreview(null);
      setPendingStrokes([]);
      setPointerDown(false);
    }

    appliedSequenceRef.current = sequence;
    appliedServerTimeRef.current = next.server_time;
    serverOffsetRef.current = Date.now() - next.server_time;
    snapshotRef.current = next;
    setGame(next);
    setNow(Date.now());
    return true;
  }, [boardId]);

  const loadState = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++requestSequenceRef.current;
    const response = await apiClient.get<DrawGuessState>(`${endpoint}/state`, { signal });
    const applied = applySnapshot(response.data, sequence);
    if (applied) setError('');
    return applied;
  }, [applySnapshot, endpoint]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeStrokeRef.current = null;
      activePointerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    let stopped = false;

    const poll = async () => {
      try {
        await loadState(controller.signal);
      } catch (pollError) {
        if (!controller.signal.aborted && mountedRef.current) setError(errorMessage(pollError));
      } finally {
        if (!stopped) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadState]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const isDrawer = Boolean(game?.is_drawer ?? (game?.status === 'drawing' && game.answer));
  const canDraw = game?.status === 'drawing' && isDrawer;
  const canGuess = game?.status === 'drawing' && game.joined && !isDrawer && !game.my_guessed;
  const remainingSeconds = game?.ends_at
    ? Math.max(0, Math.ceil((game.ends_at - (now - serverOffsetRef.current)) / 1000))
    : 0;

  const renderedStrokes = useMemo(() => {
    const serverStrokes = game?.strokes ?? [];
    const serverKeys = new Set(serverStrokes.map(strokeSignature));
    // 已经落到服务端的笔画不要再叠加本地草稿，否则同一笔会画两遍、看起来发粗/抖动。
    const optimistic = activePreview ? [] : pendingStrokes.filter((stroke) => !serverKeys.has(strokeSignature(stroke)));
    return [...serverStrokes, ...optimistic, ...(activePreview ? [activePreview] : [])];
  }, [activePreview, game?.strokes, pendingStrokes]);

  renderedStrokesRef.current = renderedStrokes;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const redraw = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
      const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
      if (Math.abs(canvas.width - pixelWidth) > 1 || Math.abs(canvas.height - pixelHeight) > 1) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(pixelWidth / LOGICAL_WIDTH, 0, 0, pixelHeight / LOGICAL_HEIGHT, 0, 0);
      context.fillStyle = '#FFFFFF';
      context.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

      for (const stroke of renderedStrokesRef.current) {
        if (!stroke.points.length) continue;
        context.beginPath();
        context.strokeStyle = stroke.color;
        context.fillStyle = stroke.color;
        const logicalLineWidth = stroke.width * LOGICAL_WIDTH / rect.width;
        context.lineWidth = logicalLineWidth;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        const first = stroke.points[0];
        context.moveTo(first.x * LOGICAL_WIDTH, first.y * LOGICAL_HEIGHT);
        if (stroke.points.length === 1) {
          context.arc(first.x * LOGICAL_WIDTH, first.y * LOGICAL_HEIGHT, logicalLineWidth / 2, 0, Math.PI * 2);
          context.fill();
        } else {
          for (let index = 1; index < stroke.points.length; index += 1) {
            const point = stroke.points[index];
            context.lineTo(point.x * LOGICAL_WIDTH, point.y * LOGICAL_HEIGHT);
          }
          context.stroke();
        }
      }
    };

    redrawRef.current = redraw;
    const schedule = () => {
      if (redrawFrameRef.current) return;
      redrawFrameRef.current = window.requestAnimationFrame(() => {
        redrawFrameRef.current = 0;
        redraw();
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (redrawFrameRef.current) window.cancelAnimationFrame(redrawFrameRef.current);
    };
  }, []);

  useEffect(() => {
    if (redrawFrameRef.current) return;
    redrawFrameRef.current = window.requestAnimationFrame(() => {
      redrawFrameRef.current = 0;
      redrawRef.current?.();
    });
  }, [renderedStrokes]);

  const queueStroke = useCallback((stroke: ActiveStroke, points: Point[]) => {
    if (!points.length) return;
    const segment: Stroke = { color: stroke.color, width: stroke.width, points };
    pendingStrokesRef.current = [...pendingStrokesRef.current, segment];
    setPendingStrokes(pendingStrokesRef.current);
    pendingRequestsRef.current += 1;
    setSendingStrokes(true);

    const task = strokeQueueRef.current.then(async () => {
      const sequence = ++requestSequenceRef.current;
      try {
        const response = await apiClient.post<DrawGuessState>(`${endpoint}/stroke`, {
          round_id: stroke.roundId,
          canvas_version: stroke.canvasVersion,
          color: stroke.color,
          width: stroke.width,
          points,
        });
        applySnapshot(response.data, sequence);
      } catch (strokeError) {
        if (mountedRef.current) setError(errorMessage(strokeError));
        if ((strokeError as { response?: { status?: number } })?.response?.status === 409) {
          try { await loadState(); } catch { /* keep the current snapshot */ }
        }
      }
    }).finally(() => {
      pendingRequestsRef.current = Math.max(0, pendingRequestsRef.current - 1);
      if (mountedRef.current) setSendingStrokes(pendingRequestsRef.current > 0);
    });
    strokeQueueRef.current = task;
  }, [applySnapshot, endpoint, loadState]);

  const sendAvailableChunks = useCallback((stroke: ActiveStroke) => {
    if (stroke.uploadedThrough < 0 && stroke.points.length >= STROKE_BATCH_SIZE) {
      queueStroke(stroke, stroke.points.slice(0, STROKE_BATCH_SIZE));
      stroke.uploadedThrough = STROKE_BATCH_SIZE - 1;
    }
    while (stroke.uploadedThrough >= 0 && stroke.points.length >= stroke.uploadedThrough + STROKE_BATCH_SIZE + 1) {
      const start = stroke.uploadedThrough;
      const end = start + STROKE_BATCH_SIZE;
      queueStroke(stroke, stroke.points.slice(start, end));
      stroke.uploadedThrough += STROKE_BATCH_SIZE - 1;
    }
  }, [queueStroke]);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>): Point | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDraw || busy || clearRequestedRef.current || event.button !== 0) return;
    const point = pointFromEvent(event);
    const current = snapshotRef.current;
    if (!point || !current?.round_id) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerRef.current = event.pointerId;
    const stroke: ActiveStroke = {
      roundId: current.round_id,
      canvasVersion: current.canvas_version,
      color,
      width: brushWidth,
      points: [point],
      uploadedThrough: -1,
    };
    activeStrokeRef.current = stroke;
    setActivePreview(stroke);
    setPointerDown(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = activeStrokeRef.current;
    if (!stroke || activePointerRef.current !== event.pointerId) return;
    const point = pointFromEvent(event);
    const previous = stroke.points[stroke.points.length - 1];
    if (!point || (Math.abs(previous.x - point.x) < 0.0005 && Math.abs(previous.y - point.y) < 0.0005)) return;
    stroke.points = [...stroke.points, point];
    setActivePreview({ color: stroke.color, width: stroke.width, points: stroke.points });
    sendAvailableChunks(stroke);
  };

  const finishPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = activeStrokeRef.current;
    if (!stroke || activePointerRef.current !== event.pointerId) return;
    const point = pointFromEvent(event);
    const previous = stroke.points[stroke.points.length - 1];
    if (point && (Math.abs(previous.x - point.x) >= 0.0005 || Math.abs(previous.y - point.y) >= 0.0005)) {
      stroke.points = [...stroke.points, point];
    }
    if (stroke.uploadedThrough < 0) {
      queueStroke(stroke, stroke.points);
    } else if (stroke.points.length - 1 > stroke.uploadedThrough) {
      queueStroke(stroke, stroke.points.slice(stroke.uploadedThrough));
    }
    activeStrokeRef.current = null;
    activePointerRef.current = null;
    setActivePreview(null);
    setPointerDown(false);

    void strokeQueueRef.current.then(async () => {
      try {
        const applied = await loadState();
        if (applied) {
          pendingStrokesRef.current = [];
          setPendingStrokes([]);
        }
      } catch { /* keep the optimistic stroke visible until the next refresh */ }
    });
  };

  const handleBoardAction = async (action: 'join' | 'end') => {
    const current = snapshotRef.current;
    if (busy || current?.status !== 'drawing') return;
    if (action === 'join' ? current.joined : !current.can_end || !current.round_id || pointerDown) return;
    setBusy(true);
    setError('');
    setMissedGuess(false);
    try {
      if (action === 'end') await strokeQueueRef.current;
      if (!mountedRef.current) return;
      const sequence = ++requestSequenceRef.current;
      const { data } = await apiClient.post<DrawGuessState>(`${endpoint}/${action}`,
        action === 'end' ? { round_id: current.round_id } : undefined);
      applySnapshot(data, sequence);
    } catch (actionError) {
      if (!mountedRef.current) return;
      setError(errorMessage(actionError));
      if ((actionError as { response?: { status?: number } })?.response?.status === 409) {
        try { await loadState(); } catch { /* leave the last known state */ }
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleUndo = async () => {
    const current = snapshotRef.current;
    if (!current?.round_id || !canDraw || busy) return;
    setBusy(true);
    setError('');
    try {
      await strokeQueueRef.current;
      const sequence = ++requestSequenceRef.current;
      const { data } = await apiClient.post<DrawGuessState>(`${endpoint}/undo`, {
        round_id: current.round_id,
        canvas_version: current.canvas_version,
      });
      applySnapshot(data, sequence);
      pendingStrokesRef.current = [];
      setPendingStrokes([]);
    } catch (undoError) {
      setError(errorMessage(undoError));
      if ((undoError as { response?: { status?: number } })?.response?.status === 409) {
        try { await loadState(); } catch { /* leave the last known state */ }
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleHintRequest = async () => {
    const current = snapshotRef.current;
    if (!current?.round_id || !current.can_request_hint || busy) return;
    setBusy(true);
    setError('');
    try {
      const sequence = ++requestSequenceRef.current;
      const { data } = await apiClient.post<DrawGuessState>(`${endpoint}/hint-request`, { round_id: current.round_id });
      applySnapshot(data, sequence);
    } catch (hintError) {
      setError(errorMessage(hintError));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleHintReveal = async () => {
    const current = snapshotRef.current;
    if (!current?.round_id || !current.can_reveal_hint || busy) return;
    setBusy(true);
    setError('');
    try {
      const sequence = ++requestSequenceRef.current;
      const { data } = await apiClient.post<DrawGuessState>(`${endpoint}/hint-reveal`, { round_id: current.round_id });
      applySnapshot(data, sequence);
    } catch (hintError) {
      setError(errorMessage(hintError));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleClear = async () => {
    const current = snapshotRef.current;
    if (!current?.round_id || !canDraw || busy) return;
    clearRequestedRef.current = true;
    activeStrokeRef.current = null;
    activePointerRef.current = null;
    setActivePreview(null);
    setPointerDown(false);
    setBusy(true);
    setError('');
    setMissedGuess(false);
    try {
      await strokeQueueRef.current;
      const sequence = ++requestSequenceRef.current;
      const response = await apiClient.post<DrawGuessState>(`${endpoint}/clear`, {
        round_id: current.round_id,
        canvas_version: current.canvas_version,
      });
      applySnapshot(response.data, sequence);
      pendingStrokesRef.current = [];
      setPendingStrokes([]);
    } catch (clearError) {
      setError(errorMessage(clearError));
      if ((clearError as { response?: { status?: number } })?.response?.status === 409) {
        try { await loadState(); } catch { /* leave the last known state */ }
      }
    } finally {
      clearRequestedRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleNext = async (role: 'drawer' | 'guesser') => {
    const current = snapshotRef.current;
    if (!current?.round_id || current.status !== 'finished' || busy) return;
    setBusy(true);
    setError('');
    setMissedGuess(false);
    try {
      const sequence = ++requestSequenceRef.current;
      const { data } = await apiClient.post<DrawGuessState>(`${endpoint}/next`, {
        round_id: current.round_id,
        role,
        ...(role === 'drawer' ? {
          answer: nextAnswer.trim() || undefined,
          hint: nextHint.trim() || undefined,
          duration_seconds: nextDuration,
        } : {}),
      });
      applySnapshot(data, sequence);
      setReward(null);
    } catch (nextError) {
      if (!mountedRef.current) return;
      setError(errorMessage(nextError));
      if ((nextError as { response?: { status?: number } })?.response?.status === 409) {
        try { await loadState(); } catch { /* keep the last known state */ }
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleGuess = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const current = snapshotRef.current;
    const text = guess.trim();
    if (!current?.round_id || !text || text.length > 64 || !canGuess || busy) return;
    setBusy(true);
    setError('');
    setMissedGuess(false);
    try {
      const sequence = ++requestSequenceRef.current;
      const { data } = await apiClient.post<GuessResponse>(`${endpoint}/guess`, {
        round_id: current.round_id,
        text,
      });
      applySnapshot(data, sequence);
      if (!mountedRef.current) return;
      const { exp_gained, group_level, level_up, daily_exp_left } = data;
      if (typeof exp_gained === 'number' && typeof group_level === 'number' &&
        typeof level_up === 'boolean' && typeof daily_exp_left === 'number') {
        const rewardData = { exp_gained, group_level, level_up, daily_exp_left };
        setReward(rewardData);
        onGroupExp(rewardData);
      } else if (data.status === 'drawing') {
        setMissedGuess(true);
      }
      setGuess('');
    } catch (guessError) {
      if (!mountedRef.current) return;
      setError(errorMessage(guessError));
      if ((guessError as { response?: { status?: number } })?.response?.status === 409) {
        try { await loadState(); } catch { /* leave the last known state */ }
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const scores = [...(game?.scores ?? [])].sort((a, b) => b.score - a.score);

  return (
    <section className="w-full space-y-4 text-wb-text-primary">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-wb-border-subtle bg-gradient-to-br from-wb-bg-surface via-wb-bg-surface to-wb-brand/[0.07] px-4 py-3.5 shadow-[0_10px_30px_rgba(0,0,0,0.05)]">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-wb-brand to-wb-brand/70 text-white shadow-lg shadow-wb-brand/20">
            <Brush className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h4 className="truncate text-base font-bold tracking-tight">{game ? `${game.drawer_name || '群友'}的画板` : '你画我猜'}</h4>
            <p className="text-2xs text-wb-text-muted">
              {game?.status === 'drawing'
                ? isDrawer ? '你来画画，其他群友来猜' : game.joined ? '看画面猜一猜' : '正在旁观，加入后即可猜词'
                : game?.status === 'finished' ? '本轮已结束' : '正在加载画板'}
              {game?.round_no ? ` · 第 ${game.round_no} 轮` : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-3 py-1 text-2xs font-semibold ${game?.status === 'drawing' ? 'bg-wb-brand/10 text-wb-brand ring-1 ring-wb-brand/15' : 'bg-wb-bg-subtle text-wb-text-muted'}`}>
            {game?.status === 'drawing' ? `进行中 · ${remainingSeconds}s` : game?.status === 'finished' ? '已结束' : error ? '加载失败' : '加载中'}
          </span>
          {game?.status === 'drawing' && !game.joined && !isDrawer && (
            <button type="button" onClick={() => void handleBoardAction('join')} disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-capsule bg-wb-brand px-3 text-2xs font-semibold text-white disabled:opacity-50">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}加入游戏
            </button>
          )}
          {game?.status === 'drawing' && game.can_end && (
            <button type="button" onClick={() => void handleBoardAction('end')} disabled={busy || pointerDown}
              className="h-8 rounded-capsule border border-wb-danger/20 px-3 text-2xs font-semibold text-wb-danger hover:bg-wb-danger/5 disabled:opacity-50">
              结束本轮
            </button>
          )}
          <button type="button" onClick={onBack}
            className="inline-flex h-8 items-center gap-1.5 rounded-capsule border border-wb-border-subtle px-3 text-2xs font-medium hover:bg-wb-bg-subtle">
            <ArrowLeft className="h-3.5 w-3.5" />返回大厅
          </button>
        </div>
      </header>

      {error && <p role="alert" className="rounded-xl border border-wb-danger/20 bg-wb-danger/5 px-3 py-2 text-2xs text-wb-danger">{error}</p>}

      <div className="mx-auto grid gap-3 lg:max-w-[max(760px,calc(160dvh_-_150px))] lg:grid-cols-[minmax(0,1fr)_208px] xl:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0 space-y-2">
          {game?.status === 'finished' && (
            <div role="status" className="rounded-2xl border border-wb-brand/15 bg-gradient-to-br from-wb-brand/[0.10] via-wb-bg-surface to-wb-bg-surface px-4 py-3.5 text-xs shadow-[0_10px_30px_rgba(0,0,0,0.05)]">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-2 text-sm font-bold"><span className="grid h-7 w-7 place-items-center rounded-full bg-wb-brand/15 text-wb-brand"><Trophy className="h-4 w-4" aria-hidden="true" /></span>本轮结果</span>
                {game.answer && <span className="min-w-0 break-words text-wb-text-secondary [overflow-wrap:anywhere]">答案：<strong className="text-base text-wb-text-primary">{game.answer}</strong></span>}
                <span className="min-w-0 break-words text-wb-text-secondary [overflow-wrap:anywhere]">
                  {game.ended_reason === 'all_guessed'
                    ? `全部猜中！${game.guessed_names?.length ? `（${game.guessed_names.join('、')}）` : ''}`
                    : game.ended_reason === 'guessed' ? reward ? '你猜中了！' : `${game.winner_name || '有群友'}猜中了！`
                      : game.ended_reason === 'manual' ? '本轮已手动结束。'
                        : game.ended_reason === 'timeout' ? '时间到，本轮结束。' : '本轮已结束。'}
                </span>
              </div>
              {reward && <p className="mt-1 text-wb-text-secondary">
                {reward.exp_gained > 0 ? `群经验 +${reward.exp_gained}` : '本轮未获得群经验'}
                {reward.daily_exp_left === 0 && ' · 今日群经验额度已用完'}
                {reward.level_up && ` · 群等级升至 ${reward.group_level} 级`}
              </p>}
              {isDrawer && (
                <div className="mt-2.5 grid gap-1.5 rounded-xl border border-wb-border-subtle bg-white/60 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7.5rem]">
                  <input value={nextAnswer} onChange={(event) => setNextAnswer(event.target.value.slice(0, 8))}
                    maxLength={8} placeholder="下一题（留空随机）" aria-label="下一题题目"
                    className="h-8 min-w-0 rounded-lg border border-wb-border-subtle bg-white px-2.5 text-xs focus:border-wb-brand focus:outline-none" />
                  <input value={nextHint} onChange={(event) => setNextHint(event.target.value.slice(0, 30))}
                    maxLength={30} placeholder="提示（选填）" aria-label="下一题提示"
                    className="h-8 min-w-0 rounded-lg border border-wb-border-subtle bg-white px-2.5 text-xs focus:border-wb-brand focus:outline-none" />
                  <select value={nextDuration} onChange={(event) => setNextDuration(Number(event.target.value))}
                    aria-label="下一轮时长"
                    className="h-8 rounded-lg border border-wb-border-subtle bg-white px-2 text-xs focus:border-wb-brand focus:outline-none">
                    {ROUND_DURATIONS.map((value) => <option key={value} value={value}>{value} 秒</option>)}
                  </select>
                </div>
              )}
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void handleNext('drawer')} disabled={busy}
                  className="inline-flex h-9 items-center gap-1.5 rounded-capsule bg-wb-text-primary px-4 text-2xs font-semibold text-wb-bg-page shadow-sm hover:opacity-90 disabled:opacity-50">
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {isDrawer ? '继续画 · 换一题' : '继续画 · 我来画'}
                </button>
                {!isDrawer && game.joined && (
                  <button type="button" onClick={() => void handleNext('guesser')} disabled={busy}
                    className="inline-flex h-9 items-center gap-1.5 rounded-capsule border border-wb-border-subtle px-4 text-2xs font-semibold text-wb-text-secondary hover:bg-wb-bg-subtle disabled:opacity-50">
                    继续猜 · 等新题
                  </button>
                )}
              </div>
            </div>
          )}
          {game?.status === 'drawing' && (
            <div className="rounded-xl border border-wb-border-subtle bg-gradient-to-r from-wb-brand/[0.07] via-wb-bg-surface to-wb-bg-surface px-3 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {isDrawer && game.answer ? (
                  <span>请画出：<strong className="break-all text-sm text-wb-brand">{game.answer}</strong></span>
                ) : (
                  <span className="font-semibold tracking-wide text-wb-brand">
                    {game.answer_mask || (game.answer_length ? '＿'.repeat(game.answer_length) : '猜一猜')}
                    {game.answer_length ? <span className="ml-2 text-2xs font-normal text-wb-text-muted">· {game.answer_length} 字</span> : null}
                  </span>
                )}
                {game.hint && <span className="min-w-0 break-words text-wb-text-secondary">提示：{game.hint}</span>}
                {!isDrawer && game.can_request_hint && (
                  <button type="button" onClick={() => void handleHintRequest()} disabled={busy}
                    className="ml-auto inline-flex h-7 items-center gap-1 rounded-capsule border border-wb-border-subtle bg-white/70 px-2.5 text-2xs font-semibold text-wb-text-secondary hover:bg-wb-bg-subtle disabled:opacity-50">
                    <Lightbulb className="h-3 w-3" />请求提示
                  </button>
                )}
                {isDrawer && game.can_reveal_hint && (
                  <button type="button" onClick={() => void handleHintReveal()} disabled={busy}
                    className="ml-auto inline-flex h-7 items-center gap-1 rounded-capsule border border-wb-border-subtle bg-white/70 px-2.5 text-2xs font-semibold text-wb-text-secondary hover:bg-wb-bg-subtle disabled:opacity-50">
                    <Lightbulb className="h-3 w-3" />揭示一个字
                  </button>
                )}
              </div>
              {isDrawer && Boolean(game.hint_requests?.length) && (
                <p className="mt-1.5 text-2xs text-wb-text-muted">{game.hint_requests!.join('、')} 请求提示</p>
              )}
            </div>
          )}
          <div className="relative aspect-[16/10] w-full overflow-hidden rounded-2xl border border-white/80 bg-white shadow-[0_18px_45px_rgba(0,0,0,0.12)] ring-1 ring-black/[0.04]">
            <canvas
              ref={canvasRef}
              aria-label="你画我猜共享画板"
              className={`absolute inset-0 h-full w-full ${canDraw ? 'cursor-crosshair touch-none' : 'cursor-default'}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={finishPointer}
              onPointerCancel={finishPointer}
            />
            {!game?.strokes.length && !pendingStrokes.length && !activePreview && game?.status !== 'drawing' && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-xs text-slate-400">
                <div><Brush className="mx-auto mb-2 h-6 w-6 opacity-40" /><p>{game?.status === 'finished' ? '本轮没有笔画' : '正在加载画板…'}</p></div>
              </div>
            )}
          </div>

          {canDraw ? (
            <div className="rounded-lg border border-wb-border-subtle bg-wb-bg-surface">
              <div role="group" aria-label="选择画笔颜色" className="flex flex-wrap items-center gap-1 px-2 py-1.5">
                {PALETTE.map((swatch) => (
                  <button key={swatch} type="button" aria-label={`画笔颜色 ${swatch}`} aria-pressed={color === swatch}
                    onClick={() => setColor(swatch)} className="grid h-8 w-8 place-items-center rounded-md hover:bg-wb-bg-subtle">
                    <span className={`h-5 w-5 rounded-full border ${swatch === '#FFFFFF' ? 'border-slate-300' : 'border-black/10'} ${color === swatch ? 'ring-2 ring-wb-brand ring-offset-2' : ''}`}
                      style={{ backgroundColor: swatch }} />
                  </button>
                ))}
                <input type="color" value={color} onChange={(event) => setColor(event.target.value.toUpperCase())}
                  aria-label="自定义画笔颜色" title="自定义画笔颜色" className="h-8 w-8 cursor-pointer rounded-md border-0 bg-transparent p-1" />
              </div>
              <div className="flex items-center gap-2 border-t border-wb-border-subtle px-2 py-2 sm:px-3">
                <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-wb-text-secondary">
                  <span className="shrink-0 tabular-nums">笔触 {brushWidth}px</span>
                  <input type="range" min="1" max="32" value={brushWidth} onChange={(event) => setBrushWidth(Number(event.target.value))}
                    aria-label="画笔粗细" className="h-9 min-w-0 flex-1 accent-wb-brand sm:max-w-44" />
                </label>
                <button type="button" onClick={() => void handleUndo()} disabled={busy || pointerDown || !(game?.strokes?.length)}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-wb-border-subtle px-2 text-xs font-medium text-wb-text-secondary hover:bg-wb-bg-subtle disabled:opacity-40 sm:px-3">
                  <Undo2 className="h-3.5 w-3.5" />撤销
                </button>
                <button type="button" onClick={() => void handleClear()} disabled={busy || pointerDown}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-wb-border-subtle px-2 text-xs font-medium text-wb-text-secondary hover:bg-wb-bg-subtle disabled:opacity-50 sm:px-3">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eraser className="h-3.5 w-3.5" />}
                  清空
                </button>
              </div>
              {sendingStrokes && <p className="px-3 pb-2 text-2xs text-wb-text-muted">正在同步笔画…</p>}
            </div>
          ) : game?.status === 'drawing' && game.my_guessed ? (
            <div className="flex items-center gap-2 rounded-xl border border-wb-brand/20 bg-wb-brand/[0.06] px-3 py-2.5 text-xs text-wb-text-secondary">
              <Trophy className="h-4 w-4 text-wb-brand" />
              你已猜中，等其他群友继续；画手也可以直接开下一轮。
            </div>
          ) : canGuess ? (
            <form onSubmit={(event) => void handleGuess(event)} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-wb-border-subtle bg-wb-bg-surface p-2">
              <input value={guess} onChange={(event) => setGuess(event.target.value.slice(0, 64))} maxLength={64}
                placeholder={game.answer_length ? `猜一个 ${game.answer_length} 字的词…` : '输入你的猜测…'} aria-label="输入猜测" autoComplete="off"
                className="h-10 min-w-0 flex-1 rounded-lg border border-wb-border-subtle bg-wb-bg-page px-3 text-base text-wb-text-primary placeholder:text-wb-text-muted focus:border-wb-brand focus:outline-none sm:text-sm" />
              <button type="submit" disabled={!guess.trim() || busy}
                className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-wb-brand px-3 text-xs font-semibold text-white disabled:opacity-50">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                猜一猜
              </button>
              <span role="status" className="col-span-2 min-h-4 px-1 text-xs text-wb-text-secondary">{missedGuess ? '还没猜中，再试试。' : ''}</span>
            </form>
          ) : null}
        </div>

        <aside className="min-w-0 space-y-3">
          <div className="rounded-2xl border border-wb-border-subtle bg-wb-bg-surface p-3.5 shadow-[0_8px_24px_rgba(0,0,0,0.04)]">
            <h5 className="mb-2.5 text-xs font-semibold tracking-wide">群友猜词</h5>
            {game?.guesses?.length ? (
              <ol aria-label="猜词记录（最新在前）" className="max-h-32 space-y-1 overflow-y-auto text-xs lg:max-h-48">
                {[...game.guesses].reverse().map((entry, index) => (
                  <li key={`${entry.user_id}-${entry.ts}-${index}`} className="break-words text-wb-text-secondary">
                    <strong>{entry.name || '群友'}：</strong>
                    {entry.correct ? <span className="font-semibold text-wb-brand">猜中了</span> : entry.text}
                  </li>
                ))}
              </ol>
            ) : <p className="text-2xs text-wb-text-muted">还没有人猜词。</p>}
          </div>
          <div className="rounded-2xl border border-wb-border-subtle bg-wb-bg-surface p-3.5 shadow-[0_8px_24px_rgba(0,0,0,0.04)]">
            <div className="mb-3 flex items-center justify-between">
              <h5 className="text-xs font-semibold">群内积分</h5>
              <Trophy className="h-4 w-4 text-wb-text-muted" />
            </div>
            {scores.length ? (
              <ol className="space-y-2">
                {scores.map((entry, index) => (
                  <li key={entry.user_id} className="flex items-center gap-2 text-2xs">
                    <span className="w-5 shrink-0 text-center font-mono text-wb-text-muted">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-wb-text-secondary">{entry.name || '群友'}</span>
                    <span className="font-semibold tabular-nums">{entry.score}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-2xs text-wb-text-muted">还没有积分，来开一局吧。</p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
};
