import React, { useCallback, useEffect, useState } from 'react';
import { Bookmark, FolderPlus, Check, Trash2, X } from 'lucide-react';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { apiClient } from '../api/client';
import type { CollectionTarget } from '../utils/collection';
import { emitCollectionChanged, onCollectionChanged } from '../utils/collection';

interface Folder {
  name: string;
  count: number;
}

/** 全站唯一的收藏弹窗：选择收藏夹 / 新建收藏夹 / 取消收藏。 */
export const CollectionModalHost: React.FC = () => {
  const toast = useToast();
  const [target, setTarget] = useState<CollectionTarget | null>(null);
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [current, setCurrent] = useState<string>('默认收藏');
  const [isCollected, setIsCollected] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      setTarget((e as CustomEvent).detail as CollectionTarget);
      setOpen(true);
    };
    window.addEventListener('wb:open-collection', handler);
    return () => window.removeEventListener('wb:open-collection', handler);
  }, []);

  const load = useCallback(async (postId: string) => {
    try {
      const [fRes, cRes] = await Promise.all([
        apiClient.get('/users/me/collection-folders'),
        apiClient.get('/users/me/collections'),
      ]);
      setFolders(Array.isArray(fRes.data) ? fRes.data : []);
      const mine = Array.isArray(cRes.data)
        ? cRes.data.find((p: any) => p.id === postId)
        : null;
      setIsCollected(!!mine);
      setCurrent((mine as any)?.group_name || '默认收藏');
    } catch {
      setFolders([{ name: '默认收藏', count: 0 }]);
    }
  }, []);

  useEffect(() => {
    if (open && target) void load(target.id);
  }, [open, target, load]);

  // 别处的收藏状态变化同步到弹窗（例如同一文章在别的卡片被取消收藏）
  useEffect(() => onCollectionChanged((c) => {
    if (target?.id === c.postId) setIsCollected(c.is_collected);
  }), [target]);

  const close = () => { setOpen(false); setNewName(''); };

  const collectTo = async (folder: string) => {
    if (!target || busy) return;
    setBusy(true);
    try {
      await apiClient.post(`/posts/${target.id}/collect-to`, { folder });
      setCurrent(folder);
      setIsCollected(true);
      emitCollectionChanged({ postId: target.id, is_collected: true, group_name: folder });
      toast.success(`已收藏到「${folder}」`);
      setFolders(prev => prev.some(f => f.name === folder)
        ? prev.map(f => f.name === folder ? { ...f, count: f.count + (folder === current ? 0 : 1) } : f)
        : [...prev, { name: folder, count: 1 }]);
      close();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '收藏失败');
    } finally { setBusy(false); }
  };

  const createFolder = async () => {
    const name = newName.trim().slice(0, 32);
    if (!name) return toast.error('请输入收藏夹名称');
    if (folders.some(f => f.name === name)) return toast.error('同名收藏夹已存在');
    setBusy(true);
    try {
      await apiClient.post('/users/me/collection-folders', { name });
      setFolders(prev => [...prev, { name, count: 0 }]);
      setNewName('');
      toast.success(`已创建「${name}」`);
      await collectTo(name);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '创建失败');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      await apiClient.delete(`/posts/${target.id}/collect`);
      setIsCollected(false);
      emitCollectionChanged({ postId: target.id, is_collected: false });
      toast.success('已取消收藏');
      close();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '取消失败');
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={close} widthClass="max-w-md" labelledBy="collection-modal-title">
      <div className="rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Bookmark className="w-4 h-4 text-wb-text-primary shrink-0" />
              <h3 id="collection-modal-title" className="font-semibold text-sm text-wb-text-primary">加入收藏夹</h3>
            </div>
            <p className="text-2xs text-wb-text-muted mt-1 truncate">{target?.title || '文章'}</p>
          </div>
          <button type="button" onClick={close} aria-label="关闭" className="p-2 min-w-[44px] min-h-[44px] rounded-capsule hover:bg-wb-bg-subtle text-wb-text-muted flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-1.5 max-h-[300px] overflow-y-auto overscroll-contain">
          {folders.map(f => (
            <button
              key={f.name}
              type="button"
              disabled={busy}
              onClick={() => void collectTo(f.name)}
              aria-pressed={isCollected && current === f.name}
              className={`w-full min-h-[44px] flex items-center gap-3 px-3 py-2 rounded-2xl border text-left transition-colors disabled:opacity-50 ${
                isCollected && current === f.name
                  ? 'bg-wb-bg-subtle border-wb-border-strong'
                  : 'bg-transparent border-wb-border-subtle hover:bg-wb-bg-subtle/60'
              }`}
            >
              <Bookmark className={`w-3.5 h-3.5 shrink-0 ${isCollected && current === f.name ? 'text-wb-text-primary' : 'text-wb-text-muted'}`} />
              <span className="flex-1 text-xs font-medium text-wb-text-primary truncate">{f.name}</span>
              <span className="text-3xs text-wb-text-muted font-mono">{f.count}</span>
              {isCollected && current === f.name && <Check className="w-3.5 h-3.5 text-wb-success shrink-0" />}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 pt-1 border-t border-wb-border-subtle">
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void createFolder(); }}
            placeholder="新建收藏夹名称"
            aria-label="新建收藏夹名称"
            maxLength={32}
            className="min-w-0 flex-1 px-3 py-2 min-h-[44px] rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-xs outline-none focus:border-wb-border-strong"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void createFolder()}
            className="inline-flex items-center gap-1 px-3 py-2 min-h-[44px] rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-semibold disabled:opacity-50"
          >
            <FolderPlus className="w-3.5 h-3.5" /> 新建
          </button>
        </div>

        {isCollected && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            className="w-full min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-wb-danger/30 text-wb-danger text-xs font-semibold hover:bg-wb-danger/10 transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" /> 取消收藏
          </button>
        )}
      </div>
    </Modal>
  );
};
