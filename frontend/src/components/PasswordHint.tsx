import React, { useMemo } from 'react';
import { Check, X } from 'lucide-react';

/**
 * 密码规则小提醒：输入时实时打勾，让用户在提交前就知道要满足什么。
 *
 * 规则与后端 app/core/password_policy.py 保持一致（后端才是最终裁决方），
 * 这里只做即时反馈，避免"填完点提交才被打回"的挫败感。
 */

// 与后端 WEAK_PASSWORDS 对齐的常见项（前端只做提示，不追求穷举）
const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd',
  '12345678', '123456789', '1234567890', '11111111', '00000000',
  '88888888', '12341234', '11223344', '87654321',
  'qwertyui', 'qwerty123', 'qwertyuiop', '1qaz2wsx', 'zaq12wsx',
  'asdfghjk', 'asdf1234', 'abc12345', 'abcd1234', 'a1234567',
  'admin123', 'admin1234', 'root1234', 'test1234', 'guest123',
  'welcome1', 'welcome123', 'iloveyou', 'letmein1', 'qazwsxedc',
  '1q2w3e4r', 'woaini1314', '5201314520',
]);

interface Props {
  value: string;
  username?: string;
  email?: string;
  className?: string;
}

export const PasswordHint: React.FC<Props> = ({ value, username = '', email = '', className = '' }) => {
  const checks = useMemo(() => {
    const v = value || '';
    const lowered = v.toLowerCase();
    const identities = [username, email.includes('@') ? email.split('@')[0] : '']
      .map((s) => (s || '').trim().toLowerCase())
      .filter((s) => s.length >= 3);

    return [
      { key: 'len', label: '至少 8 个字符', ok: v.length >= 8 },
      {
        key: 'mix',
        label: '同时包含字母和数字',
        ok: /[A-Za-z]/.test(v) && /\d/.test(v),
      },
      {
        key: 'ident',
        label: '不含用户名或邮箱前缀',
        ok: v.length > 0 && !identities.some((i) => lowered.includes(i)),
      },
      {
        key: 'weak',
        label: '不是常见弱口令',
        ok: v.length > 0 && !WEAK_PASSWORDS.has(lowered),
      },
    ];
  }, [value, username, email]);

  const passed = checks.filter((c) => c.ok).length;

  return (
    <div className={`mt-2 space-y-1.5 ${className}`}>
      {/* 四段式强度条：一眼看出还差多少 */}
      <div className="flex items-center gap-1">
        {checks.map((c) => (
          <span
            key={c.key}
            className={`h-1 flex-1 rounded-full transition-colors ${
              c.ok ? 'bg-wb-success/70' : 'bg-wb-border-subtle'
            }`}
          />
        ))}
        <span className="ml-1 text-3xs text-wb-text-muted font-mono shrink-0">
          {passed}/{checks.length}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {checks.map((c) => (
          <span
            key={c.key}
            className={`flex items-center gap-1 text-3xs transition-colors ${
              c.ok ? 'text-wb-success' : 'text-wb-text-muted'
            }`}
          >
            {c.ok ? <Check className="w-3 h-3 shrink-0" /> : <X className="w-3 h-3 shrink-0 opacity-60" />}
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
};
