/**
 * 将 ISO 时间字符串或数据库 UTC 时间安全格式化为东八区 (UTC+8) 显示
 * 格式例如: 10-13 15:42
 */
export function formatEast8Time(isoStr: string | undefined | null): string {
  if (!isoStr) return '';
  try {
    let cleanStr = String(isoStr).trim();
    // 如果无时区标识 (Z 或 +XX:XX / -XX:XX)，因后端通常存储 UTC，强制补 Z 避免浏览器按本地时区误判
    if (!cleanStr.endsWith('Z') && !/[+-]\d{2}(:\d{2})?$/.test(cleanStr)) {
      cleanStr = cleanStr.replace(' ', 'T') + 'Z';
    }
    const d = new Date(cleanStr);
    if (isNaN(d.getTime())) return String(isoStr);

    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return formatter.format(d).replace(/\//g, '-');
  } catch {
    return String(isoStr);
  }
}

/**
 * 格式化聊天消息时间为北京时间 (UTC+8)
 * 当天显示: HH:mm (例如 10:35)
 * 跨天显示: MM-DD HH:mm (例如 10-13 18:20)
 * 无论传入无时区 naive ISO 还是 UTC 时间，均严格对齐东八区 (Asia/Shanghai)，杜绝 8 小时时差
 */
export function formatChatTime(isoStr: string | undefined | null): string {
  if (!isoStr) return '';
  try {
    let cleanStr = String(isoStr).trim();
    if (!cleanStr.endsWith('Z') && !/[+-]\d{2}(:\d{2})?$/.test(cleanStr)) {
      cleanStr = cleanStr.replace(' ', 'T') + 'Z';
    }
    const d = new Date(cleanStr);
    if (isNaN(d.getTime())) return '';

    const formatterDate = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const formatterTime = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const now = new Date();
    const isToday = formatterDate.format(d) === formatterDate.format(now);
    if (isToday) {
      return formatterTime.format(d);
    } else {
      const parts = formatterDate.format(d).replace(/\//g, '-').split('-');
      const datePart = parts.length === 3 ? `${parts[1]}-${parts[2]}` : formatterDate.format(d);
      return `${datePart} ${formatterTime.format(d)}`;
    }
  } catch {
    return '';
  }
}


/**
 * 格式化为东八区日期，如: 2026-10-13
 */
export function formatEast8Date(isoStr: string | undefined | null): string {
  if (!isoStr) return '';
  try {
    let cleanStr = String(isoStr).trim();
    if (!cleanStr.endsWith('Z') && !/[+-]\d{2}(:\d{2})?$/.test(cleanStr)) {
      cleanStr = cleanStr.replace(' ', 'T') + 'Z';
    }
    const d = new Date(cleanStr);
    if (isNaN(d.getTime())) return String(isoStr);

    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(d).replace(/\//g, '-');
  } catch {
    return String(isoStr);
  }
}

export function getTodayDateString(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${m}-${d}`;
}

const isUUIDorHash = (str: string | undefined | null): boolean => {
  if (!str) return false;
  const s = str.trim();
  return (
    /^[0-9a-fA-F]{8,}(-[0-9a-fA-F]{4,})+$/i.test(s) ||
    /^[0-9a-fA-F]{24,}$/i.test(s) ||
    /^[0-9a-fA-F]{8,}\s*$/i.test(s)
  );
};

/**
 * 智能从真实正文 Markdown 提取真实标题：
 * 1. 扫描正文中第一个具体的 Markdown 标题（例如 ### 标题 或 #### 1. 核心聚焦：xxx）
 * 2. 扫描加粗核心条目（例如 - **重点技术进展**：xxx）
 * 3. 扫描正文首个有内容的有效自然段
 * 4. 如果是早报类型，组合上日期前缀 【极客早报 · MM-DD】
 */
export function extractTitleFromContent(
  contentMd: string | undefined | null,
  isDaily: boolean = false,
  dateStr?: string
): string {
  if (!contentMd || !contentMd.trim() || isUUIDorHash(contentMd)) {
    return '';
  }

  const lines = contentMd.split('\n');
  let extractedTopic = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('>') || line.startsWith('---') || line.startsWith('```') || isUUIDorHash(line)) {
      continue;
    }

    // 匹配加粗冒号引导，例如 "- **重点技术进展**：xxx" 或 "**聚焦**：xxx"
    const boldMatch = line.match(/^[-*]?\s*\*\*([^*]+)\*\*[:：]\s*(.+)$/);
    if (boldMatch) {
      const val = boldMatch[2].trim().replace(/[*_`#]/g, '');
      if (
        val.length >= 4 &&
        !isUUIDorHash(val) &&
        !val.includes('在此输入') &&
        !val.includes('一句话描述核心') &&
        !val.includes('https://')
      ) {
        extractedTopic = val;
        break;
      }
    }

    // 匹配 Markdown 标题行
    const hMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (hMatch) {
      const headingText = hMatch[1].trim().replace(/^[🌅🚀🔥💡📌\s]+/, '');
      if (isUUIDorHash(headingText)) continue;

      // 如果形如 "1. 核心聚焦：xxx" 或 "今日要闻：xxx"
      const colonMatch = headingText.match(/[:：]\s*(.+)$/);
      if (colonMatch) {
        const afterColon = colonMatch[1].trim();
        if (
          afterColon.length >= 4 &&
          !isUUIDorHash(afterColon) &&
          !afterColon.includes('在此输入') &&
          !afterColon.includes('今日技术头条')
        ) {
          extractedTopic = afterColon;
          break;
        }
      }

      // 如果标题本身是具体的文章标题（排除通用母分类占位词）
      const genericWords = [
        '今日极客要闻',
        '核心架构聚焦',
        '开源前沿与硬核工具推荐',
        '极客思考与今日互动',
        '今日技术头条与架构前沿精选',
      ];
      if (headingText.length >= 4 && !genericWords.some((w) => headingText.includes(w))) {
        extractedTopic = headingText.replace(/^\d+[\.、\s]*/, '');
        break;
      }
    }
  }

  // 如果标题中没找到，尝试从正文首个有效文本段落提取
  if (!extractedTopic) {
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('>') || line.startsWith('-') || line.startsWith('*') || isUUIDorHash(line)) {
        continue;
      }
      const clean = line.replace(/[*_`#\[\]]/g, '').trim();
      if (clean.length >= 4 && !isUUIDorHash(clean) && !clean.includes('每日聚合全球尖端算力')) {
        const firstSentence = clean.split(/[。！？\n]/)[0];
        if (!isUUIDorHash(firstSentence)) {
          extractedTopic = (firstSentence.length >= 4 ? firstSentence : clean).slice(0, 45);
          break;
        }
      }
    }
  }

  if (isDaily && extractedTopic && !isUUIDorHash(extractedTopic)) {
    const dStr = dateStr || getTodayDateString();
    return `【极客早报 · ${dStr}】${extractedTopic}`;
  }

  return (!isUUIDorHash(extractedTopic) && extractedTopic) || '';
}

/**
 * 获取文章真实标题：
 * 1. 优先使用用户填写的真实标题！
 * 2. 只有在标题未填写时，才从真实正文中智能提取！
 * 3. 绝不使用任何虚假 mock 数组或 UUID 乱码！
 */
export function getSmartDailyTitle(
  title: string | undefined | null,
  contentMd?: string | null
): string {
  const cleanTitle = (title || '').trim();
  const validContentMd = contentMd && !isUUIDorHash(contentMd) ? contentMd : null;

  if (cleanTitle) {
    // 如果不是千篇一律的通用占位模板，直接返回用户填写的真实标题
    if (!cleanTitle.includes('今日技术头条与架构前沿精选')) {
      return cleanTitle;
    }
    // 如果是旧的占位模板，并且传入了有效 contentMd，尝试从真实正文中提取
    if (validContentMd) {
      const match = cleanTitle.match(/【(?:极客早报|每日早报)\s*[·•-]?\s*([^】]+)】/);
      const dateStr = match ? match[1].trim() : '';
      const extracted = extractTitleFromContent(validContentMd, true, dateStr);
      if (extracted && !isUUIDorHash(extracted)) return extracted;
    }
    // 无法从正文提取时，将冗余模板标题优雅降级为精美日常聚焦
    const dateMatch = cleanTitle.match(/【(?:极客早报|每日早报)\s*[·•-]?\s*([^】]+)】/);
    if (dateMatch) {
      return `【极客早报 · ${dateMatch[1].trim()}】全球前沿科技精选与深度动态`;
    }
    return '极客早报前沿科技精选';
  }

  // 标题未填写时，从正文中提取真实标题
  if (validContentMd) {
    const extracted = extractTitleFromContent(validContentMd);
    if (extracted && !isUUIDorHash(extracted)) return extracted;
  }

  return '技术前沿探索';
}


/** 完整时间：2026-11-06 21:35:12（东八区，用于"发布于"展示） */
export function formatEast8Full(isoStr?: string | null): string {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((x) => x.type === t)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
  } catch {
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
}
