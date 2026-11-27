import React from 'react';

/** 群聊 1-20 级默认铭牌，与后端 GROUP_BADGE_NAMES 保持一致 */
export const GROUP_BADGE_NAMES = [
  '刚来蹭网', '潜水观光', '偶尔冒泡', '水群新兵', '稳定出没',
  '话题搭子', '吃瓜选手', '消息机器', '群聊常客', '活跃选手',
  '话题发动机', '楼王预备役', '抬杠大师', '爆料观察员', '气氛支柱',
  '常驻原住民', '群里老面孔', '传说路人', '群内传说', '次元锚点',
];

/** 逐级区分的静态配色：7-19 级渐变，20 级保留原有彩虹色 */
const BADGE_STYLES: { from: string; to: string; glow: string }[] = [
  { from: '#9aa4b2', to: '#6b7280', glow: 'rgba(148,163,184,.30)' },
  { from: '#8fb8c9', to: '#5b8a9e', glow: 'rgba(125,190,210,.35)' },
  { from: '#8fc7a8', to: '#4f9d76', glow: 'rgba(110,200,150,.40)' },
  { from: '#8aa9d6', to: '#4f74b8', glow: 'rgba(110,150,225,.45)' },
  { from: '#a89ad6', to: '#7059b8', glow: 'rgba(160,130,235,.48)' },
  { from: '#7f9ee8', to: '#4c5fc4', glow: 'rgba(105,135,240,.55)' },
  { from: '#167751', to: '#123d38', glow: '#58dfa5' },
  { from: '#127b83', to: '#233b72', glow: '#69e1e7' },
  { from: '#285cca', to: '#282665', glow: '#88b8ff' },
  { from: '#8044b8', to: '#44206a', glow: '#d2a2ff' },
  { from: '#a83578', to: '#591e4b', glow: '#ffa6dc' },
  { from: '#af4731', to: '#601e30', glow: '#ffac8d' },
  { from: '#513017', to: '#a1621e 52%, #513017', glow: '#ffce7b' },
  { from: '#263749', to: '#61788f 52%, #263044', glow: '#d7edff' },
  { from: '#08533d', to: '#16776e 52%, #163446', glow: '#80ffd0' },
  { from: '#571728', to: '#a12c46 48%, #420f37', glow: '#ff95ab' },
  { from: '#192b61', to: '#345bbb 41%, #5147ad 64%, #24204c', glow: '#9cd6ff' },
  { from: '#38234f', to: '#74429b 41%, #884578 64%, #322052', glow: '#f0acff' },
  { from: '#403323', to: '#8c642b 41%, #704e25 62%, #35283c', glow: '#ffe39e' },
  { from: '#ff5f6d', to: '#5b8cff', glow: 'rgba(190,120,255,.95)' },
];

interface Props {
  level: number;
  name?: string | null;
  badgeId?: number | null;
  size?: 'xs' | 'sm';
  showLevel?: boolean;
}

/** QQ 样式群铭牌：7-19 级静态渐变，20 级保留原有彩虹色 */
export const GroupBadge: React.FC<Props> = ({
  level, name, badgeId, size = 'xs', showLevel = true,
}) => {
  const lv = Math.max(1, Math.min(20, Number(level) || 1));
  const id = badgeId && badgeId >= 1 && badgeId <= 20 ? badgeId : lv;
  const label = name || GROUP_BADGE_NAMES[id - 1];
  const c = BADGE_STYLES[id - 1];
  const isMax = id === 20;

  return (
    <span
      className={`wb-group-badge ${size === 'sm' ? 'wb-group-badge-sm' : ''}`}
      data-level={id}
      data-static-gradient={id >= 7 && id < 20 ? '1' : '0'}
      data-badge-finish={id >= 17 && id < 20 ? 'gem' : id >= 13 && id < 17 ? 'metal' : undefined}
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
