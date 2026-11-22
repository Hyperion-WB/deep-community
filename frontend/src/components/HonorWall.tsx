import React, { useEffect, useState } from 'react';
import { Award, Lock, Sparkles, TrendingUp } from 'lucide-react';
import { apiClient } from '../api/client';
import { SegmentedControl } from './SegmentedControl';
import { Modal } from './Modal';
import { ChevronDown } from 'lucide-react';
import { MedalIcon } from './MedalIcon';
import { InlineErrorState } from './InlineErrorState';

interface SeriesItem {
  targets?: { tier: number; target: number }[];
  series: string;
  name: string;
  icon: string;
  current: number;
  unit: string;
  tier: number;
  next: { tier: number; target: number } | null;
}

interface MedalItem {
  code: string;
  name: string;
  subtitle: string;
  description: string;
  icon: string;
  tier: number;
  owned?: boolean;
  reason?: string;
}

interface WallData {
  medals: MedalItem[];
  series: SeriesItem[];
  specials: (MedalItem & { owned: boolean })[];
  eggs: (MedalItem & { owned: boolean })[];
  stats: { owned: number; rarity: Record<string, number>; total_users: number };
}

const TIER_MATERIAL = [
  { label: '铜', ring: 'from-[#b87333] to-[#7c4a1b]', text: 'text-[#c98a4b]' },
  { label: '银', ring: 'from-[#c9d3e0] to-[#7f8b9c]', text: 'text-[#aab6c6]' },
  { label: '金', ring: 'from-[#f6d365] to-[#b8860b]', text: 'text-[#e8c766]' },
  { label: '钻', ring: 'from-[#8be9fd] via-[#c4b5fd] to-[#67e8f9]', text: 'text-[#8be9fd]' },
];

/** 系列含义：解释「这个系列到底在统计什么」，避免只写数字看不懂 */
const SERIES_DESC: Record<string, string> = {
  quill: '发布正式文章的数量，草稿不计入。',
  resonance: '你发布的文章累计获得的点赞数。',
  dwell: '在社区产生互动的天数：发帖、评论、点赞等，任一天记 1 天。',
  bond: '关注你的人（粉丝）数量。',
  debate: '发出且正常展示的评论条数，被删除或封禁的不计。',
  library: '收藏他人文章的累计次数。',
  evangel: '正文里包含代码块（```）的文章数量。',
  nightowl: '在 00:00–05:59 之间发布文章的次数。',
  archae: '累计签到天数（社区每日打卡）。',
  anniv: '从注册账号到现在经过的年数。',
};

const TIER_TABS = [
  { key: 'series', label: '系列勋章' },
  { key: 'special', label: '特别成就' },
];

// 按勋章名称给一点专属小动效，避免所有徽章长得一模一样
const badgeFx = (name: string, tier: number): string => {
  if (/夜|月|星/.test(name)) return 'wb-fx-float';
  if (/Bug|虫|调试/.test(name)) return 'wb-fx-shake';
  if (/锦鲤|好运|欧气|福/.test(name)) return 'wb-fx-swing';
  if (/节|圣诞|万圣|春节|中秋|端午|跨年|平安|新年/.test(name)) return 'wb-fx-spin';
  return tier >= 3 ? 'wb-fx-pulse' : '';
};

const TierBadge: React.FC<{ tier: number; icon: string; size?: 'sm' | 'md'; locked?: boolean; label?: string }> = ({
  tier,
  icon,
  size = 'md',
  locked = false,
  label = '',
}) => {
  const material = TIER_MATERIAL[Math.max(0, Math.min(3, tier))];
  const box = size === 'sm' ? 'w-9 h-9' : 'w-12 h-12';
  return (
    <div
      className={`${box} shrink-0 rounded-full p-[2px] bg-gradient-to-br ${material.ring} ${
        locked ? 'opacity-45 grayscale' : `wb-badge-glow ${badgeFx(label, tier)}`
      }`}
    >
      <div className="relative w-full h-full rounded-full bg-wb-bg-elevated flex items-center justify-center overflow-hidden">
        {locked ? (
          <Lock className="w-3.5 h-3.5 text-wb-text-muted" />
        ) : (
          <>
            <MedalIcon name={icon} className={size === 'sm' ? 'w-4 h-4 text-wb-text-primary' : 'w-5 h-5 text-wb-text-primary'} />
            <span className="wb-badge-shine" aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  );
};

export const HonorWall: React.FC<{ userId?: string | null; title?: string }> = ({
  userId,
  title = '荣誉墙',
}) => {
  const [data, setData] = useState<WallData | null>(null);
  const [tab, setTab] = useState('series');
  const [onlyOwned, setOnlyOwned] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('geek_honor_collapsed') === '1';
    } catch {
      return false;
    }
  });
  const [detail, setDetail] = useState<
    | {
        kind: 'series' | 'special';
        title: string;
        desc: string;
        icon?: string;
        progress?: string;
        tier?: number;
        targets?: { tier: number; target: number }[];
      }
    | null
  >(null);

  const toggleCollapse = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('geek_honor_collapsed', next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoading(true);
    apiClient
      .get<WallData>(`/achievements/wall/${userId}`)
      .then((res) => {
        if (!cancelled) setData(res.data);
      })
      .catch(() => {
        if (!cancelled) { setData(null); setLoadError(true); }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, reloadKey]);

  if (loading) {
    return (
      <div className="p-8 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle text-center text-xs text-wb-text-muted">
        正在加载荣誉墙…
      </div>
    );
  }
  if (!data) {
    return loadError ? (
      <div className="rounded-3xl bg-wb-bg-surface border border-wb-border-subtle p-2">
        <InlineErrorState
          label="荣誉墙加载失败"
          onRetry={() => { setLoadError(false); setReloadKey((n) => n + 1); }}
        />
      </div>
    ) : null;
  }

  return (
    <div className="rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card overflow-hidden">
      {/* 头部 */}
      <div className="px-4 pt-4 pb-2.5 space-y-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-wb-brand/12 border border-wb-brand/25 flex items-center justify-center">
              <Award className="w-4 h-4 text-wb-brand" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-wb-text-primary leading-tight">{title}</h3>
              <p className="text-2xs text-wb-text-muted">
                已获 <span className="text-wb-text-primary font-semibold">{data.stats.owned}</span> 枚
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-1.5 text-2xs text-wb-text-muted">
              <TrendingUp className="w-3 h-3" />
              10 个系列 · 越往上越稀有
            </div>
            <button
              type="button"
              onClick={toggleCollapse}
              title={collapsed ? '展开荣誉墙' : '收起荣誉墙'}
              className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${collapsed ? '' : 'rotate-180'}`} />
            </button>
          </div>
        </div>

        <SegmentedControl id="honor-tabs" size="sm" items={TIER_TABS} activeKey={tab} onChange={setTab} />
      </div>

      {!collapsed && (<div className="px-4 pb-4 max-h-[42vh] overflow-y-auto overscroll-contain">
        {/* 系列 */}
        {tab === 'series' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-2xs text-wb-text-muted">
                共 {data.series.length} 个系列 · 已解锁 {data.series.filter((i) => i.tier >= 0).length}
              </span>
              <button
                type="button"
                onClick={() => setOnlyOwned((v) => !v)}
                className={`h-6 px-2 rounded-capsule text-2xs font-medium border transition-colors ${
                  onlyOwned
                    ? 'border-wb-brand/50 bg-wb-brand/12 text-wb-text-primary'
                    : 'border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary'
                }`}
              >
                只看已解锁
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {data.series.filter((item) => (onlyOwned ? item.tier >= 0 : true)).map((item) => {
              const material = TIER_MATERIAL[Math.max(0, item.tier)];
              const nextTarget = item.next?.target ?? 0;
              const pct = nextTarget
                ? Math.min(100, Math.round((item.current / Math.max(1, nextTarget)) * 100))
                : item.tier >= 0 ? 100 : 0;
              const statusText =
                item.tier >= 0 && !item.next
                  ? '已满级'
                  : item.next
                    ? `${item.current} / ${item.next.target} ${item.unit}`
                    : '未开始';
              return (
                <button
                  type="button"
                  key={item.series}
                  onClick={() =>
                    setDetail({
                      kind: 'series',
                      title: item.name,
                      icon: item.icon,
                      tier: item.tier,
                      targets: item.targets,
                      desc: SERIES_DESC[item.series] || '该系列的达成条件。',
                      progress: statusText,
                    })
                  }
                  className={`text-left p-2.5 rounded-xl border space-y-1.5 transition-all hover:-translate-y-0.5 ${
                    item.tier >= 0
                      ? 'border-wb-brand/30 bg-gradient-to-br from-wb-brand/10 to-transparent'
                      : 'border-wb-border-subtle bg-wb-bg-subtle/40 hover:border-wb-border-strong'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <TierBadge tier={item.tier < 0 ? 0 : item.tier} icon={item.icon} size="sm" locked={item.tier < 0} label={item.name} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-wb-text-primary truncate">{item.name}</span>
                        <span className={`text-2xs font-bold ${item.tier < 0 ? 'text-wb-text-muted' : material.text}`}>
                          {item.tier < 0 ? '未解锁' : `${material.label}级`}
                        </span>
                      </div>
                      <div className="text-2xs text-wb-text-muted font-mono">{statusText}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {[0, 1, 2, 3].map((tier) => (
                      <span
                        key={tier}
                        className={`h-1.5 flex-1 rounded-full ${
                          item.tier >= tier
                            ? `bg-gradient-to-r ${TIER_MATERIAL[tier].ring}`
                            : 'bg-wb-bg-subtle'
                        }`}
                      />
                    ))}
                  </div>
                  {item.next && (
                    <div className="h-1 rounded-full bg-wb-bg-subtle overflow-hidden">
                      <div
                        className={`h-full rounded-full bg-gradient-to-r ${material.ring} transition-[width] duration-500`}
                        style={{ width: `${Math.max(6, pct)}%` }}
                      />
                    </div>
                  )}
                </button>
              );
            })}
            </div>
          </div>
        )}

        {/* 特别成就 */}
        {tab === 'special' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {data.specials.map((item) => (
              <div
                key={item.code}
                className={`flex items-center gap-2.5 p-2.5 rounded-2xl border ${
                  item.owned
                    ? 'border-wb-brand/30 bg-wb-brand/8'
                    : 'border-wb-border-subtle bg-wb-bg-subtle/30'
                }`}
              >
                <TierBadge tier={item.tier} icon={item.icon} size="sm" locked={!item.owned} label={item.name} />
                <div className="min-w-0">
                  <div className={`text-xs font-semibold truncate ${item.owned ? 'text-wb-text-primary' : 'text-wb-text-secondary'}`}>
                    {item.name}
                  </div>
                  <div className="text-2xs text-wb-text-muted truncate">{item.description}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>)}

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} widthClass="max-w-md">
        <div className="p-5 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-wb-brand/12 border border-wb-brand/25 flex items-center justify-center">
              <MedalIcon name={detail?.icon} className="w-5 h-5 text-wb-brand" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-wb-text-primary">{detail?.title}</h3>
              <p className="text-2xs text-wb-text-muted">
                {detail?.kind === 'special' ? '特别成就' : '系列勋章'}
              </p>
            </div>
          </div>
          <p className="text-xs text-wb-text-secondary leading-relaxed">{detail?.desc}</p>
          {detail?.progress && (
            <p className="text-2xs text-wb-text-muted font-mono">当前进度：{detail.progress}</p>
          )}
          {detail?.kind === 'series' && (detail as any).targets?.length > 0 && (
            <div className="rounded-xl border border-wb-border-subtle divide-y divide-wb-border-subtle overflow-hidden">
              {(detail as any).targets.map((t: { tier: number; target: number }) => {
                const done = (detail.tier ?? -1) >= t.tier;
                return (
                  <div key={t.tier} className="flex items-center justify-between px-3 py-1.5 text-2xs">
                    <span className={done ? 'text-wb-text-primary font-semibold' : 'text-wb-text-muted'}>
                      {TIER_MATERIAL[t.tier].label}级
                    </span>
                    <span className="font-mono text-wb-text-muted">
                      需 {t.target} {data.series.find((s2) => s2.name === detail.title)?.unit || ''}
                    </span>
                    <span className={done ? 'text-wb-brand' : 'text-wb-text-muted'}>{done ? '已获得' : '未获得'}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="pt-1 flex justify-end">
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="wb-pressable px-4 py-1.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-bold"
            >
              知道了
            </button>
          </div>
        </div>
      </Modal>

      {/* 底部说明 */}
      {!collapsed && <div className="px-4 py-2 border-t border-wb-border-subtle flex items-center gap-1.5 text-2xs text-wb-text-muted">
        <Sparkles className="w-3 h-3 text-wb-brand" />
        系列勋章会随发帖、获赞、活跃自动升级；特别成就由系统或超级管理员颁发。
      </div>}
    </div>
  );
};
