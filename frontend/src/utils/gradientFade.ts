/**
 * 渐变氛围光交叉淡入。
 *
 * CSS 的 background-image（渐变）无法插值，单靠 transition 只能瞬间跳变。
 * 这里用两层伪元素：::before 固化「旧渐变」，::after 显示「新渐变」并淡入，
 * 过渡结束后再把旧值同步成新值，视觉上就是平滑的颜色过渡。
 */
let fadeTimer: number | undefined;

export const crossFadePageGradient = (apply: () => void): void => {
  const root = document.documentElement;
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      apply();
      return;
    }
    const prev = getComputedStyle(root).getPropertyValue('--wb-page-gradient').trim();
    root.style.setProperty('--wb-page-gradient-old', prev || 'none');
    apply();
    // 强制回流，确保旧层变量已生效再开始淡入
    void root.offsetHeight;
    root.classList.add('page-gradient-fade');
    if (fadeTimer) window.clearTimeout(fadeTimer);
    fadeTimer = window.setTimeout(() => {
      const cur = getComputedStyle(root).getPropertyValue('--wb-page-gradient').trim();
      root.style.setProperty('--wb-page-gradient-old', cur || 'none');
      root.classList.remove('page-gradient-fade');
    }, 480);
  } catch {
    apply();
  }
};
