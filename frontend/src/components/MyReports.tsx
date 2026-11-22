import React, { useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import { ExternalLink, ShieldCheck, Clock, XCircle, CheckCircle2 } from 'lucide-react';

interface ReportItem {
  id: number;
  target_type: string;
  target_id: string;
  reason_label: string;
  description: string;
  image_url?: string | null;
  status: string;
  status_label: string;
  resolve_note: string;
  created_at: string;
  handled_at?: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-wb-warn/15 text-wb-warn border-wb-warn/30',
  resolved: 'bg-wb-success/15 text-wb-success border-wb-success/30',
  rejected: 'bg-wb-bg-surface text-wb-text-muted border-wb-border-subtle',
};

const STATUS_ICON: Record<string, React.ReactNode> = {
  pending: <Clock className="w-3 h-3" />,
  resolved: <CheckCircle2 className="w-3 h-3" />,
  rejected: <XCircle className="w-3 h-3" />,
};

/** 举报人查看自己提交的举报及处理进度（结果 + 处理理由） */
export const MyReports: React.FC = () => {
  const [items, setItems] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    apiClient.get('/users/me/reports', { params: { page: 1, size: 50 } })
      .then((res) => { if (alive) setItems(Array.isArray(res.data) ? res.data : []); })
      .catch(() => { if (alive) setItems([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  return (
    <div className="p-5 md:p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-wb-text-primary" />
        <h3 className="font-semibold text-sm text-wb-text-primary">我的举报</h3>
        <span className="text-2xs text-wb-text-muted">查看提交记录与处理结论</span>
      </div>

      {loading ? (
        <p className="text-xs text-wb-text-muted py-6 text-center">加载中…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-wb-text-muted py-6 text-center">你还没有提交过举报</p>
      ) : (
        <div className="space-y-3">
          {items.map((r) => (
            <div key={r.id} className="p-4 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-capsule border text-2xs font-semibold ${STATUS_STYLE[r.status] || STATUS_STYLE.pending}`}>
                  {STATUS_ICON[r.status] || STATUS_ICON.pending}
                  {r.status_label}
                </span>
                <span className="text-2xs text-wb-text-secondary">{r.reason_label}</span>
                <span className="text-3xs text-wb-text-muted font-mono ml-auto">
                  {new Date(r.created_at).toLocaleDateString('zh-CN')}
                </span>
              </div>
              <p className="text-xs text-wb-text-primary break-words">{r.description}</p>
              {r.image_url && (
                <a href={r.image_url} target="_blank" rel="noopener noreferrer" title="查看举报截图">
                  <img src={r.image_url} alt="举报截图" className="w-20 h-20 rounded-xl object-cover border border-wb-border-subtle" />
                </a>
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => window.open(`/?post=${r.target_id}`, '_blank', 'noopener,noreferrer')}
                  className="inline-flex items-center gap-1 text-2xs text-wb-brand hover:underline"
                >
                  <ExternalLink className="w-3 h-3" /> 查看被举报内容
                </button>
                <span className="text-3xs text-wb-text-muted font-mono">#{r.id}</span>
              </div>
              {r.status !== 'pending' && (
                <div className="pt-2 border-t border-wb-border-subtle text-2xs text-wb-text-secondary space-y-1">
                  <p>处理结论：{r.status === 'resolved' ? '已核实违规并处理' : '经核实未发现违规，举报已驳回'}</p>
                  {r.resolve_note && <p className="break-words">处理理由：{r.resolve_note}</p>}
                  {r.handled_at && (
                    <p className="text-3xs text-wb-text-muted">
                      处理时间：{new Date(r.handled_at).toLocaleString('zh-CN')}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
