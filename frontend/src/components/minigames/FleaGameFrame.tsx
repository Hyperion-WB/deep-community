import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../../api/client';

const ROUND_BRIDGE_VERSION = 2;

interface GameDef {
  code: string;
  name: string;
  path: string;
  difficulty: number;
  target_score: number;
  ref_seconds: number;
}

interface Props {
  game: GameDef;
  loggedIn: boolean;
  onScoreSubmitted?: () => void;
}

/**
 * flea-game 游戏的 iframe 容器。
 * 负责服务端签发 run_id、监听同源 bridge 回传、局末一次性结算成绩。
 * 未登录也能玩，只是不计分。
 */
export const FleaGameFrame: React.FC<Props> = ({ game, loggedIn, onScoreSubmitted }) => {
  const [status, setStatus] = useState('进行游戏后开始计分');
  const [incompatiblePath, setIncompatiblePath] = useState<string>();
  const frameUrl = new URL(game.path, window.location.origin);
  frameUrl.searchParams.set('round-bridge', String(ROUND_BRIDGE_VERSION));
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const submitted = useRef(onScoreSubmitted);

  useEffect(() => {
    submitted.current = onScoreSubmitted;
  }, [onScoreSubmitted]);

  useEffect(() => {
    setStatus(loggedIn ? '进行游戏后开始计分' : '登录后成绩才会计入榜单');
    if (!loggedIn) return;

    let alive = true;
    let latestId = 0;
    let current: { id: number; credential: Promise<string | undefined> } | undefined;
    const onMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow;
      const data = event.data;
      if (!frameWindow || event.source !== frameWindow || event.origin !== window.location.origin ||
          data?.type !== 'flea-game-round' || data.version !== ROUND_BRIDGE_VERSION ||
          data.game !== game.code || !Number.isSafeInteger(data.id)) return;

      if (data.phase === 'reset' || data.phase === 'start') {
        if (data.id <= latestId) return;
        const id: number = data.id;
        latestId = id;
        if (data.phase === 'reset') {
          current = undefined;
          setStatus(data.ranked ? '进行游戏后开始计分' : '当前为本地练习，新开排名对局后开始计分');
          return;
        }
        setStatus('对局已开始，玩完自动结算');
        const credential = apiClient.post<{ run_id: string }>(`/minigames/${game.code}/run`)
          .then(({ data: response }) => response.run_id)
          .catch((error) => {
            const detail = error.response?.data?.detail;
            if (alive && latestId === id) setStatus(typeof detail === 'string' ? detail : '未能领取计分凭证');
            return undefined;
          });
        current = { id, credential };
        return;
      }

      const round = current;
      if (data.phase !== 'finish' || !round || round.id !== data.id) return;
      current = undefined;
      void round.credential.then(async (runId) => {
        if (!runId) return;
        if (alive && latestId === round.id) setStatus('正在结算本局成绩…');
        try {
          await apiClient.post(`/minigames/${game.code}/score`, {
            run_id: runId,
            score: data.score,
            duration_ms: data.durationMs,
            completed: true,
            event_log: data.events,
            metrics: data.metrics,
          });
          if (alive && latestId === round.id) setStatus('本局成绩已计入赛季积分');
          submitted.current?.();
        } catch (error: any) {
          const detail = error?.response?.data?.detail;
          if (alive && latestId === round.id) setStatus(typeof detail === 'string' ? detail : '成绩结算失败');
        }
      });
    };
    window.addEventListener('message', onMessage);
    return () => {
      alive = false;
      window.removeEventListener('message', onMessage);
    };
  }, [game.code, loggedIn]);

  /** 让方向键只控制游戏、不滚动网页。
   *  iframe 是独立 browsing context，未聚焦时按键会派发给父页面。
   *  这里在捕获阶段拦下并同源转发到 iframe 的 document。 */
  useEffect(() => {
    const GAME_KEYS = /^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight| |Spacebar)$/;
    const onKey = (e: KeyboardEvent) => {
      if (!GAME_KEYS.test(e.key)) return;
      const frame = frameRef.current;
      if (!frame) return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest('input, textarea, select, button, a[href], [role="button"]') || active?.isContentEditable) return;
      if (active === frame) return;              // 焦点已在 iframe，浏览器自己派发
      e.preventDefault();
      try {
        const win = frame.contentWindow as any;
        const doc = frame.contentDocument;
        if (!doc || !win?.KeyboardEvent) return;
        doc.dispatchEvent(new win.KeyboardEvent('keydown', {
          key: e.key, code: e.code, keyCode: e.keyCode, which: e.keyCode,
          bubbles: true, cancelable: true,
        }));
      } catch { /* 跨域或 iframe 尚未就绪时忽略 */ }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const focusGame = () => {
    try { frameRef.current?.contentWindow?.focus(); } catch { /* 忽略 */ }
  };

  const onFrameLoad = () => {
    try {
      const frame = frameRef.current?.contentWindow as (Window & { FleaRound?: { version?: number } }) | null;
      setIncompatiblePath(frame?.FleaRound?.version === ROUND_BRIDGE_VERSION ? undefined : game.path);
    } catch {
      setIncompatiblePath(game.path);
    }
    focusGame();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-3xs text-wb-text-muted px-1 flex-wrap">
        <span>{loggedIn && incompatiblePath === game.path ? '当前游戏版本仅支持练习，请刷新页面后计分' : status}</span>
        <span>难度 {game.difficulty.toFixed(2)} · 目标 {game.target_score} · 参考 {game.ref_seconds}s</span>
      </div>
      <div className="rounded-2xl overflow-hidden border border-wb-border-subtle bg-wb-bg-surface">
        <iframe
          ref={frameRef}
          key={game.code}
          title={game.name}
          src={frameUrl.href}
          className="w-full border-0"
          style={{ height: 520 }}
          loading="lazy"
          tabIndex={0}
          onLoad={onFrameLoad}
          onClick={focusGame}
        />
      </div>
      <p className="text-3xs text-wb-text-muted px-1">
        来源 huazie/flea-game（MIT）。成绩按「难度 × 完成度 ÷ 用时」换算为 0–100 赛季分；点一下游戏区即可用方向键操作，不会滚动网页。
      </p>
    </div>
  );
};
