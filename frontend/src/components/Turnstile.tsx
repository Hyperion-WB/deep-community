import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, RotateCcw, ShieldCheck } from 'lucide-react';

declare global {
  interface Window {
    turnstile?: any;
  }
}

let scriptPromise: Promise<void> | null = null;

const loadTurnstile = (): Promise<void> => {
  if (typeof window !== 'undefined' && window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('turnstile script load failed'));
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
};

type Status = 'idle' | 'running' | 'ok' | 'error';

interface Props {
  siteKey: string;
  onToken: (token: string) => void;
  className?: string;
}

/**
 * Cloudflare Turnstile 人机校验（自定义外观版）
 *
 * 设计思路：
 * Turnstile 官方 widget 渲染在跨域 iframe 里，颜色、圆角、字体一律不可改，
 * 塞进钛金属极简界面会非常突兀。因此这里改用「静默验证 + 自绘状态条」：
 *
 * 1. widget 以 appearance=interaction-only / execution=execute 隐藏挂载，
 *    页面加载后自动触发 execute()，用户无感完成验证；
 * 2. 界面上只展示一行 11px 的状态文案（校验中 / 已通过 / 需重试），
 *    配色全部走 wb-* 设计 token，与输入框、按钮同族；
 * 3. 万一 Cloudflare 判定需要真人交互，官方 widget 才会在下方出现
 *    （仅此一种情况会露出原生样式，同时叠加去色以免过于刺眼）；
 * 4. token 过期后自动重新执行一次，避免用户提交时才报错。
 */
export const Turnstile: React.FC<Props> = ({ siteKey, onToken, className }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  const [status, setStatus] = useState<Status>('idle');

  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  const runChallenge = useCallback(() => {
    if (!window.turnstile || !widgetRef.current) return;
    setStatus('running');
    try {
      window.turnstile.execute(widgetRef.current);
    } catch {
      setStatus('error');
      onTokenRef.current('');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    loadTurnstile()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        try {
          widgetRef.current = window.turnstile.render(containerRef.current, {
            sitekey: siteKey,
            theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
            language: 'zh-cn',
            appearance: 'interaction-only',
            execution: 'execute',
            callback: (token: string) => {
              setStatus('ok');
              onTokenRef.current(token || '');
            },
            'expired-callback': () => {
              // token 默认 5 分钟过期：静默重跑一次，用户无感
              setStatus('idle');
              onTokenRef.current('');
              runChallenge();
            },
            'error-callback': () => {
              setStatus('error');
              onTokenRef.current('');
            },
          });
          // 挂载后立即静默校验
          setStatus('running');
          window.turnstile.execute(widgetRef.current);
        } catch {
          setStatus('error');
          onTokenRef.current('');
        }
      })
      .catch(() => {
        setStatus('error');
        onTokenRef.current('');
      });

    return () => {
      cancelled = true;
      try {
        if (widgetRef.current && window.turnstile) window.turnstile.remove(widgetRef.current);
      } catch {}
      widgetRef.current = null;
    };
  }, [siteKey, runChallenge]);


  // 看门狗：静默校验若长时间无回调（网络异常等），降级为可重试状态
  useEffect(() => {
    if (status !== 'running') return;
    const timer = setTimeout(() => {
      setStatus((prev) => (prev === 'running' ? 'error' : prev));
      onTokenRef.current('');
    }, 15000);
    return () => clearTimeout(timer);
  }, [status]);

  const label =
    status === 'ok'
      ? '已通过安全校验'
      : status === 'running'
      ? '正在校验'
      : status === 'error'
      ? '校验失败，点击重试'
      : '点击开始校验';

  const icon =
    status === 'ok' ? (
      <Check className="w-3 h-3" strokeWidth={2.5} />
    ) : status === 'running' ? (
      <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2.5} />
    ) : status === 'error' ? (
      <RotateCcw className="w-3 h-3" strokeWidth={2.5} />
    ) : (
      <ShieldCheck className="w-3 h-3" strokeWidth={2} />
    );

  return (
    <div className={`flex flex-col items-center gap-2 ${className ?? ''}`}>
      {/* 自绘状态条：与表单控件同色族，不使用任何高饱和色 */}
      <button
        type="button"
        onClick={status === 'ok' || status === 'running' ? undefined : runChallenge}
        disabled={status === 'ok' || status === 'running'}
        className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-full border text-2xs leading-none tracking-wide transition-colors ${
          status === 'ok'
            ? 'border-wb-border-subtle bg-wb-bg-subtle text-wb-text-secondary'
            : status === 'error'
            ? 'border-wb-danger/30 bg-wb-danger/5 text-wb-danger hover:bg-wb-danger/10'
            : 'border-wb-border-subtle bg-wb-bg-subtle text-wb-text-muted hover:border-wb-border-strong hover:text-wb-text-secondary'
        } ${status === 'ok' || status === 'running' ? 'cursor-default' : 'cursor-pointer'}`}
      >
        {icon}
        <span>{label}</span>
      </button>

      {/* 原生 widget 容器：常态高度为 0，仅在需要真人交互时才出现 */}
      <div
        ref={containerRef}
        className="flex justify-center [&_iframe]:rounded-2xl"
        style={{ filter: 'grayscale(1) contrast(1.05)', opacity: 0.92 }}
      />

      <a
        href="https://www.cloudflare.com/products/turnstile/"
        target="_blank"
        rel="noreferrer noopener"
        className="text-3xs text-wb-text-muted/50 hover:text-wb-text-muted/80 transition-colors"
      >
        Protected by Cloudflare Turnstile
      </a>
    </div>
  );
};
