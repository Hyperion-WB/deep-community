import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trophy, Crown } from 'lucide-react';
import { apiClient } from '../../api/client';
import { UserAvatar } from '../UserAvatar';

interface Row {
  rank: number;
  user_id: string;
  username: string;
  nickname: string;
  avatar_url: string;
  score: number;
}

const RANK_STYLE = [
  'bg-amber-400/20 text-amber-600 border-amber-400/40',
  'bg-slate-300/20 text-slate-500 border-slate-300/40',
  'bg-orange-400/20 text-orange-600 border-orange-400/40',
];

/** 单款游戏排行榜：只展示前 10 名，含头像 / 昵称 / 分数。 */
export const MinigameLeaderboard: React.FC<{ game: string; refreshKey?: number; myId?: string }> = ({
  game,
  refreshKey = 0,
  myId,
}) => {
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [myRank, setMyRank] = useState<number | null>(null);

  const firstRef = useRef(true);

  // silent=true 时保留旧数据静默刷新，避免每局结束都闪一次骨架屏
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await apiClient.get(`/minigames/${game}/leaderboard`);
      const next = Array.isArray(res.data?.items) ? res.data.items : [];
      setItems((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      setMyRank(res.data?.my_rank ?? null);
    } catch {
      if (!silent) setItems([]);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [game]);

  useEffect(() => {
    const silent = !firstRef.current;
    firstRef.current = false;
    void load(silent);
  }, [load, refreshKey]);

  return (
    <div className="rounded-2xl border border-wb-border-subtle bg-wb-bg-surface overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-wb-border-subtle">
        <span className="flex items-center gap-1.5 text-2xs font-bold text-wb-text-primary">
          <Trophy className="w-3.5 h-3.5 text-wb-brand" /> 本榜前 10
        </span>
        {myRank && <span className="text-3xs text-wb-text-muted font-mono">我的排名 #{myRank}</span>}
      </div>

      {loading ? (
        <div className="p-4 space-y-1.5">
          {[0, 1, 2].map((i) => <div key={i} className="h-7 rounded-lg bg-wb-bg-subtle animate-pulse" />)}
        </div>
      ) : items.length === 0 ? (
        <p className="p-4 text-3xs text-wb-text-muted text-center">还没有人留下记录，来当第一个</p>
      ) : (
        <ul className="divide-y divide-wb-border-subtle/60">
          {items.map((r) => {
            const isMe = myId && r.user_id === myId;
            return (
              <li
                key={`${r.user_id}-${r.rank}`}
                className={`flex items-center gap-2.5 px-3 py-1.5 text-2xs ${isMe ? 'bg-wb-brand/8' : ''}`}
              >
                <span
                  className={`w-5 h-5 shrink-0 rounded-md border flex items-center justify-center font-mono font-bold text-3xs ${
                    r.rank <= 3 ? RANK_STYLE[r.rank - 1] : 'border-transparent text-wb-text-muted'
                  }`}
                >
                  {r.rank === 1 ? <Crown className="w-3 h-3" /> : r.rank}
                </span>
                <UserAvatar username={r.username} avatarUrl={r.avatar_url} size={20} className="shrink-0" />
                <span className={`min-w-0 flex-1 truncate ${isMe ? 'font-semibold text-wb-text-primary' : 'text-wb-text-secondary'}`}>
                  {r.nickname || r.username}
                </span>
                <span className="font-mono font-bold text-wb-text-primary shrink-0">{r.score}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
