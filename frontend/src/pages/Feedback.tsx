import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Lightbulb,
  Bug,
  Plus,
  CheckCircle2,
  Clock,
  AlertCircle,
  HelpCircle,
  XCircle,
  Shield,
  Trash2,
  ArrowUp,
  Sparkles,
  Search,
  Inbox,
  Flame,
  Eye,
  Edit3,
  Bold,
  Code,
  Quote,
  List,
  Link as LinkIcon,
  ImagePlus,
  RotateCcw,
  MailCheck,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { apiClient, UPLOAD_TIMEOUT } from '../api/client';
import { useDialogA11y } from '../hooks/useDialogA11y';
import { UserAvatar } from '../components/UserAvatar';
import { LevelBadge } from '../components/LevelBadge';
import { CustomDropdown, type DropdownOption } from '../components/CustomDropdown';
import { useToast } from '../components/Toast';
import { ImageLightbox } from '../components/ImageLightbox';
import { SafeImage } from '../components/SafeImage';
import { EmojiToolbarButton } from '../components/EmojiToolbarButton';
import { precompressImage, validateUploadFile } from '../utils/imageCompress';
import { useConfirm } from '../components/ConfirmModal';
import { formatEast8Date } from '../utils/format';
import type { UserProfile } from '../types';

export interface FeedbackItem {
  id: string;
  feedback_type: 'bug' | 'feature';
  title: string;
  content: string;
  status: string;
  upvotes_count: number;
  has_upvoted: boolean;
  admin_reply?: string | null;
  admin_replied_by_username?: string | null;
  admin_replied_by_nickname?: string | null;
  admin_replied_at?: string | null;
  image_url?: string | null;
  image_urls?: string[];
  user_confirm?: string;
  user_confirm_at?: string | null;
  user_note?: string | null;
  can_confirm?: boolean;
  author_id: string;
  author_username: string;
  author_nickname?: string | null;
  author_avatar?: string | null;
  author_level: number;
  created_at: string;
  updated_at: string;
  category?: string;
  is_draft?: boolean;
  withdrawn_at?: string | null;
}

interface Props {
  user: UserProfile | null;
  onRequireAuth: () => void;
  onSelectUser?: (username: string) => void;
}

const BUG_STATUS_MAP: Record<string, { label: string; color: string; icon: any }> = {
  open: { label: '待处理', color: 'bg-wb-warn/10 text-wb-warn border-wb-warn/20', icon: AlertCircle },
  investigating: { label: '排查中', color: 'bg-wb-info/10 text-wb-info border-wb-info/20', icon: Clock },
  fixed: { label: '已修复', color: 'bg-wb-success/10 text-wb-success border-wb-success/20', icon: CheckCircle2 },
  wontfix: { label: '无法复现 / 关闭', color: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20', icon: XCircle },
  completed: { label: '已完成', color: 'bg-wb-success/10 text-wb-success border-wb-success/20', icon: Sparkles },
};

const FEATURE_STATUS_MAP: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: '待评估', color: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20', icon: Clock },
  under_consideration: { label: '考虑中', color: 'bg-purple-500/10 text-purple-400 border-purple-500/20', icon: HelpCircle },
  accepted: { label: '已采纳', color: 'bg-wb-info/10 text-wb-info border-wb-info/20', icon: CheckCircle2 },
  completed: { label: '已完成', color: 'bg-wb-success/10 text-wb-success border-wb-success/20', icon: Sparkles },
  declined: { label: '暂不考虑', color: 'bg-wb-danger/10 text-wb-danger border-wb-danger/20', icon: XCircle },
};

export const Feedback: React.FC<Props> = ({ user, onRequireAuth, onSelectUser }) => {
  const toast = useToast();
  const confirm = useConfirm();
  const [feedbacks, setFeedbacks] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);

  // 筛选与排序状态
  const [activeType, setActiveType] = useState<'all' | 'feature' | 'bug'>('all');
  // 默认只看到未被结案的反馈：提新问题前先在这一档里查重，避免和管理员已结案的旧帖重复
  const [activeStatus, setActiveStatus] = useState<string>('unresolved');
  const [sortBy, setSortBy] = useState<'hot' | 'latest'>('hot');
  // v2：数据驱动子分区 / 按日期定位 / 草稿箱
  const [categories, setCategories] = useState<Record<string, string[]>>({ feature: [], bug: [] });
  const [activeCategory, setActiveCategory] = useState('all');
  const [formCategory, setFormCategory] = useState('其他');
  const [singleDate, setSingleDate] = useState('');
  const [box, setBox] = useState<'all' | 'draft' | 'sent' | 'withdrawn'>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  // 分页：此前一次只能看到最新 30 条，更早的反馈与历史处理进度实际不可达
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // 提报表单状态
  const [formOpen, setFormOpen] = useState(false);
  const [formType, setFormType] = useState<'feature' | 'bug'>('feature');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 管理员状态处理弹窗
  const [adminModalItem, setAdminModalItem] = useState<FeedbackItem | null>(null);
  const adminDialogRef = useDialogA11y(Boolean(adminModalItem), () => setAdminModalItem(null));
  const [adminSelectedStatus, setAdminSelectedStatus] = useState('');
  const [adminReplyText, setAdminReplyText] = useState('');
  const [adminReplyTab, setAdminReplyTab] = useState<'write' | 'preview'>('write');
  const [adminSubmitting, setAdminSubmitting] = useState(false);
  const adminTextareaRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  // 反馈正文的表情插入：落在光标处，和 Markdown 工具条里的表情按钮共用同一套面板
  const insertFeedbackEmoji = (text: string) => {
    const el = contentRef.current;
    if (!el) {
      setContent((prev) => prev + text);
      return;
    }
    const start = el.selectionStart ?? content.length;
    const end = el.selectionEnd ?? start;
    setContent(content.slice(0, start) + text + content.slice(end));
    setTimeout(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  };

  const insertMarkdown = (prefix: string, suffix = '') => {
    const el = adminTextareaRef.current;
    if (!el) {
      setAdminReplyText((prev) => prev + prefix + suffix);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = adminReplyText.substring(start, end);
    const replacement = prefix + (selected || '示例') + suffix;
    const nextText = adminReplyText.substring(0, start) + replacement + adminReplyText.substring(end);
    setAdminReplyText(nextText);
    setTimeout(() => {
      el.focus();
      const newCursor = start + prefix.length + (selected ? selected.length : 2);
      el.setSelectionRange(newCursor, newCursor);
    }, 0);
  };

  // 表情插入：不套用 insertMarkdown 的「示例」占位，直接落在光标处
  const insertEmojiText = (text: string) => {
    const el = adminTextareaRef.current;
    if (!el) {
      setAdminReplyText((prev) => prev + text);
      return;
    }
    const start = el.selectionStart ?? adminReplyText.length;
    const end = el.selectionEnd ?? start;
    setAdminReplyText(adminReplyText.slice(0, start) + text + adminReplyText.slice(end));
    setTimeout(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  };

  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(user?.role || '');

  const FEEDBACK_PAGE_SIZE = 20;

  useEffect(() => {
    apiClient.get('/feedbacks/categories')
      .then((res) => {
        if (res.data && typeof res.data === 'object') setCategories(res.data);
      })
      .catch(() => undefined);
  }, []);

  const fetchFeedbacks = async (pageToLoad = 1, append = false) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const params: any = {
        feedback_type: activeType,
        status: activeStatus,
        sort_by: sortBy,
        category: activeCategory,
        box,
        page: pageToLoad,
        size: FEEDBACK_PAGE_SIZE,
      };
      // 关键词交给服务端检索，才能覆盖 30 条以外的历史反馈
      if (searchTerm) params.q = searchTerm;
      if (singleDate) params.date_on = singleDate;
      const res = await apiClient.get('/feedbacks', { params });
      const data: FeedbackItem[] = Array.isArray(res.data) ? res.data : [];
      setHasMore(data.length >= FEEDBACK_PAGE_SIZE);
      setPage(pageToLoad);
      if (append) {
        setFeedbacks((prev) => {
          const seen = new Set(prev.map((f) => f.id));
          return [...prev, ...data.filter((f) => !seen.has(f.id))];
        });
      } else {
        setFeedbacks(data);
      }
    } catch {
      if (!append) {
        setFeedbacks([]);
        setHasMore(false);
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  // 筛选 / 排序 / 关键词变化：重置回第一页
  useEffect(() => {
    setPage(1);
    fetchFeedbacks(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType, activeStatus, sortBy, searchTerm, activeCategory, singleDate, box]);

  // 搜索防抖：停止输入 350ms 后再请求，避免逐字打接口
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(searchQuery.trim()), 350);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // 提交新反馈
  // 提交时附带的截图（最多 5 张）
  const FEEDBACK_IMAGE_LIMIT = 5;
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [imageUploading, setImageUploading] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  // 反馈者确认时的补充说明
  const [confirmNotes, setConfirmNotes] = useState<Record<string, string>>({});
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const uploadScreenshotFiles = async (files: File[]) => {
    const images = files.filter(f => f.type.startsWith('image/'));
    if (!images.length) return;
    for (const f of images) {
      const invalid = validateUploadFile(f);
      if (invalid) {
        toast.error(`${f.name}：${invalid}`);
        return;
      }
    }
    setImageUploading(true);
    let added = 0;
    try {
      for (const file of images) {
        const compressed = await precompressImage(file, 1600, 0.8);
        const fd = new FormData();
        fd.append('file', compressed);
        const res = await apiClient.post('/posts/upload-image', fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
          timeout: UPLOAD_TIMEOUT,
        });
        if (res.data?.url) {
          const url = res.data.url as string;
          setImageUrls(prev => {
            if (prev.length >= FEEDBACK_IMAGE_LIMIT || prev.includes(url)) return prev;
            return [...prev, url];
          });
          added += 1;
        }
      }
      if (added) toast.success(`已附上 ${added} 张截图`);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '截图上传失败');
    } finally {
      setImageUploading(false);
    }
  };

  const handlePickScreenshot = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    const room = FEEDBACK_IMAGE_LIMIT - imageUrls.length;
    if (room <= 0) { toast.warning(`最多 ${FEEDBACK_IMAGE_LIMIT} 张截图`); return; }
    if (picked.length > room) toast.info(`最多 ${FEEDBACK_IMAGE_LIMIT} 张，已自动截取前 ${room} 张`);
    if (picked.length) void uploadScreenshotFiles(picked.slice(0, room));
  };

  const handlePasteScreenshot = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const file = Array.from(e.clipboardData?.files || []).find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    if (imageUrls.length >= FEEDBACK_IMAGE_LIMIT) { toast.warning(`最多 ${FEEDBACK_IMAGE_LIMIT} 张截图`); return; }
    void uploadScreenshotFiles([file]);
  };

  // 反馈者确认：Bug 已修复 / 仍可复现，建议已收到
  const handleConfirmFeedback = async (item: FeedbackItem, confirm: 'fixed' | 'unfixed' | 'received') => {
    setConfirmingId(item.id);
    try {
      const res = await apiClient.put(`/feedbacks/${item.id}/confirm`, {
        confirm,
        note: (confirmNotes[item.id] || '').trim() || null,
      });
      setFeedbacks((prev) => prev.map((f) => (f.id === item.id ? res.data : f)));
      setConfirmNotes((prev) => {
        const copy = { ...prev };
        delete copy[item.id];
        return copy;
      });
      toast.success(
        confirm === 'fixed'
          ? '已标记为修复，谢谢你帮忙确认！'
          : confirm === 'unfixed'
          ? '已记录仍可复现，我们会继续跟进'
          : '已收到，感谢反馈'
      );
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '确认失败');
    } finally {
      setConfirmingId(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return onRequireAuth();
    if (!title.trim() || title.trim().length < 2) {
      toast.warning('标题至少需要 2 个字符');
      return;
    }
    if (!content.trim() || content.trim().length < 5) {
      toast.warning('详细描述至少需要 5 个字符');
      return;
    }

    setSubmitting(true);
    try {
      if (editingId) {
        // 先落库改动，再直接发布：已撤回 / 草稿的「立即提交」都应真正发出，
        // 而不是又存回草稿（此前只调 /draft，用户以为发了其实还在草稿箱）
        await apiClient.put(`/feedbacks/${editingId}/draft`, {
          feedback_type: formType,
          title: title.trim(),
          content: content.trim(),
          category: formCategory,
          image_url: imageUrls[0] || null,
          image_urls: imageUrls,
        });
        await apiClient.post(`/feedbacks/${editingId}/publish`);
        toast.success(
          formType === 'bug' ? 'Bug 反馈已发布，自带 +1 UP！' : '功能建议已发布，一键 UP 生效！'
        );
      } else {
        await apiClient.post('/feedbacks', {
          feedback_type: formType,
          title: title.trim(),
          content: content.trim(),
          category: formCategory,
          image_url: imageUrls[0] || null,
          image_urls: imageUrls,
          is_draft: false,
        });
        toast.success(formType === 'bug' ? 'Bug 反馈已提交，感谢排障支持！' : '功能建议已提交，一键 UP 生效！');
      }
      setTitle('');
      setContent('');
      setImageUrls([]);
      setEditingId(null);
      setFormOpen(false);
      // 重新拉取第一页：本地强插会无视当前筛选/排序条件，出现"列表与筛选矛盾"
      fetchFeedbacks(1, false);
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  // 一键 UP / 取消 UP
  const handleToggleUpvote = async (item: FeedbackItem) => {
    if (!user) return onRequireAuth();

    // 乐观更新
    const nextVoted = !item.has_upvoted;
    const nextCount = item.upvotes_count + (nextVoted ? 1 : -1);

    setFeedbacks((prev) =>
      prev.map((f) =>
        f.id === item.id ? { ...f, has_upvoted: nextVoted, upvotes_count: Math.max(0, nextCount) } : f
      )
    );

    try {
      const res = await apiClient.post(`/feedbacks/${item.id}/upvote`);
      toast.info(res.data?.message || (nextVoted ? '已顶上去 (+1 UP)' : '已取消 UP'));
    } catch (err: any) {
      // 回滚
      setFeedbacks((prev) =>
        prev.map((f) =>
          f.id === item.id ? { ...f, has_upvoted: item.has_upvoted, upvotes_count: item.upvotes_count } : f
        )
      );
      toast.error(err?.response?.data?.detail || '操作失败');
    }
  };

  // 管理员更新状态与理由
  const handleAdminUpdateStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminModalItem || !adminSelectedStatus) return;

    setAdminSubmitting(true);
    try {
      const res = await apiClient.put(`/feedbacks/${adminModalItem.id}/status`, {
        status: adminSelectedStatus,
        admin_reply: adminReplyText.trim() || null,
      });
      toast.success('状态与判定理由已公示生效！');
      setFeedbacks((prev) =>
        prev.map((f) => (f.id === adminModalItem.id ? res.data : f))
      );
      setAdminModalItem(null);
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '更新失败');
    } finally {
      setAdminSubmitting(false);
    }
  };

  // 删除反馈
  // ---- v2 草稿箱 ----
  const handleSaveDraft = async () => {
    if (!user) return onRequireAuth();
    if (!title.trim() && !content.trim()) return toast.warning('先写点内容再存草稿');
    setSubmitting(true);
    try {
      if (editingId) {
        await apiClient.put(`/feedbacks/${editingId}/draft`, {
          feedback_type: formType, title: title.trim() || '未命名草稿',
          content: content.trim() || '（待补充）', category: formCategory,
          image_url: imageUrls[0] || null,
          image_urls: imageUrls,
        });
      } else {
        await apiClient.post('/feedbacks', {
          feedback_type: formType, title: title.trim() || '未命名草稿',
          content: content.trim() || '（待补充）', category: formCategory,
          image_url: imageUrls[0] || null, image_urls: imageUrls, is_draft: true,
        });
      }
      toast.success('已存入草稿箱');
      setTitle(''); setContent(''); setImageUrls([]); setEditingId(null); setFormOpen(false);
      if (box === 'draft') fetchFeedbacks(1, false);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '保存失败');
    } finally { setSubmitting(false); }
  };

  const handlePublish = async (item: FeedbackItem) => {
    try {
      await apiClient.post(`/feedbacks/${item.id}/publish`);
      toast.success('已发布');
      fetchFeedbacks(1, false);
    } catch (err: any) { toast.error(err?.response?.data?.detail || '发布失败'); }
  };

  const handleWithdraw = async (item: FeedbackItem) => {
    const ok = await confirm({ title: '撤回反馈', description: '撤回后可在草稿箱里修改再重新发布。', confirmText: '确认撤回' });
    if (!ok) return;
    try {
      await apiClient.post(`/feedbacks/${item.id}/withdraw`);
      toast.success('已撤回，可在草稿箱修改');
      fetchFeedbacks(1, false);
    } catch (err: any) { toast.error(err?.response?.data?.detail || '撤回失败'); }
  };

  const handleEditDraft = (item: FeedbackItem) => {
    setEditingId(item.id);
    setFormType(item.feedback_type);
    setTitle(item.title);
    setContent(item.content);
    setFormCategory(item.category || '其他');
    setImageUrls(item.image_urls?.length ? item.image_urls.slice(0, FEEDBACK_IMAGE_LIMIT)
      : item.image_url ? [item.image_url] : []);
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDelete = async (item: FeedbackItem) => {
    const ok = await confirm({
      title: '删除反馈',
      description: '确定要删除这条反馈记录吗？此操作不可撤销。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/feedbacks/${item.id}`);
      toast.success('反馈已删除');
      setFeedbacks((prev) => prev.filter((f) => f.id !== item.id));
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '删除失败');
    }
  };

  // 列表已由服务端按关键词过滤，这里不再做二次过滤，避免正文命中被前端丢弃
  const displayedList = feedbacks;

  // 状态筛选选项 (统一遵循黑白钛金视觉语言的 CustomDropdown)
  const statusDropdownOptions: DropdownOption[] = [
    { value: 'all', label: '所有状态' },
    // 「未完成」跨类型通用：只要管理员还没给出结案结论（未修复 / 未完成 / 未关闭 / 未拒绝）都算，
    // 提新问题前在这一档里查有没有同款即可
    { value: 'unresolved', label: '未完成 · 待跟进' },
    // 「已完成」作为跨类型的通用筛选，任何 tab 下都能查
    ...(activeType === 'all'
      ? [{ value: 'completed', label: '已完成' }]
      : Object.entries(activeType === 'feature' ? FEATURE_STATUS_MAP : BUG_STATUS_MAP).map(([k, v]) => ({
          value: k,
          label: v.label,
        }))),
  ];

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      {/* 顶部标语与快速唤起 */}
      <div className="p-6 md:p-8 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="space-y-2 max-w-xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-xs font-semibold text-wb-text-primary">
            <Sparkles className="w-3.5 h-3.5" />
            <span>社区反馈中心 · 公开建议与问题排查</span>
          </div>
          <h1 className="text-xl md:text-2xl font-bold text-wb-text-primary tracking-tight">
            需求公开公示与 Bug 追踪中心
          </h1>
          <p className="text-xs text-wb-text-muted leading-relaxed">
            极简直观，真实透明。为心仪的功能一键 UP 顶上热度，管理团队实时跟进排查、公示采纳理由与修复进度。
          </p>
        </div>

        <button
          onClick={() => {
            if (!user) return onRequireAuth();
            setFormOpen((prev) => !prev);
          }}
          className="wb-pressable w-full sm:w-auto shrink-0 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm hover:opacity-90 transition-opacity"
        >
          <Plus className={`w-4 h-4 transition-transform duration-200 ${formOpen ? 'rotate-45' : ''}`} />
          <span>{formOpen ? '收起面板' : '我要反馈 / 提建议'}</span>
        </button>
      </div>

      {/* 快速提报表单 (极简直观，绝不繁琐) */}
      {formOpen && (
        <form
          onSubmit={handleSubmit}
          className="p-5 md:p-8 rounded-3xl bg-wb-bg-surface border border-wb-border-strong shadow-card space-y-5 animate-in fade-in duration-200"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-wb-border-subtle pb-4">
            <h3 className="font-bold text-sm text-wb-text-primary flex items-center gap-2">
              <span>提报新事项</span>
              <span className="text-2xs text-wb-text-muted font-normal">(极简快捷，无需复杂排版)</span>
            </h3>
            {/* 反馈类型切换 */}
            <div className="inline-flex items-center p-1 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle gap-1 self-start sm:self-auto">
              <button
                type="button"
                onClick={() => {
                  setFormType('feature');
                  const list = categories.feature || [];
                  if (list.length && !list.includes(formCategory)) setFormCategory(list[0]);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-capsule text-xs font-semibold transition-all ${
                  formType === 'feature'
                    ? 'bg-wb-text-primary text-wb-bg-page shadow-sm'
                    : 'text-wb-text-muted hover:text-wb-text-primary'
                }`}
              >
                <Lightbulb className="w-3.5 h-3.5" />
                <span>功能建议</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setFormType('bug');
                  const list = categories.bug || [];
                  if (list.length && !list.includes(formCategory)) setFormCategory(list[0]);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-capsule text-xs font-semibold transition-all ${
                  formType === 'bug'
                    ? 'bg-wb-text-primary text-wb-bg-page shadow-sm'
                    : 'text-wb-text-muted hover:text-wb-text-primary'
                }`}
              >
                <Bug className="w-3.5 h-3.5" />
                <span>Bug 缺陷</span>
              </button>
            </div>
          </div>

          {editingId && (
            <div className="flex items-start gap-2 p-2.5 rounded-xl bg-wb-info/10 border border-wb-info/25">
              <span className="text-2xs font-semibold text-wb-info shrink-0">正在编辑</span>
              <p className="text-3xs text-wb-text-secondary leading-relaxed">
                修改后点「立即发布」会直接发出去（自带 +1 UP）；点「存草稿」才会继续留在草稿箱。
              </p>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="flex items-center gap-1.5 text-xs font-semibold text-wb-text-secondary mb-1.5">
                {formType === 'feature' ? (
                  <>
                    <Lightbulb className="w-3.5 h-3.5 text-wb-warn" />
                    <span>建议功能标题</span>
                  </>
                ) : (
                  <>
                    <Bug className="w-3.5 h-3.5 text-wb-danger" />
                    <span>遇到的问题描述</span>
                  </>
                )}
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={
                  formType === 'feature'
                    ? '例：希望在个人中心增加“最近阅读历史”与快捷入口'
                    : '例：移动端在深色模式下某些评论展开按钮字迹发灰看不清'
                }
                className="w-full px-4 py-2.5 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle text-xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong font-medium"
                maxLength={200}
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-wb-text-secondary mb-1.5">
                详细补充说明 (复现路径或价值诉求)
              </label>
              <textarea
                ref={contentRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onPaste={handlePasteScreenshot}
                placeholder={
                  formType === 'feature'
                    ? '说明该功能的应用场景，为什么能帮到大家？'
                    : '描述发生页面、所用设备/浏览器，以及出现的异常表现...'
                }
                rows={4}
                className="w-full px-4 py-2.5 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle text-xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong resize-y"
                maxLength={5000}
                required
              />
            </div>

            {/* 截图：去掉占地方的大上传卡片，保留粘贴 + 小上传按钮两种方式 */}
            <div className="flex items-center gap-2 flex-wrap">
              <label className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-capsule border border-wb-border-subtle bg-wb-bg-surface text-2xs text-wb-text-secondary hover:text-wb-text-primary hover:border-wb-border-strong cursor-pointer transition-colors">
                {imageUploading ? (
                  <span className="w-3 h-3 border-2 border-wb-text-muted border-t-transparent rounded-full animate-spin" />
                ) : (
                  <ImagePlus className="w-3.5 h-3.5" />
                )}
                {imageUploading ? '上传中' : '上传截图'}
                <input type="file" accept="image/*" multiple className="hidden" onChange={handlePickScreenshot} />
              </label>
              <EmojiToolbarButton
                onInsert={insertFeedbackEmoji}
                label="表情"
                title="插入表情"
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-capsule border border-wb-border-subtle bg-wb-bg-surface text-2xs text-wb-text-secondary hover:text-wb-text-primary hover:border-wb-border-strong transition-colors"
              />
              <span className="text-3xs text-wb-text-muted">最多 {FEEDBACK_IMAGE_LIMIT} 张，可多选 / Ctrl+V 粘贴</span>
              <span className="text-3xs font-mono text-wb-text-muted ml-auto">{imageUrls.length}/{FEEDBACK_IMAGE_LIMIT}</span>
              {imageUrls.length > 0 && (
                <div className="w-full flex flex-wrap gap-1.5">
                  {imageUrls.map((u, i) => (
                    <div key={u + i} className="relative w-12 h-12 rounded-lg overflow-hidden border border-wb-border-subtle group">
                      <button type="button" onClick={() => setPreviewImage(u)} aria-label={`预览第 ${i + 1} 张截图`} className="w-full h-full">
                        <SafeImage src={u} alt={`反馈截图 ${i + 1}`} className="w-full h-full object-cover" />
                      </button>
                      <button type="button" onClick={() => setImageUrls(prev => prev.filter((_, j) => j !== i))}
                        aria-label={`移除第 ${i + 1} 张截图`}
                        className="absolute top-0 right-0 w-4 h-4 rounded-bl-lg bg-black/65 text-white text-3xs leading-4 text-center opacity-0 group-hover:opacity-100 transition-opacity">×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="pt-1 space-y-1.5">
            <span className="text-2xs text-wb-text-muted font-semibold">子分区</span>
            {/* 并行选择：所有分区平铺成一行，点一下就切换，不再藏在下拉里 */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {(categories[formType]?.length ? categories[formType] : ['其他']).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setFormCategory(c)}
                  aria-pressed={formCategory === c}
                  className={`h-7 px-3 rounded-capsule text-2xs border transition-colors ${
                    formCategory === c
                      ? 'bg-wb-text-primary text-wb-bg-page border-transparent font-semibold shadow-sm'
                      : 'bg-wb-bg-surface border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary hover:border-wb-border-strong'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2">
            <span className="text-2xs text-wb-text-muted font-mono text-center sm:text-left">
              ✓ 提交后自动自带您的 +1 UP 支持票数
            </span>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => void handleSaveDraft()}
                disabled={submitting}
                className="flex-1 sm:flex-initial px-4 py-2 rounded-capsule border border-wb-border-subtle text-xs text-wb-text-secondary hover:text-wb-text-primary disabled:opacity-50 text-center"
              >
                存草稿
              </button>
              <button
                type="button"
                onClick={() => { setFormOpen(false); setEditingId(null); }}
                className="flex-1 sm:flex-initial px-4 py-2 rounded-capsule border border-wb-border-subtle text-xs text-wb-text-secondary hover:text-wb-text-primary text-center"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="wb-pressable flex-1 sm:flex-initial px-6 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm hover:opacity-90 disabled:opacity-50 text-center"
              >
                {submitting ? '提交中...' : (editingId ? '立即发布' : '立即提交 (+5 经验)')}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* 筛选与排序控制条 (全端响应式防挤压，统一采用 CustomDropdown) */}
      <div className="space-y-3">
        <div className="flex flex-col items-stretch gap-3">
          {/* 类型切换 (独占一行，避免被右侧控件压成竖排文字) */}
          <div className="relative flex items-center p-1 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle shadow-card gap-1 w-full shrink-0">
            <button
              type="button"
              onClick={() => {
                setActiveType('all');
                setActiveStatus('all');
              }}
              className={`relative z-10 flex-1 md:flex-initial px-3 py-1.5 rounded-capsule text-xs font-semibold text-center whitespace-nowrap shrink-0 transition-colors duration-200 select-none ${
                activeType === 'all'
                  ? 'text-wb-bg-page'
                  : 'text-wb-text-secondary hover:text-wb-text-primary'
              }`}
            >
              {activeType === 'all' && (
                <motion.div
                  layoutId="feedback-type-pill"
                  transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                  className="absolute inset-0 bg-wb-text-primary rounded-capsule shadow-sm -z-10"
                />
              )}
              <span>全部</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveType('feature');
                setActiveStatus('all');
              }}
              className={`relative z-10 flex-1 md:flex-initial inline-flex items-center justify-center gap-1 px-3 py-1.5 whitespace-nowrap shrink-0 rounded-capsule text-xs font-semibold transition-colors duration-200 select-none ${
                activeType === 'feature'
                  ? 'text-wb-bg-page'
                  : 'text-wb-text-secondary hover:text-wb-text-primary'
              }`}
            >
              {activeType === 'feature' && (
                <motion.div
                  layoutId="feedback-type-pill"
                  transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                  className="absolute inset-0 bg-wb-text-primary rounded-capsule shadow-sm -z-10"
                />
              )}
              <Lightbulb className="w-3.5 h-3.5" />
              <span>功能建议</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveType('bug');
                setActiveStatus('all');
              }}
              className={`relative z-10 flex-1 md:flex-initial inline-flex items-center justify-center gap-1 px-3 py-1.5 whitespace-nowrap shrink-0 rounded-capsule text-xs font-semibold transition-colors duration-200 select-none ${
                activeType === 'bug'
                  ? 'text-wb-bg-page'
                  : 'text-wb-text-secondary hover:text-wb-text-primary'
              }`}
            >
              {activeType === 'bug' && (
                <motion.div
                  layoutId="feedback-type-pill"
                  transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                  className="absolute inset-0 bg-wb-text-primary rounded-capsule shadow-sm -z-10"
                />
              )}
              <Bug className="w-3.5 h-3.5" />
              <span>Bug 排查</span>
            </button>
          </div>

          {/* 第二行：子分区 / 单日 / 草稿箱，全部使用主题化控件 */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xs font-semibold text-wb-text-muted shrink-0">子分区</span>
            <CustomDropdown
              size="sm"
              value={activeCategory}
              onChange={(val) => setActiveCategory(val)}
              options={[
                { value: 'all', label: '全部分区' },
                ...(activeType === 'all'
                  ? [...new Set([...(categories.feature || []), ...(categories.bug || [])])]
                  : (categories[activeType] || [])
                ).map((c) => ({ value: c, label: c })),
              ]}
              className="min-w-[110px]"
            />
            <span className="text-2xs font-semibold text-wb-text-muted shrink-0 ml-1">日期</span>
            <input
              type="date"
              value={singleDate}
              onChange={(e) => setSingleDate(e.target.value)}
              aria-label="按日期筛选反馈"
              style={{ colorScheme: 'light dark' }}
              className="h-8 px-2.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-2xs text-wb-text-primary focus:outline-none focus:border-wb-brand transition-colors"
            />
            {singleDate && (
              <button type="button" onClick={() => setSingleDate('')} className="text-2xs text-wb-text-muted hover:text-wb-text-primary">清除</button>
            )}
            <button
              type="button"
              onClick={() => { if (!user) return onRequireAuth(); setBox(box === 'all' ? 'draft' : 'all'); }}
              className={`ml-auto h-8 px-3 rounded-capsule border text-2xs font-semibold shrink-0 ${box !== 'all' ? 'bg-wb-text-primary text-wb-bg-page border-transparent' : 'bg-wb-bg-surface text-wb-text-secondary border-wb-border-subtle hover:text-wb-text-primary'}`}
            >
              {box === 'all' ? '我的草稿箱' : '返回全部反馈'}
            </button>
          </div>

          {box !== 'all' && (
            <div className="flex items-center gap-1.5 pb-1">
              {([['draft', '草稿'], ['sent', '发出'], ['withdrawn', '已撤回']] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setBox(k)}
                  className={`px-2.5 py-1 rounded-capsule text-2xs font-semibold ${box === k ? 'bg-wb-text-primary text-wb-bg-page' : 'bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary'}`}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* 状态下拉框 + 搜索框 + 排序按钮 (移动端自适应流式排版，绝无挤压) */}
          <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 w-full">
            {/* 状态筛选器 (全局主题风格 CustomDropdown) */}
            {(
              <div className="shrink-0">
                <CustomDropdown
                  size="sm"
                  value={activeStatus}
                  onChange={(val) => setActiveStatus(val)}
                  options={statusDropdownOptions}
                  className="min-w-[110px]"
                />
              </div>
            )}

            {/* 搜索框 */}
            <div className="relative flex-1 sm:w-44 min-w-[120px]">
              <Search className="w-3.5 h-3.5 text-wb-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索反馈 / 理由..."
                className="w-full h-8 pl-8 pr-3 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong font-medium placeholder:text-wb-text-muted"
              />
            </div>

            {/* 排序按钮 (带全局统一弹簧滑动动效) */}
            <div className="relative inline-flex items-center p-0.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle shrink-0 ml-auto sm:ml-0">
              <button
                type="button"
                onClick={() => setSortBy('hot')}
                className={`relative z-10 inline-flex items-center gap-1 px-2.5 sm:px-3 py-1 rounded-capsule text-xs font-semibold transition-colors duration-200 select-none ${
                  sortBy === 'hot'
                    ? 'text-wb-bg-page'
                    : 'text-wb-text-muted hover:text-wb-text-primary'
                }`}
              >
                {sortBy === 'hot' && (
                  <motion.div
                    layoutId="feedback-sort-pill"
                    transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                    className="absolute inset-0 bg-wb-text-primary rounded-capsule shadow-sm -z-10"
                  />
                )}
                <Flame className="w-3.5 h-3.5 text-wb-warn" />
                <span>最热 UP</span>
              </button>
              <button
                type="button"
                onClick={() => setSortBy('latest')}
                className={`relative z-10 px-2.5 sm:px-3 py-1 rounded-capsule text-xs font-semibold transition-colors duration-200 select-none ${
                  sortBy === 'latest'
                    ? 'text-wb-bg-page'
                    : 'text-wb-text-muted hover:text-wb-text-primary'
                }`}
              >
                {sortBy === 'latest' && (
                  <motion.div
                    layoutId="feedback-sort-pill"
                    transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                    className="absolute inset-0 bg-wb-text-primary rounded-capsule shadow-sm -z-10"
                  />
                )}
                <span>最新提交</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 反馈列表 */}
      {loading ? (
        <div className="py-24 text-center space-y-3">
          <div className="w-6 h-6 border-2 border-wb-text-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs text-wb-text-muted font-mono">拉取全站真实反馈中...</p>
        </div>
      ) : displayedList.length === 0 ? (
        <div className="p-12 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle text-center space-y-3 shadow-card">
          <div className="w-12 h-12 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle flex items-center justify-center mx-auto text-wb-text-muted">
            <Inbox className="w-6 h-6" />
          </div>
          <h3 className="font-bold text-sm text-wb-text-primary">
            {searchTerm
              ? '没有匹配的反馈'
              : activeStatus !== 'all'
              ? '当前筛选下暂无反馈'
              : activeType === 'bug'
              ? '暂无待排查的 Bug 缺陷'
              : '暂无功能建议'}
          </h3>
          <p className="text-xs text-wb-text-muted max-w-sm mx-auto">
            {searchTerm
              ? `没有找到包含「${searchTerm}」的反馈，换个关键词试试。`
              : activeStatus === 'unresolved'
              ? '所有反馈都已有结论，有新问题可以直接提交。'
              : activeStatus !== 'all'
              ? '换个状态筛选看看，或者提交一条新的反馈。'
              : '系统当前运行健康纯净，欢迎点击上方按钮提出你对社区的第一个极客建议！'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {displayedList.map((item) => {
            const statusConfig =
              item.feedback_type === 'bug'
                ? BUG_STATUS_MAP[item.status] || BUG_STATUS_MAP.open
                : FEATURE_STATUS_MAP[item.status] || FEATURE_STATUS_MAP.pending;
            const StatusIcon = statusConfig.icon;

            return (
              <div
                key={item.id}
                className="p-4 sm:p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card hover:border-wb-border-strong transition-all flex items-start gap-3 sm:gap-4"
              >
                {/* 左侧：一键 UP 胶囊按钮 (移动端与桌面端均保持侧边对齐，绝不换行断裂) */}
                <button
                  type="button"
                  onClick={() => handleToggleUpvote(item)}
                  title={item.has_upvoted ? '取消 UP' : '顶上去让管理员看到'}
                  className={`wb-pressable flex flex-col items-center justify-center w-11 sm:w-14 py-2 rounded-2xl border transition-all shrink-0 ${
                    item.has_upvoted
                      ? 'bg-wb-text-primary text-wb-bg-page border-transparent shadow-sm font-bold'
                      : 'bg-wb-bg-subtle text-wb-text-secondary border-wb-border-subtle hover:border-wb-border-strong hover:text-wb-text-primary'
                  }`}
                >
                  <ArrowUp className={`w-3.5 sm:w-4 h-3.5 sm:h-4 mb-0.5 ${item.has_upvoted ? 'stroke-[2.5]' : ''}`} />
                  <span className="font-mono text-xs font-bold leading-tight">{item.upvotes_count}</span>
                  <span className="text-3xs scale-90 opacity-75 leading-tight">UP</span>
                </button>

                {/* 中间核心内容 */}
                <div className="flex-1 min-w-0 space-y-2.5">
                  {/* 顶栏徽标 */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-capsule text-2xs font-semibold border ${
                        item.feedback_type === 'bug'
                          ? 'bg-wb-danger/10 text-wb-danger border-wb-danger/20'
                          : 'bg-wb-info/10 text-wb-info border-wb-info/20'
                      }`}
                    >
                      {item.feedback_type === 'bug' ? (
                        <>
                          <Bug className="w-3 h-3" />
                          <span>Bug 缺陷</span>
                        </>
                      ) : (
                        <>
                          <Lightbulb className="w-3 h-3" />
                          <span>功能建议</span>
                        </>
                      )}
                    </span>

                    {/* 状态徽标 */}
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-capsule text-2xs font-semibold border ${statusConfig.color}`}
                    >
                      <StatusIcon className="w-3 h-3" />
                      <span>{statusConfig.label}</span>
                    </span>

                    <span className="text-2xs sm:text-xs text-wb-text-muted font-mono ml-auto">
                      {formatEast8Date(item.created_at)}
                    </span>
                  </div>

                  {/* 标题 */}
                  <h2 className="font-bold text-sm md:text-base text-wb-text-primary leading-snug break-words">
                    {item.title}
                  </h2>

                  {/* 内容描述 */}
                  <p className="text-xs text-wb-text-secondary leading-relaxed whitespace-pre-wrap break-words">
                    {item.content}
                  </p>

                  {/* 提交时附带的截图：点开可查看大图 */}
                  {(() => {
                    const imgs = item.image_urls?.length ? item.image_urls : item.image_url ? [item.image_url] : [];
                    if (!imgs.length) return null;
                    return (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {imgs.map((u, i) => (
                          <button key={u + i} type="button" onClick={() => setPreviewImage(u)}
                            className="block w-20 h-20 sm:w-24 sm:h-24 rounded-2xl overflow-hidden border border-wb-border-subtle group relative"
                            title={`查看截图 ${i + 1}/${imgs.length}`}>
                            <SafeImage src={u} alt={`反馈截图 ${i + 1}`}
                              className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
                          </button>
                        ))}
                      </div>
                    );
                  })()}

                  {/* 官方管理员判定与说明理由 */}
                  {item.admin_reply && (
                    <div className="p-3 sm:p-3.5 rounded-2xl bg-wb-bg-subtle/80 border border-wb-border-subtle space-y-2 mt-2">
                      <div className="flex items-center gap-2 text-xs font-semibold text-wb-text-primary flex-wrap">
                        <Shield className="w-3.5 h-3.5 text-wb-success shrink-0" />
                        <span className="truncate">
                          管理员 @{item.admin_replied_by_username || '社区团队'} 官方说明：
                        </span>
                        <span className="text-3xs text-wb-text-muted font-mono font-normal ml-auto">
                          {item.admin_replied_at && formatEast8Date(item.admin_replied_at)}
                        </span>
                      </div>
                      <div className="text-xs text-wb-text-secondary leading-relaxed pl-2 sm:pl-5 font-sans break-words">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkBreaks]}
                          components={{
                            a: ({ node, ...props }) => (
                              <a {...props} target="_blank" rel="noopener noreferrer" className="text-wb-info hover:underline" />
                            ),
                            code: ({ className, children, ...props }: any) => {
                              return (!className?.includes('language-') && !String(children).includes('\n')) ? (
                                <code className="px-1 py-0.5 rounded bg-wb-bg-surface border border-wb-border-subtle font-mono text-2xs text-wb-warn" {...props}>
                                  {children}
                                </code>
                              ) : (
                                <pre className="p-2.5 rounded-xl bg-wb-bg-surface border border-wb-border-subtle font-mono text-2xs overflow-x-auto text-wb-text-primary my-1.5" {...props}>
                                  <code>{children}</code>
                                </pre>
                              );
                            },
                            ul: ({ ...props }) => <ul className="list-disc pl-4 space-y-0.5 my-1" {...props} />,
                            ol: ({ ...props }) => <ol className="list-decimal pl-4 space-y-0.5 my-1" {...props} />,
                            blockquote: ({ ...props }) => <blockquote className="border-l-2 border-wb-success pl-2 text-wb-text-secondary italic my-1" {...props} />,
                            h1: ({ ...props }) => <h1 className="text-sm font-bold text-wb-text-primary my-1" {...props} />,
                            h2: ({ ...props }) => <h2 className="text-xs font-bold text-wb-text-primary my-1" {...props} />,
                            h3: ({ ...props }) => <h3 className="text-xs font-semibold text-wb-text-primary my-1" {...props} />,
                            p: ({ ...props }) => <p className="leading-relaxed my-0.5 break-words" {...props} />
                          }}
                        >
                          {item.admin_reply}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}

                  {/* 反馈者确认：Bug 已修复 / 仍可复现；建议已收到。
                      确认后管理员在列表里能直接看到结论，形成闭环。 */}
                  {(item.can_confirm || item.user_confirm) && (
                    <div className="mt-2 p-3 rounded-2xl border border-dashed border-wb-border-strong bg-wb-bg-subtle/45 space-y-2">
                      {item.can_confirm ? (
                        <>
                          <p className="text-2xs text-wb-text-muted">
                            {item.feedback_type === 'bug'
                              ? '这个问题现在还在吗？确认一下，方便我们收尾'
                              : '看到这条回复了吗？点一下告诉我们'}
                          </p>
                          <textarea
                            value={confirmNotes[item.id] || ''}
                            onChange={(e) =>
                              setConfirmNotes((prev) => ({ ...prev, [item.id]: e.target.value }))
                            }
                            rows={2}
                            maxLength={500}
                            placeholder="补充说明（选填）：仍然复现的话，可以写一下新的复现步骤"
                            className="w-full px-3 py-2 rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-2xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong resize-y"
                          />
                          <div className="flex items-center gap-2 flex-wrap">
                            {item.feedback_type === 'bug' ? (
                              <>
                                <button
                                  type="button"
                                  disabled={confirmingId === item.id}
                                  onClick={() => handleConfirmFeedback(item, 'fixed')}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-capsule bg-wb-success/15 text-wb-success border border-wb-success/35 text-2xs font-semibold hover:bg-wb-success/25 transition-colors disabled:opacity-50"
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  已修复
                                </button>
                                <button
                                  type="button"
                                  disabled={confirmingId === item.id}
                                  onClick={() => handleConfirmFeedback(item, 'unfixed')}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-capsule bg-wb-warn/15 text-wb-warn border border-wb-warn/35 text-2xs font-semibold hover:bg-wb-warn/25 transition-colors disabled:opacity-50"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                  还能复现
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                disabled={confirmingId === item.id}
                                onClick={() => handleConfirmFeedback(item, 'received')}
                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-capsule bg-wb-info/15 text-wb-info border border-wb-info/35 text-2xs font-semibold hover:bg-wb-info/25 transition-colors disabled:opacity-50"
                              >
                                <MailCheck className="w-3.5 h-3.5" />
                                已收到
                              </button>
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="flex items-start gap-1.5 flex-wrap">
                          <span
                            className={`inline-flex items-center gap-1 text-2xs font-semibold px-2 py-0.5 rounded-capsule border ${
                              item.user_confirm === 'unfixed'
                                ? 'bg-wb-warn/15 text-wb-warn border-wb-warn/35'
                                : 'bg-wb-success/15 text-wb-success border-wb-success/35'
                            }`}
                          >
                            {item.user_confirm === 'fixed' ? (
                              <>
                                <CheckCircle2 className="w-3 h-3" /> 提交者确认：已修复
                              </>
                            ) : item.user_confirm === 'unfixed' ? (
                              <>
                                <RotateCcw className="w-3 h-3" /> 提交者反馈：仍可复现
                              </>
                            ) : (
                              <>
                                <MailCheck className="w-3 h-3" /> 提交者确认：已收到
                              </>
                            )}
                          </span>
                          {item.user_note && (
                            <span className="text-2xs text-wb-text-secondary break-words">
                              {item.user_note}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 底栏作者信息与管理操作 (防止移动端重叠挤压) */}
                  <div className="pt-2 border-t border-wb-border-subtle flex items-center justify-between gap-2 flex-wrap">
                    <div
                      onClick={() => onSelectUser?.(item.author_username)}
                      className="flex items-center gap-1.5 sm:gap-2 cursor-pointer group min-w-0"
                    >
                      <UserAvatar
                        username={item.author_username}
                        avatarUrl={item.author_avatar}
                        size={20}
                      />
                      <span className="text-xs text-wb-text-secondary group-hover:text-wb-text-primary group-hover:underline truncate max-w-[100px] sm:max-w-none">
                        {item.author_nickname || item.author_username}
                      </span>
                      <LevelBadge level={item.author_level} />
                    </div>

                    <div className="flex items-center gap-1.5 sm:gap-2 ml-auto shrink-0">
                      {/* 热度等级：最热排序下直接体现开发优先级 */}
                      {item.upvotes_count >= 10 && (
                        <span className="text-3xs font-semibold text-wb-danger bg-wb-danger/10 border border-wb-danger/20 px-1.5 py-0.5 rounded-md">高优先级</span>
                      )}
                      {item.upvotes_count >= 5 && item.upvotes_count < 10 && (
                        <span className="text-3xs font-semibold text-wb-warn bg-wb-warn/10 border border-wb-warn/20 px-1.5 py-0.5 rounded-md">受关注</span>
                      )}
                      {box !== 'all' && (() => {
                        const ops = [];
                        if (box === 'draft') ops.push(<button key="pub" type="button" onClick={() => void handlePublish(item)} className="text-2xs px-2 py-1 rounded-capsule bg-wb-success/10 text-wb-success">发布</button>);
                        if (box === 'withdrawn') ops.push(<button key="rep" type="button" onClick={() => void handlePublish(item)} className="text-2xs px-2 py-1 rounded-capsule bg-wb-success/10 text-wb-success">重新发出</button>);
                        if (box === 'sent') ops.push(<button key="wd" type="button" onClick={() => void handleWithdraw(item)} className="text-2xs px-2 py-1 rounded-capsule bg-wb-warn/10 text-wb-warn">撤回</button>);
                        if (box !== 'sent') ops.push(<button key="edit" type="button" onClick={() => handleEditDraft(item)} className="text-2xs px-2 py-1 rounded-capsule bg-wb-bg-subtle text-wb-text-secondary">编辑</button>);
                        return ops;
                      })()}
                      {/* 管理员状态变更按钮 */}
                      {isAdmin && (
                        <button
                          type="button"
                          onClick={() => {
                            setAdminModalItem(item);
                            setAdminSelectedStatus(item.status);
                            setAdminReplyText(item.admin_reply || '');
                            setAdminReplyTab('write');
                          }}
                          className="wb-pressable inline-flex items-center gap-1 px-2.5 sm:px-3 py-1 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-semibold text-wb-text-primary hover:border-wb-border-strong shadow-sm whitespace-nowrap"
                        >
                          <Shield className="w-3 h-3 text-wb-info" />
                          <span>处理状态</span>
                        </button>
                      )}

                      {/* 作者本人或管理员删除 */}
                      {(isAdmin || user?.id === item.author_id) && (
                        <button
                          type="button"
                          onClick={() => handleDelete(item)}
                          className="p-1 rounded-lg text-wb-text-muted hover:text-wb-danger transition-colors shrink-0"
                          title="删除此反馈"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 分页：加载更早的反馈（服务端 page/size） */}
      {!loading && displayedList.length > 0 && hasMore && (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={() => fetchFeedbacks(page + 1, true)}
            disabled={loadingMore}
            className="wb-pressable px-4 py-2 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-xs font-semibold text-wb-text-secondary hover:text-wb-text-primary hover:border-wb-border-strong disabled:opacity-50"
          >
            {loadingMore ? '加载中...' : '加载更多历史反馈'}
          </button>
        </div>
      )}
      {!loading && displayedList.length > 0 && !hasMore && (
        <p className="text-center text-2xs text-wb-text-muted font-mono pb-2">已展示全部反馈</p>
      )}

      <ImageLightbox src={previewImage} onClose={() => setPreviewImage(null)} />

      {/* 管理员状态判定与附言弹窗 */}
      {adminModalItem && (
        <div
          ref={adminDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="管理员处理反馈"
          className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
        >
          <form
            onSubmit={handleAdminUpdateStatus}
            className="w-full max-w-lg p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-strong shadow-2xl space-y-5"
          >
            <div className="flex items-center justify-between border-b border-wb-border-subtle pb-3">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-wb-info" />
                <h3 className="font-bold text-sm text-wb-text-primary">
                  管理员处理：{adminModalItem.feedback_type === 'bug' ? 'Bug 状态' : '功能建议状态'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setAdminModalItem(null)}
                className="text-wb-text-muted hover:text-wb-text-primary text-xs"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-wb-text-secondary mb-1">
                  变更目标状态
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {adminModalItem.feedback_type === 'bug'
                    ? Object.entries(BUG_STATUS_MAP).map(([k, v]) => (
                        <button
                          type="button"
                          key={k}
                          onClick={() => setAdminSelectedStatus(k)}
                          className={`p-2.5 rounded-xl border text-xs font-semibold flex items-center gap-2 transition-all ${
                            adminSelectedStatus === k
                              ? 'border-wb-text-primary bg-wb-text-primary text-wb-bg-page shadow-sm'
                              : 'border-wb-border-subtle bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary'
                          }`}
                        >
                          <v.icon className="w-3.5 h-3.5" />
                          <span>{v.label}</span>
                        </button>
                      ))
                    : Object.entries(FEATURE_STATUS_MAP).map(([k, v]) => (
                        <button
                          type="button"
                          key={k}
                          onClick={() => setAdminSelectedStatus(k)}
                          className={`p-2.5 rounded-xl border text-xs font-semibold flex items-center gap-2 transition-all ${
                            adminSelectedStatus === k
                              ? 'border-wb-text-primary bg-wb-text-primary text-wb-bg-page shadow-sm'
                              : 'border-wb-border-subtle bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary'
                          }`}
                        >
                          <v.icon className="w-3.5 h-3.5" />
                          <span>{v.label}</span>
                        </button>
                      ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <label className="block text-xs font-semibold text-wb-text-secondary">
                    说明理由 / 进度公布 (面向全站公开展示)
                  </label>
                  {/* Tab 切换：编辑 / 实时预览 */}
                  <div className="flex items-center gap-1 bg-wb-bg-subtle p-0.5 rounded-xl border border-wb-border-subtle text-2xs">
                    <button
                      type="button"
                      onClick={() => setAdminReplyTab('write')}
                      className={`px-2.5 py-1 rounded-lg font-medium flex items-center gap-1 transition-all ${
                        adminReplyTab === 'write'
                          ? 'bg-wb-bg-surface text-wb-text-primary shadow-xs'
                          : 'text-wb-text-muted hover:text-wb-text-primary'
                      }`}
                    >
                      <Edit3 className="w-3 h-3" />
                      <span>编辑 (Markdown)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setAdminReplyTab('preview')}
                      className={`px-2.5 py-1 rounded-lg font-medium flex items-center gap-1 transition-all ${
                        adminReplyTab === 'preview'
                          ? 'bg-wb-bg-surface text-wb-text-primary shadow-xs'
                          : 'text-wb-text-muted hover:text-wb-text-primary'
                      }`}
                    >
                      <Eye className="w-3 h-3" />
                      <span>实时预览</span>
                    </button>
                  </div>
                </div>

                {adminReplyTab === 'write' ? (
                  <div className="space-y-1.5">
                    {/* Markdown 快捷工具栏 */}
                    <div className="flex items-center gap-1 p-1 bg-wb-bg-subtle/70 border border-wb-border-subtle rounded-xl flex-wrap text-xs text-wb-text-secondary">
                      <button
                        type="button"
                        onClick={() => insertMarkdown('**', '**')}
                        className="p-1.5 hover:bg-wb-bg-surface rounded-lg hover:text-wb-text-primary transition-colors"
                        title="加粗 (**文本**)"
                      >
                        <Bold className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => insertMarkdown('`', '`')}
                        className="p-1.5 hover:bg-wb-bg-surface rounded-lg hover:text-wb-text-primary transition-colors font-mono"
                        title="行内代码 (`代码`)"
                      >
                        <Code className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => insertMarkdown('\n```\n', '\n```\n')}
                        className="px-1.5 py-1 hover:bg-wb-bg-surface rounded-lg hover:text-wb-text-primary transition-colors font-mono text-3xs"
                        title="代码块 (```代码块```)"
                      >
                        pre
                      </button>
                      <button
                        type="button"
                        onClick={() => insertMarkdown('> ')}
                        className="p-1.5 hover:bg-wb-bg-surface rounded-lg hover:text-wb-text-primary transition-colors"
                        title="引用 (> 文本)"
                      >
                        <Quote className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => insertMarkdown('- ')}
                        className="p-1.5 hover:bg-wb-bg-surface rounded-lg hover:text-wb-text-primary transition-colors"
                        title="无序列表 (- 条目)"
                      >
                        <List className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => insertMarkdown('[', '](https://)')}
                        className="p-1.5 hover:bg-wb-bg-surface rounded-lg hover:text-wb-text-primary transition-colors"
                        title="超链接 [标题](链接)"
                      >
                        <LinkIcon className="w-3.5 h-3.5" />
                      </button>
                      <EmojiToolbarButton
                        onInsert={insertEmojiText}
                        className="p-1.5 hover:bg-wb-bg-surface rounded-lg hover:text-wb-text-primary transition-colors"
                      />
                      <span className="text-3xs text-wb-text-muted ml-auto pr-1 hidden sm:inline">
                        支持 Markdown 格式
                      </span>
                    </div>

                    <textarea
                      ref={adminTextareaRef}
                      value={adminReplyText}
                      onChange={(e) => setAdminReplyText(e.target.value)}
                      placeholder={
                        adminSelectedStatus === 'declined'
                          ? '请说明暂不考虑的具体原因（支持 Markdown 排版、列表、加粗等）...'
                          : adminSelectedStatus === 'accepted'
                          ? '说明采纳方案与排期规划（支持 Markdown 排版、列表、代码块等）...'
                          : adminSelectedStatus === 'fixed'
                          ? '说明修复方案或上线版本（支持 Markdown 排版）...'
                          : '选填：为社区提出官方说明，支持 Markdown 格式...'
                      }
                      rows={4}
                      className="w-full px-4 py-2.5 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle text-xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong resize-y font-mono"
                      maxLength={3000}
                    />
                    <div className="flex justify-between items-center text-3xs text-wb-text-muted px-1">
                      <span>可使用 **加粗**、`代码`、&gt; 引用、- 列表等语法</span>
                      <span>{adminReplyText.length} / 3000</span>
                    </div>
                  </div>
                ) : (
                  <div className="min-h-[120px] max-h-56 overflow-y-auto p-3.5 rounded-2xl bg-wb-bg-subtle/80 border border-wb-border-subtle text-xs text-wb-text-primary">
                    {adminReplyText.trim() ? (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkBreaks]}
                        components={{
                          a: ({ node, ...props }) => (
                            <a {...props} target="_blank" rel="noopener noreferrer" className="text-wb-info hover:underline" />
                          ),
                          code: ({ className, children, ...props }: any) => {
                            return (!className?.includes('language-') && !String(children).includes('\n')) ? (
                              <code className="px-1 py-0.5 rounded bg-wb-bg-surface border border-wb-border-subtle font-mono text-2xs text-wb-warn" {...props}>
                                {children}
                              </code>
                            ) : (
                              <pre className="p-2.5 rounded-xl bg-wb-bg-surface border border-wb-border-subtle font-mono text-2xs overflow-x-auto text-wb-text-primary my-1.5" {...props}>
                                <code>{children}</code>
                              </pre>
                            );
                          },
                          ul: ({ ...props }) => <ul className="list-disc pl-4 space-y-0.5 my-1" {...props} />,
                          ol: ({ ...props }) => <ol className="list-decimal pl-4 space-y-0.5 my-1" {...props} />,
                          blockquote: ({ ...props }) => <blockquote className="border-l-2 border-wb-success pl-2 text-wb-text-secondary italic my-1" {...props} />,
                          h1: ({ ...props }) => <h1 className="text-sm font-bold text-wb-text-primary my-1" {...props} />,
                          h2: ({ ...props }) => <h2 className="text-xs font-bold text-wb-text-primary my-1" {...props} />,
                          h3: ({ ...props }) => <h3 className="text-xs font-semibold text-wb-text-primary my-1" {...props} />,
                          p: ({ ...props }) => <p className="leading-relaxed my-0.5 break-words" {...props} />
                        }}
                      >
                        {adminReplyText}
                      </ReactMarkdown>
                    ) : (
                      <div className="h-28 flex items-center justify-center text-wb-text-muted italic text-xs">
                        暂无说明内容，请先在「编辑」界面输入
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2.5 sm:gap-3 pt-2">
              <button
                type="button"
                onClick={() => setAdminModalItem(null)}
                className="px-4 py-2 rounded-capsule border border-wb-border-subtle text-xs text-wb-text-secondary hover:text-wb-text-primary text-center"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={adminSubmitting}
                className="wb-pressable px-6 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm hover:opacity-90 disabled:opacity-50 text-center"
              >
                {adminSubmitting ? '更新中...' : '确认更新并公示'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
