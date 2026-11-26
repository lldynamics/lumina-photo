import type { FolderAlbumNode, LibraryFolderTree } from './types';

export interface FlatFolderOption {
  libraryId: number;
  libraryName: string;
  folderPath: string;
  label: string;
  depth: number;
  totalCount: number;
  isLockedSealed?: boolean;
  isEffectiveLocked?: boolean;
}

export function flattenFolderTrees(
  trees: LibraryFolderTree[],
): FlatFolderOption[] {
  const out: FlatFolderOption[] = [];

  const walk = (
    libId: number,
    libName: string,
    nodes: FolderAlbumNode[],
    depth: number,
  ) => {
    for (const n of nodes) {
      const sealed = Boolean(n.effectiveLocked && !n.isUnlocked);
      out.push({
        libraryId: libId,
        libraryName: libName,
        folderPath: n.folderPath,
        label: `${'  '.repeat(depth)}└ ${n.name}`,
        depth,
        totalCount: n.totalCount,
        isLockedSealed: sealed,
        isEffectiveLocked: Boolean(n.effectiveLocked),
      });
      if (n.children.length > 0 && !sealed) {
        walk(libId, libName, n.children, depth + 1);
      }
    }
  };

  for (const t of trees) {
    const rootSealed = Boolean(t.isLocked && !t.isUnlocked);
    out.push({
      libraryId: t.libraryId,
      libraryName: t.libraryName,
      folderPath: '',
      label: `${t.libraryName}（根目录）`,
      depth: 0,
      totalCount: t.totalCount,
      isLockedSealed: rootSealed,
      isEffectiveLocked: Boolean(t.isLocked),
    });
    if (!rootSealed) {
      walk(t.libraryId, t.libraryName, t.children, 1);
    }
  }

  return out;
}

export function findFolderNode(
  trees: LibraryFolderTree[],
  libraryId: number,
  folderPath: string,
): { libraryName: string; node: FolderAlbumNode | null } | null {
  const lib = trees.find((t) => t.libraryId === libraryId);
  if (!lib) return null;
  if (!folderPath) return { libraryName: lib.libraryName, node: null };

  const search = (nodes: FolderAlbumNode[]): FolderAlbumNode | null => {
    for (const n of nodes) {
      if (n.folderPath === folderPath) return n;
      const hit = search(n.children);
      if (hit) return hit;
    }
    return null;
  };

  return { libraryName: lib.libraryName, node: search(lib.children) };
}
