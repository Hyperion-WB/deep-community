import React from 'react';

interface State {
  hasError: boolean;
  isChunkError: boolean;
}

/**
 * 全局错误边界：
 * - 捕获渲染期异常，避免整站白屏；
 * - 识别发版后旧 chunk 加载失败（ChunkLoadError / 动态导入失败），提示刷新获取新版本。
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false, isChunkError: false };

  static getDerivedStateFromError(error: any): State {
    const msg = String(error?.message || error || '');
    const isChunkError =
      /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(msg);
    return { hasError: true, isChunkError };
  }

  componentDidCatch(error: any, info: React.ErrorInfo) {
    console.error('[App ErrorBoundary]', error, info?.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center bg-wb-bg-page px-6">
        <div className="max-w-md w-full text-center space-y-4">
          <h1 className="text-lg font-semibold text-wb-text-primary">
            {this.state.isChunkError ? '站点已更新' : '页面出了点问题'}
          </h1>
          <p className="text-xs text-wb-text-secondary leading-relaxed">
            {this.state.isChunkError
              ? '检测到新版本资源，请刷新页面以加载最新内容。'
              : '渲染过程中发生异常，你可以刷新重试；若持续出现，请反馈给我们。'}
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="wb-pressable px-5 py-2 rounded-capsule text-xs font-semibold bg-wb-text-primary text-wb-bg-page hover:opacity-90 transition-opacity"
          >
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}
