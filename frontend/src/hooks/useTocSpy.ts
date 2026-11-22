import { useCallback, useEffect, useState } from 'react';
import { normalizeHeadingText, slugifyHeading, type TocHeading } from '../utils/heading';

const HEADING_SELECTOR = '.prose h1[id], .prose h2[id], .prose h3[id], .prose h4[id], .prose h5[id], .prose h6[id]';
const HEADING_SELECTOR_FALLBACK = 'article h1[id], article h2[id], article h3[id], article h4[id], article h5[id], article h6[id]';

/**
 * 目录随动（scrollspy）：返回当前阅读到的小节 id 与跳转函数。
 *
 * 跳转兼容：优先按 id；id 对不上（不同 Markdown 写法导致 slug 差异）时
 * 依次尝试「标题归一化文本匹配」「slug 宽松匹配」「标题文本互相包含」，
 * 保证只写 h4/h5、标题带 emoji/链接/粗体、或只有单个标题时都能跳到正确位置。
 */
export const useTocSpy = (items: TocHeading[], enabled = true) => {
  const [activeId, setActiveId] = useState<string>('');

  const findHeadings = (): HTMLElement[] => {
    let nodes = Array.from(document.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
    if (nodes.length === 0) {
      nodes = Array.from(document.querySelectorAll<HTMLElement>(HEADING_SELECTOR_FALLBACK));
    }
    return nodes;
  };

  useEffect(() => {
    if (!enabled || items.length === 0) return;

    const pick = () => {
      const nodes = findHeadings();
      if (nodes.length === 0) return;
      let current = nodes[0].id;
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= 140) current = node.id;
        else break;
      }
      setActiveId(current);
    };

    window.addEventListener('scroll', pick, { passive: true });
    window.addEventListener('resize', pick);
    pick();
    return () => {
      window.removeEventListener('scroll', pick);
      window.removeEventListener('resize', pick);
    };
  }, [items, enabled]);

  const resolveTarget = useCallback((id: string, text?: string): HTMLElement | null => {
    const byId = document.getElementById(id);
    if (byId) return byId;
    const nodes = findHeadings();
    if (nodes.length === 0) return null;

    if (text) {
      const want = normalizeHeadingText(text);
      const exact = nodes.find((n) => normalizeHeadingText(n.textContent || '') === want);
      if (exact) return exact;
      const included = nodes.find((n) => {
        const got = normalizeHeadingText(n.textContent || '');
        return want && got && (got.includes(want) || want.includes(got));
      });
      if (included) return included;
    }

    // slug 宽松匹配：忽略连字符与大小写差异
    const loose = (s: string) => s.replace(/-/g, '').toLowerCase();
    return nodes.find((n) => loose(n.id) === loose(slugifyHeading(text || id))) || null;
  }, []);

  const scrollTo = useCallback((id: string, text?: string) => {
    const target = resolveTarget(id, text);
    if (!target) return;

    // 只滚动最近的可滚动祖先：scrollIntoView 会同时滚动所有祖先，
    // 移动端会把外层弹层和整页一起带走
    let scroller: HTMLElement | null = document.getElementById('article-scroll');
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 4) {
      scroller = target.parentElement;
      while (scroller && scroller !== document.body) {
        const cs = getComputedStyle(scroller);
        if (/(auto|scroll)/.test(cs.overflowY) && scroller.scrollHeight > scroller.clientHeight + 4) break;
        scroller = scroller.parentElement;
      }
    }
    const OFFSET = 72;
    if (scroller && scroller !== document.body) {
      const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - OFFSET;
      scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } else {
      const top = target.getBoundingClientRect().top + window.scrollY - OFFSET;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
    setActiveId(target.id || id);
  }, [resolveTarget]);

  return { activeId, scrollTo };
};
