import { useEffect, useState } from 'react';
import { apiClient } from '../api/client';

/**
 * 门户界面偏好（经典版 / 专业版）。
 *
 * - 初始默认永远是「经典版」，未登录 / 旧数据 / 接口失败都回落到 classic
 * - 登录后以服务端 users.portal_mode 为准，实现长期保存、换设备跟随
 * - 切换时先本地即时生效（不等待网络），再异步写入服务端
 * - 通过自定义事件广播，顶栏切换器、设置页开关、App 分流三处实时同步
 */
export type PortalMode = 'classic' | 'pro';

const STORAGE_KEY = 'wb_portal_mode';
const EVENT = 'geek_portal_mode_change';

export const normalizePortalMode = (v: unknown): PortalMode =>
  v === 'pro' ? 'pro' : 'classic';

export const getPortalMode = (): PortalMode => {
  try { return normalizePortalMode(localStorage.getItem(STORAGE_KEY)); } catch { return 'classic'; }
};

/** 只改本地并广播（不写服务端）；给登录回灌、游客临时切换使用 */
export const setPortalModeLocal = (mode: PortalMode): void => {
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* 忽略 */ }
  // 同步到 <html>，让全局 CSS 可以用 [data-portal="pro"] 给所有页面套专业版皮肤
  try { document.documentElement.dataset.portal = mode; } catch { /* 忽略 */ }
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: mode })); } catch { /* 忽略 */ }
};

/** 登录时从服务端拉取偏好，覆盖本地缓存 */
export const syncPortalFromCloud = async (): Promise<PortalMode> => {
  if (!localStorage.getItem('access_token')) return getPortalMode();
  try {
    const res = await apiClient.get('/users/me/portal');
    const mode = normalizePortalMode(res.data?.portal_mode);
    setPortalModeLocal(mode);
    return mode;
  } catch {
    return getPortalMode();
  }
};

/** 切换门户：界面立即生效，并把选择持久化到服务器 */
export const changePortalMode = async (mode: PortalMode): Promise<void> => {
  setPortalModeLocal(mode);
  if (!localStorage.getItem('access_token')) return;   // 游客仅本设备生效
  try {
    await apiClient.put('/users/me/portal', { portal_mode: mode });
  } catch {
    // 网络失败时保留本地选择，下次登录会被服务端值覆盖；
    // 不回滚界面，避免点了没反应
  }
};

export const usePortalMode = (): [PortalMode, (mode: PortalMode) => void] => {
  const [mode, setMode] = useState<PortalMode>(getPortalMode);

  useEffect(() => {
    // 首屏（含刷新、未触发过切换）也要把皮肤标记写上去
    try { document.documentElement.dataset.portal = getPortalMode(); } catch { /* 忽略 */ }
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<PortalMode>).detail;
      setMode(detail ? normalizePortalMode(detail) : getPortalMode());
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  const change = (next: PortalMode) => {
    setMode(next);
    void changePortalMode(next);
  };
  return [mode, change];
};
