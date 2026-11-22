/**
 * 全站覆盖层协调器。
 *
 * 之前每个弹窗各自保存/恢复 document.body.style.overflow，并各自监听 ESC：
 * - 嵌套弹窗按不同顺序关闭时，背景会被永久锁死或提前解锁；
 * - 一次 ESC 会把抽屉、灯箱、通知面板一起关掉。
 *
 * 这里用「滚动锁计数 + ESC 栈」统一管理：
 * - 只有计数归零才把 overflow 恢复到最初的值；
 * - 只有一个全局 keydown 监听，且只调用栈顶覆盖层的 handler。
 */

type EscEntry = { id: string; handler: () => void };

let lockCount = 0;
let savedOverflow = '';
const escStack: EscEntry[] = [];
let keyListenerAdded = false;

const onGlobalKeyDown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return;
  const top = escStack[escStack.length - 1];
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  top.handler();
};

function ensureKeyListener() {
  if (keyListenerAdded) return;
  document.addEventListener('keydown', onGlobalKeyDown, true);
  keyListenerAdded = true;
}

/** 占用一次背景滚动锁，返回释放函数（必须成对调用）。 */
export function acquireScrollLock(): () => void {
  if (lockCount === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) {
      document.body.style.overflow = savedOverflow;
    }
  };
}

/** 注册一个 ESC 处理器；只有最后注册的（栈顶）会响应。 */
export function registerEsc(id: string, handler: () => void): () => void {
  ensureKeyListener();
  const entry: EscEntry = { id, handler };
  escStack.push(entry);
  return () => {
    const idx = escStack.findIndex((e) => e.id === id);
    if (idx !== -1) escStack.splice(idx, 1);
  };
}

/** 覆盖层是否处于栈顶（供仍保留自有监听的旧组件过渡使用）。 */
export function isTopOverlay(id: string): boolean {
  return escStack.length > 0 && escStack[escStack.length - 1].id === id;
}
