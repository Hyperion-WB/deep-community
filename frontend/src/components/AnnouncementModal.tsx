import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Volume2,
  Sparkles,
  AlertTriangle,
  History,
  Calendar,
  Search,
  ChevronRight,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { apiClient } from '../api/client';
import type { AnnouncementItem } from './AnnouncementTicker';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** 点击「我知道了」：确认已读并收起公告，不再反复提示 */
  onAcknowledge?: () => void;
  activeAnnouncements?: AnnouncementItem[];
  initialSelectedId?: number;
}

export const AnnouncementModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onAcknowledge,
  activeAnnouncements = [],
  initialSelectedId,
}) => {
  const [activeTab, setActiveTab] = useState<'current' | 'history'>('current');
  const [historyList, setHistoryList] = useState<AnnouncementItem[]>([]);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<AnnouncementItem | null>(null);
  const [loadingHistory, setLoadingHistory] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterLevel, setFilterLevel] = useState<string>('all');

  // 当弹窗打开时，根据传入的 initialSelectedId 设置选中的公告
  useEffect(() => {
    if (isOpen) {
      if (initialSelectedId && activeAnnouncements.length > 0) {
        const found = activeAnnouncements.find((a) => a.id === initialSelectedId);
        if (found) setSelectedAnnouncement(found);
        else setSelectedAnnouncement(activeAnnouncements[0] || null);
      } else if (activeAnnouncements.length > 0) {
        setSelectedAnnouncement(activeAnnouncements[0]);
      }
      fetchHistory();
    }
  }, [isOpen, initialSelectedId, activeAnnouncements]);

  // 获取全站历史公告与版本更新日志 (公开接口)
  const fetchHistory = async () => {
    setLoadingHistory(true);
    try {
      const res = await apiClient.get('/admin/announcements/history?limit=100');
      if (Array.isArray(res.data)) {
        setHistoryList(res.data);
      }
    } catch {
      // 降级使用当前活跃公告列表
      setHistoryList(activeAnnouncements);
    } finally {
      setLoadingHistory(false);
    }
  };

  // ESC 键收起
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // 模态弹窗开启时锁定底层 body 滚动，彻底杜绝移动端与桌面端手势穿透
  useEffect(() => {
    if (isOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [isOpen]);

  // 格式化时间
  const formatTime = (timeStr?: string) => {
    if (!timeStr) return '';
    try {
      const d = new Date(timeStr);
      return d.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return timeStr;
    }
  };

  // 筛选过滤后的历史记录
  const filteredHistory = useMemo(() => {
    return historyList.filter((item) => {
      const matchesLevel =
        filterLevel === 'all' || item.level === filterLevel;
      const matchesQuery =
        !searchQuery.trim() ||
        (item.title && item.title.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (item.content && item.content.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchesLevel && matchesQuery;
    });
  }, [historyList, filterLevel, searchQuery]);

  // 徽标样式与图标映射
  const renderBadge = (level: string = 'info') => {
    switch (level) {
      case 'update':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-wb-brand/15 text-wb-brand border border-wb-brand/20">
            <Sparkles className="w-3 h-3" />
            <span>版本更新</span>
          </span>
        );
      case 'warning':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-wb-warn/15 text-wb-warn dark:text-wb-warn border border-wb-warn/20">
            <AlertTriangle className="w-3 h-3" />
            <span>维护警示</span>
          </span>
        );
      case 'info':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-wb-info/15 text-wb-info dark:text-wb-info border border-wb-info/20">
            <Volume2 className="w-3 h-3" />
            <span>社区公告</span>
          </span>
        );
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
          {/* 背景毛玻璃遮罩 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 backdrop-blur-md transition-opacity"
          />

          {/* 模态框主体卡片 (定高 560px 杜绝 Tab 切换时的窗口伸缩抖动) */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: 'spring', damping: 28, stiffness: 350 }}
            className="relative w-full max-w-2xl h-[560px] max-h-[85vh] bg-wb-bg-surface border border-wb-border-subtle rounded-3xl shadow-2xl overflow-hidden flex flex-col z-10 my-auto [scrollbar-gutter:stable]"
          >
            {/* 顶栏：标题与 Tab 切换 */}
            <div className="flex flex-col border-b border-wb-border-subtle bg-wb-bg-subtle/50 px-5 pt-4 pb-3 flex-shrink-0">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-2xl bg-wb-text-primary text-wb-bg-page shadow-xs">
                    <Volume2 className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="font-bold text-sm sm:text-base text-wb-text-primary leading-tight">
                      社区公告与更新日志
                    </h3>
                    <p className="text-2xs text-wb-text-muted mt-0.5">
                      了解最新版本特性、平台动态与重要通知
                    </p>
                  </div>
                </div>

                <button
                  onClick={onClose}
                  className="wb-pressable p-1.5 rounded-full hover:bg-wb-bg-subtle text-wb-text-muted hover:text-wb-text-primary transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* 选项卡切换胶囊 (修复白色文字无背景问题与滑动弹簧) */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center p-0.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-xs">
                  <button
                    onClick={() => {
                      setActiveTab('current');
                      if (activeAnnouncements.length > 0 && !selectedAnnouncement) {
                        setSelectedAnnouncement(activeAnnouncements[0]);
                      }
                    }}
                    className={`relative px-3.5 py-1.5 rounded-capsule font-medium transition-colors select-none ${
                      activeTab === 'current'
                        ? 'text-wb-bg-page font-semibold'
                        : 'text-wb-text-secondary hover:text-wb-text-primary'
                    }`}
                  >
                    {activeTab === 'current' && (
                      <motion.div
                        layoutId="announcement-tab-active"
                        className="absolute inset-0 bg-wb-text-primary rounded-capsule shadow-xs"
                        transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                      />
                    )}
                    <span className="relative z-10">当前公告 {activeAnnouncements.length > 0 && `(${activeAnnouncements.length})`}</span>
                  </button>

                  <button
                    onClick={() => setActiveTab('history')}
                    className={`relative px-3.5 py-1.5 rounded-capsule font-medium transition-colors select-none ${
                      activeTab === 'history'
                        ? 'text-wb-bg-page font-semibold'
                        : 'text-wb-text-secondary hover:text-wb-text-primary'
                    }`}
                  >
                    {activeTab === 'history' && (
                      <motion.div
                        layoutId="announcement-tab-active"
                        className="absolute inset-0 bg-wb-text-primary rounded-capsule shadow-xs"
                        transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                      />
                    )}
                    <span className="relative z-10 flex items-center gap-1.5">
                      <History className="w-3.5 h-3.5" />
                      <span>更新日志与历史</span>
                    </span>
                  </button>
                </div>

                {activeTab === 'current' && activeAnnouncements.length > 1 && (
                  <div className="hidden sm:flex items-center gap-1 text-xs text-wb-text-muted">
                    <span>选择切换公告:</span>
                    <div className="flex items-center gap-1">
                      {activeAnnouncements.map((item, idx) => (
                        <button
                          key={item.id}
                          onClick={() => setSelectedAnnouncement(item)}
                          className={`w-6 h-6 rounded-full text-xs font-mono font-medium flex items-center justify-center transition-all ${
                            selectedAnnouncement?.id === item.id
                              ? 'bg-wb-text-primary text-wb-bg-page font-bold shadow-xs scale-105'
                              : 'bg-wb-bg-surface hover:bg-wb-bg-subtle text-wb-text-secondary border border-wb-border-subtle'
                          }`}
                        >
                          {idx + 1}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 内容视口区域 */}
            <div className="flex-1 overflow-y-auto p-5 wb-scrollbar-thin">
              {activeTab === 'current' ? (
                /* 当前公告详情模式 */
                selectedAnnouncement ? (
                  <div className="space-y-4">
                    {/* 头部元信息 */}
                    <div className="pb-3 border-b border-wb-border-subtle space-y-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        {renderBadge(selectedAnnouncement.level)}
                        {selectedAnnouncement.created_at && (
                          <div className="flex items-center gap-1.5 text-xs text-wb-text-muted">
                            <Calendar className="w-3.5 h-3.5" />
                            <span>发布于 {formatTime(selectedAnnouncement.created_at)}</span>
                          </div>
                        )}
                      </div>

                      <h2 className="text-base sm:text-lg font-bold text-wb-text-primary">
                        {selectedAnnouncement.title || '社区公告详情'}
                      </h2>
                    </div>

                    {/* 正文 (支持 Markdown、更新日志列表与排版) */}
                    <div className="prose prose-sm dark:prose-invert max-w-none text-wb-text-primary leading-relaxed text-xs sm:text-sm">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkBreaks]}
                        components={{
                          h1: ({ children }) => (
                            <h3 className="text-base font-bold text-wb-text-primary mt-4 mb-2">
                              {children}
                            </h3>
                          ),
                          h2: ({ children }) => (
                            <h4 className="text-sm font-bold text-wb-text-primary mt-3 mb-1.5">
                              {children}
                            </h4>
                          ),
                          h3: ({ children }) => (
                            <h5 className="text-xs font-bold text-wb-text-primary mt-2 mb-1">
                              {children}
                            </h5>
                          ),
                          ul: ({ children }) => (
                            <ul className="list-disc list-inside space-y-1 my-2 pl-1 text-wb-text-secondary">
                              {children}
                            </ul>
                          ),
                          ol: ({ children }) => (
                            <ol className="list-decimal list-inside space-y-1 my-2 pl-1 text-wb-text-secondary">
                              {children}
                            </ol>
                          ),
                          li: ({ children }) => (
                            <li className="text-wb-text-secondary text-xs sm:text-sm leading-normal">
                              {children}
                            </li>
                          ),
                          p: ({ children }) => (
                            <p className="my-1.5 leading-relaxed text-wb-text-secondary">
                              {children}
                            </p>
                          ),
                          code: ({ className, children, ...props }: any) =>
                            (!className?.includes('language-') && !String(children).includes('\n')) ? (
                              <code className="px-1.5 py-0.5 rounded bg-wb-bg-subtle font-mono text-2xs text-wb-text-primary font-semibold border border-wb-border-subtle" {...props}>
                                {children}
                              </code>
                            ) : (
                              <pre className="p-3 my-2 rounded-xl bg-wb-bg-subtle text-wb-text-primary font-mono text-xs overflow-x-auto border border-wb-border-subtle">
                                <code>{children}</code>
                              </pre>
                            ),
                          blockquote: ({ children }) => (
                            <blockquote className="border-l-4 border-wb-text-primary/40 pl-3 py-1 my-2 text-wb-text-muted italic bg-wb-bg-subtle/50 rounded-r-lg text-xs">
                              {children}
                            </blockquote>
                          ),
                        }}
                      >
                        {selectedAnnouncement.content}
                      </ReactMarkdown>
                    </div>

                    {/* 移动端多条公告快速切换 */}
                    {activeAnnouncements.length > 1 && (
                      <div className="pt-4 border-t border-wb-border-subtle flex items-center justify-between">
                        <span className="text-xs text-wb-text-muted">
                          当前展示第 {activeAnnouncements.findIndex((a) => a.id === selectedAnnouncement.id) + 1} / {activeAnnouncements.length} 条公告
                        </span>
                        <div className="flex items-center gap-1.5">
                          {activeAnnouncements.map((a, i) => (
                            <button
                              key={a.id}
                              onClick={() => setSelectedAnnouncement(a)}
                              className={`px-2.5 py-1 rounded-capsule text-xs font-medium border transition-colors ${
                                selectedAnnouncement.id === a.id
                                  ? 'bg-wb-text-primary text-wb-bg-page border-wb-text-primary'
                                  : 'bg-wb-bg-surface text-wb-text-secondary border-wb-border-subtle hover:bg-wb-bg-subtle'
                              }`}
                            >
                              公告 {i + 1}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="py-12 text-center text-wb-text-muted text-xs">
                    暂无正在生效的置顶公告，请点击“更新日志与历史”查看往期动态
                  </div>
                )
              ) : (
                /* 历史公告与版本更新日志模式 */
                <div className="space-y-3">
                  {/* 搜索与分类过滤器 */}
                  <div className="flex flex-col sm:flex-row items-center gap-2">
                    <div className="relative w-full flex-1">
                      <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-wb-text-muted" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="搜索历史更新日志、功能升级或公告关键词..."
                        className="w-full h-8 pl-8 pr-3 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-xs text-wb-text-primary focus:outline-none focus:border-wb-text-primary placeholder:text-wb-text-muted"
                      />
                      {searchQuery && (
                        <button
                          onClick={() => setSearchQuery('')}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-wb-text-muted hover:text-wb-text-primary"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>

                    {/* 分类过滤徽标 */}
                    <div className="flex items-center gap-1 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0">
                      {[
                        { key: 'all', label: '全部' },
                        { key: 'update', label: '版本日志' },
                        { key: 'info', label: '通知公告' },
                        { key: 'warning', label: '维护警示' },
                      ].map((f) => (
                        <button
                          key={f.key}
                          onClick={() => setFilterLevel(f.key)}
                          className={`px-2.5 py-1 rounded-capsule text-2xs font-medium transition-colors whitespace-nowrap ${
                            filterLevel === f.key
                              ? 'bg-wb-text-primary text-wb-bg-page font-semibold'
                              : 'bg-wb-bg-subtle hover:bg-wb-bg-surface text-wb-text-secondary border border-wb-border-subtle'
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 历史卡片列表 */}
                  {loadingHistory ? (
                    <div className="py-12 text-center text-wb-text-muted text-xs">
                      正在拉取社区历史公告与更新日志...
                    </div>
                  ) : filteredHistory.length === 0 ? (
                    <div className="py-12 text-center text-wb-text-muted text-xs">
                      没有找到匹配的历史公告或日志
                    </div>
                  ) : (
                    <div className="space-y-2.5 pt-1">
                      {filteredHistory.map((item) => (
                        <div
                          key={item.id}
                          onClick={() => {
                            setSelectedAnnouncement(item);
                            setActiveTab('current');
                          }}
                          className="group p-3.5 rounded-2xl bg-wb-bg-subtle/50 hover:bg-wb-bg-subtle border border-wb-border-subtle hover:border-wb-border-strong cursor-pointer transition-all duration-200"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1.5 min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                {renderBadge(item.level)}
                                {item.is_active && (
                                  <span className="px-1.5 py-0.2 rounded text-3xs bg-wb-success/15 text-wb-success dark:text-wb-success font-medium">
                                    正在生效
                                  </span>
                                )}
                                {item.created_at && (
                                  <span className="text-2xs text-wb-text-muted flex items-center gap-1 font-mono">
                                    <Calendar className="w-3 h-3" />
                                    {formatTime(item.created_at)}
                                  </span>
                                )}
                              </div>

                              <h4 className="font-bold text-xs sm:text-sm text-wb-text-primary group-hover:text-wb-text-primary transition-colors line-clamp-1">
                                {item.title || item.content.slice(0, 40)}
                              </h4>

                              <p className="text-xs text-wb-text-secondary line-clamp-2 leading-relaxed">
                                {item.content.replace(/[#*`_~-]/g, '')}
                              </p>
                            </div>

                            <div className="p-1 rounded-full text-wb-text-muted group-hover:text-wb-text-primary group-hover:translate-x-0.5 transition-all flex-shrink-0 mt-1">
                              <ChevronRight className="w-4 h-4" />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 底栏说明与操作 */}
            <div className="px-5 py-3 border-t border-wb-border-subtle bg-wb-bg-subtle/30 flex items-center justify-between text-xs text-wb-text-muted flex-shrink-0">
              <span className="text-2xs">
                {activeTab === 'current'
                  ? '点击“更新日志与历史”可随时查阅往期版本记录'
                  : `共收录 ${filteredHistory.length} 条公告与更新日志`}
              </span>
              <button
                type="button"
                onClick={onAcknowledge || onClose}
                className="wb-pressable px-4 py-1.5 rounded-capsule bg-wb-text-primary text-wb-bg-page font-medium text-xs shadow-xs"
              >
                我知道了
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
