// Rich typography uses exact class-only span pairs. Markdown within each pair is
// still parsed normally, and only these classes can be emitted by the renderer.
export const typographyOptions = {
  underline: [['straight', '直线下划线'], ['wavy', '波浪下划线']],
  size: [['12', '12 px'], ['14', '14 px'], ['16', '16 px'], ['18', '18 px'], ['20', '20 px'], ['24', '24 px'], ['28', '28 px'], ['32', '32 px']],
  font: [['sans', '无衬线'], ['serif', '衬线'], ['mono', '等宽']],
  color: [['red', '红色'], ['orange', '橙色'], ['green', '绿色'], ['blue', '蓝色'], ['purple', '紫色'], ['gray', '灰色']],
  highlight: [['yellow', '黄色'], ['green', '绿色'], ['blue', '蓝色'], ['purple', '紫色'], ['pink', '粉色']],
  align: [['left', '左对齐'], ['center', '居中'], ['right', '右对齐'], ['justify', '两端对齐']],
} as const;

export type TypographyProperty = keyof typeof typographyOptions;
export const inlineTypography = ['underline', 'size', 'font', 'color', 'highlight'] as const;

export function typographyClass(property: TypographyProperty, value: unknown): string | undefined {
  return typographyOptions[property].some(([option]) => option === value)
    ? `wb-typography-${property}-${value}`
    : undefined;
}

export function typographyStyle(property: TypographyProperty, value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return undefined;
  if (property !== 'color' && property !== 'highlight') return undefined;
  return `${property === 'color' ? 'color' : 'background-color'}: ${value.toLowerCase()}`;
}

export function typographySpan(className: string, content: string): string {
  return `<span class="${className}">${content}</span>`;
}

export function typographyStyleSpan(style: string, content: string): string {
  return `<span style="${style}">${content}</span>`;
}

type TypographyTag = {
  tag: 'span' | 'u' | 'em' | 'strong';
  property: TypographyProperty | 'italic' | 'bold';
  value: string;
  className?: string;
  style?: string;
  opening?: string;
};

const classTags = new Map<string, TypographyTag>();
for (const property of [...inlineTypography, 'align'] as const) {
  for (const [value] of typographyOptions[property]) {
    const className = typographyClass(property, value)!;
    classTags.set(className, { tag: 'span', property, value, className, opening: `<span class="${className}">` });
  }
}

const legacyTags = new Map<string, TypographyTag>([
  ['u', { tag: 'u', property: 'underline', value: 'straight', className: typographyClass('underline', 'straight') }],
  ['strong', { tag: 'strong', property: 'bold', value: '' }],
  ['em', { tag: 'em', property: 'italic', value: '' }],
]);

export function readTypographyOpening(raw: string): TypographyTag | undefined {
  // 任意颜色以安全的内联样式保存：style="color: #rrggbb" / style="background-color: #rrggbb"
  const styled = /^<span style="((?:color|background-color):\s*#[0-9a-fA-F]{6})">/.exec(raw);
  if (styled) {
    const hex = /#([0-9a-fA-F]{6})/.exec(styled[1])![1].toLowerCase();
    const property = styled[1].startsWith('background-color') ? 'highlight' : 'color';
    return {
      tag: 'span', property, value: `#${hex}`,
      style: `${property === 'color' ? 'color' : 'background-color'}: #${hex}`,
      opening: styled[0],
    };
  }
  const span = /^<span class="(wb-typography-[a-z0-9-]+)">/.exec(raw);
  if (span) return classTags.get(span[1]);
  const legacy = /^<(u|strong|em)>/i.exec(raw);
  return legacy ? legacyTags.get(legacy[1].toLowerCase()) : undefined;
}

export function stripRichTypography(markdown: string): string {
  return markdown.replace(/<span (?:class="(wb-typography-[a-z0-9-]+)"|style="(?:color|background-color):\s*#[0-9a-fA-F]{6}")>|<\/(?:span|u|em|strong)>|<(?:u|em|strong)>/gi,
    (tag, className?: string) => className && !classTags.has(className) ? tag : '');
}

export function findTypographyOpening(raw: string): number {
  return raw.search(/<span (?:class="wb-typography-|style="(?:color|background-color):\s*#)|<(?:u|strong|em)>/i);
}

export function findTypographyClosing(raw: string, openingLength: number, tag: TypographyTag['tag']): number {
  // An apparent closing tag in a code span, an escaped tag, or a nested tag
  // belongs to the inner content. Include complete HTML tags so attribute text
  // cannot be mistaken for an opening or closing delimiter.
  const delimiters = /\\[\s\S]|`+|<!--[\s\S]*?-->|<\/?[a-z][\w-]*(?:\s+(?:"[^"]*"|'[^']*'|[^'"<>])*)?\s*\/?>/gi;
  delimiters.lastIndex = openingLength;
  let depth = 1;
  let match = delimiters.exec(raw);
  while (match) {
    const part = match[0];
    if (part.startsWith('`')) {
      const ticks = /`+/g;
      ticks.lastIndex = delimiters.lastIndex;
      let end = ticks.exec(raw);
      while (end && end[0].length !== part.length) end = ticks.exec(raw);
      if (end) delimiters.lastIndex = ticks.lastIndex;
    } else if (part.toLowerCase() === `</${tag}>`) {
      depth -= 1;
      if (depth === 0) return match.index;
    } else if (part.slice(1).split(/[\s/>]/, 1)[0].toLowerCase() === tag && !part.endsWith('/>')) {
      depth += 1;
    }
    match = delimiters.exec(raw);
  }
  return -1;
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName: string; hProperties?: { className?: string[]; style?: string } };
};

type TagFrame = { tag: string; open: MarkdownNode; appearance?: TypographyTag; children: MarkdownNode[] };

function renderTypographyChildren(children: MarkdownNode[]): MarkdownNode[] {
  const output: MarkdownNode[] = [];
  const frames: TagFrame[] = [];
  const append = (...nodes: MarkdownNode[]) => (frames.at(-1)?.children ?? output).push(...nodes);
  for (const child of children) {
    const raw = child.type === 'html' ? child.value ?? '' : '';
    const apparentOpen = /^<(span|u|strong|em)(?:\s[^]*)?>$/i.exec(raw);
    const frame = frames.at(-1);
    if (apparentOpen && !raw.endsWith('/>')) {
      frames.push({ tag: apparentOpen[1].toLowerCase(), open: child, appearance: readTypographyOpening(raw), children: [] });
    } else if (frame && raw.toLowerCase() === `</${frame.tag}>`) {
      frames.pop();
      if (frame.appearance) {
        const { tag, className, style } = frame.appearance;
        const hProperties = {
          ...(className && { className: [className] }),
          ...(style && { style }),
        };
        append({
          type: 'richTypography', children: frame.children,
          data: { hName: tag, ...(Object.keys(hProperties).length > 0 && { hProperties }) },
        });
      } else {
        append(frame.open, ...frame.children, child);
      }
    } else {
      append(child);
    }
  }
  while (frames.length) {
    const frame = frames.pop()!;
    append(frame.open, ...frame.children);
  }
  return output;
}

export function remarkRichTypography() {
  return (tree: MarkdownNode) => {
    function visit(node: MarkdownNode) {
      if (!node.children) return;
      node.children.forEach(visit);
      node.children = renderTypographyChildren(node.children);
    }
    visit(tree);
  };
}
