import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, Trash2, Plus, Search, ShieldAlert, RefreshCw, Download } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmModal';
import { CustomDropdown } from './CustomDropdown';

const ACTION_OPTIONS = [
  { value: 'block', label: '拦截', description: '命中内容直接拦截' },
  { value: 'replace', label: '替换***', description: '命中部分替换为 ***' },
  { value: 'warn', label: '仅记录', description: '正常放行，仅记录日志' },
];

interface WordItem {
  id: number;
  word: string;
  category: string;
  action: 'block' | 'replace' | 'warn';
  created_at?: string | null;
}

const PAGE_SIZE = 50;

export const SensitiveWordsPanel: React.FC = () => {
  const toast = useToast();
  const confirm = useConfirm();

  const [items, setItems] = useState<WordItem[]>([]);
  const [total, setTotal] = useState(0);
  // 批量操作：ids 为空 + allSelected 表示「全库」
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [allSelected, setAllSelected] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);

  const [newWord, setNewWord] = useState('');
  const [newCategory, setNewCategory] = useState('general');
  const [newAction, setNewAction] = useState<'block' | 'replace' | 'warn'>('block');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  // 导入进度：大词库文件上传耗时较长，给出可见进度而不是干等
  const [importPercent, setImportPercent] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const fetchWords = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/admin/sensitive-words', {
        params: { page, size: PAGE_SIZE, q: keyword.trim() || undefined },
      });
      setItems(Array.isArray(res.data?.items) ? res.data.items : []);
      setTotal(Number(res.data?.total) || 0);
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '加载敏感词失败');
    } finally {
      setLoading(false);
    }
  }, [page, keyword, toast]);

  useEffect(() => {
    fetchWords();
  }, [fetchWords]);

  const handleAdd = async () => {
    const word = newWord.trim();
    if (!word) {
      toast.error('请输入敏感词');
      return;
    }
    setAdding(true);
    try {
      const res = await apiClient.post('/admin/sensitive-words', {
        words: [{ word, category: newCategory.trim() || 'general', action: newAction }],
      });
      toast.success(res.data?.message || '已添加');
      setNewWord('');
      setPage(1);
      fetchWords();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '添加失败');
    } finally {
      setAdding(false);
    }
  };

  const handleUpdate = async (item: WordItem, patch: Partial<WordItem>) => {
    // 先本地乐观更新，界面立刻响应
    setItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, ...patch } : x)));
    try {
      await apiClient.put(`/admin/sensitive-words/${item.id}`, patch);
      toast.success('已更新');
      // 再回读一次服务端数据：避免 PUT 返回 200 但实际未落库时，界面停留在错误状态
      fetchWords();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '更新失败');
      fetchWords(); // 失败也回读，把乐观更新还原成真实值
    }
  };

  const toggleSelect = (id: number) => {
    setAllSelected(false);
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleSelectPage = () => {
    const pageIds = items.map((i) => i.id);
    const allOnPage = pageIds.every((id) => selectedIds.includes(id));
    setAllSelected(false);
    setSelectedIds(allOnPage ? selectedIds.filter((id) => !pageIds.includes(id)) : Array.from(new Set([...selectedIds, ...pageIds])));
  };

  const selectAllTotal = () => {
    setAllSelected(true);
    setSelectedIds([]);
  };

  const runBulkAction = async (action: 'block' | 'replace' | 'warn') => {
    if (!allSelected && selectedIds.length === 0) {
      toast.warning('请先选择要处理的词条');
      return;
    }
    setBulkBusy(true);
    try {
      const res = await apiClient.post('/admin/sensitive-words/bulk-action', {
        ids: selectedIds,
        action,
        all: allSelected,
      });
      toast.success(`已更新 ${res.data?.updated ?? 0} 条`);
      // 先把命中的行就地改掉：即便随后的回读因网络/缓存异常返回旧值，界面也不会“假成功”
      const hitAll = allSelected;
      const hitIds = new Set(selectedIds);
      setItems((prev) =>
        prev.map((x) => (hitAll || hitIds.has(x.id) ? { ...x, action } : x))
      );
      setSelectedIds([]);
      setAllSelected(false);
      await fetchWords();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '批量更新失败');
    } finally {
      setBulkBusy(false);
    }
  };

  const runBulkDelete = async () => {
    const count = allSelected ? total : selectedIds.length;
    if (count === 0) {
      toast.warning('请先选择要删除的词条');
      return;
    }
    const ok = await confirm({
      title: '批量删除敏感词',
      description: allSelected
        ? `将删除全部 ${total} 条敏感词，此操作不可撤销。`
        : `将删除已选中的 ${selectedIds.length} 条敏感词，此操作不可撤销。`,
      confirmText: '确定删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      if (allSelected) {
        // 全库删除走独立接口：需要确认词，防止误触
        const res = await apiClient.post('/admin/sensitive-words/clear-all', { confirm: '清空敏感词库' });
        toast.success(`已清空 ${res.data?.deleted ?? 0} 条`);
      } else {
        const res = await apiClient.post('/admin/sensitive-words/bulk-delete', { ids: selectedIds });
        toast.success(`已删除 ${res.data?.deleted ?? 0} 条`);
      }
      const hitAllDel = allSelected;
      const hitIdsDel = new Set(selectedIds);
      setItems((prev) => prev.filter((x) => !(hitAllDel || hitIdsDel.has(x.id))));
      setSelectedIds([]);
      setAllSelected(false);
      await fetchWords();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '批量删除失败');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleDelete = async (item: WordItem) => {
    const ok = await confirm({
      title: '删除敏感词',
      description: `确定删除「${item.word}」吗？删除后该词将不再被拦截。`,
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/admin/sensitive-words/${item.id}`);
      toast.success('已删除');
      setItems((prev) => prev.filter((x) => x.id !== item.id));
      setTotal((prev) => Math.max(0, prev - 1));
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '删除失败');
    }
  };

  const handleImport = async (file: File) => {
    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      setImportPercent(0);
      const res = await apiClient.post('/admin/sensitive-words/import', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => {
          if (e.total) setImportPercent(Math.min(99, Math.round((e.loaded / e.total) * 100)));
        },
      });
      toast.success(res.data?.message || '导入完成');
      setPage(1);
      fetchWords();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '导入失败');
    } finally {
      setImporting(false);
      setImportPercent(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="p-4 md:p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-wb-text-primary" />
            <h3 className="font-semibold text-sm text-wb-text-primary">敏感词库</h3>
            <span className="text-2xs text-wb-text-muted font-mono">共 {total} 条</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={fetchWords}
              className="wb-pressable inline-flex items-center gap-1.5 h-8 px-3 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs text-wb-text-secondary hover:text-wb-text-primary"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={importing}
              className="wb-pressable inline-flex items-center gap-1.5 h-8 px-3 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" /> {importing ? (importPercent === null ? '导入中...' : `导入中 ${importPercent}%`) : '一键导入'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.txt,.csv,application/json,text/plain,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleImport(file);
              }}
            />
          </div>
        </div>

        <p className="text-2xs text-wb-text-muted leading-relaxed">
          支持 JSON / TXT / CSV 一键导入。JSON 示例：<code className="font-mono">[&quot;词1&quot;,&quot;词2&quot;]</code> 或{' '}
          <code className="font-mono">[{'{'}&quot;word&quot;:&quot;词&quot;,&quot;action&quot;:&quot;block&quot;{'}'}]</code>；
          文本每行一个词，也支持 <code className="font-mono">词,分类,动作</code>（动作：block / replace / warn）。
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
          <input
            value={newWord}
            onChange={(e) => setNewWord(e.target.value)}
            placeholder="输入敏感词"
            className="sm:col-span-5 h-9 px-3 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary"
          />
          <input
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="分类（如 abuse）"
            className="sm:col-span-3 h-9 px-3 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary"
          />
          <CustomDropdown
            size="md"
            className="sm:col-span-2"
            value={newAction}
            onChange={(v) => setNewAction(v as any)}
            options={ACTION_OPTIONS}
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={adding}
            className="sm:col-span-2 h-9 rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> {adding ? '添加中' : '添加'}
          </button>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-wb-text-muted" />
          <input
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setPage(1);
            }}
            placeholder="搜索词条"
            className="w-full h-9 pl-9 pr-3 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary"
          />
        </div>
      </div>

      <div className="rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card overflow-hidden">
        {loading ? (
          <p className="py-10 text-center text-xs text-wb-text-muted">加载中...</p>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-xs text-wb-text-muted">词库还是空的，先添加一个试试</p>
        ) : (
          <div className="divide-y divide-wb-border-subtle">
            {/* 批量工具栏 */}
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-wb-bg-subtle/60">
              <div className="flex items-center gap-2 text-2xs text-wb-text-secondary">
                <input
                  type="checkbox"
                  className="w-3.5 h-3.5 accent-current cursor-pointer"
                  checked={items.length > 0 && items.every((i) => selectedIds.includes(i.id))}
                  onChange={toggleSelectPage}
                  title="选择当前页"
                />
                <span>
                  {allSelected ? `已选全部 ${total} 条` : `已选 ${selectedIds.length} 条`}
                </span>
                {!allSelected && (
                  <button
                    type="button"
                    onClick={selectAllTotal}
                    className="px-2 py-0.5 rounded-capsule border border-wb-border-strong text-2xs font-semibold hover:bg-wb-bg-subtle"
                  >
                    选择全部 {total} 条
                  </button>
                )}
                {(selectedIds.length > 0 || allSelected) && (
                  <button
                    type="button"
                    onClick={() => { setSelectedIds([]); setAllSelected(false); }}
                    className="text-2xs text-wb-text-muted hover:text-wb-text-primary"
                  >
                    取消选择
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {(['block', 'replace', 'warn'] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    disabled={bulkBusy}
                    onClick={() => runBulkAction(a)}
                    className="px-2.5 py-1 rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle text-2xs text-wb-text-secondary hover:text-wb-text-primary hover:border-wb-border-strong disabled:opacity-40"
                  >
                    设为{ACTION_OPTIONS.find((o) => o.value === a)?.label}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={runBulkDelete}
                  className="px-2.5 py-1 rounded-capsule border border-wb-danger/30 bg-wb-danger/10 text-2xs text-wb-danger hover:bg-wb-danger/15 disabled:opacity-40"
                >
                  批量删除
                </button>
              </div>
            </div>
            {items.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0 flex items-center gap-2 flex-wrap">
                  <input
                    type="checkbox"
                    className="w-3.5 h-3.5 accent-current cursor-pointer shrink-0"
                    checked={allSelected || selectedIds.includes(item.id)}
                    onChange={() => toggleSelect(item.id)}
                  />
                  <span className="text-xs font-medium text-wb-text-primary break-all">{item.word}</span>
                  <span className="text-3xs px-1.5 py-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-muted font-mono">
                    {item.category}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <CustomDropdown
                    key={`${item.id}-${item.action}`}
                    size="xs"
                    value={item.action}
                    onChange={(v) => handleUpdate(item, { action: v as any })}
                    options={ACTION_OPTIONS}
                    menuWidth="w-48"
                  />
                  <button
                    type="button"
                    onClick={() => handleDelete(item)}
                    title="删除"
                    className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-danger hover:bg-wb-bg-subtle"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 text-2xs text-wb-text-muted">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="px-2.5 py-1 rounded-capsule border border-wb-border-subtle disabled:opacity-40"
          >
            上一页
          </button>
          <span className="font-mono">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="px-2.5 py-1 rounded-capsule border border-wb-border-subtle disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      )}

      <div className="flex items-center gap-1.5 text-3xs text-wb-text-muted">
        <Download className="w-3 h-3" />
        导入后立即生效，无需重启；调度器每 10 分钟还会兜底重载一次。
      </div>
    </div>
  );
};
