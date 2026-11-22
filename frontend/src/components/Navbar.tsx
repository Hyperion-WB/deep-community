import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Compass,
  PenTool,
  MessageSquare,
  ShieldCheck,
  LogOut,
  User as UserIcon,
  Bell,
  Newspaper,
  Lightbulb,
  Volume2,
  Sparkles,
  LayoutGrid,
  Calendar,
  Search,
} from 'lucide-react';
import { ThemeCapsule } from './ThemeCapsule';
import { UserAvatar } from './UserAvatar';
import { OnlineAvatar } from './OnlineAvatar';
import { useScrollVisibility } from '../hooks/useScrollVisibility';
import type { UserProfile } from '../types';
import { usePortalMode } from '../utils/portalMode';
import { apiClient } from '../api/client';

interface Props {
  user: UserProfile | null;
  currentTab: string;
  onSelectTab: (tab: string) => void;
  onOpenAuth: (pendingTab?: string) => void;
  onSelectUser: (username: string) => void;
  onLogout: () => void;
  onOpenNotifications?: () => void;
  unreadCount?: number;
  unreadChatCount?: number;
  hasAnnouncements?: boolean;
  /** 是否存在尚未确认的新公告（决定黑色小角标是否显示） */
  hasUnreadAnnouncement?: boolean;
  isAnnouncementCollapsed?: boolean;
  onToggleAnnouncement?: () => void;
}

export const Navbar: React.FC<Props> = ({
  user,
  currentTab,
  onSelectTab,
  onOpenAuth,
  onSelectUser,
  onLogout,
  onOpenNotifications,
  unreadCount = 0,
  unreadChatCount = 0,
  hasAnnouncements = false,
  hasUnreadAnnouncement = false,
  isAnnouncementCollapsed = false,
  onToggleAnnouncement,
}) => {
  const [portalMode, changePortalMode] = usePortalMode();
  const [checkedIn, setCheckedIn] = useState(false);
  const [proSearch, setProSearch] = useState(() => {
    try { return localStorage.getItem('wb_pro_search') || ''; } catch { return ''; }
  });

  const [proSearchOpen, setProSearchOpen] = useState(false);
  const [proUsers, setProUsers] = useState<{ username: string; nickname: string }[]>([]);
  const [proUsersStatus, setProUsersStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const userSearchQuery = Array.from(proSearch.trim()).slice(0, 40).join('');

  useEffect(() => {
    setProUsers([]);
    setProUsersStatus('loading');
    if (portalMode !== 'pro' || !proSearchOpen || !userSearchQuery) return;
    const request = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const { data } = await apiClient.get<{ users: typeof proUsers }>('/search/suggest', {
          params: { q: userSearchQuery, limit: 8 }, signal: request.signal,
        });
        if (request.signal.aborted) return;
        setProUsers(data.users);
        setProUsersStatus('ready');
      } catch {
        if (!request.signal.aborted) setProUsersStatus('error');
      }
    }, 220);
    return () => { window.clearTimeout(timer); request.abort(); };
  }, [portalMode, proSearchOpen, userSearchQuery]);

  // 顶部签到只显示状态，点击进入独立的签到页（与迁移包 onSelectTab('checkin') 一致）
  useEffect(() => {
    if (!user) { setCheckedIn(false); return; }
    let alive = true;
    apiClient.get('/users/checkin/status')
      .then((r) => { if (alive) setCheckedIn(Boolean(r.data?.checked_today)); })
      .catch(() => undefined);
    const onDone = () => setCheckedIn(true);
    window.addEventListener('geek:checkin-done', onDone);
    return () => { alive = false; window.removeEventListener('geek:checkin-done', onDone); };
  }, [user]);
  const isSuperAdmin = user?.role === 'super_admin' || user?.role === 'admin';
  const isAdmin = ['super_admin', 'admin', 'moderator', 'auditor'].includes(user?.role || '');

  // 桌面端导航列表
  const navItems = [
    { key: 'home', label: '发现', icon: Compass },
    { key: 'feedback', label: '反馈', icon: Lightbulb },
    { key: 'write', label: '写帖', icon: PenTool },
  ];

  if (isSuperAdmin) {
    navItems.push({ key: 'daily', label: '日报', icon: Newspaper });
  }

  navItems.push({ key: 'chat', label: '私聊', icon: MessageSquare });

  if (isAdmin) {
    navItems.push({ key: 'admin', label: '管理', icon: ShieldCheck });
  }

  // 移动端核心导航配置
  const mobileNavItems: {
    key: string;
    label: string;
    icon: any;
    requiresAuth: boolean;
    badge?: number;
  }[] = [
    { key: 'home', label: '发现', icon: Compass, requiresAuth: false },
    { key: 'feedback', label: '反馈', icon: Lightbulb, requiresAuth: false },
    { key: 'write', label: '写帖', icon: PenTool, requiresAuth: true },
    { key: 'chat', label: '私聊', icon: MessageSquare, requiresAuth: true, badge: unreadChatCount },
    {
      key: 'profile',
      label: user ? '我的' : '登录',
      icon: user ? null : UserIcon,
      requiresAuth: !user,
    },
  ];


  const activeMobileIndex = mobileNavItems.findIndex((item) => item.key === currentTab);
  const hasActiveMobile = activeMobileIndex !== -1;

  const navHidden = useScrollVisibility();
  // 滚动后加深投影：内容顶到导航下方时，靠一道柔和暗影把两者分开
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  // 文章读完（滚到底）时把底栏带回来，否则用户只能退出详情才能换频道
  const logoClickRef = useRef(0);
  const [logoSpins, setLogoSpins] = useState(0);
  const handleLogoClick = () => {
    logoClickRef.current += 1;
    if (logoClickRef.current % 5 === 0) setLogoSpins((n) => n + 1);
  };
  const [atArticleEnd, setAtArticleEnd] = useState(false);
  useEffect(() => {
    const onEnd = (e: Event) => setAtArticleEnd(Boolean((e as CustomEvent).detail));
    window.addEventListener('geek:article-bottom', onEnd as EventListener);
    return () => window.removeEventListener('geek:article-bottom', onEnd as EventListener);
  }, []);
  useEffect(() => {
    setAtArticleEnd(false);
  }, [currentTab]);
  // 手机端聊天：专业版聊天区占满视口，底部 Dock 会压住输入栏，进入会话时隐藏
  const [chatInConversation, setChatInConversation] = useState(false);
  useEffect(() => {
    const handler = (e: Event) =>
      setChatInConversation(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener('geek:chat-conversation-open', handler);
    return () => window.removeEventListener('geek:chat-conversation-open', handler);
  }, []);
  useEffect(() => {
    if (currentTab !== 'chat') setChatInConversation(false);
  }, [currentTab]);
  // 编辑器也必须保留底栏，否则页面内无法切换到其他频道；
  // 详情页只在读到底部时出现，其余时候让位给悬浮评论栏，避免两层叠加。
  const showDockBar = (currentTab !== '' || atArticleEnd)
    && !(currentTab === 'chat' && chatInConversation && portalMode === 'pro');


  return (
    <>
      {/* 顶部悬浮导航条 (全部使用统一规格胶囊组件，移动端自适应无挤压) */}
      <header className={portalMode === 'pro'
        ? `sticky top-0 z-50 w-full bg-wb-bg-surface/95 dark:bg-zinc-900/95 backdrop-blur-md border-b border-wb-border-subtle transition-shadow duration-200 ${scrolled ? 'shadow-xs' : ''}`
        : 'sticky top-2.5 sm:top-3.5 z-50 max-w-5xl mx-auto px-2 sm:px-4 w-full'}>
        <div
          className={portalMode === 'pro'
            ? 'max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4 w-full'
            : `flex items-center justify-between gap-1.5 sm:gap-2 px-2.5 sm:px-3.5 py-1.5 frost rounded-capsule max-w-full transition-shadow duration-300 ${
                scrolled
                  ? 'border border-wb-border-subtle shadow-[0_10px_30px_-14px_rgba(15,23,42,0.28)] dark:shadow-[0_12px_34px_-14px_rgba(0,0,0,0.7)]'
                  : 'border border-wb-border-subtle/60 shadow-none'
              }`}
        >
          {/* 极简 Logo */}
          <div
            onClick={handleLogoClick}
            title="点一点试试"
            className="flex items-center gap-1.5 sm:gap-2 cursor-pointer select-none group shrink-0"
          >
            <img loading="lazy" decoding="async"
              key={`logo-${logoSpins}`}
              src="/logo.svg"
              alt="Logo"
              className={`w-7 h-7 rounded-xl object-contain transition-transform duration-200 group-hover:scale-105 ${logoSpins > 0 ? 'wb-logo-spin' : ''}`}
            />
            <span className="font-bold text-xs tracking-wider text-wb-text-primary font-mono select-none hidden md:inline">
              COMMUNITY
            </span>
          </div>

          {/* 桌面端核心导航: 严格统一 h-9 胶囊 */}
          <nav className={portalMode === 'pro'
            ? 'hidden md:flex items-center gap-1 flex-1 max-w-2xl justify-center relative select-none'
            : 'hidden sm:flex items-center h-9 p-1 bg-wb-capsule-track rounded-capsule border border-wb-border-subtle relative select-none flex-shrink-0'}>
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = currentTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    // 仅「写帖 / 私聊」需要登录态；反馈等页面游客可浏览，与移动端 Dock 保持一致
                    if (!user && (item.key === 'write' || item.key === 'chat')) {
                      onOpenAuth(item.key);
                    } else {
                      onSelectTab(item.key);
                    }
                  }}
                  className={`relative z-10 ${portalMode === 'pro' ? 'h-8 px-3 rounded-md' : 'h-7 px-3 rounded-capsule'} text-xs font-medium transition-colors duration-200 flex items-center gap-1.5 select-none whitespace-nowrap flex-shrink-0 ${
                    isActive
                      ? (portalMode === 'pro' ? 'text-wb-bg-page font-bold' : 'text-wb-text-primary font-semibold')
                      : 'text-wb-text-secondary hover:text-wb-text-primary'
                  }`}
                >
                  {isActive && (
                    <motion.div
                      layoutId="navbar-pill-desktop"
                      transition={{ type: 'tween', duration: 0.22, ease: 'easeOut' }}
                      className={portalMode === 'pro'
                        ? 'absolute inset-0 bg-wb-text-primary rounded-md shadow-xs -z-10'
                        : 'absolute inset-0 bg-wb-capsule-thumb rounded-capsule shadow-capsule -z-10'}
                    />
                  )}
                  <div className="relative flex items-center justify-center flex-shrink-0">
                    <Icon className="w-3.5 h-3.5" />
                    {item.key === 'chat' && unreadChatCount > 0 && (
                      <span className="absolute -top-1 -right-1 flex h-2 w-2 pointer-events-none">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wb-danger opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-wb-danger ring-2 ring-wb-bg-surface" />
                      </span>
                    )}
                  </div>
                  <span className="whitespace-nowrap">{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* 专业版：搜索集中到顶部通栏，输入实时驱动专业版首页信息流 */}
          {portalMode === 'pro' && (
            <div className="relative flex min-w-0 items-center h-8 px-2.5 rounded-full bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-muted flex-1 max-w-[240px] xl:max-w-[300px] shrink"
              onFocus={() => setProSearchOpen(true)}
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setProSearchOpen(false); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && proSearchOpen) {
                  e.stopPropagation();
                  setProSearchOpen(false);
                  e.currentTarget.querySelector('input')?.focus();
                }
              }}>
              <Search className="w-3.5 h-3.5 shrink-0" />
              <input
                value={proSearch}
                onChange={(e) => {
                  const v = e.target.value;
                  setProSearch(v);
                  setProSearchOpen(true);
                  try { localStorage.setItem('wb_pro_search', v); } catch { /* 忽略 */ }
                  window.dispatchEvent(new CustomEvent('geek:pro-search', { detail: v }));
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) { e.stopPropagation(); return; }
                  if (e.key === 'Escape' && !proSearchOpen) {
                    setProSearch('');
                    try { localStorage.removeItem('wb_pro_search'); } catch { /* 忽略 */ }
                    window.dispatchEvent(new CustomEvent('geek:pro-search', { detail: '' }));
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                placeholder="搜索帖子、技术讨论与极客..."
                aria-label="专业版全站搜索"
                className="min-w-0 flex-1 ml-1.5 bg-transparent outline-none text-3xs text-wb-text-primary placeholder:text-wb-text-muted"
              />
              {proSearchOpen && userSearchQuery && (
                <div className="fixed inset-x-3 top-14 z-50 max-h-[60vh] overflow-y-auto rounded-xl border border-wb-border-subtle bg-wb-bg-surface p-1.5 shadow-lg lg:absolute lg:inset-x-auto lg:right-0 lg:top-full lg:mt-1 lg:w-72">
                  <p className="px-2 py-1 text-xs font-semibold text-wb-text-primary">用户</p>
                  {proUsers.length === 0 && (
                    <p role="status" className="px-2 py-2 text-xs">{proUsersStatus === 'loading' ? '正在搜索…' : proUsersStatus === 'error' ? '用户搜索失败，请重试' : '未找到匹配的用户'}</p>
                  )}
                  {proUsers.map(({ username, nickname }) => (
                    <button key={username} type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-wb-bg-subtle focus-visible:bg-wb-bg-subtle"
                      onClick={() => { setProSearchOpen(false); onSelectUser(username); }}>
                      <span className="min-w-0 flex-1 truncate font-medium text-wb-text-primary">{nickname}</span>
                      <span className="max-w-[50%] truncate">@{username}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 右侧交互区: 公告收纳球 + 主题切换 + 消息中心 + 用户头像 / 登录 (移动端自适应紧凑 w-8/w-9，绝不挤出屏幕) */}
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {/* 全站公告入口：收起时恒显示；有未确认的新公告时额外亮起黑色小角标 */}
            {hasAnnouncements && (isAnnouncementCollapsed || hasUnreadAnnouncement) && (
              <motion.button
                type="button"
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.6, opacity: 0 }}
                whileHover={{ scale: 1.08 }}
                whileTap={{ scale: 0.94 }}
                onClick={onToggleAnnouncement}
                title={
                  hasUnreadAnnouncement
                    ? '有新的社区公告 (点击查看)'
                    : '全站公告与更新日志 (点击展开)'
                }
                className="wb-pressable relative flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary transition-colors shrink-0 cursor-pointer"
              >
                <Volume2 className="w-3.5 h-3.5 text-wb-text-primary" />
                {hasUnreadAnnouncement && (
                  <span className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 flex h-2 w-2 pointer-events-none">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wb-text-primary opacity-40" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-wb-text-primary" />
                  </span>
                )}
              </motion.button>
            )}

            {/* 门户切换器：经典版 / 专业版，选择会保存到账号长期生效 */}
            <button
              type="button"
              onClick={() => changePortalMode(portalMode === 'pro' ? 'classic' : 'pro')}
              title={portalMode === 'pro' ? '当前：专业版门户 · 点击切换到经典版' : '当前：经典版 · 点击切换到专业版门户'}
              aria-label="切换门户界面"
              className="wb-pressable relative flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary transition-colors shrink-0"
            >
              {portalMode === 'pro'
                ? <Sparkles className="w-3.5 h-3.5" />
                : <LayoutGrid className="w-3.5 h-3.5" />}
            </button>

            {/* 专业版顶部签到：迁移包把签到放在通栏右侧，不再只藏在首页左栏 */}
            {portalMode === 'pro' && (
              <button
                type="button"
                onClick={() => onSelectTab('checkin')}
                title={checkedIn ? '今日已签到 · 查看签到页与打卡日历' : '进入每日签到页'}
                aria-label="每日签到"
                className={`hidden sm:flex items-center gap-1.5 h-8 px-2.5 rounded-md text-2xs font-semibold transition-colors shrink-0 ${
                  checkedIn
                    ? 'bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-muted hover:text-wb-text-primary'
                    : 'bg-wb-text-primary text-wb-bg-page hover:opacity-90'
                }`}
              >
                <Calendar className="w-3.5 h-3.5" />
                <span>{checkedIn ? '已签到' : '签到'}</span>
              </button>
            )}

            <ThemeCapsule />

            {/* 消息通知铃铛 */}
            {user && (
              <button
                type="button"
                onClick={onOpenNotifications}
                title="查看系统与互动消息"
                className="wb-pressable relative flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary transition-colors shrink-0"
              >
                <Bell className="w-3.5 h-3.5" />
                {unreadCount > 0 && (
                  <span className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 w-2 h-2 rounded-full bg-wb-danger ring-2 ring-wb-bg-surface animate-pulse" />
                )}
              </button>
            )}

            {user ? (
              <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => onSelectTab('profile')}
                  title="查看与修改个人档案"
                  className={`wb-pressable flex items-center justify-center sm:gap-2 h-8 w-8 sm:h-9 sm:w-auto sm:px-2.5 rounded-capsule border transition-colors select-none ${
                    currentTab === 'profile'
                      ? 'bg-wb-capsule-track border-wb-border-strong text-wb-text-primary font-semibold'
                      : 'bg-wb-bg-subtle border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary'
                  }`}
                >
                  {/* 自己正在使用站点，因此恒为在线；绿点让"当前登录态"更直观 */}
                  <OnlineAvatar online size={22} ringClassName="ring-wb-bg-page">
                    <UserAvatar username={user.username} avatarUrl={user.avatar_url} size={22} />
                  </OnlineAvatar>
                  <span className="text-xs max-w-[80px] truncate hidden md:inline font-medium">
                    {user.nickname || user.username}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={onLogout}
                  title="退出登录"
                  aria-label="退出登录"
                  className="wb-pressable flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-muted hover:text-wb-danger hover:border-wb-danger/30 transition-colors shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onOpenAuth()}
                className="wb-pressable flex items-center justify-center h-8 sm:h-9 px-3 sm:px-4 text-xs font-semibold rounded-capsule bg-wb-text-primary text-wb-bg-page hover:opacity-90 shadow-sm"
              >
                登录
              </button>
            )}
          </div>
        </div>
      </header>

      {/* 手机端灵动流体导航浮岛 (Mobile Dock - 纯绝对横向滑移，物理锁定于屏幕底部，杜绝跳动与位移) */}
            {showDockBar && (
<nav
        className="sm:hidden fixed bottom-3 inset-x-4 z-50 h-14 p-1.5 frost border border-wb-border-strong/30 rounded-capsule shadow-[0_12px_32px_rgba(0,0,0,0.15)] dark:shadow-[0_16px_40px_rgba(0,0,0,0.6)] flex items-center justify-between select-none overflow-hidden transition-transform duration-300 ease-out will-change-transform"
        style={{
          bottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))',
          transform: navHidden ? 'translateY(calc(100% + 1.5rem))' : 'translateY(0)',
        }}
      >
        {/* 单一纯横向滑动药丸滑块 (无需 layoutId，不受页面高度塌陷、滚动或重新挂载影响，100% 纯横向贴地平移) */}
        {hasActiveMobile && (
          <div className="absolute inset-1.5 pointer-events-none -z-0">
            <motion.div
              className="h-full rounded-capsule bg-wb-bg-elevated shadow-sm border border-wb-border-strong/20"
              style={{ width: `${100 / mobileNavItems.length}%` }}
              initial={false}
              animate={{
                x: `${activeMobileIndex * 100}%`,
              }}
              transition={{ type: 'spring', stiffness: 420, damping: 36 }}
            />
          </div>
        )}

        {mobileNavItems.map((item) => {
          const isActive = currentTab === item.key;
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                if (item.requiresAuth && !user) {
                  onOpenAuth(item.key);
                } else {
                  // 手机端点「私聊」应进「私聊 + 群聊」列表，而不是上次打开的具体群聊
                  if (item.key === 'chat') {
                    window.dispatchEvent(new CustomEvent('geek:chat-show-list'));
                  }
                  onSelectTab(item.key);
                }
              }}
              className="relative z-10 flex flex-col items-center justify-center flex-1 h-full py-1 rounded-capsule select-none transition-transform active:scale-90 duration-100"
            >
              <div className="relative flex items-center justify-center">
                {item.key === 'profile' && user ? (
                  <UserAvatar
                    username={user.username}
                    avatarUrl={user.avatar_url}
                    size={18}
                    className="mb-0.5"
                  />
                ) : Icon ? (
                  <Icon
                    className={`w-4 h-4 mb-0.5 transition-colors ${
                      isActive
                        ? 'text-wb-text-primary'
                        : 'text-wb-text-muted'
                    }`}
                  />
                ) : null}
                {item.badge && item.badge > 0 ? (
                  <span className="absolute -top-1 -right-1.5 flex h-2.5 w-2.5 pointer-events-none">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wb-danger opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-wb-danger ring-2 ring-wb-bg-surface" />
                  </span>
                ) : null}
              </div>
              <span
                className={`text-3xs tracking-tight transition-colors ${
                  isActive
                    ? 'text-wb-text-primary font-bold'
                    : 'text-wb-text-muted'
                }`}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>
      )}
    </>
  );
};
