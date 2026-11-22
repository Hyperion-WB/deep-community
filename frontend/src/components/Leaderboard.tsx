import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Trophy, Crown, Zap, CalendarCheck } from 'lucide-react';
import { apiClient } from '../api/client';
import { UserAvatar } from './UserAvatar';
import { InlineErrorState } from './InlineErrorState';

interface Row {
  rank: number;
  user_id: string;
  username: string;
  nickname?: string | null;
  avatar_url?: string;
  level: number;
  title: string;
  metric: number;
  metric_label: string;
  streak?: number;
}

type Tab = 'total' | 'early' | 'active';

const TABS: { key: Tab; label: string; icon: React.ReactNode; desc: string }[] = [
  { key: 'total', label: '签到榜', icon: <CalendarCheck className="w-3.5 h-3.5" />, desc: '累计签到天数排名' },
  { key: 'early', label: '抢早签', icon: <Zap className="w-3.5 h-3.5" />, desc: '今日最早打卡的五位' },
  { key: 'active', label: '活跃榜', icon: <Crown className="w-3.5 h-3.5" />, desc: '近 7 天综合活跃度' },
];

/** 金 / 银 / 铜 三色，4~5 名用中性色 */
const MEDAL = [
  'bg-gradient-to-br from-amber-300 to-amber-500 text-slate-900',
  'bg-gradient-to-br from-slate-200 to-slate-400 text-slate-900',
  'bg-gradient-to-br from-orange-300 to-orange-500 text-slate-900',
];

const LeaderboardInner: React.FC<{ onSelectUser?: (username: string) => void }> = ({ onSelectUser }) => {
  const [tab, setTab] = useState<Tab>('total');
  const [data, setData] = useState<Record<Tab, Row[]>>({ total: [], early: [], active: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoadError(false);
      try {
        const res = await apiClient.get('/stats/leaderboards');
        if (!alive) return;
        setData({
          total: res.data?.total || [],
          early: res.data?.early || [],
          active: res.data?.active || [],
        });
      } catch {
        // 接口失败不能伪装成「没人上榜」
        if (alive) setLoadError(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  // 与全局 SegmentedControl 同一套做法：实测按钮 left/width 后做 x/width 动画，
  // 不用 layoutId 布局投影，父级重渲染时不会重播导致闪烁。
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState<{ x: number; width: number } | null>(null);

  const measureThumb = React.useCallback(() => {
    const wrap = tabsRef.current;
    if (!wrap) return;
    const btn = wrap.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    // 抽屉打开导致容器 display:none 时测出来是 0，直接跳过，别把滑块压成 0 宽
    if (!btn || btn.offsetWidth === 0) return;
    const x = btn.offsetLeft;
    const width = btn.offsetWidth;
    setThumb((prev) =>
      prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.width - width) < 0.5 ? prev : { x, width }
    );
  }, [tab]);

  useLayoutEffect(() => { measureThumb(); }, [measureThumb, reloadKey]);

  useEffect(() => {
    const handle = () => measureThumb();
    window.addEventListener('resize', handle);
    if (document.fonts?.ready) document.fonts.ready.then(handle).catch(() => undefined);
    const ob = new ResizeObserver(handle);
    if (tabsRef.current) ob.observe(tabsRef.current);
    return () => {
      window.removeEventListener('resize', handle);
      ob.disconnect();
    };
  }, [measureThumb]);

  const rows = data[tab];

  return (
    <div className="p-5 rounded-3xl surface border border-wb-border-subtle shadow-card space-y-3 transition-all duration-200 hover:shadow-lg">
      <div className="flex items-center gap-2 pb-2 border-b border-wb-border-subtle">
        <Trophy className="w-4 h-4 text-wb-text-primary" />
        <h3 className="text-sm font-bold text-wb-text-primary tracking-wide">社区榜单</h3>
      </div>

      {/* 三个榜单切换：与「全部发现 / 关注动态」同一套胶囊 + 滑块 */}
      <div ref={tabsRef} className="relative flex items-center gap-1.5 p-1 rounded-capsule frost shrink-0">
        {thumb && (
          <motion.div
            aria-hidden="true"
            className="absolute top-1 bottom-1 left-0 rounded-capsule bg-wb-text-primary shadow-sm pointer-events-none"
            initial={false}
            animate={{ x: thumb.x, width: thumb.width }}
            transition={{ type: 'spring', stiffness: 480, damping: 38, mass: 0.9 }}
          />
        )}
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            data-tab={t.key}
            onClick={() => setTab(t.key)}
            className={`wb-pressable relative z-10 flex-1 h-9 px-3 rounded-capsule text-xs font-semibold transition-colors duration-200 whitespace-nowrap select-none inline-flex items-center justify-center gap-1.5 ${
              tab === t.key
                ? 'text-wb-bg-page'
                : 'text-wb-text-secondary hover:text-wb-text-primary'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      <p className="text-3xs text-wb-text-muted -mt-1">{TABS.find((t) => t.key === tab)?.desc}</p>

      {loadError ? (
        <InlineErrorState compact label="榜单加载失败" onRetry={() => setReloadKey((n) => n + 1)} />
      ) : loading ? (
        <div className="space-y-2 py-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 rounded-xl bg-wb-bg-subtle animate-pulse" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-2xs text-wb-text-muted">
          {tab === 'early' ? '今天还没人打卡，抢个第一吧' : '暂时还没有上榜的极客'}
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <button
              key={`${tab}-${row.user_id}`}
              type="button"
              onClick={() => onSelectUser?.(row.username)}
              className="w-full text-left flex items-center gap-2.5 p-1.5 rounded-xl hover:bg-wb-bg-subtle transition-colors group"
            >
              <span
                className={`w-5 h-5 rounded-lg flex items-center justify-center text-3xs font-bold shrink-0 ${
                  MEDAL[row.rank - 1] || 'bg-wb-bg-subtle text-wb-text-muted'
                }`}
              >
                {row.rank}
              </span>
              <UserAvatar username={row.username} avatarUrl={row.avatar_url} size={26} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-wb-text-primary truncate group-hover:underline">
                    {row.nickname || row.username}
                  </span>
                  <span className="text-3xs px-1 py-0.2 rounded bg-wb-brand/10 text-wb-brand shrink-0">
                    {row.title}
                  </span>
                </div>
                <p className="text-3xs text-wb-text-muted truncate font-mono">{row.metric_label}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// 父级重渲染时不跟着重算，避免榜单 tab 与高亮闪烁
export const Leaderboard = React.memo(LeaderboardInner);
