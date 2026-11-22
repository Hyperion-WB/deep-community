/**
 * 标题锚点工具：目录（TOC）与正文渲染必须使用同一套 id 生成规则。
 *
 * 兼容性：支持 h1~h6 全部层级（不再只认 h2/h3），跳过代码块内的 # 行，
 * 处理 ATX 闭合标记、行内链接/图片/粗体；并提供按标题文本回退的归一化函数，
 * 让不同写法的帖子（emoji、全角标点、嵌套元素）也能正确跳转。
 */

export interface TocHeading {
  id: string;
  text: string;
  level: number;
}

export const slugifyHeading = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[`*~_]/g, '')
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** 从 Markdown 标题行提取可见文字：剥链接、图片、行内标记与 ATX 闭合 # */
export const cleanHeadingText = (raw: string): string =>
  raw
    .trim()
    .replace(/\s+#+\s*$/, '')                      // `## 标题 ##`
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')      // 图片 → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')       // 链接 → 文字
    .replace(/<[^>]{1,80}>/g, '')                  // 行内 HTML 标签
    .replace(/[`*~_]/g, '')
    .trim();

/** 从 ReactMarkdown 的 children 递归提取纯文本（兼容嵌套 strong/em/a 等） */
export const headingTextFromChildren = (children: any): string => {
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(headingTextFromChildren).join('');
  if (typeof children === 'object' && 'props' in children) {
    return headingTextFromChildren((children as any).props?.children);
  }
  return '';
};

/** 文本归一化，用于 id 找不到时按标题内容兜底匹配 */
export const normalizeHeadingText = (raw: string): string =>
  cleanHeadingText(raw)
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '')                 // 去标点与符号（含 emoji）
    .toLowerCase();

/** 按文档顺序解析 Markdown 的 h1~h6；重复标题追加 -2、-3 保证 id 唯一 */
export const buildTocFromMarkdown = (contentMd: string): TocHeading[] => {
  if (!contentMd) return [];
  const seen = new Map<string, number>();
  const list: TocHeading[] = [];
  let inFence = false;

  contentMd.split('\n').forEach((line) => {
    // 代码块里的 `# 注释` 不是标题
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;

    const match = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (!match) return;
    const text = cleanHeadingText(match[2]);
    if (!text) return;
    const base = slugifyHeading(text) || 'section';
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    list.push({
      id: count === 1 ? base : `${base}-${count}`,
      text,
      level: match[1].length,
    });
  });

  return list;
};

/** 生成一个与文档顺序一致的唯一 id 分配器（供 react-markdown 标题渲染器使用） */
export const createHeadingIdFactory = () => {
  const seen = new Map<string, number>();
  return (rawText: string): string => {
    const base = slugifyHeading(cleanHeadingText(rawText)) || 'section';
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  };
};
