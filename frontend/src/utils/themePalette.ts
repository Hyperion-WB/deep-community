import { crossFadePageGradient } from './gradientFade';
/**
 * 全站配色方案 (Color Palette) 管理器
 *
 * 8 套取自成熟开源调色板的配色，每套都同时具备「浅色 + 深色」取值：
 *   obsidian 曜石(默认) / nord 极地 / tokyo 午夜 / kanagawa 墨青
 *   rose 樱雾 / gruvbox 暖铅 / everforest 宣纸 / catppuccin 薄荷
 *
 * 生效方式：在 <html> 上写入 data-palette，index.css 内的同名变量块接管颜色；
 * 深浅模式仍由 .dark 类独立控制，两者正交组合。
 * 持久化：localStorage，仅作用于当前设备，换设备不受影响。
 */

export const PALETTE_STORAGE_KEY = 'geek_color_palette';
export const PALETTE_CHANGE_EVENT = 'geek_palette_change';

export type PaletteId =
  | 'obsidian'
  | 'tokyo'
  | 'kanagawa'
  | 'rose'
  | 'catppuccin'
  | 'aurora'
  | 'sunset'
  | 'ocean';

interface PalettePreview {
  page: string;
  surface: string;
  brand: string;
  /** 渐变主题的强调色渐变，纯色主题不填 */
  gradient?: string;
}

export interface PaletteMeta {
  id: PaletteId;
  name: string;
  en: string;
  desc: string;
  light: PalettePreview;
  dark: PalettePreview;
}

export const COLOR_PALETTES: PaletteMeta[] = [
  {
    id: 'obsidian',
    name: '曜石',
    en: 'Obsidian',
    desc: '中性冷黑，最克制的工业默认',
    light: { page: '#f4f5f7', surface: '#ffffff', brand: '#b45309' },
    dark: { page: '#090a0d', surface: '#181b21', brand: '#f2b95c' },
  },
  {
    id: 'tokyo',
    name: '午夜',
    en: 'Tokyo Night',
    desc: '蓝紫霓虹，属于程序员的深夜',
    light: { page: '#e1e2e7', surface: '#f7f7fa', brand: '#2e7de9' },
    dark: { page: '#16161e', surface: '#24283b', brand: '#7aa2f7' },
  },
  {
    id: 'kanagawa',
    name: '墨青',
    en: 'Kanagawa',
    desc: '神奈川墨色，冲浪与水墨的东方气质',
    light: { page: '#f2ecbc', surface: '#fbf6d3', brand: '#4d699b' },
    dark: { page: '#1f1f28', surface: '#363646', brand: '#7e9cd8' },
  },
  {
    id: 'rose',
    name: '樱雾',
    en: 'Rosé Pine',
    desc: '雾粉与紫灰，柔和优雅的阅读氛围',
    light: { page: '#faf4ed', surface: '#ffffff', brand: '#6e5a8c' },
    dark: { page: '#191724', surface: '#26233a', brand: '#c4a7e7' },
  },
  {
    id: 'catppuccin',
    name: '薄荷',
    en: 'Catppuccin',
    desc: '柔光紫调，圆润现代的层次感',
    light: { page: '#eff1f5', surface: '#ffffff', brand: '#8839ef' },
    dark: { page: '#11111b', surface: '#313244', brand: '#cba6f7' },
  },
  {
    id: 'aurora',
    name: '极光',
    en: 'Aurora',
    desc: '青蓝到紫，极夜天幕的流动光带',
    light: {
      page: '#f3f5fd',
      surface: '#ffffff',
      brand: '#4f6bff',
      gradient: 'linear-gradient(135deg, #4f9bff 0%, #8b5cf6 100%)',
    },
    dark: {
      page: '#0b0e1a',
      surface: '#151a2e',
      brand: '#7f9cff',
      gradient: 'linear-gradient(135deg, #4f8bff 0%, #a06bff 100%)',
    },
  },
  {
    id: 'sunset',
    name: '落日',
    en: 'Sunset',
    desc: '橙红到玫粉，海边黄昏的余温',
    light: {
      page: '#fdf4f0',
      surface: '#ffffff',
      brand: '#e05a3a',
      gradient: 'linear-gradient(135deg, #ff9a5a 0%, #ff5f8f 100%)',
    },
    dark: {
      page: '#170d10',
      surface: '#241518',
      brand: '#ff8f6b',
      gradient: 'linear-gradient(135deg, #ff8a4c 0%, #ff5f8f 100%)',
    },
  },
  {
    id: 'ocean',
    name: '深海',
    en: 'Ocean',
    desc: '青绿到湛蓝，清澈通透的水光',
    light: {
      page: '#eff7fa',
      surface: '#ffffff',
      brand: '#0e7d8f',
      gradient: 'linear-gradient(135deg, #28c4d8 0%, #3a7bfd 100%)',
    },
    dark: {
      page: '#07141a',
      surface: '#0f2028',
      brand: '#4fd6e6',
      gradient: 'linear-gradient(135deg, #26c6da 0%, #3f8cff 100%)',
    },
  },
];

export const DEFAULT_PALETTE_ID: PaletteId = 'obsidian';

const PALETTE_IDS: PaletteId[] = COLOR_PALETTES.map((item) => item.id);

const isPaletteId = (value: string | null | undefined): value is PaletteId =>
  !!value && (PALETTE_IDS as string[]).includes(value);

/** 读取当前设备的配色方案（非法值自动回落默认） */
export const getStoredPalette = (): PaletteId => {
  if (typeof window === 'undefined') return DEFAULT_PALETTE_ID;
  try {
    const saved = localStorage.getItem(PALETTE_STORAGE_KEY);
    return isPaletteId(saved) ? saved : DEFAULT_PALETTE_ID;
  } catch {
    return DEFAULT_PALETTE_ID;
  }
};

/** 获取配色方案的展示信息 */
export const getPaletteMeta = (id: PaletteId): PaletteMeta =>
  COLOR_PALETTES.find((item) => item.id === id) || COLOR_PALETTES[0];

/** 将当前实际生效的背景色同步到浏览器地址栏 / PWA 主题色 */
export const syncMetaThemeColor = (): void => {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const pageColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--wb-bg-page')
    .trim();
  if (pageColor) meta.setAttribute('content', pageColor);
};

let transitionTimer: number | undefined;

/**
 * 应用配色方案
 * @param id 目标配色 id
 * @param options.persist 是否写入 localStorage（首屏初始化时可传 false）
 * @param options.animate 是否播放 450ms 颜色过渡
 */
export const applyColorPalette = (
  id: PaletteId,
  options: { persist?: boolean; animate?: boolean } = {}
): PaletteId => {
  if (typeof document === 'undefined') return DEFAULT_PALETTE_ID;
  // 切换配色时清掉旧的强调色覆盖，否则 --wb-brand 会停在上一套强调色
  try {
    document.documentElement.removeAttribute('data-accent');
    localStorage.removeItem('geek_accent_color');
  } catch {}

  const target: PaletteId = isPaletteId(id) ? id : DEFAULT_PALETTE_ID;
  const root = document.documentElement;

  if (options.animate !== false) {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion) {
      root.classList.add('theme-transitioning');
      if (transitionTimer) window.clearTimeout(transitionTimer);
      transitionTimer = window.setTimeout(() => {
        root.classList.remove('theme-transitioning');
      }, 460);
    }
  }

  crossFadePageGradient(() => root.setAttribute('data-palette', target));

  if (options.persist !== false) {
    try {
      localStorage.setItem(PALETTE_STORAGE_KEY, target);
    } catch {
      /* 隐私模式下忽略写入失败 */
    }
  }

  window.requestAnimationFrame(() => {
    syncMetaThemeColor();
    window.dispatchEvent(new CustomEvent(PALETTE_CHANGE_EVENT, { detail: target }));
  });

  return target;
};

/** 恢复默认配色 */
export const resetColorPalette = (): PaletteId => {
  // data-accent 会覆盖 --wb-brand；不清理的话重置配色后品牌色仍停在旧强调色
  try {
    document.documentElement.removeAttribute('data-accent');
    localStorage.removeItem('geek_accent_color');
  } catch {}
  return applyColorPalette(DEFAULT_PALETTE_ID, { persist: true });
};
