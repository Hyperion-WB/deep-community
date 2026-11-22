/* 首帧前应用主题与外观偏好，避免闪屏。
 * 独立为外部脚本是为了满足严格 CSP（不放开 script-src 'unsafe-inline'）。
 */
(function () {
  try {
    var t = localStorage.getItem('theme');
    var isDark = t === 'dark' || ((!t || t === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');

    var p = localStorage.getItem('geek_color_palette');
    if (p) document.documentElement.setAttribute('data-palette', p);

    var raw = localStorage.getItem('geek_ui_prefs');
    if (raw) {
      var u = JSON.parse(raw) || {};
      var root = document.documentElement;
      if (u.accent) root.setAttribute('data-accent', u.accent);
      if (u.density) root.setAttribute('data-density', u.density);
      if (u.motion) root.setAttribute('data-motion', u.motion);
      if (u.texture) root.setAttribute('data-texture', u.texture);
      if (u.codeTheme) root.setAttribute('data-code-theme', u.codeTheme);
      if (u.scale) root.style.fontSize = (16 * u.scale).toFixed(2) + 'px';
    }
  } catch (e) {}
})();
