import React, { useCallback, useEffect, useState } from 'react';
import { FolderCog, Pencil, Trash2, Merge, Check, X } from 'lucide-react';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { apiClient } from '../api/client';
import { emitCollectionChanged } from '../utils/collection';

interface Folder {
  name: string;
  count: number;
}

/** 收藏夹管理：重命名、合并、删除。 */
export const CollectionFolderManager: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const toast = useToast();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);
  const [mergeTo, setMergeTo] = useState('默认收藏');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get('/users/me/collection-folders');
      setFolders(Array.isArray(res.data) ? res.data : []);
    } catch { setFolders([]); }
  }, []);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const rename = async (from: string) => {
    const name = nameInput.trim();
    if (!name) return toast.error('名称不能为空');
    setBusy(true);
    try {
      await apiClient.put(`/users/me/collection-folders/${encodeURIComponent(from)}`, { name });
      toast.success('已重命名');
      setEditing(null); setNameInput('');
      await load();
    } catch (e: any) { toast.error(e?.response?.data?.detail || '重命名失败'); }
    finally { setBusy(false); }
  };

  const remove = async (name: string) => {
    setBusy(true);
    try {
      await apiClient.delete(`/users/me/collection-folders/${encodeURIComponent(name)}`);
      toast.success('已删除，夹内文章移回默认收藏');
      await load();
      emitCollectionChanged({ postId: '', is_collected: true, group_name: '默认收藏' });
    } catch (e: any) { toast.error(e?.response?.data?.detail || '删除失败'); }
    finally { setBusy(false); }
  };

  const merge = async () => {
    if (!mergeFrom) return;
    setBusy(true);
    try {
      const res = await apiClient.post('/users/me/collection-folders/merge', {
        source: mergeFrom, target: mergeTo,
      });
      toast.success(`已合并 ${res.data?.moved ?? 0} 篇到「${mergeTo}」`);
      setMergeFrom(null); setMergeTo('默认收藏');
      await load();
    } catch (e: any) { toast.error(e?.response?.data?.detail || '合并失败'); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} widthClass="max-w-lg" labelledBy="folder-manager-title">
      <div className="rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <FolderCog className="w-4 h-4 text-wb-text-primary" />
          <h3 id="folder-manager-title" className="font-semibold text-sm text-wb-text-primary">管理收藏夹</h3>
        </div>

        <div className="space-y-2 max-h-[360px] overflow-y-auto overscroll-contain">
          {folders.map(f => (
            <div key={f.name} className="p-2.5 rounded-2xl border border-wb-border-subtle space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-xs font-semibold text-wb-text-primary truncate">{f.name}</span>
                <span className="text-3xs text-wb-text-muted font-mono">{f.count}</span>
                {f.name !== '默认收藏' && (
                  <>
                    <button type="button" aria-label={`重命名 ${f.name}`} onClick={() => { setEditing(f.name); setNameInput(f.name); }} className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"><Pencil className="w-3 h-3" /></button>
                    <button type="button" aria-label={`合并 ${f.name}`} onClick={() => { setMergeFrom(f.name); setMergeTo('默认收藏'); }} className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-info hover:bg-wb-info/10"><Merge className="w-3 h-3" /></button>
                    <button type="button" aria-label={`删除 ${f.name}`} onClick={() => void remove(f.name)} className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-danger hover:bg-wb-danger/10"><Trash2 className="w-3 h-3" /></button>
                  </>
                )}
              </div>
              {editing === f.name && (
                <div className="flex items-center gap-1.5">
                  <input
                    value={nameInput}
                    onChange={e => setNameInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void rename(f.name); }}
                    aria-label="新名称"
                    className="min-w-0 flex-1 px-2 py-1.5 rounded-lg bg-wb-bg-subtle border border-wb-border-subtle text-2xs outline-none"
                  />
                  <button type="button" onClick={() => void rename(f.name)} className="p-1.5 rounded-lg bg-wb-text-primary text-wb-bg-page"><Check className="w-3 h-3" /></button>
                  <button type="button" onClick={() => setEditing(null)} className="p-1.5 rounded-lg bg-wb-bg-subtle border border-wb-border-subtle"><X className="w-3 h-3" /></button>
                </div>
              )}
              {mergeFrom === f.name && (
                <div className="flex items-center gap-1.5">
                  <span className="text-3xs text-wb-text-muted shrink-0">合并到</span>
                  <select
                    value={mergeTo}
                    onChange={e => setMergeTo(e.target.value)}
                    aria-label="合并目标收藏夹"
                    className="min-w-0 flex-1 px-2 py-1.5 rounded-lg bg-wb-bg-subtle border border-wb-border-subtle text-2xs outline-none"
                  >
                    {folders.filter(x => x.name !== f.name).map(x => (
                      <option key={x.name} value={x.name}>{x.name}</option>
                    ))}
                  </select>
                  <button type="button" disabled={busy} onClick={() => void merge()} className="px-2 py-1.5 rounded-lg bg-wb-text-primary text-wb-bg-page text-2xs font-semibold">合并</button>
                  <button type="button" onClick={() => setMergeFrom(null)} className="p-1.5 rounded-lg bg-wb-bg-subtle border border-wb-border-subtle"><X className="w-3 h-3" /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
};
