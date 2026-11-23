import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { Bold, CheckSquare, Code, Heading2, Heading3, Image as ImageIcon, Italic, Link, List, ListOrdered, Quote, Redo2, Strikethrough, Table, Undo2 } from 'lucide-react';
import { EmojiToolbarButton } from './EmojiToolbarButton';

const extensions = [
  StarterKit.configure({ link: { openOnClick: false } }),
  Markdown.configure({ markedOptions: { breaks: true } }),
  Image.configure({ inline: true }),
  TableKit.configure({ table: { renderWrapper: true } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({ placeholder: '从这里开始撰写正文…' }),
];

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

export default function RichTextEditor({ value, onChange, uploadImage }: Props) {
  const externalValue = useRef(value);
  const applyingExternalValue = useRef(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const [linkInput, setLinkInput] = useState<string | null>(null);
  const [linkError, setLinkError] = useState(false);
  const editor = useEditor({
    extensions,
    content: value,
    contentType: 'markdown',
    editorProps: {
      attributes: {
        class: 'wb-rich-content wb-author-prose prose max-w-none break-words focus:outline-none',
        role: 'textbox',
        'aria-label': '富文本正文',
        'aria-multiline': 'true',
      },
    },
    onUpdate: ({ editor: instance }) => {
      if (applyingExternalValue.current) return;
      const markdown = instance.isEmpty ? '' : instance.getMarkdown();
      externalValue.current = markdown;
      onChange(markdown);
    },
  });

  useEffect(() => {
    if (!editor || value === externalValue.current) return;
    externalValue.current = value;
    applyingExternalValue.current = true;
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
    applyingExternalValue.current = false;
  }, [editor, value]);

  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => instance && ({
      bold: instance.isActive('bold'),
      italic: instance.isActive('italic'),
      strike: instance.isActive('strike'),
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
