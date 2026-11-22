/**
 * 个性化本地系统字体管理器
 * 支持用户输入其本地电脑/手机操作系统中已安装的任意字体名称
 * 持久化至 localStorage，并在全站根样式与 body 注入生效
 */

export const FONT_STORAGE_KEY = 'geek_custom_font';

export const DEFAULT_FONT_FALLBACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", sans-serif';

/**
 * 将指定系统字体应用至全局页面
 * @param fontName 字体名，为空时恢复系统预设默认字体
 */
export const applyCustomFont = (fontName: string | null | undefined): void => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const clean = (fontName || '').trim().replace(/["']/g, '');

  if (!clean) {
    document.documentElement.style.removeProperty('--font-custom');
    document.body.style.fontFamily = '';
    try {
      localStorage.removeItem(FONT_STORAGE_KEY);
    } catch {}
  } else {
    // 包裹安全引号并追加经典 fallback 回退链
    const formattedFont = `"${clean}", ${DEFAULT_FONT_FALLBACK}`;
    document.documentElement.style.setProperty('--font-custom', formattedFont);
    document.body.style.fontFamily = formattedFont;
    try {
      localStorage.setItem(FONT_STORAGE_KEY, clean);
    } catch {}
  }
};

/**
 * 获取当前持久化的自定义系统字体
 */
export const getStoredCustomFont = (): string => {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(FONT_STORAGE_KEY) || '';
  } catch {
    return '';
  }
};
