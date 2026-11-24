import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, CalendarDays, Camera, ChevronLeft, ChevronRight, Heart, ImagePlus, MessageCircle, Plus, Trash2, X } from 'lucide-react';
import { apiClient, UPLOAD_TIMEOUT } from '../api/client';
import { UserAvatar } from './UserAvatar';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmModal';
import type { UserProfile } from '../types';

interface CardAuthor {
  id: string;
  username: string;
  nickname: string;
  avatar_url: string;
}

interface FoodCardItem {
  id: string;
  dish_names: string[];
  content: string;
  image_urls: string[];
  meal_type: string;
  source: string;
  like_count: number;
  comment_count: number;
  liked: boolean;
  created_at: string | null;
  author: CardAuthor;
}

interface FoodComment {
  id: string;
  content: string;
  emoji_key: string | null;
  parent_id: string | null;
  like_count: number;
  liked: boolean;
  status: 'visible' | 'deleted';
  created_at: string | null;
  author: { username: string; nickname: string; avatar_url: string };
}

interface Props {
  onClose: () => void;
  user: UserProfile | null;
  embedded?: boolean;
}

const MEALS: { key: string; label: string }[] = [
  { key: 'breakfast', label: '早餐' },
  { key: 'lunch', label: '午餐' },
  { key: 'dinner', label: '晚餐' },
  { key: 'other', label: '其他' },
];

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const timeAgo = (iso: string | null) => {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}-${d.getDate()}`;
};

/** 精致表情：本地 3D 图片，加载失败时退化为文字 */
const FoodEmoji: React.FC<{ name?: string | null; size?: number; fallback?: string }> = ({ name, size = 22, fallback = '🍽️' }) => {
  const [broken, setBroken] = useState(false);
  if (!name || broken) return <span style={{ fontSize: size - 2, lineHeight: 1 }}>{fallback}</span>;
  return (
    <img
      src={`/food-emoji/${name}.png`}
      alt=""
      width={size}
      height={size}
      className="object-contain"
      onError={() => setBroken(true)}
      draggable={false}
    />
  );
};

const pad2 = (n: number) => String(n).padStart(2, '0');
const fmtDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 站内风格日期选择器：黑白日历 + 今天/清除，替代原生蓝色弹层 */
const DatePicker: React.FC<{
  value: string;
  active: boolean;
  onChange: (date: string) => void;
  onClear: () => void;
}> = ({ value, active, onChange, onClear }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const selected = value ? new Date(`${value}T00:00:00`) : new Date();
  const [cursor, setCursor] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (value) {
      const d = new Date(`${value}T00:00:00`);
      setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
    }
  }, [value]);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const start = new Date(year, month, 1);
  const offset = (start.getDay() + 6) % 7; // 周一为第一列
  const days = new Date(year, month + 1, 0).getDate();
  const todayStr = fmtDate(new Date());
  const canNext = new Date(year, month, 1) < new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const pick = (day: number) => {
    onChange(fmtDate(new Date(year, month, day)));
    setOpen(false);
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`h-7 px-2 rounded-capsule border text-[10px] font-semibold inline-flex items-center gap-1 transition-colors ${
          active
            ? 'border-wb-text-primary text-wb-text-primary bg-wb-text-primary/5'
            : 'border-wb-border-subtle text-wb-text-muted hover:text-wb-text-primary'
        }`}
      >
        <CalendarDays className="w-3 h-3" />
        {active ? value : '选择日期'}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="选择日期"
          className="absolute right-0 top-full mt-2 z-[60] w-64 p-3 rounded-2xl bg-wb-bg-surface border border-wb-border-strong shadow-[0_18px_50px_rgba(0,0,0,.35)]"
        >
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={() => setCursor(new Date(year, month - 1, 1))}
              aria-label="上个月" className="w-6 h-6 rounded-full hover:bg-wb-bg-subtle inline-flex items-center justify-center text-wb-text-secondary">
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs font-bold text-wb-text-primary">{year} 年 {month + 1} 月</span>
            <button type="button" disabled={!canNext} onClick={() => setCursor(new Date(year, month + 1, 1))}
              aria-label="下个月" className="w-6 h-6 rounded-full hover:bg-wb-bg-subtle inline-flex items-center justify-center text-wb-text-secondary disabled:opacity-30">
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
              <span key={w} className="text-center text-[9px] text-wb-text-muted">{w}</span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {Array.from({ length: 42 }).map((_, i) => {
              const day = i - offset + 1;
              if (day < 1 || day > days) return <span key={i} />;
              const dateStr = fmtDate(new Date(year, month, day));
              const isSelected = active && value === dateStr;
              const isToday = dateStr === todayStr;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => pick(day)}
                  className={`h-7 w-7 mx-auto rounded-full text-[10px] font-semibold transition-colors ${
                    isSelected
                      ? 'bg-wb-text-primary text-wb-bg-page'
                      : isToday
                        ? 'text-wb-text-primary ring-1 ring-wb-text-primary/40 hover:bg-wb-bg-subtle'
                        : 'text-wb-text-secondary hover:bg-wb-bg-subtle'
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between mt-2 pt-2 border-t border-wb-border-subtle">
            <button type="button" onClick={() => { onChange(todayStr); setOpen(false); }}
              className="text-[10px] text-wb-text-secondary hover:text-wb-text-primary">今天</button>
            <button type="button" onClick={() => { onClear(); setOpen(false); }}
              className="text-[10px] text-wb-text-muted hover:text-wb-text-primary">清除</button>
          </div>
        </div>
      )}
    </div>
  );
};

export const FoodTopic: React.FC<Props> = ({ onClose, user, embedded = false }) => {
  const toast = useToast();
  const confirm = useConfirm();
  const [topic, setTopic] = useState<any>(null);
  const [cards, setCards] = useState<FoodCardItem[]>([]);
  const [sort, setSort] = useState<'latest' | 'hot'>('latest');
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'yesterday' | 'custom'>('all');
  const [customDate, setCustomDate] = useState(localDate());
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [composer, setComposer] = useState(false);
  const [detail, setDetail] = useState<FoodCardItem | null>(null);

  const loadTopic = useCallback(async () => {
    try {
      const res = await apiClient.get('/food/topic');
      setTopic(res.data);
    } catch {
      toast.error('美食帖加载失败');
    }
  }, [toast]);

  const dateParam = dateFilter === 'all'
    ? ''
    : dateFilter === 'today'
      ? localDate()
      : dateFilter === 'yesterday'
        ? localDate(new Date(Date.now() - 86400000))
        : customDate;

  const loadCards = useCallback(async (nextPage = 1, append = false) => {
    setLoading(true);
    try {
      const res = await apiClient.get('/food/cards', {
        params: {
          sort, page: nextPage, page_size: 12,
          ...(dateParam ? { date: dateParam } : {}),
        },
      });
      const items: FoodCardItem[] = res.data?.items || [];
      setCards((prev) => (append ? [...prev, ...items] : items));
      setHasMore(Boolean(res.data?.has_more));
      setPage(nextPage);
    } catch {
      if (!append) setCards([]);
    } finally {
      setLoading(false);
    }
  }, [sort, dateParam]);

  useEffect(() => { void loadTopic(); }, [loadTopic]);
  useEffect(() => { void loadCards(1); }, [loadCards]);

  const toggleLike = async (card: FoodCardItem) => {
    setCards((prev) => prev.map((c) => c.id === card.id
      ? { ...c, liked: !c.liked, like_count: Math.max(0, c.like_count + (c.liked ? -1 : 1)) }
      : c));
    setDetail((prev) => (prev && prev.id === card.id
      ? { ...prev, liked: !prev.liked, like_count: Math.max(0, prev.like_count + (prev.liked ? -1 : 1)) }
      : prev));
    try {
      const res = await apiClient.post(`/food/cards/${card.id}/like`);
      setCards((prev) => prev.map((c) => c.id === card.id
        ? { ...c, liked: Boolean(res.data?.liked), like_count: Number(res.data?.like_count ?? c.like_count) }
        : c));
      setDetail((prev) => (prev && prev.id === card.id
        ? { ...prev, liked: Boolean(res.data?.liked), like_count: Number(res.data?.like_count ?? prev.like_count) }
        : prev));
    } catch {
      void loadCards(1);
    }
  };

  const removeCard = async (card: FoodCardItem) => {
    const ok = await confirm({
      title: '删除这张卡片',
      description: '删除后不可恢复，确定要删除吗？',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/food/cards/${card.id}`);
      setCards((prev) => prev.filter((c) => c.id !== card.id));
      setDetail(null);
      toast.success('已删除');
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '删除失败');
    }
  };

  return (
    <div className={embedded ? 'relative food-topic-enter' : 'fixed inset-0 z-[210] bg-wb-bg-page overflow-y-auto food-topic-enter'}>
      <div className="mx-auto w-full max-w-3xl px-3 sm:px-5 py-4 pb-24">
        <div className="flex items-center gap-2 mb-3">
          <button type="button" onClick={onClose} aria-label="返回"
            className="w-8 h-8 rounded-full bg-wb-bg-surface border border-wb-border-subtle inline-flex items-center justify-center text-wb-text-secondary hover:text-wb-text-primary">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] text-wb-text-muted leading-none mb-0.5">综合交流 · 置顶美食帖</p>
            <h1 className="text-base font-black text-wb-text-primary truncate">今天吃什么</h1>
            <p className="text-3xs text-wb-text-muted truncate">
              今日 {topic?.today_cards ?? 0} 张 · 共 {topic?.total_cards ?? 0} 张 ·
              每天 {topic?.daily_limit ?? 4} 张（转盘 {topic?.spin_limit ?? 1} + 手动 {topic?.manual_limit ?? 3}）
            </p>
          </div>
          <button type="button" onClick={() => setComposer(true)}
            className="h-8 px-3 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-bold inline-flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" /> 发卡片
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1 mb-3">
          {([['latest', '最新'], ['hot', '最热']] as const).map(([key, label]) => (
            <button key={key} type="button" onClick={() => setSort(key)}
              className={`h-7 px-3 rounded-capsule text-2xs font-semibold transition-colors ${
                sort === key ? 'bg-wb-text-primary text-wb-bg-page' : 'bg-wb-bg-subtle text-wb-text-secondary'
              }`}>
              {label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1">
            {([['all', '全部'], ['today', '今天'], ['yesterday', '昨天']] as const).map(([key, label]) => (
              <button key={key} type="button"
                onClick={() => setDateFilter(key)}
                className={`h-7 px-2 rounded-capsule text-[10px] font-semibold transition-colors ${
                  dateFilter === key ? 'bg-wb-text-primary text-wb-bg-page' : 'text-wb-text-muted hover:text-wb-text-primary'
                }`}>{label}</button>
            ))}
            <DatePicker
              value={customDate}
              active={dateFilter === 'custom'}
              onChange={(d) => { setCustomDate(d); setDateFilter('custom'); }}
              onClear={() => setDateFilter('all')}
            />
          </div>
        </div>
        {topic?.my_cards_today >= (topic?.daily_limit ?? 4) && (
          <p className="text-[10px] text-wb-text-muted mb-2">今天的卡片额度已用完（转盘 1 + 手动 3），明天再来</p>
        )}

        {loading && cards.length === 0 ? (
          <p className="py-16 text-center text-2xs text-wb-text-muted">正在加载美食…</p>
        ) : cards.length === 0 ? (
          <p className="py-16 text-center text-2xs text-wb-text-muted">还没有人晒饭，来做第一个吧</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {cards.map((card) => (
              <article key={card.id}
                className="group rounded-2xl overflow-hidden bg-wb-bg-surface border border-wb-border-subtle transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-wb-border-strong">
                {card.image_urls[0] && (
                  <button type="button" onClick={() => setDetail(card)} className="block w-full">
                    <img src={card.image_urls[0]} alt="" loading="lazy"
                      className="w-full aspect-[4/3] object-cover bg-wb-bg-subtle" />
                  </button>
                )}
                <div className="p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {card.dish_names.map((d) => (
                      <span key={d} title={d}
                        className="px-1.5 py-0.5 rounded-capsule bg-wb-warn/10 text-wb-warn text-3xs font-semibold max-w-[8rem] truncate">
                        {d}
                      </span>
                    ))}
                    {card.source === 'spin' && (
                      <span className="px-1.5 py-0.5 rounded-capsule bg-wb-brand/10 text-wb-brand text-3xs">转盘</span>
                    )}
                  </div>
                  <button type="button" onClick={() => setDetail(card)} className="block w-full text-left">
                    <p title={card.content || '今天也要好好吃饭'}
                      className="text-xs text-wb-text-primary line-clamp-3 break-words">
                      {card.content || '今天也要好好吃饭'}
                    </p>
                  </button>
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <UserAvatar avatarUrl={card.author.avatar_url} username={card.author.nickname} size={20} />
                    <span title={card.author.nickname} className="text-3xs text-wb-text-muted truncate flex-1">{card.author.nickname}</span>
                    <span className="text-3xs text-wb-text-muted">{timeAgo(card.created_at)}</span>
                    <button type="button" onClick={() => void toggleLike(card)} aria-label="点赞"
                      className={`inline-flex items-center gap-0.5 px-1.5 h-6 rounded-capsule text-3xs font-semibold ${
                        card.liked ? 'text-rose-500 bg-rose-500/10' : 'text-wb-text-muted hover:text-rose-500'
                      }`}>
                      <Heart className={`w-3.5 h-3.5 ${card.liked ? 'fill-current' : ''}`} />
                      {card.like_count}
                    </button>
                    <button type="button" onClick={() => setDetail(card)}
                      className="inline-flex items-center gap-0.5 px-1.5 h-6 rounded-capsule text-3xs text-wb-text-muted hover:text-wb-text-primary">
                      <MessageCircle className="w-3.5 h-3.5" />{card.comment_count}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        {hasMore ? (
          <button type="button" onClick={() => void loadCards(page + 1, true)}
            className="mt-4 w-full h-9 rounded-capsule bg-wb-bg-subtle text-2xs font-semibold text-wb-text-secondary">
            加载更多
          </button>
        ) : cards.length > 0 ? (
          <p className="mt-6 pb-4 text-center text-[10px] text-wb-text-muted">已经到底啦 · 去转个盘决定下一顿</p>
        ) : null}
      </div>

      {composer && (
        <CardComposer
          user={user}
          onClose={() => setComposer(false)}
          onDone={() => { setComposer(false); void loadTopic(); void loadCards(1); }}
        />
      )}

      {detail && (
        <CardDetail
          card={detail}
          user={user}
          onClose={() => setDetail(null)}
          onToggleLike={() => void toggleLike(detail)}
          onDelete={() => void removeCard(detail)}
          onCommentAdded={() => {
            setCards((prev) => prev.map((c) => c.id === detail.id ? { ...c, comment_count: c.comment_count + 1 } : c));
            setDetail((prev) => (prev ? { ...prev, comment_count: prev.comment_count + 1 } : prev));
          }}
          onCommentDeleted={() => {
            setCards((prev) => prev.map((c) => c.id === detail.id
              ? { ...c, comment_count: Math.max(0, c.comment_count - 1) } : c));
            setDetail((prev) => (prev ? { ...prev, comment_count: Math.max(0, prev.comment_count - 1) } : prev));
          }}
        />
      )}
    </div>
  );
};

/* ---------------- 发布卡片 ---------------- */

const CardComposer: React.FC<{ user: UserProfile | null; onClose: () => void; onDone: () => void }> = ({ user, onClose, onDone }) => {
  const toast = useToast();
  const [content, setContent] = useState('');
  const [dishes, setDishes] = useState('');
  const [meal, setMeal] = useState('lunch');
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [suggestions, setSuggestions] = useState<{ 名称: string; 简短介绍?: string }[]>([]);
  const suggestTimer = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 菜名联想：和转盘共用 1376 道菜库，输入最后一个菜名时给建议
  const searchDish = (raw: string) => {
    if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
    const last = raw.split(/[,，、\s]+/).filter(Boolean).pop() || '';
    if (!last.trim()) {
      setSuggestions([]);
      return;
    }
    suggestTimer.current = window.setTimeout(() => {
      apiClient.get('/food/dishes', { params: { q: last.trim(), limit: 6 } })
        .then((res) => setSuggestions(res.data?.items || []))
        .catch(() => setSuggestions([]));
    }, 180);
  };

  useEffect(() => () => {
    if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
  }, []);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    if (images.length >= 3) return toast.warning('最多 3 张图');
    const file = files[0];
    if (!file.type.startsWith('image/')) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiClient.post('/posts/upload-image', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: UPLOAD_TIMEOUT,
      });
      const url = res.data?.url || res.data?.image_url;
      if (url) setImages((prev) => [...prev, url].slice(0, 3));
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '图片上传失败');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = async () => {
    if (!user) return toast.warning('登录后才能发卡片');
    const dishList = dishes.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
    if (!content.trim() && dishList.length === 0 && images.length === 0) {
      return toast.warning('写点什么或加一张图吧');
    }
    setSubmitting(true);
    try {
      await apiClient.post('/food/cards', {
        content: content.trim(),
        dish_names: dishList,
        image_urls: images,
        meal_type: meal,
        source: 'manual',
      });
      toast.success('已发到美食帖');
      onDone();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '发布失败');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[215] bg-black/45 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-lg max-h-[90vh] overflow-y-auto [scrollbar-gutter:stable] rounded-t-3xl sm:rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl p-4 space-y-3 animate-[food-modal-in_.24s_cubic-bezier(.2,.9,.3,1.05)] will-change-transform"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-wb-text-primary">晒一顿饭</h3>
          <button type="button" onClick={onClose} className="p-1 text-wb-text-muted hover:text-wb-text-primary"><X className="w-4 h-4" /></button>
        </div>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} maxLength={300}
          placeholder="今天吃了什么？好吃吗？"
          className="w-full p-2.5 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-xs resize-none focus:outline-none" />
        <div className="relative">
          <input value={dishes} onChange={(e) => { setDishes(e.target.value); searchDish(e.target.value); }} maxLength={80}
            placeholder="菜名，用逗号分隔（选填，最多 5 道）"
            className="w-full h-9 px-3 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-xs focus:outline-none" />
          {suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 z-10 p-1.5 rounded-xl bg-wb-bg-surface border border-wb-border-strong shadow-2xl">
              <div className="flex flex-wrap gap-1">
                {suggestions.map((sugg) => (
                  <button key={sugg.名称} type="button"
                    onClick={() => {
                      const parts = dishes.split(/[,，、\s]+/).filter(Boolean);
                      parts.pop();
                      const next = [...parts, sugg.名称].join('，');
                      setDishes(next);
                      setSuggestions([]);
                    }}
                    className="px-2 py-1 rounded-capsule bg-wb-bg-subtle hover:bg-wb-warn/15 text-2xs text-wb-text-secondary">
                    {sugg.名称}
                    {sugg.简短介绍 && <span className="ml-1 text-[10px] opacity-50">{sugg.简短介绍}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {MEALS.map((m) => (
            <button key={m.key} type="button" onClick={() => setMeal(m.key)}
              className={`h-7 px-2.5 rounded-capsule text-2xs font-semibold ${
                meal === m.key ? 'bg-wb-text-primary text-wb-bg-page' : 'bg-wb-bg-subtle text-wb-text-secondary'
              }`}>{m.label}</button>
          ))}
          <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading || images.length >= 3}
            className="ml-auto h-7 px-2.5 rounded-capsule bg-wb-bg-subtle text-2xs text-wb-text-secondary inline-flex items-center gap-1 disabled:opacity-50">
            {uploading ? <Camera className="w-3.5 h-3.5 animate-pulse" /> : <ImagePlus className="w-3.5 h-3.5" />}
            {images.length}/3
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void upload(e.target.files)} />
        </div>
        {images.length > 0 && (
          <div className="flex gap-2">
            {images.map((url) => (
              <div key={url} className="relative">
                <img src={url} alt="" className="w-16 h-16 rounded-lg object-cover" />
                <button type="button" onClick={() => setImages((prev) => prev.filter((u) => u !== url))}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/60 text-white text-[10px]">✕</button>
              </div>
            ))}
          </div>
        )}
        <button type="button" onClick={() => void submit()} disabled={submitting}
          className="w-full h-9 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-bold disabled:opacity-60">
          {submitting ? '发布中…' : '发到美食帖'}
        </button>
      </div>
    </div>,
    document.body,
  );
};

/* ---------------- 卡片详情 + 评论 ---------------- */

const CardDetail: React.FC<{
  card: FoodCardItem;
  user: UserProfile | null;
  onClose: () => void;
  onToggleLike: () => void;
  onDelete: () => void;
  onCommentAdded: () => void;
  onCommentDeleted: () => void;
}> = ({ card, user, onClose, onToggleLike, onDelete, onCommentAdded, onCommentDeleted }) => {
  const toast = useToast();
  const confirm = useConfirm();
  const [comments, setComments] = useState<FoodComment[]>([]);
  const [quick, setQuick] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [imgIndex, setImgIndex] = useState(0);
  // 跟评：回复某条评论时带上 parent_id
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([
        apiClient.get(`/food/cards/${card.id}/comments`),
        apiClient.get('/food/topic'),
      ]);
      setComments(c.data?.items || []);
      setQuick(t.data?.quick_comments || []);
    } catch { /* ignore */ }
  }, [card.id]);

  useEffect(() => { void load(); }, [load]);

  const send = async (content: string, emojiKey?: string) => {
    if (!content.trim() && !emojiKey) return;
    if (!user) return toast.warning('登录后才能评论');
    setSending(true);
    try {
      await apiClient.post(`/food/cards/${card.id}/comments`, {
        content,
        emoji_key: emojiKey,
        parent_id: replyTo?.id || null,
      });
      setText('');
      setReplyTo(null);
      onCommentAdded();
      void load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '评论失败');
    } finally {
      setSending(false);
    }
  };

  const toggleCommentLike = async (c: FoodComment) => {
    setComments((prev) => prev.map((x) => x.id === c.id
      ? { ...x, liked: !x.liked, like_count: Math.max(0, (x.like_count || 0) + (x.liked ? -1 : 1)) }
      : x));
    try {
      const res = await apiClient.post(`/food/comments/${c.id}/like`);
      setComments((prev) => prev.map((x) => x.id === c.id
        ? { ...x, liked: Boolean(res.data?.liked), like_count: Number(res.data?.like_count ?? x.like_count) }
        : x));
    } catch {
      void load();
    }
  };

  const removeComment = async (c: FoodComment) => {
    const ok = await confirm({
      title: '删除评论',
      description: '删除后不可恢复，确定删除这条评论吗？',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/food/comments/${c.id}`);
      onCommentDeleted();
      void load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '删除失败');
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[220] bg-black/50 backdrop-blur-sm flex items-center justify-center p-3" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl animate-[food-modal-in_.24s_cubic-bezier(.2,.9,.3,1.05)] will-change-transform"
        onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 bg-wb-bg-surface/95 backdrop-blur border-b border-wb-border-subtle">
          <UserAvatar avatarUrl={card.author.avatar_url} username={card.author.nickname} size={26} />
          <span className="text-xs font-semibold text-wb-text-primary flex-1 truncate">{card.author.nickname}</span>
          <span className="text-3xs text-wb-text-muted">{timeAgo(card.created_at)}</span>
          <button type="button" onClick={onClose} className="p-1 text-wb-text-muted hover:text-wb-text-primary"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable] p-4 space-y-2">
          {card.image_urls.length > 0 && (
            <div className="space-y-1.5">
              <div className="w-full aspect-[4/3] max-h-[45vh] rounded-xl overflow-hidden bg-wb-bg-subtle">
                <img src={card.image_urls[imgIndex]} alt="" className="w-full h-full object-cover" />
              </div>
              {card.image_urls.length > 1 && (
                <div className="flex gap-1.5">
                  {card.image_urls.map((u, i) => (
                    <button key={u} type="button" onClick={() => setImgIndex(i)}
                      className={`w-12 h-12 rounded-lg overflow-hidden border-2 ${i === imgIndex ? 'border-wb-brand' : 'border-transparent'}`}>
                      <img src={u} alt="" className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            {card.dish_names.map((d) => (
              <span key={d} className="px-2 py-0.5 rounded-capsule bg-wb-warn/10 text-wb-warn text-3xs font-semibold">{d}</span>
            ))}
            <span className="text-3xs text-wb-text-muted">{MEALS.find((m) => m.key === card.meal_type)?.label || ''}</span>
          </div>
          <p className="text-xs text-wb-text-primary whitespace-pre-wrap leading-relaxed">{card.content}</p>
          <div className="flex items-center gap-2 pt-1">
            <button type="button" onClick={onToggleLike}
              className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-capsule text-2xs font-semibold ${
                card.liked ? 'text-rose-500 bg-rose-500/10' : 'text-wb-text-muted bg-wb-bg-subtle'
              }`}>
              <Heart className={`w-3.5 h-3.5 ${card.liked ? 'fill-current' : ''}`} /> {card.like_count}
            </button>
            <span className="text-3xs text-wb-text-muted inline-flex items-center gap-1">
              <MessageCircle className="w-3.5 h-3.5" /> {card.comment_count}
            </span>
            {user && card.author.username === user.username && (
              <button type="button" onClick={onDelete}
                className="ml-auto inline-flex items-center gap-1 text-3xs text-wb-text-muted hover:text-wb-danger">
                <Trash2 className="w-3.5 h-3.5" /> 删除
              </button>
            )}
          </div>
        </div>

        <div className="px-4 pb-4 space-y-2 border-t border-wb-border-subtle pt-3">
          <div className="flex flex-wrap gap-1.5">
            {quick.map((q: any) => (
              <button key={q.text} type="button" disabled={sending} title={q.text}
                onClick={() => void send(q.text, q.emoji)}
                className="inline-flex items-center gap-1 h-7 px-2 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-3xs text-wb-text-secondary hover:text-wb-text-primary disabled:opacity-50">
                <FoodEmoji name={q.emoji} size={18} fallback="🍽️" />
                {q.text}
              </button>
            ))}
          </div>
          {replyTo && (
            <div className="flex items-center gap-1.5 text-[10px] text-wb-text-muted">
              <span className="truncate">回复 <span className="text-wb-text-secondary font-semibold">@{replyTo.name}</span></span>
              <button type="button" onClick={() => setReplyTo(null)}
                className="ml-auto px-1.5 py-0.5 rounded-capsule bg-wb-bg-subtle hover:text-wb-text-primary">取消</button>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void send(text); } }}
              placeholder={replyTo ? `回复 @${replyTo.name}…` : '说点什么…'}
              className="flex-1 h-9 px-3 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-xs focus:outline-none" />
            <button type="button" onClick={() => void send(text)} disabled={sending || !text.trim()}
              className="h-9 px-3 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-bold disabled:opacity-50">发送</button>
          </div>
          <div className="space-y-2.5 pt-1">
            {comments.length === 0 && <p className="text-3xs text-wb-text-muted">还没有评论，来抢沙发</p>}
            {(() => {
              const children = new Map<string, FoodComment[]>();
              comments.forEach((c) => {
                if (!c.parent_id) return;
                const list = children.get(c.parent_id) || [];
                list.push(c);
                children.set(c.parent_id, list);
              });
              // 父评论可能不在当前分页里：把这类孤儿子评论当根节点展示，避免“回复消失”
              const ids = new Set(comments.map((c) => c.id));
              const roots = comments
                .filter((c) => !c.parent_id || !ids.has(c.parent_id))
                .sort((a, b) => (b.like_count || 0) - (a.like_count || 0)
                  || new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());

              const renderNode = (c: FoodComment, depth: number): React.ReactNode => {
                const kids = (children.get(c.id) || []).slice().sort(
                  (a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime(),
                );
                const deleted = c.status === 'deleted';
                const mine = Boolean(user && c.author.username === user.username);
                return (
                  <div key={c.id} className={depth > 0 ? 'mt-2' : ''}>
                    <div className="flex items-start gap-2">
                      <UserAvatar avatarUrl={c.author.avatar_url} username={c.author.nickname} size={depth > 0 ? 20 : 24} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span title={c.author.nickname}
                            className="text-3xs font-semibold text-wb-text-secondary truncate max-w-[6.5rem]">
                            {c.author.nickname}
                          </span>
                          <span className="text-3xs text-wb-text-muted shrink-0">{timeAgo(c.created_at)}</span>
                          {!deleted && (
                            <div className="ml-auto flex items-center gap-1.5 shrink-0">
                              <button type="button" onClick={() => void toggleCommentLike(c)}
                                aria-label="点赞评论"
                                className={`inline-flex items-center gap-0.5 text-[10px] font-semibold ${
                                  c.liked ? 'text-rose-500' : 'text-wb-text-muted hover:text-rose-500'
                                }`}>
                                <Heart className={`w-3 h-3 ${c.liked ? 'fill-current' : ''}`} />
                                {c.like_count || 0}
                              </button>
                              <button type="button"
                                onClick={() => setReplyTo({ id: c.id, name: c.author.nickname })}
                                className="text-[10px] text-wb-text-muted hover:text-wb-text-primary">
                                回复
                              </button>
                              {mine && (
                                <button type="button" onClick={() => void removeComment(c)}
                                  aria-label="删除评论"
                                  className="text-[10px] text-wb-text-muted hover:text-wb-danger">
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                        {deleted ? (
                          <p className="text-xs text-wb-text-muted italic mt-0.5">该评论已删除</p>
                        ) : (
                          <p title={c.content}
                            className={`text-xs text-wb-text-primary break-words whitespace-pre-wrap mt-0.5 ${
                              depth > 0 ? 'line-clamp-4' : 'line-clamp-6'
                            }`}>
                            {c.emoji_key && <FoodEmoji name={c.emoji_key} size={16} fallback="" />}
                            {c.content}
                          </p>
                        )}
                        {kids.length > 0 && (
                          <div className={`mt-1.5 space-y-1.5 border-l border-wb-border-subtle ${depth >= 2 ? 'pl-2' : 'pl-2.5'}`}>
                            {kids.map((child) => renderNode(child, depth + 1))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              };

              return roots.map((c) => renderNode(c, 0));
            })()}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
