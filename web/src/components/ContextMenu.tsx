import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type ContextMenuEntry =
  | {
      type: 'item';
      label: string;
      icon?: React.ReactNode;
      danger?: boolean;
      disabled?: boolean;
      shortcut?: string;
      onClick: () => void;
    }
  | {
      type: 'divider';
    }
  | {
      type: 'custom';
      key: string;
      render: () => React.ReactNode;
    };

interface ContextMenuProps {
  x: number;
  y: number;
  header?: string;
  entries: ContextMenuEntry[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  header,
  entries,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
    const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
    setPos({
      left: Math.min(Math.max(8, x), maxLeft),
      top: Math.min(Math.max(8, y), maxTop),
    });
  }, [x, y, entries]);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleScroll = (e: Event) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) {
        return;
      }
      onClose();
    };
    const handleResize = () => onClose();

    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      className="fixed z-50 min-w-52 max-w-68 py-1.5 rounded-xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md border border-zinc-200/90 dark:border-zinc-700/80 shadow-2xl text-xs select-none"
    >
      {header && (
        <div className="px-3 py-1.5 text-[11px] font-medium text-zinc-400 truncate border-b border-zinc-100 dark:border-zinc-800 mb-1">
          {header}
        </div>
      )}

      {entries.map((entry, idx) => {
        if (entry.type === 'divider') {
          return (
            <div
              key={`div-${idx}`}
              className="my-1 border-t border-zinc-100 dark:border-zinc-800"
            />
          );
        }
        if (entry.type === 'custom') {
          return <div key={entry.key}>{entry.render()}</div>;
        }
        return (
          <button
            key={`${entry.label}-${idx}`}
            type="button"
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onClick();
            }}
            className={`w-full px-3 py-2 flex items-center justify-between gap-3 text-left transition-colors disabled:opacity-40 ${
              entry.danger
                ? 'text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/50'
                : 'text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800'
            }`}
          >
            <span className="flex items-center gap-2 min-w-0">
              {entry.icon && <span className="shrink-0">{entry.icon}</span>}
              <span className="truncate">{entry.label}</span>
            </span>
            {entry.shortcut && (
              <span className="text-[10px] text-zinc-400 shrink-0">
                {entry.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
