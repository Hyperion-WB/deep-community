import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, CheckSquare, Code, Heading2, Heading3,
  Image as ImageIcon, Italic, Link, List, ListOrdered, Palette, Quote, Redo2, Strikethrough, Table, Underline, Undo2, Waves,
} from 'lucide-react';
import { CustomDropdown } from './CustomDropdown';
import { EmojiToolbarButton } from './EmojiToolbarButton';
import { normalizeRichClipboardHtml, parseRichEditorMarkdown, richEditorExtensions, richEditorMarkdown, typographyMark } from '../utils/richEditorMarkdown';
import { typographyOptions } from '../utils/richMarkdown';

const typographyControls = [
  ['size', '字号'], ['font', '字体'], ['color', '文字颜色'], ['highlight', '背景色'],
] as const;
const alignmentIcons = { left: AlignLeft, center: AlignCenter, right: AlignRight, justify: AlignJustify };

interface Props {
  value: string;
  onChange: (markdown: string) => void;
  uploadImage: (file: File) => Promise<string | undefined>;
}

function Tool({ label, icon, action, active, disabled }: {
  label: string;
  icon: ReactNode;
  action: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled}
      onMouseDown={(event) => event.preventDefault()} onClick={action} className="wb-author-tool">
      {icon}
    </button>
  );
}

const COLOR_PRESETS = [
  '#000000', '#374151', '#6b7280', '#9ca3af', '#d1d5db', '#ffffff',
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#fb7185',
  '#7f1d1d', '#9a3412', '#854d0e', '#3f6212', '#14532d', '#134e4a',
  '#164e63', '#1e3a8a', '#312e81', '#4c1d95', '#701a75', '#831843',
  '#fecaca', '#fed7aa', '#fef08a', '#bbf7d0', '#bae6fd', '#ddd6fe',
];
const PRESET_HEX: Record<string, string> = {
  red: '#ef4444', orange: '#f97316', green: '#22c55e', blue: '#3b82f6',
  purple: '#8b5cf6', gray: '#6b7280', yellow: '#eab308', pink: '#ec4899',
};

function ColorPicker({ label, value, onSelect, onClear }: {
  label: string;
  value: string;
  onSelect: (value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const current = value && value.startsWith('#') ? value : PRESET_HEX[value] || '';
  return (
    <div ref={wrapRef} className="relative inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      <span>{label}</span>
      <button type="button" aria-label={`${label}：${value || '默认'}`} aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-wb-border-subtle bg-wb-bg-surface px-2 text-[11px] hover:border-wb-border-strong">
        <span className="h-3.5 w-3.5 rounded-full border border-black/10"
          style={{ background: current || 'transparent' }} />
        <Palette className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-[70] mt-1 w-60 rounded-xl border border-wb-border-strong bg-wb-bg-surface p-2.5 shadow-2xl">
          <div className="mb-2 grid grid-cols-8 gap-1" role="group" aria-label={`${label}色盘`}>
            {COLOR_PRESETS.map((color) => (
              <button key={color} type="button" title={color}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { onSelect(color); setOpen(false); }}
                aria-label={`选择颜色 ${color}`}
                className={`h-5 w-5 rounded-full border transition-transform hover:scale-110 ${
                  current.toLowerCase() === color ? 'border-wb-text-primary ring-2 ring-wb-text-primary/20' : 'border-black/10'
                }`}
                style={{ background: color }} />
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-wb-border-subtle pt-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-wb-text-secondary">
              <input type="color" value={current || '#000000'}
                onChange={(event) => onSelect(event.target.value)}
                className="h-6 w-7 cursor-pointer rounded border-0 bg-transparent p-0" />
              自定义任意颜色
            </label>
            <button type="button" onMouseDown={(event) => event.preventDefault()}
              onClick={() => { onClear(); setOpen(false); }}
              className="rounded-md px-2 py-1 text-[11px] text-wb-text-muted hover:bg-wb-bg-subtle hover:text-wb-text-primary">
              恢复默认
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function RichTextEditor({ value, onChange, uploadImage }: Props) {
  const externalValue = useRef(value);
  const applyingExternalValue = useRef(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const [linkInput, setLinkInput] = useState<string | null>(null);
  const [linkError, setLinkError] = useState(false);
  const [initialContent] = useState(() => value ? parseRichEditorMarkdown(value) : '');
  const editor = useEditor({
    extensions: richEditorExtensions,
    content: initialContent,
    editorProps: {
      transformPastedHTML: normalizeRichClipboardHtml,
      attributes: {
        class: 'wb-rich-content wb-article-prose wb-rich-typography prose max-w-none break-words focus:outline-none',
        role: 'textbox',
        'aria-label': '富文本正文',
        'aria-multiline': 'true',
      },
    },
    onUpdate: ({ editor: instance }) => {
      if (applyingExternalValue.current) return;
      const markdown = instance.isEmpty ? '' : richEditorMarkdown.serialize(instance.getJSON());
      externalValue.current = markdown;
      onChange(markdown);
    },
  });

  useEffect(() => {
    if (!editor || value === externalValue.current) return;
    externalValue.current = value;
    applyingExternalValue.current = true;
    editor.commands.setContent(value ? parseRichEditorMarkdown(value) : '', { emitUpdate: false });
    applyingExternalValue.current = false;
  }, [editor, value]);

  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => instance && ({
      bold: instance.isActive('bold'),
      italic: instance.isActive('italic'),
      underline: instance.isActive(typographyMark('underline'), { value: 'straight' }),
      wavy: instance.isActive(typographyMark('underline'), { value: 'wavy' }),
      strike: instance.isActive('strike'),
      typography: Object.fromEntries(typographyControls.map(([property]) => [property, instance.getAttributes(typographyMark(property)).value ?? ''])),
      canAlign: instance.can().updateAttributes('paragraph', {}) || instance.can().updateAttributes('heading', {}),
      alignment: instance.getAttributes('paragraph').typographyAlignment ?? instance.getAttributes('heading').typographyAlignment ?? 'left',
      heading2: instance.isActive('heading', { level: 2 }),
      heading3: instance.isActive('heading', { level: 3 }),
      bulletList: instance.isActive('bulletList'),
      orderedList: instance.isActive('orderedList'),
      taskList: instance.isActive('taskList'),
      blockquote: instance.isActive('blockquote'),
      codeBlock: instance.isActive('codeBlock'),
      link: instance.isActive('link'),
      table: instance.isActive('table'),
      undo: instance.can().undo(),
      redo: instance.can().redo(),
    }),
  });

  if (!editor || !state) return null;
  const insertImage = async (file: File) => {
    const src = await uploadImage(file);
    if (src && !editor.isDestroyed) editor.chain().focus().setImage({ src, alt: '图片' }).run();
  };
  const applyLink = () => {
    const href = linkInput?.trim() || '';
    if (href && !/^(https?:\/\/|mailto:|tel:)/i.test(href)) {
      setLinkError(true);
      return;
    }
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!href) chain.unsetLink().run();
    else if (editor.state.selection.empty && !state.link) {
      chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else chain.setLink({ href }).run();
    setLinkInput(null);
  };

  return (
    <>
      <div className="wb-author-toolbar" role="group" aria-label="富文本工具">
        <Tool label="撤销" icon={<Undo2 />} action={() => editor.chain().focus().undo().run()} disabled={!state.undo} />
        <Tool label="重做" icon={<Redo2 />} action={() => editor.chain().focus().redo().run()} disabled={!state.redo} />
        <span className="wb-author-tool-divider" />
        <Tool label="二级标题" icon={<Heading2 />} active={state.heading2} action={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
        <Tool label="三级标题" icon={<Heading3 />} active={state.heading3} action={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} />
        <Tool label="粗体" icon={<Bold />} active={state.bold} action={() => editor.chain().focus().toggleBold().run()} />
        <Tool label="斜体" icon={<Italic />} active={state.italic} action={() => editor.chain().focus().toggleItalic().run()} />
        <Tool label="直线下划线" icon={<Underline />} active={state.underline} action={() => editor.chain().focus().toggleMark(typographyMark('underline'), { value: 'straight' }).run()} />
        <Tool label="波浪下划线" icon={<Waves />} active={state.wavy} action={() => editor.chain().focus().toggleMark(typographyMark('underline'), { value: 'wavy' }).run()} />
        <Tool label="删除线" icon={<Strikethrough />} active={state.strike} action={() => editor.chain().focus().toggleStrike().run()} />
        <span className="wb-author-tool-divider" />
        <Tool label="无序列表" icon={<List />} active={state.bulletList} action={() => editor.chain().focus().toggleBulletList().run()} />
        <Tool label="有序列表" icon={<ListOrdered />} active={state.orderedList} action={() => editor.chain().focus().toggleOrderedList().run()} />
        <Tool label="任务清单" icon={<CheckSquare />} active={state.taskList} action={() => editor.chain().focus().toggleTaskList().run()} />
        <Tool label="引用" icon={<Quote />} active={state.blockquote} action={() => editor.chain().focus().toggleBlockquote().run()} />
        <Tool label="代码块" icon={<Code />} active={state.codeBlock} action={() => editor.chain().focus().toggleCodeBlock().run()} />
        <span className="wb-author-tool-divider" />
        <Tool label="链接" icon={<Link />} active={state.link || linkInput !== null} action={() => {
          setLinkError(false);
          setLinkInput(linkInput === null ? editor.getAttributes('link').href || '' : null);
        }} />
        <Tool label="插入图片" icon={<ImageIcon />} action={() => imageInput.current?.click()} />
        <input ref={imageInput} type="file" accept="image/*" hidden onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void insertImage(file);
        }} />
        <Tool label="插入表格" icon={<Table />} disabled={state.table} action={() => editor.chain().focus().insertTable({ rows: 3, cols: 3 }).run()} />
        <EmojiToolbarButton onInsert={(text) => editor.chain().focus().insertContent({ type: 'text', text }).run()} />
        {state.table && (
          <div className="flex flex-wrap gap-1 text-xs" role="group" aria-label="表格操作">
            <Tool label="在下方添加行" icon="加行" action={() => editor.chain().focus().addRowAfter().run()} />
            <Tool label="在右侧添加列" icon="加列" action={() => editor.chain().focus().addColumnAfter().run()} />
            <Tool label="删除当前行" icon="删行" action={() => editor.chain().focus().deleteRow().run()} />
            <Tool label="删除当前列" icon="删列" action={() => editor.chain().focus().deleteColumn().run()} />
            <Tool label="删除表格" icon="删表" action={() => editor.chain().focus().deleteTable().run()} />
          </div>
        )}
      </div>
      <div className="wb-author-toolbar wb-typography-toolbar" role="group" aria-label="文字和段落排版">
        {typographyControls.map(([property, label]) => (
          <div key={property} className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
            {property === 'color' || property === 'highlight' ? (
              <ColorPicker
                label={label}
                value={state.typography[property]}
                onSelect={(value) => editor.chain().focus().setMark(typographyMark(property), { value }).run()}
                onClear={() => editor.chain().focus().unsetMark(typographyMark(property)).run()}
              />
            ) : (
              <>
                <span>{label}</span>
                <CustomDropdown
                  ariaLabel={label}
                  size="xs"
                  value={state.typography[property]}
                  options={[{ value: '', label: '默认' }, ...typographyOptions[property].map(([value, label]) => ({ value, label }))]}
                  preserveMouseFocus
                  onChange={(value: string) => {
                    const chain = editor.chain().focus();
                    const mark = typographyMark(property);
                    if (value) chain.setMark(mark, { value }).run();
                    else chain.unsetMark(mark).run();
                  }}
                />
              </>
            )}
          </div>
        ))}
        <span className="wb-author-tool-divider" />
        <div className="flex items-center gap-1" role="group" aria-label="段落对齐">
          {typographyOptions.align.map(([value, label]) => {
            const Icon = alignmentIcons[value];
            return <Tool key={value} label={label} icon={<Icon />} disabled={!state.canAlign} active={state.alignment === value} action={() => {
              editor.chain().focus().command(({ commands, tr }) => {
                const pendingMarks = tr.storedMarks;
                const attrs = { typographyAlignment: value };
                const paragraph = commands.updateAttributes('paragraph', attrs);
                const heading = commands.updateAttributes('heading', attrs);
                if (pendingMarks && tr.selection.empty) tr.setStoredMarks(pendingMarks);
                return paragraph || heading;
              }).run();
            }} />;
          })}
        </div>
      </div>
      {linkInput !== null && (
        <div className="wb-author-toolbar" role="group" aria-label="编辑链接">
          <input autoFocus type="text" inputMode="url" aria-label="链接地址" aria-invalid={linkError}
            placeholder="https://example.com" value={linkInput} className="min-w-0 flex-1 rounded-lg border border-wb-border-subtle bg-wb-bg-surface px-3 py-1.5 text-sm"
            onChange={(event) => { setLinkInput(event.target.value); setLinkError(false); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); applyLink(); }
              if (event.key === 'Escape') { setLinkInput(null); editor.commands.focus(); }
            }} />
          <Tool label="应用链接" icon="应用" action={applyLink} />
          <Tool label="取消编辑链接" icon="取消" action={() => { setLinkInput(null); editor.commands.focus(); }} />
          {linkError && <span className="w-full text-xs text-wb-danger" role="alert">请输入以 https://、http://、mailto: 或 tel: 开头的地址。</span>}
        </div>
      )}
      <EditorContent editor={editor} onPasteCapture={(event) => {
        const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith('image/'));
        if (file) { event.preventDefault(); void insertImage(file); }
      }} onDropCapture={(event) => {
        const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/'));
        if (file) { event.preventDefault(); void insertImage(file); }
      }} />
    </>
  );
}
