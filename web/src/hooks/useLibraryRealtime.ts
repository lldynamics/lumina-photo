import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiHttpError } from '../lib/api';
import type {
  AiStatusResponse,
  AlbumNode,
  AuthStatusResponse,
  Library,
  LibraryFolderTree,
  LibraryStats,
  MemoryYearGroup,
  ScanProgressEvent,
  SmartAlbum,
  TagItem,
} from '../lib/types';

export const IDLE_SCAN: ScanProgressEvent = {
  status: 'idle',
  libraryId: null,
  libraryName: null,
  scannedFiles: 0,
  newFiles: 0,
  updatedFiles: 0,
  removedFiles: 0,
  thumbnailsDone: 0,
  thumbnailsTotal: 0,
  currentFile: null,
};

export function useLibraryRealtime(onDataReload: () => void) {
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [libraries, setLibraries] = useState<Library[]>([]);
  const [librariesLoaded, setLibrariesLoaded] = useState(false);
  const [folderTrees, setFolderTrees] = useState<LibraryFolderTree[]>([]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [albums, setAlbums] = useState<AlbumNode[]>([]);
  const [smartAlbums, setSmartAlbums] = useState<SmartAlbum[]>([]);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [memories, setMemories] = useState<MemoryYearGroup[]>([]);
  const [memoriesFallback, setMemoriesFallback] = useState(false);
  const [scan, setScan] = useState<ScanProgressEvent>(IDLE_SCAN);
  const [aiStatus, setAiStatus] = useState<AiStatusResponse | null>(null);

  const onDataReloadRef = useRef(onDataReload);
  onDataReloadRef.current = onDataReload;

  // Initial auth handshake
  useEffect(() => {
    api
      .getAuthStatus()
      .then((st) => {
        setAuthStatus(st);
        setAuthChecked(true);
      })
      .catch(() => {
        setAuthChecked(true);
      });
  }, []);

  const refreshLightweightStatsAndTags = useCallback(async () => {
    const [sysRes, albRes, smartRes, tagRes] = await Promise.all([
      api.getSystemInfo().catch(() => null),
      api.getAlbums().catch(() => ({ albums: [] })),
      api.getSmartAlbums().catch(() => ({ smartAlbums: [] })),
      api.getTags().catch(() => ({ tags: [] })),
    ]);
    if (sysRes) {
      setStats(sysRes.stats);
      setScan(sysRes.scan);
    }
    setAlbums(albRes.albums);
    setSmartAlbums(smartRes.smartAlbums);
    setTags(tagRes.tags);
  }, []);

  const refreshMetadata = useCallback(async () => {
    try {
      const [
        sysRes,
        libRes,
        treeRes,
        albRes,
        smartRes,
        tagRes,
        memRes,
        aiRes,
      ] = await Promise.all([
        api.getSystemInfo(),
        api.getLibraries(),
        api.getFolderAlbumTree(),
        api.getAlbums(),
        api.getSmartAlbums(),
        api.getTags(),
        api
          .getMemories()
          .catch(() => ({ memories: [], isNearbyFallback: false })),
        api.getAiStatus().catch(() => null),
      ]);
      setStats(sysRes.stats);
      setScan(sysRes.scan);
      setLibraries(libRes.libraries);
      setFolderTrees(treeRes.libraries);
      setLibrariesLoaded(true);
      setAlbums(albRes.albums);
      setSmartAlbums(smartRes.smartAlbums);
      setTags(tagRes.tags);
      setMemories(memRes.memories);
      setMemoriesFallback(Boolean(memRes.isNearbyFallback));
      if (aiRes) setAiStatus(aiRes);
    } catch (err) {
      if (err instanceof ApiHttpError && err.status === 401) {
        setAuthStatus((prev) =>
          prev
            ? { ...prev, authenticated: false, authRequired: true }
            : {
                authRequired: true,
                authenticated: false,
                hasPasscode: true,
                isLoopback: false,
                requireOnLoopback: false,
                envManaged: false,
              },
        );
      }
    }
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    if (authStatus && !authStatus.authenticated) return;
    void refreshMetadata();
  }, [authChecked, authStatus?.authenticated, refreshMetadata]);

  const prevStatusRef = useRef<string>('idle');
  useEffect(() => {
    if (!authChecked || (authStatus && !authStatus.authenticated)) return;
    const es = new EventSource('/api/system/events');
    es.addEventListener('progress', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as ScanProgressEvent;
        setScan(data);
        const prev = prevStatusRef.current;
        prevStatusRef.current = data.status;

        if (
          (prev !== 'idle' && data.status === 'idle') ||
          (prev === 'scanning' && data.status === 'thumbnails')
        ) {
          void refreshMetadata();
          onDataReloadRef.current();
        }
      } catch {
        // ignore parse errors
      }
    });
    return () => es.close();
  }, [authChecked, authStatus?.authenticated, refreshMetadata]);

  const prevAiRunningRef = useRef(false);
  useEffect(() => {
    if (!authChecked || (authStatus && !authStatus.authenticated)) return;
    const es = new EventSource('/api/ai/events');
    es.addEventListener('status', (ev) => {
      try {
        const next = JSON.parse((ev as MessageEvent).data) as AiStatusResponse;
        setAiStatus(next);
        const nowRunning =
          next.tasks.clip.running ||
          next.tasks.face.running ||
          next.tasks.ocr.running;
        if (prevAiRunningRef.current && !nowRunning) {
          onDataReloadRef.current();
        }
        prevAiRunningRef.current = nowRunning;
      } catch {
        // ignore parse errors
      }
    });
    return () => es.close();
  }, [authChecked, authStatus?.authenticated]);

  return {
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
  };
}
