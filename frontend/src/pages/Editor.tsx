import React, { lazy, Suspense, useDeferredValue, useState, useEffect, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mdTableComponents } from '../utils/mdComponents';
import remarkBreaks from 'remark-breaks';
import { Image as ImageIcon, Images, ChevronLeft, ChevronRight, ChevronDown, X, Send, BarChart2, Plus, Trash2, Tag, MessageSquare, ShieldCheck, Bold, Italic, Heading2, Quote, Code, List, CheckSquare, Link as LinkIcon, Table as TableIcon, Eye, Edit3, Columns2, RotateCcw, Sparkles, Newspaper, FolderOpen, Save, Clock, FileText } from 'lucide-react';
import { apiClient, UPLOAD_TIMEOUT } from '../api/client';
import type { UserProfile } from '../types';
import { CustomDropdown, type DropdownOption } from '../components/CustomDropdown';
import { CodeBlock } from '../components/CodeBlock';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmModal';
import { DraftManagerModal, type DraftItem } from '../components/DraftManagerModal';
import { EmojiToolbarButton } from '../components/EmojiToolbarButton';
import { extractTitleFromContent, getTodayDateString } from '../utils/format';
import { precompressImage, validateUploadFile } from '../utils/imageCompress';

interface Props {
  user: UserProfile | null;
  onSuccess: (postId: string) => void;
  onRequireAuth: () => void;
  initialMode?: 'post' | 'daily';
  initialDraftId?: string | null;
  onClearInitialDraftId?: () => void;
}

const RichTextEditor = lazy(() => import('../components/RichTextEditor'));

const editorViews = [
  { id: 'edit', label: '编辑', Icon: Edit3 },
  { id: 'preview', label: '预览', Icon: Eye },
  { id: 'split', label: '分栏', Icon: Columns2 },
] as const;

const articleTemplates = [
  { label: '技术分享', description: '背景、实现和总结', markdown: '## 背景\n\n介绍问题与目标。\n\n## 实现思路\n\n记录关键步骤与示例。\n\n## 总结\n\n补充收获与相关资源。' },
  { label: '问题求助', description: '现象、复现和已尝试的方法', markdown: '## 问题描述\n\n描述现象和预期结果。\n\n## 复现步骤\n\n1. 说明运行环境。\n2. 列出复现步骤。\n\n## 已尝试的方法\n\n- 补充排查过程。' },
  { label: '社区日报', description: '要闻、开源动态和阅读推荐', markdown: '## 今日要闻\n\n- **要闻标题**：简要说明与来源。\n\n## 开源动态\n\n- **项目名称**：更新亮点与项目链接。\n\n## 推荐阅读\n\n- 补充文章及推荐理由。' },
];

const articleStatements = [
  { label: '原创声明', markdown: '> **创作声明**：本文为原创内容，转载请注明作者和来源。' },
  { label: '转载声明', markdown: '> **转载声明**：原作者：待填写 · 原文链接：待填写。' },
  { label: '翻译声明', markdown: '> **翻译声明**：本文译自原文，原作者和出处：待填写。' },
];

function readDraftMarkdown(content: string, format?: string) {
  return format === 'plain' ? content.replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g, '\\$&') : content;
}

const editorTabs = 'inline-flex flex-wrap gap-0.5 rounded-xl border border-wb-border-subtle bg-wb-bg-subtle p-0.5';
const editorTab = 'inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs font-medium text-wb-text-secondary transition-colors hover:text-wb-text-primary aria-pressed:bg-wb-bg-elevated aria-pressed:text-wb-text-primary aria-pressed:shadow-sm';

const previewComponents = {
  ...mdTableComponents,
  pre({ children, ...props }: React.ComponentProps<'pre'>) {
    if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(children)) {
      const language = children.props.className?.match(/language-([^\s]+)/)?.[1];
      return <CodeBlock language={language || 'text'} value={String(children.props.children).replace(/\n$/, '')} />;
    }
    return <pre {...props}>{children}</pre>;
  },
};

const MarkdownPreview = React.memo(function MarkdownPreview({ title, markdown }: { title: string; markdown: string }) {
  return (
    <div className="wb-author-pane-body overflow-auto px-4 py-5 md:px-6" tabIndex={0} aria-label="Markdown 预览内容">
      {title.trim() && <h2 className="mb-5 border-b border-wb-border-subtle pb-3 text-xl font-bold text-wb-text-primary">{title}</h2>}
      {markdown.trim() ? (
        <div className="wb-author-prose prose max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={previewComponents}>{markdown}</ReactMarkdown>
        </div>
      ) : <p className="py-12 text-center text-sm text-wb-text-muted">写下正文后，排版会显示在这里。</p>}
    </div>
  );
});

export const Editor: React.FC<Props> = ({
  user,
  onSuccess,
  onRequireAuth,
  initialMode = 'post',
  initialDraftId,
  onClearInitialDraftId,
}) => {
  const toast = useToast();
  const confirm = useConfirm();
  const isSuperAdmin = user?.role === 'super_admin' || user?.role === 'admin';
  const effectiveMode = initialMode === 'daily' && isSuperAdmin ? 'daily' : 'post';
  const draftKey = (name: string) => `draft_${effectiveMode === 'daily' ? 'daily_' : ''}${name}_${user?.id || 'anon'}`;
  const [title, setTitle] = useState('');
  const [contentMd, setContentMd] = useState('');
  const previewMarkdown = useDeferredValue(contentMd);
  const previewTitle = useDeferredValue(title);
  const insertMenuRef = useRef<HTMLDetailsElement>(null);
  const [categoryId, setCategoryId] = useState<number>(effectiveMode === 'daily' ? 2 : 1);
  const [postType, setPostType] = useState<'post' | 'news'>(effectiveMode === 'daily' ? 'news' : 'post');
  const [commentPolicy, setCommentPolicy] = useState('open');
  // 定时发布：后端现已支持 status=scheduled + scheduled_at，前端补齐入口
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');

  // 编辑器设置快照：云端草稿只存 comment_policy / scheduled_at，
  // 投票配置等纯前端设置按「用户 + 草稿」存本地，刷新或切草稿后恢复
  const editorSettingsKey = (draftId?: string | null) =>
    `geek_editor_settings_${user?.id || 'guest'}_${draftId || 'current'}`;
  const applyEditorSettings = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (typeof v.commentPolicy === 'string') setCommentPolicy(v.commentPolicy);
    if (typeof v.scheduleEnabled === 'boolean') setScheduleEnabled(v.scheduleEnabled);
    if (typeof v.scheduledAt === 'string') setScheduledAt(v.scheduledAt);
    if (typeof v.enablePoll === 'boolean') setEnablePoll(v.enablePoll);
    if (typeof v.pollTitle === 'string') setPollTitle(v.pollTitle);
    if (Array.isArray(v.pollOptions)) setPollOptions(v.pollOptions);
    if (typeof v.pollIsMultiple === 'boolean') setPollIsMultiple(v.pollIsMultiple);
    if (typeof v.pollMaxChoices === 'number') setPollMaxChoices(v.pollMaxChoices);
  };
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);
  const [viewMode, setViewMode] = useState<typeof editorViews[number]['id']>('split');
  // 好文分享：原创 / 转载 + 来源 + 承诺书
  const [sourceType, setSourceType] = useState<'original' | 'repost' | ''>('');
  const [sourceNote, setSourceNote] = useState('');
  const [sourceAck, setSourceAck] = useState(false);
  const [editorMode, setEditorMode] = useState<'markdown' | 'rich'>(
    () => localStorage.getItem('wb_editor_format') === 'rich' ? 'rich' : 'markdown'
  );
  const switchEditorMode = (mode: typeof editorMode) => {
    setEditorMode(mode);
    localStorage.setItem('wb_editor_format', mode);
  };
  const [lastSavedTime, setLastSavedTime] = useState<string | null>(null);

  // 服务端分类动态加载
  const [serverCategories, setServerCategories] = useState<any[]>([]);

  useEffect(() => {
    apiClient.get('/posts/categories').then((res) => {
      if (Array.isArray(res.data) && res.data.length > 0) {
        setServerCategories(res.data);
      }
    }).catch(() => {});
  }, []);

  // 多草稿箱管理
  const [isDraftModalOpen, setIsDraftModalOpen] = useState(false);

  // 持久化 currentDraftId：从 localStorage 恢复，避免页面切换后丢失导致重复创建草稿
  const [currentDraftId, setCurrentDraftIdRaw] = useState<string | null>(() => {
    if (initialDraftId) return initialDraftId;
    try {
      return localStorage.getItem(draftKey('cloud_id')) || null;
    } catch {
      return null;
    }
  });
  const currentDraftIdRef = useRef<string | null>(currentDraftId);
  // 自动保存代次：每次内容变更 +1，发布成功后也 +1；响应回来时若代次已变则丢弃
  const autosaveGenerationRef = useRef(0);


  // 跨标签页草稿同步：另一个标签保存/删除草稿时，本页列表跟随更新，避免后写覆盖先写
  useEffect(() => {
    const onStorageSync = (e: StorageEvent) => {
      if (e.key !== 'geek_community_drafts_v1' || !e.newValue) return;
      try {
        const list = JSON.parse(e.newValue);
        if (Array.isArray(list)) {
          setMultiDrafts(list);
          toast.info('已同步其他标签页的草稿变更');
        }
      } catch {}
    };
    window.addEventListener('storage', onStorageSync);
    return () => window.removeEventListener('storage', onStorageSync);
  }, []);
  const inlineUploadingRef = useRef(0);
  const [inlineUploading, setInlineUploading] = useState(0);
  const documentRevision = useRef(0);

  // 统一的 setCurrentDraftId 包装器：同步更新 ref + localStorage
  const setCurrentDraftId = (id: string | null) => {
    currentDraftIdRef.current = id;
    setCurrentDraftIdRaw(id);
    if (id) {
      localStorage.setItem(draftKey('cloud_id'), id);
    } else {
      localStorage.removeItem(draftKey('cloud_id'));
    }
  };

  const [multiDrafts, setMultiDrafts] = useState<DraftItem[]>(() => {
    try {
      const stored = localStorage.getItem('geek_community_drafts_v1');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // 仅写入 localStorage，不再额外 setState（避免在 setMultiDrafts 回调中双重 setState 反模式）
  const persistDraftsToStorage = (items: DraftItem[]) => {
    localStorage.setItem('geek_community_drafts_v1', JSON.stringify(items));
  };

  // 直接设置 multiDrafts 并持久化（用于非 setMultiDrafts 回调的场景）
  const saveMultiDrafts = (items: DraftItem[]) => {
    setMultiDrafts(items);
    persistDraftsToStorage(items);
  };

  // 自动从服务端同步草稿（以服务端云端草稿为唯一真值，合并未同步的本地离线草稿）
  const fetchCloudDrafts = async () => {
    if (!user) return;
    try {
      const res = await apiClient.get('/posts/drafts');
      if (Array.isArray(res.data)) {
        const cloudItems: DraftItem[] = res.data.map((item: any) => ({
          id: item.id,
          title: item.title,
          contentMd: readDraftMarkdown(item.content_md || '', item.content_type),
          categoryId: item.category_id || 1,
          postType: item.post_type || 'post',
          tags: item.tags || [],
          updatedAt: item.updated_at
            ? new Date(item.updated_at).toLocaleDateString() + ' ' + new Date(item.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '刚刚',
          charCount: item.char_count || item.content_md?.length || 0,
          source: 'cloud',
        }));

        setMultiDrafts((prev) => {
          // 仅保留未在服务端建立 UUID 的本地离线草稿
          const localOnly = prev.filter(
            (p) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.id)
          );
          const merged = [...cloudItems, ...localOnly];
          persistDraftsToStorage(merged);
          return merged;
        });
      }
    } catch {}
  };

  useEffect(() => {
    fetchCloudDrafts();
  }, [user]);

  // 在原草稿基础上保存修改（安全同步对应草稿，绝不覆盖其他草稿）
  const handleUpdateCurrentDraft = async () => {
    if (!title.trim() && !contentMd.trim()) {
      toast.warning('请先输入标题或正文再保存');
      return;
    }
    if (!currentDraftId) {
      handleSaveCurrentAsNewDraft();
      return;
    }

    const nowStr = new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(currentDraftId);

    try {
      const res = await apiClient.post('/posts/draft/save', {
        draft_id: isUuid ? currentDraftId : undefined,
        title: title.trim() || '未命名草稿',
        content_md: contentMd.trim(),
        content_type: 'markdown',
        category_id: categoryId,
        post_type: postType,
        tags,
        // 相册一并存进草稿，避免「上传图 → 存草稿 → 发布」丢图
        image_urls: albumImagesRef.current,
      });

      const actualId = res.data?.draft_id || currentDraftId;
      setCurrentDraftId(actualId);

      const updatedItem: DraftItem = {
        id: actualId,
        title: title.trim() || '未命名草稿',
        contentMd: contentMd.trim(),
        categoryId,
        postType,
        tags,
        updatedAt: nowStr,
        charCount: contentMd.length,
        source: 'cloud',
      };

      setMultiDrafts((prev) => {
        const idx = prev.findIndex((d) => d.id === currentDraftId || d.id === actualId);
        let updated: DraftItem[];
        if (idx !== -1) {
          updated = [...prev];
          updated[idx] = updatedItem;
        } else {
          updated = [updatedItem, ...prev];
        }
        persistDraftsToStorage(updated);
        return updated;
      });

      setLastSavedTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      toast.success('已在原草稿基础上保存更新！');
      setIsDraftModalOpen(false);
    } catch {
      toast.error('保存草稿失败，请稍后重试');
    }
  };

  // 另存为全新独立草稿（后端生成新 UUID，彻底杜绝串改与复制冲突）
  const handleSaveCurrentAsNewDraft = async () => {
    if (!title.trim() && !contentMd.trim()) {
      toast.warning('请先输入标题或正文再保存');
      return;
    }
    const nowStr = new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    try {
      // 传递 draft_id=undefined，指示后端创建独立新草稿
      const res = await apiClient.post('/posts/draft/save', {
        title: title.trim() || '未命名草稿',
        content_md: contentMd.trim(),
        content_type: 'markdown',
        category_id: categoryId,
        post_type: postType,
        tags,
        // 相册一并存进草稿，避免「上传图 → 存草稿 → 发布」丢图
        image_urls: albumImagesRef.current,
      });

      const serverDraftId = res.data.draft_id;
      setCurrentDraftId(serverDraftId);

      const newDraft: DraftItem = {
        id: serverDraftId,
        title: title.trim() || '未命名草稿',
        contentMd: contentMd.trim(),
        categoryId,
        postType,
        tags,
        updatedAt: nowStr,
        charCount: contentMd.length,
        source: 'cloud',
      };

      setMultiDrafts((prev) => {
        const updated = [newDraft, ...prev.filter((d) => d.id !== serverDraftId)];
        persistDraftsToStorage(updated);
        return updated;
      });

      setLastSavedTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      toast.success('已成功保存为新草稿！');
      setIsDraftModalOpen(false);
    } catch {
      const localId = Date.now().toString();
      const fallbackDraft: DraftItem = {
        id: localId,
        title: title.trim() || '未命名草稿',
        contentMd: contentMd.trim(),
        categoryId,
        postType,
        tags,
        updatedAt: nowStr,
        charCount: contentMd.length,
        source: 'local',
      };
      setCurrentDraftId(localId);
      setMultiDrafts((prev) => {
        const updated = [fallbackDraft, ...prev];
        persistDraftsToStorage(updated);
        return updated;
      });
      toast.warning('云端同步失败，已暂存至本地草稿箱');
      setIsDraftModalOpen(false);
    }
  };

  const handleLoadDraft = (draft: DraftItem) => {
    documentRevision.current += 1;
    setCurrentDraftId(draft.id);
    setAlbumImages(draft.imageUrls || []);
    setTitle(draft.title);
    setContentMd(draft.contentMd);
    setCategoryId(draft.categoryId);
    setPostType(draft.postType);
    setTags(draft.tags || []);
    setUserEditedTitle(true);
    try {
      const raw = localStorage.getItem(editorSettingsKey(draft.id));
      if (raw) applyEditorSettings(JSON.parse(raw));
    } catch {}
    localStorage.setItem(draftKey('title'), draft.title);
    localStorage.setItem(draftKey('content'), draft.contentMd);
    localStorage.setItem(draftKey('category'), String(draft.categoryId));
    setLastSavedTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    setIsDraftModalOpen(false);
    toast.success(`已载入草稿：《${draft.title || '未命名草稿'}》`);
  };

  const handleStartNewBlank = () => {
    documentRevision.current += 1;
    setCurrentDraftId(null);
    setTitle('');
    setContentMd('');
    setTags([]);
    setUserEditedTitle(false);
    localStorage.removeItem(draftKey('title'));
    localStorage.removeItem(draftKey('content'));
    localStorage.removeItem(draftKey('category'));
    setLastSavedTime(null);
    setCloudSyncStatus('idle');
    toast.info('已开启新空白文章创作');
  };

  useEffect(() => {
    if (initialDraftId) {
      const loadInitialDraft = async () => {
        try {
          const res = await apiClient.get(`/posts/${initialDraftId}`);
          if (res.data) {
            const d = res.data;
            documentRevision.current += 1;
            setCurrentDraftId(initialDraftId);
            setTitle(d.title || '');
            const markdown = readDraftMarkdown(d.content_md || '', d.content_type);
            setContentMd(markdown);
            setAlbumImages(d.image_urls || []);
            if (d.category_id) setCategoryId(d.category_id);
            if (d.post_type) setPostType(d.post_type);
            if (Array.isArray(d.tags)) setTags(d.tags);
            setUserEditedTitle(true);
            applyEditorSettings({
              commentPolicy: d.comment_policy,
              scheduleEnabled: Boolean(d.scheduled_at),
              scheduledAt: d.scheduled_at ? String(d.scheduled_at).slice(0, 16) : '',
            });
            try {
              const raw = localStorage.getItem(editorSettingsKey(initialDraftId));
              if (raw) applyEditorSettings(JSON.parse(raw));
            } catch {}
            localStorage.setItem(draftKey('title'), d.title || '');
            localStorage.setItem(draftKey('content'), markdown);
            if (d.category_id) localStorage.setItem(draftKey('category'), String(d.category_id));
            setLastSavedTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
            toast.success(`已载入草稿：《${d.title || '未命名草稿'}》`);
            onClearInitialDraftId?.();
          }
        } catch {
          const localDraft = multiDrafts.find((item) => item.id === initialDraftId);
          if (localDraft) {
            handleLoadDraft(localDraft);
            onClearInitialDraftId?.();
          }
        }
      };
      loadInitialDraft();
    }
  }, [initialDraftId]);

  const handleDeleteDraft = async (id: string) => {
    // 草稿会同步删除云端数据，误触无法恢复，先二次确认
    const target = multiDrafts.find((d) => d.id === id);
    const ok = await confirm({
      title: '删除草稿',
      description: `确定删除草稿《${target?.title?.trim() || '未命名草稿'}》吗？云端草稿会一并删除，此操作不可撤销。`,
      confirmText: '确定删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    setMultiDrafts((prev) => {
      const updated = prev.filter((d) => d.id !== id);
      persistDraftsToStorage(updated);
      return updated;
    });
    if (currentDraftId === id || currentDraftIdRef.current === id) {
      setCurrentDraftId(null);
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      try {
        await apiClient.delete(`/posts/${id}?action=delete`);
      } catch (err) {
        console.warn('Delete cloud draft error:', err);
      }
    }
    toast.info('草稿已移除');
  };

  const handleClearAllDrafts = async () => {
    const ok = await confirm({
      title: '清空草稿箱',
      description: `确定清空全部 ${multiDrafts.length} 份草稿吗？云端草稿会一并删除，此操作不可撤销。`,
      confirmText: '全部清空',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    const draftsToDelete = [...multiDrafts];
    saveMultiDrafts([]);
    setCurrentDraftId(null);
    toast.info('草稿箱已全部清空');
    for (const d of draftsToDelete) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.id)) {
        try {
          await apiClient.delete(`/posts/${d.id}?action=delete`);
        } catch {}
      }
    }
  };

  // 附加投票
  const [enablePoll, setEnablePoll] = useState(false);
  const [pollTitle, setPollTitle] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const [pollIsMultiple, setPollIsMultiple] = useState(false);
  const [pollMaxChoices, setPollMaxChoices] = useState(2);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 记录用户是否主动填写/编辑过标题 (若用户未填写，则正文变动时自动智能提取)
  const [userEditedTitle, setUserEditedTitle] = useState(false);

  // 本地自动备份草稿 (localStorage)
  useEffect(() => {
    if (initialDraftId) return;
    if (effectiveMode === 'daily') setTags(['每日早报', '前沿架构', '开源快讯']);

    const savedTitle = localStorage.getItem(draftKey('title'));
    const savedContent = localStorage.getItem(draftKey('content'));
    const savedCategory = localStorage.getItem(draftKey('category'));
    if (savedTitle) {
      setTitle(savedTitle);
      setUserEditedTitle(true);
    }
    if (savedContent) setContentMd(savedContent);
    if (savedCategory) setCategoryId(Number(savedCategory));
    if (savedTitle || savedContent) {
      setLastSavedTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    }
  }, [effectiveMode, user?.id]);

  const saveToLocal = (t: string, c: string, cat?: number, explicitUserTitle?: boolean) => {
    let resolvedTitle = t;
    if (explicitUserTitle !== undefined) {
      setUserEditedTitle(explicitUserTitle);
    } else if (!userEditedTitle || !resolvedTitle.trim()) {
      // 用户未手动指定标题时，从正文内容智能提取真实标题！
      const auto = extractTitleFromContent(c, effectiveMode === 'daily');
      if (auto) {
        resolvedTitle = auto;
      }
    }
    setTitle(resolvedTitle);
    setContentMd(c);
    localStorage.setItem(draftKey('title'), resolvedTitle);
    localStorage.setItem(draftKey('content'), c);
    if (cat) localStorage.setItem(draftKey('category'), String(cat));
    setLastSavedTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  };

  const handleClearDraft = async () => {
    const ok = await confirm({
      title: '清空草稿',
      description: '确定要清空当前草稿内容吗？此操作不可撤销。',
      confirmText: '清空',
      danger: true,
    });
    if (ok) {
      documentRevision.current += 1;
      // 必须先清除 currentDraftId，否则自动云同步会以旧 ID 将空内容覆盖回服务端
      setCurrentDraftId(null);
      setTitle('');
      setContentMd('');
      setTags([]);
      setUserEditedTitle(false);
      localStorage.removeItem(draftKey('title'));
      localStorage.removeItem(draftKey('content'));
      localStorage.removeItem(draftKey('category'));
      setLastSavedTime(null);
      setCloudSyncStatus('idle');
    }
  };

  const insertMarkdown = (prefix: string, suffix: string = '', placeholder: string = '') => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = contentMd.substring(start, end) || placeholder;
    const replacement = `${prefix}${selected}${suffix}`;

    const newContent = contentMd.substring(0, start) + replacement + contentMd.substring(end);
    saveToLocal(title, newContent, categoryId);

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    }, 10);
  };

  const insertArticleBlock = (markdown: string) => {
    if (insertMenuRef.current) insertMenuRef.current.open = false;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const nextLine = contentMd.indexOf('\n', textarea.selectionEnd);
    const position = nextLine === -1 ? contentMd.length : nextLine;
    const before = contentMd.slice(0, position);
    const after = contentMd.slice(position);
    const prefix = before ? '\n\n' : '';
    const suffix = after && !after.startsWith('\n\n') ? '\n' : '';
    saveToLocal(title, before + prefix + markdown + suffix + after, categoryId);
    requestAnimationFrame(() => {
      const end = position + prefix.length + markdown.length;
      textarea.focus();
      textarea.setSelectionRange(end, end);
    });
  };

  // 九宫格相册：最多 10 张，可排序（朋友圈式发图）
  const [albumImages, setAlbumImages] = useState<string[]>([]);
  // ref 同步：自动保存/发布走的是异步回调，闭包里的 albumImages 可能是旧值
  const albumImagesRef = useRef<string[]>([]);
  useEffect(() => {
    albumImagesRef.current = albumImages;
  }, [albumImages]);
  const [albumUploading, setAlbumUploading] = useState(false);
  // 九宫格周配额（相册 >=2 张的帖子每周最多 3 次，周一重置）：后端强校验，这里只做提前提示
  const [albumQuota, setAlbumQuota] = useState<{ used: number; limit: number; remaining: number } | null>(null);
  useEffect(() => {
    let alive = true;
    apiClient.get('/posts/album-quota')
      .then((r) => { if (alive) setAlbumQuota(r.data); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  // 上传队列：每张图先在本地出预览并显示"压缩/上传"状态，完成后替换成服务器地址
  type AlbumTask = { id: string; file: File; preview: string; status: 'compress' | 'upload' | 'error'; percent?: number };
  const [albumTasks, setAlbumTasks] = useState<AlbumTask[]>([]);
  const ALBUM_LIMIT = 10;

  // 多选上传到相册（批量、带队列与进度，不插入正文）
  const uploadAlbumFiles = async (picked: File[]) => {
    const used = albumImages.length + albumTasks.length;
    const room = ALBUM_LIMIT - used;
    if (room <= 0) {
      toast.error(`最多添加 ${ALBUM_LIMIT} 张图片`);
      return;
    }
    const list = picked.slice(0, room);
    if (picked.length > room) toast.info(`最多 ${ALBUM_LIMIT} 张，已自动保留前 ${room} 张`);

    // 本地先卡大小：大 GIF 传到一半被 413/超时打断，体感就是「卡住」
    const valid = list.filter((file) => {
      const invalid = validateUploadFile(file);
      if (invalid) toast.error(`${file.name}：${invalid}`);
      return !invalid;
    });
    if (!valid.length) return;

    const tasks = valid.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      preview: URL.createObjectURL(file),
      status: 'compress' as const,
    }));
    setAlbumTasks((prev) => [...prev, ...tasks]);
    setAlbumUploading(true);

    for (const task of tasks) {
      await uploadOneTask(task);
    }

    setAlbumUploading(false);
  };

  // 单张上传（首次上传与「重试」共用一份逻辑）
  const uploadOneTask = async (task: AlbumTask) => {
    try {
      setAlbumTasks((prev) =>
        prev.map((x) => (x.id === task.id ? { ...x, status: 'compress' } : x))
      );
      const compressed = await precompressImage(task.file, 1600);
      setAlbumTasks((prev) =>
        prev.map((x) => (x.id === task.id ? { ...x, status: 'upload' } : x))
      );
      const formData = new FormData();
      formData.append('file', compressed);
      const res = await apiClient.post('/posts/upload-image', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: UPLOAD_TIMEOUT,
        onUploadProgress: (e) => {
          if (!e.total) return;
          const percent = Math.min(99, Math.round((e.loaded / e.total) * 100));
          setAlbumTasks((prev) =>
            prev.map((x) => (x.id === task.id ? { ...x, percent } : x))
          );
        },
      });
      if (res.data?.url) setAlbumImages((prev) => [...prev, res.data.url]);
      setAlbumTasks((prev) => prev.filter((x) => x.id !== task.id));
      URL.revokeObjectURL(task.preview);
    } catch (err: any) {
      setAlbumTasks((prev) =>
        prev.map((x) => (x.id === task.id ? { ...x, status: 'error' } : x))
      );
      toast.error(err?.response?.data?.detail || '图片上传失败');
    }
  };

  // 失败重试：失败的任务此前会永久占位、也一直计入 10 张名额
  const retryAlbumTask = async (id: string) => {
    const task = albumTasks.find((x) => x.id === id);
    if (!task) return;
    setAlbumUploading(true);
    await uploadOneTask(task);
    setAlbumUploading(false);
  };

  // 移除失败占位：同时释放本地预览的 object URL，避免内存泄漏
  const removeAlbumTask = (id: string) => {
    setAlbumTasks((prev) => {
      const target = prev.find((x) => x.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return prev.filter((x) => x.id !== id);
    });
  };

  const moveAlbumImage = (from: number, to: number) => {
    setAlbumImages((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const uploadInlineImage = async (file: File): Promise<string | undefined> => {
    if (!file.type.startsWith('image/')) return;
    const invalid = validateUploadFile(file);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    const revision = documentRevision.current;
    setInlineUploading(++inlineUploadingRef.current);
    try {
      const formData = new FormData();
      formData.append('file', await precompressImage(file, 1600));
      const res = await apiClient.post('/posts/upload-image', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: UPLOAD_TIMEOUT,
      });
      if (documentRevision.current === revision) return res.data.url;
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '图片上传失败');
    } finally {
      setInlineUploading(--inlineUploadingRef.current);
    }
  };

  const insertUploadedMarkdown = useRef<(url: string) => void>(() => {});
  insertUploadedMarkdown.current = (url) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { value, selectionEnd } = textarea;
    const snippet = `\n![图片](${url})\n`;
    saveToLocal(title, value.slice(0, selectionEnd) + snippet + value.slice(selectionEnd), categoryId);
    requestAnimationFrame(() => textarea.setSelectionRange(selectionEnd + snippet.length, selectionEnd + snippet.length));
    toast.success('图片已插入');
  };

  const uploadAndInsertFile = async (file: File) => {
    const url = await uploadInlineImage(file);
    if (url) insertUploadedMarkdown.current(url);
  };

  // 截屏剪贴板粘贴直接上传
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            e.preventDefault();
            uploadAndInsertFile(file);
            return;
          }
        }
      }
    }
  };

  // 拖拽图片直接上传
  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        if (files[i].type.startsWith('image/')) {
          uploadAndInsertFile(files[i]);
          return;
        }
      }
    }
  };

  const handleUploadImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    try {
      await uploadAndInsertFile(file);
    } finally {
      // 清空 input：否则再次选择同一张图不会触发 change 事件（看起来像卡死）
      e.target.value = '';
    }
  };

  // 服务端草稿双重自动保存反馈 (防丢失，消除作者焦虑)
  const [cloudSyncStatus, setCloudSyncStatus] = useState<'saved' | 'syncing' | 'idle'>('idle');
  useEffect(() => {
    if (!user || submittingRef.current || (!title.trim() && !contentMd.trim())) {
      setCloudSyncStatus('idle');
      return;
    }
    setCloudSyncStatus('syncing');
    // 代次标记：发布成功后自增，使发布前发出的在途保存响应被丢弃，避免产生"幽灵草稿"
    const generation = ++autosaveGenerationRef.current;
    const timer = setTimeout(async () => {
      try {
        if (submittingRef.current) return;
        const activeDraftId = currentDraftIdRef.current;
        const isUuid = activeDraftId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(activeDraftId);

        const res = await apiClient.post('/posts/draft/save', {
          draft_id: isUuid ? activeDraftId : undefined,
          title: title.trim() || '未命名草稿',
          content_md: contentMd.trim(),
          content_type: 'markdown',
          category_id: categoryId,
          post_type: postType,
          tags: tags,
          image_urls: albumImagesRef.current,
          comment_policy: commentPolicy,
          scheduled_at: scheduleEnabled && scheduledAt
            ? new Date(scheduledAt).toISOString()
            : null,
        });
        // 设置也写一份本地快照（含投票配置），刷新/切换草稿后可恢复
        try {
          localStorage.setItem(
            editorSettingsKey(currentDraftIdRef.current),
            JSON.stringify({
              commentPolicy, scheduleEnabled, scheduledAt,
              enablePoll, pollTitle, pollOptions, pollIsMultiple, pollMaxChoices,
            })
          );
        } catch {}

        // 期间内容又变了 / 已发布成功：本次响应过期，直接丢弃
        if (generation !== autosaveGenerationRef.current) return;

        const authoritativeId = res.data?.draft_id;
        if (authoritativeId) {
          // 如果之前的 ID 不是这个（首次同步或本地草稿升级为云端），统一更新
          if (currentDraftIdRef.current !== authoritativeId) {
            setCurrentDraftId(authoritativeId);
          }

          const nowStr = new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const updatedDraftItem: DraftItem = {
            id: authoritativeId,
            title: title.trim() || '未命名草稿',
            contentMd: contentMd.trim(),
            categoryId,
            postType,
            tags,
            updatedAt: nowStr,
            charCount: contentMd.length,
            source: 'cloud',
          };

          setMultiDrafts((prev) => {
            // 同时匹配旧本地 ID 和新云端 ID，避免本地→云端升级时产生重复
            const idx = prev.findIndex((d) => d.id === authoritativeId || (activeDraftId && d.id === activeDraftId));
            let next: DraftItem[];
            if (idx !== -1) {
              next = [...prev];
              next[idx] = updatedDraftItem;
            } else {
              next = [updatedDraftItem, ...prev];
            }
            persistDraftsToStorage(next);
            return next;
          });
        }

        setCloudSyncStatus('saved');
        setLastSavedTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      } catch {
        setCloudSyncStatus('idle');
      }
    }, 2500);
    return () => clearTimeout(timer);
  }, [
    title, contentMd, categoryId, tags, user, postType, albumImages,
    commentPolicy, scheduleEnabled, scheduledAt,
    enablePoll, pollTitle, pollOptions, pollIsMultiple, pollMaxChoices,
  ]);

  // 关闭/刷新页面前的未保存提醒：仅在"有内容且最后一轮云端同步未完成"时提示，避免骚扰
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (submittingRef.current) return;
      if (!title.trim() && !contentMd.trim()) return;
      if (cloudSyncStatus === 'saved') return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [title, contentMd, cloudSyncStatus]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isShareCategory) {
      if (!sourceType) { toast.warning('好文分享需选择「原创」或「转载」'); return; }
      if (sourceType === 'repost' && sourceNote.trim().length < 2) { toast.warning('转载必须注明文章来源'); return; }
      if (!sourceAck) { toast.warning('请先勾选「我已知晓」承诺书'); return; }
    }
    if (!user) return onRequireAuth();
    if (user.status === 'probation') {
      toast.warning(`您当前处于见习观察期（还需活跃 ${Math.max(1, 5 - (user.active_days || 0))} 天自动转正），暂不可公开发布文章。您的草稿已妥善保存至草稿箱～`);
      return;
    }
    if (!contentMd.trim()) {
      toast.warning('请填写文章正文内容');
      return;
    }

    let finalTitle = title.trim();
    if (!finalTitle) {
      finalTitle = extractTitleFromContent(contentMd, effectiveMode === 'daily');
    }
    if (!finalTitle) {
      finalTitle = effectiveMode === 'daily' ? `【极客早报 · ${getTodayDateString()}】今日技术要闻` : '极客技术前沿讨论';
    }

    if (enablePoll) {
      if (!pollTitle.trim()) {
        toast.warning('请填写投票主题');
        return;
      }
      const validOpts = pollOptions.filter((o) => o.trim().length > 0);
      if (validOpts.length < 2) {
        toast.warning('投票至少需要填写 2 个有效选项');
        return;
      }
    }

    // 定时发布校验：必须选择时间且至少晚于当前 1 分钟（校验必须先于提交锁，避免提前 return 时锁死）
    let publishStatus: 'published' | 'scheduled' = 'published';
    let scheduledIso: string | undefined;
    if (scheduleEnabled) {
      if (!scheduledAt) {
        toast.warning('请选择定时发布的时间');
        return;
      }
      const ts = new Date(scheduledAt).getTime();
      if (!Number.isFinite(ts) || ts < Date.now() + 60_000) {
        toast.warning('定时发布时间需晚于当前时间 1 分钟以上');
        return;
      }
      publishStatus = 'scheduled';
      scheduledIso = new Date(ts).toISOString();
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      // 正在上传的图片也算名额：否则「先点发布、上传才完成」会导致丢图并突破 10 张上限
      if (albumTasks.length > 0) {
        toast.warning(`还有 ${albumTasks.length} 张图片正在上传，请上传完成后再发布`);
        setSubmitting(false);
        return;
      }
      if (inlineUploadingRef.current > 0) {
        toast.warning(`正文还有 ${inlineUploadingRef.current} 张插图正在上传，请稍候`);
        setSubmitting(false);
        return;
      }

      // 正文里的插图 + 相册，合计不能超过 10 张
      const inlineImageCount = (contentMd.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;
      if (inlineImageCount + albumImages.length > ALBUM_LIMIT) {
        toast.error(`正文插图 ${inlineImageCount} 张 + 相册 ${albumImages.length} 张，合计不能超过 ${ALBUM_LIMIT} 张`);
        setSubmitting(false);
        return;
      }

      const postPayload: any = {
        title: finalTitle,
        content_md: contentMd.trim(),
        content_type: 'markdown',
        category_id: categoryId,
        post_type: postType,
        comment_policy: commentPolicy,
        tags: tags,
        status: publishStatus,
        ...(scheduledIso ? { scheduled_at: scheduledIso } : {}),
        // 无条件携带：空数组代表「相册已清空」，条件展开会让后端保留旧图
        image_urls: albumImagesRef.current,
        ...(isShareCategory ? {
          source_type: sourceType || undefined,
          source_note: sourceNote.trim() || undefined,
          source_ack: sourceAck,
        } : {}),
      };

      const validOptions = enablePoll && pollTitle.trim() ? pollOptions.filter((o) => o.trim().length > 0) : [];
      const effMaxChoices = pollIsMultiple
        ? Math.min(Math.max(pollMaxChoices, 2), Math.max(validOptions.length, 2))
        : 1;
      if (enablePoll && pollTitle.trim() && validOptions.length >= 2) {
        postPayload.poll = {
          title: pollTitle.trim(),
          options: validOptions.map((o) => o.trim()),
          is_multiple: pollIsMultiple,
          max_choices: effMaxChoices,
          duration_days: 7,
        };
      }

      let newPostId: string;
      const isCloudDraft = currentDraftId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(currentDraftId);

      if (isCloudDraft) {
        try {
          const res = await apiClient.put(`/posts/${currentDraftId}`, {
            title: finalTitle,
            content_md: contentMd.trim(),
            content_type: 'markdown',
            category_id: categoryId,
            tags: tags,
            comment_policy: commentPolicy,
            post_type: postType,
            status: publishStatus,
            ...(scheduledIso ? { scheduled_at: scheduledIso } : {}),
            image_urls: albumImagesRef.current,
            poll: postPayload.poll,
          });
          newPostId = res.data.id;
        } catch (updateErr: any) {
          if (updateErr.response?.status === 404) {
            const res = await apiClient.post('/posts', postPayload);
            newPostId = res.data.id;
          } else {
            throw updateErr;
          }
        }
      } else {
        const res = await apiClient.post('/posts', postPayload);
        newPostId = res.data.id;
      }

      // 兜底保障：若后端未能自动入库投票，则通过独立接口补齐
      if (enablePoll && pollTitle.trim() && validOptions.length >= 2) {
        try {
          await apiClient.post('/polls', {
            post_id: newPostId,
            title: pollTitle.trim(),
            options: validOptions.map((o) => ({ option_text: o.trim() })),
            is_multiple: pollIsMultiple,
            max_choices: effMaxChoices,
            expires_in_days: 7,
          });
        } catch (pollErr: any) {
          console.warn('Poll fallback error:', pollErr);
        }
      }

      // 若当前关联了草稿箱中的特定草稿，发布后将其移出草稿箱（使用最新的 state 避免闭包快照过期）
      // 发布成功：让所有在途的自动保存响应失效，避免把刚发布的内容又写回草稿箱
      autosaveGenerationRef.current += 1;

      const draftIdToRemove = currentDraftIdRef.current;
      setMultiDrafts((prev) => {
        const filtered = prev.filter(
          (d) => d.id !== draftIdToRemove && d.id !== newPostId
        );
        persistDraftsToStorage(filtered);
        return filtered;
      });
      setCurrentDraftId(null);

      // 清空本地草稿缓存与编辑状态，防止新建文章时覆盖旧文章
      localStorage.removeItem(draftKey('title'));
      localStorage.removeItem(draftKey('content'));
      localStorage.removeItem(draftKey('category'));
      setTitle('');
      setContentMd('');
      setTagInput('');
      setEnablePoll(false);
      setPollTitle('');
      setPollOptions(['', '']);
      setLastSavedTime(null);
      setCloudSyncStatus('idle');
      setUserEditedTitle(false);

      if (publishStatus === 'scheduled') {
        toast.success(`已设置定时发布，将于 ${new Date(scheduledIso as string).toLocaleString()} 自动上线`);
      } else {
        toast.success(postType === 'news' ? '极客早报发布成功！' : '文章发布成功！');
      }
      setScheduleEnabled(false);
      setScheduledAt('');
      onSuccess(newPostId);
    } catch (err: any) {
      toast.error(err.response?.data?.detail || err.message || '发布失败');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  // 分类选项 (与首页板块分类及后端核心数据 100% 对齐)
  const categoryOptions: DropdownOption[] = useMemo(() => {
    let list: DropdownOption[] = [];
    if (serverCategories.length > 0) {
      list = serverCategories
        .filter((c) => isSuperAdmin || c.slug !== 'news')
        .map((c) => ({
          value: c.id,
          label: c.name,
          description: c.description || '',
          badge: c.slug ? c.slug.slice(0, 1).toUpperCase() + c.slug.slice(1) : undefined,
        }));
    } else {
      list = [
        { value: 1, label: '科技前沿', description: '尖端算力、AI 与系统架构', badge: 'Tech' },
        { value: 3, label: '后端架构', description: '微服务与高并发性能调优', badge: 'Backend' },
        { value: 4, label: '设计美学', description: '黑白钛金属极简工业美学', badge: 'Design' },
        { value: 5, label: '极客日常', description: '硬件 Homelab 与极客工作流', badge: 'Geek' },
        { value: 6, label: '综合交流', description: '极客茶水间与闲聊讨论', badge: 'General' },
      ];
    }
    // 确保下拉选项中必定包含“综合交流”
    const hasGeneral = list.some((c) => c.label === '综合交流' || c.badge?.toLowerCase() === 'general');
    if (!hasGeneral) {
      list.push({
        value: 6,
        label: '综合交流',
        description: '极客茶水间与闲聊讨论',
        badge: 'General',
      });
    }
    if (isSuperAdmin && !list.some((c) => c.badge === 'News')) {
      list.splice(1, 0, {
        value: 2,
        label: '新闻早报',
        description: '每日社区精选与行业早报 (首页置顶)',
        badge: 'News',
      });
    }
    return list;
  }, [serverCategories, isSuperAdmin]);

  // 评论权限选项
  // 当前选中板块是否为「好文分享」（slug = share），仅该板块显示来源与承诺书
  const isShareCategory = useMemo(() => {
    const hit = (serverCategories || []).find((c: any) => Number(c.id) === Number(categoryId));
    return hit?.slug === 'share';
  }, [serverCategories, categoryId]);

  // 当前选中板块是否为「问答广场」（slug = qa）
  const isQaCategory = useMemo(() => {
    const hit = (serverCategories || []).find((c: any) => Number(c.id) === Number(categoryId));
    return hit?.slug === 'qa';
  }, [serverCategories, categoryId]);
  const [qaQuota, setQaQuota] = useState<any>(null);
  useEffect(() => {
    if (!isQaCategory) { setQaQuota(null); return; }
    apiClient.get('/qa/config')
      .then((r) => setQaQuota(r.data))
      .catch(() => setQaQuota(null));
  }, [isQaCategory]);

  const commentOptions: DropdownOption[] = [
    { value: 'open', label: '全员开放评论', description: '开放全站注册会员自由交流跟帖' },
    { value: 'member_only', label: '仅正式会员允许评论', description: '仅限 Lv.1 及以上正式会员，屏蔽见习期' },
    { value: 'closed', label: '关闭评论区', description: '纯展示只读模式，禁止任何跟帖' },
  ];

  // 专栏类型 (管理员)
  const postTypeOptions: DropdownOption[] = [
    { value: 'post', label: '普通技术交流贴', description: '标准社区话题讨论与经验分享' },
    { value: 'news', label: '官方每日早报专栏', description: '发布到每日早报专栏，首页常驻置顶' },
  ];

  // 字数统计与预估阅读时长
  const charCount = contentMd.length;
  const estimatedMinutes = Math.max(1, Math.ceil(charCount / 350));

  return (
    <div className="mx-auto max-w-7xl px-3 pt-4 pb-28 sm:px-6 sm:pt-6">
      <form onSubmit={handleSubmit} className="space-y-5 rounded-3xl border border-wb-border-subtle bg-wb-bg-surface p-3.5 shadow-card sm:p-6 lg:p-8">
        {/* 见习期提醒横幅 */}
        {user?.status === 'probation' && (
          <div className="p-3.5 rounded-2xl bg-wb-warn/10 border border-wb-warn/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-wb-warn dark:text-wb-warn">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 shrink-0 text-wb-warn" />
              <span>
                您当前处于见习观察期（已活跃 {user.active_days || 1} / 5 天，还需 {Math.max(1, 5 - (user.active_days || 1))} 天自动晋升正式会员）。见习期间支持撰写并保存草稿，公开发布文章特权将在转正后解锁。
              </span>
            </div>
            <span className="shrink-0 font-medium px-2 py-0.5 rounded-capsule bg-wb-warn/20 text-wb-warn dark:text-wb-warn text-2xs font-mono">
              见习考核中
            </span>
          </div>
        )}

        {/* 顶部标题栏与快捷操作 */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 sm:gap-4 border-b border-wb-border-subtle pb-4">
          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-base md:text-lg font-bold text-wb-text-primary flex items-center gap-2 flex-wrap min-w-0">
                {postType === 'news' ? (
                  <>
                    <Newspaper className="w-4 h-4 text-wb-text-primary shrink-0" />
                    <span className="whitespace-nowrap">极客早报与日报编辑工作台</span>
                    <span className="text-3xs px-2 py-0.5 rounded-capsule bg-wb-text-primary text-wb-bg-page font-semibold whitespace-nowrap shrink-0 max-w-full truncate">
                      官方日报专栏
                    </span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 text-wb-text-primary shrink-0" />
                    <span className="whitespace-nowrap">极客创作者工作台</span>
                  </>
                )}
              </h2>

              {/* 当前关联草稿状态标识：置于标题旁，彻底消除与右侧操作按钮的挤压与重叠错位 */}
              {currentDraftId && (
                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-capsule bg-wb-accent-subtle text-xs text-wb-accent border border-wb-accent/30 font-medium shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-wb-accent animate-pulse" />
                  <span className="whitespace-nowrap">编辑草稿中</span>
                  <button
                    type="button"
                    onClick={handleStartNewBlank}
                    className="ml-1 text-2xs underline opacity-80 hover:opacity-100 whitespace-nowrap"
                    title="脱离当前草稿，开始全新空白写作"
                  >
                    [新建空白]
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 sm:gap-3 text-xs text-wb-text-muted font-mono flex-wrap">
              <span className="whitespace-nowrap">{charCount} 字符</span>
              {(() => {
                // 字数口径与后端保持一致
                const lucky = [666, 888, 999];
                if (lucky.includes(charCount)) {
                  return <span className="whitespace-nowrap text-wb-warn font-semibold">字数渡劫 ✓</span>;
                }
                const near = lucky.find((n) => Math.abs(charCount - n) <= 12);
                if (near) {
                  return (
                    <span className="whitespace-nowrap text-wb-text-muted">
                      距 {near} 字还差 {Math.abs(near - charCount)} 字符
                    </span>
                  );
                }
                return null;
              })()}
              <span>·</span>
              <span className="whitespace-nowrap">预估 {estimatedMinutes} 分钟读完</span>
              {cloudSyncStatus === 'syncing' ? (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1.5 text-wb-warn font-sans whitespace-nowrap">
                    <span className="w-1.5 h-1.5 rounded-full bg-wb-warn animate-pulse" />
                    <span>云端同步中...</span>
                  </span>
                </>
              ) : cloudSyncStatus === 'saved' ? (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1.5 text-wb-success dark:text-wb-success font-sans whitespace-nowrap font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-wb-success" />
                    <span>✓ 云端草稿已保存 {lastSavedTime}</span>
                  </span>
                </>
              ) : lastSavedTime ? (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1.5 text-wb-text-secondary font-sans whitespace-nowrap">
                    <span className="w-1.5 h-1.5 rounded-full bg-wb-text-muted" />
                    <span>本地草稿已备份 {lastSavedTime}</span>
                  </span>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap shrink-0">
            {/* 快速保存草稿 */}
            <button
              type="button"
              onClick={handleUpdateCurrentDraft}
              disabled={!title.trim() && !contentMd.trim()}
              title={currentDraftId ? '保存并覆盖当前原草稿' : '保存为新草稿'}
              className="wb-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-bg-subtle text-xs text-wb-text-secondary hover:text-wb-text-primary border border-wb-border-subtle transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
            >
              <Save className="w-3.5 h-3.5 shrink-0" />
              <span className="whitespace-nowrap">{currentDraftId ? '覆盖保存' : '存为草稿'}</span>
            </button>

            {/* 草稿箱管理 */}
            <button
              type="button"
              onClick={() => setIsDraftModalOpen(true)}
              title="查看与管理多篇草稿"
              className="wb-pressable relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-bg-subtle text-xs text-wb-text-secondary hover:text-wb-text-primary border border-wb-border-subtle transition-colors whitespace-nowrap shrink-0"
            >
              <FolderOpen className="w-3.5 h-3.5 shrink-0" />
              <span className="whitespace-nowrap">草稿箱</span>
              {multiDrafts.length > 0 && (
                <span className="px-1.5 py-0.2 text-3xs font-bold rounded-full bg-wb-accent-subtle text-wb-text-primary shrink-0">
                  {multiDrafts.length}
                </span>
              )}
            </button>

            {/* 清空草稿 */}
            {(title || contentMd) && (
              <button
                type="button"
                onClick={handleClearDraft}
                title="清空当前草稿"
                className="wb-pressable inline-flex items-center gap-1 px-2.5 py-1.5 rounded-capsule bg-wb-bg-subtle text-xs text-wb-text-muted hover:text-wb-danger transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                <span className="whitespace-nowrap hidden sm:inline">清空</span>
              </button>
            )}

            {/* 定时发布（管理员专属能力） */}
            {['super_admin', 'admin'].includes(user?.role || '') && (
            <div className="flex items-center gap-1.5 shrink-0">
              <label className="inline-flex items-center gap-1 text-2xs text-wb-text-secondary select-none cursor-pointer whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={scheduleEnabled}
                  onChange={(e) => setScheduleEnabled(e.target.checked)}
                  className="w-3 h-3 accent-current"
                />
                <span>定时发布</span>
              </label>
              {scheduleEnabled && (
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="h-8 px-2 rounded-lg bg-wb-bg-subtle border border-wb-border-subtle text-2xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong"
                />
              )}
            </div>
            )}

            {/* 发布 / 定时发布 */}
            <button
              type="submit"
              disabled={submitting || inlineUploading > 0 || albumTasks.length > 0}
              className="wb-pressable inline-flex items-center gap-1.5 px-5 py-1.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 disabled:opacity-50 shadow-sm whitespace-nowrap shrink-0"
            >
              <Send className="w-3.5 h-3.5 shrink-0" />
              <span className="whitespace-nowrap">
                {albumTasks.length > 0
                  ? `图片上传中 ${albumImages.length}/${albumImages.length + albumTasks.length}`
                  : submitting
                  ? '提交中...'
                  : scheduleEnabled
                  ? '定时发布'
                  : '立即发布'}
              </span>
            </button>
          </div>
        </div>

        {/* 标题 */}
        <input
          type="text"
          value={title}
          onChange={(e) => saveToLocal(e.target.value, contentMd, categoryId, e.target.value.trim().length > 0)}
          placeholder={
            effectiveMode === 'daily'
              ? '输入早报主标题（可留空，自动从正文要闻获取）...'
              : '请输入文章标题（留空则自动从正文智能获取）...'
          }
          className="w-full px-2 py-2 text-base md:text-xl font-bold bg-transparent border-b border-wb-border-subtle focus:outline-none focus:border-wb-border-strong text-wb-text-primary placeholder:text-wb-text-muted transition-colors"
        />

        <div className="flex items-center justify-between text-xs text-wb-text-muted -mt-1 pb-1">
          <span className="text-2xs">
            {userEditedTitle ? '已手动设置自定义标题' : '留空时将自动从正文要闻提取真实标题'}
          </span>
          <button
            type="button"
            onClick={() => {
              const auto = extractTitleFromContent(contentMd, effectiveMode === 'daily');
              if (auto) {
                saveToLocal(auto, contentMd, categoryId, true);
                toast.info('已从正文提取标题');
              } else {
                toast.info('正文中未检测到小标题或核心条目，请在正文输入内容');
              }
            }}
            className="text-wb-text-muted hover:text-wb-text-primary text-2xs inline-flex items-center gap-1 transition-colors px-2 py-0.5 rounded-md hover:bg-wb-bg-subtle border border-wb-border-subtle"
          >
            <Sparkles className="w-3 h-3 text-wb-warn" />
            <span>从正文重新提取标题</span>
          </button>
        </div>

        {/* 技术话题标签选择器 (Tags Picker) */}
        <div className="space-y-2 py-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-wb-text-muted font-medium flex items-center gap-1">
              <Tag className="w-3.5 h-3.5" />
              <span>话题标签:</span>
            </span>

            {/* 当前已选标签 */}
            {tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 text-xs font-mono px-2.5 py-0.5 rounded-capsule bg-wb-text-primary text-wb-bg-page font-semibold shadow-sm"
              >
                #{t}
                <button
                  type="button"
                  onClick={() => setTags((prev) => prev.filter((item) => item !== t))}
                  className="hover:opacity-75 text-3xs ml-0.5"
                  title="移除标签"
                >
                  ✕
                </button>
              </span>
            ))}

            {/* 输入自定义标签 */}
            <div className="inline-flex items-center gap-1">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = tagInput.trim().replace(/^#/, '');
                    if (val && !tags.includes(val) && tags.length < 5) {
                      setTags((prev) => [...prev, val]);
                      setTagInput('');
                    }
                  }
                }}
                placeholder="回车添加标签..."
                className="h-7 w-28 px-2 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-capsule text-wb-text-primary placeholder:text-wb-text-muted focus:outline-none focus:border-wb-border-strong font-mono"
              />
            </div>
          </div>

          {/* 常用预设快捷标签 */}
          <div className="flex items-center gap-1.5 flex-wrap text-2xs">
            <span className="text-wb-text-muted">推荐标签:</span>
            {['AI', 'Rust', 'Go', '架构设计', '性能调优', '前端', '云原生', 'Docker', 'Linux', 'Python'].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => {
                  if (!tags.includes(preset) && tags.length < 5) {
                    setTags((prev) => [...prev, preset]);
                  }
                }}
                disabled={tags.includes(preset)}
                className={`px-2 py-0.5 rounded-md font-mono transition-colors ${
                  tags.includes(preset)
                    ? 'bg-wb-bg-subtle/40 text-wb-text-muted cursor-not-allowed'
                    : 'bg-wb-bg-subtle hover:bg-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary border border-wb-border-subtle'
                }`}
              >
                +{preset}
              </button>
            ))}
          </div>
        </div>

        <section className="rounded-2xl border border-wb-border-subtle bg-wb-bg-elevated shadow-sm" aria-label="正文编辑器"
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void handleSubmit(event);
            }
          }}>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-2xl border-b border-wb-border-subtle bg-wb-bg-surface px-3 py-2.5">
            <div className={editorTabs} role="group" aria-label="编辑模式">
              <button type="button" className={editorTab} aria-pressed={editorMode === 'markdown'} disabled={inlineUploading > 0} onClick={() => switchEditorMode('markdown')}>
                <Code className="h-3.5 w-3.5" /> Markdown
              </button>
              <button type="button" className={editorTab} aria-pressed={editorMode === 'rich'} disabled={inlineUploading > 0} onClick={() => switchEditorMode('rich')}>
                <FileText className="h-3.5 w-3.5" /> 富文本
              </button>
            </div>
            {editorMode === 'markdown' && <div className={editorTabs} role="group" aria-label="Markdown 视图">
              {editorViews.map(({ id, label, Icon }) => (
                <button key={id} type="button" className={editorTab} aria-pressed={viewMode === id} onClick={() => setViewMode(id)}>
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>}
          </div>
          {editorMode === 'rich' ? (
            <Suspense fallback={<p className="wb-author-pane-body p-6 text-sm text-wb-text-muted" role="status">正在载入富文本编辑器…</p>}>
              <RichTextEditor key={documentRevision.current} value={contentMd} onChange={(markdown) => saveToLocal(title, markdown, categoryId)} uploadImage={uploadInlineImage} />
            </Suspense>
          ) : (
            <>
              {viewMode !== 'preview' && (
                <div className="wb-author-toolbar relative" role="group" aria-label="Markdown 工具">
                  <button
                    type="button"
                    onClick={() => insertMarkdown('**', '**', '加粗文本')}
                    title="粗体"
                    className="wb-author-tool"
                  >
                    <Bold className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => insertMarkdown('*', '*', '斜体文本')}
                    title="斜体"
                    className="wb-author-tool"
                  >
                    <Italic className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => insertMarkdown('\n## ', '', '二级标题')}
                    title="标题"
                    className="wb-author-tool"
                  >
                    <Heading2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => insertMarkdown('\n> ', '', '引用文案')}
                    title="引用"
                    className="wb-author-tool"
                  >
                    <Quote className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => insertMarkdown('`', '`', 'code')}
                    title="行内代码"
                    className="wb-author-tool"
                  >
                    <Code className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => insertMarkdown('\n```python\n# 示例代码\n', '\n```\n', '')}
                    title="代码块"
                    className="wb-author-tool font-mono text-xs"
                  >
                    {'```'}
                  </button>
                  <span className="wb-author-tool-divider" />
                  <button
                    type="button"
                    onClick={() => insertMarkdown('\n- ', '', '列表项')}
                    title="无序列表"
                    className="wb-author-tool"
                  >
                    <List className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => insertMarkdown('\n- [ ] ', '', '待办任务')}
                    title="任务清单"
                    className="wb-author-tool"
                  >
                    <CheckSquare className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => insertMarkdown('[', '](https://example.com)', '链接描述')}
                    title="超链接"
                    className="wb-author-tool"
                  >
                    <LinkIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      insertMarkdown(
                        '\n| 模块 | 说明 | 内存 |\n|---|---|---|\n| FastAPI | 核心 API 服务 | ~180MB |\n| SQLite | 本地轻量化存储 | 零内存 |\n'
                      )
                    }
                    title="表格"
                    className="wb-author-tool"
                  >
                    <TableIcon className="w-3.5 h-3.5" />
                  </button>
                  <span className="wb-author-tool-divider" />
                  <label className="cursor-pointer text-xs">
                    <ImageIcon className="w-3.5 h-3.5" />
                    <span>插图</span>
                    <input type="file" accept="image/*" onChange={handleUploadImage} className="hidden" />
                  </label>
                  <EmojiToolbarButton onInsert={(text) => insertMarkdown(text)} />
                  <span className="wb-author-tool-divider" />
                  <details ref={insertMenuRef} className="md:relative" onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
                  }} onKeyDown={(event) => {
                    if (event.key === 'Escape' && event.currentTarget.open) {
                      event.currentTarget.open = false;
                      event.currentTarget.querySelector('summary')?.focus();
                    }
                  }}>
                    <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-wb-text-secondary hover:bg-wb-bg-subtle [&::-webkit-details-marker]:hidden">
                      <FileText className="h-3.5 w-3.5" /> 模板与声明 <ChevronDown className="h-3 w-3" />
                    </summary>
                    <div className="absolute end-3 top-full z-20 mt-1 w-56 max-w-[calc(100vw-4rem)] rounded-xl border border-wb-border-subtle bg-wb-bg-elevated p-1.5 shadow-lg md:end-0">
                      <p className="px-2 py-1 text-xs font-medium text-wb-text-muted">写作模板</p>
                      {[...articleTemplates].sort((a, b) => postType === 'news' ? Number(b.label === '社区日报') - Number(a.label === '社区日报') : 0).map(({ label, description, markdown }) => (
                        <button type="button" key={label} className="block w-full rounded-lg px-2 py-1.5 text-left text-xs hover:bg-wb-bg-subtle"
                          onClick={() => insertArticleBlock(markdown)}>
                          <span className="font-medium text-wb-text-primary">{label}</span>
                          <span className="mt-0.5 block text-wb-text-muted">{description}</span>
                        </button>
                      ))}
                      <p className="mt-1 border-t border-wb-border-subtle px-2 pb-1 pt-2 text-xs font-medium text-wb-text-muted">文章声明</p>
                      {articleStatements.map(({ label, markdown }) => (
                        <button type="button" key={label} className="block w-full rounded-lg px-2 py-1.5 text-left text-xs text-wb-text-primary hover:bg-wb-bg-subtle"
                          onClick={() => insertArticleBlock(markdown)}>{label}</button>
                      ))}
                    </div>
                  </details>
                </div>
              )}
              <div className="wb-author-panes" data-view={viewMode}>
                <div className="wb-author-pane min-w-0" hidden={viewMode === 'preview'}>
                  <div className="border-b border-wb-border-subtle px-4 py-2 text-xs font-medium text-wb-text-secondary">Markdown 源码</div>
                  <textarea
                    ref={textareaRef}
                    value={contentMd}
                    aria-label="Markdown 正文"
                    spellCheck={false}
                    onChange={(e) => saveToLocal(title, e.target.value, categoryId)}
                    onKeyDown={(e) => {
                      if ((!e.ctrlKey && !e.metaKey) || e.nativeEvent.isComposing) return;
                      const shortcut = e.key.toLowerCase();
                      if (shortcut === 'b') { e.preventDefault(); insertMarkdown('**', '**', '加粗文本'); }
                      if (shortcut === 'i') { e.preventDefault(); insertMarkdown('*', '*', '斜体文本'); }
                      if (shortcut === 'k') { e.preventDefault(); insertMarkdown('[', '](https://)', '链接描述'); }
                    }}
                    onPaste={handlePaste}
                    onDrop={handleDrop}
                    onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
                    placeholder="从这里开始写作，或插入一个模板…"
                    className="wb-author-pane-body block w-full resize-none bg-transparent px-4 py-5 font-mono text-base leading-7 text-wb-text-primary outline-none placeholder:text-wb-text-muted focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-wb-border-strong md:px-6 md:text-sm"
                  />
                </div>
                {viewMode !== 'edit' && (
                  <div className="wb-author-pane min-w-0 bg-wb-bg-surface">
                    <div className="border-b border-wb-border-subtle px-4 py-2 text-xs font-medium text-wb-text-secondary">实时预览</div>
                    <MarkdownPreview title={previewTitle} markdown={previewMarkdown} />
                  </div>
                )}
              </div>
            </>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-b-2xl border-t border-wb-border-subtle bg-wb-bg-surface px-4 py-2.5 text-xs text-wb-text-muted">
            <span role="status">{inlineUploading ? '正在上传正文图片…' : `${charCount} 字符 · 预计阅读 ${estimatedMinutes} 分钟`}</span>
            <span className="hidden sm:inline"><kbd className="font-mono">Ctrl / ⌘ + Enter</kbd> 快捷发布</span>
          </div>
        </section>

        <div className="space-y-2">
            {/* 九宫格相册：最多 10 张，可拖动排序（朋友圈式发图） */}
            <div className="mt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-wb-text-primary flex items-center gap-1.5">
                  <Images className="w-3.5 h-3.5 text-wb-brand" />
                  图片相册
                  <span className="text-3xs font-normal text-wb-text-muted">
                    {albumImages.length + albumTasks.length}/{ALBUM_LIMIT}
                  </span>
                  {albumQuota && (
                    <span
                      className={`text-3xs font-mono px-1.5 py-0.5 rounded-md border ${
                        albumQuota.remaining <= 0
                          ? 'text-wb-danger border-wb-danger/30 bg-wb-danger/10'
                          : 'text-wb-text-muted border-wb-border-subtle bg-wb-bg-subtle'
                      }`}
                      title="九宫格帖子（相册 ≥2 张）每人每周 3 次，每周一自动重置"
                    >
                      九宫格 {albumQuota.used}/{albumQuota.limit}
                    </span>
                  )}
                  {albumUploading && (
                    <span className="inline-flex items-center gap-1 text-3xs text-wb-brand font-mono">
                      <span className="w-3 h-3 border-2 border-wb-brand border-t-transparent rounded-full animate-spin" />
                      压缩上传 {albumImages.length}/{albumImages.length + albumTasks.length}
                    </span>
                  )}
                </span>
                {albumImages.length >= 2 && (
                  <button
                    type="button"
                    onClick={() => toast.success('已整理为九宫格，发布后会按此顺序展示')}
                    className="text-2xs font-semibold text-wb-brand hover:underline"
                  >
                    一键设置九宫格
                  </button>
                )}
              </div>

              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                {albumImages.map((url, idx) => (
                  <div
                    key={`${url}-${idx}`}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', String(idx))}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = Number(e.dataTransfer.getData('text/plain'));
                      if (!Number.isNaN(from)) moveAlbumImage(from, idx);
                    }}
                    className="relative aspect-square rounded-xl overflow-hidden border border-wb-border-subtle group cursor-move"
                  >
                    <img loading="lazy" decoding="async" src={url} alt="" className="w-full h-full object-cover" />
                    <span className="absolute left-1 top-1 px-1.5 py-0.5 rounded-md bg-black/55 text-white text-3xs font-mono">
                      {idx + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => setAlbumImages((prev) => prev.filter((_, i) => i !== idx))}
                      className="absolute right-1 top-1 w-5 h-5 rounded-full bg-black/55 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      title="移除这张"
                    >
                      <X className="w-3 h-3" />
                    </button>
                    <div className="absolute inset-x-0 bottom-0 flex justify-between px-1 pb-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => moveAlbumImage(idx, idx - 1)}
                        className="w-5 h-5 rounded-full bg-black/55 text-white flex items-center justify-center"
                        title="前移"
                      >
                        <ChevronLeft className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveAlbumImage(idx, idx + 1)}
                        className="w-5 h-5 rounded-full bg-black/55 text-white flex items-center justify-center"
                        title="后移"
                      >
                        <ChevronRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}

                {/* 上传中的占位：先出本地预览，再显示压缩/上传状态 */}
                {albumTasks.map((task) => (
                  <div
                    key={task.id}
                    className="relative aspect-square rounded-xl overflow-hidden border border-dashed border-wb-border-strong"
                  >
                    <img loading="lazy" decoding="async" src={task.preview} alt="" className="w-full h-full object-cover opacity-35" />
                    {task.status === 'error' ? (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/65">
                        <span className="text-3xs text-white font-semibold">上传失败</span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => retryAlbumTask(task.id)}
                            className="px-1.5 py-0.5 rounded-md bg-white/90 text-wb-text-primary text-3xs font-semibold"
                          >
                            重试
                          </button>
                          <button
                            type="button"
                            onClick={() => removeAlbumTask(task.id)}
                            className="px-1.5 py-0.5 rounded-md bg-black/60 text-white text-3xs font-semibold border border-white/30"
                          >
                            移除
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/35">
                        <span className="w-5 h-5 border-2 border-white/85 border-t-transparent rounded-full animate-spin" />
                        <span className="text-3xs text-white font-mono">
                          {task.status === 'compress' ? '压缩中' : `上传中 ${task.percent ?? 0}%`}
                        </span>
                      </div>
                    )}
                  </div>
                ))}

                {albumImages.length + albumTasks.length < ALBUM_LIMIT && (
                  <label
                    className={`aspect-square rounded-xl border-2 border-dashed border-wb-border-subtle flex flex-col items-center justify-center gap-1 cursor-pointer hover:border-wb-border-strong transition-colors ${
                      albumImages.length + albumTasks.length >= ALBUM_LIMIT ? 'opacity-60 pointer-events-none' : ''
                    }`}
                    title="添加图片（可多选，最多 10 张）"
                  >
                    {albumUploading ? (
                      <span className="w-4 h-4 border-2 border-wb-text-muted border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4 text-wb-text-muted" />
                    )}
                    <span className="text-3xs text-wb-text-muted">
                      {albumUploading ? '上传中' : '添加'}
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        // 必须先复制成数组：清空 value 会把 FileList 一起清掉，
                        // 这就是之前"点了没反应"的原因
                        const picked = Array.from(e.target.files || []);
                        e.target.value = '';
                        if (picked.length) uploadAlbumFiles(picked);
                      }}
                    />
                  </label>
                )}
              </div>

              <p className="text-3xs text-wb-text-muted mt-1.5">
                拖动图片可调整顺序 · 发布后按九宫格展示（1 张大图，2–4 张两列，5 张以上三列）
              </p>
            </div>

        </div>

        {/* 进阶配置栏 (统一采用符合黑白钛灰工业主题的 CustomDropdown) */}
        <div className="pt-4 border-t border-wb-border-subtle grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
          {/* 1. 所属板块分类 (与首页分类严格对齐) */}
          <CustomDropdown
            label="所属板块分类"
            value={categoryId}
            onChange={(val) => {
              setCategoryId(val);
              saveToLocal(title, contentMd, val);
            }}
            options={categoryOptions}
            icon={<Tag className="w-3.5 h-3.5" />}
          />

          {/* 问答广场：悬赏与名额说明（仅该板块显示，写帖流程与其它板块完全一致） */}
          {isQaCategory && (
            <div className="sm:col-span-2 lg:col-span-3 p-3 rounded-2xl bg-wb-warn/10 border border-wb-warn/25 space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-2xs font-bold text-wb-text-primary">问答广场 · 悬赏提问</span>
                <span className="text-3xs px-2 py-0.5 rounded-capsule bg-wb-warn/20 text-wb-warn font-semibold">
                  系统悬赏 {qaQuota?.bounty ?? 10} 经验
                </span>
              </div>
              <p className="text-3xs text-wb-text-secondary leading-relaxed">
                悬赏由系统经验池发放，<b>不消耗你的经验</b>。发布后进入 7 天采纳期，
                可勾选 1~{qaQuota?.max_accepted ?? 5} 个回答平分悬赏（除不尽向下取整，零头归系统积分池）；
                超时未采纳自动标记「已过期」并原路退回。你不能回答自己的问题，每位用户对同一问题只能回答一次。
              </p>
              <p className="text-3xs text-wb-text-muted">
                今日提问名额：{qaQuota?.quota?.unlimited ? '管理员不限次数'
                  : `${qaQuota?.quota?.used ?? 0} / ${qaQuota?.quota?.limit ?? 1}（剩余 ${qaQuota?.quota?.remaining ?? 1}）`}
                {qaQuota?.quota?.exchange_cost ? ` · 可用 ${qaQuota.quota.exchange_cost} 经验兑换额外次数` : ''}
              </p>
            </div>
          )}

          {/* 好文分享：文章来源与承诺书（仅该板块显示） */}
          {isShareCategory && (
            <div className="sm:col-span-2 lg:col-span-3 p-3 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-2xs font-semibold text-wb-text-primary">文章来源</span>
                <div className="inline-flex items-center p-0.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle">
                  {([['original', '原创'], ['repost', '转载']] as const).map(([k, label]) => (
                    <button key={k} type="button" onClick={() => setSourceType(k)}
                      className={`wb-pressable px-3 py-1 rounded-capsule text-2xs transition-all ${
                        sourceType === k ? 'bg-wb-text-primary text-wb-bg-page font-semibold' : 'text-wb-text-secondary hover:text-wb-text-primary'
                      }`}>{label}</button>
                  ))}
                </div>
              </div>
              {sourceType === 'repost' && (
                <input
                  value={sourceNote}
                  onChange={(e) => setSourceNote(e.target.value.slice(0, 500))}
                  placeholder="请注明文章来源（链接或出处），必填"
                  maxLength={500}
                  className="w-full h-9 px-3 rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-2xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong"
                />
              )}
              {sourceType && (
                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={sourceAck} onChange={(e) => setSourceAck(e.target.checked)}
                    className="mt-0.5 w-3.5 h-3.5 accent-current" />
                  <span className="text-3xs leading-relaxed text-wb-text-secondary">
                    我已知晓：本文内容由我自行发布并承担全部责任，因转载/引用引发的版权或法律问题与本站无关。
                  </span>
                </label>
              )}
              {sourceType && !sourceAck && (
                <p className="text-3xs text-wb-warn">需勾选「我已知晓」承诺书后才能发布</p>
              )}
            </div>
          )}

          {/* 2. 评论区权限策略 */}
          <CustomDropdown
            label="评论区权限"
            value={commentPolicy}
            onChange={(val) => setCommentPolicy(val)}
            options={commentOptions}
            icon={<MessageSquare className="w-3.5 h-3.5" />}
          />

          {/* 3. 专栏分类 (仅管理员可选早报) */}
          {isSuperAdmin && (
            <CustomDropdown
              label="内容专栏类型"
              value={postType}
              onChange={(val) => setPostType(val)}
              options={postTypeOptions}
              icon={<ShieldCheck className="w-3.5 h-3.5" />}
            />
          )}
        </div>

        {/* 附加投票控制 */}
        <div className="pt-2 border-t border-wb-border-subtle space-y-3">
          <label className="flex items-center gap-2 cursor-pointer select-none text-xs font-semibold text-wb-text-secondary">
            <input
              type="checkbox"
              checked={enablePoll}
              onChange={(e) => setEnablePoll(e.target.checked)}
              className="rounded border-wb-border-strong text-wb-text-primary focus:ring-0"
            />
            <BarChart2 className="w-4 h-4 text-wb-text-muted" />
            <span>发起附加投票</span>
          </label>

          {enablePoll && (
            <div className="p-4 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle space-y-3 animate-fade-in text-xs">
              <input
                type="text"
                value={pollTitle}
                onChange={(e) => setPollTitle(e.target.value)}
                placeholder="投票主题 (如: 下个版本最期待什么功能？)"
                className="w-full px-3 py-2 bg-wb-bg-surface border border-wb-border-subtle rounded-xl text-wb-text-primary focus:outline-none"
              />
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={pollIsMultiple}
                  onChange={(e) => setPollIsMultiple(e.target.checked)}
                  className="rounded border-wb-border-strong text-wb-text-primary focus:ring-0"
                />
                <span className="text-wb-text-secondary">允许多选</span>
                {pollIsMultiple && (
                  <span className="inline-flex items-center gap-1 ml-2">
                    <span className="text-wb-text-muted">最多可选</span>
                    <input
                      type="number"
                      min={2}
                      max={8}
                      value={pollMaxChoices}
                      onChange={(e) => setPollMaxChoices(parseInt(e.target.value, 10) || 2)}
                      className="w-14 px-2 py-0.5 bg-wb-bg-surface border border-wb-border-subtle rounded-lg text-wb-text-primary focus:outline-none"
                    />
                    <span className="text-wb-text-muted">项</span>
                  </span>
                )}
              </label>
              <div className="space-y-2">
                {pollOptions.map((opt, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={opt}
                      onChange={(e) => {
                        const next = [...pollOptions];
                        next[idx] = e.target.value;
                        setPollOptions(next);
                      }}
                      placeholder={`选项 ${idx + 1}`}
                      className="flex-1 px-3 py-1.5 bg-wb-bg-surface border border-wb-border-subtle rounded-xl text-wb-text-primary focus:outline-none"
                    />
                    {pollOptions.length > 2 && (
                      <button
                        type="button"
                        onClick={() => setPollOptions(pollOptions.filter((_, i) => i !== idx))}
                        className="p-1 text-wb-text-muted hover:text-wb-danger"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {pollOptions.length < 8 && (
                <button
                  type="button"
                  onClick={() => setPollOptions([...pollOptions, ''])}
                  className="inline-flex items-center gap-1 text-2xs font-medium text-wb-text-secondary hover:text-wb-text-primary"
                >
                  <Plus className="w-3 h-3" /> 添加更多选项
                </button>
              )}
            </div>
          )}
        </div>
      </form>

      {/* 创作者多草稿箱工作台弹窗 */}
      <DraftManagerModal
        isOpen={isDraftModalOpen}
        onClose={() => setIsDraftModalOpen(false)}
        drafts={multiDrafts}
        currentDraftId={currentDraftId}
        onLoadDraft={handleLoadDraft}
        onDeleteDraft={handleDeleteDraft}
        onClearAllDrafts={handleClearAllDrafts}
        onUpdateCurrentDraft={handleUpdateCurrentDraft}
        onSaveCurrentAsNewDraft={handleSaveCurrentAsNewDraft}
        canSaveCurrent={Boolean(title.trim() || contentMd.trim())}
      />
    </div>
  );
};
