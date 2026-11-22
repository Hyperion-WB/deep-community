/* flea-game 通用桥接 v2
   - 每个游戏按真实 HUD 采集原始成绩/步数/关卡/难度/用时，不再把历史最高分
     或隐藏的「恭喜」静态文案当成本局成绩
   - 只有真正「可见」的结束层才算完成；Toast 用 MutationObserver 锁存，
     避免 2~3 秒临时 DOM 被 900ms 轮询错过
   - 捕获阶段拦截方向键/空格默认行为，防止 iframe 或父页面滚动
   采集层不是信任边界，服务端仍做 run_id / 时长 / 操作序列校验。 */
(function () {
  var parentOrigin = window.location.origin;
  var GAME = (location.pathname.match(/\/flea-games\/([^/]+)\//) || [])[1] || '';
  var startedAt = Date.now();
  var ended = false;
  var events = [];
  var wonFlag = false, lostFlag = false, lastSent = -1;

  /* ---------- 反作弊操作序列 ---------- */
  function pushEvent(kind, key) {
    if (events.length >= 5000) return;
    events.push({ t: Date.now() - startedAt, k: kind, v: String(key || '').slice(0, 24) });
  }
  // 捕获阶段统一挡住方向键/空格的默认滚动（父页面另有转发兜底）
  document.addEventListener('keydown', function (e) {
    if (/^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight| |Spacebar)$/.test(e.key)) e.preventDefault();
    pushEvent('key', e.key);
  }, true);
  document.addEventListener('pointerdown', function (e) {
    pushEvent('ptr', (e.target && e.target.id) || (e.target && e.target.tagName) || '');
  }, true);

  /* ---------- 工具 ---------- */
  function el(id) { return document.getElementById(id); }
  function txt(id) { var e = el(id); return e ? (e.textContent || '').trim() : ''; }
  function num(v) {
    var t = String(v == null ? '' : v).replace(/,/g, '').replace(/[^\d.\-]/g, '');
    var n = parseFloat(t); return isNaN(n) ? 0 : n;
  }
  function numId(id) { return num(txt(id)); }
  function secs(v) {
    var t = String(v || '').trim();
    if (t.indexOf(':') >= 0) {
      var p = t.split(':');
      return (num(p[0]) || 0) * 60 + (num(p[1]) || 0);
    }
    return num(t);
  }
  function selectLevel(id) {
    var e = el(id);
    return e && e.tagName === 'SELECT' ? (e.selectedIndex + 1) : 1;
  }
  function visible(e) {
    if (!e) return false;
    var c = getComputedStyle(e);
    return c.display !== 'none' && c.visibility !== 'hidden' && parseFloat(c.opacity || '1') > 0.1;
  }

  /* ---------- 结束层检测 ---------- */
  var WIN_RE = /恭喜|通关|过关|完成了这局|新纪录|你赢了|胜利|完成游戏/i;
  var LOSE_RE = /游戏结束|失败|步数用完|再试一次|Game Over/i;
  function scanEnd() {
    if (wonFlag) return;
    var nodes = document.querySelectorAll(
      '.game-message,.overlay,.game-over,.toast,.notification,[class*="toast"],[class*="message"],[class*="dialog"]'
    );
    for (var i = 0; i < nodes.length; i++) {
      var e = nodes[i];
      if (!visible(e)) continue;                       // opacity:0 的静态 overlay 不算
      var t = (e.innerText || e.textContent || '').trim();
      if (!t || t.length > 200) continue;
      if (WIN_RE.test(t)) { wonFlag = true; break; }
      if (LOSE_RE.test(t)) lostFlag = true;
    }
    // canvas 类游戏：撞车/结束由内部状态判断
    if (GAME === 'dino') {
      try {
        var r = window.Runner && window.Runner.instance_;
        if (r && (r.crashed || r.gameOver)) lostFlag = true;
      } catch (err) {}
    }
  }
  var mo = new MutationObserver(scanEnd);
  // bridge 在 <head> 里执行，此时 document.body 还不存在，观察 document 本身
  try {
    mo.observe(document, { childList: true, subtree: true, characterData: true });
  } catch (err) {
    // 兜底：等 body 就绪后再挂
    document.addEventListener('DOMContentLoaded', function () {
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  }
  setInterval(scanEnd, 500);

  /* ---------- 每个游戏的结构化成绩 ---------- */
  function collect() {
    var m = {
      raw: 0, elapsedMs: Date.now() - startedAt, moves: 0, level: 1,
      difficultyLevel: 1, progress: 0, won: wonFlag,
      finished: wonFlag || lostFlag
    };
    switch (GAME) {
      case '2048':
        m.raw = numId('score');                     // 排除 best-score（历史最高）
        m.progress = Math.min(1, m.raw / 20000);
        break;
      case 'dino':
        m.raw = numId('score');
        m.progress = Math.min(1, m.raw / 8000);
        m.difficultyLevel = selectLevel('difficulty-select');
        break;
      case 'shudu':
        m.elapsedMs = secs(txt('timer')) * 1000;    // 游戏内计时，不是墙钟
        m.moves = Math.round(m.elapsedMs / 1000);
        m.difficultyLevel = selectLevel('difficulty');
        m.progress = wonFlag ? 1 : 0.35;
        break;
      case 'memory':
        m.moves = numId('moves');                   // 步数越少越强
        m.difficultyLevel = selectLevel('grid-size');
        m.progress = wonFlag ? 1 : 0.35;
        break;
      case 'tetris':
        m.raw = numId('score');                     // 排除 high-score
        m.level = numId('level') || 1;
        m.difficultyLevel = selectLevel('difficulty-select');
        m.progress = Math.min(1, m.raw / 10000);
        break;
      case 'match3':
        m.raw = numId('score');                     // 排除 best/target/victory
        m.level = numId('level-num') || 1;
        m.progress = Math.min(1, m.raw / 10000);
        break;
      case 'sokoban':
        m.moves = numId('moves-count');
        m.level = numId('level-num') || 1;
        m.difficultyLevel = m.level;
        m.progress = wonFlag ? 1 : Math.min(0.9, m.level / 10);
        break;
      case 'minesweeper':
        m.elapsedMs = secs(txt('timer')) * 1000;
        m.moves = Math.round(m.elapsedMs / 1000);
        m.difficultyLevel = selectLevel('difficulty');
        m.progress = wonFlag ? 1 : 0.35;
        break;
    }
    return m;
  }

  function send(final) {
    var m = collect();
    var raw = Math.max(0, m.raw);
    if (raw === lastSent && !final) return;
    lastSent = raw;
    if (final) ended = true;
    try {
      parent.postMessage({
        type: 'flea-game', game: GAME,
        score: raw, durationMs: Date.now() - startedAt,
        completed: m.finished, won: m.won, progress: m.progress,
        metrics: m, events: events.slice(-2000), final: !!final
      }, parentOrigin);
    } catch (e) {}
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== parentOrigin || !e.data) return;
    if (e.data.type === 'wb-game-reset') {
      startedAt = Date.now(); lastSent = -1; ended = false;
      wonFlag = false; lostFlag = false; events = [];
    }
  });

  setInterval(function () { if (!ended) send(false); }, 900);
  window.addEventListener('beforeunload', function () { send(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') send(true);
  });
})();
