import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brush, ChevronRight, Feather, Gamepad2, Link2, Loader2, Sparkles, X } from 'lucide-react';
import { apiClient } from '../api/client';

export type GameDockKind = 'draw' | 'chain' | 'feihua';

interface ActiveGame {
  kind: GameDockKind;
  id: string;
  title: string;
  subtitle: string;
  badge: string;
}

interface Props {
  roomId: string;
  onOpenGame: (kind: GameDockKind, id?: string) => void;
}

const KIND_META: Record<GameDockKind, { icon: React.ReactNode; accent: string }> = {
  draw: { icon: <Brush className="h-4 w-4" />, accent: 'bg-rose-500/10 text-rose-500' },
  chain: { icon: <Link2 className="h-4 w-4" />, accent: 'bg-sky-500/10 text-sky-500' },
  feihua: { icon: <Feather className="h-4 w-4" />, accent: 'bg-violet-500/10 text-violet-500' },
};

export const GameDock: React.FC<Props> = ({ roomId, onOpenGame }) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [games, setGames] = useState<ActiveGame[]>([]);
  const [failed, setFailed] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const ballRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [drawResult, chainResult, feihuaResult] = await Promise.allSettled([
        apiClient.get<{ boards: any[] }>(`/chat/groups/${roomId}/draw-guess/boards`),
        apiClient.get<any>(`/chat/groups/${roomId}/idiom-chain/state`),
        apiClient.get<any>(`/chat/groups/${roomId}/feihua/state`),
      ]);
      const next: ActiveGame[] = [];

      if (drawResult.status === 'fulfilled') {
        for (const board of drawResult.value.data?.boards ?? []) {
          if (board.status !== 'drawing') continue;
          next.push({
            kind: 'draw',
            id: String(board.board_id),
            title: `${board.drawer_name || '群友'} 的画板`,
            subtitle: `${board.participant_count || 0} 人参与 · 点击继续画或猜`,
            badge: '你画我猜',
          });
        }
      }
      if (chainResult.status === 'fulfilled' && chainResult.value.data?.active) {
        const data = chainResult.value.data;
        const last = data.state?.current || data.state?.word || data.state?.last_word || '';
        next.push({
          kind: 'chain',
          id: String(data.game_id || ''),
          title: last ? `成语接龙 · ${last}` : '成语接龙',
          subtitle: `剩余 ${Math.max(0, Number(data.remaining_seconds || 0))} 秒 · 点进去接一句`,
          badge: '成语接龙',
        });
      }
      if (feihuaResult.status === 'fulfilled' && feihuaResult.value.data?.active) {
        const data = feihuaResult.value.data;
        const flag = data.state?.flag || data.state?.current || '';
        next.push({
          kind: 'feihua',
          id: String(data.game_id || ''),
          title: flag ? `飞花令 · ${flag}` : '飞花令',
          subtitle: `剩余 ${Math.max(0, Number(data.remaining_seconds || 0))} 秒 · 点进去对诗`,
          badge: '飞花令',
        });
      }
      setGames(next);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      if (cancelled) return;
      await load();
      if (!cancelled) timer = window.setTimeout(poll, open ? 6000 : 15000);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const handleDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!wrapRef.current?.contains(target) && !ballRef.current?.contains(target)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const launch = (kind: GameDockKind, id?: string) => {
    setOpen(false);
    onOpenGame(kind, id);
  };

  return (
    <>
      <button
        ref={ballRef}
        type="button"
        aria-label="群内游戏"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="fixed bottom-44 right-3 z-[120] flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-wb-text-primary text-wb-bg-page shadow-[0_12px_30px_rgba(0,0,0,0.28)] transition-transform hover:scale-105 active:scale-95 sm:right-4"
      >
        {open ? <X className="h-5 w-5" /> : <Gamepad2 className="h-5 w-5" />}
        {!open && games.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white ring-2 ring-wb-bg-page">
            {games.length > 9 ? '9+' : games.length}
          </span>
        )}
      </button>

      {open && createPortal(
        <div ref={wrapRef}
          className="fixed bottom-[11.5rem] right-3 z-[121] w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-3xl border border-wb-border-strong bg-wb-bg-surface/96 shadow-[0_24px_70px_rgba(0,0,0,0.32)] backdrop-blur-xl sm:right-4">
          <div className="flex items-center justify-between border-b border-wb-border-subtle px-4 py-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-bold"><Gamepad2 className="h-4 w-4 text-wb-brand" />群内游戏</p>
              <p className="mt-0.5 text-2xs text-wb-text-muted">正在进行 · 点击直接加入</p>
            </div>
            <span className={`flex h-2 w-2 rounded-full ${games.length ? 'bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]' : 'bg-wb-border-strong'}`} />
          </div>

          <div className="max-h-[min(24rem,calc(100dvh-13rem))] overflow-y-auto p-2.5">
            {loading && !games.length ? (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-wb-text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />正在看看群里在玩什么…
              </div>
            ) : games.length ? (
              <div className="space-y-1.5">
                {games.map((game) => {
                  const meta = KIND_META[game.kind];
                  return (
                    <button key={`${game.kind}-${game.id}`} type="button" onClick={() => launch(game.kind, game.id)}
                      className="group flex w-full items-center gap-3 rounded-2xl border border-transparent px-2.5 py-2.5 text-left transition-colors hover:border-wb-border-subtle hover:bg-wb-bg-subtle">
                      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${meta.accent}`}>{meta.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-wb-text-primary">{game.title}</span>
                        <span className="mt-0.5 block truncate text-2xs text-wb-text-muted">{game.subtitle}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-wb-text-muted">
                        {game.badge}<ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-3 py-8 text-center">
                <Sparkles className="mx-auto mb-2 h-7 w-7 text-wb-text-muted/50" />
                <p className="text-xs font-semibold text-wb-text-secondary">群里还没有正在进行的游戏</p>
                <p className="mt-1 text-2xs text-wb-text-muted">发起一局，等群友一起加入</p>
              </div>
            )}
            {failed && <p className="px-2 py-1 text-2xs text-wb-danger">部分游戏状态加载失败，稍后会自动重试</p>}
          </div>

          <div className="border-t border-wb-border-subtle bg-wb-bg-subtle/40 p-2.5">
            <p className="mb-1.5 px-1 text-[10px] font-semibold text-wb-text-muted">发起新游戏</p>
            <div className="grid grid-cols-3 gap-1.5">
              {([
                ['draw', '你画我猜', Brush],
                ['chain', '成语接龙', Link2],
                ['feihua', '飞花令', Feather],
              ] as const).map(([kind, label, Icon]) => (
                <button key={kind} type="button" onClick={() => launch(kind)}
                  className="flex min-w-0 flex-col items-center gap-1 rounded-xl border border-wb-border-subtle bg-wb-bg-surface px-1.5 py-2 text-[10px] font-semibold text-wb-text-secondary transition-colors hover:border-wb-border-strong hover:text-wb-text-primary">
                  <Icon className="h-3.5 w-3.5" />{label}
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};
