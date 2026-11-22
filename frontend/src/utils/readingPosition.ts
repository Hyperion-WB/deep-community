/** 长文阅读位置记忆：按文章保存滚动比例，下次打开自动回到原位。 */
const KEY = (postId: string) => `wb:reading:${postId}`;

export const readPosition = (postId: string): number => {
  try {
    const v = Number(localStorage.getItem(KEY(postId)) || '0');
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  } catch { return 0; }
};

export const savePosition = (postId: string, ratio: number): void => {
  try {
    localStorage.setItem(KEY(postId), String(Math.min(1, Math.max(0, ratio))));
  } catch {}
};
