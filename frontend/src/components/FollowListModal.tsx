import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Search, UserCheck, UserPlus, Lock, MessageSquare } from 'lucide-react';
import { apiClient } from '../api/client';
import { UserAvatar } from './UserAvatar';
import { OnlineAvatar } from './OnlineAvatar';
import { LevelBadge } from './LevelBadge';
import type { UserProfile } from '../types';

export interface FollowItem {
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
  /** 在线状态（90 秒心跳），对方隐藏在线状态时恒为 false */
  is_online?: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  username?: string;
  targetUsername?: string;
  initialTab?: 'following' | 'followers';
  currentUser?: UserProfile | null;
  onSelectUser?: (username: string) => void;
  onDirectMessage?: (user: { id: string; username: string }) => void;
  onRequireAuth?: () => void;
}

export const FollowListModal: React.FC<Props> = ({
  isOpen,
  onClose,
  username,
  targetUsername,
  initialTab = 'following',
  currentUser,
  onSelectUser,
  onDirectMessage,
  onRequireAuth,
}) => {
  const effectiveUsername = username || targetUsername || '';
  const [activeTab, setActiveTab] = useState<'following' | 'followers'>(initialTab);
  const [searchQuery, setSearchQuery] = useState('');
  const [items, setItems] = useState<FollowItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [isHidden, setIsHidden] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, isOpen]);

  const fetchData = async () => {
    if (!effectiveUsername || !isOpen) return;
    setLoading(true);
    try {
      const endpoint = activeTab === 'following' ? `/users/${effectiveUsername}/following` : `/users/${effectiveUsername}/followers`;
      const params = new URLSearchParams();
      if (searchQuery.trim()) {
        params.append('q', searchQuery.trim());
      }
      params.append('size', '50');
      const res = await apiClient.get(`${endpoint}?${params.toString()}`);
      if (res.data) {
        setIsHidden(Boolean(res.data.hidden));
        setTotal(res.data.total || 0);
        setItems(res.data.items || []);
      }
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchData();
    }
  }, [isOpen, effectiveUsername, activeTab, searchQuery]);

  const handleToggleFollow = async (targetItem: FollowItem) => {
    if (!currentUser) {
      onRequireAuth?.();
      return;
    }
    const isNowFollowing = !targetItem.is_following;
    
    // 乐观更新
    setItems((prev) =>
      prev.map((it) => (it.id === targetItem.id ? { ...it, is_following: isNowFollowing } : it))
    );

    try {
      if (isNowFollowing) {
        await apiClient.post(`/users/${targetItem.username}/follow`);
      } else {
        await apiClient.delete(`/users/${targetItem.username}/follow`);
      }
    } catch {
      // 失败回滚
      setItems((prev) =>
        prev.map((it) => (it.id === targetItem.id ? { ...it, is_following: !isNowFollowing } : it))
      );
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <AnimatePresence>
      <div
        className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="w-full max-w-lg bg-wb-bg-surface border border-wb-border-strong rounded-3xl shadow-2xl flex flex-col overflow-hidden max-h-[85vh]"
        >
          {/* 弹窗头部 */}
          <div className="px-6 pt-5 pb-4 border-b border-wb-border-subtle flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-bold text-base text-wb-text-primary">
                @{effectiveUsername} 的社交圈
              </span>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-full hover:bg-wb-bg-subtle text-wb-text-muted hover:text-wb-text-primary transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 分段 Tab 切换 */}
          <div className="px-6 pt-3 pb-2 flex items-center gap-2 border-b border-wb-border-subtle bg-wb-bg-subtle/30">
            <button
              onClick={() => {
                setActiveTab('following');
                setSearchQuery('');
              }}
              className={`flex-1 py-2 px-3 rounded-2xl text-xs font-semibold flex items-center justify-center gap-2 transition-all ${
                activeTab === 'following'
                  ? 'bg-wb-text-primary text-wb-bg-page shadow-sm'
                  : 'text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle'
              }`}
            >
              <span>关注中 (Following)</span>
              {activeTab === 'following' && total > 0 && (
                <span className="text-3xs px-1.5 py-0.2 rounded-capsule bg-wb-bg-page/20">
                  {total}
                </span>
              )}
            </button>
            <button
              onClick={() => {
                setActiveTab('followers');
                setSearchQuery('');
              }}
              className={`flex-1 py-2 px-3 rounded-2xl text-xs font-semibold flex items-center justify-center gap-2 transition-all ${
                activeTab === 'followers'
                  ? 'bg-wb-text-primary text-wb-bg-page shadow-sm'
                  : 'text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle'
              }`}
            >
              <span>粉丝 (Followers)</span>
              {activeTab === 'followers' && total > 0 && (
                <span className="text-3xs px-1.5 py-0.2 rounded-capsule bg-wb-bg-page/20">
                  {total}
                </span>
              )}
            </button>
          </div>

          {/* 搜索框 */}
          <div className="px-6 py-3 border-b border-wb-border-subtle bg-wb-bg-surface">
            <div className="relative flex items-center">
              <Search className="w-3.5 h-3.5 absolute left-3 text-wb-text-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={`在${activeTab === 'following' ? '关注中' : '粉丝'}中搜索用户名或昵称...`}
                className="w-full pl-8 pr-4 py-1.5 text-xs bg-wb-bg-subtle rounded-capsule border border-wb-border-subtle text-wb-text-primary placeholder:text-wb-text-muted focus:outline-none focus:border-wb-border-strong"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 text-wb-text-muted hover:text-wb-text-primary"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* 列表内容区 */}
          <div className="flex-1 overflow-y-auto wb-scrollbar-thin p-4 space-y-2 min-h-[260px]">
            {loading ? (
              <div className="space-y-3 p-4 animate-pulse">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-wb-bg-subtle" />
                    <div className="flex-1 space-y-1.5">
                      <div className="w-28 h-3.5 bg-wb-bg-subtle rounded-md" />
                      <div className="w-44 h-2.5 bg-wb-bg-subtle rounded-md" />
                    </div>
                  </div>
                ))}
              </div>
            ) : isHidden ? (
              <div className="py-16 text-center space-y-3">
                <div className="w-12 h-12 mx-auto rounded-full bg-wb-bg-subtle flex items-center justify-center text-wb-text-muted border border-wb-border-subtle">
                  <Lock className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold text-wb-text-primary">隐私保护模式</h4>
                  <p className="text-xs text-wb-text-muted">该用户已将{activeTab === 'following' ? '关注列表' : '粉丝列表'}设为私密</p>
                </div>
              </div>
            ) : items.length === 0 ? (
              <div className="py-16 text-center space-y-2">
                <p className="text-xs text-wb-text-muted">
                  {searchQuery ? '未找到匹配的极客成员' : `暂无${activeTab === 'following' ? '关注成员' : '粉丝成员'}`}
                </p>
              </div>
            ) : (
              items.map((item) => {
                const isSelf = currentUser && currentUser.id === item.id;
                return (
                  <div
                    key={item.id}
                    className="flex items-center justify-between p-3 rounded-2xl hover:bg-wb-bg-subtle/60 border border-transparent hover:border-wb-border-subtle transition-all"
                  >
                    <div
                      onClick={() => {
                        onClose();
                        if (onSelectUser) onSelectUser(item.username);
                      }}
                      className="flex items-center gap-3 cursor-pointer flex-1 min-w-0 pr-2"
                    >
                      {/* 粉丝/关注列表就能看到谁在线，不必点进对方主页 */}
                      <OnlineAvatar online={Boolean(item.is_online)} size={30}>
                        <UserAvatar username={item.username} avatarUrl={item.avatar_url} size="sm" />
                      </OnlineAvatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-xs text-wb-text-primary truncate">
                            {item.nickname || item.username}
                          </span>
                          <span className="text-2xs text-wb-text-muted font-mono truncate">
                            @{item.username}
                          </span>
                          <LevelBadge level={item.level} />
                        </div>
                        {item.bio ? (
                          <p className="text-2xs text-wb-text-muted truncate mt-0.5">
                            {item.bio}
                          </p>
                        ) : (
                          <p className="text-2xs text-wb-text-muted font-mono mt-0.5">
                            {item.followers_count} 粉丝 · {item.following_count} 关注
                          </p>
                        )}
                      </div>
                    </div>

                    {/* 操作区 */}
                    {!isSelf && currentUser && (
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {onDirectMessage && (
                          <button
                            onClick={() => {
                              onClose();
                              onDirectMessage({ id: item.id, username: item.username });
                            }}
                            title="发起私聊"
                            className="p-1.5 rounded-full hover:bg-wb-bg-subtle text-wb-text-muted hover:text-wb-text-primary transition-colors"
                          >
                            <MessageSquare className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => handleToggleFollow(item)}
                          className={`wb-pressable inline-flex items-center gap-1 px-3 py-1 rounded-capsule text-xs font-semibold transition-all ${
                            item.is_following
                              ? 'bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-secondary hover:text-wb-danger hover:border-wb-danger/40'
                              : 'bg-wb-text-primary text-wb-bg-page hover:opacity-90 shadow-sm'
                          }`}
                        >
                          {item.is_following ? (
                            <>
                              <UserCheck className="w-3 h-3" />
                              <span>已关注</span>
                            </>
                          ) : (
                            <>
                              <UserPlus className="w-3 h-3" />
                              <span>关注</span>
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body
  );
};
