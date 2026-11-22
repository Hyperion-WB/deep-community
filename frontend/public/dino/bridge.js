/**
 * 404 页 <-> 原版小恐龙 iframe 的桥接。
 *
 * 说明：站内 CSP 是 script-src 'self'（不允许 inline），
 * 所以这段逻辑必须放在外部文件里，不能写进 index.html 的内联 <script>。
 *
 * 原版 Runner 会把单例挂在 window.Runner.instance_ 上，
 * distanceRan 是累计像素，原版显示分数 = round(distanceRan * 0.025)。
 */
(function () {
  'use strict';
  var lastSent = -1;

  setInterval(function () {
    try {
      var r = window.Runner && window.Runner.instance_;
      if (!r) return;
      var score = Math.round((r.distanceRan || 0) * 0.025);
      var crashed = !!r.crashed;
      // 分数没变化且状态没变时不必重复发
      if (score === lastSent && !crashed) return;
      lastSent = score;
      parent.postMessage({ type: 'wb-dino', score: score, over: crashed }, '*');
    } catch (e) {
      /* iframe 内静默 */
    }
  }, 350);
})();
