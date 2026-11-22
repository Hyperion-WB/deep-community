import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, FileText, Trash2, RotateCcw, Clock, Plus, Tag } from 'lucide-react';

export interface DraftItem {
  id: string;
  title: string;
  contentMd: string;
  categoryId: number;
  postType: 'post' | 'news';
  tags: string[];
  updatedAt: string;
  charCount: number;
  source?: 'local' | 'cloud';
  /** 九宫格相册（云端草稿才带） */
  imageUrls?: string[];
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  drafts: DraftItem[];
  currentDraftId?: string | null;
  onLoadDraft: (draft: DraftItem) => void;
  onDeleteDraft: (id: string) => void;
  onClearAllDrafts: () => void;
  onUpdateCurrentDraft?: () => void;
  onSaveCurrentAsNewDraft: () => void;
  canSaveCurrent: boolean;
}

export const DraftManagerModal: React.FC<Props> = ({
  isOpen,
  onClose,
  drafts,
  currentDraftId,
  onLoadDraft,
  onDeleteDraft,
  onClearAllDrafts,
  onUpdateCurrentDraft,
  onSaveCurrentAsNewDraft,
  canSaveCurrent,
}) => {
  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div
        className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 16 }}
          transition={{ type: 'spring', stiffness: 450, damping: 32 }}
          className="w-full max-w-xl bg-wb-bg-surface border border-wb-border-strong rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
        >
          {/* 模态框头部 */}
          <div className="p-5 border-b border-wb-border-subtle flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-wb-text-primary" />
              <h3 className="font-bold text-base text-wb-text-primary">
                创作者多草稿箱工作台
              </h3>
              <span className="text-2xs px-2 py-0.5 rounded-capsule bg-wb-bg-subtle text-wb-text-muted font-mono font-semibold">
                共 {drafts.length} 篇
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-full text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 快捷操作栏 */}
          <div className="px-5 py-3 bg-wb-bg-subtle/50 border-b border-wb-border-subtle flex items-center justify-between gap-2 text-xs flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {currentDraftId && onUpdateCurrentDraft && (
                <button
                  type="button"
                  disabled={!canSaveCurrent}
                  onClick={onUpdateCurrentDraft}
                  className="wb-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-text-primary text-wb-bg-page font-semibold disabled:opacity-40 transition-opacity whitespace-nowrap shrink-0 shadow-sm"
                >
                  <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                  <span>更新覆盖当前草稿</span>
                </button>
              )}
              <button
                type="button"
                disabled={!canSaveCurrent}
                onClick={onSaveCurrentAsNewDraft}
                className={`wb-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule font-semibold disabled:opacity-40 transition-opacity whitespace-nowrap shrink-0 ${
                  currentDraftId
                    ? 'bg-wb-bg-surface border border-wb-border-subtle text-wb-text-primary hover:bg-wb-bg-subtle'
                    : 'bg-wb-text-primary text-wb-bg-page'
                }`}
              >
                <Plus className="w-3.5 h-3.5 shrink-0" />
                <span>{currentDraftId ? '另存为新草稿' : '保存当前内容为新草稿'}</span>
              </button>
            </div>
            {drafts.length > 0 && (
              <button
                type="button"
                onClick={onClearAllDrafts}
                className="text-wb-text-muted hover:text-wb-danger transition-colors text-xs whitespace-nowrap shrink-0 ml-auto"
              >
                清空全部草稿
              </button>
            )}
          </div>

          {/* 草稿列表 */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3">
            {drafts.length === 0 ? (
              <div className="py-16 text-center space-y-2 text-wb-text-muted">
                <FileText className="w-10 h-10 mx-auto stroke-1 opacity-50" />
                <p className="text-xs">暂无暂存草稿</p>
                <p className="text-2xs">您在编写时的内容将自动同步，也可手动保存多份独立草稿</p>
              </div>
            ) : (
              drafts.map((d) => (
                <div
                  key={d.id}
                  className={`p-4 rounded-2xl bg-wb-bg-elevated border shadow-sm space-y-2.5 transition-all group ${
                    d.id === currentDraftId
                      ? 'border-wb-text-primary ring-1 ring-wb-text-primary/30'
                      : 'border-wb-border-subtle hover:border-wb-border-strong'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="text-sm font-bold text-wb-text-primary truncate">
                          {d.title || '（未命名草稿）'}
                        </h4>
                        {d.id === currentDraftId && (
                          <span className="text-3xs px-2 py-0.5 rounded-capsule bg-wb-text-primary text-wb-bg-page font-semibold whitespace-nowrap">
                            当前载入编辑中
                          </span>
                        )}
                        {d.source === 'cloud' ? (
                          <span className="text-3xs px-2 py-0.5 rounded-capsule bg-wb-success/15 text-wb-success dark:text-wb-success font-semibold whitespace-nowrap">
                            云端已同步
                          </span>
                        ) : (
                          <span className="text-3xs px-2 py-0.5 rounded-capsule bg-wb-bg-subtle text-wb-text-muted font-semibold whitespace-nowrap">
                            本地暂存
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-wb-text-muted line-clamp-2 leading-relaxed font-mono">
                        {d.contentMd.slice(0, 100) || '暂无正文预览...'}
                      </p>
                    </div>
                    <span className="text-3xs px-2 py-0.5 rounded-capsule bg-wb-bg-subtle text-wb-text-secondary flex-shrink-0 font-medium whitespace-nowrap">
                      {d.postType === 'news' ? '早报专栏' : '技术交流'}
                    </span>
                  </div>

                  {d.tags && d.tags.length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap text-3xs">
                      <Tag className="w-3 h-3 text-wb-text-muted shrink-0" />
                      {d.tags.map((t) => (
                        <span
                          key={t}
                          className="px-1.5 py-0.5 rounded bg-wb-bg-subtle text-wb-text-muted font-mono whitespace-nowrap shrink-0"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="pt-2 border-t border-wb-border-subtle flex items-center justify-between text-2xs text-wb-text-muted font-mono flex-wrap gap-2">
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      <Clock className="w-3 h-3 shrink-0" />
                      <span>{d.updatedAt}</span>
                      <span>·</span>
                      <span>{d.charCount} 字符</span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onLoadDraft(d)}
                        className="wb-pressable inline-flex items-center gap-1 px-2.5 py-1 rounded-capsule bg-wb-text-primary text-wb-bg-page font-semibold hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
                      >
                        <RotateCcw className="w-3 h-3 shrink-0" />
                        <span className="whitespace-nowrap">载入编辑</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteDraft(d.id)}
                        className="p-1 rounded-lg text-wb-text-muted hover:text-wb-danger hover:bg-wb-danger/10 transition-colors"
                        title="删除该草稿"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
