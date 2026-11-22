import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Check } from 'lucide-react';

export interface DropdownOption {
  value: string | number;
  label: string;
  description?: string;
  badge?: string;
}

interface Props {
  label?: string;
  value: string | number;
  onChange: (value: any) => void;
  options: DropdownOption[];
  icon?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  size?: 'xs' | 'sm' | 'md';
  align?: 'left' | 'right';
  menuWidth?: string;
  className?: string;
  /** 追加到触发按钮上的类（写在默认样式之后，可用于局部配色/尺寸覆写） */
  triggerClassName?: string;
}

const MENU_MAX_HEIGHT = 280;
const VIEWPORT_MARGIN = 8;

export const CustomDropdown: React.FC<Props> = ({
  label,
  value,
  onChange,
  options,
  icon,
  placeholder = '请选择...',
  disabled = false,
  size = 'md',
  align = 'left',
  menuWidth,
  className = '',
  triggerClassName = '',
}) => {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{
    left: number;
    top: number;
    width?: number;
    maxHeight: number;
    placement: 'bottom' | 'top';
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.value === value);

  /**
   * 菜单改为 fixed + portal 渲染：
   * 此前 absolute 面板会参与文档滚动尺寸计算，展开瞬间可能出现滚动条/布局抖动，
   * 表现为整页内容横向跳一下。fixed 定位完全不占用文档流，从根上消除。
   */
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - VIEWPORT_MARGIN;
    const placement: 'bottom' | 'top' =
      spaceBelow < 180 && spaceAbove > spaceBelow ? 'top' : 'bottom';
    const available = placement === 'bottom' ? spaceBelow : spaceAbove;
    const maxHeight = Math.max(140, Math.min(MENU_MAX_HEIGHT, available - 6));

    const desiredWidth = size === 'md' ? rect.width : 180;
    let left = align === 'right' ? rect.right - desiredWidth : rect.left;
    left = Math.min(Math.max(VIEWPORT_MARGIN, left), window.innerWidth - desiredWidth - VIEWPORT_MARGIN);

    setMenuStyle({
      left,
      top: placement === 'bottom' ? rect.bottom + 6 : rect.top - 6,
      width: size === 'md' ? rect.width : undefined,
      maxHeight,
      placement,
    });
  }, [align, size]);

  // 打开时定位 + 跟随滚动/缩放，避免菜单与触发器脱节
  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handle = () => updatePosition();
    window.addEventListener('resize', handle);
    window.addEventListener('scroll', handle, true);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
    };
  }, [open, updatePosition]);

  // 点击外部关闭（菜单在 portal 中，不能只看 trigger 容器）
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const triggerSizeClasses = {
    xs: 'h-7 px-2.5 rounded-capsule text-2xs gap-1.5',
    sm: 'h-8 px-3 rounded-capsule text-xs gap-2',
    md: 'w-full px-3.5 py-2.5 rounded-2xl text-xs gap-2',
  }[size];

  const itemSizeClasses = {
    xs: 'px-2 py-1.5 rounded-lg text-2xs',
    sm: 'px-2.5 py-2 rounded-xl text-xs',
    md: 'p-2.5 rounded-xl text-xs',
  }[size];

  return (
    <div
      className={`relative select-none ${open ? 'z-50' : 'z-10'} ${
        size === 'md' ? 'space-y-1.5 w-full' : 'inline-block'
      } ${className}`}
      ref={containerRef}
    >
      {label && (
        <label className="block text-xs font-semibold text-wb-text-secondary">{label}</label>
      )}

      {/* 触发器按钮 (与全站黑白钛金属设计语言对齐) */}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center justify-between border text-left transition-all wb-pressable ${triggerSizeClasses} ${
          open
            ? 'bg-wb-bg-surface border-wb-text-primary shadow-sm'
            : 'bg-wb-bg-subtle/90 border-wb-border-subtle hover:border-wb-border-strong text-wb-text-primary'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${triggerClassName}`}
      >
        <div className="flex items-center gap-1.5 truncate">
          {icon && <span className="text-wb-text-muted flex-shrink-0">{icon}</span>}
          <span className={`font-medium truncate ${selectedOption ? 'text-wb-text-primary' : 'text-wb-text-muted'}`}>
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          {selectedOption?.badge && (
            <span className="text-3xs font-semibold px-1.5 py-0.2 rounded-capsule bg-wb-bg-elevated border border-wb-border-subtle text-wb-text-secondary">
              {selectedOption.badge}
            </span>
          )}
        </div>

        <ChevronDown
          className={`w-3.5 h-3.5 text-wb-text-muted transition-transform duration-200 flex-shrink-0 ${
            open ? 'rotate-180 text-wb-text-primary' : ''
          }`}
        />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && menuStyle && (
            <motion.div
              ref={menuRef}
              role="listbox"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
              style={{
                position: 'fixed',
                left: menuStyle.left,
                top: menuStyle.top,
                width: menuStyle.width,
                maxHeight: menuStyle.maxHeight,
                transform: menuStyle.placement === 'top' ? 'translateY(-100%)' : undefined,
                zIndex: 130,
              }}
              className={`p-1.5 frost border border-wb-border-strong rounded-2xl shadow-2xl space-y-1 overflow-y-auto wb-scrollbar-thin box-border ${
                menuWidth || (size === 'md' ? '' : 'min-w-[140px]')
              }`}
            >
              {options.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className={`w-full flex items-center justify-between transition-colors text-left ${itemSizeClasses} ${
                      isSelected
                        ? 'bg-wb-text-primary text-wb-bg-page font-semibold'
                        : 'text-wb-text-primary hover:bg-wb-bg-subtle'
                    }`}
                  >
                    <div className="flex flex-col items-start gap-0.5 truncate">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate">{opt.label}</span>
                        {opt.badge && (
                          <span
                            className={`text-3xs px-1.5 py-0.2 rounded-capsule ${
                              isSelected
                                ? 'bg-wb-bg-page/20 text-wb-bg-page'
                                : 'bg-wb-bg-subtle text-wb-text-secondary border border-wb-border-subtle'
                            }`}
                          >
                            {opt.badge}
                          </span>
                        )}
                      </div>
                      {opt.description && (
                        <span
                          className={`text-3xs leading-tight ${
                            isSelected ? 'text-wb-bg-page/70' : 'text-wb-text-muted'
                          }`}
                        >
                          {opt.description}
                        </span>
                      )}
                    </div>

                    {isSelected && <Check className="w-3.5 h-3.5 ml-2 flex-shrink-0" />}
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
};
