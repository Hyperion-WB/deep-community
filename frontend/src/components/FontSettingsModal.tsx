import React, { useState, useEffect } from 'react';
import { Modal } from './Modal';
import { Type, X, Check, RotateCcw, Sparkles, ChevronDown } from 'lucide-react';
import { applyCustomFont, getStoredCustomFont } from '../utils/fontUtils';
import { useToast } from './Toast';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const PRESET_FONTS = [
  // 只保留「开源可自由分发」与「自带托管」两类，去掉苹方/雅黑等商业字体，避免侵权
  { name: '', label: '系统默认', os: '跟随设备 · 最稳' },
  { name: 'HarmonyOS Sans SC', label: '鸿蒙黑体', os: '站点自带 · 全平台一致' },
  { name: 'JetBrains Mono', label: 'JetBrains Mono', os: '等宽 · 本机已装才生效' },
  { name: 'Fira Code', label: 'Fira Code', os: '等宽连字 · 本机已装才生效' },
  { name: 'LXGW WenKai', label: '霞鹜文楷', os: '开源楷体 · 本机已装才生效' },
];

export const FontSettingsModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const toast = useToast();
  const [fontName, setFontName] = useState('');
  // 手动输入字体名属于进阶用法（多数商业字体在手机上不可用），默认收起
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [activeFont, setActiveFont] = useState('');

  useEffect(() => {
    if (isOpen) {
      const stored = getStoredCustomFont();
      setFontName(stored);
      setActiveFont(stored);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleApply = (targetFont?: string) => {
    const val = typeof targetFont === 'string' ? targetFont : fontName;
    const clean = val.trim();
    applyCustomFont(clean);
    setActiveFont(clean);
    setFontName(clean);
    if (clean) {
      toast.success(`字体已切换为「${clean}」`);
    } else {
      toast.info('已恢复系统预设默认字体');
    }
    onClose();
  };

  const handleReset = () => {
    applyCustomFont('');
    setActiveFont('');
    setFontName('');
    toast.info('已重置并恢复系统默认字体');
    onClose();
  };

  return (
    <Modal open={isOpen} onClose={onClose} widthClass="max-w-lg">
          {/* 模态框顶部 */}
          <div className="px-6 py-4 border-b border-wb-border-subtle flex items-center justify-between bg-wb-bg-surface/90">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-wb-brand/10 text-wb-brand border border-wb-brand/20">
                <Type className="w-4 h-4" />
              </div>
              <div>
                <h3 className="font-bold text-sm md:text-base text-wb-text-primary">
                  个性化设置 · 自定义系统字体
                </h3>
                <p className="text-2xs text-wb-text-muted">
                  支持调用您本地电脑中已安装的任何系统字体
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

          <div className="p-6 overflow-y-auto space-y-5 flex-1">
            {/* 手动输入字体名：进阶选项，默认收起，避免误导用户输入手机不存在的字体 */}
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex w-full items-center justify-between text-xs font-semibold text-wb-text-secondary hover:text-wb-text-primary transition-colors"
              >
                <span className="flex items-center gap-1.5">
                  <Type className="w-3.5 h-3.5" />
                  手动输入字体名（进阶）
                </span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
              </button>
              {showAdvanced && (
                <div className="animate-fade-in">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-semibold text-wb-text-primary">
                  本地系统字体名称 (Font Family)
                </label>
                {activeFont && (
                  <span className="text-3xs px-2 py-0.5 rounded-full bg-wb-brand/10 text-wb-brand font-mono font-medium">
                    当前应用: {activeFont}
                  </span>
                )}
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={fontName}
                  onChange={(e) => setFontName(e.target.value)}
                  placeholder="例如: 霞鹜文楷、微软雅黑、Fira Code、苹方..."
                  className="w-full px-4 py-2.5 text-xs md:text-sm rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary placeholder:text-wb-text-muted focus:outline-none focus:ring-2 focus:ring-wb-brand/30 focus:border-wb-brand transition-all"
                />
                {fontName && (
                  <button
                    type="button"
                    onClick={() => setFontName('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-wb-text-muted hover:text-wb-text-primary p-0.5"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <p className="text-2xs text-wb-text-muted leading-relaxed">
                无需向服务器上传字体文件，直接输入本地计算机中已安装的字体族名称即可全站即时渲染生效。
              </p>
            </div>

                </div>
              )}
            </div>

            {/* 常用热门系统字体快捷预设 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-wb-text-primary">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-wb-brand" />
                  <span>快捷预设推荐</span>
                </span>
                <span className="text-3xs text-wb-text-muted font-normal">点击填入</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {PRESET_FONTS.map((font) => {
                  const isSelected = fontName.trim().toLowerCase() === font.name.toLowerCase();
                  return (
                    <button
                      key={font.name}
                      type="button"
                      onClick={() => setFontName(font.name)}
                      className={`p-2.5 rounded-xl border text-left transition-all relative ${
                        isSelected
                          ? 'border-wb-text-primary/45 bg-wb-text-primary/[0.06] text-wb-text-primary shadow-xs'
                          : 'border-wb-border-subtle bg-wb-bg-subtle/40 hover:border-wb-border-strong text-wb-text-secondary hover:text-wb-text-primary'
                      }`}
                    >
                      <div className="font-semibold text-xs truncate" style={{ fontFamily: `"${font.name}", sans-serif` }}>
                        {font.label}
                      </div>
                      <div className="text-3xs text-wb-text-muted truncate mt-0.5">
                        {font.os}
                      </div>
                      {isSelected && (
                        <Check className="w-3.5 h-3.5 absolute right-2 top-2 text-wb-text-primary" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 实时字体排版效果预览区 */}
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-wb-text-primary">
                实时字体渲染效果预览
              </label>
              <div
                className="p-4 rounded-2xl border border-wb-border-subtle bg-wb-bg-subtle/30 space-y-2.5 transition-all"
                style={{
                  // 与全局 --font-custom 保持同一套回退链，预览与真实生效一致
                  fontFamily: fontName.trim()
                    ? `"${fontName.trim()}", "HarmonyOS Sans SC", -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif`
                    : 'inherit',
                }}
              >
                <div className="text-sm font-bold text-wb-text-primary">
                  极客技术社区 · 架构与算法之美
                </div>
                <div className="text-xs text-wb-text-secondary leading-relaxed">
                  The quick brown fox jumps over the lazy dog. 专注探索尖端算力与架构前沿，坚持纯粹极客精神。
                </div>
                <div className="text-2xs text-wb-text-muted font-mono">
                  const code = (x: number) =&gt; x &gt;= 0 ? Math.sqrt(x) : -1; // 0123456789
                </div>
              </div>
            </div>
          </div>

          {/* 模态框底部按钮栏 */}
          <div className="px-6 py-4 border-t border-wb-border-subtle bg-wb-bg-surface/90 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={handleReset}
              className="px-3.5 py-2 rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle/80 text-xs font-semibold transition-colors flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>恢复默认字体</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-capsule border border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary text-xs font-semibold transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => handleApply()}
                className="px-5 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page hover:opacity-90 text-xs font-bold transition-opacity shadow-sm flex items-center gap-1.5"
              >
                <Check className="w-3.5 h-3.5" />
                <span>保存并应用</span>
              </button>
            </div>
          </div>
    </Modal>
  );
};
