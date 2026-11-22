import { apiClient } from '../api/client';

export const MUTED_GROUPS_KEY = 'geek_chat_muted_groups';
export const MUTED_CONVS_KEY = 'geek_chat_muted_convs';

const read = (key: string): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** 把本地免打扰设置推送到云端（登录后多端同步）。 */
export const pushMutedToCloud = async (): Promise<void> => {
  if (!localStorage.getItem('access_token')) return;
  try {
    await apiClient.put('/users/me/muted', {
      groups: read(MUTED_GROUPS_KEY),
      convs: read(MUTED_CONVS_KEY),
    });
  } catch {}
};

/** 登录时从云端拉回免打扰设置；云端无数据时保留本地设置。 */
export const syncMutedFromCloud = async (): Promise<void> => {
  if (!localStorage.getItem('access_token')) return;
  try {
    const res = await apiClient.get('/users/me/muted');
    const groups = res.data?.groups;
    const convs = res.data?.convs;
    // 云端为空且本地有值时，以本地为准并回推，避免首次升级把用户设置清掉
    if ((!groups || groups.length === 0) && (!convs || convs.length === 0)
        && (read(MUTED_GROUPS_KEY).length || read(MUTED_CONVS_KEY).length)) {
      await pushMutedToCloud();
      return;
    }
    if (Array.isArray(groups) && Array.isArray(convs)) {
      localStorage.setItem(MUTED_GROUPS_KEY, JSON.stringify(groups));
      localStorage.setItem(MUTED_CONVS_KEY, JSON.stringify(convs));
    }
  } catch {}
};
