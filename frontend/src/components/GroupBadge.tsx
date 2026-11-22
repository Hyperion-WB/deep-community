import React from 'react';

/** 群聊 1-20 级默认铭牌，与后端 GROUP_BADGE_NAMES 保持一致 */
export const GROUP_BADGE_NAMES = [
  '刚来蹭网', '潜水观光', '偶尔冒泡', '水群新兵', '稳定出没',
  '话题搭子', '吃瓜选手', '消息机器', '群聊常客', '活跃选手',
  '话题发动机', '楼王预备役', '抬杠大师', '爆料观察员', '气氛支柱',
  '常驻原住民', '群里老面孔', '传说路人', '群内传说', '次元锚点',
];

/** 逐级区分的配色：低等级朴素、高等级发光、20 级动态渐变 */
const BADGE_STYLES: { from: string; to: string; glow: string }[] = [
  { from: '#9aa4b2', to: '#6b7280', glow: 'rgba(148,163,184,.30)' },
  { from: '#8fb8c9', to: '#5b8a9e', glow: 'rgba(125,190,210,.35)' },
  { from: '#8fc7a8', to: '#4f9d76', glow: 'rgba(110,200,150,.40)' },
  { from: '#8aa9d6', to: '#4f74b8', glow: 'rgba(110,150,225,.45)' },
  { from: '#a89ad6', to: '#7059b8', glow: 'rgba(160,130,235,.48)' },
  { from: '#7f9ee8', to: '#4c5fc4', glow: 'rgba(105,135,240,.55)' },
  { from: '#b48ee0', to: '#8247bd', glow: 'rgba(180,120,235,.58)' },
  { from: '#e08bb6', to: '#c04d86', glow: 'rgba(225,120,175,.60)' },
  { from: '#ef9a86', to: '#d95f4b', glow: 'rgba(235,135,110,.62)' },
  { from: '#e8b45f', to: '#c8872c', glow: 'rgba(240,185,90,.65)' },
  { from: '#f0c14b', to: '#d99a1f', glow: 'rgba(250,200,70,.72)' },
  { from: '#f2a33c', to: '#d9701a', glow: 'rgba(250,165,60,.75)' },
  { from: '#f07a5a', to: '#d94a2c', glow: 'rgba(250,120,80,.78)' },
  { from: '#ec5f8a', to: '#c72f66', glow: 'rgba(245,95,145,.80)' },
  { from: '#d65ec9', to: '#a32ba8', glow: 'rgba(220,95,210,.82)' },
  { from: '#9a6ff0', to: '#6c3ad6', glow: 'rgba(160,110,245,.85)' },
  { from: '#5f8ff5', to: '#2f57d6', glow: 'rgba(95,145,250,.88)' },
  { from: '#3fc7d6', to: '#1a8fb8', glow: 'rgba(65,205,220,.90)' },
  { from: '#3fd39a', to: '#12a06e', glow: 'rgba(60,220,160,.92)' },
  { from: '#ff5f6d', to: '#5b8cff', glow: 'rgba(190,120,255,.95)' },
];

interface Props {
  level: number;
  name?: string | null;
  badgeId?: number | null;
  size?: 'xs' | 'sm';
  showLevel?: boolean;
}

/** QQ 样式群铭牌：等级越高越亮、带呼吸发光；20 级彩虹流动渐变 */
export const GroupBadge: React.FC<Props> = ({
  level, name, badgeId, size = 'xs', showLevel = true,
}) => {
  const lv = Math.max(1, Math.min(20, Number(level) || 1));
  const id = badgeId && badgeId >= 1 && badgeId <= 20 ? badgeId : lv;
  const label = name || GROUP_BADGE_NAMES[id - 1];
  const c = BADGE_STYLES[id - 1];
  const isMax = id === 20;
  const glow = id >= 11;

  return (
    <span
      className={`wb-group-badge ${size === 'sm' ? 'wb-group-badge-sm' : ''}`}
      data-level={id}
      data-glow={glow ? '1' : '0'}
      title={`群等级 Lv.${lv} · ${label}${isMax ? '（满级渐变铭牌）' : ''}`}
      style={{
        background: isMax ? undefined : `linear-gradient(135deg, ${c.from}, ${c.to})`,
        // @ts-expect-error CSS 自定义属性
        '--badge-glow': c.glow,
      }}
    >
      {showLevel && <b className="wb-group-badge-lv">{lv}</b>}
      <span className="wb-group-badge-name">{label}</span>
    </span>
  );
};

export const badgeOptionList = GROUP_BADGE_NAMES.map((name, i) => ({
  value: i + 1, label: `Lv.${i + 1} · ${name}`,
}));
