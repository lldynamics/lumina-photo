import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FolderPlus } from 'lucide-react';
import { AdminLoginGate } from './components/AdminAuthModal';
import { ContextMenu } from './components/ContextMenu';
import { ErrorBoundary } from './components/ErrorBoundary';
import type { ExportTarget } from './components/ExportModal';
import { FolderAlbumHeader } from './components/FolderAlbumHeader';
import {
  FolderPrivacyModal,
  type FolderPrivacyTarget,
} from './components/FolderPrivacyModal';
import { LockedFolderGate } from './components/LockedFolderGate';
import { MobileNav } from './components/MobileNav';
import type { SettingsTab } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import {
  VirtualTimeline,
  type TimelineInlineMutation,
} from './components/VirtualTimeline';
import { useLibraryRealtime } from './hooks/useLibraryRealtime';
import { useNavHistory } from './hooks/useNavHistory';
import {
  buildContextMenuView,
  type AppContextMenuState,
  type AppFolderPickerState,
  type AppShareTarget,
} from './lib/buildContextMenu';
import { getUserPermissions } from './lib/permissions';
import {
  loadUserPreferences,
  normalizeUserPreferences,
  resolveThemeIsDark,
  saveUserPreferences,
  type UserPreferences,
} from './lib/preferences';

const BatchDateModal = lazy(() =>
  import('./components/BatchDateModal').then((m) => ({
    default: m.BatchDateModal,
  })),
);
const CompareModal = lazy(() =>
  import('./components/CompareModal').then((m) => ({
    default: m.CompareModal,
  })),
);
const DuplicatesView = lazy(() =>
  import('./components/DuplicatesView').then((m) => ({
    default: m.DuplicatesView,
  })),
);
const ExportModal = lazy(() =>
  import('./components/ExportModal').then((m) => ({ default: m.ExportModal })),
);
const FolderPickerModal = lazy(() =>
  import('./components/FolderPickerModal').then((m) => ({
    default: m.FolderPickerModal,
  })),
);
const ImportModal = lazy(() =>
  import('./components/ImportModal').then((m) => ({ default: m.ImportModal })),
);
const Lightbox = lazy(() =>
  import('./components/Lightbox').then((m) => ({ default: m.Lightbox })),
);
const MapView = lazy(() =>
  import('./components/MapView').then((m) => ({ default: m.MapView })),
);
const PeopleView = lazy(() =>
  import('./components/PeopleView').then((m) => ({ default: m.PeopleView })),
);
const PublicShareView = lazy(() =>
  import('./components/PublicShareView').then((m) => ({
    default: m.PublicShareView,
  })),
);
const SemanticSearchView = lazy(() =>
  import('./components/SemanticSearchView').then((m) => ({
    default: m.SemanticSearchView,
  })),
);
const SettingsModal = lazy(() =>
  import('./components/SettingsModal').then((m) => ({
    default: m.SettingsModal,
  })),
);
const ShareModal = lazy(() =>
  import('./components/ShareModal').then((m) => ({ default: m.ShareModal })),
);
const SmartAlbumModal = lazy(() =>
  import('./components/SmartAlbumModal').then((m) => ({
    default: m.SmartAlbumModal,
  })),
);
const StorageView = lazy(() =>
  import('./components/StorageView').then((m) => ({ default: m.StorageView })),
);
const TrashView = lazy(() =>
  import('./components/TrashView').then((m) => ({ default: m.TrashView })),
);
import { api } from './lib/api';
import { findFolderNode } from './lib/folderTree';
import { formatBytes } from './lib/format';
import type {
  ActiveFolderSelection,
  AlbumNode,
  BatchActionType,
  GridDensity,
  MediaFilterParams,
  MediaItem,
  MediaType,
  NavSection,
  SemanticSearchResponse,
  SmartAlbum,
  TimelineBucket,
} from './lib/types';

function findAlbumById(nodes: AlbumNode[], id: number): AlbumNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findAlbumById(n.children, id);
    if (hit) return hit;
  }
  return null;
}

export function App() {
  const shareMatch = window.location.pathname.match(/^\/s\/([^/]+)/);
  if (shareMatch) {
    return (
      <ErrorBoundary title="分享相册加载异常">
        <Suspense
          fallback={
            <div className="h-screen flex items-center justify-center bg-zinc-950 text-xs text-zinc-400">
              正在加载分享相册...
            </div>
          }
        >
          <PublicShareView token={decodeURIComponent(shareMatch[1])} />
        </Suspense>
      </ErrorBoundary>
    );
  }
  return <MainAlbumApp />;
}

function MainAlbumApp() {
  const [preferences, setPreferences] = useState<UserPreferences>(() =>
    loadUserPreferences(),
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) =>
      setSystemPrefersDark(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const darkMode = resolveThemeIsDark(
    preferences.themeMode,
    systemPrefersDark,
  );

  const updatePreferences = useCallback((patch: Partial<UserPreferences>) => {
    setPreferences((prev) => {
      const next = normalizeUserPreferences({ ...prev, ...patch });
      saveUserPreferences(next);
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  const [reloadToken, setReloadToken] = useState(0);
  const triggerReload = useCallback(() => setReloadToken((t) => t + 1), []);

  const {
    authStatus,
    setAuthStatus,
    authChecked,
    libraries,
    librariesLoaded,
    folderTrees,
    setFolderTrees,
    stats,
    setStats,
    albums,
    setAlbums,
    smartAlbums,
    setSmartAlbums,
    tags,
    setTags,
    memories,
    memoriesFallback,
    scan,
    aiStatus,
    setAiStatus,
    refreshMetadata,
    refreshLightweightStatsAndTags,
  } = useLibraryRealtime(triggerReload);

  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [folderPrivacyTarget, setFolderPrivacyTarget] =
    useState<FolderPrivacyTarget | null>(null);
  const [privacyRefreshNonce, setPrivacyRefreshNonce] = useState(0);
  const openSettings = useCallback(
    (tab: SettingsTab = 'ai') => setSettingsTab(tab),
    [],
  );

  const { userRole, canEdit, isGlobalAdmin: isAdmin, canShareAlbum } =
    getUserPermissions(authStatus);

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [section, setSection] = useState<NavSection>('all');
  const [activeFolder, setActiveFolder] =
    useState<ActiveFolderSelection | null>(null);
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [activeAlbumId, setActiveAlbumId] = useState<number | null>(null);
  const [activeSmartAlbumId, setActiveSmartAlbumId] = useState<number | null>(
    null,
  );
  const [activeTagPath, setActiveTagPath] = useState<string | null>(null);
  const [activePersonId, setActivePersonId] = useState<number | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searchMode, setSearchMode] = useState<'keyword' | 'semantic'>('keyword');
  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticSourceItem, setSemanticSourceItem] =
    useState<MediaItem | null>(null);
  const [semanticResult, setSemanticResult] =
    useState<SemanticSearchResponse | null>(null);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaType | undefined>(
    undefined,
  );
  const [minRating, setMinRating] = useState(0);
  const [screenshotsOnly, setScreenshotsOnly] = useState(false);
  const [density, setDensity] = useState<GridDensity>('standard');

  const [totalCount, setTotalCount] = useState(0);
  const [inlineMutation, setInlineMutation] =
    useState<TimelineInlineMutation | null>(null);
  const mutationSeqRef = useRef(0);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const lastClickedIdRef = useRef<number | null>(null);
  const loadedItemMapRef = useRef<Map<number, MediaItem>>(new Map());

  const [lightboxId, setLightboxId] = useState<number | null>(null);
  const [lightboxItems, setLightboxItems] = useState<MediaItem[]>([]);
  const timelineBucketsRef = useRef<{
    buckets: TimelineBucket[];
    filter: MediaFilterParams;
    prefetching: Set<string>;
  }>({ buckets: [], filter: {}, prefetching: new Set() });

  const [importOpen, setImportOpen] = useState(false);
  const [importDefaultTarget, setImportDefaultTarget] =
    useState<ActiveFolderSelection | null>(null);
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [shareTarget, setShareTarget] = useState<AppShareTarget | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<
    number[] | 'all_trashed' | null
  >(null);
  const [compareItems, setCompareItems] = useState<MediaItem[] | null>(null);
  const [batchDateState, setBatchDateState] = useState<{
    mediaIds: number[];
    sampleItem: MediaItem | null;
  } | null>(null);
  const [smartAlbumModalState, setSmartAlbumModalState] = useState<{
    editing: SmartAlbum | null;
    initialFilter?: MediaFilterParams;
  } | null>(null);

  const [contextMenu, setContextMenu] = useState<AppContextMenuState | null>(
    null,
  );
  const [folderPickerState, setFolderPickerState] =
    useState<AppFolderPickerState | null>(null);

  const [sidebarCreateTrigger, setSidebarCreateTrigger] = useState<{
    libraryId: number;
    parentPath: string;
    nonce: number;
  } | null>(null);

  const [sidebarRenameTrigger, setSidebarRenameTrigger] = useState<{
    libraryId: number;
    folderPath: string;
    currentName: string;
    nonce: number;
  } | null>(null);

  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 3500);
  }, []);

  useNavHistory({
    section,
    activeFolder,
    activeAlbumId,
    activeSmartAlbumId,
    activePersonId,
    activeTagPath,
    lightboxOpen: lightboxId !== null,
    onRestoreState: (st) => {
      if (st.closeLightbox) setLightboxId(null);
      if (st.section) setSection(st.section);
      setActiveFolder(st.activeFolder);
      setActiveAlbumId(st.activeAlbumId);
      setActiveSmartAlbumId(st.activeSmartAlbumId);
      setActivePersonId(st.activePersonId);
      setActiveTagPath(st.activeTagPath);
    },
  });

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const runSemanticSearch = useCallback(
    async (rawQuery: string) => {
      const q = rawQuery.trim();
      setSection('semantic');
      setSearchMode('semantic');
      setSemanticSourceItem(null);
      setSemanticQuery(q);
      setSemanticError(null);
      if (!q) {
        setSemanticResult(null);
        setTotalCount(0);
        return;
      }
      setSemanticLoading(true);
      try {
        const res = await api.semanticSearch(q, 60);
        setSemanticResult(res);
        setTotalCount(res.items.length);
      } catch (err) {
        setSemanticError((err as Error).message || 'AI 语义搜索失败');
      } finally {
        setSemanticLoading(false);
      }
    },
    [],
  );

  const handleFindVisualSimilar = useCallback(async (item: MediaItem) => {
    setSection('semantic');
    setSearchMode('semantic');
    setSemanticSourceItem(item);
    setSemanticQuery('');
    setSemanticError(null);
    setSemanticLoading(true);
    try {
      const res = await api.findSimilarVisual(item.id, 30);
      setSemanticResult(res);
      setTotalCount(res.items.length);
    } catch (err) {
      setSemanticError((err as Error).message || '以图搜图失败');
    } finally {
      setSemanticLoading(false);
    }
  }, []);

  const handleJumpToPerson = useCallback((personId: number) => {
    setSection('people');
    setActivePersonId(personId);
    setActiveFolder(null);
    setActiveAlbumId(null);
    setActiveSmartAlbumId(null);
    setActiveTagPath(null);
  }, []);

  useEffect(() => {
    setSelectedIds(new Set());
    lastClickedIdRef.current = null;
  }, [
    section,
    activeFolder?.libraryId,
    activeFolder?.folderPath,
    activeAlbumId,
    activePersonId,
    activeSmartAlbumId,
    activeTagPath,
  ]);

  const activeSmartAlbum = useMemo(
    () => smartAlbums.find((s) => s.id === activeSmartAlbumId) ?? null,
    [smartAlbums, activeSmartAlbumId],
  );

  const baseFilter = useMemo<MediaFilterParams>(() => {
    const f: MediaFilterParams =
      section === 'smartAlbum' && activeSmartAlbum
        ? { ...activeSmartAlbum.filter }
        : {};
    if (mediaTypeFilter) f.mediaType = mediaTypeFilter;
    if (minRating > 0) f.minRating = minRating;
    if (screenshotsOnly) f.screenshotsOnly = true;
    if (debouncedSearch && searchMode === 'keyword') f.search = debouncedSearch;

    if (section === 'inbox') f.inboxOnly = true;
    else if (section === 'favorites') f.favoriteOnly = true;
    else if (section === 'folderAlbum' && activeFolder) {
      f.libraryId = activeFolder.libraryId;
      f.folderPath = activeFolder.folderPath;
      f.includeSubfolders = includeSubfolders;
    } else if (section === 'album' && activeAlbumId !== null) {
      f.albumId = activeAlbumId;
      f.includeSubAlbums = true;
    } else if (section === 'people' && activePersonId !== null) {
      f.personId = activePersonId;
    } else if (section === 'tag' && activeTagPath !== null) {
      f.tagPath = activeTagPath;
    } else if (section === 'trash') {
      f.trashedOnly = true;
    }

    return f;
  }, [
    mediaTypeFilter,
    minRating,
    screenshotsOnly,
    debouncedSearch,
    searchMode,
    section,
    activeFolder,
    includeSubfolders,
    activeAlbumId,
    activePersonId,
    activeSmartAlbum,
    activeTagPath,
  ]);

  const currentFolderInfo = useMemo(() => {
    if (section !== 'folderAlbum' || !activeFolder) return null;
    return findFolderNode(
      folderTrees,
      activeFolder.libraryId,
      activeFolder.folderPath,
    );
  }, [section, activeFolder, folderTrees]);

  const currentAlbumNode = useMemo(() => {
    if (section !== 'album' || activeAlbumId === null) return null;
    return findAlbumById(albums, activeAlbumId);
  }, [section, activeAlbumId, albums]);

  const sectionTitle = useMemo(() => {
    switch (section) {
      case 'all':
        return '全部照片与视频';
      case 'inbox':
        return '待整理收件箱';
      case 'favorites':
        return '我的收藏';
      case 'folderAlbum': {
        if (!activeFolder) return '相册目录';
        if (!activeFolder.folderPath) {
          return currentFolderInfo?.libraryName ?? '图库根目录';
        }
        return (
          activeFolder.folderPath.split('/').pop() ?? activeFolder.folderPath
        );
      }
      case 'duplicates':
        return '重复与相似挑片';
      case 'map':
        return '足迹地图';
      case 'people':
        return '人物相册';
      case 'semantic':
        return 'AI 语义搜图';
      case 'storage':
        return '空间与大文件';
      case 'trash':
        return '回收站';
      case 'album':
        return currentAlbumNode ? `精选集 · ${currentAlbumNode.name}` : '虚拟精选集';
      case 'smartAlbum':
        return activeSmartAlbum?.name ?? '动态智能相册';
      case 'tag':
        return activeTagPath ? `#${activeTagPath}` : '标签';
      default:
        return '全部照片与视频';
    }
  }, [
    section,
    activeFolder,
    currentFolderInfo,
    currentAlbumNode,
    activeSmartAlbum,
    activeTagPath,
  ]);

  const handleToggleSelect = useCallback(
    (id: number, shiftKey: boolean, orderedIds: number[]) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (shiftKey && lastClickedIdRef.current !== null) {
          const startIdx = orderedIds.indexOf(lastClickedIdRef.current);
          const endIdx = orderedIds.indexOf(id);
          if (startIdx !== -1 && endIdx !== -1) {
            const [lo, hi] =
              startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
            for (let i = lo; i <= hi; i++) {
              next.add(orderedIds[i]);
            }
            lastClickedIdRef.current = id;
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        lastClickedIdRef.current = id;
        return next;
      });
    },
    [],
  );

  const handleSelectMultiple = useCallback(
    (ids: number[], selected: boolean) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (selected) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    },
    [],
  );

  const rememberTimeline = useCallback((buckets: TimelineBucket[], filter: MediaFilterParams) => {
    timelineBucketsRef.current = { buckets, filter, prefetching: new Set() };
  }, []);

  // Seamless cross-month Lightbox prefetching when stepping near loaded boundaries
  const handleLightboxNearBoundary = useCallback(
    (direction: 'prev' | 'next') => {
      const { buckets, filter, prefetching } = timelineBucketsRef.current;
      if (buckets.length === 0 || lightboxItems.length === 0) return;

      const edgeItem =
        direction === 'prev'
          ? lightboxItems[0]
          : lightboxItems[lightboxItems.length - 1];
      if (!edgeItem) return;

      const curBucketIdx = buckets.findIndex(
        (b) => b.bucket === edgeItem.monthBucket,
      );
      if (curBucketIdx === -1) return;

      const context = timelineBucketsRef.current;
      const key = `${direction}/${edgeItem.id}`;
      if (prefetching.has(key)) return;
      prefetching.add(key);
      const load = async () => {
        let page = await api.getBucketMedia(edgeItem.monthBucket, filter, undefined, {
          direction, cursor: `${edgeItem.takenAtTs}:${edgeItem.id}`,
        });
        if (!page.items.length) {
          const adjacent = buckets[curBucketIdx + (direction === 'prev' ? -1 : 1)];
          if (!adjacent) return;
          page = await api.getBucketMedia(adjacent.bucket, filter, undefined, { direction });
        }
        if (timelineBucketsRef.current !== context || !page.items.length) return;
        setLightboxItems(prev => {
          const edge = direction === 'prev' ? prev[0] : prev[prev.length - 1];
          if (edge?.id !== edgeItem.id) return prev;
          const seen = new Set(prev.map(it => it.id));
          const fresh = page.items.filter(it => !seen.has(it.id));
          return direction === 'prev' ? [...fresh, ...prev] : [...prev, ...fresh];
        });
      };
      void load().catch(() => {}).finally(() => prefetching.delete(key));
    },
    [lightboxItems],
  );

  const handleLoadedItemsChange = useCallback((items: MediaItem[]) => {
    const map = new Map<number, MediaItem>();
    for (const it of items) map.set(it.id, it);
    loadedItemMapRef.current = map;
  }, []);

  const openCompareForIds = useCallback(
    (ids: number[]) => {
      const list: MediaItem[] = [];
      for (const id of ids.slice(0, 4)) {
        const it = loadedItemMapRef.current.get(id);
        if (it && it.mediaType === 'photo') list.push(it);
      }
      if (list.length < 2) {
        showToast('请至少选择 2 张照片进行并排对比');
        return;
      }
      setCompareItems(list);
    },
    [showToast],
  );

  const openBatchDateForIds = useCallback(
    (ids: number[], fallbackSample?: MediaItem) => {
      if (ids.length === 0) return;
      const sample =
        fallbackSample ?? loadedItemMapRef.current.get(ids[0]) ?? null;
      setBatchDateState({ mediaIds: ids, sampleItem: sample });
    },
    [],
  );

  const runBatchOnIds = useCallback(
    async (
      ids: number[],
      action: BatchActionType,
      extra?: { rating?: number; albumId?: number; tagPath?: string },
    ) => {
      if (ids.length === 0) return;
      const res = await api.batchMedia({
        mediaIds: ids,
        action,
        ...extra,
      });
      setStats(res.stats);
      setSelectedIds(new Set());
      setReloadToken((t) => t + 1);
      void refreshMetadata();

      if (action === 'trash') showToast(`已将 ${ids.length} 项移入回收站`);
      else if (action === 'restore') showToast(`已恢复 ${ids.length} 项`);
      else if (action === 'favorite') showToast(`已收藏 ${ids.length} 项`);
      else if (action === 'unfavorite') showToast('已取消收藏');
      else if (action === 'rate')
        showToast(extra?.rating ? `已设为 ${extra.rating} 星` : '已清除评分');
      else if (action === 'addTag') showToast('已批量添加标签');
      else if (action === 'removeTag') showToast('已批量移除标签');
      else if (action === 'addToAlbum') showToast('已加入虚拟精选集');
    },
    [refreshMetadata, showToast],
  );

  const handleBatchAction = async (
    action: BatchActionType,
    extra?: { rating?: number; albumId?: number; tagPath?: string },
  ) => {
    await runBatchOnIds(Array.from(selectedIds), action, extra);
  };

  const handleMoveMediaToFolder = useCallback(
    async (
      mediaIds: number[],
      targetLibraryId: number,
      targetFolderPath: string,
      mode: 'move' | 'copy' = 'move',
    ) => {
      try {
        const res = await api.moveMediaToFolder(
          mediaIds,
          targetLibraryId,
          targetFolderPath,
          mode,
        );
        setFolderTrees(res.libraries);
        setStats(res.stats);
        setSelectedIds(new Set());
        setReloadToken((t) => t + 1);
        const destLabel = targetFolderPath || '图库根目录';
        if (mode === 'move') {
          showToast(`已将 ${res.movedCount} 项移动到「${destLabel}」`);
        } else {
          showToast(`已复制 ${res.copiedCount} 项到「${destLabel}」`);
        }
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [showToast],
  );

  const handleCreateFolderAlbum = async (
    libraryId: number,
    parentPath: string,
    name: string,
  ): Promise<string | null> => {
    try {
      const res = await api.createFolderAlbum(libraryId, parentPath, name);
      setFolderTrees(res.libraries);
      showToast(`已创建相册文件夹「${res.folderPath}」`);
      return res.folderPath;
    } catch (err) {
      showToast((err as Error).message);
      return null;
    }
  };

  const handleMoveFolderAlbum = async (
    srcLibraryId: number,
    srcFolderPath: string,
    targetLibraryId: number,
    targetParentPath: string,
  ) => {
    try {
      const res = await api.moveFolderAlbum(
        srcLibraryId,
        srcFolderPath,
        targetLibraryId,
        targetParentPath,
      );
      setFolderTrees(res.libraries);
      if (
        section === 'folderAlbum' &&
        activeFolder?.libraryId === srcLibraryId &&
        (activeFolder.folderPath === srcFolderPath ||
          activeFolder.folderPath.startsWith(`${srcFolderPath}/`))
      ) {
        const suffix = activeFolder.folderPath.slice(srcFolderPath.length);
        setActiveFolder({
          libraryId: res.libraryId,
          folderPath: `${res.folderPath}${suffix}`,
        });
      }
      setReloadToken((t) => t + 1);
      showToast(`已将文件夹移动到「${res.folderPath}」`);
    } catch (err) {
      showToast((err as Error).message);
    }
  };

  const handleRenameFolderAlbum = async (
    libraryId: number,
    folderPath: string,
    newName: string,
  ) => {
    try {
      const res = await api.renameFolderAlbum(libraryId, folderPath, newName);
      setFolderTrees(res.libraries);
      if (
        section === 'folderAlbum' &&
        activeFolder?.libraryId === libraryId &&
        (activeFolder.folderPath === folderPath ||
          activeFolder.folderPath.startsWith(`${folderPath}/`))
      ) {
        const suffix = activeFolder.folderPath.slice(folderPath.length);
        setActiveFolder({ libraryId, folderPath: `${res.folderPath}${suffix}` });
      }
      setReloadToken((t) => t + 1);
      showToast(`已重命名为「${newName}」`);
    } catch (err) {
      showToast((err as Error).message);
    }
  };

  const handleDeleteFolderAlbum = async (
    libraryId: number,
    folderPath: string,
  ) => {
    try {
      const res = await api.deleteFolderAlbum(
        libraryId,
        folderPath,
        'empty_only',
      );
      setFolderTrees(res.libraries);
      setStats(res.stats);
      if (
        section === 'folderAlbum' &&
        activeFolder?.libraryId === libraryId &&
        (activeFolder.folderPath === folderPath ||
          activeFolder.folderPath.startsWith(`${folderPath}/`))
      ) {
        setActiveFolder({ libraryId, folderPath: '' });
      }
      showToast('已删除空相册文件夹');
    } catch (err) {
      const msg = (err as Error).message;
      if (
        confirm(
          `${msg}\n\n确认将该相册文件夹里的照片移入软件回收站吗？（原文件可在回收站恢复）`,
        )
      ) {
        const res = await api.deleteFolderAlbum(
          libraryId,
          folderPath,
          'trash_contents',
        );
        setFolderTrees(res.libraries);
        setStats(res.stats);
        setReloadToken((t) => t + 1);
        if (
          section === 'folderAlbum' &&
          activeFolder?.libraryId === libraryId &&
          (activeFolder.folderPath === folderPath ||
            activeFolder.folderPath.startsWith(`${folderPath}/`))
        ) {
          setActiveFolder({ libraryId, folderPath: '' });
        }
        showToast(`已将 ${res.trashedMediaCount} 项移入回收站`);
      }
    }
  };

  const handlePurgeConfirm = async (target: number[] | 'all_trashed') => {
    const res = await api.purgeMedia({ mediaIds: target, confirm: true });
    setPurgeTarget(null);
    setSelectedIds(new Set());
    setReloadToken((t) => t + 1);
    void refreshMetadata();
    if (res.errors.length > 0) {
      showToast(
        `已移入系统废纸篓 ${res.purgedCount} 项，部分异常: ${res.errors[0]}`,
      );
    } else {
      showToast(
        `已将 ${res.purgedCount} 个文件移入系统废纸篓，释放 ${formatBytes(res.freedBytes)}`,
      );
    }
  };

  const openExportForCurrentView = () => {
    if (section === 'folderAlbum' && activeFolder) {
      const label =
        activeFolder.folderPath ||
        currentFolderInfo?.libraryName ||
        '相册目录';
      setExportTarget({
        label: `相册文件夹：${label}`,
        scope: 'folder',
        libraryId: activeFolder.libraryId,
        folderPath: activeFolder.folderPath,
        includeSubfolders,
        defaultZipName: label.split('/').pop() || 'Lumina相册',
      });
    } else {
      setExportTarget({
        label: `${sectionTitle}（当前筛选结果，共 ${totalCount} 项）`,
        scope: 'filter',
        filter: baseFilter,
        defaultZipName: sectionTitle || 'Lumina导出',
      });
    }
    setExportOpen(true);
  };

  const handleContextMenuTile = useCallback(
    (e: React.MouseEvent, item: MediaItem, orderedItems: MediaItem[]) => {
      const targetIds =
        selectedIds.has(item.id) && selectedIds.size > 1
          ? Array.from(selectedIds)
          : [item.id];
      setContextMenu({
        kind: 'media',
        x: e.clientX,
        y: e.clientY,
        item,
        targetIds,
        orderedItems,
      });
    },
    [selectedIds],
  );

  const handleContextMenuFolder = useCallback(
    (
      e: React.MouseEvent,
      target: {
        libraryId: number;
        folderPath: string;
        name: string;
        isRoot: boolean;
      },
    ) => {
      setContextMenu({
        kind: 'folder',
        x: e.clientX,
        y: e.clientY,
        ...target,
      });
    },
    [],
  );

  const openFolderPrivacy = useCallback(
    (libraryId: number, folderPath: string) => {
      const lib = folderTrees.find((t) => t.libraryId === libraryId);
      const libraryName = lib?.libraryName ?? `图库 #${libraryId}`;
      if (!folderPath) {
        setFolderPrivacyTarget({
          libraryId,
          libraryName,
          folderPath: '',
          folderName: libraryName,
          isExcluded: Boolean(lib?.isExcluded),
          isLocked: Boolean(lib?.isLocked),
          isUnlocked: Boolean(lib?.isUnlocked),
        });
        return;
      }
      const found = findFolderNode(folderTrees, libraryId, folderPath);
      setFolderPrivacyTarget({
        libraryId,
        libraryName,
        folderPath,
        folderName:
          found?.node?.name ??
          folderPath.split('/').pop() ??
          libraryName,
        isExcluded: Boolean(found?.node?.isExcluded),
        isLocked: Boolean(found?.node?.isLocked),
        isUnlocked: Boolean(found?.node?.isUnlocked),
      });
    },
    [folderTrees],
  );

  const handleLockFolder = useCallback(
    async (libraryId: number, folderPath: string) => {
      try {
        const res = await api.lockFolder({ libraryId, folderPath });
        setFolderTrees(res.libraries);
        setPrivacyRefreshNonce((n) => n + 1);
        setReloadToken((t) => t + 1);
        void refreshMetadata();
        showToast('已立即重新上锁该隐私文件夹');
      } catch (err) {
        showToast((err as Error).message || '上锁失败');
      }
    },
    [setFolderTrees, refreshMetadata, showToast],
  );

  const contextMenuView = useMemo(
    () =>
      buildContextMenuView({
        contextMenu,
        section,
        canEdit,
        isAdmin,
        onCloseMenu: () => setContextMenu(null),
        onOpenExport: (target) => {
          setExportTarget(target);
          setExportOpen(true);
        },
        onOpenShare: (target) => {
          setShareTarget(target);
          setShareOpen(true);
        },
        onOpenImport: (target) => {
          setImportDefaultTarget(target);
          setImportOpen(true);
        },
        onTriggerSidebarCreate: (libraryId, parentPath) =>
          setSidebarCreateTrigger({ libraryId, parentPath, nonce: Date.now() }),
        onTriggerSidebarRename: (libraryId, folderPath, currentName) =>
          setSidebarRenameTrigger({
            libraryId,
            folderPath,
            currentName,
            nonce: Date.now(),
          }),
        onOpenFolderPicker: setFolderPickerState,
        onOpenFolderPrivacy: openFolderPrivacy,
        onDeleteFolderAlbum: (libraryId, folderPath) =>
          void handleDeleteFolderAlbum(libraryId, folderPath),
        onRunBatch: runBatchOnIds,
        onRequestPurge: setPurgeTarget,
        onOpenLightbox: (item, orderedItems) => {
          setLightboxItems(orderedItems);
          setLightboxId(item.id);
        },
        onOpenCompare: openCompareForIds,
        onOpenBatchDate: openBatchDateForIds,
        onPatchRotated: (media) => {
          mutationSeqRef.current += 1;
          setInlineMutation({
            seq: mutationSeqRef.current,
            type: 'patch',
            id: media.id,
            patch: {
              width: media.width,
              height: media.height,
              mtimeMs: media.mtimeMs,
            },
          });
        },
        onNotify: showToast,
      }),
    [
      contextMenu,
      section,
      canEdit,
      isAdmin,
      runBatchOnIds,
      openBatchDateForIds,
      openCompareForIds,
      openFolderPrivacy,
      showToast,
    ],
  );

  const activeFolderLockState = useMemo(() => {
    if (section !== 'folderAlbum' || !activeFolder) return null;
    const lib = folderTrees.find((t) => t.libraryId === activeFolder.libraryId);
    if (!lib) return null;
    if (!activeFolder.folderPath) {
      if (lib.isLocked && !lib.isUnlocked) {
        return {
          libraryId: lib.libraryId,
          libraryName: lib.libraryName,
          folderPath: '',
          lockedByPath: '',
        };
      }
      return null;
    }
    if (lib.isLocked && !lib.isUnlocked) {
      return {
        libraryId: lib.libraryId,
        libraryName: lib.libraryName,
        folderPath: activeFolder.folderPath,
        lockedByPath: '',
      };
    }
    const found = findFolderNode(
      folderTrees,
      activeFolder.libraryId,
      activeFolder.folderPath,
    );
    if (found?.node?.effectiveLocked && !found.node.isUnlocked) {
      return {
        libraryId: activeFolder.libraryId,
        libraryName: lib.libraryName,
        folderPath: activeFolder.folderPath,
        lockedByPath: found.node.lockedByPath ?? activeFolder.folderPath,
      };
    }
    return null;
  }, [section, activeFolder, folderTrees]);

  const showOnboarding =
    librariesLoaded &&
    libraries.length === 0 &&
    section !== 'trash' &&
    section !== 'duplicates' &&
    section !== 'map' &&
    section !== 'storage' &&
    section !== 'people' &&
    section !== 'semantic';

  const anyOverlayOpen =
    lightboxId !== null ||
    settingsTab !== null ||
    folderPrivacyTarget !== null ||
    importOpen ||
    exportOpen ||
    shareOpen ||
    compareItems !== null ||
    batchDateState !== null ||
    smartAlbumModalState !== null ||
    folderPickerState !== null ||
    purgeTarget !== null;

  const folderAlbumHeaderSlot = (
    <FolderAlbumHeader
      section={section}
      sectionTitle={sectionTitle}
      debouncedSearch={debouncedSearch}
      memories={memories}
      memoriesFallback={memoriesFallback}
      currentAlbumNode={currentAlbumNode}
      activeFolder={activeFolder}
      folderTrees={folderTrees}
      currentFolderNode={currentFolderInfo?.node ?? null}
      canEdit={canEdit}
      isAdmin={isAdmin}
      canShareAlbum={canShareAlbum}
      onSelectFolder={setActiveFolder}
      onOpenLightbox={(item, list) => {
        setLightboxItems(list);
        setLightboxId(item.id);
      }}
      onExportCurrent={openExportForCurrentView}
      onShareAlbum={(albumId, name) => {
        setShareTarget({ shareType: 'album', albumId, defaultTitle: name });
        setShareOpen(true);
      }}
      onShareFolder={(libraryId, folderPath, title) => {
        setShareTarget({
          shareType: 'folder',
          libraryId,
          folderPath,
          defaultTitle: title,
        });
        setShareOpen(true);
      }}
      onOpenFolderPrivacy={openFolderPrivacy}
      onLockFolder={(libId, fp) => void handleLockFolder(libId, fp)}
      onCreateFolderAlbum={handleCreateFolderAlbum}
      onMoveMediaToFolder={handleMoveMediaToFolder}
      onContextMenuFolder={handleContextMenuFolder}
    />
  );

  if (!authChecked) {
    return (
      <div className="h-screen flex items-center justify-center bg-white dark:bg-[#0f1115] text-xs text-zinc-400">
        正在连接 自己用的一个相册...
      </div>
    );
  }

  if (authStatus && authStatus.authRequired && !authStatus.authenticated) {
    return (
      <AdminLoginGate
        authStatus={authStatus}
        onUnlocked={(st) => {
          setAuthStatus(st);
          void refreshMetadata();
        }}
      />
    );
  }

  const handleLogout = async () => {
    try {
      const res = await api.logoutAdmin();
      setAuthStatus(res.status);
      setSettingsTab(null);
      showToast('已退出登录');
    } catch {
      // ignore
    }
  };

  return (
    <div className="h-screen flex bg-white dark:bg-[#0f1115] text-zinc-900 dark:text-zinc-100 overflow-hidden">
      <Sidebar
        openMobile={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
        section={section}
        activeFolder={activeFolder}
        activeAlbumId={activeAlbumId}
        activeSmartAlbumId={activeSmartAlbumId}
        activeTagPath={activeTagPath}
        stats={stats}
        folderTrees={folderTrees}
        albums={albums}
        smartAlbums={smartAlbums}
        tags={tags}
        scan={scan}
        aiStatus={aiStatus}
        authStatus={authStatus}
        darkMode={darkMode}
        onToggleDark={() =>
          updatePreferences({ themeMode: darkMode ? 'light' : 'dark' })
        }
        onSelectSection={(s) => {
          setSection(s);
          setActiveFolder(null);
          setActiveAlbumId(null);
          setActivePersonId(null);
          setActiveSmartAlbumId(null);
          setActiveTagPath(null);
        }}
        onSelectSmartAlbum={(id) => {
          setSection('smartAlbum');
          setActiveSmartAlbumId(id);
          setActiveFolder(null);
          setActiveAlbumId(null);
          setActivePersonId(null);
          setActiveTagPath(null);
        }}
        onCreateSmartAlbum={() => setSmartAlbumModalState({ editing: null })}
        onEditSmartAlbum={(sa) => setSmartAlbumModalState({ editing: sa })}
        onDeleteSmartAlbum={async (id) => {
          const res = await api.deleteSmartAlbum(id);
          setSmartAlbums(res.smartAlbums);
          if (section === 'smartAlbum' && activeSmartAlbumId === id) {
            setSection('all');
            setActiveSmartAlbumId(null);
          }
          showToast('已删除智能相册');
        }}
        onSelectFolderAlbum={(libraryId, folderPath) => {
          setSection('folderAlbum');
          setActiveFolder({ libraryId, folderPath });
          setActiveAlbumId(null);
          setActivePersonId(null);
          setActiveSmartAlbumId(null);
          setActiveTagPath(null);
        }}
        onCreateFolderAlbum={handleCreateFolderAlbum}
        onRenameFolderAlbum={handleRenameFolderAlbum}
        onMoveFolderAlbum={handleMoveFolderAlbum}
        onDeleteFolderAlbum={handleDeleteFolderAlbum}
        onMoveMediaToFolder={(ids, libId, fp) =>
          handleMoveMediaToFolder(ids, libId, fp, 'move')
        }
        onShareFolderAlbum={(libraryId, folderPath, title) => {
          setShareTarget({
            shareType: 'folder',
            libraryId,
            folderPath,
            defaultTitle: title,
          });
          setShareOpen(true);
        }}
        onExportFolderAlbum={(libraryId, folderPath, title) => {
          setExportTarget({
            label: `相册文件夹：${folderPath || title}`,
            scope: 'folder',
            libraryId,
            folderPath,
            includeSubfolders: true,
            defaultZipName: title,
          });
          setExportOpen(true);
        }}
        onContextMenuFolder={handleContextMenuFolder}
        externalCreateTarget={sidebarCreateTrigger}
        externalRenameTarget={sidebarRenameTrigger}
        onSelectAlbum={(albumId) => {
          setSection('album');
          setActiveAlbumId(albumId);
          setActiveFolder(null);
          setActivePersonId(null);
          setActiveSmartAlbumId(null);
          setActiveTagPath(null);
        }}
        onCreateAlbum={async (name, parentId) => {
          try {
            const res = await api.createAlbum(name, parentId);
            setAlbums(res.albums);
            showToast(`已创建精选集「${name}」`);
          } catch (err) {
            showToast((err as Error).message);
          }
        }}
        onRenameAlbum={async (albumId, name) => {
          try {
            const res = await api.updateAlbum(albumId, { name });
            setAlbums(res.albums);
            showToast(`已重命名为「${name}」`);
          } catch (err) {
            showToast((err as Error).message);
          }
        }}
        onDeleteAlbum={async (albumId) => {
          if (!confirm('确认删除此虚拟精选集吗？（不会删除硬盘上的任何照片文件）')) {
            return;
          }
          try {
            const res = await api.deleteAlbum(albumId);
            setAlbums(res.albums);
            if (section === 'album' && activeAlbumId === albumId) {
              setSection('all');
              setActiveAlbumId(null);
            }
            void refreshLightweightStatsAndTags();
            showToast('已删除虚拟精选集');
          } catch (err) {
            showToast((err as Error).message);
          }
        }}
        onAddMediaToAlbum={async (albumId, mediaIds) => {
          try {
            const res = await api.addAlbumMedia(albumId, mediaIds);
            setAlbums(res.albums);
            setSelectedIds(new Set());
            void refreshLightweightStatsAndTags();
            showToast(`已将 ${mediaIds.length} 项加入精选集`);
          } catch (err) {
            showToast((err as Error).message);
          }
        }}
        onShareAlbum={(albumId, title) => {
          setShareTarget({
            shareType: 'album',
            albumId,
            defaultTitle: title,
          });
          setShareOpen(true);
        }}
        onSelectTag={(p) => {
          setSection('tag');
          setActiveTagPath(p);
          setActiveFolder(null);
          setActiveAlbumId(null);
          setActivePersonId(null);
          setActiveSmartAlbumId(null);
        }}
        onCreateTag={async (p) => {
          try {
            const res = await api.createTag(p);
            setTags(res.tags);
          } catch (err) {
            showToast((err as Error).message);
          }
        }}
        onRenameTag={async (id, newPath) => {
          try {
            const res = await api.updateTag(id, { path: newPath });
            setTags(res.tags);
            if (section === 'tag') {
              setActiveTagPath(newPath);
            }
            showToast(`标签已更新为 #${newPath}`);
          } catch (err) {
            showToast((err as Error).message);
          }
        }}
        onDeleteTag={async (id) => {
          const res = await api.deleteTag(id);
          setTags(res.tags);
          if (section === 'tag') {
            setSection('all');
            setActiveTagPath(null);
          }
          void refreshLightweightStatsAndTags();
        }}
        onOpenImport={() => setImportOpen(true)}
        onOpenExport={openExportForCurrentView}
        onOpenSettings={(tab) => openSettings(tab ?? (isAdmin ? 'ai' : 'appearance'))}
        onOpenFolderPrivacy={openFolderPrivacy}
        onLogout={() => void handleLogout()}
      />

      <main className="flex-1 flex flex-col min-w-0 h-full">
        <TopBar
          title={sectionTitle}
          totalCount={totalCount}
          section={section}
          activeFolder={activeFolder}
          includeSubfolders={includeSubfolders}
          onToggleIncludeSubfolders={() => setIncludeSubfolders((v) => !v)}
          search={searchInput}
          onSearchChange={setSearchInput}
          searchMode={searchMode}
          onSearchModeChange={(nextMode) => {
            setSearchMode(nextMode);
            if (nextMode === 'semantic') {
              setSection('semantic');
              if (searchInput.trim()) {
                void runSemanticSearch(searchInput);
              }
            } else if (section === 'semantic') {
              setSection('all');
            }
          }}
          onRunSemanticSearch={(q) => void runSemanticSearch(q)}
          mediaTypeFilter={mediaTypeFilter}
          onMediaTypeChange={setMediaTypeFilter}
          minRating={minRating}
          onMinRatingChange={setMinRating}
          screenshotsOnly={screenshotsOnly}
          onScreenshotsOnlyChange={setScreenshotsOnly}
          density={density}
          onDensityChange={setDensity}
          selectedCount={selectedIds.size}
          onClearSelection={() => setSelectedIds(new Set())}
          onBatchAction={handleBatchAction}
          onMoveSelectionToFolder={(libId, fp, mode) =>
            handleMoveMediaToFolder(Array.from(selectedIds), libId, fp, mode)
          }
          onCreateFolderAndMoveSelection={async (
            libId,
            parentPath,
            newName,
            mode,
          ) => {
            const created = await api.createFolderAlbum(
              libId,
              parentPath,
              newName,
            );
            setFolderTrees(created.libraries);
            await handleMoveMediaToFolder(
              Array.from(selectedIds),
              created.libraryId,
              created.folderPath,
              mode,
            );
          }}
          onShareSelection={() => {
            setShareTarget({
              shareType: 'selection',
              mediaIds: Array.from(selectedIds),
              defaultTitle: `精选照片分享 (${selectedIds.size}项)`,
            });
            setShareOpen(true);
          }}
          onExportSelection={() => {
            const ids = Array.from(selectedIds);
            setExportTarget({
              label: `已选中的 ${ids.length} 项照片/视频`,
              scope: 'selection',
              mediaIds: ids,
              defaultZipName: `精选导出_${ids.length}项`,
            });
            setExportOpen(true);
          }}
          onCompareSelection={() =>
            openCompareForIds(Array.from(selectedIds))
          }
          onBatchDateSelection={() =>
            openBatchDateForIds(Array.from(selectedIds))
          }
          onSaveSmartAlbum={() =>
            setSmartAlbumModalState({
              editing: null,
              initialFilter: baseFilter,
            })
          }
          onOpenImport={() => setImportOpen(true)}
          onOpenExportCurrent={openExportForCurrentView}
          onRequestPurgeSelected={() => setPurgeTarget(Array.from(selectedIds))}
          onScanAll={() => {
            void api.scanAll();
            showToast('已开始增量扫描所有目录');
          }}
          onOpenMobileSidebar={() => setMobileMenuOpen(true)}
          folderTrees={folderTrees}
          albums={albums}
          tags={tags}
          userRole={userRole}
          isAdmin={isAdmin}
        />

        <ErrorBoundary
          compact
          key={section}
          title="当前视图渲染出错"
          onReset={() => setReloadToken((t) => t + 1)}
        >
        {showOnboarding ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <img
              src="/icon.svg?v=2"
              alt="自己用的一个相册"
              className="w-20 h-20 rounded-3xl shadow-lg mb-5"
            />
            {isAdmin ? (
              <>
                <h2 className="text-xl font-bold">
                  欢迎使用「自己用的一个相册」
                </h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2 max-w-md leading-relaxed">
                  选择电脑或外接硬盘里的照片文件夹后，左侧会自动按真实文件夹建立树状相册；导入自动查重、拖拽或按钮移动照片直接同步硬盘目录，也支持跨目录虚拟精选集与一键打包导出。
                </p>
                <button
                  type="button"
                  onClick={() => openSettings('libraries')}
                  className="mt-6 px-6 py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium shadow-md flex items-center gap-2 transition-colors"
                >
                  <FolderPlus className="w-4 h-4" />
                  添加第一个本地照片文件夹
                </button>
              </>
            ) : (
              <>
                <h2 className="text-xl font-bold">当前账号暂无可访问的相册图库</h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2 max-w-md leading-relaxed">
                  请联系相册管理员添加本地照片目录，或在「安全与成员」中为当前账号开启对应的图库目录访问权限。
                </p>
              </>
            )}
          </div>
        ) : section === 'map' ? (
          <Suspense
            fallback={
              <div className="flex-1 flex items-center justify-center text-xs text-zinc-400">
                正在加载地图视图...
              </div>
            }
          >
            <MapView
              onBucketsLoaded={rememberTimeline}
              baseFilter={baseFilter}
              density={density}
              reloadToken={reloadToken}
              selectedIds={selectedIds}
              basemap={preferences.mapBasemap}
              customTileUrl={preferences.mapCustomTileUrl}
              onChangeBasemap={(mode) =>
                updatePreferences({ mapBasemap: mode })
              }
              onOpenMapSettings={() => openSettings('appearance')}
              onToggleSelect={handleToggleSelect}
              onSelectMultiple={handleSelectMultiple}
              onReplaceSelection={setSelectedIds}
              onOpenLightbox={(item, list) => {
                setLightboxItems(list);
                setLightboxId(item.id);
              }}
              onContextMenuTile={handleContextMenuTile}
              onTotalCountChange={setTotalCount}
            />
          </Suspense>
        ) : section === 'people' ? (
          <Suspense
            fallback={
              <div className="flex-1 flex items-center justify-center text-xs text-zinc-400">
                正在加载人物相册...
              </div>
            }
          >
            <PeopleView
              onBucketsLoaded={rememberTimeline}
              aiStatus={aiStatus}
              activePersonId={activePersonId}
              onSelectPerson={setActivePersonId}
              baseFilter={baseFilter}
              density={density}
              reloadToken={reloadToken}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
              onSelectMultiple={handleSelectMultiple}
              onReplaceSelection={setSelectedIds}
              onOpenLightbox={(item, list) => {
                setLightboxItems(list);
                setLightboxId(item.id);
              }}
              onContextMenuTile={handleContextMenuTile}
              onTotalCountChange={setTotalCount}
              onOpenAiModal={() => openSettings('ai')}
              onNotify={showToast}
              onRefreshAiStatus={() => {
                void api
                  .getAiStatus()
                  .then(setAiStatus)
                  .catch(() => undefined);
              }}
              readOnly={!canEdit}
              isAdmin={isAdmin}
            />
          </Suspense>
        ) : section === 'semantic' ? (
          <Suspense
            fallback={
              <div className="flex-1 flex items-center justify-center text-xs text-zinc-400">
                正在加载语义搜图...
              </div>
            }
          >
            <SemanticSearchView
              query={semanticQuery}
              similarSourceItem={semanticSourceItem}
              result={semanticResult}
              loading={semanticLoading}
              error={semanticError}
              aiStatus={aiStatus}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
              onQuickQuery={(q) => {
                setSearchInput(q);
                void runSemanticSearch(q);
              }}
              onOpenLightbox={(item, list) => {
                setLightboxItems(list);
                setLightboxId(item.id);
              }}
              onContextMenuTile={handleContextMenuTile}
              onOpenAiModal={() => openSettings('ai')}
              onClear={() => {
                setSearchMode('keyword');
                setSection('all');
              }}
            />
          </Suspense>
        ) : section === 'storage' ? (
          <Suspense
            fallback={
              <div className="flex-1 flex items-center justify-center text-xs text-zinc-400">
                正在加载空间分析...
              </div>
            }
          >
            <StorageView
              reloadToken={reloadToken}
              onTrashIds={async (ids) => {
                await api.batchMedia({ mediaIds: ids, action: 'trash' });
                setReloadToken((t) => t + 1);
                void refreshMetadata();
                showToast(`已将 ${ids.length} 个大文件移入回收站`);
              }}
              onOpenLightbox={(item, list) => {
                setLightboxItems(list);
                setLightboxId(item.id);
              }}
              onTotalCountChange={setTotalCount}
              readOnly={!canEdit}
            />
          </Suspense>
        ) : section === 'trash' ? (
          <Suspense
            fallback={
              <div className="flex-1 flex items-center justify-center text-xs text-zinc-400">
                正在加载回收站...
              </div>
            }
          >
            <TrashView
              onBucketsLoaded={rememberTimeline}
              stats={stats}
              baseFilter={baseFilter}
              density={density}
              reloadToken={reloadToken}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
              onSelectMultiple={handleSelectMultiple}
              onReplaceSelection={setSelectedIds}
              onOpenLightbox={(item, list) => {
                setLightboxItems(list);
                setLightboxId(item.id);
              }}
              onContextMenuTile={handleContextMenuTile}
              onTotalCountChange={setTotalCount}
              onRestoreAll={async () => {
                const res = await api.batchMedia({
                  mediaIds: 'all_trashed',
                  action: 'restore',
                });
                setStats(res.stats);
                setReloadToken((t) => t + 1);
                void refreshMetadata();
                showToast(`已恢复全部 ${res.affected} 个项目`);
              }}
              onPurgeConfirm={handlePurgeConfirm}
              purgeTarget={purgeTarget}
              onSetPurgeTarget={setPurgeTarget}
              userRole={userRole}
              isAdmin={isAdmin}
            />
          </Suspense>
        ) : section === 'duplicates' ? (
          <Suspense
            fallback={
              <div className="flex-1 flex items-center justify-center text-xs text-zinc-400">
                正在加载重复查重...
              </div>
            }
          >
            <DuplicatesView
              reloadToken={reloadToken}
              onTrashIds={async (ids) => {
                await api.batchMedia({ mediaIds: ids, action: 'trash' });
                setReloadToken((t) => t + 1);
                void refreshMetadata();
                showToast(`已将 ${ids.length} 个项目移入回收站`);
              }}
              onOpenLightbox={(item, list) => {
                setLightboxItems(list);
                setLightboxId(item.id);
              }}
              onCompareItems={(items) => setCompareItems(items)}
              onTotalCountChange={setTotalCount}
              readOnly={!canEdit}
            />
          </Suspense>
        ) : activeFolderLockState ? (
          <LockedFolderGate
            libraryId={activeFolderLockState.libraryId}
            libraryName={activeFolderLockState.libraryName}
            folderPath={activeFolderLockState.folderPath}
            lockedByPath={activeFolderLockState.lockedByPath}
            isAdmin={isAdmin}
            onUnlocked={(nextLibraries) => {
              setFolderTrees(nextLibraries);
              setPrivacyRefreshNonce((n) => n + 1);
              setReloadToken((t) => t + 1);
              void refreshMetadata();
              showToast('已解锁隐私文件夹');
            }}
            onOpenManagePrivacy={
              isAdmin
                ? () =>
                    openFolderPrivacy(
                      activeFolderLockState.libraryId,
                      activeFolderLockState.lockedByPath,
                    )
                : undefined
            }
          />
        ) : (
          <VirtualTimeline
            filter={baseFilter}
            density={density}
            reloadToken={reloadToken}
            inlineMutation={inlineMutation}
            selectedIds={selectedIds}
            keyboardSelectionEnabled={!anyOverlayOpen}
            onToggleSelect={handleToggleSelect}
            onSelectMultiple={handleSelectMultiple}
            onReplaceSelection={setSelectedIds}
            onClearSelection={() => setSelectedIds(new Set())}
            onLoadedItemsChange={handleLoadedItemsChange}
            onOpenLightbox={(item, list) => {
              setLightboxItems(list);
              setLightboxId(item.id);
            }}
            onContextMenuTile={handleContextMenuTile}
            onBucketsLoaded={rememberTimeline}
            onTotalCountChange={setTotalCount}
            headerSlot={folderAlbumHeaderSlot}
            emptyTitle={
              section === 'inbox'
                ? '太棒了！待整理收件箱已清空'
                : section === 'folderAlbum'
                  ? '此相册文件夹暂无直属照片'
                  : section === 'album'
                    ? '此虚拟精选集暂无照片'
                    : '当前视图暂无照片或视频'
            }
            emptySubtitle={
              section === 'inbox'
                ? '所有照片均已归入精选集、贴标签或打分收藏'
                : section === 'folderAlbum'
                  ? '可直接把照片拖拽到左侧此文件夹，或点击「导入照片(查重)」导入到这里'
                  : section === 'album'
                    ? '可在浏览照片时直接拖拽照片到左侧此精选集，或选中后点击顶部「精选集」'
                    : '尝试清空搜索框或切换筛选条件'
            }
          />
        )}
        </ErrorBoundary>
      </main>

      <MobileNav
        section={section}
        stats={stats}
        onSelectSection={(s) => {
          if (s === 'folderAlbum') {
            setSection('folderAlbum');
            if (!activeFolder && folderTrees[0]) {
              setActiveFolder({
                libraryId: folderTrees[0].libraryId,
                folderPath: '',
              });
            }
          } else {
            setSection(s);
            setActiveFolder(null);
          }
          setActiveAlbumId(null);
          setActivePersonId(null);
          setActiveSmartAlbumId(null);
          setActiveTagPath(null);
        }}
        onOpenMenu={() => setMobileMenuOpen(true)}
      />

      <Suspense fallback={null}>
        {lightboxId !== null && (
          <ErrorBoundary
            title="大图预览遇到异常"
            onReset={() => setLightboxId(null)}
          >
          <Lightbox
            items={lightboxItems}
            currentId={lightboxId}
            onClose={() => setLightboxId(null)}
            onChangeId={setLightboxId}
            onNearBoundary={['storage', 'semantic', 'duplicates'].includes(section) ? undefined : handleLightboxNearBoundary}
            onItemPatched={(updated) => {
              setLightboxItems((prev) =>
                prev.map((it) =>
                  it.id === updated.id ? { ...it, ...updated } : it,
                ),
              );
              mutationSeqRef.current += 1;
              setInlineMutation({
                seq: mutationSeqRef.current,
                type: 'patch',
                id: updated.id,
                patch: {
                  isFavorite: updated.isFavorite,
                  rating: updated.rating,
                  isOrganized: updated.isOrganized,
                  takenAt: updated.takenAt,
                  takenAtTs: updated.takenAtTs,
                  monthBucket: updated.monthBucket,
                  dayBucket: updated.dayBucket,
                  width: updated.width,
                  height: updated.height,
                  mtimeMs: updated.mtimeMs,
                },
              });
            }}
            onItemTrashed={(id) => {
              setLightboxItems((prev) => prev.filter((it) => it.id !== id));
              mutationSeqRef.current += 1;
              setInlineMutation({
                seq: mutationSeqRef.current,
                type: 'remove',
                id,
              });
              setTotalCount((c) => Math.max(0, c - 1));
            }}
            onNotify={showToast}
            onMoveToFolder={async (mediaId, libId, fp) => {
              await handleMoveMediaToFolder([mediaId], libId, fp, 'move');
            }}
            onSetFolderCover={async (libId, fp, mediaId) => {
              try {
                const res = await api.setFolderAlbumCover(libId, fp, mediaId);
                setFolderTrees(res.libraries);
                showToast('已将该照片设为相册文件夹封面');
              } catch (err) {
                showToast((err as Error).message);
              }
            }}
            onJumpToPerson={handleJumpToPerson}
            onFindVisualSimilar={(item) => void handleFindVisualSimilar(item)}
            onMutated={(opts) => {
              // Only reload timeline buckets if item sort order/filter membership structurally changed
              const filterMayExclude =
                section === 'favorites' ||
                section === 'inbox' ||
                section === 'smartAlbum' ||
                minRating > 0 ||
                Boolean(opts?.structural);
              if (filterMayExclude) {
                setReloadToken((t) => t + 1);
              }
              void refreshLightweightStatsAndTags();
            }}
            folderTrees={folderTrees}
            albums={albums}
            tags={tags}
            readOnly={!canEdit}
            defaultSlideshowIntervalSec={preferences.slideshowIntervalSec}
            defaultShowFaceBoxes={preferences.showFaceBoxesDefault}
            onSlideshowIntervalChange={(sec) =>
              updatePreferences({ slideshowIntervalSec: sec })
            }
          />
          </ErrorBoundary>
        )}

        {settingsTab !== null && (
          <SettingsModal
            open={settingsTab !== null}
            initialTab={settingsTab}
            onClose={() => setSettingsTab(null)}
            isAdmin={isAdmin}
            userRole={userRole}
            authStatus={authStatus}
            libraries={libraries}
            folderTrees={folderTrees}
            aiStatus={aiStatus}
            density={density}
            preferences={preferences}
            privacyRefreshNonce={privacyRefreshNonce}
            onUpdatePreferences={updatePreferences}
            onDensityChange={setDensity}
            onAiStatusUpdated={setAiStatus}
            onLibrariesChanged={() => {
              setReloadToken((t) => t + 1);
              void refreshMetadata();
            }}
            onOpenFolderPrivacy={openFolderPrivacy}
            onJumpToFolder={(libraryId, folderPath) => {
              setSection('folderAlbum');
              setActiveFolder({ libraryId, folderPath });
              setActiveAlbumId(null);
              setActivePersonId(null);
              setActiveSmartAlbumId(null);
              setActiveTagPath(null);
            }}
            onFolderTreesUpdated={(nextLibraries) => {
              setFolderTrees(nextLibraries);
              setReloadToken((t) => t + 1);
              void refreshMetadata();
            }}
            onAuthUpdated={(st) => {
              setAuthStatus(st);
              showToast('安全与成员配置已更新');
            }}
            onLogout={() => void handleLogout()}
            onRestored={() => {
              setReloadToken((t) => t + 1);
              void refreshMetadata();
            }}
            onNotify={showToast}
          />
        )}

        {importOpen && (
          <ImportModal
            open={importOpen}
            folderTrees={folderTrees}
            defaultTarget={importDefaultTarget ?? activeFolder}
            onClose={() => {
              setImportOpen(false);
              setImportDefaultTarget(null);
            }}
            onImported={() => {
              setReloadToken((t) => t + 1);
              void refreshMetadata();
            }}
            onOpenSetup={() => openSettings('libraries')}
            isAdmin={isAdmin}
          />
        )}

        {exportOpen && (
          <ExportModal
            open={exportOpen}
            target={exportTarget}
            onClose={() => setExportOpen(false)}
            isAdmin={isAdmin}
          />
        )}

        {shareOpen && (
          <ShareModal
            open={shareOpen}
            target={shareTarget}
            authStatus={authStatus}
            onOpenSecurity={() => {
              setShareOpen(false);
              openSettings('security');
            }}
            onClose={() => setShareOpen(false)}
          />
        )}

        {folderPickerState !== null && (
          <FolderPickerModal
            open={folderPickerState !== null}
            title={
              folderPickerState?.kind === 'moveFolder'
                ? `移动文件夹「${folderPickerState.name}」`
                : folderPickerState?.title ?? '选择目标相册文件夹'
            }
            subtitle={
              folderPickerState?.kind === 'moveFolder'
                ? '将会在硬盘上将整个目录及其照片一起搬迁到所选父文件夹下'
                : folderPickerState?.kind === 'copyMedia'
                  ? '保留原图，在目标文件夹新建一份副本'
                  : '将在硬盘上把原文件（及关联实况视频）移动到目标文件夹'
            }
            confirmLabel={
              folderPickerState?.kind === 'copyMedia'
                ? '确认复制到此处'
                : '确认移动到此处'
            }
            folderTrees={folderTrees}
            excludeFolder={
              folderPickerState?.kind === 'moveFolder'
                ? {
                    libraryId: folderPickerState.libraryId,
                    folderPath: folderPickerState.folderPath,
                  }
                : undefined
            }
            onCreateFolder={handleCreateFolderAlbum}
            onConfirm={async (targetLibId, targetPath) => {
              if (!folderPickerState) return;
              if (folderPickerState.kind === 'moveFolder') {
                await handleMoveFolderAlbum(
                  folderPickerState.libraryId,
                  folderPickerState.folderPath,
                  targetLibId,
                  targetPath,
                );
              } else {
                await handleMoveMediaToFolder(
                  folderPickerState.mediaIds,
                  targetLibId,
                  targetPath,
                  folderPickerState.kind === 'copyMedia' ? 'copy' : 'move',
                );
              }
            }}
            onClose={() => setFolderPickerState(null)}
          />
        )}

        {compareItems !== null && (
          <CompareModal
            open={compareItems !== null}
            items={compareItems ?? []}
            onClose={() => setCompareItems(null)}
            readOnly={!canEdit}
            onKeepOnly={async (_keepId, trashIds) => {
              if (trashIds.length > 0) {
                await api.batchMedia({ mediaIds: trashIds, action: 'trash' });
                setReloadToken((t) => t + 1);
                void refreshMetadata();
                showToast(`已保留最佳照片，并将 ${trashIds.length} 张移入回收站`);
              }
              setCompareItems(null);
              setSelectedIds(new Set());
            }}
            onTrashSingle={async (id) => {
              await api.batchMedia({ mediaIds: [id], action: 'trash' });
              setReloadToken((t) => t + 1);
              void refreshMetadata();
              setCompareItems((prev) => {
                if (!prev) return null;
                const next = prev.filter((x) => x.id !== id);
                return next.length > 0 ? next : null;
              });
              showToast('已移入回收站');
            }}
            onToggleFavorite={async (item) => {
              const updated = await api.updateMedia(item.id, {
                isFavorite: !item.isFavorite,
              });
              setCompareItems((prev) =>
                prev
                  ? prev.map((it) =>
                      it.id === item.id ? { ...it, ...updated } : it,
                    )
                  : null,
              );
              mutationSeqRef.current += 1;
              setInlineMutation({
                seq: mutationSeqRef.current,
                type: 'patch',
                id: updated.id,
                patch: { isFavorite: updated.isFavorite },
              });
              void refreshMetadata();
            }}
          />
        )}

        {batchDateState !== null && (
          <BatchDateModal
            open={batchDateState !== null}
            mediaIds={batchDateState?.mediaIds ?? []}
            sampleItem={batchDateState?.sampleItem}
            onClose={() => setBatchDateState(null)}
            onSaved={(affected) => {
              setReloadToken((t) => t + 1);
              setSelectedIds(new Set());
              void refreshMetadata();
              showToast(`已成功修正 ${affected} 项的拍摄时间/地点`);
            }}
          />
        )}

        {smartAlbumModalState !== null && (
          <SmartAlbumModal
            open={smartAlbumModalState !== null}
            editing={smartAlbumModalState?.editing ?? null}
            initialFilter={smartAlbumModalState?.initialFilter}
            tags={tags}
            onClose={() => setSmartAlbumModalState(null)}
            onSaved={(list, createdId) => {
              setSmartAlbums(list);
              if (createdId) {
                setSection('smartAlbum');
                setActiveSmartAlbumId(createdId);
                setActiveFolder(null);
                setActiveAlbumId(null);
                setActivePersonId(null);
                setActiveTagPath(null);
              } else {
                setReloadToken((t) => t + 1);
              }
              showToast('已保存智能相册规则');
            }}
          />
        )}
      </Suspense>

      {folderPrivacyTarget !== null && (
        <FolderPrivacyModal
          open={folderPrivacyTarget !== null}
          target={folderPrivacyTarget}
          onClose={() => setFolderPrivacyTarget(null)}
          onUpdated={({ libraries: nextLibraries }) => {
            setFolderTrees(nextLibraries);
            setPrivacyRefreshNonce((n) => n + 1);
            setReloadToken((t) => t + 1);
            void refreshMetadata();
          }}
          onNotify={showToast}
        />
      )}

      {contextMenu && contextMenuView && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          header={contextMenuView.header}
          entries={contextMenuView.entries}
          onClose={() => setContextMenu(null)}
        />
      )}

      {toast && (
        <div className="fixed bottom-16 md:bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-xs font-medium shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
