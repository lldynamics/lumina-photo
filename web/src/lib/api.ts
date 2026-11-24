import type {
  AiStatusResponse,
  AiTaskKey,
  AlbumNode,
  AuthStatusResponse,
  BackupArchiveItem,
  BackupProgress,
  BackupRestoreResult,
  BackupSummaryResponse,
  BatchActionRequest,
  BatchDateRequest,
  ChunkedUploadInitResponse,
  DirBrowseResponse,
  DuplicateGroup,
  ExportRequest,
  FamilyUser,
  FolderPrivacyListResponse,
  FolderPrivacyRuleItem,
  ImportResult,
  Library,
  LibraryFolderTree,
  LibraryStats,
  LocalExportResult,
  LocalImportPreview,
  LocationsSummaryResponse,
  MediaDetail,
  MediaFilterParams,
  MediaItem,
  MediaType,
  MemoriesResponse,
  MoveToFolderResult,
  NetworkInfo,
  PersonSummary,
  PublicShareResponse,
  PurgeRequest,
  PurgeResult,
  RotateMediaResult,
  SemanticSearchResponse,
  ShareItem,
  SimilarGroup,
  SmartAlbum,
  StorageBreakdownResponse,
  SystemInfo,
  TagItem,
  TimelineBucketsResponse,
  UserRole,
} from './types';

export class ApiHttpError extends Error {
  status: number;
  authRequired: boolean;
  constructor(message: string, status: number, authRequired = false) {
    super(message);
    this.status = status;
    this.authRequired = authRequired;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    let authRequired = false;
    try {
      const data = (await res.json()) as {
        error?: string;
        authRequired?: boolean;
      };
      if (data?.error) msg = data.error;
      if (data?.authRequired) authRequired = true;
    } catch {
      // ignore non-json
    }
    throw new ApiHttpError(msg, res.status, authRequired);
  }
  return (await res.json()) as T;
}

export async function apiGet<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, credentials: 'same-origin' });
  return handleResponse<T>(res);
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers:
      body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  return handleResponse<T>(res);
}

export async function apiPatch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  return handleResponse<T>(res);
}

export async function apiPut<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  return handleResponse<T>(res);
}

export async function apiDelete<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'DELETE',
    headers:
      body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  return handleResponse<T>(res);
}

export function buildFilterQuery(filter: MediaFilterParams): string {
  const qs = new URLSearchParams();
  if (filter.mediaType) qs.set('type', filter.mediaType);
  if (filter.favoriteOnly) qs.set('favorite', '1');
  if (filter.inboxOnly) qs.set('inbox', '1');
  if (filter.trashedOnly) qs.set('trashed', '1');
  if (filter.screenshotsOnly) qs.set('screenshots', '1');
  if (filter.rawOnly) qs.set('rawOnly', '1');
  if (filter.hasLivePhotoOnly) qs.set('hasLivePhotoOnly', '1');
  if (filter.minRating) qs.set('minRating', String(filter.minRating));
  if (filter.minFileSizeBytes) {
    qs.set('minFileSizeBytes', String(filter.minFileSizeBytes));
  }
  if (filter.maxFileSizeBytes) {
    qs.set('maxFileSizeBytes', String(filter.maxFileSizeBytes));
  }
  if (filter.recentDays) qs.set('recentDays', String(filter.recentDays));
  if (filter.albumId !== undefined) qs.set('albumId', String(filter.albumId));
  if (filter.includeSubAlbums === false) qs.set('includeSubAlbums', '0');
  if (filter.tagPath) qs.set('tagPath', filter.tagPath);
  if (filter.location) qs.set('location', filter.location);
  if (
    filter.minLat !== undefined &&
    filter.maxLat !== undefined &&
    filter.minLng !== undefined &&
    filter.maxLng !== undefined
  ) {
    qs.set('minLat', filter.minLat.toFixed(6));
    qs.set('maxLat', filter.maxLat.toFixed(6));
    qs.set('minLng', filter.minLng.toFixed(6));
    qs.set('maxLng', filter.maxLng.toFixed(6));
  }
  if (filter.dateFrom) qs.set('dateFrom', filter.dateFrom);
  if (filter.dateTo) qs.set('dateTo', filter.dateTo);
  if (filter.libraryId !== undefined)
    qs.set('libraryId', String(filter.libraryId));
  if (filter.folderPath !== undefined) qs.set('folderPath', filter.folderPath);
  if (filter.includeSubfolders) qs.set('includeSubfolders', '1');
  if (filter.search) qs.set('search', filter.search);
  if (filter.personId) qs.set('personId', String(filter.personId));
  const str = qs.toString();
  return str ? `?${str}` : '';
}

export const api = {
  getAuthStatus: () => apiGet<AuthStatusResponse>('/api/auth/status'),
  loginAdmin: (passcode: string, username?: string) =>
    apiPost<{ ok: boolean; status: AuthStatusResponse }>('/api/auth/login', {
      passcode,
      ...(username?.trim() ? { username: username.trim() } : {}),
    }),
  logoutAdmin: () =>
    apiPost<{ ok: boolean; status: AuthStatusResponse }>('/api/auth/logout'),
  updateAdminPasscode: (payload: {
    newPasscode?: string | null;
    requireOnLoopback?: boolean;
    currentPasscode?: string;
  }) =>
    apiPost<{ ok: boolean; status: AuthStatusResponse }>(
      '/api/auth/passcode',
      payload,
    ),
  getUsers: () => apiGet<{ users: FamilyUser[] }>('/api/users'),
  createUser: (payload: {
    username: string;
    displayName: string;
    role: UserRole;
    passcode: string;
    allowedLibraryIds?: number[] | null;
  }) => apiPost<{ user: FamilyUser }>('/api/users', payload),
  updateUser: (
    id: number,
    patch: {
      displayName?: string;
      role?: UserRole;
      passcode?: string;
      allowedLibraryIds?: number[] | null;
      isActive?: boolean;
    },
  ) => apiPatch<{ user: FamilyUser }>(`/api/users/${id}`, patch),
  deleteUser: (id: number) => apiDelete<{ ok: boolean }>(`/api/users/${id}`),

  getSystemInfo: () => apiGet<SystemInfo>('/api/system/info'),
  getNetworkInfo: () => apiGet<NetworkInfo>('/api/system/network'),
  browseDirs: (dirPath?: string) =>
    apiGet<DirBrowseResponse>(
      `/api/system/browse-dirs${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''}`,
    ),

  getLibraries: () => apiGet<{ libraries: Library[] }>('/api/libraries'),
  addLibrary: (rootPath: string, name?: string) =>
    apiPost<{ library: Library }>('/api/libraries', { rootPath, name }),
  deleteLibrary: (id: number) =>
    apiDelete<{ ok: boolean }>(`/api/libraries/${id}`),
  scanLibrary: (id: number, forcePrune = false) =>
    apiPost<{ ok: boolean }>(
      `/api/libraries/${id}/scan${forcePrune ? '?forcePrune=1' : ''}`,
    ),
  scanAll: () => apiPost<{ ok: boolean }>('/api/libraries/scan-all'),

  getTimelineBuckets: (filter: MediaFilterParams, signal?: AbortSignal) =>
    apiGet<TimelineBucketsResponse>(
      `/api/timeline/buckets${buildFilterQuery(filter)}`,
      signal,
    ),
  getBucketMedia: (
    bucket: string, filter: MediaFilterParams, signal?: AbortSignal,
    page: { offset?: number; cursor?: string; direction?: 'prev' | 'next' } = {},
  ) => {
    const params = new URLSearchParams(buildFilterQuery(filter));
    for (const [key, value] of Object.entries(page)) params.set(key, String(value));
    return apiGet<{ bucket: string; items: MediaItem[]; nextCursor: string | null }>(
      `/api/timeline/bucket/${encodeURIComponent(bucket)}?${params}`, signal);
  },
  getBucketIds: async (bucket: string, filter: MediaFilterParams, signal?: AbortSignal) => {
    const params = new URLSearchParams(buildFilterQuery(filter));
    params.set('idsOnly', '1');
    params.set('limit', '512');
    const ids: number[] = [];
    let cursor: string | null = null;
    do {
      if (cursor) params.set('cursor', cursor);
      const page = await apiGet<{ ids: number[]; nextCursor: string | null }>(
        `/api/timeline/bucket/${encodeURIComponent(bucket)}?${params}`, signal);
      ids.push(...page.ids);
      cursor = page.nextCursor;
    } while (cursor);
    return ids;
  },
  getDuplicates: () =>
    apiGet<{ groups: DuplicateGroup[] }>('/api/timeline/duplicates'),
  getSimilar: (maxDistance = 8) =>
    apiGet<{ groups: SimilarGroup[]; missingPhashCount: number }>(
      `/api/timeline/similar?maxDistance=${maxDistance}`,
    ),
  getSimilarGroups: (maxDistance = 8) =>
    apiGet<{ groups: SimilarGroup[]; missingPhashCount: number }>(
      `/api/timeline/similar?maxDistance=${maxDistance}`,
    ),
  getMemories: () => apiGet<MemoriesResponse>('/api/timeline/memories'),
  getLocations: () =>
    apiGet<LocationsSummaryResponse>('/api/timeline/locations'),
  getStorage: (params?: {
    type?: MediaType;
    minMb?: number;
    screenshots?: boolean;
    rawOnly?: boolean;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.type) qs.set('type', params.type);
    if (params?.minMb) qs.set('minMb', String(params.minMb));
    if (params?.screenshots) qs.set('screenshots', '1');
    if (params?.rawOnly) qs.set('rawOnly', '1');
    if (params?.limit) qs.set('limit', String(params.limit));
    const str = qs.toString();
    return apiGet<StorageBreakdownResponse>(
      `/api/timeline/storage${str ? `?${str}` : ''}`,
    );
  },

  getMediaDetail: (id: number) => apiGet<MediaDetail>(`/api/media/${id}`),
  updateMedia: (
    id: number,
    patch: {
      isFavorite?: boolean;
      rating?: number;
      notes?: string | null;
      takenAt?: string;
    },
  ) => apiPatch<MediaDetail>(`/api/media/${id}`, patch),
  batchMedia: (req: BatchActionRequest) =>
    apiPost<{ ok: boolean; affected: number; stats: LibraryStats }>(
      '/api/media/batch',
      req,
    ),
  batchDate: (req: BatchDateRequest) =>
    apiPost<{ ok: boolean; affected: number }>('/api/media/batch-date', req),
  rotateMedia: (id: number, angle: 90 | 180 | 270) =>
    apiPost<RotateMediaResult>(`/api/media/${id}/rotate`, { angle }),
  purgeMedia: (req: PurgeRequest) =>
    apiPost<PurgeResult>('/api/media/purge', req),

  getSmartAlbums: () =>
    apiGet<{ smartAlbums: SmartAlbum[] }>('/api/smart-albums'),
  createSmartAlbum: (payload: {
    name: string;
    icon?: string;
    filter: MediaFilterParams;
  }) =>
    apiPost<{ id: number; smartAlbums: SmartAlbum[] }>(
      '/api/smart-albums',
      payload,
    ),
  updateSmartAlbum: (
    id: number,
    payload: { name?: string; icon?: string; filter?: MediaFilterParams },
  ) =>
    apiPatch<{ smartAlbums: SmartAlbum[] }>(`/api/smart-albums/${id}`, payload),
  deleteSmartAlbum: (id: number) =>
    apiDelete<{ ok: boolean; smartAlbums: SmartAlbum[] }>(
      `/api/smart-albums/${id}`,
    ),

  getAlbums: () => apiGet<{ albums: AlbumNode[] }>('/api/albums'),
  createAlbum: (name: string, parentId?: number | null, description?: string) =>
    apiPost<{ id: number; albums: AlbumNode[] }>('/api/albums', {
      name,
      parentId,
      description,
    }),
  updateAlbum: (
    id: number,
    patch: {
      name?: string;
      parentId?: number | null;
      coverMediaId?: number | null;
    },
  ) => apiPatch<{ albums: AlbumNode[] }>(`/api/albums/${id}`, patch),
  deleteAlbum: (id: number) =>
    apiDelete<{ ok: boolean; albums: AlbumNode[] }>(`/api/albums/${id}`),
  addAlbumMedia: (albumId: number, mediaIds: number[]) =>
    apiPost<{ ok: boolean; albums: AlbumNode[] }>(
      `/api/albums/${albumId}/media`,
      { mediaIds },
    ),
  removeAlbumMedia: (albumId: number, mediaIds: number[]) =>
    apiDelete<{ ok: boolean; albums: AlbumNode[] }>(
      `/api/albums/${albumId}/media`,
      { mediaIds },
    ),

  getTags: () => apiGet<{ tags: TagItem[] }>('/api/tags'),
  createTag: (path: string, color?: string | null) =>
    apiPost<{ id: number; tags: TagItem[] }>('/api/tags', { path, color }),
  updateTag: (id: number, patch: { path?: string; color?: string | null }) =>
    apiPatch<{ tags: TagItem[] }>(`/api/tags/${id}`, patch),
  deleteTag: (id: number) =>
    apiDelete<{ ok: boolean; tags: TagItem[] }>(`/api/tags/${id}`),

  getShares: () => apiGet<{ shares: ShareItem[] }>('/api/shares'),
  createShare: (payload: {
    title?: string;
    shareType: 'album' | 'selection' | 'folder';
    albumId?: number;
    libraryId?: number;
    folderPath?: string;
    mediaIds?: number[];
    passcode?: string;
    allowDownload?: boolean;
    stripExif?: boolean;
    expiresInHours?: number | null;
  }) => apiPost<{ share: ShareItem }>('/api/shares', payload),
  deleteShare: (id: number) => apiDelete<{ ok: boolean }>(`/api/shares/${id}`),

  getFolderAlbumTree: () =>
    apiGet<{ libraries: LibraryFolderTree[] }>('/api/folder-albums/tree'),
  createFolderAlbum: (libraryId: number, parentPath: string, name: string) =>
    apiPost<{
      libraryId: number;
      folderPath: string;
      libraries: LibraryFolderTree[];
    }>('/api/folder-albums/create', { libraryId, parentPath, name }),
  renameFolderAlbum: (
    libraryId: number,
    folderPath: string,
    newName: string,
  ) =>
    apiPost<{ folderPath: string; libraries: LibraryFolderTree[] }>(
      '/api/folder-albums/rename',
      { libraryId, folderPath, newName },
    ),
  moveFolderAlbum: (
    libraryId: number,
    folderPath: string,
    targetLibraryId: number,
    targetParentPath: string,
  ) =>
    apiPost<{
      libraryId: number;
      folderPath: string;
      libraries: LibraryFolderTree[];
    }>('/api/folder-albums/move-folder', {
      libraryId,
      folderPath,
      targetLibraryId,
      targetParentPath,
    }),
  setFolderAlbumCover: (
    libraryId: number,
    folderPath: string,
    coverMediaId: number | null,
  ) =>
    apiPost<{ ok: boolean; libraries: LibraryFolderTree[] }>(
      '/api/folder-albums/cover',
      { libraryId, folderPath, coverMediaId },
    ),
  deleteFolderAlbum: (
    libraryId: number,
    folderPath: string,
    mode: 'empty_only' | 'trash_contents',
  ) =>
    apiPost<{
      trashedMediaCount: number;
      removedDir: boolean;
      libraries: LibraryFolderTree[];
      stats: LibraryStats;
    }>('/api/folder-albums/delete', { libraryId, folderPath, mode }),
  moveMediaToFolder: (
    mediaIds: number[],
    targetLibraryId: number,
    targetFolderPath: string,
    mode: 'move' | 'copy' = 'move',
  ) =>
    apiPost<
      MoveToFolderResult & {
        libraries: LibraryFolderTree[];
        stats: LibraryStats;
      }
    >('/api/media/move-to-folder', {
      mediaIds,
      targetLibraryId,
      targetFolderPath,
      mode,
    }),

  uploadImport: (formData: FormData): Promise<ImportResult & { stats: LibraryStats }> =>
    api.uploadImportWithProgress(formData),

  uploadImportWithProgress: (
    formData: FormData,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<ImportResult & { stats: LibraryStats }> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/import/upload');
      xhr.withCredentials = true;

      if (onProgress) {
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            onProgress(ev.loaded, ev.total);
          }
        };
      }

      xhr.onload = () => {
        try {
          const parsed = JSON.parse(xhr.responseText || '{}');
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(parsed as ImportResult & { stats: LibraryStats });
          } else {
            reject(
              new ApiHttpError(
                parsed?.error || `上传失败 (${xhr.status})`,
                xhr.status,
              ),
            );
          }
        } catch {
          reject(new Error(`解析上传响应失败 (${xhr.status})`));
        }
      };

      xhr.onerror = () => reject(new Error('网络中断，上传失败'));
      xhr.send(formData);
    });
  },

  previewLocalImport: (sourcePath: string) =>
    apiPost<LocalImportPreview>('/api/import/local/preview', { sourcePath }),
  executeLocalImport: (payload: {
    sourcePath: string;
    targetLibraryId: number;
    targetFolderPath: string;
    structureMode: 'flat' | 'preserve' | 'by_month';
    transferMode: 'copy' | 'move';
    skipDuplicates: boolean;
  }) =>
    apiPost<ImportResult & { stats: LibraryStats }>(
      '/api/import/local/execute',
      payload,
    ),

  prepareZipExport: (payload: ExportRequest) =>
    apiPost<{ jobId: string; downloadUrl: string; count: number; warnings: string[] }>(
      '/api/export/prepare',
      payload,
    ),
  executeLocalExport: (payload: ExportRequest) =>
    apiPost<LocalExportResult>('/api/export/local', payload),

  getPublicShare: (token: string) =>
    apiGet<PublicShareResponse>(
      `/api/public/shares/${encodeURIComponent(token)}`,
    ),
  unlockPublicShare: (token: string, passcode: string) =>
    apiPost<{ unlocked: boolean }>(
      `/api/public/shares/${encodeURIComponent(token)}/unlock`,
      { passcode },
    ),

  getAiStatus: () => apiGet<AiStatusResponse>('/api/ai/status'),
  updateAiSettings: (patch: {
    hfMirror?: 'official' | 'mirror';
    ocrScope?: 'screenshots' | 'all';
  }) => apiPatch<AiStatusResponse>('/api/ai/settings', patch),
  downloadClipModel: () =>
    apiPost<AiStatusResponse>('/api/ai/models/clip/download', {}),
  clearClipModelCache: () =>
    apiDelete<AiStatusResponse>('/api/ai/models/clip/cache'),
  startAiTask: (task: AiTaskKey | 'all', reindex = false) =>
    apiPost<AiStatusResponse>('/api/ai/start', { task, reindex }),
  stopAiTask: (task: AiTaskKey | 'all') =>
    apiPost<AiStatusResponse>('/api/ai/stop', { task }),
  semanticSearch: (q: string, limit = 60) =>
    apiGet<SemanticSearchResponse>(
      `/api/ai/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  findSimilarVisual: (mediaId: number, limit = 30) =>
    apiGet<SemanticSearchResponse>(
      `/api/ai/similar-visual/${mediaId}?limit=${limit}`,
    ),

  getPeople: (includeHidden = false) =>
    apiGet<{ people: PersonSummary[] }>(
      `/api/people?includeHidden=${includeHidden ? '1' : '0'}`,
    ),
  updatePerson: (
    id: number,
    patch: { name?: string | null; coverFaceId?: number; isHidden?: boolean },
  ) => apiPatch<{ person: PersonSummary }>(`/api/people/${id}`, patch),
  mergePeople: (sourcePersonIds: number[], targetPersonId: number) =>
    apiPost<{ ok: boolean; people: PersonSummary[] }>('/api/people/merge', {
      sourcePersonIds,
      targetPersonId,
    }),
  reclusterPeople: (threshold?: number) =>
    apiPost<{
      assignedFaces: number;
      newPeople: number;
      people: PersonSummary[];
    }>('/api/people/recluster', { threshold }),
  reassignFace: (
    faceId: number,
    payload: { personId?: number | null; newPersonName?: string },
  ) =>
    apiPost<{
      ok: boolean;
      personId: number;
      mediaId: number;
      people: PersonSummary[];
    }>(`/api/faces/${faceId}/reassign`, payload),

  initChunkedUpload: (payload: {
    sourceKey?: string;
    filename: string;
    fileSize: number;
    mtimeMs?: number;
    libraryId?: number;
    targetFolderPath?: string;
    organizeByMonth?: boolean;
    skipDuplicates?: boolean;
    chunkSize?: number;
    chunkHashes: string[];
  }) => apiPost<ChunkedUploadInitResponse>('/api/import/chunked/init', payload),

  uploadChunk: async (uploadId: string, chunkIndex: number, blob: Blob) => {
    const res = await fetch(
      `/api/import/chunked/${encodeURIComponent(uploadId)}/${chunkIndex}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
        credentials: 'same-origin',
      },
    );
    return handleResponse<{ ok: boolean; chunkIndex: number; receivedBytes: number }>(
      res,
    );
  },

  completeChunkedUpload: (uploadId: string, companionId?: string, operationId?: string) =>
    apiPost<ImportResult & { stats: LibraryStats }>(
      `/api/import/chunked/${encodeURIComponent(uploadId)}/complete`,
      { companionId, operationId },
    ),

  getBackupSummary: () => apiGet<BackupSummaryResponse>('/api/backup/summary'),
  getBackupProgress: () => apiGet<BackupProgress>('/api/backup/progress'),
  cancelBackup: () => apiPost<{ ok: boolean }>('/api/backup/cancel', {}),
  createBackup: () =>
    apiPost<{ backup: BackupArchiveItem; summary: BackupSummaryResponse }>(
      '/api/backup/create',
      {},
    ),
  deleteBackup: (filename: string) =>
    apiDelete<{ ok: boolean; summary: BackupSummaryResponse }>(
      `/api/backup/${encodeURIComponent(filename)}`,
    ),
  restoreBackupByFilename: (filename: string) =>
    apiPost<BackupRestoreResult>('/api/backup/restore', {
      filename,
      confirm: true,
    }),
  restoreBackupFromFile: async (file: File) => {
    const fd = new FormData();
    fd.append('confirm', '1');
    fd.append('file', file, file.name);
    const res = await fetch('/api/backup/restore', {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
    });
    return handleResponse<BackupRestoreResult>(res);
  },

  getFolderPrivacyRules: () =>
    apiGet<FolderPrivacyListResponse>('/api/folder-privacy/rules'),

  updateFolderPrivacyRule: (payload: {
    libraryId: number;
    folderPath?: string;
    isExcluded?: boolean;
    lockAction?: 'set' | 'change' | 'remove';
    currentPasscode?: string;
    newPasscode?: string;
    forceAdminReset?: boolean;
  }) =>
    apiPut<{
      ok: boolean;
      rules: FolderPrivacyRuleItem[];
      unlockedCount: number;
      libraries: LibraryFolderTree[];
    }>('/api/folder-privacy/rule', payload),

  unlockFolder: (libraryId: number, folderPath: string, passcode: string) =>
    apiPost<{
      ok: boolean;
      unlocked: boolean;
      nextLockedBy?: { libraryId: number; folderPath: string } | null;
      libraries: LibraryFolderTree[];
    }>('/api/folder-privacy/unlock', { libraryId, folderPath, passcode }),

  lockFolder: (payload?: {
    libraryId?: number;
    folderPath?: string;
    all?: boolean;
  }) =>
    apiPost<{ ok: boolean; libraries: LibraryFolderTree[] }>(
      '/api/folder-privacy/lock',
      payload ?? { all: true },
    ),
};
