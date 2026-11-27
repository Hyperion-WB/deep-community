import { Extension, Mark, type JSONContent, type KeyboardShortcutCommand, type Node } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { MarkdownManager } from '@tiptap/markdown';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import {
  findTypographyClosing, findTypographyOpening, inlineTypography, readTypographyOpening,
  typographyClass, typographyOptions, typographySpan, typographyStyle, typographyStyleSpan,
} from './richMarkdown';

type InlineProperty = typeof inlineTypography[number];

export const typographyMark = (property: InlineProperty): string => `wbTypography${property[0].toUpperCase()}${property.slice(1)}`;

function typographyValue(element: HTMLElement, property: InlineProperty | 'align') {
  const preset = typographyOptions[property].find(([value]) => {
    const className = typographyClass(property, value);
    return className && element.classList.contains(className);
  })?.[0];
  if (preset) return preset;
  // 任意颜色：从内联样式中读回 #rrggbb
  if (property === 'color' || property === 'highlight') {
    const style = element.getAttribute('style') || '';
    const match = /(?:^|;)\s*(color|background-color)\s*:\s*(#[0-9a-f]{6})/i.exec(style);
    if (match && (property === 'color' ? match[1].toLowerCase() === 'color' : match[1].toLowerCase() === 'background-color')) {
      return match[2].toLowerCase();
    }
  }
  return undefined;
}

const clipboardTags = new Set('article section main div p h1 h2 h3 h4 h5 h6 blockquote ul ol li br hr pre code strong b em i u s del strike span a img table thead tbody tfoot tr th td'.split(' '));
const ignoredClipboardTags = new Set('head title script style template iframe object embed svg math form button select textarea'.split(' '));

function clipboardUrl(raw: string, image: boolean): boolean {
  if (!raw.trim()) return false;
  try {
    const { protocol } = new URL(raw, document.baseURI);
    return protocol === 'https:' || protocol === 'http:' || (!image && (protocol === 'mailto:' || protocol === 'tel:'));
  } catch {
    return false;
  }
}

export function normalizeRichClipboardHtml(html: string): string {
  const source = document.createElement('template');
  const output = document.createElement('template');
  source.innerHTML = html;

  const copy = (parent: ParentNode, destination: ParentNode) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 3) {
        destination.append(node.textContent ?? '');
        continue;
      }
      if (!(node instanceof HTMLElement) || ignoredClipboardTags.has(node.localName)) continue;
      const tag = node.localName;
      if (!clipboardTags.has(tag)) {
        copy(node, destination);
        continue;
      }
      const clean = output.ownerDocument.createElement(tag);
      const urlAttr = tag === 'img' ? 'src' : tag === 'a' ? 'href' : undefined;
      if (urlAttr) {
        const url = node.getAttribute(urlAttr);
        if (url && clipboardUrl(url, tag === 'img')) clean.setAttribute(urlAttr, url.trim());
        else if (tag === 'img') continue;
        for (const key of tag === 'img' ? ['alt', 'title'] : ['title']) {
          const value = node.getAttribute(key);
          if (value !== null) clean.setAttribute(key, value);
        }
      }
      if (tag === 'ol' || tag === 'th' || tag === 'td') {
        for (const key of tag === 'ol' ? ['start'] : ['colspan', 'rowspan']) {
          const value = node.getAttribute(key);
          if (value && /^-?\d{1,6}$/.test(value) && (key === 'start' || Number(value) > 0 && Number(value) <= 1000)) clean.setAttribute(key, value);
        }
      }
      if (tag === 'code') {
        const language = Array.from(node.classList).find((value) => /^language-[\w+-]+$/.test(value));
        if (language) clean.classList.add(language);
      }
      if (tag === 'ul' && node.dataset.type === 'taskList') clean.dataset.type = 'taskList';
      if (tag === 'li' && node.dataset.type === 'taskItem') {
        clean.dataset.type = 'taskItem';
        clean.dataset.checked = String(node.dataset.checked === 'true');
      }
      if (tag === 'p' || /^h[1-6]$/.test(tag)) {
        const alignment = typographyValue(node, 'align') ?? node.style.textAlign ?? node.getAttribute('align');
        const className = typographyClass('align', alignment || node.getAttribute('align'));
        if (className) clean.classList.add(className);
      }
      let content: ParentNode = clean;
      if (tag === 'span') {
        for (const property of inlineTypography) {
          const className = typographyClass(property, typographyValue(node, property));
          if (className) clean.classList.add(className);
        }
        const wrap = (name: string) => {
          const mark = output.ownerDocument.createElement(name);
          content.append(mark);
          content = mark;
        };
        if (/^(bold|bolder|[6-9]00)$/.test(node.style.fontWeight)) wrap('strong');
        if (/^(italic|oblique)$/.test(node.style.fontStyle)) wrap('em');
        const decoration = node.style.textDecorationLine || node.style.textDecoration;
        if (decoration.split(/\s+/).includes('underline')) wrap('u');
        if (decoration.split(/\s+/).includes('line-through')) wrap('s');
      }
      copy(node, content);
      destination.append(clean);
    }
  };
  copy(source.content, output.content);
  return output.innerHTML;
}

const typographyMarks = inlineTypography.map((property) => Mark.create({
  name: typographyMark(property),
  addAttributes() {
    return { value: { default: null, rendered: false } };
  },
  parseHTML() {
    const span = {
      tag: 'span[class]',
      getAttrs: (element: HTMLElement) => {
        const value = typographyValue(element, property);
        return value ? { value } : false;
      },
    };
    return property === 'underline' ? [span, { tag: 'u', attrs: { value: 'straight' } }] : [span];
  },
  renderHTML({ mark }) {
    const style = typographyStyle(property, mark.attrs.value);
    if (style) return ['span', { style }, 0];
    return ['span', { class: typographyClass(property, mark.attrs.value) }, 0];
  },
  renderMarkdown(node, helpers) {
    const children = helpers.renderChildren(node);
    const style = typographyStyle(property, node.attrs?.value);
    if (style) return typographyStyleSpan(style, children);
    const className = typographyClass(property, node.attrs?.value);
    return className ? typographySpan(className, children) : children;
  },
  addKeyboardShortcuts(): Record<string, KeyboardShortcutCommand> {
    if (property !== 'underline') return {};
    const toggleStraight = () => this.editor.commands.toggleMark(this.name, { value: 'straight' });
    return { 'Mod-u': toggleStraight, 'Mod-U': toggleStraight };
  },
}));

const typographyToken = 'wbTypography';
const alignmentWrapper = 'wbAlignmentWrapper';

const RichMarkdownTokenizer = Extension.create({
  name: 'wbTypographyMarkdown',
  markdownTokenName: typographyToken,
  markdownTokenizer: {
    name: typographyToken,
    level: 'inline',
    start: findTypographyOpening,
    tokenize(src, _tokens, lexer) {
      const appearance = readTypographyOpening(src);
      if (!appearance) return;
      const { tag, property, value, className, opening } = appearance;
      const openingLength = opening?.length || (tag === 'span' ? `<span class="${className}">`.length : tag.length + 2);
      const end = findTypographyClosing(src, openingLength, tag);
      if (end === -1) return;
      return {
        type: typographyToken,
        raw: src.slice(0, end + tag.length + 3),
        appearance: { property, value },
        tokens: lexer.inlineTokens(src.slice(openingLength, end)),
      };
    },
  },
  parseMarkdown(token, helpers) {
    const { property, value } = token.appearance as NonNullable<ReturnType<typeof readTypographyOpening>>;
    const content = helpers.parseInline(token.tokens || []);
    if (property === 'align') return helpers.createNode(alignmentWrapper, { value }, content);
    const mark = property === 'italic' || property === 'bold' ? { type: property } : { type: typographyMark(property), attrs: { value } };
    return content.map((node) => {
      const marks = node.marks ?? [];
      if (node.type !== 'text' || marks.some(({ type }) => type === 'code' || type === mark.type)) return node;
      return { ...node, marks: [...marks, mark] };
    });
  },
});

const RichStarterKit = StarterKit.extend({
  addExtensions() {
    return this.parent?.()?.map((extension) => {
      if (extension.name !== 'paragraph' && extension.name !== 'heading') return extension;
      return (extension as Node).extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            typographyAlignment: {
              default: null,
              parseHTML: (element: HTMLElement) => typographyValue(element, 'align') ?? null,
              renderHTML: (attrs: Record<string, unknown>) => ({ class: typographyClass('align', attrs.typographyAlignment) }),
            },
          };
        },
        renderMarkdown(node, helpers, context) {
          const markdown = this.parent?.(node, helpers, context) || '';
          const className = typographyClass('align', node.attrs?.typographyAlignment);
          if (!className) return markdown;
          const content = helpers.renderChildren(node.content ?? []);
          const wrapped = typographySpan(className, content || '&nbsp;');
          return node.type === 'heading' ? `${'#'.repeat(node.attrs?.level ?? 1)} ${wrapped}` : wrapped;
        },
      });
    }) ?? [];
  },
});

export const richEditorExtensions = [
  RichStarterKit.configure({ link: { openOnClick: false }, underline: false }),
  Image.configure({ inline: true }),
  TableKit.configure({ table: { renderWrapper: true } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({ placeholder: '从这里开始撰写正文…' }),
  RichMarkdownTokenizer,
  ...typographyMarks,
];

export const richEditorMarkdown = new MarkdownManager({ extensions: richEditorExtensions, markedOptions: { breaks: true } });

function restoreAlignment(node: JSONContent): JSONContent {
  if (!node.content?.length) return node;
  let source = node.content;
  let attrs = node.attrs;
  // List and task parsers construct their own paragraphs. Restore alignment
  // after those parsers have finished building the complete document tree.
  if ((node.type === 'paragraph' || node.type === 'heading') && source.length === 1 && source[0].type === alignmentWrapper) {
    attrs = { ...attrs, typographyAlignment: source[0].attrs?.value };
    source = source[0].content ?? [];
    if (source.length === 1 && source[0].type === 'text' && (source[0].text === '\u00a0' || source[0].text === '&nbsp;')) source = [];
  }
  const content = source.flatMap(function unwrap(child): JSONContent[] {
    return child.type === alignmentWrapper ? (child.content ?? []).flatMap(unwrap) : [restoreAlignment(child)];
  });
  return { ...node, attrs, content };
}

export function parseRichEditorMarkdown(markdown: string): JSONContent {
  return restoreAlignment(richEditorMarkdown.parse(markdown));
}
