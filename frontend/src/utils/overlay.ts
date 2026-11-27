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

type EscEntry = { id: string; handler: () => void; priority: number };

let lockCount = 0;
let savedOverflow = '';
const escStack: EscEntry[] = [];

const getTopEntry = () => escStack.reduce<EscEntry | undefined>(
  (top, entry) => !top || entry.priority >= top.priority ? entry : top,
  undefined,
);

const onGlobalKeyDown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  const top = getTopEntry();
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) top.handler();
};

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

/** 按覆盖层的 z-index 排序；同层时最后打开的优先。 */
export function registerEsc(id: string, handler: () => void, priority = 100): () => void {
  if (escStack.length === 0) document.addEventListener('keydown', onGlobalKeyDown, true);
  const entry: EscEntry = { id, handler, priority };
  escStack.push(entry);
  return () => {
    const idx = escStack.indexOf(entry);
    if (idx === -1) return;
    escStack.splice(idx, 1);
    if (escStack.length === 0) document.removeEventListener('keydown', onGlobalKeyDown, true);
  };
}

/** 覆盖层是否位于栈顶（供焦点和其他快捷键使用）。 */
export function isTopOverlay(id: string): boolean {
  return getTopEntry()?.id === id;
}
