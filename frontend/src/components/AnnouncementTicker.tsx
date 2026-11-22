import React, { useState, useEffect, useRef } from 'react';
import { Volume2, X, ChevronRight, ChevronLeft, Sparkles, AlertTriangle, BookOpen } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../api/client';
import { AnnouncementModal } from './AnnouncementModal';
import { SegmentedControl } from './SegmentedControl';

export interface AnnouncementItem {
  id: number;
  title?: string;
  content: string;
  level: 'info' | 'update' | 'warning';
  is_active: boolean;
  created_at?: string;
}

interface Props {
  announcements?: AnnouncementItem[];
  isCollapsed?: boolean;
  onCollapse?: () => void;
  onOpenModal?: () => void;
  onOpenAdmin?: () => void;
  isAdmin?: boolean;
  /** 弹窗内点「我知道了」：交由外层确认已读并收起 */
  onAcknowledge?: () => void;
}

export const AnnouncementTicker: React.FC<Props> = ({
  announcements: propAnnouncements,
  isCollapsed: propIsCollapsed,
  onCollapse,
  onOpenModal,
  onOpenAdmin,
  isAdmin,
  onAcknowledge,
}) => {
  const [localAnnouncements, setLocalAnnouncements] = useState<AnnouncementItem[]>([]);
  const announcements = propAnnouncements || localAnnouncements;
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [localIsCollapsed, setLocalIsCollapsed] = useState<boolean>(false);
  const isCollapsed = propIsCollapsed !== undefined ? propIsCollapsed : localIsCollapsed;
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [targetWidth, setTargetWidth] = useState<number>(240);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  // 右侧「详情/历史」「管理」的弹簧滑块当前悬停项，与顶部导航分段控件动画保持一致
  const [actionHover, setActionHover] = useState<'details' | 'admin' | null>(null);
  const measureRef = useRef<HTMLSpanElement>(null);

  const fetchAnnouncements = async () => {
    if (propAnnouncements) return;
    try {
      const res = await apiClient.get('/admin/announcements/active');
      if (res.data && Array.isArray(res.data) && res.data.length > 0) {
        setLocalAnnouncements(res.data);
      } else {
        const singleRes = await apiClient.get('/admin/announcement/current');
        if (singleRes.data && singleRes.data.content) {
          setLocalAnnouncements([singleRes.data]);
        } else {
          setLocalAnnouncements([]);
        }
      }
    } catch {
      setLocalAnnouncements([]);
    }
  };

  useEffect(() => {
    fetchAnnouncements();
    const handleRefresh = () => fetchAnnouncements();
    window.addEventListener('announcement_updated', handleRefresh);
    return () => window.removeEventListener('announcement_updated', handleRefresh);
  }, [propAnnouncements]);

  // 核心生命周期逻辑 (当未由父级控制 collapse 时自适应)：
  useEffect(() => {
    if (propIsCollapsed !== undefined || announcements.length === 0) return;

    try {
      const today = new Date().toISOString().slice(0, 10);
      const savedDate = localStorage.getItem('geek_announcement_dismiss_date');
      const savedLatestId = parseInt(localStorage.getItem('geek_announcement_dismiss_latest_id') || '0', 10);
      const currentLatestId = Math.max(...announcements.map((a) => a.id));

      if (savedDate !== today) {
        setLocalIsCollapsed(false);
      } else if (currentLatestId > savedLatestId) {
        setLocalIsCollapsed(false);
      } else {
        setLocalIsCollapsed(true);
      }
    } catch {
      setLocalIsCollapsed(false);
    }
  }, [announcements, propIsCollapsed]);

  // 用户点击关闭按钮：收纳至顶部导航栏，并持久化今日记录
  const handleCollapse = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onCollapse) {
      onCollapse();
    } else {
      setLocalIsCollapsed(true);
      try {
        const today = new Date().toISOString().slice(0, 10);
        const currentLatestId = announcements.length > 0 ? Math.max(...announcements.map((a) => a.id)) : 0;
        localStorage.setItem('geek_announcement_dismiss_date', today);
        localStorage.setItem('geek_announcement_dismiss_latest_id', String(currentLatestId));
      } catch {}
    }
  };

  // 多条公告自动轮播
  useEffect(() => {
    if (announcements.length <= 1 || isPaused || isModalOpen || isCollapsed) return;
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % announcements.length);
    }, 6000);
    return () => clearInterval(interval);
  }, [announcements.length, isPaused, isModalOpen, isCollapsed]);

  const currentAnn = announcements[currentIndex] || announcements[0];
  const displayText = currentAnn ? (currentAnn.title || currentAnn.content) : '';

  // 实时根据文案长度计算目标宽度，自适应移动端与桌面端屏幕
  useEffect(() => {
    if (measureRef.current && displayText) {
      const measured = measureRef.current.offsetWidth;
      const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
      const minW = isMobile ? Math.max(measured + 4, 32) : Math.max(measured + 8, 100);
      const maxAllowed = isMobile ? Math.min(window.innerWidth - 120, 220) : 520;
      const clamped = Math.min(Math.max(minW, 32), maxAllowed);
      setTargetWidth(clamped);
    }
  }, [displayText, currentIndex, announcements.length]);

  const handleOpenDetails = () => {
    if (onOpenModal) {
      onOpenModal();
    } else {
      setIsModalOpen(true);
    }
  };

  const renderBadge = (level: string = 'info') => {
    switch (level) {
      case 'update':
        return (
          <div className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full bg-wb-brand text-white font-bold text-3xs leading-4 flex-shrink-0 shadow-xs">
            <Sparkles className="w-2.5 h-2.5 animate-pulse" />
            <span>更新</span>
          </div>
        );
      case 'warning':
        return (
          <div className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full bg-wb-warn text-white font-bold text-3xs leading-4 flex-shrink-0 shadow-xs">
            <AlertTriangle className="w-2.5 h-2.5 animate-pulse" />
            <span>提醒</span>
          </div>
        );
      case 'info':
      default:
        return (
          <div className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full bg-wb-text-primary text-wb-bg-page font-bold text-3xs leading-4 flex-shrink-0 shadow-xs">
            <Volume2 className="w-2.5 h-2.5 animate-pulse" />
            <span>公告</span>
          </div>
        );
    }
  };

  // 管理员关闭所有公告时彻底不显示
  if (announcements.length === 0) return null;

  // 用户主动关闭后收纳到顶部导航栏深浅色切换旁边，此处不再在主视口渲染小球
  if (isCollapsed) {
    return isModalOpen ? (
      <AnnouncementModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onAcknowledge={() => {
          setIsModalOpen(false);
          (onAcknowledge || onCollapse)?.();
        }}
        activeAnnouncements={announcements}
        initialSelectedId={currentAnn?.id}
      />
    ) : null;
  }

  return (
    <>
      {/* z-40：此前与首页搜索区同为 z-30，而搜索区在 DOM 中更靠后，
          滚动到重叠位置时会把公告浮条整条盖住；提到 40 后恒在内容之上、导航栏(50)之下 */}
      <div
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
        className="sticky top-[4.25rem] sm:top-[4.75rem] z-40 flex justify-center px-2 sm:px-4 pointer-events-none mt-3 sm:mt-5 mb-0 select-none max-w-full"
      >
        {/* 离屏精确测宽隐藏节点 */}
        <span
          ref={measureRef}
          aria-hidden="true"
          className="fixed -top-[9999px] -left-[9999px] font-medium text-xs whitespace-nowrap opacity-0 pointer-events-none select-none inline-block"
        >
          {displayText}
          {announcements.length > 1 && ` (${currentIndex + 1}/${announcements.length})`}
        </span>

        {/* 胶囊主容器 */}
        <div className="pointer-events-auto inline-flex items-center gap-1.5 sm:gap-2 pl-2 pr-1 sm:pl-2.5 sm:pr-1.5 py-1 rounded-full bg-wb-bg-surface/90 backdrop-blur-xl border border-wb-border-subtle hover:border-wb-border-strong shadow-sm text-xs max-w-[calc(100vw-1.5rem)] min-w-0 overflow-hidden transition-[box-shadow,border-color] duration-300">
          {/* 左侧类型徽标 */}
          {renderBadge(currentAnn?.level)}

          {/* 核心弹簧平滑宽度过渡容器 (动态物理弹簧伸缩，点击可展开全屏/模态框查看全文及历史) */}
          <motion.div
            animate={{ width: targetWidth }}
            transition={{
              type: 'spring',
              stiffness: 220,
              damping: 24,
              mass: 0.8,
            }}
            className="overflow-hidden relative h-5 flex items-center cursor-pointer"
            onClick={handleOpenDetails}
            title="点击展开查看详情与更新日志"
          >
            <AnimatePresence initial={false}>
              <motion.div
                key={currentAnn.id || currentIndex}
                initial={{ opacity: 0, y: 8, filter: 'blur(3px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -8, filter: 'blur(3px)', position: 'absolute' }}
                transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                className="font-medium text-wb-text-primary flex items-center gap-1.5 hover:underline whitespace-nowrap w-full"
              >
                <span className="truncate">{displayText}</span>
                {announcements.length > 1 && (
                  <span className="text-3xs text-wb-text-muted font-mono flex-shrink-0 ml-0.5 opacity-70">
                    ({currentIndex + 1}/{announcements.length})
                  </span>
                )}
              </motion.div>
            </AnimatePresence>
          </motion.div>

          {/* 左右快速切换按钮 (多条公告时呈现微控制组件) */}
          {announcements.length > 1 && (
            <div className="flex items-center gap-0.5 border-l border-wb-border-subtle pl-1 flex-shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setCurrentIndex((prev) => (prev - 1 + announcements.length) % announcements.length);
                }}
                className="p-0.5 rounded-full hover:bg-wb-bg-subtle text-wb-text-muted hover:text-wb-text-primary transition-colors"
                title="上一条公告"
              >
                <ChevronLeft className="w-3 h-3" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setCurrentIndex((prev) => (prev + 1) % announcements.length);
                }}
                className="p-0.5 rounded-full hover:bg-wb-bg-subtle text-wb-text-muted hover:text-wb-text-primary transition-colors"
                title="下一条公告"
              >
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* 查看详情与历史 + 管理：复用顶部导航同一套实测滑块分段控件 */}
          <SegmentedControl
            id="announcement-actions"
            size="xs"
            className="hidden sm:inline-flex ml-0.5"
            emphasizeActive={false}
            items={[
              {
                key: 'details',
                label: (
                  <>
                    <BookOpen className="w-3 h-3" />
                    <span>详情/历史</span>
                  </>
                ),
              },
              ...(isAdmin && onOpenAdmin ? [{ key: 'admin', label: <span>管理</span> }] : []),
            ]}
            activeKey={actionHover ?? ''}
            onHoverItem={(key) => setActionHover((key as 'details' | 'admin' | null) ?? null)}
            onChange={(key) => {
              if (key === 'details') handleOpenDetails();
              else if (key === 'admin') onOpenAdmin?.();
            }}
          />

          {/* 右侧行动按键 */}
          <div className="flex items-center gap-1 flex-shrink-0 pl-1 border-l border-wb-border-subtle">
            <button
              onClick={handleCollapse}
              title="收纳至顶部导航栏 (今日不再弹出)"
              className="p-1 rounded-full text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {/* 弹窗：公告全文展开与历史更新日志浏览 */}
      <AnnouncementModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onAcknowledge={() => {
          setIsModalOpen(false);
          (onAcknowledge || onCollapse)?.();
        }}
        activeAnnouncements={announcements}
        initialSelectedId={currentAnn?.id}
      />
    </>
  );
};
