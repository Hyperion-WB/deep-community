import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Bell, Award, Gamepad2, MessageSquare, Heart, CheckCheck, X, ChevronRight, Sparkles, UserPlus, Trash2, Users, ChevronDown } from 'lucide-react';
import { apiClient } from '../api/client';
import type { NotificationItem } from '../types';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmModal';
import { formatChatTime } from '../utils/format';
import { acquireScrollLock, registerEsc } from '../utils/overlay';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectPost?: (postId: string, commentId?: string | null, openComments?: boolean) => void;
  onSelectUser?: (username: string) => void;
  onSelectChat?: (username: string, groupId?: string) => void;
  onNotificationsChange?: (unreadCount: number) => void;
  selfUsername?: string;
  selfUserId?: string;
  /** 全局未读数（与 Navbar 同源），避免抽屉用列表自算造成两个数字对不上 */
  globalUnreadCount?: number;
}

const DEFAULT_NOTIFICATIONS: NotificationItem[] = [];

export const NotificationDrawer: React.FC<Props> = ({
  isOpen,
  onClose,
  onSelectPost,
  onSelectUser,
  onSelectChat,
  onNotificationsChange,
  selfUsername,
  selfUserId,
  globalUnreadCount,
}) => {
  // 折叠的「累计 N 条」可点开看具体条目
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toast = useToast();
  const confirm = useConfirm();
  const [notifications, setNotifications] = useState<NotificationItem[]>(DEFAULT_NOTIFICATIONS);
  const [filterCategory, setFilterCategory] = useState<'all' | 'chat' | 'interactive' | 'social' | 'system'>('all');
  const [loading, setLoading] = useState<boolean>(false);
  // 分页：每次 40 条，底部"加载更多"继续向后翻，历史通知不再永远看不到
  const NOTIF_PAGE_SIZE = 20;
  const [notifPage, setNotifPage] = useState<number>(1);
  const [hasMoreNotifs, setHasMoreNotifs] = useState<boolean>(false);
  const [loadingMoreNotifs, setLoadingMoreNotifs] = useState<boolean>(false);

  // 未读红点口径统一由服务端 unread-count 决定：
  // 列表接口有条数上限，用列表自算未读会把全局数字改小，与轮询值互相打架。
  const syncUnreadCount = async () => {
    try {
      const res = await apiClient.get('/users/me/notifications/unread-count');
      if (typeof res.data?.unread_count === 'number') {
        onNotificationsChange?.(res.data.unread_count);
      }
    } catch {
      // 忽略：App 侧还有 20s 轮询兜底
    }
  };

  // 前端 tab 与服务端分类的映射（服务端按 action_type 过滤）
  const categoryParam =
    filterCategory === 'interactive' ? 'interaction' : filterCategory === 'social' ? 'follow' : filterCategory;

  const fetchNotifications = async (silent: boolean = false, page: number = 1) => {
    if (!silent) setLoading(true);
    try {
      const res = await apiClient.get('/users/me/notifications', {
        params: { page, size: NOTIF_PAGE_SIZE, category: categoryParam },
      });
      const list: NotificationItem[] = Array.isArray(res.data) ? res.data : [];
      const hasMoreHeader = res.headers?.['x-has-more'];
      setHasMoreNotifs(hasMoreHeader !== undefined ? hasMoreHeader === '1' : list.length >= NOTIF_PAGE_SIZE);
      setNotifPage(page);
      if (page === 1) {
        setNotifications(list);
      } else {
        setNotifications((prev) => {
          const seen = new Set(prev.map((n) => n.id));
          return [...prev, ...list.filter((n) => !seen.has(n.id))];
        });
      }
      // 不 await：列表已经拿到，红点数字晚一点更新无妨，别让它拖慢首屏
      void syncUnreadCount();
    } catch {
      // 接口失败保持当前通知状态
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const loadMoreNotifications = async () => {
    if (loadingMoreNotifs || !hasMoreNotifs) return;
    setLoadingMoreNotifs(true);
    try {
      await fetchNotifications(true, notifPage + 1);
    } finally {
      setLoadingMoreNotifs(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setNotifPage(1);
    fetchNotifications(false, 1);
    // 未读计数由 App 统一轮询；抽屉内不再重复开定时器，避免同接口双份请求
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, filterCategory]);

  // onClose 通常是内联箭头函数，用 ref 固定引用，避免副作用反复重绑
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // 打开时锁定背景滚动 + 支持 ESC 关闭；关闭瞬间立即释放，避免遮罩残留造成卡顿感
  useEffect(() => {
    if (!isOpen) return;
    // ESC 与滚动锁统一交给全局覆盖层栈
    const releaseLock = acquireScrollLock();
    const unregisterEsc = registerEsc('notification-drawer', () => onCloseRef.current());
    return () => {
      unregisterEsc();
      releaseLock();
    };
  }, [isOpen]);

  // 统一的已读逻辑：折叠成一张卡片的组必须整组标记，不能只更新代表条；
  // 标记后重拉列表，让 group_total / group_items / is_read 保持同一份快照
  const markNotificationRead = async (item: any) => {
    const groupSize = item.group_total || item._groupCount || 0;
    const isGroup = groupSize > 1 && item.target_id;
    try {
      if (isGroup) {
        await apiClient.put('/users/me/notifications/read-group', {
          action_type: item.action_type,
          target_id: item.target_id,
        });
      } else {
        await apiClient.put(`/users/me/notifications/${item.id}/read`);
      }
      await fetchNotifications(true);
      await syncUnreadCount();
    } catch {
      // 失败时重拉一次把乐观更新回滚到服务端真实状态
      await fetchNotifications(true).catch(() => undefined);
    }
  };

  const handleMarkAllRead = async () => {
    const ok = await confirm({
      title: '全部标为已读',
      description: '将把当前所有未读通知标记为已读，操作后无法恢复为未读状态。',
      confirmText: '全部已读',
      cancelText: '取消',
      danger: false,
    });
    if (!ok) return;
    try {
      await apiClient.put('/users/me/notifications/read');
      await fetchNotifications(true);
      await syncUnreadCount();
      toast.success('已全部标记为已读');
    } catch {
      // 失败时保持本地状态不动，避免"清零→轮询跳回"的徽标闪烁与状态与服务端相反
      toast.error('标记已读失败，请稍后重试');
    }
  };

  const handleClearAll = async () => {
    const ok = await confirm({
      title: '清空所有通知',
      description: '确定要清空全部消息通知吗？此操作无法撤销。',
      confirmText: '确定清空',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete('/users/me/notifications');
      setNotifications([]);
      if (onNotificationsChange) onNotificationsChange(0);
      toast.info('已清空全部通知');
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '清空通知失败');
    }
  };

  // 单条标为已读：不用点进详情，直接消掉这一条的红点
  const handleMarkReadItem = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const item = notifications.find((n) => n.id === id);
    if (!item) return;
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
    await markNotificationRead(item);
  };

  const handleDeleteItem = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await apiClient.delete(`/users/me/notifications/${id}`);
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      await syncUnreadCount();
      toast.info('通知已删除');
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '删除通知失败');
    }
  };

  // 通知跳转目标分类：
  // - post: 帖子/评论类互动（target_id 为帖子 UUID）
  // - profile: 个人主页类（关注、等级变动、纯系统通告）
  // - chat / group: 会话与群聊
  // 此前 system/level_up 类通知的 target_id 可能是接收者自己的 UUID（如管理员提前转正），
  // 被当作帖子 ID 跳转导致 404；现统一归入个人主页跳转。
  const resolveNotificationNav = (item: NotificationItem): 'post' | 'profile' | 'chat' | 'group' | 'battle' | 'none' => {
    // 棋类对战邀请的 target_id 是对局 UUID，不是文章 ID。
    // 必须在这里拦住，否则会落到末尾兜底被当成帖子跳转，
    // 打开 /posts/<match_id> 得到「该文章已被删除」。
    if (item.action_type === 'ai_daily_digest') return 'none';
    if (item.action_type === 'game_invite') return 'battle';
    if (item.action_type === 'chat_message') return 'chat';
    if (['group_apply', 'group_apply_approved', 'group_apply_rejected', 'group_invite', 'group_owner_transferred', 'group_kicked'].includes(item.action_type)) return 'group';
    if (item.action_type === 'follow') return 'profile';
    if (['level_up', 'level_down', 'system'].includes(item.action_type)) return 'profile';
    // 互动类：仅当 target_id 不是自己的 UUID 时才视为帖子目标
    if (['comment', 'reply', 'like_post', 'like_comment', 'accepted_solution', 'essence_post', 'mention'].includes(item.action_type)) {
      if (item.target_id && item.target_id !== selfUserId) return 'post';
      return 'profile';
    }
    if (item.target_id && item.target_id !== selfUserId) return 'post';
    return 'profile';
  };

  const handleItemClick = (item: NotificationItem) => {
    // 1. 若当前通知为未读，点击即刻转为已读并上报后端持久化，同步扣减全局未读徽标
    if (!item.is_read) {
      setNotifications((prev) => prev.map((n) => (n.id === item.id ? { ...n, is_read: true } : n)));
      void markNotificationRead(item);
    }

    // 2. 智能跳转对应关联目标
    const nav = resolveNotificationNav(item);
    if (nav === 'none') return;
    if (nav === 'battle') {
      // 游戏大厅是独立页面，带对局 id 跳过去即可在「我的对局」里接受
      onClose();
      window.location.href = `/404?zone=versus&match=${item.target_id || ''}`;
    } else if (nav === 'group' && onSelectChat) {
      onSelectChat('', item.target_id || undefined);
      onClose();
    } else if (nav === 'chat' && onSelectChat) {
      onSelectChat(item.sender_username || '');
      onClose();
    } else if (nav === 'profile' && onSelectUser) {
      // 等级晋升/系统通告/关注 → 本人主页；follow 类优先查看关注者
      const target = item.action_type === 'follow' && item.sender_username
        ? item.sender_username
        : (selfUsername || '');
      if (target) {
        onSelectUser(target);
        onClose();
      }
    } else if (nav === 'post' && onSelectPost && item.target_id) {
      // 评论/回复/提及类通知一律打开评论区；即使历史通知没有 comment_id，
      // 也不至于点了之后什么都没发生。
      const commentRelated = ['comment', 'reply', 'mention', 'like_comment', 'accepted_solution'].includes(item.action_type);
      onSelectPost(item.target_id, item.comment_id, commentRelated);
      onClose();
    }
  };

  // 通知聚合：同一来源（类型 + 目标）的连续未读通知合并成一条，避免同一会话/文章刷屏
  const aggregated = React.useMemo(() => {
    type AggItem = NotificationItem & { _groupCount?: number; _unreadInGroup?: number };
    const out: AggItem[] = [];
    const keyOf = (n: NotificationItem) => `${n.action_type}:${n.target_id || ''}`;
    for (const n of notifications) {
      const prev = out[out.length - 1];
      if (prev && !prev.is_read && !n.is_read && keyOf(prev) === keyOf(n) && prev._groupCount) {
        prev._groupCount += 1;
        prev._unreadInGroup = (prev._unreadInGroup || 0) + (n.is_read ? 0 : 1);
        continue;
      }
      out.push({ ...n, _groupCount: 1, _unreadInGroup: n.is_read ? 0 : 1 });
    }
    return out;
  }, [notifications]);

  // 分类已由服务端过滤，这里不再二次筛选
  const filteredNotifications = aggregated;

  // 注意：不能再在 portal 外层 `if (!isOpen) return null`，
  // 否则 AnimatePresence 的退出动画永远不会执行（组件直接消失）。
  return createPortal(
    <AnimatePresence>
      {isOpen && (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        role="dialog"
          aria-modal="true"
          aria-label="消息与通知中心"
          className="fixed inset-0 z-[100] flex justify-end bg-black/50"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <motion.div
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
          className="w-full max-w-md h-full frost-panel flex flex-col will-change-transform"
        >
          {/* 抽屉头部 */}
          <div className="p-4 sm:p-5 border-b border-wb-border-subtle flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-wb-text-primary" />
              <h2 className="font-bold text-sm text-wb-text-primary">消息与通知中心</h2>
              <span className="text-xs text-wb-text-muted font-mono">
                ({globalUnreadCount ?? notifications.filter((n) => !n.is_read).length} 条未读)
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleMarkAllRead}
                title="全部标为已读"
                className="wb-pressable inline-flex items-center gap-1 text-2xs font-medium text-wb-text-secondary hover:text-wb-text-primary px-2 py-1 rounded-capsule bg-wb-bg-subtle whitespace-nowrap shrink-0"
              >
                <CheckCheck className="w-3.5 h-3.5 shrink-0" />
                <span className="whitespace-nowrap">已读</span>
              </button>

              <button
                type="button"
                onClick={handleClearAll}
                title="一键清空全部通知"
                className="wb-pressable inline-flex items-center gap-1 text-2xs font-medium text-wb-danger hover:text-wb-danger px-2 py-1 rounded-capsule bg-wb-danger/10 hover:bg-wb-danger/15 transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5 shrink-0" />
                <span className="whitespace-nowrap">清空</span>
              </button>

              <button
                type="button"
                onClick={onClose}
                className="p-1 text-wb-text-muted hover:text-wb-text-primary rounded-lg ml-1 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 分类筛选器 */}
          <div className="px-4 pt-3 pb-2 border-b border-wb-border-subtle/70 bg-wb-bg-surface/50">
            <div
              className="relative flex items-center p-1 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle overflow-x-auto overflow-y-hidden no-scrollbar"
              style={{ overflowY: 'hidden', scrollbarWidth: 'none' }}
            >
              {[
                { key: 'all', label: '全部' },
                { key: 'chat', label: '私信' },
                { key: 'interactive', label: '互动' },
                { key: 'social', label: '关注' },
                { key: 'system', label: '系统' },
              ].map((tab) => {
                const isActive = filterCategory === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setFilterCategory(tab.key as any)}
                    className={`relative z-10 flex-1 min-w-[50px] text-center py-1 text-xs font-medium rounded-capsule transition-colors duration-180 whitespace-nowrap shrink-0 ${
                      isActive
                        ? 'text-wb-bg-page font-semibold'
                        : 'text-wb-text-secondary hover:text-wb-text-primary'
                    }`}
                  >
                    {isActive && (
                      <motion.div
                        layoutId="notification-category-pill"
                        transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                        className="absolute inset-0 bg-wb-text-primary rounded-capsule shadow-sm -z-10"
                      />
                    )}
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 消息通知列表 */}
          <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-2.5">
            {loading ? (
              <div className="py-12 text-center text-xs text-wb-text-muted animate-pulse">
                正在同步通知列表...
              </div>
            ) : (
              <AnimatePresence mode="wait">
                <motion.div
                  key={filterCategory}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.16 }}
                  className="space-y-2.5"
                >
                  {filteredNotifications.length > 0 ? (
                    filteredNotifications.map((item) => (
                      <div
                        key={item.id}
                        onClick={() => handleItemClick(item)}
                        className={`p-3.5 rounded-2xl border transition-all cursor-pointer group relative ${
                          item.is_read
                            ? 'bg-wb-bg-surface border-wb-border-subtle hover:border-wb-border-strong opacity-80'
                            : 'bg-wb-bg-subtle/80 border-wb-text-primary/30 shadow-sm'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          {/* 类型专属单色矢量徽标 */}
                          <div className="p-2 rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-wb-text-primary flex-shrink-0 mt-0.5">
                            {item.action_type === 'game_invite' && <Gamepad2 className="w-4 h-4 text-wb-brand" />}
                            {item.action_type === 'chat_message' && <MessageSquare className="w-4 h-4 text-wb-info" />}
                            {['group_apply', 'group_apply_approved', 'group_apply_rejected', 'group_invite', 'group_owner_transferred', 'group_kicked'].includes(item.action_type) && <Users className="w-4 h-4 text-wb-info" />}
                            {item.action_type === 'level_up' && <Award className="w-4 h-4" />}
                            {item.action_type === 'level_down' && <Sparkles className="w-4 h-4" />}
                            {(item.action_type === 'comment' || item.action_type === 'reply') && <MessageSquare className="w-4 h-4" />}
                            {item.action_type === 'like_post' && <Heart className="w-4 h-4" />}
                            {item.action_type === 'like_comment' && <Heart className="w-4 h-4" />}
                            {item.action_type === 'accepted_solution' && <MessageSquare className="w-4 h-4" />}
                            {item.action_type === 'essence_post' && <Award className="w-4 h-4" />}
                            {item.action_type === 'follow' && <UserPlus className="w-4 h-4" />}
                            {item.action_type === 'system' && <Sparkles className="w-4 h-4" />}
                            {item.action_type === 'ai_daily_digest' && <Sparkles className="w-4 h-4 text-wb-brand" />}
                          </div>

                          <div className="flex-1 space-y-1 pr-6 min-w-0">
                            <div className="flex items-center justify-between">
                              <span className="text-2xs font-semibold text-wb-text-primary truncate">
                                {item.action_type === 'game_invite' && '棋类对战邀请'}
                                {item.action_type === 'chat_message' && (item.sender_nickname ? `${item.sender_nickname} 发来私信` : `@${item.sender_username || '用户'} 发来私信`)}
                                {item.action_type === 'group_apply' && '群聊加入申请'}
                                {item.action_type === 'group_apply_approved' && '入群申请已批准'}
                                {item.action_type === 'group_apply_rejected' && '入群申请已拒绝'}
                                {item.action_type === 'group_invite' && '群聊邀请通知'}
                                {item.action_type === 'group_owner_transferred' && '群主身份变更'}
                                {item.action_type === 'group_kicked' && '群聊成员变更'}
                                {item.action_type === 'level_up' && '等级特权晋升'}
                                {item.action_type === 'level_down' && '等级调整通知'}
                                {item.action_type === 'comment' && '收到新的评论'}
                                {item.action_type === 'reply' && '收到楼层回复'}
                                {item.action_type === 'like_post' && '帖子点赞'}
                                {item.action_type === 'like_comment' && '评论点赞'}
                                {item.action_type === 'accepted_solution' && '解答被采纳'}
                                {item.action_type === 'essence_post' && '文章被设为精华'}
                                {item.action_type === 'follow' && '新增极客关注'}
                                {item.action_type === 'system' && '系统通告'}
                                {item.action_type === 'ai_daily_digest' && 'AI 回复日报'}
                              </span>
                              <span className="text-3xs text-wb-text-muted font-mono flex-shrink-0 ml-2">
                                {formatChatTime(item.created_at)}
                              </span>
                            </div>
                            <p className="text-xs text-wb-text-secondary leading-relaxed break-words">
                              {item.brief}
                            </p>
                            {(() => {
                              const count = (item as any).group_total || (item as any)._groupCount || 0;
                              if (count <= 1) return null;
                              const gkey = `${item.action_type}:${(item as any).target_id || ''}`;
                              const open = expandedGroups.has(gkey);
                              const details: any[] = (item as any).group_items || [];
                              const toggle = (e: React.MouseEvent) => {
                                // 阻止冒泡：外层卡片点击会把通知标记已读并跳转
                                e.stopPropagation();
                                setExpandedGroups((prev) => {
                                const next = new Set(prev);
                                  if (next.has(gkey)) next.delete(gkey);
                                  else next.add(gkey);
                                  return next;
                                });
                              };
                              return (
                                <div className="space-y-1">
                                  <button
                                    type="button"
                                    onClick={toggle}
                                    aria-expanded={open}
                                    aria-label={open ? '收起同类互动' : `展开查看这 ${count} 条同类互动`}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-wb-info/10 border border-wb-info/20 text-3xs font-semibold text-wb-info hover:bg-wb-info/20 transition-colors"
                                  >
                                    累计 {count} 条同类互动
                                    <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
                                  </button>
                                  {open && (
                                    <ul
                                      className="space-y-0.5 pt-0.5 pl-1 border-l-2 border-wb-info/20"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      {details.length === 0 && (
                                        <li className="text-3xs text-wb-text-muted pl-2">没有更多明细</li>
                                      )}
                                      {details.map((g: any) => (
                                        <li key={g.id} className="text-3xs text-wb-text-secondary pl-2 leading-relaxed">
                                          <span className="text-wb-text-muted font-mono mr-1">
                                            {formatChatTime(g.created_at)}
                                          </span>
                                          {g.brief}
                                        </li>
                                      ))}
                                      {count > details.length && details.length > 0 && (
                                        <li className="text-3xs text-wb-text-muted pl-2">
                                          另有 {count - details.length} 条更早的同类互动
                                        </li>
                                      )}
                                    </ul>
                                  )}
                                </div>
                              );
                            })()}
                            {resolveNotificationNav(item) !== 'none' && (
                              <div className="pt-1 flex items-center gap-1 text-3xs text-wb-text-primary font-medium">
                                <span>
                                  {item.action_type === 'game_invite'
                                    ? '前往摸鱼游乐场'
                                    : item.action_type === 'chat_message'
                                    ? '进入私聊对话'
                                    : ['group_apply', 'group_apply_approved', 'group_apply_rejected', 'group_invite', 'group_owner_transferred', 'group_kicked'].includes(item.action_type)
                                    ? '进入群聊频道'
                                    : item.action_type === 'follow'
                                    ? '查看极客空间'
                                    : ['level_up', 'level_down', 'system'].includes(item.action_type)
                                    ? '查看我的主页'
                                    : '查看关联内容'}
                                </span>
                                <ChevronRight className="w-3 h-3" />
                              </div>
                            )}
                          </div>

                          {/* 操作按钮组：放在同一个 flex 容器里右对齐。
                              以前两个按钮各自 absolute 定位（right-2.5 / right-9），
                              窄卡片下会与时间文字挤在一起、甚至互相重叠。 */}
                          <div className="flex items-center gap-0.5 shrink-0 self-start ml-auto opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                            {item.action_type === 'game_invite' && item.target_id && (
                              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                <button
                                  type="button"
                                  title="接受对战邀请"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    try {
                                      await apiClient.post(`/battles/${item.target_id}/accept`);
                                      void markNotificationRead(item);
                                      onClose();
                                      window.location.href = `/404?zone=versus&match=${item.target_id}`;
                                    } catch (err: any) {
                                      // 已接受/过期的邀请仍可进大厅查看
                                      window.location.href = '/404?zone=versus';
                                    }
                                  }}
                                  className="p-1.5 rounded-lg text-wb-success hover:bg-wb-success/10 transition-colors text-3xs font-semibold"
                                >接受</button>
                                <button
                                  type="button"
                                  title="拒绝对战邀请"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    try {
                                      await apiClient.post(`/battles/${item.target_id}/decline`);
                                      void markNotificationRead(item);
                                      setNotifications((prev) => prev.filter((n) => n.id !== item.id));
                                    } catch { /* 容错 */ }
                                  }}
                                  className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-danger transition-colors text-3xs"
                                >拒绝</button>
                              </div>
                            )}
                            {!item.is_read && (
                              <button
                                type="button"
                                onClick={(e) => handleMarkReadItem(item.id, e)}
                                title="标为已读"
                                className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-success hover:bg-wb-success/10 transition-colors"
                              >
                                <CheckCheck className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(e) => handleDeleteItem(item.id, e)}
                              title="删除此通知"
                              className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-danger hover:bg-wb-danger/10 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="py-16 text-center text-xs text-wb-text-muted space-y-2">
                      <Bell className="w-8 h-8 mx-auto text-wb-text-muted stroke-1 opacity-50" />
                      <p>暂无任何新的系统或互动消息</p>
                    </div>
                  )}

                  {/* 加载更多历史通知：不受当前分类是否有匹配影响，
                      否则"该分类在已加载的 40 条里为空"时按钮会消失，历史永远取不到 */}
                  {hasMoreNotifs && (
                    <div className="flex justify-center pt-1">
                      <button
                        type="button"
                        onClick={loadMoreNotifications}
                        disabled={loadingMoreNotifs}
                        className="px-3 py-1.5 rounded-capsule text-2xs font-medium text-wb-text-secondary bg-wb-bg-subtle border border-wb-border-subtle hover:text-wb-text-primary hover:border-wb-border-strong transition-colors disabled:opacity-50"
                      >
                        {loadingMoreNotifs ? '加载中...' : '加载更多历史通知'}
                      </button>
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        </motion.div>
      </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};
