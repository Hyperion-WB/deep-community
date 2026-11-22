/**
 * 全站界面个性化偏好（除配色方案外）
 *
 * 统一存放：强调色、字号缩放、界面密度、动效强度、背景质感、代码块主题。
 * 全部持久化于 localStorage（仅本设备生效），并以 <html data-*> 属性驱动 CSS，
 * 因此切换无需重新渲染整棵组件树，也不会造成页面闪烁。
 */

export const UI_PREFS_STORAGE_KEY = 'geek_ui_prefs';
export const UI_PREFS_CHANGE_EVENT = 'geek_ui_prefs_change';

export type AccentId =
  | 'default'
  | 'rose'
  | 'cerulean'
  | 'mint'
  | 'slate'
  | 'peach'
  | 'haze'
  | 'lemon'
  | 'pine'
  | 'mauve'
  | 'bronze'
  | 'ink'
  | 'rosegold'
  | 'sunset'
  | 'aurora'
  | 'citrus'
  | 'candy'
  | 'amber'
  | 'teal'
  | 'cyan'
  | 'blue'
  | 'indigo'
  | 'violet'
  | 'crimson'
  | 'sakura'
  | 'gold'
  | 'olive';

export type Density = 'compact' | 'standard' | 'cozy';
export type MotionLevel = 'full' | 'soft' | 'off';
export type TextureId =
  | 'plain'
  | 'aurora-flow'
  | 'nebula'
  | 'mist'
  | 'grid'
  | 'dots'
  | 'stripes'
  | 'glow'
  | 'aurora'
  | 'bokeh'
  | 'stars'
  | 'flashbang';
export type CodeThemeId = 'auto' | 'terminal' | 'paper' | 'contrast';

export interface UiPreferences {
  /** 强调色（覆盖当前配色方案的品牌色） */
  accent: AccentId;
  /** 字号缩放倍率，1 为标准 */
  scale: number;
  /** 界面密度 */
  density: Density;
  /** 动效强度 */
  motion: MotionLevel;
  /** 背景质感 */
  texture: TextureId;
  /** 代码块主题 */
  codeTheme: CodeThemeId;
}

export const DEFAULT_UI_PREFS: UiPreferences = {
  accent: 'default',
  scale: 1,
  density: 'standard',
  motion: 'full',
  texture: 'plain',
  codeTheme: 'auto',
};

export const ACCENT_OPTIONS: { id: AccentId; name: string; light: string; dark: string; second?: string }[] = [
  { id: 'default', name: '跟随配色', light: '#b45309', dark: '#f2b95c' },
  { id: 'amber', name: '琥珀', light: '#b45309', dark: '#f2b95c' },
  { id: 'teal', name: '青碧', light: '#0f766e', dark: '#5eead4' },
  { id: 'cyan', name: '电光青', light: '#0e7490', dark: '#67e8f9' },
  { id: 'blue', name: '深海蓝', light: '#1d4ed8', dark: '#60a5fa' },
  { id: 'indigo', name: '靛蓝', light: '#4338ca', dark: '#a5b4fc' },
  { id: 'violet', name: '星紫', light: '#6d28d9', dark: '#c4b5fd' },
  { id: 'crimson', name: '朱砂', light: '#b91c1c', dark: '#fca5a5' },
  { id: 'sakura', name: '樱粉', light: '#9d174d', dark: '#f9a8d4' },
  { id: 'gold', name: '钛金', light: '#8a6a12', dark: '#e8c766' },
  { id: 'olive', name: '橄榄', light: '#4d7c0f', dark: '#bef264' },
  { id: 'rose', name: '玫红', light: '#b0143c', dark: '#fb7185' },
  { id: 'cerulean', name: '天青', light: '#0369a1', dark: '#7dd3fc' },
  { id: 'mint', name: '薄荷', light: '#047857', dark: '#6ee7b7' },
  { id: 'slate', name: '岩灰', light: '#475569', dark: '#cbd5e1' },
  { id: 'peach', name: '蜜桃', light: '#c2410c', dark: '#fdba74' },
  { id: 'haze', name: '雾紫', light: '#7e22ce', dark: '#d8b4fe' },
  { id: 'lemon', name: '柠檬', light: '#a16207', dark: '#fde047' },
  { id: 'pine', name: '松绿', light: '#15803d', dark: '#86efac' },
  { id: 'mauve', name: '玫紫', light: '#86198f', dark: '#f0abfc' },
  { id: 'bronze', name: '青铜', light: '#92400e', dark: '#fcd34d' },
  { id: 'ink', name: '墨黑', light: '#1e293b', dark: '#e2e8f0' },
  { id: 'rosegold', name: '玫瑰金', light: '#9f1239', dark: '#fda4af' },
  // 渐变强调色：light 为主色、second 为渐变终点
  { id: 'sunset', name: '日落渐变', light: '#ea580c', dark: '#fb923c', second: '#db2777' },
  { id: 'aurora', name: '极光渐变', light: '#0891b2', dark: '#22d3ee', second: '#7c3aed' },
  { id: 'citrus', name: '柑橘渐变', light: '#65a30d', dark: '#a3e635', second: '#f59e0b' },
  { id: 'candy', name: '糖果渐变', light: '#db2777', dark: '#f472b6', second: '#7c3aed' },
];

export const SCALE_OPTIONS: { value: number; label: string }[] = [
  { value: 0.9, label: '小' },
  { value: 1, label: '标准' },
  { value: 1.1, label: '大' },
  { value: 1.2, label: '特大' },
];

export const DENSITY_OPTIONS: { value: Density; label: string }[] = [
  { value: 'compact', label: '紧凑' },
  { value: 'standard', label: '标准' },
  { value: 'cozy', label: '宽松' },
];

export const MOTION_OPTIONS: { value: MotionLevel; label: string }[] = [
  { value: 'full', label: '完整' },
  { value: 'soft', label: '减弱' },
  { value: 'off', label: '关闭' },
];

/** 背景质感预设：desc 用于下拉面板说明，bright 标记「高亮」预设（选中时会弹出提醒） */
export const TEXTURE_PRESETS: {
  value: TextureId;
  label: string;
  desc: string;
  bright?: boolean;
}[] = [
  { value: 'plain', label: '纯色', desc: '干净的纯色底，最克制' },
  { value: 'aurora-flow', label: '极光流', desc: '强调色缓慢流动的极光带' },
  { value: 'nebula', label: '星云', desc: '强调色与信息色晕染成雾' },
  { value: 'mist', label: '晨雾', desc: '自上而下的柔和暖雾' },
  { value: 'grid', label: '网格', desc: '工程图纸般的 32px 方格' },
  { value: 'dots', label: '点阵', desc: '疏朗的圆点阵列' },
  { value: 'stripes', label: '斜纹', desc: '45° 细斜线，工业质感' },
  { value: 'glow', label: '光晕', desc: '顶部品牌色柔光' },
  { value: 'aurora', label: '极光', desc: '品牌色与信息色双向晕染' },
  { value: 'bokeh', label: '光斑', desc: '散景虚化光点，柔和有景深' },
  { value: 'stars', label: '星野', desc: '稀疏星点，夜里最耐看' },
  { value: 'flashbang', label: '闪光弹', desc: 'WebGL 流体，色彩很冲、一直在动', bright: true },
];

/** 兼容旧调用：只取 id 与名称 */
export const TEXTURE_OPTIONS: { value: TextureId; label: string }[] = TEXTURE_PRESETS.map(
  ({ value, label }) => ({ value, label })
);

export const CODE_THEME_OPTIONS: { value: CodeThemeId; label: string }[] = [
  { value: 'auto', label: '跟随主题' },
  { value: 'terminal', label: '终端黑' },
  { value: 'paper', label: '纸张' },
  { value: 'contrast', label: '高对比' },
];

const ACCENT_IDS = ACCENT_OPTIONS.map((item) => item.id);
const DENSITY_IDS = DENSITY_OPTIONS.map((item) => item.value);
const MOTION_IDS = MOTION_OPTIONS.map((item) => item.value);
const TEXTURE_IDS = TEXTURE_OPTIONS.map((item) => item.value);
const CODE_THEME_IDS = CODE_THEME_OPTIONS.map((item) => item.value);

const clampScale = (value: unknown): number => {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_UI_PREFS.scale;
  // 限定在 0.8 ~ 1.35，避免用户手改 localStorage 把界面撑崩
  return Math.min(1.35, Math.max(0.8, Math.round(num * 100) / 100));
};

const pick = <T extends string>(value: unknown, allowed: T[], fallback: T): T =>
  typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;

/** 读取本设备已保存的个性化偏好（字段非法时逐项回落默认值） */
export const getUiPreferences = (): UiPreferences => {
  if (typeof window === 'undefined') return { ...DEFAULT_UI_PREFS };
  try {
    const raw = localStorage.getItem(UI_PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;
    return {
      accent: pick(parsed.accent, ACCENT_IDS, DEFAULT_UI_PREFS.accent),
      scale: clampScale(parsed.scale ?? DEFAULT_UI_PREFS.scale),
      density: pick(parsed.density, DENSITY_IDS, DEFAULT_UI_PREFS.density),
      motion: pick(parsed.motion, MOTION_IDS, DEFAULT_UI_PREFS.motion),
      texture: pick(parsed.texture, TEXTURE_IDS, DEFAULT_UI_PREFS.texture),
      codeTheme: pick(parsed.codeTheme, CODE_THEME_IDS, DEFAULT_UI_PREFS.codeTheme),
    };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
};

/**
 * 将偏好写入 <html>（属性 + 根字号）
 * @param animate 是否播放颜色/间距过渡
 */

export const applyUiPreferences = (prefs: UiPreferences, animate = false): void => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  if (animate) {
    root.classList.add('theme-transitioning');
    window.setTimeout(() => root.classList.remove('theme-transitioning'), 460);
  }

  root.setAttribute('data-accent', prefs.accent);
  root.setAttribute('data-density', prefs.density);
  root.setAttribute('data-motion', prefs.motion);
  root.setAttribute('data-texture', prefs.texture);
  root.setAttribute('data-code-theme', prefs.codeTheme);
  root.style.fontSize = `${(16 * prefs.scale).toFixed(2)}px`;
};

/** 保存并应用（局部更新） */
export const updateUiPreferences = (patch: Partial<UiPreferences>): UiPreferences => {
  const next: UiPreferences = { ...getUiPreferences(), ...patch };
  next.scale = clampScale(next.scale);

  try {
    localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式忽略 */
  }

  applyUiPreferences(next, true);
  window.dispatchEvent(new CustomEvent(UI_PREFS_CHANGE_EVENT, { detail: next }));
  return next;
};

/** 恢复全部默认个性化偏好 */
export const resetUiPreferences = (): UiPreferences => {
  const next = { ...DEFAULT_UI_PREFS };
  try {
    localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  applyUiPreferences(next, true);
  window.dispatchEvent(new CustomEvent(UI_PREFS_CHANGE_EVENT, { detail: next }));
  return next;
};
