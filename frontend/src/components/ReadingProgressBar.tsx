import React, { useEffect, useState } from 'react';

type Props = {
  /** 指定滚动容器（文章页正文是内部滚动，不是整页滚动） */
  targetRef?: React.RefObject<HTMLElement | null>;
};

export const ReadingProgressBar: React.FC<Props> = ({ targetRef }) => {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const compute = () => {
      const el = targetRef?.current;
      // 容器本身可滚动时以容器为准，否则退回整页滚动
      if (el && el.scrollHeight > el.clientHeight + 4) {
        const total = el.scrollHeight - el.clientHeight;
        setProgress(Math.min(100, Math.max(0, (el.scrollTop / total) * 100)));
        return;
      }
      const total = document.documentElement.scrollHeight - window.innerHeight;
      if (total <= 0) {
        setProgress(0);
        return;
      }
      setProgress(Math.min(100, Math.max(0, (window.scrollY / total) * 100)));
    };

    const el = targetRef?.current;
    compute();
    window.addEventListener('scroll', compute, { passive: true });
    window.addEventListener('resize', compute);
    el?.addEventListener('scroll', compute, { passive: true });
    return () => {
      window.removeEventListener('scroll', compute);
      window.removeEventListener('resize', compute);
      el?.removeEventListener('scroll', compute);
    };
  }, [targetRef]);

  if (progress <= 0) return null;

  return (
    <div className="fixed top-0 inset-x-0 z-[100] h-1 bg-transparent pointer-events-none">
      <div
        className="h-full bg-wb-text-primary transition-all duration-75 ease-out shadow-[0_0_8px_rgba(0,0,0,0.2)]"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
};
