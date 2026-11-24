import React from 'react';
import {
  FolderOpen,
  Heart,
  Image as ImageIcon,
  Inbox,
  Menu,
} from 'lucide-react';
import type { LibraryStats, NavSection } from '../lib/types';

interface MobileNavProps {
  section: NavSection;
  stats: LibraryStats | null;
  onSelectSection: (s: NavSection) => void;
  onOpenMenu: () => void;
}

export const MobileNav: React.FC<MobileNavProps> = ({
  section,
  stats,
  onSelectSection,
  onOpenMenu,
}) => {
  const itemClass = (active: boolean) =>
    `flex flex-col items-center justify-center gap-0.5 flex-1 py-1.5 text-[11px] ${
      active
        ? 'text-blue-600 dark:text-blue-400 font-medium'
        : 'text-zinc-500 dark:text-zinc-400'
    }`;

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-[#14171d]/95 backdrop-blur-md flex items-center pb-[env(safe-area-inset-bottom)]">
      <button
        type="button"
        className={itemClass(section === 'all')}
        onClick={() => onSelectSection('all')}
      >
        <ImageIcon className="w-5 h-5" />
        <span>照片</span>
      </button>

      <button
        type="button"
        className={itemClass(section === 'inbox')}
        onClick={() => onSelectSection('inbox')}
      >
        <div className="relative">
          <Inbox className="w-5 h-5" />
          {stats && stats.inboxCount > 0 && (
            <span className="absolute -top-1 -right-2 px-1 rounded-full bg-amber-500 text-white text-[9px] leading-tight">
              {stats.inboxCount > 99 ? '99+' : stats.inboxCount}
            </span>
          )}
        </div>
        <span>待整理</span>
      </button>

      <button
        type="button"
        className={itemClass(section === 'favorites')}
        onClick={() => onSelectSection('favorites')}
      >
        <Heart className="w-5 h-5" />
        <span>收藏</span>
      </button>

      <button
        type="button"
        className={itemClass(section === 'folderAlbum')}
        onClick={() => onSelectSection('folderAlbum')}
      >
        <FolderOpen className="w-5 h-5" />
        <span>相册目录</span>
      </button>

      <button
        type="button"
        className={itemClass(false)}
        onClick={onOpenMenu}
      >
        <Menu className="w-5 h-5" />
        <span>更多</span>
      </button>
    </nav>
  );
};
