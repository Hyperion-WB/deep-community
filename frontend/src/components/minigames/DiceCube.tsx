import React, { useEffect, useRef, useState } from 'react';

/**
 * 纯 CSS 3D 骰子（无 ThreeJS / WebGL / canvas，零依赖，约 3KB）。
 *
 * - value 由后端 msg_type='dice' 下发，组件只读，不产生也不能修改点数
 * - 落点由 value 决定：目标旋转角是固定映射，多人看到同一动画与同一结果，
 *   时间上可确定（不依赖随机种子或帧率），适合多人同步
 * - onRollEnd 在动画真正结束时触发一次（transitionend + 兜底定时器）
 * - animate=false（历史消息）直接呈现朝上点数，不播放动画
 */

// 点阵位置：3x3 网格中的索引
const FACE_PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

// 立方体六面：前 1 / 右 2 / 上 3 / 下 4 / 左 5 / 后 6（对面和为 7）
// 注意类名必须与 index.css 中的 .wb-dice__face--xxx 完全一致
const FACES: { value: number; cls: string }[] = [
  { value: 1, cls: 'wb-dice__face--front' },
  { value: 2, cls: 'wb-dice__face--right' },
  { value: 3, cls: 'wb-dice__face--top' },
  { value: 4, cls: 'wb-dice__face--bottom' },
  { value: 5, cls: 'wb-dice__face--left' },
  { value: 6, cls: 'wb-dice__face--back' },
];

// 让指定面朝向观察者的固定欧拉角：额外多转整圈产生翻滚观感，
// 且映射后角度 mod 360 必须精确对应目标面（1→0/0，2→0/-90，3→-90/0，
// 4→90/0，5→0/90，6→0/180）。
const LANDING: Record<number, { x: number; y: number }> = {
  1: { x: -360, y: -360 },   // 0 / 0      → front
  2: { x: -360, y: -450 },   // 0 / -90    → right
  3: { x: -450, y: -360 },   // -90 / 0    → top
  4: { x: -270, y: -360 },   // 90 / 0     → bottom
  5: { x: -360, y: -270 },   // 0 / 90     → left
  6: { x: -360, y: -540 },   // 0 / -180   → back
};

const START_TRANSFORM = 'rotateX(0deg) rotateY(0deg)';
const ROLL_MS = 1250;

interface Props {
  /** 后端下发的点数 1~6，组件不可修改 */
  value: number;
  /** 是否播放翻滚动画；历史消息传 false 直接展示朝上点数 */
  animate?: boolean;
  /** 动画结束回调（仅播放动画时触发一次） */
  onRollEnd?: (value: number) => void;
  size?: number;
}

export const DiceCube: React.FC<Props> = ({ value, animate = false, onRollEnd, size = 56 }) => {
  const v = Math.max(1, Math.min(6, Number(value) || 1));
  const landing = LANDING[v];
  const target = `rotateX(${landing.x}deg) rotateY(${landing.y}deg)`;

  // 用 state 持有 transform：只有「初始 0 → 目标角」发生真实变化，
  // CSS transition 才会生效（之前用计算值，状态没变导致先静止再瞬间跳）。
  const [transform, setTransform] = useState<string>(animate ? START_TRANSFORM : target);
  const [rolling, setRolling] = useState(animate);
  const doneRef = useRef(false);
  const cbRef = useRef(onRollEnd);
  cbRef.current = onRollEnd;

  useEffect(() => {
    if (!animate) {
      doneRef.current = false;
      setRolling(false);
      setTransform(target);
      return;
    }
    doneRef.current = false;
    setRolling(true);
    setTransform(START_TRANSFORM);

    // 双 rAF：确保浏览器已绘制起始状态，再切到目标角触发过渡
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        setTransform(`rotateX(${landing.x}deg) rotateY(${landing.y}deg)`);
      });
    });

    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      setRolling(false);
      cbRef.current?.(v);
    };
    const timer = window.setTimeout(finish, ROLL_MS + 220);

    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, v]);

  const handleTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.propertyName !== 'transform' || !rolling) return;
    if (doneRef.current) return;
    doneRef.current = true;
    setRolling(false);
    cbRef.current?.(v);
  };

  return (
    <div
      className="wb-dice"
      style={{ width: size, height: size, ['--dice-half' as any]: `${size / 2}px` }}
      aria-label={`骰子 ${v} 点`}
      data-dice-value={v}
      data-animated={animate ? 'true' : 'false'}
      role="img"
    >
      <div
        className={`wb-dice__cube ${rolling ? 'wb-dice__cube--rolling' : ''}`}
        style={{ transform }}
        onTransitionEnd={handleTransitionEnd}
      >
        {FACES.map((f) => (
          <div key={f.value} className={`wb-dice__face ${f.cls}`}>
            <div className="wb-dice__grid">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} className={FACE_PIPS[f.value].includes(i) ? 'wb-dice__pip' : 'wb-dice__empty'} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
