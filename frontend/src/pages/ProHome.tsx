import React, { useEffect, useState, useRef } from 'react';
import { DailyNewsBar } from '../components/DailyNewsBar';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText,
  MessageSquare,
  Heart,
  Eye,
  Check,
  Pin,
  ChevronRight,
  Bookmark,
  Share2,
  Shield,
  Calendar,
  Layout,
  List,
} from 'lucide-react';
import { apiClient } from '../api/client';
import { Leaderboard } from '../components/Leaderboard';
import { SeriesPanel } from '../components/SeriesPanel';
import { thumbUrl, thumbSrcSet } from '../utils/thumb';
import type { PostSimple, UserProfile } from '../types';
import { LevelBadge } from '../components/LevelBadge';
import { UserAvatar } from '../components/UserAvatar';
import { PostCardSkeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { FriendLinksCard } from '../components/FriendLinksCard';
import { formatEast8Date, getSmartDailyTitle } from '../utils/format';

export interface ProHomeProps {
  user: UserProfile | null;
  isAdmin?: boolean;
  onSelectPost: (postId: string) => void;
  onSelectUser?: (username: string) => void;
  onRequireAuth?: () => void;
  onGoWrite?: () => void;
  onGoCheckin?: () => void;
  onGoRules?: () => void;
  onGoLegal?: () => void;
  onOpenLinks?: () => void;
  onGoWriteDaily?: () => void;
  onGoHabit?: () => void;
  onGoFeedback?: () => void;
  isActive?: boolean;
}


/**
 * 深度极客社区 · 全新专业版首页 (ProHome)
 * 特点：
 * 1. 宽屏三栏专业控制台布局 (桌面端左工作台+中流+右监控面板)；
 * 2. 独家高密度纯文本信息流 (Dense Mode) 与专业极客卡片流自由切换；
 * 3. 真实友情链接动态同步，支持深情友链徽章；
 * 4. 顶部通栏搜索 + 分页/无限流单键切换；
 * 5. 全面适配移动端自适应流式排版，底部零遮挡。
 */
export const ProHome: React.FC<ProHomeProps> = ({
  user,
  isAdmin = false,
  onSelectPost,
  onSelectUser,
  onRequireAuth,
  onGoWrite,
  onGoCheckin,
  onGoRules,
  onGoLegal,
  onOpenLinks,
  onGoWriteDaily,
  onGoHabit,
  onGoFeedback,
  isActive = true,
}) => {
  const toast = useToast();

  // 核心数据状态
  const [posts, setPosts] = useState<PostSimple[]>([]);
  const [newsPost, setNewsPost] = useState<PostSimple | null>(null);
  const [categories, setCategories] = useState<string[]>([
    '全部',
    '科技前沿',
    '后端架构',
    '前端全栈',
    'AI探索',
    '极客日常',
  ]);
  const [selectedCategory, setSelectedCategory] = useState('全部');
  const [filter, setFilter] = useState<'latest' | 'hot' | 'discuss'>('latest');
  const [streamTab, setStreamTab] = useState<'all' | 'following'>('all');
  const [feedViewMode, setFeedViewMode] = useState<'card' | 'dense'>(() => {
    try {
      return (localStorage.getItem('wb_pro_feed_view_mode') as 'card' | 'dense') || 'card';
    } catch {
      return 'card';
    }
  });

  const [searchQuery, setSearchQuery] = useState(() => {
    try { return localStorage.getItem('wb_pro_search') || ''; } catch { return ''; }
  });


  // 分页与滚动状态
  const [currentPage, setCurrentPage] = useState(1);
  const [displayTotal, setDisplayTotal] = useState(0);
  const [isFetchingPosts, setIsFetchingPosts] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  // 分页 / 无限流：与经典版「首页无限滚动」开关共用同一偏好键
  const [infinite, setInfinite] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('geek_home_infinite_scroll');
      return v === null ? true : v === 'true';
    } catch { return true; }
  });
  const PAGE_SIZE_INFINITE = 15;   // 无限流：小步追加，滚动更顺
  const PAGE_SIZE_PAGED = 30;      // 分页：一页多显示一些，避免每页只有十几条
  const pageSize = infinite ? PAGE_SIZE_INFINITE : PAGE_SIZE_PAGED;
  const totalPages = Math.max(1, Math.ceil(displayTotal / PAGE_SIZE_PAGED));

  // 设置页「首页无限滚动」开关与经典版共用偏好键，这里同步外部变更
  useEffect(() => {
    const handler = (e: Event) => {
      const v = (e as CustomEvent<boolean>).detail;
      setInfinite(typeof v === 'boolean' ? v : true);
    };
    window.addEventListener('geek_infinite_scroll_change', handler);
    return () => window.removeEventListener('geek_infinite_scroll_change', handler);
  }, []);

  // 签到状态
  const [hasCheckedInToday, setHasCheckedInToday] = useState(false);
  const [checkinStreak, setCheckinStreak] = useState(0);

  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);

  // 切换流模式（卡片 vs 单行信息流）
  const toggleFeedViewMode = (mode: 'card' | 'dense') => {
    setFeedViewMode(mode);
    try {
      localStorage.setItem('wb_pro_feed_view_mode', mode);
    } catch {}
  };

  // 搜索框已集中到顶部通栏，这里只接收输入事件
  useEffect(() => {
    const handler = (e: Event) => setSearchQuery(String((e as CustomEvent<string>).detail || ''));
    window.addEventListener('geek:pro-search', handler);
    return () => window.removeEventListener('geek:pro-search', handler);
  }, []);

  // 加载全站分类
  useEffect(() => {
    let alive = true;
    apiClient
      .get('/posts/categories')
      .then((res) => {
        if (!alive || !Array.isArray(res.data)) return;
        const catNames: string[] = [];
        res.data.forEach((c: any) => {
          if (c.slug !== 'news' && c.name !== '新闻早报') catNames.push(c.name);
        });
        setCategories(Array.from(new Set(['全部', ...catNames, '极客日常'])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 加载每日早报
  useEffect(() => {
    let alive = true;
    apiClient
      .get('/posts/latest-news')
      .then((res) => {
        if (alive && res.data && res.data.id) setNewsPost(res.data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 顶部导航栏签到后同步本页状态（两处入口共用一套状态）
  useEffect(() => {
    const onDone = () => {
      setHasCheckedInToday(true);
      apiClient.get('/users/checkin/status')
        .then((r) => setCheckinStreak(Number(r.data?.streak) || checkinStreak))
        .catch(() => undefined);
    };
    window.addEventListener('geek:checkin-done', onDone);
    return () => window.removeEventListener('geek:checkin-done', onDone);
  }, [checkinStreak]);

  // 加载签到状态
  useEffect(() => {
    if (!user) {
      setHasCheckedInToday(false);
      return;
    }
    let alive = true;
    apiClient
      .get('/users/checkin/status')
      .then((res) => {
        if (!alive) return;
        setHasCheckedInToday(Boolean(res.data?.checked_today));
        setCheckinStreak(res.data?.streak || 0);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [user]);

  // 加载主列表数据
  const fetchPosts = async (page: number, append = false) => {
    if (page === 1) setIsFetchingPosts(true);
    else setLoadingMore(true);

    try {
      // 专业版复用当前项目的文章列表契约：sort_by + 服务端 X-Total-Count，
      // 关注流走 /posts/feed/following 独立端点
      const isFollowing = streamTab === 'following' && Boolean(user);
      const params: Record<string, any> = { page, size: pageSize };
      if (!isFollowing) {
        params.sort_by = filter === 'discuss' ? 'comments' : filter;
        if (selectedCategory !== '全部') params.category = selectedCategory;
        if (searchQuery.trim()) params.q = searchQuery.trim();
      }
      const res = await apiClient.get(isFollowing ? '/posts/feed/following' : '/posts', { params });
      const items: PostSimple[] = Array.isArray(res.data) ? res.data : (res.data?.items || []);
      const rawTotal = Number(res.headers?.['x-total-count']);
      const hasTotal = Number.isFinite(rawTotal) && rawTotal >= 0;
      if (!append) setDisplayTotal(hasTotal ? rawTotal : items.length);

      if (append) {
        setPosts((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          const merged = [...prev, ...items.filter((i) => !seen.has(i.id))];
          setHasMore(hasTotal ? merged.length < rawTotal : items.length >= pageSize);
          return merged;
        });
      } else {
        setPosts(items);
        setHasMore(hasTotal ? items.length < rawTotal : items.length >= pageSize);
      }
    } catch {
      if (!append) setPosts([]);
    } finally {
      setIsFetchingPosts(false);
      setLoadingMore(false);
    }
  };

  // 首次进入首页时拉第一页；之后从文章详情 / 其它 tab 返回不再重拉，
  // 列表内容、分页位置与滚动位置都原样保留（与经典版一致）
  const proFirstLoadRef = useRef(false);
  useEffect(() => {
    if (!isActive || proFirstLoadRef.current) return;
    proFirstLoadRef.current = true;
    setCurrentPage(1);
    void fetchPosts(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // 用户主动改分类 / 排序 / 视图 / 搜索词时才重置到第一页
  useEffect(() => {
    if (!proFirstLoadRef.current) return;
    setCurrentPage(1);
    void fetchPosts(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory, filter, streamTab, searchQuery, infinite]);

  // 触底无限滚动
  useEffect(() => {
    if (!infinite || !hasMore || loadingMore || isFetchingPosts) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore && !isFetchingPosts) {
          const nextPage = currentPage + 1;
          setCurrentPage(nextPage);
          fetchPosts(nextPage, true);
        }
      },
      { threshold: 0.1 }
    );
    if (bottomSentinelRef.current) observer.observe(bottomSentinelRef.current);
    return () => observer.disconnect();
  }, [infinite, hasMore, loadingMore, isFetchingPosts, currentPage]);

  // 分页 / 无限流：单个按钮点击切换（不再是两段开关）
  const toggleInfinite = () => {
    const next = !infinite;
    setInfinite(next);
    try { localStorage.setItem('geek_home_infinite_scroll', String(next)); } catch { /* 忽略 */ }
    window.dispatchEvent(new CustomEvent('geek_infinite_scroll_change', { detail: next }));
  };

  // 点赞操作
  const handleQuickLike = async (e: React.MouseEvent, post: PostSimple) => {
    e.stopPropagation();
    if (!user) {
      onRequireAuth?.();
      return;
    }
    try {
      const res = await apiClient.post(`/posts/${post.id}/like`);
      const updatedLikeCount = res.data?.like_count ?? (post.like_count || 0) + 1;
      setPosts((prev) =>
        prev.map((p) => (p.id === post.id ? { ...p, like_count: updatedLikeCount } : p))
      );
      toast.success('点赞成功');
    } catch {
      toast.error('点赞失败');
    }
  };

  // 收藏操作
  const handleToggleCollect = async (e: React.MouseEvent, post: PostSimple) => {
    e.stopPropagation();
    if (!user) {
      onRequireAuth?.();
      return;
    }
    const willCollect = !post.is_collected;
    try {
      if (willCollect) {
        await apiClient.post(`/posts/${post.id}/collect`);
        toast.success('已加入个人收藏');
      } else {
        await apiClient.delete(`/posts/${post.id}/collect`);
        toast.info('已取消收藏');
      }
      setPosts((prev) =>
        prev.map((p) => (p.id === post.id ? { ...p, is_collected: willCollect } : p))
      );
    } catch {
      toast.error('操作失败');
    }
  };

  // 分享操作
  const handleShare = (e: React.MouseEvent, post: PostSimple) => {
    e.stopPropagation();
    const url = `${window.location.origin}?post=${post.id}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => toast.success('链接已复制到剪贴板'));
    } else {
      toast.info(url);
    }
  };

  // 打卡操作
  const handleCheckin = async () => {
    if (!user) {
      onRequireAuth?.();
      return;
    }
    if (hasCheckedInToday) {
      onGoCheckin?.();
      return;
    }
    try {
      const res = await apiClient.post('/users/checkin');
      setHasCheckedInToday(true);
      setCheckinStreak(res.data?.continuous_days || checkinStreak + 1);
      toast.success('今日打卡成功，经验已到账！');
      window.dispatchEvent(new CustomEvent('geek:checkin-done'));
    } catch {
      onGoCheckin?.();
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-[1488px] grid-cols-[minmax(0,1fr)] items-start gap-4 px-3 py-4 sm:px-6 sm:py-6 md:grid-cols-[11rem_minmax(0,1fr)] lg:gap-5 xl:grid-cols-[12rem_minmax(0,1fr)_16rem] 2xl:grid-cols-[13rem_minmax(0,1fr)_18rem]">
      <aside aria-label="技术分区与快捷工作台" className="hidden space-y-4 md:sticky md:top-16 md:block">
        <section className="space-y-1.5 rounded-2xl border border-wb-border-subtle bg-wb-bg-surface p-2.5">
          <h2 className="px-3 pb-1 pt-2 text-xs font-semibold text-wb-text-secondary">技术分区</h2>
          {categories.map((cat) => {
            const isActive = selectedCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                aria-pressed={isActive}
                className={`flex min-h-9 w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-wb-brand/10 font-semibold text-wb-brand'
                    : 'text-wb-text-secondary hover:bg-wb-bg-subtle hover:text-wb-text-primary'
                }`}
              >
                <span>{cat}</span>
                {isActive && <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              </button>
            );
          }).flatMap((item, i) => (onGoHabit && (categories[i] === '问答广场' || (!categories.includes('问答广场') && i === 0))) ? [item, (
            <button key="habit-link" type="button" onClick={onGoHabit} className="flex min-h-9 w-full items-center justify-between rounded-lg px-3 text-left text-xs font-semibold text-wb-brand hover:bg-wb-brand/10">
              自律打卡 <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )] : [item])}
        </section>

        <section className="space-y-2 rounded-2xl border border-wb-border-subtle bg-wb-bg-surface p-3">
          <h2 className="px-2 pt-1 text-xs font-semibold text-wb-text-secondary">快捷工作台</h2>
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => {
                if (!user) onRequireAuth?.();
                else onGoWrite?.();
              }}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5 text-blue-500" />
              <span>发布新帖</span>
            </button>
            <button
              type="button"
              onClick={() => onGoFeedback?.()}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors cursor-pointer"
            >
              <MessageSquare className="w-3.5 h-3.5 text-emerald-500" />
              <span>反馈建议</span>
            </button>
            <button
              type="button"
              onClick={handleCheckin}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                hasCheckedInToday
                  ? 'text-amber-600 bg-amber-500/10'
                  : 'text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle'
              }`}
            >
              <Calendar className="w-3.5 h-3.5 text-amber-500" />
              <span>{hasCheckedInToday ? `今日已打卡 (${checkinStreak}天)` : '今日签到'}</span>
            </button>
          </div>
        </section>

        {/* 友情链接 */}
        <FriendLinksCard variant="sidebar" onOpenAll={onOpenLinks} />

        <section className="space-y-2 rounded-2xl border border-wb-border-subtle bg-wb-bg-surface p-3">
          <h2 className="flex items-center gap-2 px-2 pt-1 text-xs font-semibold text-wb-text-secondary">
            <Shield className="h-3.5 w-3.5" aria-hidden="true" />
            极客自治公约
          </h2>
          <div className="space-y-1">
            <button
              type="button"
              onClick={onGoRules}
              className="flex min-h-9 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-xs text-wb-text-secondary hover:bg-wb-bg-subtle hover:text-wb-text-primary"
            >
              入站必读规范
              <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onGoLegal}
              className="flex min-h-9 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-xs text-wb-text-secondary hover:bg-wb-bg-subtle hover:text-wb-text-primary"
            >
              免责与开源声明
              <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </button>
          </div>
        </section>
      </aside>

      <section aria-labelledby="pro-feed-heading" className="min-w-0 space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1">
          <div className="min-w-0">
            <h1 id="pro-feed-heading" className="text-2xl font-bold tracking-tight text-wb-text-primary sm:text-3xl">社区动态</h1>
            <p className="mt-1 text-xs text-wb-text-secondary" aria-live="polite">{selectedCategory === '全部' ? '全部分区' : selectedCategory} · 共 {displayTotal} 篇</p>
          </div>
          {onGoFeedback && (
            <button type="button" onClick={onGoFeedback} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-wb-border-subtle bg-wb-bg-surface px-3 text-xs font-semibold text-wb-text-secondary hover:text-wb-text-primary md:hidden">
              <MessageSquare className="h-4 w-4" aria-hidden="true" />
              反馈建议
            </button>
          )}
        </header>

        <DailyNewsBar post={newsPost} onRead={onSelectPost} onWrite={isAdmin ? onGoWriteDaily : undefined} />

        <div role="group" aria-label="技术分区" className="md:hidden">
          <div className="flex flex-wrap items-center gap-1.5">
            {categories.map((cat) => {
              const isActive = selectedCategory === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  aria-pressed={isActive}
                  className={`min-h-9 shrink-0 whitespace-nowrap rounded-lg border px-2.5 text-xs font-medium transition-colors ${
                    isActive
                      ? 'border-wb-brand/20 bg-wb-brand/10 font-semibold text-wb-brand'
                      : 'border-wb-border-subtle bg-wb-bg-surface text-wb-text-secondary hover:bg-wb-bg-subtle'
                  }`}
                >
                  {cat}
                </button>
              );
            }).flatMap((item, i) => (onGoHabit && (categories[i] === '问答广场' || (!categories.includes('问答广场') && i === 0))) ? [item, (
              <button key="habit-link" type="button" onClick={onGoHabit} className="min-h-9 shrink-0 whitespace-nowrap rounded-lg border border-wb-brand/20 bg-wb-brand/10 px-2.5 text-xs font-semibold text-wb-brand hover:bg-wb-brand/20">
                自律打卡
              </button>
            )] : [item])}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-wb-border-subtle bg-wb-bg-surface p-2.5 sm:p-3">
          <div role="group" aria-label="动态来源" className="relative flex shrink-0 items-center rounded-xl border border-wb-border-subtle bg-wb-bg-subtle p-0.5">
            {([
              { key: 'all', label: '全部发现' },
              { key: 'following', label: '关注动态' },
            ] as const).map((tab) => (
              <button key={tab.key} type="button"
                onClick={() => {
                  if (tab.key === 'following' && !user) { onRequireAuth?.(); return; }
                  setStreamTab(tab.key);
                }}
                aria-pressed={streamTab === tab.key}
                className={`relative z-10 min-h-9 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold transition-colors ${
                  streamTab === tab.key ? 'text-wb-text-primary' : 'text-wb-text-muted hover:text-wb-text-secondary'}`}
              >
                {streamTab === tab.key && (
                  <motion.div layoutId="pro-stream-indicator"
                    transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                    className="absolute inset-0 bg-wb-bg-surface rounded-md shadow-xs border border-wb-border-subtle/60 -z-10" />
                )}
                {tab.label}
              </button>
            ))}
          </div>

          <div role="group" aria-label="动态排序" className="relative flex shrink-0 items-center rounded-xl border border-wb-border-subtle bg-wb-bg-subtle p-0.5">
            {([
              { key: 'latest', label: '最新发布' },
              { key: 'hot', label: '热门互动' },
              { key: 'discuss', label: '热议讨论' },
            ] as const).map((tab) => (
              <button key={tab.key} type="button" onClick={() => setFilter(tab.key)} aria-pressed={filter === tab.key}
                className={`relative z-10 min-h-9 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold transition-colors ${
                  filter === tab.key ? 'text-wb-text-primary' : 'text-wb-text-muted hover:text-wb-text-secondary'}`}
              >
                {filter === tab.key && (
                  <motion.div layoutId="pro-filter-indicator"
                    transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                    className="absolute inset-0 bg-wb-bg-surface rounded-md shadow-xs border border-wb-border-subtle/60 -z-10" />
                )}
                {tab.label}
              </button>
            ))}
          </div>

          {/* 分页与无限滚动 */}
          <button type="button" onClick={toggleInfinite}
            title={infinite ? '当前无限滚动，点击切换为分页模式' : '当前分页模式，点击切换为无限滚动'}
            aria-pressed={infinite}
            aria-label="无限滚动"
            className="inline-flex h-[42px] shrink-0 items-center gap-1 overflow-hidden rounded-xl border border-wb-border-subtle px-2.5 text-xs font-semibold text-wb-text-secondary transition-colors hover:bg-wb-bg-subtle hover:text-wb-text-primary"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={infinite ? 'infinite' : 'paged'}
                initial={{ opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -7 }}
                transition={{ duration: 0.18 }}
                className="inline-flex items-center gap-1 whitespace-nowrap">
                {infinite ? <List className="w-3 h-3" /> : <Layout className="w-3 h-3" />}
                {infinite ? '无限滚动' : '分页模式'}
              </motion.span>
            </AnimatePresence>
          </button>

          <div role="group" aria-label="动态布局" className="relative flex shrink-0 items-center rounded-xl border border-wb-border-subtle bg-wb-bg-subtle p-0.5 text-xs font-medium">
            {([
              { key: 'card', label: '卡片', Icon: Layout, title: '舒适卡片流' },
              { key: 'dense', label: '信息流', Icon: List, title: '高密度纯文本信息流' },
            ] as const).map(({ key, label, Icon, title }) => (
              <button key={key} type="button" onClick={() => toggleFeedViewMode(key)} title={title} aria-pressed={feedViewMode === key}
                className={`relative z-10 flex min-h-9 items-center gap-1 rounded-lg px-2.5 transition-colors ${
                  feedViewMode === key ? 'text-wb-text-primary font-semibold' : 'text-wb-text-muted hover:text-wb-text-secondary'}`}
              >
                {feedViewMode === key && (
                  <motion.div layoutId="pro-view-indicator"
                    transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                    className="absolute inset-0 bg-wb-bg-surface rounded-md shadow-xs border border-wb-border-subtle/60 -z-10" />
                )}
                <Icon className="w-3 h-3" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 3. 信息流列表展示 */}
        <div
          className={`space-y-3 min-h-[480px] transition-opacity duration-150 ${
            isFetchingPosts ? 'opacity-65 pointer-events-none' : 'opacity-100'
          }`}
        >
          {posts.length > 0 ? (
            <>
              {posts.map((post) =>
                feedViewMode === 'dense' ? (
                  /* 极客纯文本单行信息流 (Dense Row) */
                  <article
                    key={post.id}
                    onClick={() => onSelectPost(post.id)}
                    className="group flex min-h-12 w-full cursor-pointer items-center justify-between gap-2 rounded-xl border border-wb-border-subtle bg-wb-bg-surface px-3 py-2 text-xs transition-colors hover:border-wb-border-strong hover:bg-wb-bg-subtle/80 sm:px-4"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {post.is_pinned && (
                        <span className="inline-flex items-center gap-0.5 text-3xs px-1.5 py-0.2 rounded bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 font-semibold shrink-0">
                          <Pin className="w-2.5 h-2.5" />
                          <span>置顶</span>
                        </span>
                      )}
                      <span className="hidden max-w-24 shrink-0 truncate rounded bg-wb-bg-subtle px-1.5 py-0.5 text-xs text-wb-text-muted sm:inline">
                        {post.category_name || '综合'}
                      </span>
                      <h2 className="min-w-0 text-sm font-semibold text-wb-text-primary group-hover:text-wb-brand">
                        <button type="button" onClick={(e) => { e.stopPropagation(); onSelectPost(post.id); }} className="block max-w-full truncate text-left group-hover:underline">
                          {getSmartDailyTitle(post.title, post.id)}
                        </button>
                      </h2>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-wb-text-muted sm:gap-3">
                      <span className="hidden max-w-24 truncate lg:inline">
                        @{post.author_nickname || post.author_username}
                      </span>
                      <time dateTime={post.created_at} className="hidden sm:inline">{formatEast8Date(post.created_at)}</time>
                      <span className="text-wb-text-secondary flex items-center gap-1">
                        <Eye className="w-3 h-3 text-wb-text-muted" />
                        <span>{post.view_count || 0}</span>
                      </span>
                      <span className="text-wb-text-secondary flex items-center gap-1">
                        <MessageSquare className="w-3 h-3 text-wb-text-muted" />
                        <span>{post.comment_count || 0}</span>
                      </span>
                    </div>
                  </article>
                ) : (
                  /* 专业卡片流 (Pro Card) */
                  <article
                    key={post.id}
                    onClick={() => onSelectPost(post.id)}
                    className="group w-full cursor-pointer space-y-3 rounded-2xl border border-wb-border-subtle bg-wb-bg-surface p-3.5 transition-colors hover:border-wb-border-strong sm:p-4"
                  >
                    <div className="flex items-start justify-between gap-3 sm:gap-4">
                      <div className="min-w-0 flex-1 space-y-2">
                        {/* 作者元信息 */}
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-wb-text-muted">
                          <UserAvatar
                            avatarUrl={post.author_avatar}
                            username={post.author_nickname || post.author_username}
                            size="xs"
                          />
                          <span className="max-w-full truncate font-medium text-wb-text-primary">
                            {post.author_nickname || post.author_username}
                          </span>
                          {post.author_level ? <LevelBadge level={post.author_level} /> : null}
                          <time dateTime={post.created_at} className="tabular-nums">{formatEast8Date(post.created_at)}</time>
                          {post.is_pinned && (
                            <span className="text-red-500 font-sans font-bold flex items-center gap-0.5">
                              <Pin className="w-3 h-3" /> 置顶
                            </span>
                          )}
                        </div>

                        {/* 标题 */}
                        <h2 className="text-base font-semibold leading-snug text-wb-text-primary transition-colors group-hover:text-wb-brand sm:text-lg">
                          <button type="button" onClick={(e) => { e.stopPropagation(); onSelectPost(post.id); }} className="line-clamp-2 max-w-full break-words text-left">
                            {getSmartDailyTitle(post.title, post.id)}
                          </button>
                        </h2>

                        {/* 摘要正文 */}
                        {post.summary && (
                          <p className="text-xs text-wb-text-secondary line-clamp-2 leading-relaxed">
                            {post.summary}
                          </p>
                        )}
                      </div>

                      {/* 封面缩略图 */}
                      {post.cover_image && (
                        <div className="w-20 h-16 sm:w-28 sm:h-20 rounded-lg overflow-hidden shrink-0 border border-wb-border-subtle bg-wb-bg-subtle">
                          <img
                            src={thumbUrl(post.cover_image, 200)}
                            srcSet={thumbSrcSet(post.cover_image)}
                            alt=""
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            loading="lazy"
                          />
                        </div>
                      )}
                    </div>

                    {/* 卡片底部操作栏 */}
                    <div className="flex items-center justify-between pt-2 border-t border-wb-border-subtle/40 text-3xs text-wb-text-muted">
                      <div className="flex items-center gap-2">
                        <span className="font-mono flex items-center gap-1">
                          <Eye className="w-3 h-3" />
                          <span>{post.view_count || 0}</span>
                        </span>
                        {post.category_name && (
                          <span className="px-1.5 py-0.2 rounded bg-wb-bg-subtle text-wb-text-muted font-mono">
                            {post.category_name}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={(e) => handleToggleCollect(e, post)}
                          title={post.is_collected ? '已收藏' : '收藏'}
                          className={`p-1 rounded transition-colors ${
                            post.is_collected
                              ? 'text-amber-500'
                              : 'hover:text-wb-text-primary hover:bg-wb-bg-subtle'
                          }`}
                        >
                          <Bookmark
                            className={`w-3.5 h-3.5 ${post.is_collected ? 'fill-current' : ''}`}
                          />
                        </button>
                      </div>

                      <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={(e) => handleQuickLike(e, post)}
                          title="点赞"
                          className="flex items-center gap-1 hover:text-red-500 transition-colors"
                        >
                          <Heart className="w-3.5 h-3.5" />
                          <span className="font-mono">{post.like_count || 0}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onSelectPost(post.id)}
                          title="评论"
                          className="flex items-center gap-1 hover:text-blue-500 transition-colors"
                        >
                          <MessageSquare className="w-3.5 h-3.5" />
                          <span className="font-mono">{post.comment_count || 0}</span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => handleShare(e, post)}
                          title="分享链接"
                          className="p-1 hover:text-wb-text-primary hover:bg-wb-bg-subtle rounded transition-colors"
                        >
                          <Share2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </article>
                )
              )}

              {/* 无限流：滚动哨兵 + 到底提示 */}
              {infinite && <div ref={bottomSentinelRef} className="h-4" />}
              {infinite && loadingMore && (
                <div className="py-4 text-center text-xs text-wb-text-muted font-mono animate-pulse">
                  正在同步更多极客帖子...
                </div>
              )}
              {infinite && !hasMore && posts.length > 0 && (
                <div className="py-6 text-center text-xs text-wb-text-muted font-mono border-t border-wb-border-subtle/50 flex items-center justify-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-wb-success" />
                  <span>已展现全部极客内容 · 共 {displayTotal} 篇</span>
                </div>
              )}

              {/* 分页模式：一页 30 条，页码导航 */}
              {!infinite && posts.length > 0 && (
                <div className="py-4 flex items-center justify-center gap-3 border-t border-wb-border-subtle/50">
                  <button type="button" disabled={currentPage <= 1 || isFetchingPosts}
                    onClick={() => { const p = currentPage - 1; setCurrentPage(p); void fetchPosts(p, false); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                    className="h-7 px-2.5 rounded-md bg-wb-bg-subtle border border-wb-border-subtle text-3xs font-semibold text-wb-text-secondary hover:text-wb-text-primary disabled:opacity-40">
                    上一页
                  </button>
                  <span className="text-3xs font-mono text-wb-text-muted">
                    第 {currentPage} / {totalPages} 页 · 共 {displayTotal} 篇
                  </span>
                  <button type="button" disabled={currentPage >= totalPages || isFetchingPosts}
                    onClick={() => { const p = currentPage + 1; setCurrentPage(p); void fetchPosts(p, false); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                    className="h-7 px-2.5 rounded-md bg-wb-bg-subtle border border-wb-border-subtle text-3xs font-semibold text-wb-text-secondary hover:text-wb-text-primary disabled:opacity-40">
                    下一页
                  </button>
                </div>
              )}
            </>
          ) : isFetchingPosts ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((n) => (
                <PostCardSkeleton key={n} />
              ))}
            </div>
          ) : (
            <div className="p-12 rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-center space-y-2">
              <FileText className="w-8 h-8 text-wb-text-muted mx-auto stroke-1" />
              <p className="text-xs text-wb-text-muted">当前分区暂无帖子，快来抢先发布吧</p>
            </div>
          )}
        </div>
      </section>

      <aside aria-label="个人资料、排行榜与专栏" className="hidden min-w-0 space-y-4 xl:sticky xl:top-16 xl:block">
        {/* 个人身份卡片 */}
        {user ? (
          <div className="bg-wb-bg-surface rounded-xl border border-wb-border-subtle p-3.5 shadow-2xs space-y-3">
            <div className="flex items-center gap-3">
              <UserAvatar avatarUrl={user.avatar_url} username={user.username} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-wb-text-primary truncate">
                    {user.nickname || user.username}
                  </span>
                  <LevelBadge level={user.level || 1} />
                </div>
                <p className="text-3xs text-wb-text-muted truncate mt-0.5">
                  {user.bio || '极客探索者 · 终身学习'}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1 pt-2 border-t border-wb-border-subtle/60 text-center text-3xs font-mono">
              <div className="p-1.5 rounded-lg bg-wb-bg-subtle/40">
                <div className="text-wb-text-primary font-bold">{user.experience || 0}</div>
                <div className="text-wb-text-muted text-[9px]">经验值</div>
              </div>
              <div className="p-1.5 rounded-lg bg-wb-bg-subtle/40">
                <div className="text-wb-text-primary font-bold">{user.following_count || 0}</div>
                <div className="text-wb-text-muted text-[9px]">关注</div>
              </div>
              <div className="p-1.5 rounded-lg bg-wb-bg-subtle/40">
                <div className="text-wb-text-primary font-bold">{user.followers_count || 0}</div>
                <div className="text-wb-text-muted text-[9px]">粉丝</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-wb-bg-surface rounded-xl border border-wb-border-subtle p-4 shadow-2xs text-center space-y-2.5">
            <h3 className="text-xs font-bold text-wb-text-primary">加入深度极客社区</h3>
            <p className="text-3xs text-wb-text-muted leading-relaxed">
              登录通行证，与海量全栈工程师交流技术架构，记录技术日常。
            </p>
            <button
              type="button"
              onClick={onRequireAuth}
              className="w-full py-1.5 rounded-lg bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 transition-opacity"
            >
              立即登录 / 注册
            </button>
          </div>
        )}

        {/* 社区活跃排行榜：Leaderboard 自带卡片外壳，不要再套一层 */}
        <Leaderboard onSelectUser={onSelectUser} />

        {/* 专栏：经典版有的折叠 / 倒序 / 拖拽排序，专业版同样提供 */}
        <SeriesPanel onSelectPost={onSelectPost} viewer={user} />
      </aside>

    </div>
  );
};

export default ProHome;
