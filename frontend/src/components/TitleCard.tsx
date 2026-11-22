import React, { useEffect, useMemo, useState } from 'react';
import { Check, Lock, Sparkles, Tag } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';
import { MedalIcon } from './MedalIcon';
import { InlineErrorState } from './InlineErrorState';

interface Medal {
  code: string;
  name: string;
  tier: number;
  icon?: string;
  /** 成就分类：special 为特殊称号，custom 为自定义称号 */
  category?: string;
}

interface Props {
  userId: string;
  currentTitle?: string | null;
  canEdit: boolean;
  onUpdated?: (profile: any) => void;
  profile?: any;
}

/** 经典称号：条件与服务端白名单保持一致，用于前端展示「已解锁/未解锁」 */
const CLASSIC_TITLES: { name: string; need: string; check: (p: any) => boolean }[] = [
  { name: '全栈拓荒者', need: '发布 3 篇文章', check: (p) => (p?.posts_count || 0) >= 3 },
  { name: '代码洁癖患者', need: '发布 2 篇文章', check: (p) => (p?.posts_count || 0) >= 2 },
  { name: '午夜守护者', need: '活跃 5 天', check: (p) => (p?.active_days || 0) >= 5 },
  { name: '分布式引力源', need: '10 个粉丝', check: (p) => (p?.followers_count || 0) >= 10 },
  { name: '深渊观测者', need: '阅读历史本地统计', check: () => true },
  { name: '幽灵信使', need: '50 经验', check: (p) => (p?.experience || 0) >= 50 },
  { name: '高并发捕手', need: '达到 Lv.4', check: (p) => (p?.level || 0) >= 4 },
  { name: '赛博哲人', need: '达到 Lv.5', check: (p) => (p?.level || 0) >= 5 },
  { name: '架构总设计师', need: '10 篇文章 + Lv.3', check: (p) => (p?.posts_count || 0) >= 10 && (p?.level || 0) >= 3 },
  { name: 'Bug 终结者', need: '100 经验', check: (p) => (p?.experience || 0) >= 100 },
  { name: '百炼成钢', need: '500 经验', check: (p) => (p?.experience || 0) >= 500 },
  { name: '星系引力', need: '50 个粉丝', check: (p) => (p?.followers_count || 0) >= 50 },
  { name: '专栏主笔', need: '发布 20 篇文章', check: (p) => (p?.posts_count || 0) >= 20 },
];

// 榜单称号：每天随排名轮换，只在当天有效
const LIMITED_TITLES = [
  '签到活化石', '老牌打卡钉子户', '长期蹲岗选手', '签到常驻流民', '坚持混资历选手',
  '破晓抢签卷王', '闹钟忠实奴隶', '天没亮就上线', '迷迷糊糊抢先手', '勉强赶个早集',
  '话痨发电机', '楼中楼战神', '凑热闹专业户', '到处串门唠嗑', '间歇性冒泡选手',
];

// 每个榜单称号只属于「某个榜单的某个名次」：
// 上了哪个榜的第几名，就只能佩戴那一个称号，其余保持灰色
const TITLE_RANK_MAP: Record<string, { board: 'total' | 'early' | 'active'; rank: number }> = {
  '签到活化石': { board: 'total', rank: 1 },
  '老牌打卡钉子户': { board: 'total', rank: 2 },
  '长期蹲岗选手': { board: 'total', rank: 3 },
  '签到常驻流民': { board: 'total', rank: 4 },
  '坚持混资历选手': { board: 'total', rank: 5 },
  '破晓抢签卷王': { board: 'early', rank: 1 },
  '闹钟忠实奴隶': { board: 'early', rank: 2 },
  '天没亮就上线': { board: 'early', rank: 3 },
  '迷迷糊糊抢先手': { board: 'early', rank: 4 },
  '勉强赶个早集': { board: 'early', rank: 5 },
  '话痨发电机': { board: 'active', rank: 1 },
  '楼中楼战神': { board: 'active', rank: 2 },
  '凑热闹专业户': { board: 'active', rank: 3 },
  '到处串门唠嗑': { board: 'active', rank: 4 },
  '间歇性冒泡选手': { board: 'active', rank: 5 },
};

type TitleCategory = 'normal' | 'egg' | 'special' | 'limited';

const CATEGORY_TABS: { key: TitleCategory; label: string; hint: string }[] = [
  { key: 'normal', label: '普通称号', hint: '达到条件即可佩戴' },
  { key: 'special', label: '特殊称号', hint: '由超级管理员颁发' },
  { key: 'limited', label: '限时称号', hint: '榜单名次称号，仅当天有效' },
];

export const TitleCard: React.FC<Props> = ({ userId, currentTitle, canEdit, onUpdated, profile }) => {
  const toast = useToast();
  const [medals, setMedals] = useState<Medal[]>([]);
  const [category, setCategory] = useState<TitleCategory>('normal');
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // 当天节日勋章：动态并入「限时称号」分类，仅当天可佩戴
  const [festivalTitle, setFestivalTitle] = useState<{ name: string; icon: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!canEdit) return;
    apiClient.get('/achievements/festival')
      .then((res) => {
        if (res.data?.active) setFestivalTitle({ name: res.data.name, icon: res.data.icon });
      })
      .catch(() => undefined);
  }, [canEdit]);

  // 榜单称号联动：当前用户是否在三个榜单前 5，在的话对应限时称号点亮
  const [boardNames, setBoardNames] = useState<Record<string, Record<string, number>>>({});
  useEffect(() => {
    let alive = true;
    apiClient
      .get('/stats/leaderboards')
      .then((res) => {
        if (!alive) return;
        const map: Record<string, Record<string, number>> = {};
        for (const board of ['total', 'early', 'active'] as const) {
          for (const row of res.data?.[board] || []) {
            if (!row.username) continue;
            (map[row.username] ||= {})[board] = row.rank;
          }
        }
        setBoardNames(map);
      })
      .catch(() => { if (alive) setLoadError(true); });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Medal[]>(`/achievements/user/${userId}`)
      .then((res) => {
        if (!cancelled) setMedals(Array.isArray(res.data) ? res.data : []);
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => {
      cancelled = true;
    };
  }, [userId, reloadKey]);

  const options = useMemo(() => {
    const specialOptions = medals
      .filter((m) => String(m.code || '').startsWith('custom_'))
      .map((m) => ({
        name: m.name, icon: m.icon, unlocked: true,
        need: '超级管理员颁发', fromMedal: true, category: 'special' as TitleCategory,
      }));
    const hiddenEggOptions = medals
      .filter((m) => m.category === 'hidden')
      .map((m) => ({
        name: m.name, icon: m.icon, unlocked: true,
        need: '已获得的隐藏成就', fromMedal: true, category: 'egg' as TitleCategory,
      }));
    const medalAsNormal = medals
      .filter((m) => !String(m.code || '').startsWith('custom_') && m.category !== 'hidden')
      .map((m) => ({
        name: m.name, icon: m.icon, unlocked: true,
        need: '已获得的勋章', fromMedal: true, category: 'normal' as TitleCategory,
      }));
    const classicOptions = CLASSIC_TITLES.map((t) => ({
      name: t.name, icon: undefined as string | undefined,
      unlocked: t.check(profile), need: t.need, fromMedal: false,
      category: 'normal' as TitleCategory,
    }));
    // 避免不同来源的同名称号在面板里出现多份
    const seenEggNames = new Set<string>();
    const eggOptions = hiddenEggOptions.filter((o) => {
      if (seenEggNames.has(o.name)) return false;
      seenEggNames.add(o.name);
      return true;
    });
    const limitedOptions = LIMITED_TITLES.map((name) => ({
      name, icon: '⚡' as string | undefined,
      unlocked: (() => {
        const hit = TITLE_RANK_MAP[name];
        if (!hit) return false;
        const my = boardNames[profile?.username || ''] || {};
        return my[hit.board] === hit.rank;
      })(),
      need: '登上对应榜单名次（当天有效）', fromMedal: false,
      category: 'limited' as TitleCategory,
    }));
    const festivalOptions = festivalTitle ? [{
      name: festivalTitle.name,
      icon: festivalTitle.icon,
      unlocked: true,
      need: '今日限定，明天归还',
      fromMedal: false,
      category: 'limited' as TitleCategory,
    }] : [];
    return [
      ...specialOptions,
      ...eggOptions,
      ...medalAsNormal,
      ...classicOptions,
      ...festivalOptions,
      ...limitedOptions,
    ];
  }, [medals, profile, currentTitle, boardNames, festivalTitle]);

  const equip = async (title: string | null) => {
    if (!canEdit || saving) return;
    if ((title || '') === (currentTitle || '')) return;
    setSaving(true);
    try {
      const res = await apiClient.put('/users/me', { equipped_title: title || '' });
      if (res.data) onUpdated?.(res.data);
      toast.success(title ? `已佩戴称号「${title}」` : '已卸下称号');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '称号设置失败');
    } finally {
      setSaving(false);
    }
  };

  const unlockedCount = options.filter((o) => o.unlocked).length;

  return (
    <div className="rounded-3xl border border-wb-border-subtle bg-wb-bg-surface shadow-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-wb-text-primary">
          <Tag className="w-3.5 h-3.5 text-wb-brand" />
          <span>佩戴称号</span>
          <span className="text-2xs font-normal text-wb-text-muted">
            已解锁 {unlockedCount}/{options.length}
          </span>
        </div>
        {currentTitle ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-capsule bg-wb-brand/12 border border-wb-brand/25 text-2xs font-semibold text-wb-brand">
            <Sparkles className="w-3 h-3" />
            {currentTitle}
          </span>
        ) : (
          <span className="text-2xs text-wb-text-muted">未佩戴</span>
        )}
      </div>

      {loadError && (
        <InlineErrorState
          compact
          label="称号数据加载失败"
          onRetry={() => { setLoadError(false); setReloadKey((n) => n + 1); }}
        />
      )}

      {/* 称号四分类 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {CATEGORY_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={category === t.key}
            onClick={() => setCategory(t.key)}
            title={t.hint}
            className={`h-9 px-2.5 rounded-capsule text-2xs font-semibold border transition-colors ${
              category === t.key
                ? 'bg-wb-text-primary text-wb-bg-page border-wb-text-primary'
                : 'border-wb-border-subtle text-wb-text-muted hover:text-wb-text-primary hover:border-wb-border-strong'
            }`}
          >
            {t.label}
            <span className="ml-1 opacity-80">
              {options.filter((o) => o.category === t.key).length}
            </span>
          </button>
        ))}
      </div>
      <p className="text-3xs text-wb-text-muted -mt-1">
        {CATEGORY_TABS.find((t) => t.key === category)?.hint}
      </p>

      {canEdit ? (
        <div className="flex flex-wrap gap-1.5">
          {options.filter((o) => o.category === category).map((option) => {
            const active = option.name === currentTitle;
            // 限时称号没上榜就不可佩戴：直接禁用而不是点了再提示
            const locked = category === 'limited' && !option.unlocked;
            return (
              <button
                key={option.name}
                type="button"
                disabled={saving || locked}
                title={option.unlocked ? option.need : `未解锁：${option.need}`}
                onClick={() => {
                  if (!option.unlocked) {
                    toast.info(`「${option.name}」尚未解锁：${option.need}`);
                    return;
                  }
                  equip(active ? null : option.name);
                }}
                className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-capsule border text-2xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  active
                    ? 'border-wb-brand/60 bg-wb-brand/12 text-wb-text-primary'
                    : option.unlocked
                      ? 'border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary hover:border-wb-border-strong'
                      : 'border-dashed border-wb-border-subtle text-wb-text-muted/70'
                }`}
              >
                {option.unlocked ? (
                  <MedalIcon name={option.icon} className="w-3 h-3" />
                ) : (
                  <Lock className="w-3 h-3" />
                )}
                <span className="truncate max-w-[7rem]">{option.name}</span>
                {active && <Check className="w-3 h-3 text-wb-brand" />}
              </button>
            );
          })}
          <button
            type="button"
            disabled={saving || !currentTitle}
            onClick={() => equip(null)}
            className="inline-flex items-center h-8 px-2.5 rounded-capsule border border-dashed border-wb-border-subtle text-2xs text-wb-text-muted hover:text-wb-text-primary disabled:opacity-40"
          >
            卸下称号
          </button>
        </div>
      ) : (
        <p className="text-2xs text-wb-text-muted">称号由用户本人佩戴。</p>
      )}
    </div>
  );
};
