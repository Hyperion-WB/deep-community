import React, { useEffect, useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { UI_PREFS_CHANGE_EVENT, getUiPreferences, type MotionLevel } from '../utils/appearance';

/**
 * 让「动效强度」设置同时作用于 framer-motion 动画。
 * - full：跟随系统 prefers-reduced-motion
 * - soft / off：始终降级（保留透明度渐变，去掉位移、缩放、布局动画）
 * CSS 侧的过渡与关键帧由 html[data-motion] 控制。
 */
export const MotionPreferenceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [motion, setMotion] = useState<MotionLevel>(() => getUiPreferences().motion);

  useEffect(() => {
    const handler = () => setMotion(getUiPreferences().motion);
    window.addEventListener(UI_PREFS_CHANGE_EVENT, handler);
    return () => window.removeEventListener(UI_PREFS_CHANGE_EVENT, handler);
  }, []);

  return (
    <MotionConfig reducedMotion={motion === 'full' ? 'user' : 'always'}>
      {children}
    </MotionConfig>
  );
};
