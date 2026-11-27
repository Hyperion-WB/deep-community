import React, { useEffect, useState } from 'react';
import { CircleCheck, GitBranch, Link2 } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';

/** 站内已登录后手动绑定 Gitee（P0 收紧自动合并后补的正规绑定入口）。 */
export const GiteeBindCard: React.FC<{ bound?: boolean }> = ({ bound }) => {
  const toast = useToast();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (bound !== false) return;
    const controller = new AbortController();
    apiClient.get('/auth/gitee/enabled', { signal: controller.signal })
      .then(res => { if (!controller.signal.aborted) setEnabled(res.data?.enabled === true); })
      .catch(() => { if (!controller.signal.aborted) setEnabled(false); });
    return () => controller.abort();
  }, [bound]);

  const startBind = async () => {
    setBusy(true);
    try {
      const res = await apiClient.post('/auth/gitee/bind/prepare');
      const state = res.data?.state;
      if (!state) throw new Error('缺少绑定状态');
      window.location.href = `/api/auth/gitee/bind?state=${encodeURIComponent(state)}`;
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '发起绑定失败，请稍后再试');
      setBusy(false);
    }
  };

  if (bound === undefined || (!bound && !enabled)) return null;

  return (
    <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-2">
      <div className="flex items-center gap-2">
        <GitBranch className="w-4 h-4 text-wb-text-primary" />
        <h3 className="font-semibold text-sm text-wb-text-primary">第三方账号</h3>
      </div>
      {bound ? (
        <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-wb-success">
          <CircleCheck className="w-3.5 h-3.5" aria-hidden="true" /> 已绑定 Gitee
        </p>
      ) : (
        <>
          <p className="text-2xs text-wb-text-muted leading-relaxed">
            绑定后可用 Gitee 一键登录当前账号。绑定需要你在站内已登录，不会按邮箱自动合并其他账号。
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void startBind()}
            className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-xl bg-wb-bg-subtle hover:bg-wb-bg-surface border border-wb-border-subtle text-xs font-semibold text-wb-text-secondary hover:text-wb-text-primary transition-colors disabled:opacity-50"
          >
            <Link2 className="w-3.5 h-3.5" />
            {busy ? '正在跳转…' : '绑定 Gitee'}
          </button>
        </>
      )}
    </div>
  );
};
