import React, { useEffect, useRef } from 'react';

/**
 * 中国象棋棋盘：移植 stringify/ChineseChessOnline（MIT）的 funDrawMap 绘制层。
 * 9 竖线 / 10 横线、中间断开为楚河汉界、九宫斜线、兵炮位 L 标记、木黄底，
 * 线条按官方 lineWidth 2~3 加粗（原来是 CSS grid 1px，太细看不清）。
 *
 * 只负责渲染与坐标换算：棋子状态由服务端 board_state 权威下发，
 * 走子合法性由后端 XiangqiRules 判定。
 */
interface Props {
  cells: Record<string, string | number>;
  /** 回传的永远是服务端权威的棋盘绝对坐标（红在下），与视角无关 */
  onCell: (boardX: number, boardY: number) => void;
  /** 棋盘绝对坐标 */
  selected?: [number, number] | null;
  /** 玩家执黑时把棋盘旋转 180°，让自己的棋子始终位于下方 */
  flipped?: boolean;
  /** 当前行棋方，用于棋盘角落标识 */
  turnSide?: 'r' | 'b' | null;
  /** 最近一手（服务端 board_state.last_move）：落点闪烁 + 起点虚线提示 */
  lastMove?: {
    seq: number;
    x: number;
    y: number;
    from_x?: number | null;
    from_y?: number | null;
  } | null;
  /** 这一手是不是自己走的：自己走短闪，对方走三闪后保持 */
  highlightMine?: boolean;
}

const CELL = 46;
const PAD = 30;
const W = PAD * 2 + CELL * 8;   // 428
const H = PAD * 2 + CELL * 9;   // 474
const LINE = '#3b2a17';

const RED: Record<string, string> = { K: '帅', A: '仕', E: '相', H: '马', R: '车', C: '炮', P: '兵' };
const BLACK: Record<string, string> = { K: '将', A: '士', E: '象', H: '马', R: '车', C: '炮', P: '卒' };

const cx = (x: number) => PAD + x * CELL;
const cy = (y: number) => PAD + y * CELL;

/** 棋盘绝对坐标 <-> 屏幕显示坐标。180° 旋转是自反变换，正反用同一个函数。 */
const flipX = (x: number) => 8 - x;
const flipY = (y: number) => 9 - y;

function drawPost(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const g = CELL * 0.16, k = CELL * 0.07;
  const px = cx(x), py = cy(y);
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = LINE;
  ctx.beginPath();
  if (x !== 8) {
    for (const sign of [-1, 1]) {
      ctx.moveTo(px + k, py + sign * g);
      ctx.lineTo(px + k, py + sign * k);
      ctx.lineTo(px + g, py + sign * k);
    }
  }
  if (x !== 0) {
    for (const sign of [-1, 1]) {
      ctx.moveTo(px - k, py + sign * g);
      ctx.lineTo(px - k, py + sign * k);
      ctx.lineTo(px - g, py + sign * k);
    }
  }
  ctx.stroke();
}

function drawPiece(ctx: CanvasRenderingContext2D, x: number, y: number, piece: string, isSelected: boolean) {
  const px = cx(x), py = cy(y);
  const r = CELL * 0.42;
  const side = String(piece)[0];
  const label = (side === 'r' ? RED : BLACK)[String(piece)[1]] || '?';

  if (isSelected) {
    ctx.beginPath();
    ctx.arc(px, py, r + 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(37, 150, 190, 0.35)';
    ctx.fill();
  }

  // 落子阴影
  ctx.beginPath();
  ctx.arc(px + 2, py + 3, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fill();

  const grad = ctx.createRadialGradient(px - r * 0.35, py - r * 0.4, r * 0.1, px, py, r);
  if (side === 'r') {
    grad.addColorStop(0, '#e8634f'); grad.addColorStop(0.7, '#bd2f22'); grad.addColorStop(1, '#8c1b12');
  } else {
    grad.addColorStop(0, '#6a5c49'); grad.addColorStop(0.7, '#3d3327'); grad.addColorStop(1, '#211b14');
  }
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#d9b45c';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(px, py, r * 0.79, 0, Math.PI * 2);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(255,236,190,0.75)';
  ctx.stroke();

  ctx.fillStyle = '#fff8e6';
  ctx.font = `bold ${Math.round(CELL * 0.52)}px "PingFang SC", "Microsoft YaHei", "STKaiti", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, px, py + 1);
}

export const ChineseChessBoard: React.FC<Props> = ({
  cells, onCell, selected, flipped = false, turnSide, lastMove = null, highlightMine = false,
}) => {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 木黄底 + 外框
    ctx.fillStyle = '#f6d9a6';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#8a6a35';
    ctx.lineWidth = 3;
    ctx.strokeRect(PAD * 0.45, PAD * 0.45, W - PAD * 0.9, H - PAD * 0.9);

    ctx.strokeStyle = LINE;
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'square';

    // 10 条横线
    ctx.beginPath();
    for (let y = 0; y < 10; y++) {
      ctx.moveTo(cx(0), cy(y));
      ctx.lineTo(cx(8), cy(y));
    }
    ctx.stroke();

    // 9 条竖线：两侧贯通，中间 7 条被楚河汉界断开
    ctx.beginPath();
    for (let x = 0; x < 9; x++) {
      if (x === 0 || x === 8) {
        ctx.moveTo(cx(x), cy(0));
        ctx.lineTo(cx(x), cy(9));
      } else {
        ctx.moveTo(cx(x), cy(0));
        ctx.lineTo(cx(x), cy(4));
        ctx.moveTo(cx(x), cy(5));
        ctx.lineTo(cx(x), cy(9));
      }
    }
    ctx.stroke();

    // 九宫斜线
    ctx.beginPath();
    ctx.moveTo(cx(3), cy(0)); ctx.lineTo(cx(5), cy(2));
    ctx.moveTo(cx(5), cy(0)); ctx.lineTo(cx(3), cy(2));
    ctx.moveTo(cx(3), cy(7)); ctx.lineTo(cx(5), cy(9));
    ctx.moveTo(cx(5), cy(7)); ctx.lineTo(cx(3), cy(9));
    ctx.stroke();

    // 兵位 / 炮位 L 标记
    for (let i = 0; i < 9; i++) {
      if (i % 2 === 0) { drawPost(ctx, i, 3); drawPost(ctx, i, 6); }
      else if (i === 1 || i === 7) { drawPost(ctx, i, 2); drawPost(ctx, i, 7); }
    }

    // 楚河汉界
    ctx.fillStyle = LINE;
    ctx.font = `bold ${Math.round(CELL * 0.62)}px "STKaiti", "KaiTi", "PingFang SC", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const riverY = (cy(4) + cy(5)) / 2;
    ctx.fillText('楚 河', cx(flipped ? 6 : 2), riverY);
    ctx.fillText('漢 界', cx(flipped ? 2 : 6), riverY);

    // 棋子
    Object.entries(cells).forEach(([key, piece]) => {
      const [bx, by] = key.split(',').map(Number);
      if (!Number.isInteger(bx) || !Number.isInteger(by) || bx < 0 || bx > 8 || by < 0 || by > 9) return;
      const dx = flipped ? flipX(bx) : bx;
      const dy = flipped ? flipY(by) : by;
      drawPiece(ctx, dx, dy, String(piece), !!selected && selected[0] === bx && selected[1] === by);
    });

    // 角落标识当前行棋方（红/黑），文字始终正立
    if (turnSide) {
      ctx.fillStyle = turnSide === 'r' ? '#bd2f22' : '#3d3327';
      ctx.font = `bold ${Math.round(CELL * 0.36)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${turnSide === 'r' ? '红方' : '黑方'}走棋`, 8, 6);
      ctx.textAlign = 'right';
      ctx.fillText(`你执${flipped ? '黑' : '红'}`, W - 8, 6);
    }
  }, [cells, selected, flipped, turnSide]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = ref.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (W / rect.width);
    const py = (e.clientY - rect.top) * (H / rect.height);
    const x = Math.round((px - PAD) / CELL);
    const y = Math.round((py - PAD) / CELL);
    if (x < 0 || x > 8 || y < 0 || y > 9) return;
    // 只接受落在交叉点附近的点击，避免误触
    if (Math.hypot(px - cx(x), py - cy(y)) > CELL * 0.52) return;
    onCell(flipped ? flipX(x) : x, flipped ? flipY(y) : y);
  };

  /**
   * 高亮层用百分比定位铺在 canvas 上：canvas 是响应式缩放的，
   * 百分比跟着一起缩，不会因为容器宽度变化而错位。
   */
  const overlayStyle = (bx: number, by: number, sizeRatio = 1): React.CSSProperties => {
    const dx = flipped ? flipX(bx) : bx;
    const dy = flipped ? flipY(by) : by;
    return {
      left: `${(cx(dx) / W) * 100}%`,
      top: `${(cy(dy) / H) * 100}%`,
      width: `${((CELL * sizeRatio) / W) * 100}%`,
      height: `${((CELL * sizeRatio) / H) * 100}%`,
      transform: 'translate(-50%, -50%)',
    };
  };

  return (
    <div className="flex justify-center">
      <div className="relative" style={{ width: '100%', maxWidth: W }}>
        <canvas
          ref={ref}
          onClick={handleClick}
          style={{ width: '100%', maxWidth: W, height: 'auto', aspectRatio: `${W} / ${H}` }}
          className="block rounded-xl border-2 border-[#8a6a35] shadow-md cursor-pointer"
          aria-label="中国象棋棋盘"
        />

        {/* 上一步起点：虚线空心圈，能看出“从哪走到哪” */}
        {lastMove && typeof lastMove.from_x === 'number' && typeof lastMove.from_y === 'number' && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute rounded-full border-2 border-dashed border-wb-text-muted/70"
            style={overlayStyle(lastMove.from_x, lastMove.from_y, 0.62)}
          />
        )}

        {/* 最近一手落点：对方走 → 闪 3 次后保持；自己走 → 短闪一次 */}
        {lastMove && (
          <span aria-hidden="true" className="pointer-events-none absolute" style={overlayStyle(lastMove.x, lastMove.y, 0.95)}>
            <span
              key={`${lastMove.seq}-${highlightMine ? 'me' : 'opp'}`}
              className={`block h-full w-full rounded-full border-[3px] ${
                highlightMine ? 'border-wb-brand' : 'border-wb-warn'
              } ${
                highlightMine
                  ? 'animate-[battle-lastmove_.45s_ease-out_1]'
                  : 'animate-[battle-lastmove_.55s_ease-in-out_3]'
              }`}
            />
          </span>
        )}
      </div>
    </div>
  );
};
