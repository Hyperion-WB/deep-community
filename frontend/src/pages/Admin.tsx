const REPORT_PAGE_SIZE = 20;
import React, { useState, useEffect, useRef } from 'react';
import {
  ShieldCheck,
  Shield,
  KeyRound,
  AlertTriangle,
  Search,
  Check,
  Ban,
  UserCheck,
  Terminal,
  Sparkles,
  Volume2,
  Eye,
  EyeOff,
  Trash2,
  Sliders,
  ExternalLink,
  RefreshCw,
  Cloud,
  CheckCircle2,
  XCircle,
  HardDrive,
  ChevronDown,
  ImageOff,
  PenLine,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { apiClient } from '../api/client';
import type { UserProfile, UserAdminItem, UserRole, UserStatus } from '../types';
import { LevelBadge } from '../components/LevelBadge';
import { SegmentedControl } from '../components/SegmentedControl';
import { OpsDashboard } from '../components/OpsDashboard';
import { MedalAdminPanel } from '../components/MedalAdminPanel';
import { FriendLinksPanel } from '../components/FriendLinksPanel';
import { SensitiveWordsPanel } from '../components/SensitiveWordsPanel';
import { AIAdminPanel } from '../components/AIAdminPanel';
import { UserAvatar } from '../components/UserAvatar';
import { useConfirm } from '../components/ConfirmModal';
import { CustomDropdown } from '../components/CustomDropdown';
import { SensitiveReviewPanel } from '../components/SensitiveReviewPanel';

interface Props {
  user: UserProfile | null;
  onSelectUser?: (username: string) => void;
}

/**
 * 用户管理页的「重置」下拉框。
 * 超级管理员：重置密码 / 重置头像 / 重置昵称；管理员：重置头像 / 重置昵称。
 * 放在行内用绝对定位展开，点击外部或 Esc 收起。
 */
const UserResetMenu: React.FC<{
  username: string;
  isSuperAdmin: boolean;
  onResetPassword: () => void;
  onResetAvatar: () => void;
  onResetNickname: () => void;
}> = ({ username, isSuperAdmin, onResetPassword, onResetAvatar, onResetNickname }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const itemClass =
    'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-2xs font-semibold text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors text-left whitespace-nowrap';

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`重置 @${username} 的资料`}
        className={`wb-pressable h-7 px-2.5 text-2xs font-semibold rounded-capsule border flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors ${
          open
            ? 'bg-wb-text-primary text-wb-bg-page border-wb-text-primary'
            : 'bg-wb-info/10 hover:bg-wb-info/20 text-wb-info border-wb-info/30'
        }`}
      >
        <RefreshCw className="w-3 h-3 shrink-0" />
        <span>重置</span>
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1.5 z-[70] w-40 p-1 rounded-xl bg-wb-bg-surface border border-wb-border-strong shadow-2xl space-y-0.5"
        >
          {isSuperAdmin && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onResetPassword();
              }}
              className={itemClass}
            >
              <KeyRound className="w-3.5 h-3.5 text-wb-info shrink-0" />
              重置密码
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onResetAvatar();
            }}
            className={itemClass}
          >
            <ImageOff className="w-3.5 h-3.5 text-wb-warn shrink-0" />
            重置头像
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onResetNickname();
            }}
            className={itemClass}
          >
            <PenLine className="w-3.5 h-3.5 text-wb-brand shrink-0" />
            重置昵称
          </button>
          <p className="px-2.5 pt-1 pb-0.5 text-[10px] leading-tight text-wb-text-muted">
            重置后对方可额外修改 1 次昵称
          </p>
        </div>
      )}
    </div>
  );
};

// 治理中枢的页签/筛选/页码写入 URL：刷新或从别处返回时不再回到默认视图
const ADMIN_TABS = ['users', 'rules', 'reports', 'audit', 'system', 'ops', 'medals', 'sensitive', 'review', 'links', 'ai'];
const ADMIN_QUERY_KEYS = [
  'adminTab',
  'adminRole',
  'adminStatus',
  'adminSearch',
  'adminPage',
  'reportStatus',
  'reportPage',
];

const readAdminQuery = (key: string): string => {
  try {
    return new URLSearchParams(window.location.search).get(key) || '';
  } catch {
    return '';
  }
};

const readAdminPage = (key: string): number => {
  const n = parseInt(readAdminQuery(key), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

export const Admin: React.FC<Props> = ({ user, onSelectUser }) => {
  const confirm = useConfirm();
  const [activeTab, setActiveTab] = useState<string>(() => {
    const t = readAdminQuery('adminTab');
    return ADMIN_TABS.includes(t) ? t : 'users';
  });

  // 页码/页签写进了 URL，前进后退时要把 state 同步回来
  useEffect(() => {
    const onPop = () => {
      try {
        const t = new URLSearchParams(window.location.search).get('adminTab');
        if (t && ADMIN_TABS.includes(t)) setActiveTab(t);
      } catch {}
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 用户与权限列表
  const [userList, setUserList] = useState<UserAdminItem[]>([]);
  const [userSearch, setUserSearch] = useState(() => readAdminQuery('adminSearch'));
  // 实际生效的搜索词（防抖后），与输入框分离，避免逐字打接口
  const [userSearchTerm, setUserSearchTerm] = useState(() => readAdminQuery('adminSearch'));
  const [roleFilter, setRoleFilter] = useState<string>(() => readAdminQuery('adminRole') || 'all');
  const [statusFilter, setStatusFilter] = useState<string>(() => readAdminQuery('adminStatus') || 'all');
  // Tab 栏横向拖拽滚动：桌面端 overflow 容器没有滚动条，鼠标拖不动
  const tabScrollRef = useRef<HTMLDivElement | null>(null);
  const tabDrag = useRef({ down: false, startX: 0, left: 0, moved: false });
  // Tab 栏：鼠标滚轮在标签栏上滚动时转为横向滚动（桌面端无横向滚轮）
  // 注意：必须放在组件顶部的无条件区域，不能放在早退 return 之后（违反 Hooks 规则）
  useEffect(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [activeTab]);
  // 用户管理分页：此前固定只取前 50 条，第 51 个之后的用户永远无法被管理
  const [userPage, setUserPage] = useState<number>(() => readAdminPage('adminPage'));
  const [hasMoreUsers, setHasMoreUsers] = useState<boolean>(false);
  const USER_PAGE_SIZE = 50;
  const [loadingUsers, setLoadingUsers] = useState(false);

  // 待审举报
  const [reports, setReports] = useState<any[]>([]);
  const [reportStatus, setReportStatus] = useState<'pending' | 'resolved' | 'rejected'>(() => {
    const s = readAdminQuery('reportStatus');
    return s === 'resolved' || s === 'rejected' ? s : 'pending';
  });
  const [reportPage, setReportPage] = useState(() => readAdminPage('reportPage'));
  const [reportHasMore, setReportHasMore] = useState(false);
  const [loadingReports, setLoadingReports] = useState(false);
  // 处置备注按行独立，避免把 A 的备注填到 B 身上
  const [reportNotes, setReportNotes] = useState<Record<number, string>>({});
  const [resolvingReportId, setResolvingReportId] = useState<number | null>(null);
  // 页签角标用的真实待处理总数（不受当前分页影响）
  const [pendingReportCount, setPendingReportCount] = useState(0);

  // 邀请码与全站公告及更新日志
  const [inviteCodes, setInviteCodes] = useState<string[]>([]);
  const [announcementTitle, setAnnouncementTitle] = useState('');
  const [announcementText, setAnnouncementText] = useState('');
  const [announcementLevel, setAnnouncementLevel] = useState<'info' | 'update' | 'warning'>('update');
  const [announcementIsActive, setAnnouncementIsActive] = useState(true);
  const [announcementsList, setAnnouncementsList] = useState<any[]>([]);

  // 对象存储 (Cloudflare R2 / S3) 状态与连通性测试
  interface StorageStatus {
    storage_type: string;
    s3_enabled?: boolean;
    is_s3: boolean;
    s3_endpoint: string | null;
    s3_bucket: string | null;
    s3_public_domain: string | null;
    s3_region: string;
    has_access_key: boolean;
    has_secret_key: boolean;
  }
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [testingStorage, setTestingStorage] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; latency_ms?: number } | null>(null);

  // 社区规则与经验配置
  const [settingsList, setSettingsList] = useState<Record<string, string>>({
    daily_post_limit: '5',
    daily_exp_limit: '60',
    post_exp_reward: '15',
  });
  const [savingSettings, setSavingSettings] = useState(false);

  // 匿名穿透审计输入
  const [auditCommentId, setAuditCommentId] = useState('');
  const [auditReason, setAuditReason] = useState('');
  const [auditResult, setAuditResult] = useState<any>(null);

  // 全局 Toast 提示（复用同一个定时器，避免旧定时器把新提示提前清掉 + 卸载后 setState）
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 2400);
  };
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // 删除与清空用户弹窗状态 (仅限最高管理员 + 4位数字验证码校验 + 5秒确认倒计时)
  const [userToDelete, setUserToDelete] = useState<UserAdminItem | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [inputCode, setInputCode] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteCountdown, setDeleteCountdown] = useState(5);
  const [deletingUser, setDeletingUser] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const generateCaptcha = () => Math.floor(1000 + Math.random() * 9000).toString();

  // 5 秒安全倒计时与验证码初始化
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    if (userToDelete) {
      setDeleteCountdown(5);
      setVerifyCode(generateCaptcha());
      setInputCode('');
      setDeletePassword('');
      setDeleteError('');
      timer = setInterval(() => {
        setDeleteCountdown((prev) => {
          if (prev <= 1) {
            if (timer) clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [userToDelete]);

  const handleConfirmDeleteUser = async () => {
    if (!userToDelete) return;
    if (!inputCode.trim()) {
      setDeleteError('请输入上方四位数字验证码以验证身份');
      return;
    }
    if (inputCode.trim() !== verifyCode) {
      setDeleteError('验证码输入不正确，请重新输入');
      return;
    }
    if (!deletePassword.trim()) {
      setDeleteError('请输入当前账号的登录密码以确认身份');
      return;
    }
    if (deleteCountdown > 0) {
      setDeleteError('请等待 5 秒安全倒计时结束');
      return;
    }

    setDeletingUser(true);
    setDeleteError('');
    try {
      await apiClient.delete(`/admin/users/${userToDelete.id}`, {
        data: { code: inputCode, password: deletePassword },
      });
      showToast(`@${userToDelete.username} 已进入 10 天注销缓冲期，可随时恢复`);
      setUserToDelete(null);
      fetchUsers();
    } catch (err: any) {
      const msg = err.response?.data?.detail || '删除用户失败，请重试';
      setDeleteError(msg);
      showToast(msg);
    } finally {
      setDeletingUser(false);
    }
  };

  // 恢复处于注销缓冲期的账号（仅超管）：还原状态与全部内容可见性
  const handleRestoreUser = async (target: UserAdminItem) => {
    try {
      const res = await apiClient.post(`/admin/users/${target.id}/restore`);
      showToast(res.data?.message || `已恢复用户 @${target.username}`);
      fetchUsers();
    } catch (err: any) {
      showToast(err.response?.data?.detail || '恢复失败，请重试');
    }
  };

  // 与后端 get_current_root_admin 对齐：删号/角色任免/保存全站配置仅超管可用。
  // 此前把 admin 也算作"超管"，导致普通管理员能看见这些控件、点下去必然 403。
  const isSuperAdmin = user?.role === 'super_admin';
  // 与后端 get_current_moderator 对齐：auditor 只读，不能改状态/等级
  const canModerateBackend = ['super_admin', 'admin', 'moderator'].includes(user?.role || '');
  const isAdmin = ['super_admin', 'admin', 'moderator', 'auditor'].includes(user?.role || '');

  // 获取用户列表
  const fetchUsers = async () => {
    if (!isAdmin) return;
    setLoadingUsers(true);
    try {
      const params = new URLSearchParams();
      if (userSearchTerm) params.append('search', userSearchTerm);
      if (roleFilter !== 'all') params.append('role', roleFilter);
      if (statusFilter !== 'all') params.append('status', statusFilter);
      params.append('limit', String(USER_PAGE_SIZE));
      params.append('offset', String((userPage - 1) * USER_PAGE_SIZE));
      const res = await apiClient.get(`/admin/users?${params.toString()}`);
      if (Array.isArray(res.data)) {
        setUserList(res.data);
        setHasMoreUsers(res.data.length >= USER_PAGE_SIZE);
      }
    } catch {
      // 容错保持
    } finally {
      setLoadingUsers(false);
    }
  };

  // 获取举报列表（按状态筛选 + 分页）
  const fetchReports = async (status = reportStatus, page = reportPage) => {
    if (!isAdmin) return;
    setLoadingReports(true);
    try {
      const res = await apiClient.get('/admin/reports', {
        params: { status, limit: REPORT_PAGE_SIZE, offset: (page - 1) * REPORT_PAGE_SIZE },
      });
      const list = Array.isArray(res.data) ? res.data : [];
      setReports(list);
      setReportHasMore(list.length >= REPORT_PAGE_SIZE);
      apiClient.get('/admin/reports/pending-count')
        .then((r) => setPendingReportCount(Number(r.data?.count || 0)))
        .catch(() => undefined);
    } catch {
      /* 容错 */
    } finally {
      setLoadingReports(false);
    }
  };

  // 获取公告列表
  const fetchAnnouncementsList = async () => {
    if (!isAdmin) return;
    try {
      const res = await apiClient.get('/admin/announcements');
      if (Array.isArray(res.data)) {
        setAnnouncementsList(res.data);
      }
    } catch {}
  };

  // 获取对象存储状态
  const fetchStorageStatus = async () => {
    if (!isAdmin) return;
    try {
      const res = await apiClient.get('/admin/storage/status');
      setStorageStatus(res.data);
    } catch {}
  };

  const handleTestStorage = async () => {
    setTestingStorage(true);
    setTestResult(null);
    try {
      const res = await apiClient.post('/admin/storage/test');
      setTestResult(res.data);
      if (res.data.success) {
        showToast('🎉 对象存储连通性测试通过！');
      } else {
        showToast(`⚠️ 测试未通过: ${res.data.message}`);
      }
    } catch (err: any) {
      setTestResult({
        success: false,
        message: err?.response?.data?.detail || err.message || '网络请求异常',
      });
      showToast('⚠️ 测试请求发生异常');
    } finally {
      setTestingStorage(false);
    }
  };

  // 获取社区规则与经验配置
  const fetchSettings = async () => {
    if (!isAdmin) return;
    try {
      const res = await apiClient.get('/admin/settings');
      if (Array.isArray(res.data)) {
        const dict: Record<string, string> = {};
        res.data.forEach((item: any) => {
          dict[item.key] = item.value;
        });
        setSettingsList((prev) => ({ ...prev, ...dict }));
      }
    } catch {}
  };

  // 输入防抖：停止输入 350ms 后才提交搜索词并回到第一页（首帧跳过，避免覆盖 URL 恢复的页码）
  const searchDebounceMounted = useRef(false);
  useEffect(() => {
    if (!searchDebounceMounted.current) {
      searchDebounceMounted.current = true;
      return;
    }
    const timer = setTimeout(() => {
      setUserSearchTerm(userSearch.trim());
      setUserPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [userSearch]);

  // 页签/筛选/页码/搜索词同步到 URL，刷新或分享后能回到同一视图
  useEffect(() => {
    if (!isAdmin) return;
    try {
      const url = new URL(window.location.href);
      const put = (key: string, value: string | number, fallback: string | number) => {
        if (value === '' || value === fallback) url.searchParams.delete(key);
        else url.searchParams.set(key, String(value));
      };
      put('adminTab', activeTab, 'users');
      put('adminRole', roleFilter, 'all');
      put('adminStatus', statusFilter, 'all');
      put('adminSearch', userSearchTerm, '');
      put('adminPage', userPage, 1);
      put('reportStatus', reportStatus, 'pending');
      put('reportPage', reportPage, 1);
      if (url.toString() !== window.location.href) {
        window.history.replaceState({}, '', url.toString());
      }
    } catch {}
  }, [isAdmin, activeTab, roleFilter, statusFilter, userSearchTerm, userPage, reportStatus, reportPage]);

  // 离开治理中枢时清理管理端参数，避免污染其它页面的地址
  useEffect(() => {
    return () => {
      try {
        const url = new URL(window.location.href);
        ADMIN_QUERY_KEYS.forEach((k) => url.searchParams.delete(k));
        window.history.replaceState({}, '', url.toString());
      } catch {}
    };
  }, []);

  // 非超管不保留运维/勋章页签（可能是旧链接或书签带入）
  useEffect(() => {
    if (!isSuperAdmin && (activeTab === 'ops' || activeTab === 'medals' || activeTab === 'sensitive' || activeTab === 'links' || activeTab === 'review' || activeTab === 'ai')) {
      setActiveTab('users');
    }
  }, [isSuperAdmin, activeTab]);

  // 成员列表：只在成员页拉取，且随筛选/分页/搜索词变化
  useEffect(() => {
    if (isAdmin && activeTab === 'users') fetchUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, activeTab, roleFilter, statusFilter, userPage, userSearchTerm]);

  // 举报/公告/配置：只在进入相关页签时拉一次，避免每次输入搜索词都全量重拉
  useEffect(() => {
    if (isAdmin && activeTab !== 'ops' && activeTab !== 'medals') {
      fetchReports();
      fetchAnnouncementsList();
      fetchSettings();
    }
    // 运维面板自带数据加载；存储状态接口仅超管可读，普通管理员不必发这次必然 403 的请求
    if (isAdmin && isSuperAdmin) fetchStorageStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, isSuperAdmin, activeTab]);

  // 修改用户等级与经验 (超管与管理员)
  const handleChangeLevel = async (targetUser: UserAdminItem, newLevel: number) => {
    if (!isAdmin) return;
    if (!isSuperAdmin && ['super_admin', 'admin'].includes(targetUser.role)) {
      showToast('你不是超级管理员，没有调整管理员等级的权限');
      return;
    }
    try {
      const res = await apiClient.put(`/admin/users/${targetUser.id}/level`, { level: newLevel });
      showToast(`已将 ${targetUser.username} 的极客等级调整为 Lv.${newLevel}`);
      setUserList((prev) =>
        prev.map((u) =>
          u.id === targetUser.id
            ? { ...u, level: newLevel, experience: res.data?.experience ?? u.experience }
            : u
        )
      );
    } catch (err: any) {
      showToast(err.response?.data?.detail || '等级调整失败');
    }
  };

  // 保存社区规则与经验配置 (仅限超管)
  const handleSaveSettings = async () => {
    if (!isSuperAdmin) {
      showToast('只有最高管理员拥有修改全站规则与经验限制的权限');
      return;
    }
    setSavingSettings(true);
    try {
      await apiClient.put('/admin/settings', settingsList);
      showToast('全站规则与经验限制配置已成功更新并实时生效！');
    } catch (err: any) {
      showToast(err.response?.data?.detail || '配置保存失败');
    } finally {
      setSavingSettings(false);
    }
  };

  // 修改用户角色 (仅限超管)
  const handleChangeRole = async (targetUser: UserAdminItem, newRole: UserRole) => {
    if (!isSuperAdmin) {
      showToast('只有最高管理员 (Super Admin) 拥有任命管理角色的权限');
      return;
    }
    if (targetUser.id === user?.id && newRole !== 'super_admin') {
      showToast('不可降级自身最高管理员角色');
      return;
    }
    try {
      await apiClient.put(`/admin/users/${targetUser.id}/role`, { role: newRole });
      showToast(`已将 ${targetUser.username} 的职位任命为: ${newRole}`);
      setUserList((prev) =>
        prev.map((u) => (u.id === targetUser.id ? { ...u, role: newRole } : u))
      );
    } catch (err: any) {
      showToast(err.response?.data?.detail || '任命失败');
    }
  };

  // 调整用户状态 (一键转正 / 见习 / 封禁)
  const handleChangeStatus = async (targetUser: UserAdminItem, newStatus: UserStatus) => {
    // 管理员之间不能互相处置：给出明确原因，而不是什么都不发生
    if (!isSuperAdmin && ['super_admin', 'admin'].includes(targetUser.role)) {
      showToast('你不是超级管理员，没有调整管理员账号状态的权限');
      return;
    }
    if (['super_admin', 'admin'].includes(targetUser.role) && newStatus === 'banned') {
      showToast('不可封禁最高管理员账号');
      return;
    }
    if (targetUser.id === user?.id && newStatus !== 'active') {
      showToast('不可将自身账号状态修改为见习或封禁');
      return;
    }
    try {
      await apiClient.put(`/admin/users/${targetUser.id}/status`, { status: newStatus });
      const statusLabels: Record<string, string> = {
        active: '正式会员 (已晋升激活)',
        probation: '见习期',
        banned: '已封禁',
      };
      showToast(`用户 @${targetUser.username} 状态已更新为: ${statusLabels[newStatus] || newStatus}`);
      setUserList((prev) =>
        prev.map((u) => (u.id === targetUser.id ? { ...u, status: newStatus } : u))
      );
    } catch (err: any) {
      showToast(err.response?.data?.detail || '状态调整失败');
    }
  };

  // 处理举报（终态在 UI 上不可再点，后端也有幂等兜底）
  const handleResolveReport = async (reportId: number, action: 'block_target' | 'reject') => {
    if (resolvingReportId !== null) return;
    if (action === 'block_target') {
      const ok = window.confirm('确认对该举报执行「下架处罚」吗？\n将下架被举报内容并扣除作者 50 经验，该操作不可撤销。');
      if (!ok) return;
    }
    setResolvingReportId(reportId);
    const note = (reportNotes[reportId] || '').trim();
    try {
      const res = await apiClient.post(`/admin/reports/${reportId}/resolve`, null, {
        params: { action, note },
      });
      if (res.data?.idempotent) {
        showToast('该举报已处置完毕，无需重复操作');
      } else {
        showToast('举报处置完毕，已回执举报人与被处置者');
      }
      // 重新拉列表与角标，避免本地移除导致筛选/分页状态错乱
      await fetchReports(reportStatus, reportPage);
    } catch (err: any) {
      showToast(err.response?.data?.detail || '处理失败');
    } finally {
      setResolvingReportId(null);
      setReportNotes((prev) => {
        const next = { ...prev };
        delete next[reportId];
        return next;
      });
    }
  };

  // 生成邀请码
  const handleGenerateInvites = async () => {
    try {
      const res = await apiClient.post('/admin/invite-codes?count=10');
      setInviteCodes(res.data.codes);
      showToast('邀请码签发成功，30 天有效');
    } catch (err: any) {
      showToast(err.response?.data?.detail || '生成失败');
    }
  };

  // 发布全站公告与更新日志
  const handleUpdateAnnouncement = async () => {
    if (!announcementTitle.trim() && !announcementText.trim()) {
      showToast('请至少填写公告标题或详细内容');
      return;
    }
    try {
      await apiClient.post('/admin/announcements', {
        title: announcementTitle.trim(),
        content: announcementText.trim() || announcementTitle.trim(),
        level: announcementLevel,
        is_active: announcementIsActive,
      });
      setAnnouncementTitle('');
      setAnnouncementText('');
      showToast('全站公告/更新日志已成功发布');
      fetchAnnouncementsList();
      window.dispatchEvent(new Event('announcement_updated'));
    } catch (err: any) {
      showToast(err.response?.data?.detail || '发布失败');
    }
  };

  const handleToggleAnnouncement = async (annId: number) => {
    try {
      await apiClient.patch(`/admin/announcements/${annId}/toggle`);
      fetchAnnouncementsList();
      window.dispatchEvent(new Event('announcement_updated'));
      showToast('公告状态已切换');
    } catch {
      showToast('操作失败');
    }
  };

  // 仅超级管理员：重置某用户口令为初始口令，并强制其下次登录修改
  const handleResetPassword = async (m: any) => {
    const ok = await confirm({
      title: '重置用户口令',
      description: `将为 @${m.username} 生成一个随机临时口令，其当前登录会话会立即失效；下次登录会弹出强制修改密码窗口，必须改密后才能继续操作。\n重置完成后请把临时口令转告对方。`,
      confirmText: '确认重置',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.post(`/admin/users/${m.id}/reset-password`);
      showToast(`已重置 @${m.username} 的口令`);
      void fetchUsers();
    } catch (e: any) {
      showToast(e?.response?.data?.detail || '重置失败');
    }
  };

  // 管理员 / 超级管理员：重置用户头像（清空后恢复系统默认徽章）
  const handleResetAvatar = async (m: any) => {
    const ok = await confirm({
      title: '重置用户头像',
      description: `将清空 @${m.username} 的头像，恢复为系统默认徽章。\n重置后对方可额外修改 1 次昵称（即使本月 3 次额度已用完）。`,
      confirmText: '确认重置',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.post(`/admin/users/${m.id}/reset-avatar`);
      showToast(`已重置 @${m.username} 的头像`);
      void fetchUsers();
    } catch (e: any) {
      showToast(e?.response?.data?.detail || '重置头像失败');
    }
  };

  // 管理员 / 超级管理员：重置用户昵称（回退为用户名），并补 1 次修改机会
  const handleResetNickname = async (m: any) => {
    const ok = await confirm({
      title: '重置用户昵称',
      description: `将把 @${m.username} 的昵称恢复为默认（即用户名）。\n重置不消耗对方本月额度，并额外补 1 次昵称修改机会，方便其重新设置。`,
      confirmText: '确认重置',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.post(`/admin/users/${m.id}/reset-nickname`);
      showToast(`已重置 @${m.username} 的昵称`);
      void fetchUsers();
    } catch (e: any) {
      showToast(e?.response?.data?.detail || '重置昵称失败');
    }
  };

  const handleDeleteAnnouncement = async (annId: number) => {
    const ok = await confirm({
      title: '删除全站公告',
      description: '确定要删除该条全站公告吗？此操作无法撤销。',
      confirmText: '确定删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/admin/announcements/${annId}`);
      fetchAnnouncementsList();
      window.dispatchEvent(new Event('announcement_updated'));
      showToast('公告已成功删除');
    } catch {
      showToast('删除失败');
    }
  };

  // 穿透解密
  const handleAuditAnonymous = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuditResult(null);
    try {
      const res = await apiClient.get(
        `/admin/audit/comment/${auditCommentId}?reason=${encodeURIComponent(auditReason)}`
      );
      setAuditResult(res.data);
      showToast('穿透审计完成，已记录操作痕迹');
    } catch (err: any) {
      showToast(err.response?.data?.detail || '穿透解密失败，请核实评论 ID');
    }
  };

  // 刷新直接进入 /?tab=admin 时用户信息尚未回填，先显示校验中，避免闪一下"无权访问"
  if (!user) {
    return (
      <div className="max-w-md mx-auto py-24 px-4 text-center text-xs text-wb-text-muted font-mono">
        正在校验管理权限...
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="max-w-md mx-auto py-24 px-4 text-center space-y-4">
        <div className="w-12 h-12 rounded-capsule bg-wb-danger/10 border border-wb-danger/20 text-wb-danger flex items-center justify-center mx-auto">
          <Ban className="w-5 h-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-bold text-wb-text-primary">无权访问社区治理中枢</h2>
          <p className="text-xs text-wb-text-muted">
            本控制台仅面向超级管理员、板块版主与风控审计员开放
          </p>
        </div>
      </div>
    );
  }

  const TABS = [
    { key: 'users', label: '用户管理' },
    { key: 'rules', label: '社区规则' },
    { key: 'reports', label: '举报处置' },
    { key: 'audit', label: '审计' },
    { key: 'system', label: '公告管理' },
    ...(user?.role === 'super_admin' ? [{ key: 'ops', label: '运维管理' }] : []),
    ...(user?.role === 'super_admin' ? [{ key: 'medals', label: '成就勋章' }] : []),
    ...(user?.role === 'super_admin' ? [{ key: 'sensitive', label: '敏感词' }] : []),
    ...(user?.role === 'super_admin' ? [{ key: 'review', label: '内容复审' }] : []),
    ...(user?.role === 'super_admin' ? [{ key: 'links', label: '友情链接' }] : []),
  ...(user?.role === 'super_admin' ? [{ key: 'ai', label: 'AI 管理' }] : []),
  ];

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      {/* 头部权限标识栏 */}
      <div className="p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Terminal className="w-5 h-5 text-wb-text-primary" />
              <h2 className="text-lg font-bold text-wb-text-primary font-mono tracking-tight">
                COMMUNITY GOVERNANCE HUB
              </h2>
            </div>
            <p className="text-xs text-wb-text-muted">
              极客社区多级自治中枢 · 当前操作员：
              <span className="font-semibold text-wb-text-primary mx-1">{user?.username}</span>
              <LevelBadge level={user?.level || 0} role={user?.role} size="sm" />
            </p>
          </div>

          <div className="text-right">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle font-mono text-2xs text-wb-text-secondary">
              <span className="w-1.5 h-1.5 rounded-full bg-wb-success animate-pulse" />
              {user?.role === 'super_admin'
                ? '最高总控 (Super Admin)'
                : user?.role === 'admin'
                ? '管理员 (Admin)'
                : user?.role === 'moderator'
                ? '板块版主 (Moderator)'
                : '风控审计员 (Auditor)'}
            </span>
          </div>
        </div>

        {/* 顶部多标签页切换：窄屏用下拉，避免 8 个标签横向滚动找不到入口 */}
        <div className="pt-2 border-t border-wb-border-subtle">
          <div className="sm:hidden">
            {/* 窄屏模块切换：使用全站统一的 CustomDropdown，替换原生 select 以保持视觉一致 */}
            <CustomDropdown
              value={activeTab}
              onChange={(value) => setActiveTab(String(value))}
              placeholder="选择管理模块"
              options={TABS.map((tab) => ({ value: tab.key, label: tab.label }))}
            />
          </div>
          <div
            ref={tabScrollRef}
            className="hidden sm:flex justify-start overflow-x-auto overflow-y-hidden no-scrollbar -mx-2 px-2 pr-4 cursor-grab active:cursor-grabbing select-none"
            style={{ overflowY: 'hidden', scrollbarWidth: 'none' }}
            onPointerDown={(e) => {
              const el = tabScrollRef.current;
              if (!el) return;
              tabDrag.current = { down: true, startX: e.clientX, left: el.scrollLeft, moved: false };
            }}
            onPointerMove={(e) => {
              const el = tabScrollRef.current;
              if (!el || !tabDrag.current.down) return;
              const dx = e.clientX - tabDrag.current.startX;
              if (Math.abs(dx) > 4) {
                tabDrag.current.moved = true;
                e.preventDefault();
              }
              el.scrollLeft = tabDrag.current.left - dx;
            }}
            onPointerUp={() => { tabDrag.current.down = false; }}
            onPointerLeave={() => { tabDrag.current.down = false; }}
            onClickCapture={(e) => {
              // 拖拽结束后拦截本次 click，避免误触切到别的 Tab
              if (tabDrag.current.moved) {
                e.stopPropagation();
                e.preventDefault();
                tabDrag.current.moved = false;
              }
            }}
          >
            <SegmentedControl
              id="admin-tabs"
              items={TABS.map((t) => ({
                ...t,
                label: t.key === 'reports' && pendingReportCount > 0 ? (
                  <span className="inline-flex items-center gap-1">
                    {t.label}
                    <span className="min-w-[16px] h-4 px-1 rounded-full bg-wb-danger text-white text-3xs font-bold inline-flex items-center justify-center">
                      {pendingReportCount > 99 ? '99+' : pendingReportCount}
                    </span>
                  </span>
                ) : t.label,
              }))}
              activeKey={activeTab}
              onChange={(k) => setActiveTab(k)}
            />
          </div>
        </div>
      </div>

      {/* Tab 1: 极客成员与多级角色任免 */}
      {activeTab === 'users' && (
        <div className="space-y-4 animate-fade-in">
          {/* 筛选与搜索工具条 */}
          <div className="p-4 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle shadow-card flex flex-col sm:flex-row gap-3 items-center justify-between">
            <div className="relative w-full sm:w-64">
              <input
                type="text"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const next = userSearch.trim();
                  // 立即查询：跳过防抖窗口，保证回车后看到的就是新关键词的结果
                  if (next === userSearchTerm) fetchUsers();
                  else {
                    setUserSearchTerm(next);
                    setUserPage(1);
                  }
                }}
                placeholder="搜索用户名或邮箱..."
                className="w-full h-8 pl-8 pr-3 text-xs rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-primary focus:outline-none focus:border-wb-text-primary"
              />
              <Search className="w-3.5 h-3.5 text-wb-text-muted absolute left-2.5 top-2.5" />
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto flex-wrap">
              <CustomDropdown
                size="sm"
                value={roleFilter}
                onChange={(val) => {
                  setRoleFilter(val);
                  setUserPage(1);
                }}
                options={[
                  { value: 'all', label: '全部角色' },
                  { value: 'super_admin', label: '超级管理员' },
                  { value: 'moderator', label: '版主' },
                  { value: 'auditor', label: '审计员' },
                  { value: 'user', label: '普通会员' },
                ]}
                menuWidth="w-36"
              />

              <CustomDropdown
                size="sm"
                value={statusFilter}
                onChange={(val) => {
                  setStatusFilter(val);
                  setUserPage(1);
                }}
                options={[
                  { value: 'all', label: '全部状态' },
                  { value: 'active', label: '正式 (Active)' },
                  { value: 'probation', label: '见习 (Probation)' },
                  { value: 'banned', label: '封禁 (Banned)' },
                  { value: 'deleting', label: '待删除 (Deleting)' },
                ]}
                menuWidth="w-36"
              />

              <button
                type="button"
                onClick={() => {
                  const next = userSearch.trim();
                  if (next === userSearchTerm) fetchUsers();
                  else {
                    setUserSearchTerm(next);
                    setUserPage(1);
                  }
                }}
                className="wb-pressable h-8 px-3.5 text-xs font-semibold rounded-capsule bg-wb-text-primary text-wb-bg-page flex-shrink-0"
              >
                查询
              </button>
            </div>
          </div>

          {/* 成员卡片列表 */}
          <div className="space-y-3">
            {loadingUsers ? (
              <div className="p-12 text-center text-xs text-wb-text-muted">加载成员数据中...</div>
            ) : userList.length === 0 ? (
              <div className="p-12 text-center text-xs text-wb-text-muted rounded-3xl bg-wb-bg-surface border border-wb-border-subtle">
                没有找到匹配的成员
              </div>
            ) : (
              userList.map((m) => (
                <div
                  key={m.id}
                  className="rounded-2xl bg-wb-bg-surface border border-wb-border-subtle hover:border-wb-border-strong/60 transition-all shadow-card text-xs flex flex-col relative focus-within:z-30 hover:z-20"
                >
                  {/* 上半部分：成员基础档案信息与快捷操作 */}
                  <div className="p-4 md:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 rounded-t-2xl">
                    <div className="flex items-center gap-3.5 min-w-0">
                      <button
                        type="button"
                        onClick={() => onSelectUser?.(m.username)}
                        className="shrink-0 transition-transform hover:scale-105 cursor-pointer focus:outline-none"
                        title={`访问 @${m.username} 的极客主页`}
                      >
                        <UserAvatar username={m.username} avatarUrl={m.avatar_url} size="md" />
                      </button>
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            type="button"
                            onClick={() => onSelectUser?.(m.username)}
                            className="font-bold text-wb-text-primary text-sm hover:text-wb-brand transition-colors text-left flex items-center gap-1 group/name cursor-pointer focus:outline-none"
                            title={`访问 @${m.username} 的极客主页`}
                          >
                            <span className="group-hover/name:underline underline-offset-2">
                              {m.nickname || m.username}
                            </span>
                            <ExternalLink className="w-3 h-3 text-wb-text-muted opacity-0 group-hover/name:opacity-100 transition-opacity shrink-0" />
                          </button>
                          {m.nickname && (
                            <button
                              type="button"
                              onClick={() => onSelectUser?.(m.username)}
                              className="text-xs text-wb-text-muted font-mono hover:text-wb-text-primary transition-colors cursor-pointer focus:outline-none"
                              title={`访问 @${m.username} 的极客主页`}
                            >
                              @{m.username}
                            </button>
                          )}
                          <LevelBadge level={m.level} role={m.role} size="sm" />

                          <span
                            className={`px-2 py-0.5 rounded-capsule font-mono text-3xs font-semibold shrink-0 ${
                              m.status === 'deleting'
                                ? 'bg-wb-danger/10 text-wb-danger dark:text-wb-danger'
                                : m.status === 'banned'
                                ? 'bg-wb-danger/10 text-wb-danger'
                                : m.status === 'probation'
                                ? 'bg-wb-warn/10 text-wb-warn dark:text-wb-warn'
                                : 'bg-wb-success/10 text-wb-success dark:text-wb-success'
                            }`}
                          >
                            {m.status === 'deleting'
                              ? `待删除 · 剩 ${m.purge_after ? Math.max(0, Math.ceil((new Date(m.purge_after).getTime() - Date.now()) / 86400000)) : 0} 天`
                              : m.status === 'banned'
                              ? '已封禁'
                              : m.status === 'probation'
                              ? '见习期'
                              : '正式会员'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2.5 text-wb-text-muted font-mono text-2xs flex-wrap">
                          <span>{m.email}</span>
                          <span className="text-wb-border-strong">·</span>
                          <span>活跃 {m.active_days} 天</span>
                          <span className="text-wb-border-strong">·</span>
                          <span className="text-wb-brand font-medium">{m.experience} EXP</span>
                        </div>
                      </div>
                    </div>

                    {/* 右侧快捷治理操作（访问主页 / 一键转正 / 封禁账号） */}
                    <div className="flex items-center gap-2 self-start sm:self-center shrink-0 pt-1 sm:pt-0">
                      {onSelectUser && (
                        <button
                          type="button"
                          onClick={() => onSelectUser(m.username)}
                          title={`访问 @${m.username} 的个人主页`}
                          className="wb-pressable h-7 px-2.5 text-2xs font-semibold rounded-capsule bg-wb-bg-subtle hover:bg-wb-capsule-track text-wb-text-secondary hover:text-wb-text-primary border border-wb-border-subtle flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                        >
                          <ExternalLink className="w-3 h-3 shrink-0" />
                          <span>访问主页</span>
                        </button>
                      )}

                      {m.status === 'probation' && (
                        <button
                          type="button"
                          onClick={() => handleChangeStatus(m, 'active')}
                          title="一键直接将该会员由见习期晋升为正式会员"
                          className="wb-pressable h-7 px-3 text-2xs font-semibold rounded-capsule bg-wb-success/15 hover:bg-wb-success/25 text-wb-success dark:text-wb-success border border-wb-success/30 flex items-center gap-1.5 transition-all shadow-xs whitespace-nowrap shrink-0"
                        >
                          <UserCheck className="w-3.5 h-3.5 shrink-0" />
                          <span className="whitespace-nowrap font-bold">一键转正</span>
                        </button>
                      )}

                      {['super_admin', 'admin'].includes(user?.role || '') &&
                        m.id !== user?.id &&
                        // 普通管理员不能重置管理团队账号（与后端校验保持一致）
                        !(user?.role === 'admin' && ['super_admin', 'admin'].includes(m.role)) && (
                        <UserResetMenu
                          username={m.username}
                          isSuperAdmin={isSuperAdmin}
                          onResetPassword={() => handleResetPassword(m)}
                          onResetAvatar={() => handleResetAvatar(m)}
                          onResetNickname={() => handleResetNickname(m)}
                        />
                      )}

                      {m.status === 'banned' ? (
                        <button
                          type="button"
                          onClick={() => handleChangeStatus(m, 'active')}
                          className="wb-pressable h-7 px-3 text-2xs font-semibold rounded-capsule bg-wb-bg-subtle hover:bg-wb-capsule-track text-wb-text-primary border border-wb-border-subtle flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
                        >
                          <UserCheck className="w-3.5 h-3.5 text-wb-success shrink-0" />
                          <span>解除封禁</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleChangeStatus(m, 'banned')}
                          disabled={['super_admin', 'admin'].includes(m.role)}
                          className="wb-pressable h-7 px-3 text-2xs font-semibold rounded-capsule bg-wb-bg-subtle hover:bg-wb-danger/10 text-wb-danger border border-wb-border-subtle hover:border-wb-danger/30 disabled:opacity-30 disabled:pointer-events-none flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
                        >
                          <Ban className="w-3.5 h-3.5 shrink-0" />
                          <span>封禁账号</span>
                        </button>
                      )}

                      {/* 最高管理员专属：恢复缓冲期账号 / 删除用户 */}
                      {isSuperAdmin && m.id !== user?.id && !['super_admin', 'admin'].includes(m.role) && (
                        m.status === 'deleting' ? (
                          <button
                            type="button"
                            onClick={() => handleRestoreUser(m)}
                            title="恢复该账号：状态与全部内容重新可见"
                            className="wb-pressable h-7 px-2.5 text-2xs font-semibold rounded-capsule bg-wb-success/15 hover:bg-wb-success/25 text-wb-success dark:text-wb-success border border-wb-success/30 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                          >
                            <UserCheck className="w-3.5 h-3.5 shrink-0" />
                            <span>恢复账号</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setUserToDelete(m)}
                            title="最高管理员专属：置入 10 天注销缓冲期（期间可恢复）"
                            className="wb-pressable h-7 px-2.5 text-2xs font-semibold rounded-capsule bg-wb-bg-subtle hover:bg-wb-danger/15 text-wb-danger dark:text-wb-danger border border-wb-border-subtle hover:border-wb-danger/30 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5 shrink-0" />
                            <span>删除用户</span>
                          </button>
                        )
                      )}
                    </div>
                  </div>

                  {/* 下半部分：治理配置工具栏 (状态 / 角色 / 等级经验调整) */}
                  <div className="px-4 md:px-5 py-2.5 bg-wb-bg-subtle/50 border-t border-wb-border-subtle/70 flex items-center gap-3 md:gap-4 flex-wrap rounded-b-2xl">
                    <div className="flex items-center gap-1.5 text-2xs font-semibold text-wb-text-secondary shrink-0">
                      <Shield className="w-3.5 h-3.5 text-wb-brand" />
                      <span>权限配置:</span>
                    </div>

                    <div className="h-3 w-px bg-wb-border-subtle hidden sm:block" />

                    {/* 会员状态快速修改 (正式 / 见习 / 封禁) */}
                    {canModerateBackend && (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-2xs text-wb-text-muted flex-shrink-0">状态:</span>
                      <CustomDropdown
                        size="xs"
                        align="left"
                        value={m.status}
                        onChange={(val) => handleChangeStatus(m, val as UserStatus)}
                        options={[
                          { value: 'active', label: '正式会员', badge: 'Active' },
                          { value: 'probation', label: '见习期', badge: '考核中' },
                          { value: 'banned', label: '已封禁', badge: '锁号' },
                        ]}
                        menuWidth="w-36"
                      />
                    </div>
                    )}

                    {/* 角色任免 (超管专属特权) */}
                    {isSuperAdmin && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-2xs text-wb-text-muted flex-shrink-0">角色:</span>
                        <CustomDropdown
                          size="xs"
                          align="left"
                          value={m.role}
                          onChange={(val) => handleChangeRole(m, val as UserRole)}
                          options={[
                            { value: 'user', label: '普通会员', badge: 'Member' },
                            { value: 'moderator', label: '版主 (Moderator)', badge: '管理' },
                            { value: 'auditor', label: '审计员 (Auditor)', badge: '审计' },
                            { value: 'super_admin', label: '超级管理员', badge: 'Root' },
                          ]}
                          menuWidth="w-48"
                        />
                      </div>
                    )}

                    {/* 等级设置：与后端 get_current_moderator 对齐 */}
                    {canModerateBackend && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-2xs text-wb-text-muted flex-shrink-0">等级经验:</span>
                        <CustomDropdown
                          size="xs"
                          align="left"
                          value={String(m.level ?? 1)}
                          onChange={(val) => handleChangeLevel(m, parseInt(val, 10))}
                          options={[
                            { value: '0', label: 'Lv.0 见习', badge: '0 EXP' },
                            { value: '1', label: 'Lv.1 探索者', badge: '1 EXP' },
                            { value: '2', label: 'Lv.2 先锋', badge: '100 EXP' },
                            { value: '3', label: 'Lv.3 创作者', badge: '300 EXP' },
                            { value: '4', label: 'Lv.4 专家', badge: '800 EXP' },
                            { value: '5', label: 'Lv.5 大佬', badge: '2000 EXP' },
                            { value: '6', label: 'Lv.6 满级/宗师', badge: '5000 EXP' },
                          ]}
                          menuWidth="w-44"
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}

            {/* 成员列表分页：超过 50 人后可翻页，避免第 51 位之后的用户无法管理 */}
            {!loadingUsers && userList.length > 0 && (
              <div className="flex items-center justify-between gap-3 pt-1 text-2xs text-wb-text-muted">
                <span className="font-mono">
                  第 {userPage} 页 · 本页 {userList.length} 人
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={userPage <= 1}
                    onClick={() => setUserPage((p) => Math.max(1, p - 1))}
                    className="wb-pressable px-3 py-1.5 rounded-capsule border border-wb-border-subtle bg-wb-bg-surface hover:border-wb-border-strong text-wb-text-secondary hover:text-wb-text-primary disabled:opacity-40 disabled:pointer-events-none transition-colors"
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    disabled={!hasMoreUsers}
                    onClick={() => setUserPage((p) => p + 1)}
                    className="wb-pressable px-3 py-1.5 rounded-capsule border border-wb-border-subtle bg-wb-bg-surface hover:border-wb-border-strong text-wb-text-secondary hover:text-wb-text-primary disabled:opacity-40 disabled:pointer-events-none transition-colors"
                  >
                    下一页
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 对象存储与图床中枢 (Cloudflare R2 / S3) —— 仅最高管理员可见 */}
          {user?.role === 'super_admin' && (
          <div className="md:col-span-2 p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4 text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-wb-border-subtle">
              <div className="space-y-1">
                <h4 className="font-bold text-sm text-wb-text-primary flex items-center gap-2">
                  <Cloud className="w-4 h-4 text-wb-info" />
                  对象存储中枢 (Cloudflare R2 / S3 双模引擎)
                </h4>
                <p className="text-wb-text-muted">
                  统一纳管社区图片与头像资产。支持无缝热切换本地磁盘目录与 Cloudflare R2 / AWS S3 云端存储。
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={`px-2.5 py-1 rounded-capsule text-xs font-semibold flex items-center gap-1.5 ${
                  storageStatus?.is_s3
                    ? 'bg-wb-info/10 text-wb-info border border-wb-info/20'
                    : 'bg-wb-success/10 text-wb-success dark:text-wb-success border border-wb-success/20'
                }`}>
                  {storageStatus?.is_s3 ? <Cloud className="w-3.5 h-3.5" /> : <HardDrive className="w-3.5 h-3.5" />}
                  当前存储引擎: {storageStatus?.is_s3 ? 'Cloudflare R2 / S3' : '本地持久化存储 (local)'}
                </span>
                <button
                  type="button"
                  disabled={testingStorage}
                  onClick={handleTestStorage}
                  className="wb-pressable h-8 px-3 rounded-capsule bg-wb-bg-subtle hover:bg-wb-bg-surface border border-wb-border-subtle text-wb-text-primary font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${testingStorage ? 'animate-spin' : ''}`} />
                  <span>{testingStorage ? '正在测试连通性...' : '一键连通性自检'}</span>
                </button>
              </div>
            </div>

            {/* 状态详情指标格 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="p-3 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle space-y-1">
                <div className="text-2xs text-wb-text-muted">存储模式 (STORAGE_TYPE)</div>
                <div className="font-mono font-semibold text-wb-text-primary text-xs">
                  {storageStatus?.storage_type || 'local'}
                  {storageStatus && storageStatus.s3_enabled === false && (
                    <span className="ml-1 text-wb-text-muted font-normal">（对象存储已停用）</span>
                  )}
                </div>
              </div>
              <div className="p-3 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle space-y-1">
                <div className="text-2xs text-wb-text-muted">存储桶名称 (S3_BUCKET)</div>
                <div className="font-mono font-semibold text-wb-text-primary text-xs truncate" title={storageStatus?.s3_bucket || '未配置'}>
                  {storageStatus?.s3_bucket || <span className="text-wb-text-muted font-normal">暂未配置</span>}
                </div>
              </div>
              <div className="p-3 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle space-y-1">
                <div className="text-2xs text-wb-text-muted">公开访问域名 (PUBLIC_DOMAIN)</div>
                <div className="font-mono font-semibold text-wb-text-primary text-xs truncate" title={storageStatus?.s3_public_domain || '默认使用 S3 端点'}>
                  {storageStatus?.s3_public_domain || <span className="text-wb-text-muted font-normal">自动拼接</span>}
                </div>
              </div>
              <div className="p-3 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle space-y-1">
                <div className="text-2xs text-wb-text-muted">凭证完备性 (AK / SK)</div>
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <span className={storageStatus?.has_access_key ? 'text-wb-success' : 'text-wb-warn'}>
                    AK: {storageStatus?.has_access_key ? '已配置' : '未配置'}
                  </span>
                  <span className="text-wb-border-subtle">|</span>
                  <span className={storageStatus?.has_secret_key ? 'text-wb-success' : 'text-wb-warn'}>
                    SK: {storageStatus?.has_secret_key ? '已配置' : '未配置'}
                  </span>
                </div>
              </div>
            </div>

            {/* 自检测试返回结果 */}
            {testResult && (
              <div className={`p-3.5 rounded-2xl border flex items-start gap-2.5 transition-all ${
                testResult.success
                  ? 'bg-wb-success/10 border-wb-success/20 text-wb-success dark:text-wb-success'
                  : 'bg-wb-danger/10 border-wb-danger/20 text-wb-danger dark:text-wb-danger'
              }`}>
                {testResult.success ? (
                  <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0 text-wb-success" />
                ) : (
                  <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-wb-danger" />
                )}
                <div className="text-xs space-y-0.5 min-w-0 flex-1">
                  <div className="font-semibold flex items-center justify-between">
                    <span>{testResult.success ? '连通性测试通过' : '连通性自检异常'}</span>
                    {testResult.latency_ms !== undefined && testResult.latency_ms > 0 && (
                      <span className="font-mono text-2xs opacity-80">延时: {testResult.latency_ms} ms</span>
                    )}
                  </div>
                  <div className="opacity-90 break-words">{testResult.message}</div>
                </div>
              </div>
            )}

            {/* 运维切换指南卡片 */}
            <div className="p-3.5 rounded-2xl bg-wb-bg-subtle/40 border border-wb-border-subtle text-wb-text-secondary space-y-1.5 leading-relaxed">
              <div className="font-semibold text-wb-text-primary flex items-center gap-1.5">
                💡 站长平滑迁移与上线指南
              </div>
              <ul className="list-disc list-inside space-y-1 text-2xs text-wb-text-muted">
                <li><strong>当前内测期：</strong>保持 <code className="px-1 py-0.5 rounded bg-wb-bg-subtle text-wb-text-primary">STORAGE_TYPE=local</code>，图片自动保存在服务器 <code className="px-1 py-0.5 rounded bg-wb-bg-subtle text-wb-text-primary">/uploads/</code> 目录并自动压缩为 WebP 格式。</li>
                <li><strong>正式上线切换到 Cloudflare R2：</strong>在服务器 <code className="px-1 py-0.5 rounded bg-wb-bg-subtle text-wb-text-primary">.env</code> 中配置 <code className="px-1 py-0.5 rounded bg-wb-bg-subtle text-wb-text-primary">STORAGE_TYPE=s3</code> 以及 R2 的 Account ID、AccessKey、SecretKey 和 Bucket 名称，点击上方「一键连通性自检」校验成功即可。</li>
                <li><strong>双模容灾保障：</strong>万一遇到云存储网络抖动或鉴权失效，后端内置智能熔断机制，会自动平滑降级至本地持久化目录，确保前台发帖、换头像体验 0 报错中断。</li>
              </ul>
            </div>
          </div>
          )}
        </div>
      )}

      {/* Tab 2: 社区规则与经验配置 */}
      {activeTab === 'rules' && (
        <div className="space-y-6 animate-fade-in">
          <div className="p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-wb-border-subtle">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Sliders className="w-5 h-5 text-wb-text-primary" />
                  <h3 className="text-base font-bold text-wb-text-primary font-mono">
                    社区规则与经验上限配置
                  </h3>
                </div>
                <p className="text-xs text-wb-text-muted">
                  动态调控每日文章发布频次、经验获取防刷上限与经验值下发参数（超级管理员专属管控）
                </p>
              </div>

              {isSuperAdmin && (
                <button
                  type="button"
                  onClick={handleSaveSettings}
                  disabled={savingSettings}
                  className="wb-pressable h-8 px-4 text-xs font-semibold rounded-capsule bg-wb-text-primary text-wb-bg-page hover:opacity-90 flex items-center gap-1.5 shadow-sm disabled:opacity-50 shrink-0"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{savingSettings ? '保存中...' : '保存配置'}</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* 每日发帖上限 */}
              <div className="p-4 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-wb-text-primary">普通用户每日发帖上限</span>
                  <span className="text-2xs font-mono px-2 py-0.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-wb-text-secondary">
                    篇/天
                  </span>
                </div>
                <p className="text-2xs text-wb-text-muted leading-relaxed">
                  普通会员每天最多发布的有效文章数量。超过上限后今日不可继续发帖，超级管理员和管理员免受此限制。
                </p>
                <input
                  type="number"
                  min="1"
                  max="50"
                  disabled={!isSuperAdmin}
                  value={settingsList.daily_post_limit ?? '5'}
                  onChange={(e) =>
                    setSettingsList((prev) => ({ ...prev, daily_post_limit: e.target.value }))
                  }
                  className="w-full h-9 px-3 text-xs font-mono font-bold rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-wb-text-primary focus:outline-none focus:border-wb-text-primary disabled:opacity-50"
                />
              </div>

              {/* 每日经验获取上限 */}
              <div className="p-4 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-wb-text-primary">用户每日经验获取上限</span>
                  <span className="text-2xs font-mono px-2 py-0.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-wb-text-secondary">
                    EXP/天
                  </span>
                </div>
                <p className="text-2xs text-wb-text-muted leading-relaxed">
                  单日内通过发帖、评论、点赞互动累计可获取的最大经验值。达到上限后仍可正常交流，但不再奖励经验，彻底杜绝刷分。
                </p>
                <input
                  type="number"
                  min="0"
                  max="1000"
                  disabled={!isSuperAdmin}
                  value={settingsList.daily_exp_limit ?? '60'}
                  onChange={(e) =>
                    setSettingsList((prev) => ({ ...prev, daily_exp_limit: e.target.value }))
                  }
                  className="w-full h-9 px-3 text-xs font-mono font-bold rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-wb-text-primary focus:outline-none focus:border-wb-text-primary disabled:opacity-50"
                />
              </div>

              {/* 单篇发帖奖励经验 */}
              <div className="p-4 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-wb-text-primary">单篇有效发帖奖励经验</span>
                  <span className="text-2xs font-mono px-2 py-0.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-wb-text-secondary">
                    EXP/篇
                  </span>
                </div>
                <p className="text-2xs text-wb-text-muted leading-relaxed">
                  正文有效内容不少于 15 字符的原创文章发布时奖励的基础经验值，受每日经验获取上限保护。
                </p>
                <input
                  type="number"
                  min="0"
                  max="100"
                  disabled={!isSuperAdmin}
                  value={settingsList.post_exp_reward ?? '15'}
                  onChange={(e) =>
                    setSettingsList((prev) => ({ ...prev, post_exp_reward: e.target.value }))
                  }
                  className="w-full h-9 px-3 text-xs font-mono font-bold rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-wb-text-primary focus:outline-none focus:border-wb-text-primary disabled:opacity-50"
                />
              
              <div className="space-y-1.5">
                <label className="text-2xs font-semibold text-wb-text-secondary">每日打卡次数（全局，经验固定 10）</label>
                <input type="number" min={1} max={3}
                  value={settingsList.checkin_times_per_day || '1'}
                  onChange={(e) => setSettingsList({ ...settingsList, checkin_times_per_day: e.target.value })}
                  disabled={!isSuperAdmin}
                  className="w-full h-9 px-3 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-2xs disabled:opacity-60"
                />
                <p className="text-3xs text-wb-text-muted">每次签到经验固定为 10，不可单独设置；签到语默认「签到」，群主可在群内修改。</p>
              </div>
</div>

              {/* 经验机制与反作弊说明 */}
              <div className="p-4 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle space-y-3">
                <div className="flex items-center gap-1.5 text-xs font-bold text-wb-text-primary">
                  <AlertTriangle className="w-4 h-4 text-wb-warn shrink-0" />
                  <span>规则机制与作弊巡查机制</span>
                </div>
                <div className="text-2xs text-wb-text-muted space-y-1.5 leading-relaxed">
                  <div>• <strong>已取消撤回扣经验</strong>：用户自主下架/撤回文章不再扣除经验，方便自由调整草稿与润色；</div>
                  <div>• <strong>双重上限防护</strong>：即使频繁下架与重新发帖，也会被每日发帖数与每日经验总额双重锁死；</div>
                  <div>• <strong>违规作弊巡查</strong>：巡查人员核查异常刷分行为，可在成员管理列表直接对可疑账号<strong>一键封禁</strong>。</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: 待审举报队列 */}
      {activeTab === 'reports' && (
        <div className="p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4 animate-fade-in">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-wb-text-primary flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-wb-danger" />
              <span>
                {{ pending: '待处理举报', resolved: '已处理举报', rejected: '已驳回举报' }[reportStatus]}
                {reportStatus === 'pending' && ` · 共 ${pendingReportCount} 条`}
              </span>
              {reportStatus === 'pending' && pendingReportCount > 0 && (
                <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-wb-danger text-white text-3xs font-bold inline-flex items-center justify-center">
                  {pendingReportCount > 99 ? '99+' : pendingReportCount}
                </span>
              )}
            </h3>
            <span className="text-xs text-wb-text-muted">
              {reportStatus === 'pending' ? '点击下架将扣除被举报作者 50 EXP 惩罚分' : '已归档，仅可查看结论'}
            </span>
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <SegmentedControl
              id="report-status"
              size="sm"
              items={[
                { key: 'pending', label: '待处理' },
                { key: 'resolved', label: '已处理' },
                { key: 'rejected', label: '已驳回' },
              ]}
              activeKey={reportStatus}
              onChange={(key) => {
                setReportStatus(key as 'pending' | 'resolved' | 'rejected');
                setReportPage(1);
                fetchReports(key as any, 1);
              }}
            />
            <div className="flex items-center gap-1.5 text-xs text-wb-text-muted">
              <button
                type="button"
                disabled={reportPage <= 1 || loadingReports}
                onClick={() => {
                  const next = reportPage - 1;
                  setReportPage(next);
                  fetchReports(reportStatus, next);
                }}
                className="px-2.5 py-1 rounded-capsule border border-wb-border-subtle disabled:opacity-40 hover:border-wb-border-strong"
              >
                上一页
              </button>
              <span className="font-mono">第 {reportPage} 页</span>
              <button
                type="button"
                disabled={!reportHasMore || loadingReports}
                onClick={() => {
                  const next = reportPage + 1;
                  setReportPage(next);
                  fetchReports(reportStatus, next);
                }}
                className="px-2.5 py-1 rounded-capsule border border-wb-border-subtle disabled:opacity-40 hover:border-wb-border-strong"
              >
                下一页
              </button>
            </div>
          </div>

          <p className="text-2xs text-wb-text-muted">
            每条举报可单独填写处理理由（最多 100 字），会同步回执给举报人与被处置者。
          </p>

          {reports.length === 0 ? (
            <div className="py-12 text-center text-xs text-wb-text-muted">
              {{ pending: '当前暂无待处理的违规举报', resolved: '暂无已处理的举报', rejected: '暂无已驳回的举报' }[reportStatus]}
            </div>
          ) : (
            <div className="space-y-3">
              {reports.map((rep) => (
                <div
                  key={rep.id}
                  className="p-4 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs"
                >
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="font-semibold text-wb-text-primary flex items-center gap-2 flex-wrap">
                      <span className="px-2 py-0.5 rounded-capsule bg-wb-capsule-track font-mono text-3xs">
                        {rep.target_type === 'post' ? '文章' : '评论'}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-capsule text-3xs font-semibold ${
                          rep.status === 'pending'
                            ? 'bg-wb-warn/15 text-wb-warn border border-wb-warn/30'
                            : rep.status === 'resolved'
                            ? 'bg-wb-success/15 text-wb-success border border-wb-success/30'
                            : 'bg-wb-bg-surface text-wb-text-muted border border-wb-border-subtle'
                        }`}
                      >
                        {rep.status_label || (rep.status === 'pending' ? '待处理' : rep.status)}
                      </span>
                      <span className="text-2xs text-wb-text-secondary">{rep.reason_label || rep.reason_type}</span>
                    </div>
                    <p className="text-wb-text-secondary break-words">{rep.description || '举报人未补充附加描述'}</p>
                    <div className="flex items-center gap-2 flex-wrap text-3xs text-wb-text-muted font-mono">
                      <button
                        type="button"
                        title="在新标签页打开被举报内容"
                        onClick={() => window.open(`/?post=${rep.target_id}`, '_blank', 'noopener,noreferrer')}
                        className="inline-flex items-center gap-1 text-wb-brand hover:underline"
                      >
                        <ExternalLink className="w-3 h-3" />
                        查看原文
                      </button>
                      {rep.reporter_username && <span>举报人 @{rep.reporter_username}</span>}
                      {rep.created_at && <span>{new Date(rep.created_at).toLocaleDateString('zh-CN')}</span>}
                    </div>
                    {rep.image_url && (
                      <a href={rep.image_url} target="_blank" rel="noopener noreferrer" title="查看举报截图">
                        <img src={rep.image_url} alt="举报截图" className="w-20 h-20 rounded-xl object-cover border border-wb-border-subtle" />
                      </a>
                    )}
                    {rep.status !== 'pending' && rep.resolve_note && (
                      <p className="text-3xs text-wb-text-muted break-words">处理理由：{rep.resolve_note}</p>
                    )}
                  </div>
                  {rep.status === 'pending' ? (
                    <div className="flex flex-col gap-2 flex-shrink-0 sm:w-56">
                      <input
                        type="text"
                        value={reportNotes[rep.id] || ''}
                        onChange={(e) => setReportNotes((prev) => ({ ...prev, [rep.id]: e.target.value.slice(0, 100) }))}
                        maxLength={100}
                        placeholder="处理理由（选填，最多 100 字）"
                        className="w-full h-8 px-2.5 rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-2xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleResolveReport(rep.id, 'reject')}
                          disabled={resolvingReportId !== null}
                          className="wb-pressable flex-1 px-3 py-1.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary disabled:opacity-40"
                        >
                          {resolvingReportId === rep.id ? '处理中...' : '驳回举报'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleResolveReport(rep.id, 'block_target')}
                          disabled={resolvingReportId !== null}
                          className="wb-pressable flex-1 px-3 py-1.5 rounded-capsule bg-wb-danger text-white font-semibold shadow-sm disabled:opacity-40"
                        >
                          {resolvingReportId === rep.id ? '处理中...' : '下架处罚'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <span className="text-2xs text-wb-text-muted shrink-0">已归档 · 不可重复处置</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab 3: 匿名身份穿透审计 */}
      {activeTab === 'audit' && (
        <div className="p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4 animate-fade-in">
          <div className="space-y-1">
            <h3 className="text-sm font-bold text-wb-text-primary flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-wb-text-primary" />
              <span>匿名真实身份穿透解密中枢</span>
            </h3>
            <p className="text-xs text-wb-text-muted">
              依据社区准则第 4 条，匿名言论受隐私保护，解密穿透操作将以极高安全级别强制记入审计底账
            </p>
          </div>

          <form onSubmit={handleAuditAnonymous} className="space-y-3 text-xs">
            <input
              type="text"
              required
              value={auditCommentId}
              onChange={(e) => setAuditCommentId(e.target.value)}
              placeholder="输入待审计评论 UUID (例如: c9811568-71bf-4ebc-8822-4a0fb568772a)"
              className="w-full h-9 px-3.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-primary font-mono focus:outline-none focus:border-wb-text-primary"
            />
            <input
              type="text"
              required
              value={auditReason}
              onChange={(e) => setAuditReason(e.target.value)}
              placeholder="输入详实审计事由 (不少于 5 字，如: 涉及发布危害公共安全内容调查)"
              className="w-full h-9 px-3.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-primary focus:outline-none focus:border-wb-text-primary"
            />
            <button
              type="submit"
              className="wb-pressable h-10 px-6 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm flex items-center justify-center gap-1.5 transition-transform"
            >
              执行留痕穿透核验
            </button>
          </form>

          {auditResult && (
            <div className="p-4 rounded-2xl bg-wb-bg-subtle/80 border border-wb-border-strong text-xs space-y-2 animate-fade-in font-mono">
              <div className="font-bold text-wb-text-primary flex items-center gap-1.5 pb-1 border-b border-wb-border-subtle">
                <Sparkles className="w-3.5 h-3.5" />
                <span>穿透核验报告 (Audit Log Logged)</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-2xs">
                <div>
                  <span className="text-wb-text-muted">前台代号: </span>
                  <span className="font-semibold text-wb-text-primary">{auditResult.anonymous_alias}</span>
                </div>
                <div>
                  <span className="text-wb-text-muted">真实账号: </span>
                  {onSelectUser ? (
                    <button
                      type="button"
                      onClick={() => onSelectUser(auditResult.real_username)}
                      className="font-bold text-wb-danger hover:underline inline-flex items-center gap-1 cursor-pointer"
                      title={`访问 @${auditResult.real_username} 的主页`}
                    >
                      <span>{auditResult.real_username}</span>
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  ) : (
                    <span className="font-bold text-wb-danger">{auditResult.real_username}</span>
                  )}
                </div>
                <div>
                  <span className="text-wb-text-muted">绑定邮箱: </span>
                  {/* 后端已按隐私策略不再下发邮箱 PII，保留占位避免渲染空白 */}
                  <span className="text-wb-text-muted">已按隐私策略隐藏</span>
                </div>
                <div>
                  <span className="text-wb-text-muted">账号状态: </span>
                  <span className="font-semibold">{auditResult.status}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 6: 成就勋章（仅超级管理员） */}
      {activeTab === 'medals' && user?.role === 'super_admin' && <MedalAdminPanel />}

      {/* Tab 5: 站点运维管理（仅超级管理员） */}
      {activeTab === 'ops' && user?.role === 'super_admin' && <OpsDashboard />}

      {/* Tab 7: 敏感词库管理（仅超级管理员，支持一键导入） */}
      {activeTab === 'sensitive' && user?.role === 'super_admin' && <SensitiveWordsPanel />}
      {activeTab === 'review' && user?.role === 'super_admin' && <SensitiveReviewPanel />}
      {activeTab === 'ai' && user?.role === 'super_admin' && <AIAdminPanel />}

      {activeTab === 'links' && user?.role === 'super_admin' && <FriendLinksPanel />}

      {/* Tab 4: 全局公告与邀请码 */}
      {activeTab === 'system' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 animate-fade-in">
          {/* 批量生成邀请码 (只读审计员无资格) */}
          {user?.role !== 'auditor' && (
          <div className="p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-3.5 text-xs">
            <h4 className="font-bold text-sm text-wb-text-primary flex items-center gap-1.5">
              <KeyRound className="w-4 h-4" /> 邀请码签发中枢
            </h4>
            <p className="text-wb-text-muted">
              签发的邀请码可使新注册用户免除 5 日见习期，直升正式会员资格。
              {user?.role === 'super_admin'
                ? '超级管理员不限量签发，30 天有效。'
                : '管理角色每 72 小时可签发 10 枚，30 天有效。'}
            </p>
            <button
              type="button"
              onClick={handleGenerateInvites}
              className="wb-pressable w-full h-10 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm flex items-center justify-center gap-1.5 transition-transform"
            >
              {user?.role === 'super_admin' ? '一键签发 10 枚 30 天有效邀请码' : '签发本窗口邀请码 (每 72 小时 10 枚)'}
            </button>
            {inviteCodes.length > 0 && (
              <div className="p-3 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle font-mono text-2xs space-y-1 text-wb-text-primary">
                {inviteCodes.map((c) => (
                  <div key={c} className="flex items-center justify-between">
                    <span>{c}</span>
                    <span className="text-wb-text-muted text-3xs">有效 30 天</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}

          {/* 全站公告与版本更新日志发布中心 */}
          <div className="p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4 text-xs">
            <div className="space-y-1">
              <h4 className="font-bold text-sm text-wb-text-primary flex items-center gap-1.5">
                <Volume2 className="w-4 h-4 text-wb-text-primary" /> 全站公告与版本更新日志发布中心
              </h4>
              <p className="text-wb-text-muted">
                发布社区广播、重大版本更新日志（Changelog）或维护警示，支持 Markdown 排版、分类标签与前台弹窗展开
              </p>
            </div>

            {/* 编辑与发布表单 */}
            <div className="space-y-3 bg-wb-bg-subtle/50 p-4 rounded-2xl border border-wb-border-subtle">
              {/* 分类标签选择 */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-wb-text-secondary font-medium text-2xs">类型选择:</span>
                {[
                  { key: 'update', label: '版本升级 / 更新日志', icon: Sparkles },
                  { key: 'info', label: '社区通知 / 广播', icon: Volume2 },
                  { key: 'warning', label: '维护警示 / 提醒', icon: AlertTriangle },
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setAnnouncementLevel(item.key as any)}
                      className={`wb-pressable h-7 px-3 rounded-capsule text-xs select-none inline-flex items-center gap-1.5 border transition-all ${
                        announcementLevel === item.key
                          ? 'border-transparent bg-wb-text-primary text-wb-bg-page font-semibold shadow-xs'
                          : 'border-wb-border-subtle bg-wb-bg-surface text-wb-text-secondary hover:bg-wb-bg-subtle'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* 标题输入框 */}
              <div>
                <input
                  type="text"
                  value={announcementTitle}
                  onChange={(e) => setAnnouncementTitle(e.target.value)}
                  placeholder="标题 (如: 社区 v2.0 正式上线：全新主题胶囊、个人主页改版与更新日志系统)"
                  className="w-full h-10 px-3.5 rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-wb-text-primary focus:outline-none focus:border-wb-text-primary font-medium"
                />
              </div>

              {/* 快捷 Markdown 辅助按钮 */}
              <div className="flex items-center gap-1.5 text-2xs text-wb-text-muted">
                <span>快捷插入:</span>
                <button
                  type="button"
                  onClick={() => setAnnouncementText((prev) => prev + '\n### 新增特性\n- ')}
                  className="px-2 py-0.5 rounded bg-wb-bg-surface hover:bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-secondary"
                >
                  + 新增特性
                </button>
                <button
                  type="button"
                  onClick={() => setAnnouncementText((prev) => prev + '\n- ')}
                  className="px-2 py-0.5 rounded bg-wb-bg-surface hover:bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-secondary"
                >
                  + 列表项
                </button>
                <button
                  type="button"
                  onClick={() => setAnnouncementText((prev) => prev + '**加粗文字**')}
                  className="px-2 py-0.5 rounded bg-wb-bg-surface hover:bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-secondary font-bold"
                >
                  B
                </button>
              </div>

              {/* 详细内容多行文本域 */}
              <div>
                <textarea
                  rows={4}
                  value={announcementText}
                  onChange={(e) => setAnnouncementText(e.target.value)}
                  placeholder="详细公告正文或更新日志列表 (支持 Markdown 语法，如 ### 标题、- 条目、`代码` 等)..."
                  className="w-full p-3.5 rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-wb-text-primary focus:outline-none focus:border-wb-text-primary leading-relaxed resize-y font-mono text-xs"
                />
              </div>

              {/* 底部控制栏 */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                <label className="flex items-center gap-2 cursor-pointer select-none text-wb-text-secondary hover:text-wb-text-primary">
                  <input
                    type="checkbox"
                    checked={announcementIsActive}
                    onChange={(e) => setAnnouncementIsActive(e.target.checked)}
                    className="w-4 h-4 rounded border-wb-border-subtle accent-wb-text-primary cursor-pointer"
                  />
                  <span>在首页顶部横幅轮播展示 (若取消，则直接归入历史日志库，不占横幅空间)</span>
                </label>

                <button
                  type="button"
                  onClick={handleUpdateAnnouncement}
                  className="wb-pressable w-full sm:w-auto h-9 px-6 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm flex items-center justify-center gap-1.5 flex-shrink-0"
                >
                  发布公告 / 更新日志
                </button>
              </div>
            </div>

            {/* 历史与现有公告列表 */}
            <div className="pt-2 border-t border-wb-border-subtle space-y-2">
              <div className="flex items-center justify-between text-wb-text-secondary font-semibold">
                <span>现有公告与日志列表 ({announcementsList.length})</span>
                <span className="text-2xs text-wb-text-muted font-normal">点击眼睛可即时暂停/恢复展示</span>
              </div>

              {announcementsList.length === 0 ? (
                <div className="py-6 text-center text-wb-text-muted text-2xs">
                  暂无已发布的公告记录
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto wb-scrollbar-thin pr-1">
                  {announcementsList.map((ann) => (
                    <div
                      key={ann.id}
                      className={`p-3 rounded-2xl border flex items-center justify-between gap-3 transition-all ${
                        ann.is_active
                          ? 'bg-wb-bg-subtle/70 border-wb-border-subtle text-wb-text-primary'
                          : 'bg-wb-bg-subtle/30 border-dashed border-wb-border-subtle text-wb-text-muted opacity-60'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span
                          className={`text-3xs px-2 py-0.5 rounded-capsule font-bold flex-shrink-0 ${
                            ann.level === 'update'
                              ? 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/20'
                              : ann.level === 'warning'
                              ? 'bg-wb-warn/15 text-wb-warn dark:text-wb-warn border border-wb-warn/20'
                              : 'bg-wb-info/15 text-wb-info dark:text-wb-info border border-wb-info/20'
                          }`}
                        >
                          {ann.level === 'update' ? '更新日志' : ann.level === 'warning' ? '维护警示' : '社区通知'}
                        </span>
                        <span
                          className={`text-3xs px-2 py-0.5 rounded-capsule font-bold flex-shrink-0 ${
                            ann.is_active
                              ? 'bg-wb-text-primary text-wb-bg-page'
                              : 'bg-wb-bg-subtle text-wb-text-muted'
                          }`}
                        >
                          {ann.is_active ? '轮播中' : '历史归档'}
                        </span>
                        <div className="truncate text-xs font-medium flex items-center gap-1.5">
                          {ann.title && <span className="font-bold text-wb-text-primary">{ann.title}</span>}
                          <span className="text-wb-text-secondary truncate">{ann.content}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => handleToggleAnnouncement(ann.id)}
                          title={ann.is_active ? '暂停展示' : '恢复展示'}
                          className="p-1.5 rounded-full hover:bg-wb-bg-surface text-wb-text-secondary hover:text-wb-text-primary transition-colors"
                        >
                          {ann.is_active ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteAnnouncement(ann.id)}
                          title="彻底删除"
                          className="p-1.5 rounded-full hover:bg-wb-bg-surface text-wb-text-muted hover:text-wb-danger transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 彻底清空并删除用户高危确认弹窗 (Portal, 仅限超管 + 密码验证 + 5秒确认倒计时) */}
      {userToDelete &&
        createPortal(
          <div className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
            <div className="w-full max-w-md rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl p-6 space-y-5 animate-scale-in">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-wb-danger/15 text-wb-danger dark:text-wb-danger flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-wb-text-primary">
                    注销账号：进入 10 天缓冲期
                  </h3>
                  <p className="text-xs text-wb-text-muted">最高管理员专属 · 缓冲期内可一键恢复</p>
                </div>
              </div>

              {/* 目标用户资料卡片 */}
              <div className="p-3.5 rounded-2xl bg-wb-bg-subtle/80 border border-wb-border-subtle space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-wb-text-muted">目标账号：</span>
                  <span className="font-bold text-wb-text-primary font-mono">
                    @{userToDelete.username}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-wb-text-muted">注册邮箱：</span>
                  <span className="font-mono text-wb-text-secondary">{userToDelete.email}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-wb-text-muted">当前等级与状态：</span>
                  <span className="font-mono text-wb-text-secondary">
                    Lv.{userToDelete.level} ({userToDelete.experience} EXP) ·{' '}
                    {userToDelete.status === 'deleting'
                      ? '待删除'
                      : userToDelete.status === 'banned'
                      ? '已封禁'
                      : userToDelete.status === 'probation'
                      ? '见习期'
                      : '正式会员'}
                  </span>
                </div>
              </div>

              {/* 危险警告提示 */}
              <div className="p-3 rounded-2xl bg-wb-danger/10 border border-wb-danger/20 text-xs text-wb-danger dark:text-wb-danger space-y-1">
                <div className="font-semibold flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>数据清理范围警告：</span>
                </div>
                <p className="leading-relaxed opacity-90 pl-5 text-2xs">
                  执行后将<strong>永久删除</strong>该用户账号及其发表的<strong>全部文章、草稿、评论、互动点赞、收藏、关注、私信记录与签到数据</strong>。该操作不可逆，请极其谨慎操作！
                </p>
              </div>

              {/* 最高管理员安全验证码 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-semibold text-wb-text-primary">
                    最高管理员安全验证码 <span className="text-wb-danger">*</span>
                  </label>
                  <span className="text-2xs text-wb-text-muted">请在下方填入此 4 位数字</span>
                </div>

                {/* 验证码视觉展示条 */}
                <div className="flex items-center justify-between p-3 rounded-2xl bg-wb-bg-subtle/80 border border-wb-border-subtle">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-wb-text-muted">验证码：</span>
                    <div
                      onClick={() => {
                        const nextCode = generateCaptcha();
                        setVerifyCode(nextCode);
                        setInputCode('');
                        setDeleteError('');
                      }}
                      className="px-4 py-1 rounded-xl bg-wb-bg-surface border border-wb-border-strong font-mono font-black text-xl tracking-[0.35em] text-wb-text-primary select-none cursor-pointer shadow-sm hover:border-wb-danger transition-colors"
                      title="点击更换验证码"
                    >
                      {verifyCode}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const nextCode = generateCaptcha();
                      setVerifyCode(nextCode);
                      setInputCode('');
                      setDeleteError('');
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-wb-text-muted hover:text-wb-text-primary rounded-lg hover:bg-wb-bg-surface transition-colors cursor-pointer"
                    title="更换验证码"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>换一张</span>
                  </button>
                </div>

                {/* 验证码输入框 */}
                <div className="relative">
                  <input
                    type="text"
                    maxLength={4}
                    value={inputCode}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '').slice(0, 4);
                      setInputCode(val);
                      setDeleteError('');
                    }}
                    placeholder="请输入上方 4 位数字验证码"
                    className="w-full h-11 px-3.5 text-center text-base tracking-[0.3em] font-mono font-bold rounded-xl bg-wb-bg-subtle border border-wb-border-subtle focus:border-wb-danger text-wb-text-primary placeholder:text-wb-text-muted placeholder:tracking-normal placeholder:font-normal placeholder:text-xs focus:outline-none transition-colors"
                  />
                </div>
                {/* 二次身份校验：必须输入当前登录账号的真实密码（服务端会校验） */}
                <div className="space-y-1.5 pt-1">
                  <label className="block text-xs font-semibold text-wb-text-primary">
                    当前账号登录密码 <span className="text-wb-danger">*</span>
                  </label>
                  <input
                    type="password"
                    value={deletePassword}
                    onChange={(e) => {
                      setDeletePassword(e.target.value);
                      setDeleteError('');
                    }}
                    placeholder="请输入你本人的登录密码以确认身份"
                    autoComplete="current-password"
                    className="w-full h-11 px-3.5 text-sm rounded-xl bg-wb-bg-subtle border border-wb-border-subtle focus:border-wb-danger text-wb-text-primary placeholder:text-wb-text-muted placeholder:text-xs focus:outline-none transition-colors"
                  />
                </div>

                {deleteError && (
                  <p className="text-2xs text-wb-danger font-medium pt-0.5">{deleteError}</p>
                )}
              </div>

              {/* 操作按键 */}
              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-wb-border-subtle">
                <button
                  type="button"
                  onClick={() => setUserToDelete(null)}
                  disabled={deletingUser}
                  className="wb-pressable h-9 px-4 rounded-capsule bg-wb-bg-subtle hover:bg-wb-capsule-track text-wb-text-secondary text-xs font-semibold transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDeleteUser}
                  disabled={deleteCountdown > 0 || inputCode.length !== 4 || inputCode !== verifyCode || deletePassword.length < 6 || deletingUser}
                  className="wb-pressable h-9 px-5 rounded-capsule bg-wb-danger hover:bg-wb-danger text-white text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed shadow-sm flex items-center gap-2 transition-all cursor-pointer"
                >
                  {deletingUser ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>正在清空数据...</span>
                    </>
                  ) : deleteCountdown > 0 ? (
                    <span>确认清空并删除 ({deleteCountdown}s)</span>
                  ) : (
                    <>
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>确认永久清空并删除</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* 轻量浮动 Toast */}
      {toastMessage &&
        createPortal(
          <div className="fixed bottom-20 sm:bottom-10 left-1/2 -translate-x-1/2 z-[110] px-4 py-2.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-medium shadow-2xl flex items-center gap-2 border border-wb-border-strong/20 animate-fade-in pointer-events-none">
            <Check className="w-3.5 h-3.5 text-wb-success" />
            <span>{toastMessage}</span>
          </div>,
          document.body
        )}
    </div>
  );
};

