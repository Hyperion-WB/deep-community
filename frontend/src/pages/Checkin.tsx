import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CalendarCheck, Flame, Gift, Loader2, Medal, Ticket } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from '../components/Toast';
import { CheckinHeatmap } from '../components/CheckinHeatmap';
import { Leaderboard } from '../components/Leaderboard';
import type { UserProfile } from '../types';

interface Props {
  user: UserProfile | null;
  onBack: () => void;
  onRequireAuth: () => void;
  onSelectUser?: (username: string) => void;
}

interface CheckinStatus {
  checked_today: boolean;
  streak: number;
  best_streak: number;
  makeup_left: number;
}

/**
 * 每日签到独立页。
 * 迁移包的专业版 Navbar 里签到按钮是 onSelectTab('checkin')，但包内没有
 * 附带这个页面组件；这里用现有的 /users/checkin 接口、CheckinHeatmap 与
 * 签到榜补齐，两个门户共用。
 */
export const Checkin: React.FC<Props> = ({ user, onBack, onRequireAuth, onSelectUser }) => {
  const toast = useToast();
  const [status, setStatus] = useState<CheckinStatus>({
    checked_today: false, streak: 0, best_streak: 0, makeup_left: 0,
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    try {
      const r = await apiClient.get('/users/checkin/status');
      setStatus({
        checked_today: Boolean(r.data?.checked_today),
        streak: Number(r.data?.streak) || 0,
        best_streak: Number(r.data?.best_streak) || 0,
        makeup_left: Number(r.data?.makeup_left) || 0,
      });
    } catch {
      /* 保留上一次状态 */
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  // 热力图里补签会改变连续天数与补签卡数量：完成补签后同步刷新顶部状态
  useEffect(() => {
    const onDone = () => void load();
    window.addEventListener('geek:checkin-done', onDone);
    return () => window.removeEventListener('geek:checkin-done', onDone);
  }, [load]);

  const handleCheckin = async () => {
    if (!user) { onRequireAuth(); return; }
    if (status.checked_today || busy) return;
    setBusy(true);
    try {
      const r = await apiClient.post('/users/checkin');
      toast.success(`签到成功 · 连续 ${r.data?.continuous_days || 1} 天，经验 +${r.data?.exp_gained || 0}`);
      window.dispatchEvent(new CustomEvent('geek:checkin-done'));
    } catch (err: any) {
      toast.info(err?.response?.data?.detail || '签到失败，稍后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-5 space-y-5 animate-fade-in">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="p-2 rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary transition-colors"
          aria-label="返回首页"
          title="返回首页"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-base font-bold text-wb-text-primary flex items-center gap-2">
            <CalendarCheck className="w-4 h-4 text-wb-brand" /> 每日签到
          </h1>
          <p className="text-2xs text-wb-text-muted">连续签到攒经验，补签卡可以补回漏掉的日子</p>
        </div>
      </div>

      {!user ? (
        <div className="p-8 rounded-3xl surface border border-wb-border-subtle text-center space-y-3">
          <CalendarCheck className="w-8 h-8 mx-auto text-wb-text-muted stroke-1" />
          <p className="text-xs text-wb-text-secondary">登录后即可签到并查看自己的打卡日历</p>
          <button type="button" onClick={onRequireAuth}
            className="px-4 h-9 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold">
            立即登录
          </button>
        </div>
      ) : (
        <>
          <div className="p-5 sm:p-6 rounded-3xl surface border border-wb-border-subtle shadow-card flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-wb-warn/10 text-wb-warn text-2xs font-semibold">
                  <Flame className="w-3.5 h-3.5" /> 连续 {status.streak} 天
                </span>
                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-wb-info/10 text-wb-info text-2xs font-semibold">
                  <Medal className="w-3.5 h-3.5" /> 最佳 {status.best_streak} 天
                </span>
                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-wb-bg-subtle text-wb-text-secondary text-2xs font-semibold">
                  <Ticket className="w-3.5 h-3.5" /> 补签卡 {status.makeup_left}
                </span>
              </div>
              <p className="text-xs text-wb-text-secondary leading-relaxed">
                {status.checked_today
                  ? '今天已经打过卡啦，明天再来保持连击～'
                  : '今天还没签到，点一下领取每日经验，连续满 7 天有额外奖励。'}
              </p>
              <p className="text-3xs text-wb-text-muted flex items-center gap-1">
                <Gift className="w-3 h-3" /> 基础 +5 经验 · 每连续 7 天额外 +15
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleCheckin()}
              disabled={busy || loading || status.checked_today}
              className={`wb-pressable inline-flex items-center justify-center gap-2 h-11 px-6 rounded-capsule text-sm font-bold shrink-0 transition-colors disabled:opacity-60 ${
                status.checked_today
                  ? 'bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-muted'
                  : 'bg-wb-text-primary text-wb-bg-page hover:opacity-90'
              }`}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarCheck className="w-4 h-4" />}
              {status.checked_today ? '今日已签到' : '立即签到'}
            </button>
          </div>

          <div className="p-4 sm:p-5 rounded-3xl surface border border-wb-border-subtle shadow-card">
            <h2 className="text-xs font-bold text-wb-text-primary mb-3">打卡日历</h2>
            <CheckinHeatmap username={user.username} canMakeup />
          </div>

          <div>
            <h2 className="text-xs font-bold text-wb-text-primary mb-2">社区签到榜</h2>
            <Leaderboard onSelectUser={onSelectUser} />
          </div>
        </>
      )}
    </div>
  );
};
