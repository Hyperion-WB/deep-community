import React from 'react';
import { Gift, Clock, CheckCircle2, AlertCircle, Coins } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmModal';

export interface QaState {
  is_qa?: boolean;
  bounty: number;
  status: string;
  expires_at?: string;
  days_left: number;
  accepted_count: number;
  remainder: number;
  is_asker: boolean;
  max_accepted: number;
  my_answer?: boolean;
}

const STATUS = {
  pending: { label: '待解决', cls: 'bg-wb-warn/15 text-wb-warn border-wb-warn/30', icon: Clock },
  solved: { label: '已解决', cls: 'bg-wb-success/15 text-wb-success border-wb-success/30', icon: CheckCircle2 },
  expired: { label: '已过期', cls: 'bg-wb-bg-subtle text-wb-text-muted border-wb-border-subtle', icon: AlertCircle },
  refunded: { label: '已退回', cls: 'bg-wb-bg-subtle text-wb-text-muted border-wb-border-subtle', icon: AlertCircle },
};

interface Props {
  postId: string;
  state: QaState;
  selectMode: boolean;
  selected: string[];
  onToggleSelectMode: () => void;
  onClearSelected: () => void;
  onSettled: () => void;
}

export const QaBountyCard: React.FC<Props> = ({
  postId, state, selectMode, selected, onToggleSelectMode, onClearSelected, onSettled,
}) => {
  const toast = useToast();
  const confirm = useConfirm();
  const st = STATUS[state.status as keyof typeof STATUS] || STATUS.pending;
  const Icon = st.icon;
  const canSettle = state.is_asker && state.status === 'pending' && state.days_left > 0;
  const per = selected.length ? Math.floor(state.bounty / selected.length) : 0;

  const settle = async () => {
    if (!selected.length) return toast.warning('请先勾选要采纳的回答');
    const ok = await confirm({
      title: '二次确认 · 采纳并结算悬赏',
      description: `将采纳 ${selected.length} 个回答，每人获得 ${per} 点全站经验，零头 ${state.bounty - per * selected.length} 点归系统积分池。结算后不可撤销，确认继续？`,
      confirmText: '确认结算', cancelText: '再想想',
    });
    if (!ok) return;
    try {
      const res = await apiClient.post(`/qa/posts/${postId}/settle`, {
        comment_ids: selected, confirm: true,
      });
      toast.success(`结算完成：${res.data.accepted} 人各得 ${res.data.per_person} 经验`);
      onClearSelected();
      onSettled();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '结算失败');
    }
  };

  return (
    <div className="p-3.5 rounded-2xl border border-wb-border-subtle bg-wb-bg-subtle/40 space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-capsule text-2xs font-bold border ${st.cls}`}>
          <Icon className="w-3 h-3" /> {st.label}
        </span>
        <span className="inline-flex items-center gap-1 text-2xs font-semibold text-wb-text-primary">
          <Gift className="w-3.5 h-3.5 text-wb-warn" /> {state.bounty} 经验悬赏
        </span>
        <span className="text-3xs text-wb-text-muted font-mono">由系统经验池发放 · 提问者不消耗经验</span>
      </div>

      <p className="text-3xs text-wb-text-muted leading-relaxed">
        {state.status === 'pending' && `采纳期剩 ${state.days_left} 天，可勾选 1~${state.max_accepted} 个回答平分悬赏；超时未采纳自动标记「已过期」并原路退回。`}
        {state.status === 'solved' && `已采纳 ${state.accepted_count} 个回答，零头 ${state.remainder} 点归系统积分池。`}
        {(state.status === 'expired' || state.status === 'refunded') && '悬赏已原路退回系统经验池。'}
      </p>

      {canSettle && (
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={onToggleSelectMode}
            className="wb-pressable h-8 px-3 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold">
            {selectMode ? '取消选择' : '勾选回答并采纳'}
          </button>
          {selectMode && (
            <>
              <span className="text-3xs text-wb-text-muted">
                已选 {selected.length}/{state.max_accepted} · 每人 <b className="text-wb-text-primary">{per}</b> 经验
              </span>
              <button type="button" onClick={() => void settle()} disabled={!selected.length}
                className="wb-pressable h-8 px-3 rounded-capsule bg-wb-success text-white text-2xs font-semibold inline-flex items-center gap-1 disabled:opacity-40">
                <Coins className="w-3.5 h-3.5" /> 确认采纳并结算
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
