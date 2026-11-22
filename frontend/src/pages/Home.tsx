import React, { useEffect, useLayoutEffect, useState, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  FileText,
  UserRound,
  Clock,
  MessageSquare,
  Heart,
  Eye,
  Sparkles,
  Check,
  Pin,
  ChevronRight,
  Search,
  X,
  Bookmark,
  Share2,
  RotateCcw,
  Activity,
  Users,
  UserCheck,
  UserPlus,
  Shield,
  Calendar,
  Edit3,
  Flame,
  Terminal,
  ArrowUpRight,
  History,
  Trash2,
  ExternalLink,
  ArrowDownCircle,
  BookOpen,
} from 'lucide-react';
import { apiClient } from '../api/client';
import { Leaderboard } from '../components/Leaderboard';
import { StaffDirectory } from '../components/StaffDirectory';
import { thumbUrl, thumbSrcSet } from '../utils/thumb';
import type { PostSimple, UserProfile } from '../types';
import { LevelBadge } from '../components/LevelBadge';
import { SegmentedControl } from '../components/SegmentedControl';
import { UserAvatar } from '../components/UserAvatar';
import { PostCardSkeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { FriendLinksCard } from '../components/FriendLinksCard';
import { formatEast8Date, getSmartDailyTitle } from '../utils/format';
import { SeriesPanel } from '../components/SeriesPanel';
import { openCollectionModal, onCollectionChanged } from '../utils/collection';

const DEFAULT_CATEGORIES = ['全部', '科技前沿', '后端架构', '设计美学', '极客日常', '综合交流'];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 搜索状态与地址栏的对应关系：`?q=<关键词>`，用户搜索时额外带 `&stype=users`。
 * 回车搜索必须真实改变 URL（可分享、可刷新、可前进后退），否则搜索结果页没有可寻址的落地页。
 */
type SearchTargetType = 'posts' | 'users';

const readSearchQueryFromUrl = (): { q: string; target: SearchTargetType } => {
  try {
    const params = new URLSearchParams(window.location.search);
    return {
      q: params.get('q') || '',
      target: params.get('stype') === 'users' ? 'users' : 'posts',
    };
  } catch {
    return { q: '', target: 'posts' };
  }
};

/** push 用于「回车搜索」以留下可回退的历史；replace 用于清空等不应污染历史的场景 */
const writeSearchQueryToUrl = (q: string, target: SearchTargetType, replace = false) => {
  try {
    const url = new URL(window.location.href);
    const keyword = q.trim();
    if (keyword) {
      url.searchParams.set('q', keyword);
      if (target === 'users') url.searchParams.set('stype', 'users');
      else url.searchParams.delete('stype');
    } else {
      url.searchParams.delete('q');
      url.searchParams.delete('stype');
    }
    if (url.toString() === window.location.href) return;
    if (replace) window.history.replaceState({ q: keyword }, '', url.toString());
    else window.history.pushState({ q: keyword }, '', url.toString());
  } catch {
    /* 地址栏不可用时静默忽略，搜索本身仍然可用 */
  }
};

/** 搜索结果关键词高亮：大小写不敏感，仅渲染命中片段 */
const HighlightText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const keyword = query.trim();
  if (!keyword) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(keyword)})`, 'ig'));
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === keyword.toLowerCase() ? (
          <mark key={index} className="bg-wb-warn/45 text-inherit rounded px-0.5">
            {part}
          </mark>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        )
      )}
    </>
  );
};

interface SearchedUserItem {
  id: string;
  username: string;
  nickname?: string | null;
  avatar_url?: string | null;
  bio?: string;
  level: number;
  role: string;
  followers_count: number;
  following_count: number;
  is_following: boolean;
  /** 命中来源：username / nickname / bio */
  match_type?: string;
}

interface TelemetryData {
  total_posts: number;
  total_users: number;
  online_users: number;
  top_hot_posts: { id: string; title: string; comment_count: number; like_count: number }[];
}

interface PublicStats {
  total_posts: number;
  total_members: number;
  popular_tags: string[];
  top_hot_posts: { id: string; title: string; comment_count: number; like_count: number }[];
  top_contributors: {
    username: string;
    nickname?: string | null;
    avatar_url: string;
    level: number;
    role: string;
    experience: number;
  }[];
}

interface Props {
  onSelectPost: (postId: string) => void;
  user?: UserProfile | null;
  onRequireAuth?: () => void;
  onGoWrite?: () => void;
  onGoWriteDaily?: () => void;
  onGoAdmin?: () => void;
  onRefreshUser?: () => void;
  onSelectUser?: (username: string) => void;
  onGoRules?: () => void;
  onGoLegal?: () => void;
  /** 打开友情链接独立页 */
  onOpenLinks?: () => void;
  /** 首页当前是否处于可见状态（App 用 display:none 常驻挂载，切回时需重拉信息流） */
  isActive?: boolean;
}

const generatePaginationPages = (current: number, total: number): (number | string)[] => {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, '...', total];
  }
  if (current >= total - 3) {
    return [1, '...', total - 4, total - 3, total - 2, total - 1, total];
  }
  return [1, '...', current - 1, current, current + 1, '...', total];
};

export const Home: React.FC<Props> = ({
  onSelectPost,
  user,
  onRequireAuth,
  onGoWrite,
  onGoWriteDaily,
  onGoAdmin,
  onRefreshUser,
  onSelectUser,
  onGoRules,
  onGoLegal,
  onOpenLinks,
  isActive = true,
}) => {
  const toast = useToast();
  const [posts, setPosts] = useState<PostSimple[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [isFetchingPosts, setIsFetchingPosts] = useState(false);

  // 首页浏览偏好 (无限滚动 vs 普通传统分页，仿照 linux.sb)
  const [infiniteScroll, setInfiniteScroll] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('geek_home_infinite_scroll');
      // 默认分页：一页 10 条，DOM 数量固定，滚动更稳，也更符合「翻页浏览」的习惯
      return saved !== null ? saved === 'true' : false;
    } catch {
      return false;
    }
  });

  const [currentPage, setCurrentPage] = useState<number>(1);
  const [jumpPageInput, setJumpPageInput] = useState<string>('');
  const PAGE_SIZE = 10;
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const feedTopRef = useRef<HTMLDivElement | null>(null);
  // 请求序号：快速切换排序/搜索/筛选时，丢弃先发后到的过期响应，避免列表串数据
  const postsReqIdRef = useRef(0);
  const [followingPosts, setFollowingPosts] = useState<PostSimple[]>([]);
  const [streamTab, setStreamTab] = useState<'all' | 'following'>('all');
  const [loadingFollowing, setLoadingFollowing] = useState(false);
  // 服务端分页游标：一次拉一页（100 条），滚动/翻页到底再向后取，突破"只有前 100 篇"的上限
  const [postsPage, setPostsPage] = useState<number>(1);
  // 服务端返回的全站命中总数（搜索态下用于「共 N 篇」与分页）
  const [totalPosts, setTotalPosts] = useState<number>(0);
  const [hasMorePosts, setHasMorePosts] = useState<boolean>(false);
  const [loadingMorePosts, setLoadingMorePosts] = useState<boolean>(false);
  const [newsPost, setNewsPost] = useState<PostSimple | null>(null);
  const [filter, setFilter] = useState<'latest' | 'hot' | 'comments'>('latest');
  const [selectedCategory, setSelectedCategory] = useState<string>('全部');

  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  // 分类 id → 名称，用于在信息流卡片上显示分类锚点
  const [categoryMap, setCategoryMap] = useState<Record<number, string>>({});

  useEffect(() => {
    apiClient.get('/posts/categories').then((res) => {
      if (Array.isArray(res.data) && res.data.length > 0) {
        const catNames = res.data
          .filter((c: any) => c.slug !== 'news' && c.name !== '新闻早报')
          .map((c: any) => c.name);
        const finalCats = Array.from(new Set(['全部', ...catNames, '综合交流']));
        setCategories(finalCats);
        const map: Record<number, string> = {};
        res.data.forEach((c: any) => {
          if (c && typeof c.id === 'number' && c.name) map[c.id] = c.name;
        });
        setCategoryMap(map);
      }
    }).catch(() => {});
  }, []);
  // 首屏即从地址栏恢复搜索词，保证 ?q=xxx 的链接打开就是结果页（刷新/分享/直达都成立）
  const [searchQuery, setSearchQuery] = useState<string>(() => readSearchQueryFromUrl().q);
  // 输入联想：文章 / 用户（防抖 220ms 请求 /search/suggest）
  const [suggest, setSuggest] = useState<{ posts: { id: string; title: string }[]; users: { username: string; nickname: string }[] }>({
    posts: [],
    users: [],
  });
  const [searchTarget, setSearchTarget] = useState<SearchTargetType>(() => readSearchQueryFromUrl().target);
  // 文章/极客切换：只做水平位移的实测胶囊，避免 layout 投影带来的上下抖动
  const postsTargetRef = useRef<HTMLButtonElement | null>(null);
  const usersTargetRef = useRef<HTMLButtonElement | null>(null);
  const [targetPill, setTargetPill] = useState<{ x: number; width: number }>({ x: 0, width: 0 });

  const measureTargetPill = React.useCallback(() => {
    const el = searchTarget === 'posts' ? postsTargetRef.current : usersTargetRef.current;
    if (!el) return;
    const next = { x: el.offsetLeft, width: el.offsetWidth };
    setTargetPill((prev) =>
      Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.width - next.width) < 0.5 ? prev : next
    );
  }, [searchTarget]);

  useLayoutEffect(() => {
    measureTargetPill();
  }, [measureTargetPill]);

  useEffect(() => {
    const handle = () => measureTargetPill();
    window.addEventListener('resize', handle);
    if (document.fonts?.ready) {
      document.fonts.ready.then(handle).catch(() => undefined);
    }
    return () => window.removeEventListener('resize', handle);
  }, [measureTargetPill]);
  const [searchSort, setSearchSort] = useState<'relevance' | 'latest' | 'hot'>('relevance');
  const [timeRange, setTimeRange] = useState<'all' | 'week' | 'month'>('all');
  // 按作者筛选（服务端 User.username 精确匹配）
  const [searchAuthor, setSearchAuthor] = useState<string>('');
  const [searchedUsers, setSearchedUsers] = useState<SearchedUserItem[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [checkedInLocally, setCheckedInLocally] = useState(false);

  const hasCheckedInToday = Boolean(user?.has_checked_in_today || checkedInLocally);

  // 搜索容器引用与聚焦浮层状态
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const [isSearchFocused, setIsSearchFocused] = useState(false);

  // 真实搜索历史 (初始为空数组，支持单项删除与清空)
  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    try {
      const s = localStorage.getItem('geek_search_history');
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  });

  const addSearchHistory = (term: string) => {
    if (!term.trim()) return;
    const clean = term.trim();
    setSearchHistory((prev) => {
      const next = [clean, ...prev.filter((s) => s !== clean)].slice(0, 8);
      localStorage.setItem('geek_search_history', JSON.stringify(next));
      return next;
    });
  };

  const removeSearchHistory = (term: string) => {
    setSearchHistory((prev) => {
      const next = prev.filter((s) => s !== term);
      localStorage.setItem('geek_search_history', JSON.stringify(next));
      return next;
    });
  };

  const clearSearchHistory = () => {
    setSearchHistory([]);
    localStorage.removeItem('geek_search_history');
    toast.info('搜索历史已清空');
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        setIsSearchFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // 浏览器前进/后退时，把搜索框与地址栏里的 ?q= 重新对齐
  useEffect(() => {
    const handlePopState = () => {
      const { q, target } = readSearchQueryFromUrl();
      setSearchQuery(q);
      setSearchTarget(target);
      setCurrentPage(1);
      setPostsPage(1);
      setIsSearchFocused(false);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const isAdmin = ['super_admin', 'admin', 'moderator', 'auditor'].includes(user?.role || '');
  const isSuperAdmin = ['super_admin', 'admin'].includes(user?.role || '');

  const [telemetry, setTelemetry] = useState<TelemetryData>({
    total_posts: 0,
    total_users: 0,
    online_users: 0,
    top_hot_posts: [],
  });

  const [publicStats, setPublicStats] = useState<PublicStats>({
    total_posts: 0,
    total_members: 0,
    popular_tags: [],
    top_hot_posts: [],
    top_contributors: [],
  });

  const showToast = (msg: string) => {
    toast.info(msg);
  };

  const fetchStats = async () => {
    if (isSuperAdmin) {
      try {
        const res = await apiClient.get('/posts/stats/telemetry');
        if (res.data && res.data.total_posts !== undefined) {
          setTelemetry(res.data);
        }
      } catch {}
    } else {
      try {
        const res = await apiClient.get('/posts/stats/public');
        if (res.data && res.data.popular_tags) {
          setPublicStats(res.data);
        }
      } catch {}
    }
  };

  const handleCheckin = async () => {
    if (!user) {
      onRequireAuth?.();
      return;
    }
    if (hasCheckedInToday) {
      showToast('今日已完成签到打卡');
      return;
    }
    setCheckingIn(true);
    try {
      const res = await apiClient.post('/users/checkin');
      setCheckedInLocally(true);
      showToast(`打卡成功！获得 +${res.data.exp_gained} 经验 (连续 ${res.data.continuous_days} 天)`);
      onRefreshUser?.();
    } catch (err: any) {
      if (err.response?.data?.detail?.includes('今日已经完成签到') || err.response?.data?.detail?.includes('已完成签到')) {
        setCheckedInLocally(true);
      }
      showToast(err.response?.data?.detail || '今日已完成签到');
    } finally {
      setCheckingIn(false);
    }
  };

  // 置顶日报：独立请求「最新一期」，不受列表的 最新/热议/分类筛选影响
  const fetchLatestNews = async () => {
    try {
      const res = await apiClient.get('/posts/latest-news');
      setNewsPost(res.data || null);
    } catch {
      // 失败时保留上一次的卡片，避免置顶区域闪烁消失
    }
  };

  const FEED_PAGE_SIZE = 100;

  const fetchPosts = async (page: number = 1, append: boolean = false) => {
    const reqId = ++postsReqIdRef.current;
    if (posts.length === 0) {
      setLoadingPosts(true);
    }
    setIsFetchingPosts(true);
    // 排序统一交给服务端：热议按评论数，搜索按相关度/最新/最热
    const serverSort = searchQuery.trim()
      ? searchSort === 'relevance' ? 'relevance' : searchSort === 'hot' ? 'hot' : 'latest'
      : filter;
    const pageSize = infiniteScroll ? FEED_PAGE_SIZE : PAGE_SIZE;
    try {
      const res = await apiClient.get('/posts', {
        params: {
          sort_by: serverSort,
          page,
          size: pageSize,
          // 搜索走后端全库检索（标题/标签/正文），不再局限于已加载的前 100 篇
          q: searchQuery.trim() || undefined,
          // 分类 / 时间 / 作者一律下推服务端，保证「共 N 篇」和分页都是全站口径
          category: selectedCategory !== '全部' ? selectedCategory : undefined,
          time_range: timeRange !== 'all' ? timeRange : undefined,
          author: searchQuery.trim() && searchAuthor.trim() ? searchAuthor.trim() : undefined,
        },
      });
      // 已被更新的请求取代：直接丢弃，避免旧筛选结果覆盖新列表
      if (reqId !== postsReqIdRef.current) return;
      const rawTotal = Number(res.headers?.['x-total-count']);
      const hasServerTotal = Number.isFinite(rawTotal) && rawTotal >= 0;
      if (hasServerTotal) setTotalPosts(rawTotal);
      const data: PostSimple[] = Array.isArray(res.data) ? res.data : [];
      setPostsPage(page);

      if (!append) {
        setPosts(data);
        // 置顶日报不再从当前列表里挑：列表受 最新/热议/分类 影响，
        // 会导致切换排序时置顶卡片显示成几天前的旧日报。改由 /posts/latest-news 单独提供。
        // 是否还有更多一律以服务端总数（X-Total-Count）为准：
        // 不能用「本页条数 >= 请求 size」判断——缓存返回的条数可能不等于请求的 size，
        // 那样会把「其实还有几十篇」误判成「已经到底」，无限滚动就此卡死。
        setHasMorePosts(
          data.length === 0
            ? false
            : hasServerTotal
            ? data.length < rawTotal
            : data.length >= pageSize
        );
      } else if (data.length > 0) {
        // 追加下一页并按 id 去重，避免与已加载数据重复
        // 函数式更新：用最新列表拼接，避免请求发起时的旧快照覆盖期间的收藏/点赞等乐观更新
        setPosts((prev) => {
          const seenPrev = new Set(prev.map((x) => x.id));
          const merged = [...prev, ...data.filter((x) => !seenPrev.has(x.id))];
          setHasMorePosts(hasServerTotal ? merged.length < rawTotal : data.length >= pageSize);
          return merged;
        });
      } else {
        // 请求到空页说明已经到底，必须停手，否则触底观察器会无限重试
        setHasMorePosts(false);
      }
    } catch {
      if (reqId !== postsReqIdRef.current) return;
      if (page === 1 && posts.length === 0) {
        setPosts([]);
      }
    } finally {
      if (reqId === postsReqIdRef.current) {
        setLoadingPosts(false);
        setIsFetchingPosts(false);
      }
    }
  };

  // 拉取下一页（滚动触底 / 分页翻到最后时调用）
  const loadMorePosts = async () => {
    if (loadingMorePosts || isFetchingPosts || !hasMorePosts) return;
    // 已加载条数达到服务端总数时不必再请求（防止多打一次空页请求）
    if (totalPosts > 0 && posts.length >= totalPosts) return;
    setLoadingMorePosts(true);
    try {
      await fetchPosts(postsPage + 1, true);
    } finally {
      setLoadingMorePosts(false);
    }
  };

  const fetchFollowingPosts = async () => {
    if (!user) return;
    setLoadingFollowing(true);
    try {
      // 此前后端默认只返回 20 条且前端无分页入口，关注动态超过 20 条永远不可见；扩大单次拉取量
      const res = await apiClient.get('/posts/feed/following', { params: { page: 1, size: 100 } });
      if (res.data && Array.isArray(res.data)) {
        setFollowingPosts(res.data);
      }
    } catch {
      // 容错
    } finally {
      setLoadingFollowing(false);
    }
  };

  useEffect(() => {
    // 切换「分页 / 无限滚动」会改变每页条数，必须重新拉第一页并重置页码，
    // 否则列表还停在旧模式下抓到的数据，且 postsPage 带着旧的页码坐标，越翻越乱
    setCurrentPage(1);
    setPostsPage(1);
    fetchPosts(1);
    fetchStats();
    // 首页挂载/筛选切换时重新校准置顶日报为最新一期（单条查询，代价很小）
    fetchLatestNews();
    if (user && streamTab === 'following') {
      fetchFollowingPosts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, user?.role, streamTab, selectedCategory, timeRange, infiniteScroll]);

  // 首页是常驻挂载（display:none 切换），从编辑器/详情页返回时不会重新挂载，
  // 因此在重新变为可见时静默重拉第一页，让刚发布/刚修改的帖子立即出现。
  const activeMounted = useRef(false);
  // 离开首页前记住阅读位置，回来时还原，避免每次都回到顶部
  const savedScrollRef = useRef(0);
  const restoringRef = useRef(false);

  useEffect(() => {
    const onScroll = () => {
      if (!isActive || restoringRef.current) return;
      savedScrollRef.current = window.scrollY;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [isActive]);

  useEffect(() => {
    if (!activeMounted.current) {
      activeMounted.current = true;
      return;
    }
    if (!isActive) return;
    const target = savedScrollRef.current;
    restoringRef.current = true;
    // 回到首页时保留原来的分页位置（第 2 页进来就还回第 2 页），
    // 只刷新当前页数据，不重置页码/列表
    fetchPosts(currentPage).then(() => {
      if (target > 0) requestAnimationFrame(() => window.scrollTo({ top: target }));
      // 渲染完成后再解锁，避免还原过程被自身滚动事件覆盖
      window.setTimeout(() => { restoringRef.current = false; }, 300);
    });
    fetchStats();
    // 回到首页时顺带刷新置顶日报，刚发布的新一期能立即生效
    fetchLatestNews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // 搜索词变化防抖后重拉全库检索结果（400ms）
  // 首帧跳过：挂载时已有 fetchPosts()，否则每次进首页都会重复请求一次
  const suggestReqIdRef = useRef(0);
  const userSearchReqIdRef = useRef(0);
  const searchEffectMounted = useRef(false);

  /** 清空搜索：一次性同步所有派生状态，避免旧请求回填 / 浮层残留 / URL 与 UI 不一致 */
  const clearSearch = () => {
    setSearchQuery('');
    setIsSearchFocused(false);
    setSuggest({ posts: [], users: [] });
    setSearchedUsers([]);
    setSearchingUsers(false);
    // 让所有在途请求自动失效（各 effect 的 reqId 守卫会丢弃它们）
    suggestReqIdRef.current += 1;
    userSearchReqIdRef.current += 1;
    postsReqIdRef.current += 1;
    setCurrentPage(1);
    setPostsPage(1);
    writeSearchQueryToUrl('', searchTarget, true);
  };
  useEffect(() => {
    if (!searchEffectMounted.current) {
      searchEffectMounted.current = true;
      return;
    }
    const t = setTimeout(() => {
      fetchPosts(1);
    }, searchQuery.trim() ? 400 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchSort, searchAuthor]);

  // 普通分页模式：切换页码直接向服务端取对应页
  useEffect(() => {
    if (infiniteScroll) return;
    if (currentPage === postsPage) return;
    // 页码超出服务端总页数时不再请求：越界页会返回空数组，
    // 列表变空后分页控件也会随之消失，用户就"回不去"了
    if (totalPosts > 0 && (currentPage - 1) * PAGE_SIZE >= totalPosts) return;
    fetchPosts(currentPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, infiniteScroll]);

  // 输入联想（仅在聚焦且有输入时请求）
  useEffect(() => {
    const q = searchQuery.trim();
    if (!isSearchFocused || q.length < 1) {
      suggestReqIdRef.current += 1;
      setSuggest({ posts: [], users: [] });
      return;
    }
    const reqId = ++suggestReqIdRef.current;
    const timer = setTimeout(() => {
      apiClient
        .get('/search/suggest', { params: { q, limit: 4 } })
        .then((res) => {
          if (reqId !== suggestReqIdRef.current) return;
          setSuggest({ posts: res.data?.posts || [], users: res.data?.users || [] });
        })
        .catch(() => undefined);
    }, 220);
    return () => clearTimeout(timer);
  }, [searchQuery, isSearchFocused]);

  // 帖子收藏切换（乐观更新 + 失败回滚）
  const handleToggleCollect = (e: React.MouseEvent, post: PostSimple) => {
    e.stopPropagation();
    if (!localStorage.getItem('access_token')) return;
    // 收藏时统一弹窗：可选择已有收藏夹、新建收藏夹或取消收藏
    openCollectionModal({ id: post.id, title: post.title, is_collected: post.is_collected });
  };

  // 弹窗操作完成后同步本地两条信息流，避免 UI 与后端不一致
  useEffect(() => onCollectionChanged((c) => {
    const apply = (list: PostSimple[]) =>
      list.map((p) => (p.id === c.postId ? { ...p, is_collected: c.is_collected } : p));
    setPosts(apply);
    setFollowingPosts(apply);
  }), []);

  // 帖子一键复制链接
  const handleShare = (e: React.MouseEvent, post: PostSimple) => {
    e.stopPropagation();
    const url = `${window.location.origin}?post=${post.id}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url);
    }
    showToast('文章分享链接已复制到剪贴板');
  };

  // 极客用户复合搜索 (Debounced)
  useEffect(() => {
    if (searchTarget === 'users') {
      const q = searchQuery.trim();
      if (!q) {
        userSearchReqIdRef.current += 1;
        setSearchedUsers([]);
        setSearchingUsers(false);
        return;
      }
      setSearchingUsers(true);
      const reqId = ++userSearchReqIdRef.current;
      const timer = setTimeout(async () => {
        try {
          const res = await apiClient.get('/users/search', {
            params: { q, limit: 30 },
          });
          if (reqId !== userSearchReqIdRef.current) return;
          setSearchedUsers(Array.isArray(res.data) ? res.data : []);
        } catch {
          setSearchedUsers([]);
        } finally {
          setSearchingUsers(false);
        }
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [searchTarget, searchQuery]);

  // 搜索列表用户关注/取关快捷操作
  const handleToggleFollowUser = async (e: React.MouseEvent, target: SearchedUserItem) => {
    e.stopPropagation();
    if (!user) {
      onRequireAuth?.();
      return;
    }
    const nextState = !target.is_following;
    setSearchedUsers((prev) =>
      prev.map((u) =>
        u.id === target.id
          ? {
              ...u,
              is_following: nextState,
              followers_count: Math.max(0, u.followers_count + (nextState ? 1 : -1)),
            }
          : u
      )
    );

    try {
      if (nextState) {
        await apiClient.post(`/users/${target.username}/follow`);
        showToast(`已关注 @${target.username}`);
      } else {
        await apiClient.delete(`/users/${target.username}/follow`);
        showToast(`已取消关注 @${target.username}`);
      }
      onRefreshUser?.();
    } catch {
      // 失败回滚
      setSearchedUsers((prev) =>
        prev.map((u) =>
          u.id === target.id
            ? {
                ...u,
                is_following: !nextState,
                followers_count: Math.max(0, u.followers_count + (nextState ? -1 : 1)),
              }
            : u
        )
      );
      showToast('操作失败，请重试');
    }
  };

  // 实时多维过滤与搜索
  const filteredPosts = useMemo(() => {
    const sourceList = streamTab === 'following' ? followingPosts : posts;
    let list = Array.isArray(sourceList) ? [...sourceList] : [];

    // 发现流：分类/时间/搜索/排序已由服务端完成，前端不能再筛（否则正文命中的结果会被误删）
    if (streamTab !== 'following') {
      return list;
    }

    // 分类筛选
    if (selectedCategory !== '全部') {
      list = list.filter((p) => p.category_name === selectedCategory);
    }

    // 时间跨度筛选 (Time Range Filter)
    if (timeRange !== 'all') {
      const now = Date.now();
      const cutoff = timeRange === 'week' ? 7 * 86400 * 1000 : 30 * 86400 * 1000;
      list = list.filter((p) => {
        const time = new Date(p.created_at).getTime();
        return !isNaN(time) ? now - time <= cutoff : true;
      });
    }

    // 关键词与标签搜索
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      list = list.filter(
        (p) =>
          p.title.toLowerCase().includes(query) ||
          p.author_username.toLowerCase().includes(query) ||
          (p.author_nickname && p.author_nickname.toLowerCase().includes(query)) ||
          (p.category_name && p.category_name.toLowerCase().includes(query)) ||
          (p.tags && p.tags.some((t) => t.toLowerCase().includes(query)))
      );
    }

    // 排序逻辑 (如果处于搜索中且选了综合匹配，采用综合相关度评分；否则按常规/热榜排序)
    if (query && searchSort === 'relevance') {
      list.sort((a, b) => {
        if (a.is_pinned && !b.is_pinned) return -1;
        if (!a.is_pinned && b.is_pinned) return 1;

        let scoreA = 0;
        let scoreB = 0;
        if (a.title.toLowerCase().includes(query)) scoreA += 10;
        if (b.title.toLowerCase().includes(query)) scoreB += 10;
        if (a.tags && a.tags.some((t) => t.toLowerCase().includes(query))) scoreA += 6;
        if (b.tags && b.tags.some((t) => t.toLowerCase().includes(query))) scoreB += 6;
        scoreA += (a.like_count || 0) * 0.1 + (a.comment_count || 0) * 0.2;
        scoreB += (b.like_count || 0) * 0.1 + (b.comment_count || 0) * 0.2;

        return scoreB - scoreA;
      });
    } else {
      const activeSort = query ? searchSort : filter;
      if (activeSort === 'hot') {
        const now = Date.now();
        list.sort((a, b) => {
          if (a.is_pinned && !b.is_pinned) return -1;
          if (!a.is_pinned && b.is_pinned) return 1;
          const hoursA = Math.max(0, (now - new Date(a.created_at).getTime()) / 3600000);
          const hoursB = Math.max(0, (now - new Date(b.created_at).getTime()) / 3600000);
          const scoreA = (a.like_count * 2 + a.comment_count * 3 + a.view_count * 0.2) / Math.pow(hoursA + 2, 1.5);
          const scoreB = (b.like_count * 2 + b.comment_count * 3 + b.view_count * 0.2) / Math.pow(hoursB + 2, 1.5);
          return scoreB - scoreA;
        });
      } else if (activeSort === 'comments') {
        list.sort((a, b) => {
          if (a.is_pinned && !b.is_pinned) return -1;
          if (!a.is_pinned && b.is_pinned) return 1;
          return b.comment_count - a.comment_count;
        });
      } else {
        list.sort((a, b) => {
          if (a.is_pinned && !b.is_pinned) return -1;
          if (!a.is_pinned && b.is_pinned) return 1;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });
      }
    }

    return list;
  }, [posts, followingPosts, streamTab, selectedCategory, searchQuery, filter, searchSort, timeRange]);

  // —— 总数口径 ——
  // 关注流是前端本地筛选，只能以已加载条数为准；
  // 全站流一律用服务端 X-Total-Count，否则「共 N 篇」只会显示当前这一页的条数，
  // 总页数也会被算成 1，分页控件直接消失。
  const listTotal =
    streamTab === 'following'
      ? filteredPosts.length
      : totalPosts > 0
      ? totalPosts
      : filteredPosts.length;
  // 无限滚动每页 100、分页模式每页 10，总页数必须按当前模式的实际页大小算
  const effectivePageSize = infiniteScroll ? 100 : PAGE_SIZE;
  // 搜索态优先用当前筛选的服务端总数，避免展示上一次筛选的残留值
  const displayTotal = searchQuery.trim() ? (listTotal || totalPosts) : listTotal;

  // 计算总页数与当前页
  const totalPages = Math.max(1, Math.ceil(listTotal / effectivePageSize));
  const effectiveCurrentPage = Math.min(currentPage, totalPages);

  // 筛选后总数变少导致页码越界时，自动回退到最后一页，避免停在空白页
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  // 快速跳转至指定页码
  const handleJumpPage = () => {
    const target = parseInt(jumpPageInput.trim(), 10);
    if (!isNaN(target) && target >= 1 && target <= totalPages) {
      setCurrentPage(target);
      setJumpPageInput('');
      feedTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      toast.warning(`请输入 1 至 ${totalPages} 之间的有效页码`);
    }
  };

  // 服务端已按页返回：无限滚动由追加实现，普通分页每次只渲染当前页
  const displayedPosts = streamTab === 'following' ? filteredPosts : posts;

  // 当筛选条件、搜索词变化时重置页码
  useEffect(() => {
    setCurrentPage(1);
  }, [filter, selectedCategory, searchQuery, timeRange, streamTab]);

  // 跨组件监听浏览偏好切换事件
  useEffect(() => {
    const handleScrollPref = (e: Event) => {
      const custom = e as CustomEvent<boolean>;
      if (typeof custom.detail === 'boolean') {
        setInfiniteScroll(custom.detail);
      }
    };
    window.addEventListener('geek_infinite_scroll_change', handleScrollPref);
    return () => window.removeEventListener('geek_infinite_scroll_change', handleScrollPref);
  }, []);

  // 切换「无限滚动 / 普通分页」时页大小会变，需要按新模式重新取第一页
  const scrollModeMounted = useRef(false);
  useEffect(() => {
    if (!scrollModeMounted.current) {
      scrollModeMounted.current = true;
      return;
    }
    setCurrentPage(1);
    if (streamTab === 'all') fetchPosts(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infiniteScroll]);

  // 无限滚动 IntersectionObserver 监听底部哨兵
  useEffect(() => {
    if (!infiniteScroll) return;
    const sentinel = bottomSentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        // 服务端分页：触底直接取下一页并追加，直到没有更多
        if (first.isIntersecting && hasMorePosts && !loadingPosts && !isFetchingPosts && !loadingMorePosts) {
          void loadMorePosts();
        }
      },
      { rootMargin: '300px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [infiniteScroll, loadingPosts, isFetchingPosts, loadingMorePosts, hasMorePosts]);

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-4 py-3 sm:py-5 flex flex-col lg:flex-row gap-5 sm:gap-7 items-start w-full overflow-hidden">
      {/* 左侧主内容流 (占据全屏核心视觉区，拒绝侧边栏抢镜) */}
      <div className="flex-1 min-w-0 space-y-3 sm:space-y-5 w-full">
        {/* 热门早报始终在首页置顶 (Pinned Top News Banner) */}
        {newsPost ? (
          <div
            onClick={() => onSelectPost(newsPost.id)}
            className="surface wb-pressable cursor-pointer p-4 md:p-5 rounded-3xl border border-wb-border-subtle shadow-card hover:border-wb-border-strong flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 transition-all group"
          >
            <div className="space-y-1.5 flex-1">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 text-2xs font-semibold px-2.5 py-0.5 rounded-capsule bg-wb-text-primary text-wb-bg-page">
                  <Sparkles className="w-3 h-3" /> 每日早报 · 置顶要闻
                </span>
                <span className="text-xs text-wb-text-muted font-mono">
                  {formatEast8Date(newsPost.created_at)}
                </span>
              </div>
              <h3 className="font-semibold text-sm md:text-base text-wb-text-primary group-hover:underline line-clamp-1">
                {getSmartDailyTitle(newsPost.title, newsPost.id)}
              </h3>
            </div>
            <div className="flex items-center gap-2 self-end sm:self-center">
              {isAdmin && onGoWriteDaily && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onGoWriteDaily();
                  }}
                  className="wb-pressable h-7 px-2.5 rounded-capsule bg-wb-bg-subtle hover:bg-wb-border-subtle border border-wb-border-subtle text-wb-text-primary text-2xs font-semibold flex items-center gap-1 transition-colors"
                  title="管理员专属：起草并更新今日极客日报"
                >
                  <Edit3 className="w-3 h-3" />
                  <span>撰写新日报</span>
                </button>
              )}
              <div className="flex items-center gap-1 text-xs font-medium text-wb-text-secondary">
                <span>立即阅读</span>
                <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
              </div>
            </div>
          </div>
        ) : (
          isAdmin && onGoWriteDaily && (
            <div
              onClick={onGoWriteDaily}
              className="wb-pressable cursor-pointer p-3.5 px-4 rounded-2xl bg-wb-bg-subtle/60 border border-dashed border-wb-border-subtle hover:border-wb-border-strong flex items-center justify-between gap-3 transition-colors text-xs"
            >
              <div className="flex items-center gap-2 text-wb-text-primary">
                <Sparkles className="w-4 h-4" />
                <span className="font-medium">今日尚未发布全站极客日报，点击一键起草每日新闻</span>
              </div>
              <span className="font-semibold underline flex items-center gap-1">
                <span>起草发布</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </span>
            </div>
          )
        )}

        {/* 核心流模式切换: 全部发现 vs 关注动态 */}
        <div className="flex items-center justify-between gap-3">
          <div className="relative flex items-center gap-1.5 p-1 rounded-capsule frost shrink-0">
            <button
              type="button"
              onClick={() => {
                setStreamTab('all');
                setSearchTarget('posts');
              }}
              className={`wb-pressable relative z-10 h-8 px-4 rounded-capsule text-xs font-semibold transition-colors duration-200 whitespace-nowrap shrink-0 select-none ${
                streamTab === 'all' && searchTarget === 'posts'
                  ? 'text-wb-bg-page'
                  : 'text-wb-text-secondary hover:text-wb-text-primary'
              }`}
            >
              {streamTab === 'all' && searchTarget === 'posts' && (
                <motion.div
                  layoutId="home-stream-pill"
                  transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                  className="absolute inset-0 bg-wb-text-primary rounded-capsule shadow-sm -z-10"
                />
              )}
              全部发现
            </button>
            <button
              type="button"
              onClick={() => {
                setStreamTab('following');
                setSearchTarget('posts');
                if (user) fetchFollowingPosts();
              }}
              className={`wb-pressable relative z-10 h-8 px-4 rounded-capsule text-xs font-semibold transition-colors duration-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 select-none ${
                streamTab === 'following' && searchTarget === 'posts'
                  ? 'text-wb-bg-page'
                  : 'text-wb-text-secondary hover:text-wb-text-primary'
              }`}
            >
              {streamTab === 'following' && searchTarget === 'posts' && (
                <motion.div
                  layoutId="home-stream-pill"
                  transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                  className="absolute inset-0 bg-wb-text-primary rounded-capsule shadow-sm -z-10"
                />
              )}
              {/* 此处曾展示 user.following_count 角标，但它表示「关注人数」而非动态条数，
                  极易被误读为「有 N 条新动态」，故移除；关注人数改由右侧文案单独说明 */}
              <span className="whitespace-nowrap">关注动态</span>
            </button>
          </div>

          {streamTab === 'following' && user && (
            <span className="text-xs text-wb-text-muted font-mono hidden sm:inline whitespace-nowrap">
              已关注 {user.following_count || 0} 位极客创作者
            </span>
          )}
        </div>

        {/* 综合搜索栏与实时输入 (Clean Search Bar with Popover) */}
        <div ref={searchContainerRef} className="relative z-30 w-full max-w-full">
          <div className="flex items-center gap-1.5 sm:gap-2 w-full max-w-full">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 sm:left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-wb-text-muted pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onFocus={() => setIsSearchFocused(true)}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const keyword = searchQuery.trim();
                    if (keyword) {
                      addSearchHistory(keyword);
                      // 回车 = 提交一次正式搜索：地址栏变成 ?q=关键词，结果页可分享、可刷新
                      writeSearchQueryToUrl(keyword, searchTarget);
                    }
                    setCurrentPage(1);
                    setPostsPage(1);
                    setIsSearchFocused(false);
                  } else if (e.key === 'Escape') {
                    setIsSearchFocused(false);
                  }
                }}
                placeholder={searchTarget === 'posts' ? "搜索文章、作者、技术标签..." : "搜索极客用户名、个人简介..."}
                className="w-full h-10 sm:h-11 pl-9 sm:pl-10 pr-9 sm:pr-10 text-xs md:text-sm bg-wb-bg-surface border border-wb-border-subtle rounded-2xl text-wb-text-primary placeholder:text-wb-text-muted focus:outline-none focus:border-wb-border-strong shadow-card transition-all"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={clearSearch}
                  onMouseDown={(e) => e.preventDefault()}
                  className="absolute right-2 sm:right-3 top-0 bottom-0 my-auto h-7 w-7 flex items-center justify-center text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle rounded-full transition-colors"
                  title="清空输入"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* 搜索目标切换胶囊: 搜文章 / 搜极客（纯水平滑动，无上下抖动） */}
            <div className="relative flex items-center p-0.5 sm:p-1 rounded-2xl frost shrink-0 whitespace-nowrap">
              {targetPill.width > 0 && (
                <motion.div
                  aria-hidden="true"
                  className="absolute top-0.5 bottom-0.5 left-0 rounded-xl bg-wb-text-primary shadow-sm"
                  initial={false}
                  animate={{ x: targetPill.x, width: targetPill.width }}
                  transition={{ type: 'spring', stiffness: 520, damping: 40, mass: 0.8 }}
                />
              )}
              <button
                ref={postsTargetRef}
                type="button"
                onClick={() => setSearchTarget('posts')}
                className={`relative z-10 wb-pressable h-8 sm:h-9 px-2 sm:px-3.5 rounded-xl text-xs font-semibold transition-colors flex items-center gap-1 sm:gap-1.5 whitespace-nowrap shrink-0 ${
                  searchTarget === 'posts'
                    ? 'text-wb-bg-page'
                    : 'text-wb-text-secondary hover:text-wb-text-primary'
                }`}
                title="搜索文章"
              >
                <FileText className="w-3.5 h-3.5 shrink-0" />
                {/* 手机上只留图标，避免把搜索框挤得只能显示半句占位文案 */}
                <span className="hidden sm:inline whitespace-nowrap">文章</span>
              </button>
              <button
                ref={usersTargetRef}
                type="button"
                onClick={() => setSearchTarget('users')}
                className={`relative z-10 wb-pressable h-8 sm:h-9 px-2 sm:px-3.5 rounded-xl text-xs font-semibold transition-colors flex items-center gap-1 sm:gap-1.5 whitespace-nowrap shrink-0 ${
                  searchTarget === 'users'
                    ? 'text-wb-bg-page'
                    : 'text-wb-text-secondary hover:text-wb-text-primary'
                }`}
                title="搜索极客"
              >
                <Users className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden sm:inline whitespace-nowrap">极客</span>
              </button>
            </div>
          </div>

          {/* 搜索下拉浮层 (聚焦时展现真实历史与动态热搜) */}
          {isSearchFocused && (
            <div
              className="absolute left-0 right-0 top-full mt-2 frost-panel border border-wb-border-subtle rounded-2xl p-4 shadow-2xl space-y-3.5 animate-scale-up"
              onMouseDown={(e) => {
                if ((e.target as HTMLElement).tagName !== 'BUTTON' && (e.target as HTMLElement).tagName !== 'SPAN') {
                  e.preventDefault();
                }
              }}
            >
              {/* 搜索历史：输入框聚焦且未输入内容时展示，一键回填 */}
              {!searchQuery.trim() && searchHistory.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-2xs text-wb-text-muted">最近搜索</span>
                    <button
                      type="button"
                      onClick={() => {
                        setSearchHistory([]);
                        try { localStorage.removeItem('geek_search_history'); } catch {}
                      }}
                      className="text-3xs text-wb-text-muted hover:text-wb-text-primary transition-colors"
                    >
                      清空
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {searchHistory.slice(0, 6).map((term) => (
                      <button
                        key={term}
                        type="button"
                        onClick={() => {
                          setSearchQuery(term);
                          setCurrentPage(1);
                          setPostsPage(1);
                          writeSearchQueryToUrl(term, searchTarget);
                        }}
                        className="px-2.5 py-1 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs text-wb-text-secondary hover:text-wb-text-primary hover:border-wb-border-strong transition-colors"
                      >
                        {term}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 若用户正在输入内容，提供快捷搜索引导 */}
              {searchQuery.trim() && (suggest.posts.length > 0 || suggest.users.length > 0) && (
                <div className="space-y-1.5">
                  {suggest.posts.length > 0 && (
                    <div className="space-y-0.5">
                      <div className="text-2xs text-wb-text-muted px-1">文章</div>
                      {suggest.posts.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            addSearchHistory(searchQuery.trim());
                            setSearchTarget('posts');
                            setSearchQuery(item.title);
                            setIsSearchFocused(false);
                          }}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-wb-bg-subtle text-left transition-colors"
                        >
                          <FileText className="w-3.5 h-3.5 text-wb-text-muted shrink-0" />
                          <span className="text-xs text-wb-text-primary truncate">{item.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {suggest.users.length > 0 && (
                    <div className="space-y-0.5">
                      <div className="text-2xs text-wb-text-muted px-1">极客</div>
                      {suggest.users.map((item) => (
                        <button
                          key={item.username}
                          type="button"
                          onClick={() => {
                            setSearchTarget('users');
                            setSearchQuery(item.username);
                            setIsSearchFocused(false);
                            writeSearchQueryToUrl(item.username, 'users');
                          }}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-wb-bg-subtle text-left transition-colors"
                        >
                          <UserRound className="w-3.5 h-3.5 text-wb-text-muted shrink-0" />
                          <span className="text-xs text-wb-text-primary truncate">@{item.username}</span>
                          <span className="text-2xs text-wb-text-muted truncate">{item.nickname}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {searchQuery.trim() ? (
                <div className="space-y-2">
                  <div className="text-xs text-wb-text-muted flex items-center justify-between">
                    <span>快捷直达搜索</span>
                    <span className="text-3xs font-mono">按 Enter 立即搜索 · Esc 关闭</span>
                  </div>
                  <div className="space-y-1 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        const keyword = searchQuery.trim();
                        addSearchHistory(keyword);
                        writeSearchQueryToUrl(keyword, searchTarget);
                        setCurrentPage(1);
                        setPostsPage(1);
                        setIsSearchFocused(false);
                      }}
                      className="w-full flex items-center gap-2 p-2 rounded-xl hover:bg-wb-bg-subtle text-wb-text-primary transition-colors text-left"
                    >
                      <Search className="w-3.5 h-3.5 text-wb-text-muted shrink-0" />
                      <span className="truncate">
                        在全站文章中检索 “<strong className="text-wb-text-primary font-bold">{searchQuery.trim()}</strong>”
                      </span>
                    </button>
                    {searchTarget === 'posts' && (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchTarget('users');
                          addSearchHistory(searchQuery.trim());
                          setIsSearchFocused(false);
                        }}
                        className="w-full flex items-center gap-2 p-2 rounded-xl hover:bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary transition-colors text-left"
                      >
                        <Users className="w-3.5 h-3.5 text-wb-text-muted shrink-0" />
                        <span className="truncate">
                          转为在极客用户中查找 “<strong>{searchQuery.trim()}</strong>”
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {/* 真实搜索历史 (有真实记录时才展示，支持单条删除和一键清空) */}
                  {searchHistory.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-wb-text-muted">
                        <div className="flex items-center gap-1.5 font-medium text-wb-text-secondary">
                          <History className="w-3.5 h-3.5" />
                          <span>历史搜索</span>
                        </div>
                        <button
                          type="button"
                          onClick={clearSearchHistory}
                          className="wb-pressable flex items-center gap-1 text-2xs text-wb-text-muted hover:text-wb-danger transition-colors p-1"
                          title="清空所有历史"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>清空</span>
                        </button>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {searchHistory.map((item) => (
                          <span
                            key={item}
                            className="group inline-flex items-center gap-1.5 px-3 py-1 rounded-capsule bg-wb-bg-subtle hover:bg-wb-border-subtle text-xs text-wb-text-secondary hover:text-wb-text-primary border border-wb-border-subtle transition-all"
                          >
                            <span
                              className="cursor-pointer max-w-[140px] truncate"
                              onClick={() => {
                                setSearchQuery(item);
                                addSearchHistory(item);
                                setIsSearchFocused(false);
                              }}
                            >
                              {item}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeSearchHistory(item);
                              }}
                              title="删除此条历史"
                              className="text-wb-text-muted hover:text-wb-danger transition-colors opacity-50 group-hover:opacity-100"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 真实动态热搜/探索标签 (统一从后端 publicStats.popular_tags 提取，拒绝伪造重复数据) */}
                  {publicStats.popular_tags && publicStats.popular_tags.length > 0 && (
                    <div className={`space-y-2 ${searchHistory.length > 0 ? 'pt-2.5 border-t border-wb-border-subtle' : ''}`}>
                      <div className="flex items-center justify-between text-xs text-wb-text-muted">
                        <div className="flex items-center gap-1.5 font-medium text-wb-text-secondary">
                          <Flame className="w-3.5 h-3.5 text-wb-brand fill-wb-brand" />
                          <span>热门技术探索</span>
                        </div>
                        <span className="text-3xs font-mono text-wb-text-muted">全站动态</span>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {publicStats.popular_tags.slice(0, 8).map((tag, idx) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => {
                              setSearchQuery(tag);
                              addSearchHistory(tag);
                              setIsSearchFocused(false);
                            }}
                            className="wb-pressable inline-flex items-center gap-1 px-2.5 py-1 rounded-capsule bg-wb-bg-surface hover:bg-wb-bg-subtle border border-wb-border-subtle hover:border-wb-border-strong text-xs text-wb-text-secondary hover:text-wb-text-primary transition-all font-mono"
                          >
                            <span className={`text-3xs ${idx < 3 ? 'text-wb-brand font-bold' : 'text-wb-text-muted'}`}>
                              #{idx + 1}
                            </span>
                            <span>{tag}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {searchHistory.length === 0 && (!publicStats.popular_tags || publicStats.popular_tags.length === 0) && (
                    <div className="py-3 text-center text-xs text-wb-text-muted">
                      输入关键词按 Enter 搜索，将自动为您保留历史记录
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {searchTarget === 'users' ? (
          <div className="space-y-3 pt-1 animate-fade-in">
            {/* 常驻工作人员：与下方「搜索结果」分成两个独立区块 */}
            <StaffDirectory onSelectUser={onSelectUser} />

            <div className="flex items-center justify-between text-xs text-wb-text-muted font-mono px-1">
              <span>
                {searchQuery.trim() ? `关于 “${searchQuery}” 的极客检索结果` : '全站极客创作者探索'}
              </span>
              <span>共 {searchedUsers.length} 位</span>
            </div>

            {searchingUsers ? (
              <div className="p-12 text-center text-xs text-wb-text-muted space-y-2 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card">
                <div className="w-5 h-5 border-2 border-wb-text-primary border-t-transparent rounded-full animate-spin mx-auto" />
                <p>正在检索极客用户...</p>
              </div>
            ) : searchedUsers.length > 0 ? (
              <div className="space-y-2.5">
                {searchedUsers.map((u) => (
                  <div
                    key={u.id}
                    onClick={() => onSelectUser?.(u.username)}
                    className="wb-pressable cursor-pointer p-4 md:p-5 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle hover:border-wb-border-strong shadow-card transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4 group"
                  >
                    <div className="flex items-start sm:items-center gap-3.5 min-w-0">
                      <UserAvatar
                        username={u.username}
                        avatarUrl={u.avatar_url}
                        size={46}
                        className="border border-wb-border-subtle group-hover:border-wb-border-strong flex-shrink-0"
                      />
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm text-wb-text-primary group-hover:underline">
                            {u.nickname || u.username}
                          </span>
                          <span className="text-xs text-wb-text-muted font-mono">
                            @{u.username}
                          </span>
                          {/* 命中来源标注：解决「某人账号名与另一人昵称相同」时分不清是谁 */}
                          {u.match_type === 'nickname' && (
                            <span className="text-3xs px-1.5 py-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-muted">
                              昵称匹配
                            </span>
                          )}
                          {u.match_type === 'bio' && (
                            <span className="text-3xs px-1.5 py-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-muted">
                              简介匹配
                            </span>
                          )}
                          <LevelBadge level={u.level} role={u.role} size="sm" />
                        </div>
                        {u.bio ? (
                          <p className="text-xs text-wb-text-secondary line-clamp-1">
                            {u.bio}
                          </p>
                        ) : (
                          <p className="text-xs text-wb-text-muted italic">该极客暂未填写签名</p>
                        )}
                        <div className="flex items-center gap-3 text-2xs text-wb-text-muted font-mono pt-0.5">
                          <span>{u.followers_count} 位关注者</span>
                          <span>·</span>
                          <span>{u.following_count} 正在关注</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 self-end sm:self-center shrink-0" onClick={(e) => e.stopPropagation()}>
                      {user && user.username !== u.username && (
                        <button
                          type="button"
                          onClick={(e) => handleToggleFollowUser(e, u)}
                          className={`wb-pressable flex items-center gap-1.5 h-8 px-3.5 rounded-capsule text-xs font-semibold whitespace-nowrap shrink-0 transition-all ${
                            u.is_following
                              ? 'bg-wb-bg-subtle hover:bg-wb-border-subtle text-wb-text-primary border border-wb-border-subtle'
                              : 'bg-wb-text-primary text-wb-bg-page hover:opacity-90 shadow-sm'
                          }`}
                        >
                          {u.is_following ? (
                            <>
                              <UserCheck className="w-3.5 h-3.5 shrink-0" />
                              <span className="whitespace-nowrap">已关注</span>
                            </>
                          ) : (
                            <>
                              <UserPlus className="w-3.5 h-3.5 shrink-0" />
                              <span className="whitespace-nowrap">关注</span>
                            </>
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onSelectUser?.(u.username)}
                        className="wb-pressable h-8 px-3.5 rounded-capsule text-xs text-wb-text-secondary hover:text-wb-text-primary border border-wb-border-subtle hover:border-wb-border-strong transition-colors whitespace-nowrap shrink-0"
                      >
                        进入主页
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-12 text-center text-xs text-wb-text-muted space-y-2 rounded-3xl bg-wb-bg-surface border border-dashed border-wb-border-subtle shadow-card">
                <Users className="w-8 h-8 text-wb-text-muted mx-auto stroke-1" />
                <p className="text-wb-text-secondary">没有找到相关极客</p>
                <p className="text-2xs">可尝试输入更简短的用户名或昵称关键词</p>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* 板块分类筛选胶囊轨道 (Category Pills) */}
            <div className="relative -mx-1">
            <div
              className="flex items-center gap-2 overflow-x-auto overflow-y-hidden py-1.5 -my-1 px-1 pr-8 no-scrollbar"
              style={{ overflowY: 'hidden', scrollbarWidth: 'none' }}
            >
              {categories.map((cat) => {
                const isActive = selectedCategory === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => { setSelectedCategory(cat); setCurrentPage(1); setPostsPage(1); }}
                    className={`wb-pressable h-8 px-3.5 rounded-capsule text-xs font-medium whitespace-nowrap shrink-0 border transition-all select-none ${
                      isActive
                        ? 'bg-wb-text-primary text-wb-bg-page border-transparent font-semibold shadow-sm'
                        : 'frost text-wb-text-secondary border-wb-border-subtle hover:border-wb-border-strong hover:text-wb-text-primary'
                    }`}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>
            {/* 右侧渐隐：提示这一排还能横向滑动（手机常见做法） */}
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-wb-bg-page to-transparent sm:hidden" />
            </div>

            {/* 排序与多维复合筛选控制器 */}
            {searchQuery.trim() ? (
              <div className="p-3.5 rounded-2xl frost flex flex-wrap items-center justify-between gap-3 text-xs">
                {/* 排序维度药丸 */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-wb-text-muted text-2xs">排序:</span>
                  {[
                    { key: 'relevance', label: '综合匹配' },
                    { key: 'latest', label: '最新发布' },
                    { key: 'hot', label: '最热互动' },
                  ].map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setSearchSort(opt.key as any)}
                      className={`wb-pressable px-2.5 py-1 rounded-capsule border text-xs transition-all cursor-pointer ${
                        searchSort === opt.key
                          ? 'bg-wb-text-primary text-wb-bg-page font-semibold border-transparent shadow-sm'
                          : 'bg-wb-bg-subtle text-wb-text-secondary border-wb-border-subtle hover:text-wb-text-primary'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {/* 时间跨度过滤 */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Clock className="w-3.5 h-3.5 text-wb-text-muted shrink-0" />
                  {[
                    { key: 'all', label: '全部时间' },
                    { key: 'week', label: '近一周' },
                    { key: 'month', label: '近一月' },
                  ].map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setTimeRange(t.key as any)}
                      className={`wb-pressable px-2.5 py-1 rounded-capsule border text-2xs font-mono transition-all cursor-pointer ${
                        timeRange === t.key
                          ? 'bg-wb-text-primary text-wb-bg-page font-semibold border-transparent shadow-sm'
                          : 'bg-wb-bg-subtle text-wb-text-secondary border-wb-border-subtle hover:text-wb-text-primary'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                  <span className="text-wb-text-muted font-mono ml-1 text-xs">
                    (共 {displayTotal} 篇)
                  </span>
                </div>

                {/* 按作者筛选（服务端精确匹配用户名） */}
                <div className="flex items-center gap-1.5 w-full sm:w-auto">
                  <UserRound className="w-3.5 h-3.5 text-wb-text-muted shrink-0" />
                  <input
                    type="text"
                    value={searchAuthor}
                    onChange={(e) => setSearchAuthor(e.target.value)}
                    placeholder="按作者用户名筛选"
                    className="h-7 w-full sm:w-40 px-2.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong"
                  />
                  {(searchAuthor.trim() || selectedCategory !== '全部' || timeRange !== 'all') && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchAuthor('');
                        setSelectedCategory('全部');
                        setTimeRange('all');
                      }}
                      className="shrink-0 text-2xs text-wb-text-muted hover:text-wb-text-primary underline"
                    >
                      清除筛选
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-4 w-full">
                <SegmentedControl
                  id="home-feed"
                  className="self-start"
                  items={[
                    { key: 'latest', label: '最新发布' },
                    { key: 'hot', label: '热门互动' },
                    { key: 'comments', label: '热议讨论' },
                  ]}
                  activeKey={filter}
                  onChange={(k) => setFilter(k as any)}
                />

                <div className="text-xs text-wb-text-muted font-mono flex items-center justify-between sm:justify-end gap-2.5 w-full sm:w-auto">
                  <span>共 {displayTotal} 篇</span>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !infiniteScroll;
                      setInfiniteScroll(next);
                      try {
                        localStorage.setItem('geek_home_infinite_scroll', String(next));
                        window.dispatchEvent(new CustomEvent('geek_infinite_scroll_change', { detail: next }));
                      } catch {}
                      toast.info(next ? '已开启首页无限滚动模式' : '已恢复普通分页模式');
                    }}
                    className="wb-pressable inline-flex items-center gap-1.5 px-2.5 py-1 rounded-capsule bg-wb-bg-subtle hover:bg-wb-border-subtle border border-wb-border-subtle text-2xs text-wb-text-secondary hover:text-wb-text-primary transition-all select-none cursor-pointer"
                    title={infiniteScroll ? '当前为无限滚动，点击切换为普通分页' : '当前为普通分页，点击切换为无限滚动'}
                  >
                    {infiniteScroll ? (
                      <>
                        <ArrowDownCircle className="w-3.5 h-3.5 text-wb-text-primary" />
                        <span className="hidden sm:inline">无限滚动</span>
                      </>
                    ) : (
                      <>
                        <BookOpen className="w-3.5 h-3.5 text-wb-text-primary" />
                        <span className="hidden sm:inline">分页模式</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* 列表顶部锚点 (分页切换时平滑上卷) */}
            <div ref={feedTopRef} className="scroll-mt-24" />

            {/* 内容信息流列表 */}
            {loadingPosts && posts.length === 0 ? (
              <div className="space-y-3.5">
                <PostCardSkeleton />
                <PostCardSkeleton />
                <PostCardSkeleton />
              </div>
            ) : (
              <motion.div
                key={`${filter}-${selectedCategory}-${infiniteScroll ? 'inf' : effectiveCurrentPage}`}
                initial={{ opacity: 0.92 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                className={`space-y-3.5 transition-opacity duration-150 ${
                  isFetchingPosts ? 'opacity-65 pointer-events-none' : 'opacity-100'
                }`}
              >
              {displayedPosts.length > 0 ? (
                <>
                {displayedPosts.map((post) => (
                  <article
                    key={post.id}
                    /* 屏幕外卡片跳过布局绘制，长列表滚动更省 CPU */

                    onClick={(e) => {
                      const preferNewTab = (() => {
                        try { return localStorage.getItem('wb_open_post_in_new_tab') === 'true'; } catch { return false; }
                      })();
                      if (e.metaKey || e.ctrlKey || e.button === 1 || preferNewTab) {
                        window.open(`/?post=${post.id}`, '_blank', 'noopener,noreferrer');
                      } else {
                        onSelectPost(post.id);
                      }
                    }}
                    className="cv-auto surface wb-pressable cursor-pointer p-4 md:p-5 rounded-2xl border border-wb-border-subtle shadow-card hover:border-wb-border-strong transition-all group"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-2 flex-1">
                        {/* 作者与元信息 */}
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 text-xs text-wb-text-secondary flex-wrap">
                            <div className="inline-flex items-center gap-1.5 flex-shrink-0 select-none">
                              <UserAvatar
                                username={post.author_username}
                                avatarUrl={post.author_avatar}
                                size={22}
                                className="border border-wb-border-subtle flex-shrink-0"
                              />
                              {/* 信息流只展示「可修改的昵称」：唯一用户名留到详情页的作者名片，
                                  列表里两个名字并排既拥挤又容易让人分不清哪个是账号 */}
                              <span className="font-medium text-wb-text-primary">
                                {post.author_nickname || post.author_username}
                              </span>
                            </div>
                            <LevelBadge level={post.author_level} />

                            <span>·</span>
                            <span className="text-wb-text-muted font-mono">
                              {formatEast8Date(post.created_at)}
                            </span>
                            {post.category_name && (
                              <span className="text-wb-text-muted font-medium">
                                · {post.category_name}
                              </span>
                            )}
                            {post.is_pinned && (
                              <span className="inline-flex items-center gap-0.5 text-3xs px-1.5 py-0.2 rounded-capsule bg-wb-bg-subtle text-wb-text-primary font-semibold">
                                <Pin className="w-2.5 h-2.5" /> 置顶
                              </span>
                            )}
                            {post.is_essence && (
                              <span className="inline-flex items-center gap-0.5 text-3xs px-2 py-0.5 rounded-capsule bg-wb-brand/15 text-wb-brand border border-wb-brand/25 font-bold shadow-xs">
                                <Sparkles className="w-2.5 h-2.5 text-wb-brand" /> 精华
                              </span>
                            )}
                          </div>

                        </div>

                        {/* 标题 */}
                        <h2 className="text-base md:text-lg font-semibold text-wb-text-primary group-hover:underline line-clamp-2 leading-snug">
                          <HighlightText text={getSmartDailyTitle(post.title, post.id)} query={searchQuery} />
                        </h2>

                        {/* 话题与技术标签 */}
                        {post.tags && post.tags.length > 0 && (
                          <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                            {post.tags.map((t) => (
                              <span
                                key={t}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSearchQuery(t);
                                }}
                                className="text-3xs font-mono px-2 py-0.5 rounded-md bg-wb-bg-subtle/80 hover:bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary border border-wb-border-subtle transition-colors cursor-pointer"
                                title={`按标签 #${t} 筛选`}
                              >
                                #{t}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* 互动数据与快捷操作 */}
                        <div className="flex items-center justify-between pt-1">
                          <div className="flex items-center gap-4 text-xs text-wb-text-muted font-mono">
                            <span className="inline-flex items-center gap-1 font-sans">
                              {post.category_id && categoryMap[post.category_id] && (
                                <span className="px-1.5 py-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-secondary text-3xs">
                                  {categoryMap[post.category_id]}
                                </span>
                              )}
                              <Clock className="w-3.5 h-3.5" /> {post.reading_time_minutes} 分钟
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Eye className="w-3.5 h-3.5" /> {post.view_count}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Heart className="w-3.5 h-3.5" /> {post.like_count}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <MessageSquare className="w-3.5 h-3.5" /> {post.comment_count}
                            </span>
                          </div>

                          {/* 快捷按钮：外链 / 收藏 / 分享统一收到右下角一行。
                              此前外链在作者行、收藏分享在底部，缩略图一出现就会把两者
                              挤成"上下各飘一个图标"的错位观感，合并后有无配图都对齐。 */}
                          <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100 transition-opacity shrink-0">
                            <a
                              href={`/?post=${post.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              title="在新网页中独立打开"
                              className="hidden sm:inline-flex p-1.5 rounded-lg border border-wb-border-subtle hover:border-wb-border-strong text-wb-text-muted hover:text-wb-text-primary text-xs transition-colors"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                            <button
                              type="button"
                              onClick={(e) => handleToggleCollect(e, post)}
                              title={post.is_collected ? '取消收藏' : '收藏此帖'}
                              className={`p-1.5 rounded-lg border text-xs transition-colors ${
                                post.is_collected
                                  ? 'bg-wb-text-primary text-wb-bg-page border-transparent'
                                  : 'border-wb-border-subtle hover:border-wb-border-strong text-wb-text-muted hover:text-wb-text-primary'
                              }`}
                            >
                              <Bookmark className={`w-3.5 h-3.5 ${post.is_collected ? 'fill-current' : ''}`} />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => handleShare(e, post)}
                              title="复制分享链接"
                              className="p-1.5 rounded-lg border border-wb-border-subtle hover:border-wb-border-strong text-wb-text-muted hover:text-wb-text-primary text-xs transition-colors"
                            >
                              <Share2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* 桌面端：右侧小缩略图；手机端改为下方通栏图，避免卡片被拉高 */}
                      {post.display_image && (
                        <img
                          loading="lazy"
                          decoding="async"
                          src={thumbUrl(post.display_image, 640)}
                          srcSet={thumbSrcSet(post.display_image)}
                          sizes="(max-width: 768px) 100vw, 640px"
                          alt=""
                          onError={(e) => {
                            const el = e.currentTarget as HTMLImageElement;
                            const orig = post.display_image || '';
                            if (orig && !el.dataset.fb && el.src !== orig) {
                              el.dataset.fb = '1';
                              el.src = orig;
                              return;
                            }
                            el.style.display = 'none';
                          }}
                          className="hidden sm:block self-center w-20 h-20 rounded-2xl object-cover border border-wb-border-subtle flex-shrink-0"
                        />
                      )}
                    </div>

                    {post.display_image && (
                      <img
                        loading="lazy"
                        decoding="async"
                        src={thumbUrl(post.display_image, 640)}
                          srcSet={thumbSrcSet(post.display_image)}
                          sizes="(max-width: 768px) 100vw, 640px"
                        alt=""
                        onError={(e) => {
                            const el = e.currentTarget as HTMLImageElement;
                            const orig = post.display_image || '';
                            if (orig && !el.dataset.fb && el.src !== orig) {
                              el.dataset.fb = '1';
                              el.src = orig;
                              return;
                            }
                            el.style.display = 'none';
                          }}
                        className="sm:hidden mt-3 w-full h-[168px] object-cover rounded-xl border border-wb-border-subtle"
                      />
                    )}
                  </article>
                ))}

                {/* 模式分页与加载条 */}
                {infiniteScroll ? (
                  <div className="pt-2">
                    <div ref={bottomSentinelRef} className="h-6" />
                    {(loadingMorePosts || isFetchingPosts) && (
                      <div className="py-6 flex items-center justify-center gap-2 text-xs text-wb-text-muted font-mono animate-pulse">
                        <div className="w-4 h-4 border-2 border-wb-text-primary border-t-transparent rounded-full animate-spin" />
                        <span>正在加载更多帖子...</span>
                      </div>
                    )}
                    {!hasMorePosts && !loadingMorePosts && displayedPosts.length > 0 && (
                      <div className="py-8 text-center text-xs text-wb-text-muted font-mono border-t border-wb-border-subtle/50 mt-4 select-none flex items-center justify-center gap-1.5">
                        <Check className="w-3.5 h-3.5 text-wb-success" />
                        <span>已展现全部内容 · 共 {displayTotal} 篇</span>
                      </div>
                    )}
                  </div>
                ) : (
                  /* 普通传统分页导航器 */
                  totalPages > 1 && (
                    <div className="pt-6 pb-2 flex flex-col md:flex-row items-center justify-between gap-3.5 border-t border-wb-border-subtle/60 text-xs select-none">
                      <div className="text-wb-text-muted font-mono flex items-center gap-2">
                        <span>第 <span className="font-bold text-wb-text-primary">{effectiveCurrentPage}</span> / {totalPages} 页</span>
                        <span>·</span>
                        <span>共 {displayTotal} 篇</span>
                      </div>

                      <div className="flex items-center gap-2.5 flex-wrap justify-center">
                        {/* 上一页 / 页码数字 / 下一页 */}
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={effectiveCurrentPage <= 1}
                            onClick={() => {
                              setCurrentPage((p) => Math.max(1, p - 1));
                              feedTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            }}
                            className="wb-pressable px-3 py-1.5 rounded-capsule border border-wb-border-subtle bg-wb-bg-surface hover:border-wb-border-strong text-wb-text-secondary hover:text-wb-text-primary disabled:opacity-40 disabled:pointer-events-none transition-colors"
                          >
                            上一页
                          </button>

                          {generatePaginationPages(effectiveCurrentPage, totalPages).map((p, idx) => (
                            typeof p === 'number' ? (
                              <button
                                key={p}
                                type="button"
                                onClick={() => {
                                  setCurrentPage(p);
                                  feedTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                }}
                                className={`wb-pressable w-8 h-8 rounded-capsule text-xs font-mono font-semibold transition-all ${
                                  effectiveCurrentPage === p
                                    ? 'bg-wb-text-primary text-wb-bg-page shadow-xs'
                                    : 'bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary border border-wb-border-subtle hover:border-wb-border-strong'
                                }`}
                              >
                                {p}
                              </button>
                            ) : (
                              <span key={`ellipsis-${idx}`} className="px-1 text-wb-text-muted font-mono">
                                ...
                              </span>
                            )
                          ))}

                          <button
                            type="button"
                            // 分页模式是服务端翻页（每页 PAGE_SIZE 条），页码由 totalPages 决定；
                            // 旧逻辑在末页调用 loadMorePosts 追加数据，会和"按页替换"互相打架，
                            // 导致列表条数与页码口径不一致
                            disabled={effectiveCurrentPage >= totalPages}
                            onClick={() => {
                              if (effectiveCurrentPage >= totalPages) return;
                              setCurrentPage((p) => Math.min(totalPages, p + 1));
                              feedTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            }}
                            className="wb-pressable px-3 py-1.5 rounded-capsule border border-wb-border-subtle bg-wb-bg-surface hover:border-wb-border-strong text-wb-text-secondary hover:text-wb-text-primary disabled:opacity-40 disabled:pointer-events-none transition-colors"
                          >
                            下一页
                          </button>
                        </div>

                        {/* 快速页面跳转器 (跳至第 X 页) */}
                        <div className="flex items-center gap-1.5 pl-2.5 sm:border-l sm:border-wb-border-subtle text-wb-text-secondary">
                          <span className="text-2xs text-wb-text-muted">跳至</span>
                          <input
                            type="number"
                            min={1}
                            max={totalPages}
                            value={jumpPageInput}
                            onChange={(e) => setJumpPageInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleJumpPage();
                            }}
                            placeholder={String(effectiveCurrentPage)}
                            className="w-12 h-7 px-1.5 text-center font-mono text-xs rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-wb-text-primary focus:outline-none focus:border-wb-text-primary [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          <span className="text-2xs text-wb-text-muted">页</span>
                          <button
                            type="button"
                            onClick={handleJumpPage}
                            className="wb-pressable px-2.5 h-7 rounded-capsule bg-wb-bg-subtle hover:bg-wb-text-primary hover:text-wb-bg-page border border-wb-border-subtle text-xs font-medium text-wb-text-secondary transition-colors cursor-pointer"
                          >
                            跳转
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                )}
                </>
              ) : (
                /* 空结果指示器 */
                <div className="p-12 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle text-center space-y-3 shadow-card">
                  {streamTab === 'following' && loadingFollowing ? (
                    <div className="py-6 space-y-2">
                      <div className="w-5 h-5 border-2 border-wb-text-primary border-t-transparent rounded-full animate-spin mx-auto" />
                      <p className="text-xs text-wb-text-muted">正在拉取关注动态...</p>
                    </div>
                  ) : (
                    <>
                      <Search className="w-8 h-8 text-wb-text-muted mx-auto stroke-1" />
                      {streamTab === 'following' ? (
                        !user ? (
                          <div className="space-y-3">
                            <h3 className="font-semibold text-sm text-wb-text-primary">请登录后查看关注极客动态</h3>
                            <p className="text-xs text-wb-text-muted">
                              登录极客通行证，第一时间获取已关注创作者的最新发布与深度文章
                            </p>
                            <button
                              type="button"
                              onClick={onRequireAuth}
                              className="wb-pressable inline-flex items-center gap-1.5 h-9 px-5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm"
                            >
                              通行证登录 / 注册
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <h3 className="font-semibold text-sm text-wb-text-primary">关注流暂时空空如也</h3>
                            <p className="text-xs text-wb-text-muted">
                              您关注的极客尚未发表新文章，或您尚未关注其他极客。去右侧先锋榜探索有趣的创作者吧！
                            </p>
                          </div>
                        )
                      ) : (
                        <div className="space-y-4 max-w-md mx-auto py-2">
                          <div className="space-y-1">
                            <h3 className="font-semibold text-sm text-wb-text-primary">
                              {searchQuery.trim()
                                ? `未找到与 “${searchQuery.trim()}” 相关的极客内容`
                                : `「${selectedCategory}」分类下暂无文章`}
                            </h3>
                            <p className="text-xs text-wb-text-muted leading-relaxed">
                              {searchQuery.trim()
                                ? '建议缩短搜索词、尝试技术别名，或点击下方热门话题一键探索'
                                : '成为该领域的首位探索者，向社区先锋极客分享你的前沿见解与架构思考'}
                            </p>
                          </div>

                          {/* 搜索无结果时：提供热门技术标签一键探索 */}
                          {searchQuery.trim() && publicStats.popular_tags && publicStats.popular_tags.length > 0 && (
                            <div className="space-y-2 pt-2 border-t border-wb-border-subtle/50">
                              <span className="text-2xs text-wb-text-muted">为你推荐热门技术探索主题:</span>
                              <div className="flex items-center justify-center gap-1.5 flex-wrap">
                                {publicStats.popular_tags.slice(0, 6).map((tag) => (
                                  <button
                                    key={tag}
                                    type="button"
                                    onClick={() => setSearchQuery(tag)}
                                    className="wb-pressable text-xs font-mono px-2.5 py-1 rounded-capsule bg-wb-bg-subtle hover:bg-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary border border-wb-border-subtle transition-colors"
                                  >
                                    #{tag}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* 行动按钮群: 重置 或 立即发帖 */}
                          <div className="flex items-center justify-center gap-3 pt-2">
                            <button
                              type="button"
                              onClick={() => {
                                setSearchQuery('');
                                setSelectedCategory('全部');
                                setTimeRange('all');
                              }}
                              className="wb-pressable inline-flex items-center gap-1.5 h-8 px-4 rounded-capsule bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary border border-wb-border-subtle text-xs font-medium cursor-pointer"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>重置筛选</span>
                            </button>

                            <button
                              type="button"
                              onClick={onGoWrite}
                              className="wb-pressable inline-flex items-center gap-1.5 h-8 px-4 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm hover:opacity-90 cursor-pointer"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                              <span>{searchQuery.trim() ? `发布关于 “${searchQuery.trim()}” 的新帖` : '发布首篇技术帖'}</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </motion.div>
          )}
          {/* 移动端入站必读与自治公约快捷入口 */}
          <div className="lg:hidden py-4 text-center">
            <span
              onClick={onGoRules}
              className="text-xs text-wb-text-muted hover:text-wb-text-primary hover:underline underline-offset-4 cursor-pointer select-none inline-flex items-center gap-1"
            >
              <span>阅读极客自治公约与入站必读规范</span>
              <span>&rarr;</span>
            </span>
          </div>
          </>
        )}
      </div>

      {/* 右侧极客专属侧边栏 (宽度紧凑定宽 300px，不抢占主贴视觉权重) */}
      <aside className="hidden lg:block w-[300px] flex-shrink-0 space-y-5 sticky top-20 self-start">
        {/* 1. 极客个人名片 & 签到卡片 */}
        <div className="p-5 rounded-3xl surface border border-wb-border-subtle shadow-card space-y-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-wb-border-strong/60">
          {user ? (
            <div className="space-y-3.5">
              <div className="flex items-center justify-between">
                <div
                  onClick={() => onSelectUser?.(user.username)}
                  className="flex items-center gap-3 cursor-pointer hover:opacity-85 transition-opacity"
                  title="查看与编辑个人主页"
                >
                  <UserAvatar
                    username={user.username}
                    avatarUrl={user.avatar_url}
                    size={40}
                    className="border border-wb-border-subtle shadow-sm flex-shrink-0"
                  />
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm text-wb-text-primary hover:underline">
                        {user.nickname || user.username}
                      </span>
                      {user.nickname && (
                        <span className="text-2xs text-wb-text-muted font-mono">
                          @{user.username}
                        </span>
                      )}
                      <LevelBadge level={user.level} status={user.status} role={user.role} size="sm" />
                    </div>

                    <span className="text-2xs text-wb-text-muted font-mono">
                      已活跃 {user.active_days} 天 · {user.experience} EXP
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleCheckin}
                  disabled={hasCheckedInToday || checkingIn}
                  className={`wb-pressable flex-1 flex items-center justify-center gap-1.5 h-10 px-4 rounded-capsule text-xs font-semibold shadow-sm transition-all ${
                    hasCheckedInToday
                      ? 'bg-wb-bg-subtle text-wb-text-muted border border-wb-border-subtle cursor-default opacity-85'
                      : 'bg-wb-text-primary text-wb-bg-page hover:opacity-90 disabled:opacity-50 cursor-pointer'
                  }`}
                >
                  {hasCheckedInToday ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-wb-success" />
                      <span>今日已打卡</span>
                    </>
                  ) : (
                    <>
                      <Calendar className="w-3.5 h-3.5" />
                      <span>{checkingIn ? '打卡中...' : '每日签到 (+5 EXP)'}</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={onGoWrite}
                  title="发布新帖"
                  className="wb-pressable flex items-center justify-center gap-1.5 px-4 h-10 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>创作</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-center py-2">
              <div className="w-10 h-10 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle mx-auto flex items-center justify-center text-wb-text-primary font-bold">
                ★
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-wb-text-primary">加入极客社区</h3>
                <p className="text-xs text-wb-text-muted">
                  崇尚代码与理性，探索前沿技术与纯粹美学
                </p>
              </div>
              <button
                type="button"
                onClick={onRequireAuth}
                className="wb-pressable w-full h-10 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 shadow-sm flex items-center justify-center"
              >
                通行证登录 / 注册
              </button>
            </div>
          )}
        </div>

        {/* 社区榜单：所有人（含超级管理员）都能看到 */}
        <Leaderboard onSelectUser={onSelectUser} />
        <SeriesPanel onSelectPost={onSelectPost} />

        {/* 权限差异化侧边栏：仅最高管理员可见社区运行看板 */}
        {isSuperAdmin ? (
          <div className="p-5 rounded-3xl surface border border-wb-border-subtle shadow-card space-y-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-wb-border-strong/60">
            <div className="flex items-center justify-between pb-2 border-b border-wb-border-subtle">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-wb-text-primary" />
                <h4 className="text-xs font-bold text-wb-text-primary tracking-wide uppercase">
                  社区运行看板 (管理专属)
                </h4>
              </div>
              <span className="flex items-center gap-1.5 text-3xs text-wb-success dark:text-wb-success font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-wb-success animate-pulse" />
                系统运转良好
              </span>
            </div>

            <div className="text-2xs text-wb-text-muted font-mono flex items-center justify-between">
              <span>当前管理权限:</span>
              <span className="font-semibold text-wb-text-primary">
                最高管理员 (Super Admin)
              </span>
            </div>

            {/* 3 项全新高质感布局：首行突出实时活跃极客心跳，次行双列并排帖子与成员 */}
            <div className="space-y-2.5">
              <div className="p-3.5 rounded-2xl bg-wb-bg-subtle/70 border border-wb-border-subtle flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-wb-success/10 text-wb-success dark:text-wb-success flex items-center justify-center">
                    <Users className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-2xs text-wb-text-muted font-medium">在线极客</div>
                    <div className="flex items-center gap-1.5 text-3xs text-wb-success dark:text-wb-success font-mono">
                      <span className="w-1.5 h-1.5 rounded-full bg-wb-success animate-pulse" />
                      5 分钟内活跃
                    </div>
                  </div>
                </div>
                <div className="text-2xl font-bold font-mono text-wb-text-primary">
                  {telemetry.online_users}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div className="p-3 rounded-2xl bg-wb-bg-subtle/70 border border-wb-border-subtle space-y-1">
                  <div className="flex items-center gap-1.5 text-wb-text-muted text-2xs">
                    <MessageSquare className="w-3.5 h-3.5" />
                    <span>社区帖子</span>
                  </div>
                  <div className="text-lg font-bold font-mono text-wb-text-primary">
                    {telemetry.total_posts}
                  </div>
                </div>

                <div className="p-3 rounded-2xl bg-wb-bg-subtle/70 border border-wb-border-subtle space-y-1">
                  <div className="flex items-center gap-1.5 text-wb-text-muted text-2xs">
                    <Shield className="w-3.5 h-3.5" />
                    <span>注册成员</span>
                  </div>
                  <div className="text-lg font-bold font-mono text-wb-text-primary">
                    {telemetry.total_users}
                  </div>
                </div>
              </div>
            </div>

            {onGoAdmin && (
              <button
                type="button"
                onClick={onGoAdmin}
                className="wb-pressable w-full h-10 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle hover:border-wb-border-strong text-wb-text-primary text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>进入管理与治理工作台</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ) : (
          <>

            {/* 极客贡献先锋卡已移除，由社区榜单替代 */}
          </>
        )}


        {/* 3. 24小时热议精选榜 (Top Discussions) */}
        <div className="p-5 rounded-3xl surface border border-wb-border-subtle shadow-card space-y-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-wb-border-strong/60">
          <div className="flex items-center gap-2 pb-2 border-b border-wb-border-subtle">
            <Flame className="w-4 h-4 text-wb-text-primary" />
            <h4 className="text-xs font-bold text-wb-text-primary tracking-wide uppercase">
              24小时热议精选
            </h4>
          </div>

          <div className="space-y-2.5">
            {(isSuperAdmin ? telemetry.top_hot_posts : (publicStats.top_hot_posts?.length ? publicStats.top_hot_posts : telemetry.top_hot_posts)).map((hotPost, index) => (
              <div
                key={hotPost.id}
                onClick={() => onSelectPost(hotPost.id)}
                className="wb-pressable cursor-pointer flex items-start gap-2.5 p-2 rounded-xl hover:bg-wb-bg-subtle transition-colors group"
              >
                <span
                  className={`w-5 h-5 rounded-md flex items-center justify-center font-mono text-xs font-bold flex-shrink-0 ${
                    index < 3
                      ? 'bg-wb-text-primary text-wb-bg-page'
                      : 'bg-wb-bg-subtle text-wb-text-muted'
                  }`}
                >
                  {index + 1}
                </span>
                <div className="flex-1 min-w-0 space-y-1">
                  <p className="text-xs font-medium text-wb-text-primary line-clamp-2 leading-snug group-hover:underline">
                    {getSmartDailyTitle(hotPost.title)}
                  </p>
                  <div className="flex items-center gap-3 text-3xs text-wb-text-muted font-mono">
                    <span>{hotPost.comment_count} 讨论</span>
                    <span>·</span>
                    <span>{hotPost.like_count} 赞</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 4. 极客公约与规则 */}
        <div className="p-5 rounded-3xl bg-wb-bg-subtle/50 border border-wb-border-subtle space-y-3 text-xs">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-wb-text-primary flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-wb-text-muted" />
              <span>极客自治公约</span>
            </h4>
            <span className="text-3xs text-wb-text-muted font-mono">v4.2 现行</span>
          </div>
          <p className="text-wb-text-muted text-2xs leading-relaxed">
            以实证与代码为基石，坚决抵制网络戾气与人身攻击。纯粹技术探讨，守护开源交流净土。
          </p>
          <div className="pt-2 border-t border-wb-border-subtle/60 flex items-center justify-between">
            <span className="text-3xs text-wb-text-muted font-mono">规范与入站必读</span>
            <span
              onClick={onGoRules}
              className="text-2xs text-wb-text-primary hover:text-wb-text-secondary hover:underline underline-offset-4 cursor-pointer font-medium select-none"
            >
              阅读完整公约与入站必读 &rarr;
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-3xs text-wb-text-muted font-mono">条款与声明</span>
            <span
              onClick={onGoLegal}
              className="text-2xs text-wb-text-primary hover:text-wb-text-secondary hover:underline underline-offset-4 cursor-pointer font-medium select-none"
            >
              免责与法律声明 &rarr;
            </span>
          </div>
        </div>

        {/* 5. 友情链接：放在侧栏最底部，胶囊紧凑排列，默认折叠，不抢主内容 */}
        <FriendLinksCard onOpenAll={onOpenLinks} />
      </aside>
    </div>
  );
};
