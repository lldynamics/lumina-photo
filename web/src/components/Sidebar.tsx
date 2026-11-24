import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Album,
  Camera,
  ChevronDown,
  ChevronRight,
  Clock,
  CopyCheck,
  Cpu,
  Download,
  EyeOff,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Heart,
  Image as ImageIcon,
  Inbox,
  Lock,
  LogOut,
  MapPin,
  Moon,
  Pencil,
  PieChart,
  Plus,
  QrCode,
  Settings,
  Share2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Star,
  Sun,
  Tag,
  Trash2,
  Unlock,
  Upload,
  Users,
  X,
} from 'lucide-react';
import type {
  ActiveFolderSelection,
  AiStatusResponse,
  AlbumNode,
  AuthStatusResponse,
  FolderAlbumNode,
  LibraryFolderTree,
  LibraryStats,
  NavSection,
  ScanProgressEvent,
  SmartAlbum,
  TagItem,
} from '../lib/types';

function renderSmartIcon(icon: string) {
  switch (icon) {
    case 'star':
      return <Star className="w-3.5 h-3.5 text-amber-500 shrink-0" />;
    case 'heart':
      return <Heart className="w-3.5 h-3.5 text-rose-500 shrink-0" />;
    case 'film':
      return <Film className="w-3.5 h-3.5 text-indigo-500 shrink-0" />;
    case 'camera':
      return <Camera className="w-3.5 h-3.5 text-blue-500 shrink-0" />;
    case 'smartphone':
      return <Smartphone className="w-3.5 h-3.5 text-purple-500 shrink-0" />;
    case 'map-pin':
      return <MapPin className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
    case 'clock':
      return <Clock className="w-3.5 h-3.5 text-sky-500 shrink-0" />;
    default:
      return <Sparkles className="w-3.5 h-3.5 text-indigo-500 shrink-0" />;
  }
}

interface SidebarProps {
  openMobile: boolean;
  onCloseMobile: () => void;
  section: NavSection;
  activeFolder: ActiveFolderSelection | null;
  activeAlbumId: number | null;
  activeSmartAlbumId: number | null;
  activeTagPath: string | null;
  stats: LibraryStats | null;
  folderTrees: LibraryFolderTree[];
  albums: AlbumNode[];
  smartAlbums: SmartAlbum[];
  tags: TagItem[];
  scan: ScanProgressEvent;
  aiStatus?: AiStatusResponse | null;
  authStatus: AuthStatusResponse | null;
  darkMode: boolean;
  onToggleDark: () => void;
  onSelectSection: (section: NavSection) => void;
  onSelectSmartAlbum: (id: number) => void;
  onCreateSmartAlbum: () => void;
  onEditSmartAlbum: (sa: SmartAlbum) => void;
  onDeleteSmartAlbum: (id: number) => Promise<void>;
  onSelectFolderAlbum: (libraryId: number, folderPath: string) => void;
  onCreateFolderAlbum: (
    libraryId: number,
    parentPath: string,
    name: string,
  ) => Promise<string | null>;
  onRenameFolderAlbum: (
    libraryId: number,
    folderPath: string,
    newName: string,
  ) => Promise<void>;
  onMoveFolderAlbum: (
    srcLibraryId: number,
    srcFolderPath: string,
    targetLibraryId: number,
    targetParentPath: string,
  ) => Promise<void>;
  onDeleteFolderAlbum: (libraryId: number, folderPath: string) => Promise<void>;
  onMoveMediaToFolder: (
    mediaIds: number[],
    targetLibraryId: number,
    targetFolderPath: string,
  ) => Promise<void>;
  onShareFolderAlbum: (
    libraryId: number,
    folderPath: string,
    title: string,
  ) => void;
  onExportFolderAlbum: (
    libraryId: number,
    folderPath: string,
    title: string,
  ) => void;
  onContextMenuFolder?: (
    e: React.MouseEvent,
    target: {
      libraryId: number;
      folderPath: string;
      name: string;
      isRoot: boolean;
    },
  ) => void;
  externalCreateTarget?: {
    libraryId: number;
    parentPath: string;
    nonce: number;
  } | null;
  externalRenameTarget?: {
    libraryId: number;
    folderPath: string;
    currentName: string;
    nonce: number;
  } | null;
  onSelectAlbum: (albumId: number) => void;
  onCreateAlbum: (name: string, parentId?: number | null) => Promise<void>;
  onRenameAlbum: (albumId: number, name: string) => Promise<void>;
  onDeleteAlbum: (albumId: number) => Promise<void>;
  onAddMediaToAlbum: (albumId: number, mediaIds: number[]) => Promise<void>;
  onShareAlbum: (albumId: number, title: string) => void;
  onSelectTag: (tagPath: string) => void;
  onCreateTag: (path: string) => Promise<void>;
  onRenameTag: (tagId: number, newPath: string) => Promise<void>;
  onDeleteTag: (tagId: number) => Promise<void>;
  onOpenImport: () => void;
  onOpenExport: () => void;
  onOpenSettings: (tab?: 'ai' | 'libraries' | 'privacy' | 'security' | 'lan' | 'backup' | 'appearance') => void;
  onOpenFolderPrivacy?: (libraryId: number, folderPath: string) => void;
  onLogout?: () => void;
}

interface TagTreeNode {
  segment: string;
  fullPath: string;
  tag?: TagItem;
  children: TagTreeNode[];
}

function buildTagTree(tags: TagItem[]): TagTreeNode[] {
  const roots: TagTreeNode[] = [];
  const map = new Map<string, TagTreeNode>();

  for (const tag of tags) {
    const parts = tag.path.split('/').filter(Boolean);
    let currentPath = '';
    let parentList = roots;

    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      currentPath = currentPath ? `${currentPath}/${seg}` : seg;
      let node = map.get(currentPath);
      if (!node) {
        node = {
          segment: seg,
          fullPath: currentPath,
          children: [],
        };
        map.set(currentPath, node);
        parentList.push(node);
      }
      if (i === parts.length - 1) {
        node.tag = tag;
      }
      parentList = node.children;
    }
  }
  return roots;
}

export const Sidebar: React.FC<SidebarProps> = ({
  openMobile,
  onCloseMobile,
  section,
  activeFolder,
  activeAlbumId,
  activeSmartAlbumId,
  activeTagPath,
  stats,
  folderTrees,
  albums,
  smartAlbums,
  tags,
  scan,
  aiStatus,
  authStatus,
  darkMode,
  onToggleDark,
  onSelectSection,
  onSelectSmartAlbum,
  onCreateSmartAlbum,
  onEditSmartAlbum,
  onDeleteSmartAlbum,
  onSelectFolderAlbum,
  onCreateFolderAlbum,
  onRenameFolderAlbum,
  onMoveFolderAlbum,
  onDeleteFolderAlbum,
  onMoveMediaToFolder,
  onShareFolderAlbum,
  onExportFolderAlbum,
  onContextMenuFolder,
  externalCreateTarget,
  externalRenameTarget,
  onSelectAlbum,
  onCreateAlbum,
  onRenameAlbum,
  onDeleteAlbum,
  onAddMediaToAlbum,
  onShareAlbum,
  onSelectTag,
  onCreateTag,
  onRenameTag,
  onDeleteTag,
  onOpenImport,
  onOpenExport,
  onOpenSettings,
  onOpenFolderPrivacy,
  onLogout,
}) => {
  const userRole = authStatus?.currentUser?.role ?? 'admin';
  const isScoped = authStatus?.currentUser?.allowedLibraryIds != null;
  const canEdit = userRole !== 'viewer';
  const isAdmin = userRole === 'admin' && !isScoped;
  const canShareAlbum = canEdit && !isScoped;
  const [toolsExpanded, setToolsExpanded] = useState(() => ['map', 'people', 'duplicates', 'storage'].includes(section));
  useEffect(() => {
    if (['map', 'people', 'duplicates', 'storage'].includes(section)) setToolsExpanded(true);
  }, [section]);
  const [smartAlbumsExpanded, setSmartAlbumsExpanded] = useState(() => {
    if (section === 'smartAlbum') return true;
    try {
      const saved = localStorage.getItem('lumina_sidebar_smart_expanded');
      if (saved !== null) return saved === '1';
    } catch {
      // ignore storage errors
    }
    return false;
  });
  useEffect(() => {
    if (section === 'smartAlbum') setSmartAlbumsExpanded(true);
  }, [section]);
  const toggleSmartAlbums = () => {
    setSmartAlbumsExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('lumina_sidebar_smart_expanded', next ? '1' : '0');
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [expandedAlbums, setExpandedAlbums] = useState<Set<number>>(new Set());
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());

  const [creatingTarget, setCreatingTarget] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');

  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  // Virtual album inline states
  const [creatingAlbumParent, setCreatingAlbumParent] = useState<
    number | 'root' | null
  >(null);
  const [newAlbumName, setNewAlbumName] = useState('');
  const [renamingAlbumId, setRenamingAlbumId] = useState<number | null>(null);
  const [albumRenameDraft, setAlbumRenameDraft] = useState('');

  // Tag inline states
  const [newTagName, setNewTagName] = useState('');
  const [creatingTag, setCreatingTag] = useState(false);
  const [renamingTagId, setRenamingTagId] = useState<number | null>(null);
  const [tagRenameDraft, setTagRenameDraft] = useState('');

  useEffect(() => {
    if (!externalCreateTarget) return;
    const { libraryId, parentPath } = externalCreateTarget;
    setCreatingTarget(`${libraryId}::${parentPath}`);
    setNewFolderName('');
    setRenamingKey(null);
    if (parentPath) {
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        const parts = parentPath.split('/');
        for (let i = 1; i <= parts.length; i++) {
          next.add(`${libraryId}::${parts.slice(0, i).join('/')}`);
        }
        return next;
      });
    }
  }, [externalCreateTarget]);

  useEffect(() => {
    if (!externalRenameTarget) return;
    const { libraryId, folderPath, currentName } = externalRenameTarget;
    setRenamingKey(`${libraryId}::${folderPath}`);
    setRenameDraft(currentName);
    setCreatingTarget(null);
  }, [externalRenameTarget]);

  const tagTree = useMemo(() => buildTagTree(tags), [tags]);

  const toggleFolderExpand = (key: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAlbumExpand = (id: number) => {
    setExpandedAlbums((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTagExpand = (fullPath: string) => {
    setExpandedTags((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  };

  const isAcceptingFolderDrop = (e: React.DragEvent) =>
    canEdit &&
    (e.dataTransfer.types.includes('application/x-lumina-media-ids') ||
      e.dataTransfer.types.includes('application/x-lumina-folder'));

  const handleDropOnFolder = async (
    e: React.DragEvent,
    libraryId: number,
    folderPath: string,
  ) => {
    e.preventDefault();
    setDragOverKey(null);

    const folderPayload = e.dataTransfer.getData('application/x-lumina-folder');
    if (folderPayload) {
      try {
        const src = JSON.parse(folderPayload) as {
          libraryId: number;
          folderPath: string;
        };
        if (
          src.libraryId &&
          src.folderPath &&
          !(src.libraryId === libraryId && src.folderPath === folderPath)
        ) {
          await onMoveFolderAlbum(
            src.libraryId,
            src.folderPath,
            libraryId,
            folderPath,
          );
          setExpandedFolders((prev) =>
            new Set(prev).add(`${libraryId}::${folderPath}`),
          );
        }
      } catch {
        // ignore
      }
      return;
    }

    const raw = e.dataTransfer.getData('application/x-lumina-media-ids');
    if (!raw) return;
    try {
      const ids = JSON.parse(raw) as number[];
      if (Array.isArray(ids) && ids.length > 0) {
        await onMoveMediaToFolder(ids, libraryId, folderPath);
      }
    } catch {
      // ignore
    }
  };

  const handleDropOnVirtualAlbum = async (
    e: React.DragEvent,
    albumId: number,
  ) => {
    e.preventDefault();
    setDragOverKey(null);
    const raw = e.dataTransfer.getData('application/x-lumina-media-ids');
    if (!raw) return;
    try {
      const ids = JSON.parse(raw) as number[];
      if (Array.isArray(ids) && ids.length > 0) {
        await onAddMediaToAlbum(albumId, ids);
      }
    } catch {
      // ignore
    }
  };

  const submitCreateFolder = async (
    e: React.FormEvent,
    libraryId: number,
    parentPath: string,
  ) => {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    const createdPath = await onCreateFolderAlbum(libraryId, parentPath, name);
    if (createdPath) {
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        next.add(`${libraryId}::${parentPath}`);
        const parts = createdPath.split('/');
        for (let i = 1; i < parts.length; i++) {
          next.add(`${libraryId}::${parts.slice(0, i).join('/')}`);
        }
        return next;
      });
    }
    setNewFolderName('');
    setCreatingTarget(null);
  };

  const submitRenameFolder = async (
    e: React.FormEvent,
    libraryId: number,
    folderPath: string,
  ) => {
    e.preventDefault();
    const name = renameDraft.trim();
    if (!name) return;
    await onRenameFolderAlbum(libraryId, folderPath, name);
    setRenamingKey(null);
  };

  const submitCreateAlbum = async (
    e: React.FormEvent,
    parentId: number | null,
  ) => {
    e.preventDefault();
    const name = newAlbumName.trim();
    if (!name) return;
    await onCreateAlbum(name, parentId);
    if (parentId !== null) {
      setExpandedAlbums((prev) => new Set(prev).add(parentId));
    }
    setNewAlbumName('');
    setCreatingAlbumParent(null);
  };

  const submitNewTag = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = newTagName.trim();
    if (!p) return;
    await onCreateTag(p);
    setNewTagName('');
    setCreatingTag(false);
  };

  const renderFolderNode = (node: FolderAlbumNode, depth: number) => {
    const nodeKey = `${node.libraryId}::${node.folderPath}`;
    const isSelected =
      section === 'folderAlbum' &&
      activeFolder?.libraryId === node.libraryId &&
      activeFolder?.folderPath === node.folderPath;
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedFolders.has(nodeKey);
    const isDragTarget = dragOverKey === nodeKey;
    const isRenaming = renamingKey === nodeKey;

    return (
      <div key={nodeKey}>
        {isRenaming ? (
          <form
            onSubmit={(e) =>
              void submitRenameFolder(e, node.libraryId, node.folderPath)
            }
            className="flex items-center gap-1 py-1 pr-2"
            style={{ paddingLeft: `${10 + depth * 14}px` }}
          >
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              className="w-full text-xs px-2 py-1 rounded border border-blue-400 bg-white dark:bg-zinc-900 outline-none"
            />
            <button
              type="button"
              onClick={() => setRenamingKey(null)}
              className="text-zinc-400 hover:text-zinc-600 p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </form>
        ) : (
          <div
            draggable
            onDragStart={(e) => {
              e.stopPropagation();
              e.dataTransfer.setData(
                'application/x-lumina-folder',
                JSON.stringify({
                  libraryId: node.libraryId,
                  folderPath: node.folderPath,
                }),
              );
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              if (isAcceptingFolderDrop(e)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dragOverKey !== nodeKey) setDragOverKey(nodeKey);
              }
            }}
            onContextMenu={
              onContextMenuFolder
                ? (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onContextMenuFolder(e, {
                      libraryId: node.libraryId,
                      folderPath: node.folderPath,
                      name: node.name,
                      isRoot: false,
                    });
                  }
                : undefined
            }
            onDragLeave={() => {
              if (dragOverKey === nodeKey) setDragOverKey(null);
            }}
            onDrop={(e) =>
              void handleDropOnFolder(e, node.libraryId, node.folderPath)
            }
            className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs cursor-pointer transition-colors ${
              isDragTarget
                ? 'bg-blue-100 ring-2 ring-blue-500 text-blue-800 dark:bg-blue-500/30 dark:text-blue-200'
                : isSelected
                  ? 'bg-blue-50 text-blue-700 font-medium dark:bg-blue-500/15 dark:text-blue-300'
                  : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/70'
            }`}
            style={{ paddingLeft: `${6 + depth * 14}px` }}
            onClick={() => {
              onSelectFolderAlbum(node.libraryId, node.folderPath);
              onCloseMobile();
            }}
          >
            <button
              type="button"
              className={`p-0.5 rounded hover:bg-zinc-200/70 dark:hover:bg-zinc-700 ${
                hasChildren ? 'opacity-80' : 'opacity-0 pointer-events-none'
              }`}
              onClick={(e) => {
                e.stopPropagation();
                toggleFolderExpand(nodeKey);
              }}
              aria-label="展开子文件夹"
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </button>
            {node.effectiveLocked ? (
              node.isUnlocked ? (
                <Unlock
                  className="w-3.5 h-3.5 text-emerald-500 shrink-0"
                  aria-label="已解锁隐私文件夹"
                />
              ) : (
                <Lock
                  className="w-3.5 h-3.5 text-amber-500 shrink-0"
                  aria-label="已加密文件夹"
                />
              )
            ) : isSelected || isExpanded ? (
              <FolderOpen className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            ) : (
              <Folder className="w-3.5 h-3.5 text-blue-500/80 shrink-0" />
            )}
            <span className="truncate flex-1">{node.name}</span>
            {node.effectiveExcluded && !node.effectiveLocked && (
              <span title="已从全部相册与搜索排除" className="shrink-0 text-zinc-400">
                <EyeOff className="w-3 h-3" />
              </span>
            )}
            {!(node.effectiveLocked && !node.isUnlocked) && (
              <span className="text-[11px] text-zinc-400 tabular-nums mr-0.5">
                {node.totalCount}
              </span>
            )}

            <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
              {isAdmin && onOpenFolderPrivacy && (
                <button
                  type="button"
                  title="隐私加密 / 排除显示设置"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenFolderPrivacy(node.libraryId, node.folderPath);
                  }}
                  className="p-0.5 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-600 dark:text-amber-400"
                >
                  <Lock className="w-3 h-3" />
                </button>
              )}
              {canEdit && (
                <>
                  <button
                    type="button"
                    title="新建子相册"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCreatingTarget(nodeKey);
                      setNewFolderName('');
                    }}
                    className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500"
                  >
                    <FolderPlus className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    title="重命名文件夹"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingKey(nodeKey);
                      setRenameDraft(node.name);
                    }}
                    className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                </>
              )}
              <button
                type="button"
                title="导出此相册"
                onClick={(e) => {
                  e.stopPropagation();
                  onExportFolderAlbum(
                    node.libraryId,
                    node.folderPath,
                    node.name,
                  );
                }}
                className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500"
              >
                <Download className="w-3 h-3" />
              </button>
              {canEdit && (
                <>
                  <button
                    type="button"
                    title="局域网分享此相册"
                    onClick={(e) => {
                      e.stopPropagation();
                      onShareFolderAlbum(
                        node.libraryId,
                        node.folderPath,
                        node.name,
                      );
                    }}
                    className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500"
                  >
                    <Share2 className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    title="删除相册文件夹"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onDeleteFolderAlbum(node.libraryId, node.folderPath);
                    }}
                    className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-zinc-400 hover:text-red-500"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {creatingTarget === nodeKey && (
          <form
            onSubmit={(e) =>
              void submitCreateFolder(e, node.libraryId, node.folderPath)
            }
            className="flex items-center gap-1 py-1 pr-2"
            style={{ paddingLeft: `${24 + depth * 14}px` }}
          >
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="支持多级路径，如 旅行/日本/京都"
              className="w-full text-xs px-2 py-1 rounded border border-blue-400 bg-white dark:bg-zinc-900 outline-none"
            />
            <button
              type="button"
              onClick={() => setCreatingTarget(null)}
              className="text-zinc-400 hover:text-zinc-600 p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </form>
        )}

        {hasChildren &&
          isExpanded &&
          node.children.map((child) => renderFolderNode(child, depth + 1))}
      </div>
    );
  };

  const renderAlbumNode = (node: AlbumNode, depth = 0) => {
    const dropKey = `album::${node.id}`;
    const isSelected = section === 'album' && activeAlbumId === node.id;
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedAlbums.has(node.id);
    const isDragTarget = dragOverKey === dropKey;

    return (
      <div key={node.id}>
        {renamingAlbumId === node.id ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (albumRenameDraft.trim()) {
                await onRenameAlbum(node.id, albumRenameDraft.trim());
              }
              setRenamingAlbumId(null);
            }}
            className="flex items-center gap-1 py-1 pr-2"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            <input
              autoFocus
              value={albumRenameDraft}
              onChange={(e) => setAlbumRenameDraft(e.target.value)}
              className="w-full text-xs px-2 py-1 rounded border border-indigo-400 bg-white dark:bg-zinc-900 outline-none"
            />
            <button
              type="button"
              onClick={() => setRenamingAlbumId(null)}
              className="text-zinc-400 hover:text-zinc-600 p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </form>
        ) : (
          <div
            onDragOver={(e) => {
              if (
                canEdit &&
                e.dataTransfer.types.includes('application/x-lumina-media-ids')
              ) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                if (dragOverKey !== dropKey) setDragOverKey(dropKey);
              }
            }}
            onDragLeave={() => {
              if (dragOverKey === dropKey) setDragOverKey(null);
            }}
            onDrop={(e) => void handleDropOnVirtualAlbum(e, node.id)}
            className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs cursor-pointer transition-colors ${
              isDragTarget
                ? 'bg-indigo-100 ring-2 ring-indigo-500 text-indigo-800 dark:bg-indigo-500/30 dark:text-indigo-200'
                : isSelected
                  ? 'bg-indigo-50 text-indigo-700 font-medium dark:bg-indigo-500/15 dark:text-indigo-300'
                  : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/70'
            }`}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() => {
              onSelectAlbum(node.id);
              onCloseMobile();
            }}
          >
            <button
              type="button"
              className={`p-0.5 rounded hover:bg-zinc-200/70 dark:hover:bg-zinc-700 ${
                hasChildren ? 'opacity-80' : 'opacity-0 pointer-events-none'
              }`}
              onClick={(e) => {
                e.stopPropagation();
                toggleAlbumExpand(node.id);
              }}
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </button>
            <Album className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
            <span className="truncate flex-1">{node.name}</span>
            <span className="text-[11px] text-zinc-400 tabular-nums mr-0.5">
              {node.itemCount}
            </span>

            {canEdit && (
              <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  title="新建子精选集"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCreatingAlbumParent(node.id);
                    setNewAlbumName('');
                  }}
                  className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500"
                >
                  <Plus className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  title="重命名精选集"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingAlbumId(node.id);
                    setAlbumRenameDraft(node.name);
                  }}
                  className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500"
                >
                  <Pencil className="w-3 h-3" />
                </button>
                {canShareAlbum && (
                  <button
                    type="button"
                    title="分享此精选集"
                    onClick={(e) => {
                      e.stopPropagation();
                      onShareAlbum(node.id, node.name);
                    }}
                    className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500"
                  >
                    <Share2 className="w-3 h-3" />
                  </button>
                )}
                <button
                  type="button"
                  title="删除精选集（不删任何照片）"
                  onClick={(e) => {
                    e.stopPropagation();
                    void onDeleteAlbum(node.id);
                  }}
                  className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-zinc-400 hover:text-red-500"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
        )}

        {creatingAlbumParent === node.id && (
          <form
            onSubmit={(e) => void submitCreateAlbum(e, node.id)}
            className="flex items-center gap-1 py-1 pr-2"
            style={{ paddingLeft: `${22 + depth * 14}px` }}
          >
            <input
              autoFocus
              value={newAlbumName}
              onChange={(e) => setNewAlbumName(e.target.value)}
              placeholder="子精选集名称..."
              className="w-full text-xs px-2 py-1 rounded border border-indigo-400 bg-white dark:bg-zinc-900 outline-none"
            />
            <button
              type="button"
              onClick={() => setCreatingAlbumParent(null)}
              className="text-zinc-400 hover:text-zinc-600 p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </form>
        )}

        {hasChildren &&
          isExpanded &&
          node.children.map((child) => renderAlbumNode(child, depth + 1))}
      </div>
    );
  };

  const renderTagNode = (node: TagTreeNode, depth = 0) => {
    const isSelected = section === 'tag' && activeTagPath === node.fullPath;
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedTags.has(node.fullPath);

    if (node.tag && renamingTagId === node.tag.id) {
      return (
        <div key={node.fullPath}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (tagRenameDraft.trim()) {
                await onRenameTag(node.tag!.id, tagRenameDraft.trim());
              }
              setRenamingTagId(null);
            }}
            className="flex items-center gap-1 py-1 pr-2"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            <input
              autoFocus
              value={tagRenameDraft}
              onChange={(e) => setTagRenameDraft(e.target.value)}
              className="w-full text-xs px-2 py-1 rounded border border-emerald-400 bg-white dark:bg-zinc-900 outline-none"
            />
            <button
              type="button"
              onClick={() => setRenamingTagId(null)}
              className="text-zinc-400 hover:text-zinc-600 p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>
      );
    }

    return (
      <div key={node.fullPath}>
        <div
          className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs cursor-pointer transition-colors ${
            isSelected
              ? 'bg-emerald-50 text-emerald-700 font-medium dark:bg-emerald-500/15 dark:text-emerald-300'
              : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/70'
          }`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => {
            onSelectTag(node.fullPath);
            onCloseMobile();
          }}
        >
          <button
            type="button"
            className={`p-0.5 rounded hover:bg-zinc-200/70 dark:hover:bg-zinc-700 ${
              hasChildren ? 'opacity-80' : 'opacity-0 pointer-events-none'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              toggleTagExpand(node.fullPath);
            }}
          >
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </button>
          <Tag className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
          <span className="truncate flex-1">{node.segment}</span>
          {node.tag && node.tag.itemCount > 0 && (
            <span className="text-[11px] text-zinc-400 tabular-nums mr-1">
              {node.tag.itemCount}
            </span>
          )}
          {node.tag && canEdit && (
            <div className="hidden group-hover:flex items-center gap-0.5">
              <button
                type="button"
                title="编辑标签路径"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenamingTagId(node.tag!.id);
                  setTagRenameDraft(node.tag!.path);
                }}
                className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500"
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                type="button"
                title="删除标签"
                onClick={(e) => {
                  e.stopPropagation();
                  void onDeleteTag(node.tag!.id);
                }}
                className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-zinc-400 hover:text-red-500"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
        {hasChildren &&
          isExpanded &&
          node.children.map((child) => renderTagNode(child, depth + 1))}
      </div>
    );
  };

  const navItemClass = (active: boolean) =>
    `flex items-center justify-between w-full px-3 py-2 rounded-xl text-sm transition-colors ${
      active
        ? 'bg-blue-600 text-white font-medium shadow-sm'
        : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/70'
    }`;

  const content = (
    <div className="flex flex-col h-full bg-zinc-50/90 dark:bg-[#14171d] border-r border-zinc-200/80 dark:border-zinc-800/80 w-68 select-none">
      {/* Brand */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-zinc-200/70 dark:border-zinc-800/70">
        <div className="flex items-center gap-2.5">
          <img
            src="/icon.svg?v=2"
            alt="自己用的一个相册"
            className="w-8 h-8 rounded-xl shadow-sm shrink-0"
          />
          <div>
            <div className="font-semibold text-sm leading-tight">
              自己用的一个相册
            </div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              纯本地隐私相册
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onCloseMobile}
          className="md:hidden p-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800"
          aria-label="关闭侧边栏"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Quick Import / Export CTA */}
      <div className="px-3 pt-3 flex gap-2">
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              onOpenImport();
              onCloseMobile();
            }}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 shadow-xs transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            导入照片(查重)
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            onOpenExport();
            onCloseMobile();
          }}
          className={`${
            canEdit ? 'px-3' : 'flex-1 justify-center'
          } py-2 rounded-xl text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-1 transition-colors`}
        >
          <Download className="w-3.5 h-3.5" />
          导出
        </button>
      </div>

      {/* Scrollable Navigation */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
        <div className="space-y-1">
          <button
            type="button"
            className={navItemClass(section === 'all')}
            onClick={() => {
              onSelectSection('all');
              onCloseMobile();
            }}
          >
            <span className="flex items-center gap-2.5">
              <ImageIcon className="w-4 h-4" />
              全部照片
            </span>
            {stats && (
              <span
                className={`text-xs tabular-nums ${
                  section === 'all' ? 'text-blue-100' : 'text-zinc-400'
                }`}
              >
                {stats.totalMedia.toLocaleString()}
              </span>
            )}
          </button>

          <button
            type="button"
            className={navItemClass(section === 'inbox')}
            onClick={() => {
              onSelectSection('inbox');
              onCloseMobile();
            }}
          >
            <span className="flex items-center gap-2.5">
              <Inbox className="w-4 h-4" />
              待整理收件箱
            </span>
            {stats && stats.inboxCount > 0 && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full tabular-nums ${
                  section === 'inbox'
                    ? 'bg-white/20 text-white'
                    : 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300'
                }`}
              >
                {stats.inboxCount.toLocaleString()}
              </span>
            )}
          </button>

          <button
            type="button"
            className={navItemClass(section === 'favorites')}
            onClick={() => {
              onSelectSection('favorites');
              onCloseMobile();
            }}
          >
            <span className="flex items-center gap-2.5">
              <Heart className="w-4 h-4" />
              我的收藏
            </span>
            {stats && stats.favoriteCount > 0 && (
              <span
                className={`text-xs tabular-nums ${
                  section === 'favorites' ? 'text-blue-100' : 'text-zinc-400'
                }`}
              >
                {stats.favoriteCount}
              </span>
            )}
          </button>

          <button
            type="button"
            aria-expanded={toolsExpanded}
            onClick={() => setToolsExpanded(value => !value)}
            className="w-full flex items-center justify-between px-2 py-2 text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            探索与整理工具
            {toolsExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
          {toolsExpanded && <div className="space-y-1">
          <button
            type="button"
            className={navItemClass(section === 'map')}
            onClick={() => {
              onSelectSection('map');
              onCloseMobile();
            }}
          >
            <span className="flex items-center gap-2.5">
              <MapPin className="w-4 h-4" />
              足迹地图
            </span>
          </button>

          <button
            type="button"
            className={navItemClass(section === 'people')}
            onClick={() => {
              onSelectSection('people');
              onCloseMobile();
            }}
          >
            <span className="flex items-center gap-2.5">
              <Users className="w-4 h-4" />
              人物相册
            </span>
            {aiStatus && aiStatus.peopleCount > 0 && (
              <span
                className={`text-xs tabular-nums ${
                  section === 'people' ? 'text-blue-100' : 'text-zinc-400'
                }`}
              >
                {aiStatus.peopleCount}
              </span>
            )}
          </button>

          <button
            type="button"
            className={navItemClass(section === 'duplicates')}
            onClick={() => {
              onSelectSection('duplicates');
              onCloseMobile();
            }}
          >
            <span className="flex items-center gap-2.5">
              <CopyCheck className="w-4 h-4" />
              重复与相似挑片
            </span>
          </button>

          <button
            type="button"
            className={navItemClass(section === 'storage')}
            onClick={() => {
              onSelectSection('storage');
              onCloseMobile();
            }}
          >
            <span className="flex items-center gap-2.5">
              <PieChart className="w-4 h-4" />
              空间与大文件
            </span>
          </button>
          </div>}

          <button
            type="button"
            className={navItemClass(section === 'trash')}
            onClick={() => {
              onSelectSection('trash');
              onCloseMobile();
            }}
          >
            <span className="flex items-center gap-2.5">
              <Trash2 className="w-4 h-4" />
              回收站
            </span>
            {stats && stats.trashCount > 0 && (
              <span
                className={`text-xs tabular-nums ${
                  section === 'trash' ? 'text-blue-100' : 'text-zinc-400'
                }`}
              >
                {stats.trashCount}
              </span>
            )}
          </button>
        </div>

        {/* Dynamic Smart Albums */}
        <div>
          <div className="flex items-center justify-between px-2 mb-1.5">
            <button
              type="button"
              aria-expanded={smartAlbumsExpanded}
              onClick={toggleSmartAlbums}
              className="flex-1 flex items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
            >
              {smartAlbumsExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 shrink-0" />
              )}
              <span>动态智能相册</span>
              {!smartAlbumsExpanded && smartAlbums.length > 0 && (
                <span className="text-[10px] font-normal tabular-nums text-zinc-400/80">
                  ({smartAlbums.length})
                </span>
              )}
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={onCreateSmartAlbum}
                className="p-1 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500"
                title="新建智能相册规则"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {smartAlbumsExpanded && (
            <div className="space-y-0.5">
              {smartAlbums.map((sa) => {
                const isSelected =
                  section === 'smartAlbum' && activeSmartAlbumId === sa.id;
                return (
                  <div
                    key={sa.id}
                    onClick={() => {
                      onSelectSmartAlbum(sa.id);
                      onCloseMobile();
                    }}
                    className={`group flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-indigo-50 text-indigo-700 font-medium dark:bg-indigo-500/15 dark:text-indigo-300'
                        : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/70'
                    }`}
                  >
                    {renderSmartIcon(sa.icon)}
                    <span className="truncate flex-1">{sa.name}</span>
                    <span className="text-[11px] text-zinc-400 tabular-nums">
                      {sa.itemCount}
                    </span>
                    {canEdit && (
                      <div className="hidden group-hover:flex items-center gap-0.5">
                        <button
                          type="button"
                          title="编辑规则"
                          onClick={(e) => {
                            e.stopPropagation();
                            onEditSmartAlbum(sa);
                          }}
                          className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          title="删除智能相册"
                          onClick={(e) => {
                            e.stopPropagation();
                            void onDeleteSmartAlbum(sa.id);
                          }}
                          className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-zinc-400 hover:text-red-500"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Physical Folder-Backed Album Tree */}
        <div>
          <div className="flex items-center justify-between px-2 mb-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              相册目录树（同步硬盘文件夹）
            </span>
            {canEdit && folderTrees[0] && (
              <button
                type="button"
                onClick={() => {
                  setCreatingTarget(`${folderTrees[0].libraryId}::`);
                  setNewFolderName('');
                }}
                className="p-1 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500"
                title="新建相册文件夹"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {folderTrees.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-400">
              添加图库目录后将显示真实文件夹树
            </div>
          ) : (
            <div className="space-y-2">
              {folderTrees.map((lib) => {
                const rootKey = `${lib.libraryId}::`;
                const isRootSelected =
                  section === 'folderAlbum' &&
                  activeFolder?.libraryId === lib.libraryId &&
                  activeFolder?.folderPath === '';
                const isRootDragTarget = dragOverKey === rootKey;

                return (
                  <div key={lib.libraryId} className="space-y-0.5">
                    <div
                      onDragOver={(e) => {
                        if (isAcceptingFolderDrop(e)) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          if (dragOverKey !== rootKey) setDragOverKey(rootKey);
                        }
                      }}
                      onContextMenu={
                        onContextMenuFolder
                          ? (e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              onContextMenuFolder(e, {
                                libraryId: lib.libraryId,
                                folderPath: '',
                                name: lib.libraryName,
                                isRoot: true,
                              });
                            }
                          : undefined
                      }
                      onDragLeave={() => {
                        if (dragOverKey === rootKey) setDragOverKey(null);
                      }}
                      onDrop={(e) =>
                        void handleDropOnFolder(e, lib.libraryId, '')
                      }
                      onClick={() => {
                        onSelectFolderAlbum(lib.libraryId, '');
                        onCloseMobile();
                      }}
                      className={`group flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
                        isRootDragTarget
                          ? 'bg-blue-100 ring-2 ring-blue-500 text-blue-800 dark:bg-blue-500/30 dark:text-blue-200'
                          : isRootSelected
                            ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                            : 'text-zinc-800 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800/70'
                      }`}
                    >
                      {lib.isLocked ? (
                        lib.isUnlocked ? (
                          <Unlock className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                        ) : (
                          <Lock className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                        )
                      ) : (
                        <HardDrive className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                      )}
                      <span className="truncate flex-1">{lib.libraryName}</span>
                      {lib.isExcluded && !lib.isLocked && (
                        <span title="已从全部相册与搜索排除" className="shrink-0 text-zinc-400">
                          <EyeOff className="w-3 h-3" />
                        </span>
                      )}
                      {!(lib.isLocked && !lib.isUnlocked) && (
                        <span className="text-[11px] text-zinc-400 tabular-nums">
                          {lib.totalCount}
                        </span>
                      )}
                      <div className="hidden group-hover:flex items-center gap-0.5">
                        {isAdmin && onOpenFolderPrivacy && (
                          <button
                            type="button"
                            title="隐私加密 / 排除显示设置"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenFolderPrivacy(lib.libraryId, '');
                            }}
                            className="p-0.5 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-600 dark:text-amber-400"
                          >
                            <Lock className="w-3 h-3" />
                          </button>
                        )}
                        {canEdit && (
                          <button
                            type="button"
                            title="在此图库下新建相册文件夹"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCreatingTarget(rootKey);
                              setNewFolderName('');
                            }}
                            className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500"
                          >
                            <FolderPlus className="w-3 h-3" />
                          </button>
                        )}
                        <button
                          type="button"
                          title="导出整个图库"
                          onClick={(e) => {
                            e.stopPropagation();
                            onExportFolderAlbum(
                              lib.libraryId,
                              '',
                              lib.libraryName,
                            );
                          }}
                          className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500"
                        >
                          <Download className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    {creatingTarget === rootKey && (
                      <form
                        onSubmit={(e) =>
                          void submitCreateFolder(e, lib.libraryId, '')
                        }
                        className="flex items-center gap-1 py-1 pl-4 pr-2"
                      >
                        <input
                          autoFocus
                          value={newFolderName}
                          onChange={(e) => setNewFolderName(e.target.value)}
                          placeholder="支持多级路径，如 旅行/日本/京都"
                          className="w-full text-xs px-2 py-1 rounded border border-blue-400 bg-white dark:bg-zinc-900 outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setCreatingTarget(null)}
                          className="text-zinc-400 hover:text-zinc-600 p-1"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </form>
                    )}

                    {lib.children.map((child) => renderFolderNode(child, 1))}
                  </div>
                );
              })}
            </div>
          )}
          <div className="px-2 pt-1.5 text-[10px] text-zinc-400">
            提示：拖拽照片到文件夹将物理移动原文件
          </div>
        </div>

        {/* Virtual Curated Albums (Non-Destructive Cross-Folder Collections) */}
        <div>
          <div className="flex items-center justify-between px-2 mb-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              虚拟精选集（不移动原文件）
            </span>
            {canEdit && (
              <button
                type="button"
                onClick={() => {
                  setCreatingAlbumParent('root');
                  setNewAlbumName('');
                }}
                className="p-1 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500"
                title="新建跨目录虚拟精选集"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {creatingAlbumParent === 'root' && (
            <form
              onSubmit={(e) => void submitCreateAlbum(e, null)}
              className="flex items-center gap-1 px-2 mb-1.5"
            >
              <input
                autoFocus
                value={newAlbumName}
                onChange={(e) => setNewAlbumName(e.target.value)}
                placeholder="如：年度最佳十张、宝宝成长"
                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-indigo-400 bg-white dark:bg-zinc-900 outline-none"
              />
              <button
                type="button"
                onClick={() => setCreatingAlbumParent(null)}
                className="text-zinc-400 hover:text-zinc-600 p-1"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </form>
          )}

          {albums.length === 0 ? (
            <div className="px-3 py-1.5 text-xs text-zinc-400">
              跨文件夹自由组合主题影集，不改动磁盘位置
            </div>
          ) : (
            <div className="space-y-0.5">
              {albums.map((a) => renderAlbumNode(a, 0))}
            </div>
          )}
        </div>

        {/* Hierarchical Tags */}
        <div>
          <div className="flex items-center justify-between px-2 mb-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              层级标签
            </span>
            {canEdit && (
              <button
                type="button"
                onClick={() => {
                  setCreatingTag(true);
                  setNewTagName('');
                }}
                className="p-1 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500"
                title="新建标签（支持 旅行/日本/京都）"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {creatingTag && (
            <form
              onSubmit={submitNewTag}
              className="flex items-center gap-1 px-2 mb-1.5"
            >
              <input
                autoFocus
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder="如：旅行/京都"
                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-emerald-400 bg-white dark:bg-zinc-900 outline-none"
              />
              <button
                type="button"
                onClick={() => setCreatingTag(false)}
                className="text-zinc-400 hover:text-zinc-600 p-1"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </form>
          )}

          {tagTree.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-400">
              支持用 / 建层级，如 旅行/日本
            </div>
          ) : (
            <div className="space-y-0.5">
              {tagTree.map((t) => renderTagNode(t, 0))}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Controls & Scan Status */}
      <div className="p-3 border-t border-zinc-200/70 dark:border-zinc-800/70 space-y-2">
        {scan.watchWarnings?.map(warning => (
          <div key={warning.libraryId} role="status" className="rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-500/30 px-2.5 py-2 text-[11px] text-amber-800 dark:text-amber-200">
            图库 {warning.libraryId}：{warning.message}
          </div>
        ))}
        {scan.status !== 'idle' && (
          <div className="rounded-xl bg-blue-50 dark:bg-blue-500/10 px-3 py-2 text-xs">
            <div className="flex items-center justify-between font-medium text-blue-700 dark:text-blue-300">
              <span>
                {scan.status === 'scanning'
                  ? '正在扫描照片...'
                  : '生成缩略图...'}
              </span>
              {scan.status === 'thumbnails' && scan.thumbnailsTotal > 0 && (
                <span className="tabular-nums">
                  {scan.thumbnailsDone}/{scan.thumbnailsTotal}
                </span>
              )}
            </div>
            {scan.currentFile && (
              <div className="truncate text-[11px] text-blue-600/80 dark:text-blue-300/70 mt-0.5">
                {scan.currentFile}
              </div>
            )}
            {scan.status === 'thumbnails' && scan.thumbnailsTotal > 0 && (
              <div className="mt-1.5 h-1.5 w-full rounded-full bg-blue-200/70 dark:bg-blue-900/60 overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-all duration-300"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round(
                        (scan.thumbnailsDone / scan.thumbnailsTotal) * 100,
                      ),
                    )}%`,
                  }}
                />
              </div>
            )}
          </div>
        )}

        {scan.status === 'idle' && scan.message && (
          <div className="rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-500/30 px-2.5 py-2 text-[11px] text-amber-800 dark:text-amber-200 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
            <span>{scan.message}</span>
          </div>
        )}

        <div className="space-y-1.5">
          {(() => {
            const aiBusy = Boolean(
              aiStatus &&
                (aiStatus.tasks.clip.running ||
                  aiStatus.tasks.face.running ||
                  aiStatus.tasks.ocr.running ||
                  aiStatus.clipModel?.downloading),
            );
            return (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onOpenSettings(isAdmin ? 'ai' : 'appearance')}
                  title="系统设置中心（AI 与 SigLIP2 模型 / 图库 / 安全 / 局域网 / 备份 / 外观）"
                  className={`flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap border transition-colors ${
                    aiBusy
                      ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-500/20 dark:border-indigo-500/40 dark:text-indigo-300'
                      : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700'
                  }`}
                >
                  <Settings className="w-3.5 h-3.5 shrink-0" />
                  <span>设置中心</span>
                  {aiBusy && (
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping"
                      title="AI 任务或模型下载进行中"
                    />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenSettings('ai')}
                  title="本地离线 AI 与 SigLIP2 模型下载"
                  className={`p-1.5 rounded-xl border transition-colors shrink-0 ${
                    aiBusy
                      ? 'bg-indigo-50 border-indigo-300 text-indigo-600 dark:bg-indigo-500/20 dark:border-indigo-500/40 dark:text-indigo-300'
                      : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-indigo-500 hover:bg-zinc-100 dark:hover:bg-zinc-700'
                  }`}
                >
                  <Cpu className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onOpenSettings('lan')}
                  title="局域网扫码访问 / 远程 Tailscale 访问向导"
                  className="p-1.5 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors shrink-0"
                >
                  <QrCode className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })()}

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onOpenSettings('security')}
              title="访问安全与家庭成员权限"
              className={`flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] font-medium whitespace-nowrap border transition-colors ${
                authStatus?.hasPasscode || authStatus?.hasUsers
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/15 dark:border-emerald-500/30 dark:text-emerald-300'
                  : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">
                {authStatus?.currentUser && authStatus.currentUser.id !== null
                  ? `${authStatus.currentUser.displayName} (${
                      authStatus.currentUser.role === 'viewer'
                        ? '只读'
                        : authStatus.currentUser.role === 'member'
                          ? '成员'
                          : '管理'
                    })`
                  : '安全与成员'}
              </span>
            </button>

            {authStatus?.authRequired && onLogout && (
              <button
                type="button"
                onClick={onLogout}
                title="退出当前账号"
                className="p-1.5 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30 text-zinc-500 transition-colors shrink-0"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={onToggleDark}
              title={darkMode ? '切换浅色主题' : '切换深色主题'}
              className="p-1.5 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors shrink-0"
            >
              {darkMode ? (
                <Sun className="w-3.5 h-3.5 text-amber-400" />
              ) : (
                <Moon className="w-3.5 h-3.5 text-zinc-600" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden md:block shrink-0 h-full">{content}</aside>
      {openMobile && (
        <div className="fixed inset-0 z-40 md:hidden flex">
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-xs"
            onClick={onCloseMobile}
          />
          <div className="relative z-10 h-full">{content}</div>
        </div>
      )}
    </>
  );
};
