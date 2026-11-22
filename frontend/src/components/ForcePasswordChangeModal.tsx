import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { KeyRound, ShieldAlert, Loader2 } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';
import { PasswordHint } from './PasswordHint';

interface Props {
  open: boolean;
  onSuccess: () => void;
}

/**
 * 首次部署使用默认口令时的强制改密弹窗。
 * 后端在 must_change_password=true 时会拒绝除改密/自查/登出外的所有接口，
 * 因此这里不能关闭，必须改完密码才能继续使用。
 */
export const ForcePasswordChangeModal: React.FC<Props> = ({ open, onSuccess }) => {
  const toast = useToast();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      toast.warning('新密码至少 8 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.warning('两次输入的新密码不一致');
      return;
    }
    if (newPassword === oldPassword) {
      toast.warning('新密码不能与初始密码相同');
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.put('/users/me/password', {
        old_password: oldPassword,
        new_password: newPassword,
      });
      toast.success('密码修改成功，请使用新密码重新登录');
      onSuccess();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '修改失败，请检查原密码是否正确');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70">
      <motion.form
        role="dialog"
        aria-modal="true"
        onSubmit={handleSubmit}
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="w-full max-w-md bg-wb-bg-surface border border-wb-border-strong rounded-3xl shadow-2xl overflow-hidden"
      >
        <div className="px-6 py-4 border-b border-wb-border-subtle flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-wb-warn/10 text-wb-warn border border-wb-warn/20">
            <ShieldAlert className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-bold text-sm text-wb-text-primary">首次登录 · 必须修改初始密码</h3>
            <p className="text-2xs text-wb-text-muted">
              当前账号仍在使用部署时的初始口令，修改后才能继续使用社区功能。
            </p>
          </div>
        </div>

        <div className="p-6 space-y-3">
          {[
            { label: '当前密码（初始口令）', value: oldPassword, set: setOldPassword },
            { label: '新密码（至少 8 位）', value: newPassword, set: setNewPassword },
            { label: '确认新密码', value: confirmPassword, set: setConfirmPassword },
          ].map((field) => (
            <label key={field.label} className="block space-y-1.5">
              <span className="text-xs font-semibold text-wb-text-primary">{field.label}</span>
              <input
                type="password"
                value={field.value}
                onChange={(e) => field.set(e.target.value)}
                autoComplete="new-password"
                className="w-full px-3.5 py-2.5 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary focus:outline-none focus:ring-2 focus:ring-wb-brand/30 focus:border-wb-brand transition-all"
              />
            </label>
          ))}
          {/* 新密码规则实时打勾，避免提交后才被打回 */}
          <PasswordHint value={newPassword} />
          <p className="text-2xs text-wb-text-muted leading-relaxed">
            修改成功后所有设备的登录状态都会失效，需要用新密码重新登录。
          </p>
        </div>

        <div className="px-6 py-4 border-t border-wb-border-subtle flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="wb-pressable px-5 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-bold disabled:opacity-60 flex items-center gap-1.5"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
            <span>{submitting ? '提交中…' : '修改并重新登录'}</span>
          </button>
        </div>
      </motion.form>
    </div>,
    document.body
  );
};
