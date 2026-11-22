import React, { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Palette, X, Check, RotateCcw, MonitorSmartphone, SlidersHorizontal, Type, Sparkles } from 'lucide-react';
import {
  COLOR_PALETTES,
  PALETTE_CHANGE_EVENT,
  applyColorPalette,
  getStoredPalette,
  resetColorPalette,
  type PaletteId,
} from '../utils/themePalette';
import {
  ACCENT_OPTIONS,
  CODE_THEME_OPTIONS,
  DENSITY_OPTIONS,
  MOTION_OPTIONS,
  SCALE_OPTIONS,
  UI_PREFS_CHANGE_EVENT,
  getUiPreferences,
  resetUiPreferences,
  updateUiPreferences,
  type UiPreferences,
} from '../utils/appearance';
import { SegmentedControl } from './SegmentedControl';
import { TexturePicker } from './TexturePicker';
import { useToast } from './Toast';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

type TabKey = 'color' | 'display';

/**
 * 通用分段选择器：直接复用全局 SegmentedControl，
 * 保证与导航栏/信息流切换使用同一套滑块弹簧动画。
 */
const SegmentedSetting = <T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) => {
  const isNumeric = typeof options[0]?.value === 'number';
  return (
    <SegmentedControl
      items={options.map((opt) => ({ key: String(opt.value), label: opt.label }))}
      activeKey={String(value)}
      onChange={(key) => onChange((isNumeric ? Number(key) : key) as T)}
    />
  );
};

const SettingRow: React.FC<{
  title: string;
  desc: string;
  children: React.ReactNode;
}> = ({ title, desc, children }) => (
  <div className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4">
    <div className="space-y-0.5 min-w-0">
      <span className="text-xs font-semibold text-wb-text-primary block">{title}</span>
      <p className="text-2xs text-wb-text-muted leading-relaxed">{desc}</p>
    </div>
    <div className="w-full min-w-0 sm:w-auto sm:shrink-0">{children}</div>
  </div>
);

export const AppearanceSettingsModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const toast = useToast();
  const [tab, setTab] = useState<TabKey>('color');
  const [activeId, setActiveId] = useState<PaletteId>('obsidian');
  const [prefs, setPrefs] = useState<UiPreferences>(() => getUiPreferences());

  useEffect(() => {
    if (!isOpen) return;
    setActiveId(getStoredPalette());
    setPrefs(getUiPreferences());
  }, [isOpen]);

  // 与其他入口（快捷胶囊 / 个人主页）保持同步
  useEffect(() => {
    const syncPalette = () => setActiveId(getStoredPalette());
    const syncPrefs = () => setPrefs(getUiPreferences());
    window.addEventListener(PALETTE_CHANGE_EVENT, syncPalette);
    window.addEventListener(UI_PREFS_CHANGE_EVENT, syncPrefs);
    return () => {
      window.removeEventListener(PALETTE_CHANGE_EVENT, syncPalette);
      window.removeEventListener(UI_PREFS_CHANGE_EVENT, syncPrefs);
    };
  }, []);

  if (!isOpen) return null;

  const handleSelectPalette = (id: PaletteId, name: string) => {
    if (id === activeId) return;
    applyColorPalette(id);
    setActiveId(id);
    toast.success(`全站配色已切换为「${name}」`);
  };

  const handlePatch = <K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) => {
    const next = updateUiPreferences({ [key]: value } as Partial<UiPreferences>);
    setPrefs(next);
  };

  const handleReset = () => {
    const palette = resetColorPalette();
    const defaults = resetUiPreferences();
    setActiveId(palette);
    setPrefs(defaults);
    toast.info('已恢复全部默认外观设置');
  };

  return (
    <Modal open={isOpen} onClose={onClose} widthClass="max-w-xl">
          {/* 顶部标题栏 */}
          <div className="px-6 py-4 border-b border-wb-border-subtle flex items-center justify-between bg-wb-bg-surface/90">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-wb-brand/10 text-wb-brand border border-wb-brand/20">
                <Palette className="w-4 h-4" />
              </div>
              <div>
                <h3 className="font-bold text-sm md:text-base text-wb-text-primary">
                  个性化设置 · 外观
                </h3>
                <p className="text-2xs text-wb-text-muted">
                  配色主题与界面细节 · 修改即时生效
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-full text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 分页标签 */}
          <div className="px-6 pt-3 flex items-center gap-1.5">
            {([
              { key: 'color', label: '配色主题', icon: Palette },
              { key: 'display', label: '显示与动效', icon: SlidersHorizontal },
            ] as { key: TabKey; label: string; icon: React.ElementType }[]).map((item) => {
              const Icon = item.icon;
              const active = tab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTab(item.key)}
                  className={`wb-pressable flex items-center gap-1.5 px-3 py-1.5 rounded-capsule text-2xs font-semibold transition-colors ${
                    active
                      ? 'bg-wb-text-primary text-wb-bg-page'
                      : 'bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>

          <div className="p-6 pt-4 overflow-y-auto space-y-4 flex-1">
            {tab === 'color' ? (
              <>
                <div className="flex items-center justify-between text-xs font-semibold text-wb-text-primary">
                  <span>配色方案</span>
                  <span className="text-3xs text-wb-text-muted font-normal">点击即可实时预览</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {COLOR_PALETTES.map((item) => {
                    const isActive = item.id === activeId;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleSelectPalette(item.id, item.name)}
                        className={`p-2.5 rounded-2xl border text-left transition-all relative ${
                          isActive
                            ? 'border-wb-brand bg-wb-brand/10 shadow-xs'
                            : 'border-wb-border-subtle bg-wb-bg-subtle/40 hover:border-wb-border-strong'
                        }`}
                      >
                        <div className="flex items-stretch gap-1 rounded-xl overflow-hidden border border-wb-border-subtle">
                          <div
                            className="flex-1 h-12 flex items-center justify-center gap-1 relative"
                            style={{ backgroundColor: item.light.page }}
                          >
                            <span
                              className="block w-5 h-7 rounded-[4px]"
                              style={{ backgroundColor: item.light.surface, boxShadow: '0 0 0 1px rgba(0,0,0,0.06)' }}
                            />
                            <span
                              className="block w-2.5 h-2.5 rounded-full"
                              style={
                                item.light.gradient
                                  ? { backgroundImage: item.light.gradient }
                                  : { backgroundColor: item.light.brand }
                              }
                            />
                            <span
                              className="absolute bottom-0.5 right-1.5 text-3xs font-medium"
                              style={{ color: item.light.brand }}
                            >
                              浅
                            </span>
                          </div>
                          <div
                            className="flex-1 h-12 flex items-center justify-center gap-1 relative"
                            style={{ backgroundColor: item.dark.page }}
                          >
                            <span
                              className="block w-5 h-7 rounded-[4px]"
                              style={{ backgroundColor: item.dark.surface, boxShadow: '0 0 0 1px rgba(255,255,255,0.08)' }}
                            />
                            <span
                              className="block w-2.5 h-2.5 rounded-full"
                              style={
                                item.dark.gradient
                                  ? { backgroundImage: item.dark.gradient }
                                  : { backgroundColor: item.dark.brand }
                              }
                            />
                            <span
                              className="absolute bottom-0.5 right-1.5 text-3xs font-medium"
                              style={{ color: item.dark.brand }}
                            >
                              深
                            </span>
                          </div>
                        </div>

                        <div className="mt-2 flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-baseline gap-1.5">
                              <span className="text-xs font-bold text-wb-text-primary">{item.name}</span>
                              <span className="text-3xs text-wb-text-muted font-mono truncate">{item.en}</span>
                            </div>
                            <p className="text-3xs text-wb-text-muted leading-relaxed mt-0.5 line-clamp-1">
                              {item.desc}
                            </p>
                          </div>
                          {isActive && <Check className="w-3.5 h-3.5 text-wb-brand shrink-0 mt-0.5" />}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* 强调色 */}
                <div className="pt-1 border-t border-wb-border-subtle space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-wb-text-primary pt-3">
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-wb-brand" />
                      <span>强调色</span>
                    </span>
                    <span className="text-3xs text-wb-text-muted font-normal">
                      覆盖当前配色方案的点缀色
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {ACCENT_OPTIONS.map((accent) => {
                      const isActive = accent.id === prefs.accent;
                      return (
                        <button
                          key={accent.id}
                          type="button"
                          title={accent.name}
                          onClick={() => handlePatch('accent', accent.id)}
                          className={`group relative w-8 h-8 rounded-full border transition-all flex items-center justify-center ${
                            isActive
                              ? 'border-wb-text-primary ring-2 ring-wb-text-primary/20'
                              : 'border-wb-border-strong hover:scale-105'
                          }`}
                          style={
                            accent.id === 'default'
                              ? { backgroundColor: 'transparent' }
                              : accent.second
                              ? { backgroundImage: `linear-gradient(135deg, ${accent.light}, ${accent.second})` }
                              : { backgroundColor: accent.light }
                          }
                        >
                          {accent.id === 'default' ? (
                            <span className="text-3xs font-bold text-wb-text-secondary">自动</span>
                          ) : isActive ? (
                            <Check className="w-3.5 h-3.5 text-white drop-shadow" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-3xs text-wb-text-muted leading-relaxed">
                    色板按浅色模式呈现，深色模式下会自动取对应的高亮变体，保证对比度。
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between text-xs font-semibold text-wb-text-primary">
                  <span className="flex items-center gap-1.5">
                    <Type className="w-3.5 h-3.5 text-wb-brand" />
                    <span>显示与动效</span>
                  </span>
                  <span className="text-3xs text-wb-text-muted font-normal">立即生效</span>
                </div>

                <div className="divide-y divide-wb-border-subtle">
                  <SettingRow
                    title="界面字号"
                    desc="等比缩放全站文字与间距，适合不同分辨率屏幕。"
                  >
                    <SegmentedSetting
                      options={SCALE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                      value={prefs.scale}
                      onChange={(v) => handlePatch('scale', v)}
                    />
                  </SettingRow>

                  <SettingRow
                    title="界面密度"
                    desc="控制列表与卡片的留白呼吸感：紧凑更省屏，宽松更舒展。"
                  >
                    <SegmentedSetting
                      options={DENSITY_OPTIONS}
                      value={prefs.density}
                      onChange={(v) => handlePatch('density', v)}
                    />
                  </SettingRow>

                  <SettingRow
                    title="动效强度"
                    desc="减弱会保留淡入淡出但去掉位移与缩放；关闭则完全静止。"
                  >
                    <SegmentedSetting
                      options={MOTION_OPTIONS}
                      value={prefs.motion}
                      onChange={(v) => handlePatch('motion', v)}
                    />
                  </SettingRow>

                  <SettingRow
                    title="背景质感"
                    desc="12 种预设，从极简到「闪光弹」。点击右侧展开二级菜单挑选。"
                  >
                    <TexturePicker
                      value={prefs.texture}
                      onChange={(v) => handlePatch('texture', v)}
                    />
                  </SettingRow>

                  <SettingRow
                    title="代码块主题"
                    desc="独立于全站配色的代码展示风格，终端黑常驻深色。"
                  >
                    <SegmentedSetting
                      options={CODE_THEME_OPTIONS}
                      value={prefs.codeTheme}
                      onChange={(v) => handlePatch('codeTheme', v)}
                    />
                  </SettingRow>
                </div>
              </>
            )}

            <div className="flex items-start gap-2 p-3 rounded-2xl border border-wb-border-subtle bg-wb-bg-subtle/30">
              <MonitorSmartphone className="w-3.5 h-3.5 text-wb-text-muted shrink-0 mt-0.5" />
              <p className="text-2xs text-wb-text-muted leading-relaxed">
                所有外观设置保存在当前设备的浏览器中，换设备不会跟随；清除站点数据后会恢复默认。深浅模式仍可在快捷面板单独切换。
              </p>
            </div>
          </div>

          <div className="px-6 py-4 border-t border-wb-border-subtle bg-wb-bg-surface/90 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={handleReset}
              className="px-3.5 py-2 rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle/80 text-xs font-semibold transition-colors flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>恢复默认外观</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page hover:opacity-90 text-xs font-bold transition-opacity shadow-sm flex items-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5" />
              <span>完成</span>
            </button>
          </div>
    </Modal>
  );
};
