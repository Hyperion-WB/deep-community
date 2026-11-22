import React, { useEffect, useState } from 'react';
import { ShieldCheck, Shield, UserCog, MessageCircle } from 'lucide-react';
import { apiClient } from '../api/client';
import { UserAvatar } from './UserAvatar';

interface Staff {
  username: string;
  nickname?: string | null;
  avatar_url?: string;
  level: number;
  role: string;
  role_label: string;
  is_online?: boolean;
}

const ROLE_STYLE: Record<string, { icon: React.ReactNode; cls: string }> = {
  super_admin: { icon: <ShieldCheck className="w-3 h-3" />, cls: 'bg-wb-danger/10 text-wb-danger border-wb-danger/30' },
  admin: { icon: <Shield className="w-3 h-3" />, cls: 'bg-wb-brand/10 text-wb-brand border-wb-brand/30' },
  // 版主拥有内容管理权限，与只做巡查的审计员区分开
  moderator: { icon: <Shield className="w-3 h-3" />, cls: 'bg-wb-brand/10 text-wb-brand border-wb-brand/30' },
  auditor: { icon: <UserCog className="w-3 h-3" />, cls: 'bg-wb-info/10 text-wb-info border-wb-info/30' },
};

/** 常驻工作人员：让普通用户能直接找到人联系，而不是只能搜 */
export const StaffDirectory: React.FC<{
  onSelectUser?: (username: string) => void;
  onMessage?: (username: string) => void;
}> = ({ onSelectUser, onMessage }) => {
  const [staff, setStaff] = useState<Staff[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiClient.get('/users/staff');
        if (alive) setStaff(Array.isArray(res.data) ? res.data : []);
      } catch {
        if (alive) setStaff([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!staff.length) return null;

  return (
    <div className="p-4 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-2.5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-3.5 h-3.5 text-wb-text-primary" />
        <h4 className="text-xs font-bold text-wb-text-primary">常驻工作人员</h4>
        <span className="text-3xs text-wb-text-muted">遇到问题可以直接找他们</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {staff.map((s) => {
          const style = ROLE_STYLE[s.role] || ROLE_STYLE.moderator;
          return (
            <div
              key={s.username}
              className="flex items-center gap-2.5 p-2 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle hover:border-wb-border-strong transition-colors group"
            >
              <button
                type="button"
                onClick={() => onSelectUser?.(s.username)}
                className="flex items-center gap-2.5 min-w-0 flex-1 text-left"
                title={`查看 @${s.username} 的主页`}
              >
                <div className="relative shrink-0">
                  <UserAvatar username={s.username} avatarUrl={s.avatar_url} size={32} />
                  {s.is_online && (
                    <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-wb-success ring-2 ring-wb-bg-surface" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-semibold text-wb-text-primary truncate group-hover:underline">
                      {s.nickname || s.username}
                    </span>
                    <span className={`inline-flex items-center gap-0.5 px-1 py-0.2 rounded text-[10px] border shrink-0 ${style.cls}`}>
                      {style.icon}
                      {s.role_label}
                    </span>
                  </div>
                  <p className="text-3xs text-wb-text-muted font-mono truncate">@{s.username} · Lv.{s.level}</p>
                </div>
              </button>
              {onMessage && (
                <button
                  type="button"
                  onClick={() => onMessage(s.username)}
                  className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-brand hover:bg-wb-bg-surface shrink-0"
                  title="发私信"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
