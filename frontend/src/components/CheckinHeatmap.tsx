import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Flame, Ticket } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmModal';
import { InlineErrorState } from './InlineErrorState';

interface Props {
  username: string;
  /** 是否展示补签交互（只有本人主页才显示） */
  canMakeup?: boolean;
}

const DEFAULT_MILESTONES = [5, 10, 15, 25];

const ymd = (d: Date) => {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

/**
 * 打卡日历（按月视图）。
 *
 * 数据口径：
 * - 签到状态只看接口返回的 checkins（含补签），不再用「发帖/评论活跃度」冒充签到，
 *   否则只发了帖没签到的日子也会打勾，看起来像已经签过。
 * - 补签日单独标记，便于区分「当天真签」和「事后补的」。
 * - 活动量（发帖 +2 / 评论 +1）只作为未签到日的辅助提示。
 */
export const CheckinHeatmap: React.FC<Props> = ({ username, canMakeup = false }) => {
  const toast = useToast();
  const confirm = useConfirm();

  const [counts, setCounts] = useState<Record<string, number>>({});
  const [checkins, setCheckins] = useState<Set<string>>(() => new Set());
  const [makeups, setMakeups] = useState<Set<string>>(() => new Set());
  const [total, setTotal] = useState(0);
  const [streak, setStreak] = useState(0);
  const [registeredAt, setRegisteredAt] = useState('');
  // 接口只返回最近一年数据：更早的月份不再允许翻页，否则整月空白会让人以为漏签
  const [windowSince, setWindowSince] = useState('');
  const [makeupLeft, setMakeupLeft] = useState(0);
  const [milestones, setMilestones] = useState<number[]>(DEFAULT_MILESTONES);
  const [makeupSince, setMakeupSince] = useState('');
  const [makeupUntil, setMakeupUntil] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [busyDate, setBusyDate] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const requests: Promise<any>[] = [
        apiClient.get('/stats/heatmap', { params: { username, days: 365 } }),
      ];
      if (canMakeup) requests.push(apiClient.get('/users/checkin/status'));
      const [heatRes, statusRes] = await Promise.all(requests);
      const data = heatRes?.data || {};

      setCounts(data.counts || {});
      setCheckins(new Set<string>(Array.isArray(data.checkins) ? data.checkins : []));
      setMakeups(new Set<string>(Array.isArray(data.makeups) ? data.makeups : []));
      setTotal(Number(data.total_checkins) || 0);
      setStreak(Number(data.streak) || 0);
      setRegisteredAt(data.registered_at || '');
      setWindowSince(data.since || '');

      if (canMakeup && statusRes) {
        const s = statusRes.data || {};
        setMakeupLeft(Number(s.makeup_left) || 0);
        setMilestones(
          Array.isArray(s.milestones) && s.milestones.length ? s.milestones : DEFAULT_MILESTONES
        );
        // 补签边界由后端给出：不早于注册日、不晚于昨天、且最多回溯半年
        setMakeupSince(s.makeup_since || data.registered_at || '');
        setMakeupUntil(s.makeup_until || '');
        setStreak(Number(s.streak) || Number(data.streak) || 0);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [username, canMakeup]);

  useEffect(() => {
    void load();
  }, [load]);

  // 签到页/其他入口完成签到或补签后，热力图跟着刷新
  useEffect(() => {
    const onDone = () => void load();
    window.addEventListener('geek:checkin-done', onDone);
    return () => window.removeEventListener('geek:checkin-done', onDone);
  }, [load]);

  const todayKey = ymd(new Date());
  const yesterdayKey = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return ymd(d);
  }, []);

  const makeupEnd = makeupUntil || yesterdayKey;

  // 当月网格：只渲染这个月真正覆盖到的周，不再硬凑 6 行
  const { cells, monthSigned } = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const shift = (first.getDay() + 6) % 7; // 周一 = 0
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const rows = Math.ceil((shift + daysInMonth) / 7);
    const start = new Date(year, month, 1 - shift);
    const list: {
      date: string;
      day: number;
      inMonth: boolean;
      signed: boolean;
      makeup: boolean;
      activity: number;
      future: boolean;
    }[] = [];
    let signedCount = 0;
    for (let i = 0; i < rows * 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = ymd(d);
      const signed = checkins.has(key);
      if (signed && d.getMonth() === month) signedCount += 1;
      list.push({
        date: key,
        day: d.getDate(),
        inMonth: d.getMonth() === month,
        signed,
        makeup: makeups.has(key),
        activity: counts[key] || 0,
        future: key > todayKey,
      });
    }
    return { cells: list, monthSigned: signedCount };
  }, [cursor, checkins, makeups, counts, todayKey]);

  const handleDayClick = async (cell: {
    date: string;
    signed: boolean;
    future: boolean;
    inMonth: boolean;
  }) => {
    if (busyDate) return;
    if (!canMakeup || !cell.inMonth || cell.future || cell.signed) return;
    if (cell.date > makeupEnd) return;
    if (makeupSince && cell.date < makeupSince) {
      toast.info('只能补签注册之后的日期');
      return;
    }
    if (makeupLeft <= 0) {
      toast.info(
        `补签卡不足：本月可获得 0 张（连续签到 ${milestones.join(' / ')} 天各 +1 张，每月 1 号重置，补签日不计入）`
      );
      return;
    }

    const ok = await confirm({
      title: '使用补签卡',
      description: `补签 ${cell.date}（消耗 1 张补签卡，本月剩余 ${makeupLeft} 张）。\n补签会计入连续签到天数，但补签日不计入连签奖励；操作不可撤销。`,
      confirmText: '确认补签',
      cancelText: '再想想',
    });
    if (!ok) return;

    setBusyDate(cell.date);
    try {
      const res = await apiClient.post('/users/checkin/makeup', { date: cell.date });
      const left = Number(res.data?.makeup_left);
      if (!Number.isNaN(left)) setMakeupLeft(left);
      if (Number(res.data?.streak) >= 0) setStreak(Number(res.data.streak));
      toast.success(
        `已补签 ${cell.date}${Number(res.data?.streak) ? ` · 连续 ${res.data.streak} 天` : ''}`
      );
      await load();
      window.dispatchEvent(new CustomEvent('geek:checkin-done'));
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '补签失败');
    } finally {
      setBusyDate(null);
    }
  };

  const monthLabel = `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`;
  const canGoNext = cursor < new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  // 可回看的最早月份：取「数据窗口起点」与「注册月份」中较晚者
  const earliestKey = [windowSince, registeredAt].filter(Boolean).sort().pop() || '';
  const earliestMonth = earliestKey ? new Date(`${earliestKey}T00:00:00`) : null;
  const canGoPrev =
    !earliestMonth ||
    new Date(cursor.getFullYear(), cursor.getMonth(), 1) >
      new Date(earliestMonth.getFullYear(), earliestMonth.getMonth(), 1);

  return (
    <div className="space-y-3 pt-3 border-t border-wb-border-subtle">
      {loadError && (
        <InlineErrorState compact label="打卡数据加载失败" onRetry={() => void load()} />
      )}

      <div className="flex items-start justify-between flex-wrap gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Flame className="w-3.5 h-3.5 text-wb-brand" />
            <span className="text-xs font-semibold text-wb-text-primary">打卡日历</span>
            <span className="text-3xs text-wb-text-muted font-mono">
              连续 {streak} 天 · 累计 {total} 天
            </span>
          </div>
          <p className="text-3xs text-wb-text-muted">
            本月已签 <span className="font-semibold text-wb-text-secondary">{monthSigned}</span> 天
          </p>
        </div>

        <div className="flex items-center gap-1">
          {canMakeup && (
            <span
              className={`inline-flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded-capsule font-semibold mr-1 ${
                makeupLeft > 0
                  ? 'bg-wb-brand/10 text-wb-brand'
                  : 'bg-wb-bg-subtle text-wb-text-muted'
              }`}
              title={`每月按真实连签发放：连续签到 ${milestones.join(' / ')} 天各 +1 张，每月 1 号重置`}
            >
              <Ticket className="w-3 h-3" />
              本月补签卡 {makeupLeft}
            </span>
          )}
          <button
            type="button"
            onClick={() => canGoPrev && setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            disabled={!canGoPrev}
            className="p-1 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
            title="上个月"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="text-2xs font-mono text-wb-text-secondary min-w-[86px] text-center">
            {monthLabel}
          </span>
          <button
            type="button"
            onClick={() => canGoNext && setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            disabled={!canGoNext}
            className="p-1 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
            title="下个月"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[10px] text-wb-text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-[3px] bg-wb-brand" />
          已签到
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-[3px] bg-wb-brand/25 border border-dashed border-wb-brand/70" />
          补签
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-[3px] bg-wb-bg-subtle relative">
            <span className="absolute right-[1px] top-[1px] w-1 h-1 rounded-full bg-wb-info" />
          </span>
          未签到但有动态
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-[3px] bg-wb-bg-subtle/50" />
          无记录
        </span>
      </div>

      <div className="grid grid-cols-7 gap-1 w-full max-w-[280px] mx-auto">
        {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
          <span key={w} className="text-[10px] text-wb-text-muted text-center pb-0.5">
            {w}
          </span>
        ))}
        {cells.map((cell) => {
          const isToday = cell.date === todayKey;
          const inMakeupRange =
            canMakeup && cell.inMonth && !cell.future && !cell.signed &&
            (!makeupSince || cell.date >= makeupSince) && cell.date <= makeupEnd;
          const clickable = inMakeupRange;
          const missingButNotEnough = inMakeupRange && makeupLeft <= 0;

          const tone = cell.signed
            ? cell.makeup
              ? 'bg-wb-brand/25 border border-dashed border-wb-brand/70 text-wb-text-primary'
              : 'bg-wb-brand text-wb-bg-page font-semibold'
            : cell.activity > 0
            ? 'bg-wb-bg-subtle text-wb-text-secondary'
            : 'bg-wb-bg-subtle/50 text-wb-text-muted';

          const label = cell.signed
            ? `${cell.date} · 已签到${cell.makeup ? '（补签）' : ''}`
            : cell.future
            ? `${cell.date} · 未到日期`
            : `${cell.date} · 未签到${cell.activity > 0 ? ` · 当日活跃 ${cell.activity}` : ''}`;

          return (
            <button
              key={cell.date}
              type="button"
              // 不用 disabled：禁用状态在多数浏览器里不触发 hover，签到/补签信息就看不到了
              aria-disabled={!clickable}
              onClick={() => handleDayClick(cell)}
              aria-label={label}
              aria-pressed={cell.signed}
              title={
                clickable
                  ? `${label}（${missingButNotEnough ? '补签卡不足' : '点击使用补签卡'}）`
                  : label
              }
              className={`relative before:absolute before:-inset-1 before:content-[''] w-full aspect-square max-h-[32px] rounded-[6px] flex items-center justify-center text-[10px] leading-none transition-all ${tone} ${
                isToday ? 'ring-2 ring-wb-info ring-offset-1 ring-offset-wb-bg-surface' : ''
              } ${!cell.inMonth ? 'opacity-25' : ''} ${
                clickable ? 'cursor-pointer hover:ring-1 hover:ring-wb-brand/70' : 'cursor-default'
              } ${busyDate === cell.date ? 'animate-pulse' : ''}`}
            >
              {cell.signed && !cell.makeup ? (
                <Check className="w-3 h-3" strokeWidth={3} />
              ) : (
                <span>{cell.day}</span>
              )}
              {/* 未签到但有动态：右下角一个小圆点，提示这天发过帖/评论 */}
              {!cell.signed && cell.activity > 0 && (
                <span className="absolute right-[3px] bottom-[3px] w-1 h-1 rounded-full bg-wb-info" />
              )}
            </button>
          );
        })}
      </div>

      {canMakeup && (
        <p className="text-[10px] leading-relaxed text-wb-text-muted">
          补签卡：每月按「真实连签」发放，连续签到 {milestones.join(' / ')} 天各 +1 张，1 号重置；补签日不计入连签奖励，
          {makeupSince ? `可补 ${makeupSince} 至 ${makeupEnd}` : `可补至 ${makeupEnd}`}，每次消耗 1 张且不可撤销。
          {makeupLeft <= 0 && ' 当前没有补签卡，继续签到积攒连击即可获得。'}
        </p>
      )}

      {loading && <p className="text-3xs text-wb-text-muted text-center">加载中…</p>}
    </div>
  );
};
