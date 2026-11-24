import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  title?: string;
  compact?: boolean;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const { title = '页面渲染遇到异常', compact = false } = this.props;
    const msg = this.state.error?.message || '发生了未预期的界面错误';

    return (
      <div
        className={`flex flex-col items-center justify-center text-center p-6 ${
          compact ? 'flex-1 min-h-[260px]' : 'h-screen bg-white dark:bg-[#0f1115]'
        }`}
      >
        <div className="max-w-md w-full rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/80 p-6 space-y-4 shadow-sm">
          <div className="w-11 h-11 rounded-full bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {title}
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 break-words">
              {msg}
            </p>
          </div>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={this.handleReset}
              className="px-3.5 py-2 rounded-xl text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white inline-flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              重试此视图
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-3.5 py-2 rounded-xl text-xs font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
            >
              刷新整个页面
            </button>
          </div>
        </div>
      </div>
    );
  }
}
