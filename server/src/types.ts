export type MediaType = 'photo' | 'video';

export type UserRole = 'admin' | 'member' | 'viewer';

export interface FamilyUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  allowedLibraryIds: number[] | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthStatusResponse {
  authRequired: boolean;
  authenticated: boolean;
  hasPasscode: boolean;
  hasUsers?: boolean;
  isLoopback: boolean;
  requireOnLoopback: boolean;
  envManaged: boolean;
  currentUser?: {
    id: number | null;
    username: string;
    displayName: string;
    role: UserRole;
    allowedLibraryIds: number[] | null;
  } | null;
}

export interface Library {
  id: number;
  name: string;
  rootPath: string;
  isReadonly: boolean;
  isOnline?: boolean;
  missingCount?: number;
  lastScanAt: string | null;
  createdAt: string;
  itemCount: number;
  totalBytes: number;
}

export interface MediaItem {
  id: number;
  libraryId: number;
  filename: string;
  mediaType: MediaType;
  width: number;
  height: number;
  durationMs: number | null;
  takenAt: string;
  takenAtTs: number;
  monthBucket: string;
  dayBucket: string;
  thumbhash: string | null;
  thumbReady: boolean;
  isMissing?: boolean;
  hasLivePhoto: boolean;
  isFavorite: boolean;
  rating: number;
  isOrganized: boolean;
  isScreenshot: boolean;
  fileSize: number;
  mtimeMs?: number;
  locationName?: string | null;
  deletedAt: string | null;
}

export interface MediaAlbumRef {
  id: number;
  name: string;
}

export interface MediaTagRef {
  id: number;
  path: string;
  color: string | null;
}

export interface MediaDetail extends MediaItem {
  relPath: string;
  folderPath: string;
  ext: string;
  mimeType: string;
  timeSource: string;
  orientation: number;
  phash?: string | null;
  livePhotoRelPath: string | null;
  livePhotoSize: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  focalLength: string | null;
  aperture: string | null;
  shutterSpeed: string | null;
  iso: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  locationName: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  albums: MediaAlbumRef[];
  tags: MediaTagRef[];
  ocrText?: string | null;
  hasEmbedding?: boolean;
  faces?: MediaFaceItem[];
}

export interface TimelineBucket {
  bucket: string; // YYYY-MM
  count: number;
  photoCount: number;
  videoCount: number;
  latestTakenAtTs: number;
  earliestTakenAtTs: number;
}

export interface TimelineBucketsResponse {
  totalCount: number;
  buckets: TimelineBucket[];
  locked?: boolean;
  lockedBy?: {
    libraryId: number;
    folderPath: string;
  } | null;
}

export interface MediaFilterParams {
  mediaType?: MediaType;
  favoriteOnly?: boolean;
  inboxOnly?: boolean;
  minRating?: number;
  albumId?: number;
  includeSubAlbums?: boolean;
  tagPath?: string;
  libraryId?: number;
  folderPath?: string;
  includeSubfolders?: boolean;
  search?: string;
  trashedOnly?: boolean;
  screenshotsOnly?: boolean;
  minFileSizeBytes?: number;
  maxFileSizeBytes?: number;
  rawOnly?: boolean;
  hasLivePhotoOnly?: boolean;
  location?: string;
  minLat?: number;
  maxLat?: number;
  minLng?: number;
  maxLng?: number;
  dateFrom?: string;
  dateTo?: string;
  recentDays?: number;
  personId?: number;
  allowedLibraryIds?: number[];
  unlockedFolderKeys?: string[];
}

export interface FolderEntry {
  name: string;
  folderPath: string;
  itemCount: number;
  coverMediaId: number | null;
}

export interface FoldersResponse {
  libraryId: number;
  libraryName: string;
  currentPath: string;
  folders: FolderEntry[];
  directMediaCount: number;
}

export interface AlbumNode {
  id: number;
  name: string;
  description: string | null;
  parentId: number | null;
  coverMediaId: number | null;
  sortOrder: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  children: AlbumNode[];
}

export interface TagItem {
  id: number;
  path: string;
  color: string | null;
  itemCount: number;
  createdAt: string;
}

export interface ShareItem {
  id: number;
  token: string;
  title: string;
  shareType: 'album' | 'selection' | 'folder';
  albumId: number | null;
  libraryId?: number | null;
  folderPath?: string | null;
  hasPasscode: boolean;
  allowDownload: boolean;
  stripExif?: boolean;
  expiresAt: string | null;
  createdAt: string;
  itemCount: number;
  sharePath: string;
  qrSvg?: string;
  qrBaseUrl?: string;
}

export interface PublicShareResponse {
  token: string;
  title: string;
  shareType: 'album' | 'selection' | 'folder';
  requiresPasscode: boolean;
  unlocked: boolean;
  allowDownload: boolean;
  stripExif?: boolean;
  expiresAt: string | null;
  itemCount: number;
  items: MediaItem[];
}

export interface ScanProgressEvent {
  status: 'idle' | 'scanning' | 'thumbnails';
  libraryId: number | null;
  libraryName: string | null;
  scannedFiles: number;
  newFiles: number;
  updatedFiles: number;
  removedFiles: number;
  relocatedFiles?: number;
  thumbnailsDone: number;
  thumbnailsTotal: number;
  currentFile: string | null;
  message?: string;
  watchWarnings?: Array<{ libraryId: number; message: string }>;
}

export interface LanAddressInfo {
  interfaceName: string;
  ip: string;
  url: string;
  qrSvg: string;
}

export interface NetworkInfo {
  port: number;
  hostname: string;
  mdnsUrl: string | null;
  localUrl: string | null;
  tlsEnabled: boolean;
  publicUrl: string | null;
  publicQrSvg: string | null;
  lanAddresses: LanAddressInfo[];
  tailscaleAddress?: LanAddressInfo | null;
}

export interface LibraryStats {
  totalMedia: number;
  photoCount: number;
  videoCount: number;
  favoriteCount: number;
  inboxCount: number;
  trashCount: number;
  trashBytes: number;
  totalBytes: number;
}

export interface SystemInfo {
  version: string;
  platform: string;
  arch: string;
  hostname: string;
  dataDir: string;
  stats: LibraryStats;
  scan: ScanProgressEvent;
}

export interface DirBrowseEntry {
  name: string;
  path: string;
  isReadable: boolean;
}

export interface DirBrowseResponse {
  currentPath: string | null;
  parentPath: string | null;
  quickRoots: DirBrowseEntry[];
  entries: DirBrowseEntry[];
}

export interface DuplicateMediaItem extends MediaItem {
  relPath: string;
  folderPath: string;
  libraryName: string;
}

export interface DuplicateGroup {
  quickHash: string;
  fullHash?: string | null;
  fileSize: number;
  count: number;
  items: DuplicateMediaItem[];
}

export interface SimilarGroup {
  groupId: string;
  anchorPhash: string;
  maxDistance: number;
  count: number;
  items: DuplicateMediaItem[];
}

export interface MemoryYearGroup {
  year: number;
  yearsAgo: number;
  dayBucket: string;
  count: number;
  items: MediaItem[];
}

export interface FolderAlbumNode {
  libraryId: number;
  name: string;
  folderPath: string;
  directCount: number;
  totalCount: number;
  coverMediaId: number | null;
  children: FolderAlbumNode[];
  isExcluded?: boolean;
  effectiveExcluded?: boolean;
  isLocked?: boolean;
  effectiveLocked?: boolean;
  isUnlocked?: boolean;
  lockedByPath?: string | null;
}

export interface LibraryFolderTree {
  libraryId: number;
  libraryName: string;
  rootPath: string;
  totalCount: number;
  directCount: number;
  children: FolderAlbumNode[];
  isExcluded?: boolean;
  isLocked?: boolean;
  isUnlocked?: boolean;
}

export interface FolderPrivacyRuleItem {
  libraryId: number;
  libraryName: string;
  folderPath: string;
  isExcluded: boolean;
  isLocked: boolean;
  isUnlocked: boolean;
  lockUpdatedAt: string | null;
  updatedAt: string;
}

export interface FolderPrivacyListResponse {
  rules: FolderPrivacyRuleItem[];
  unlockedCount: number;
}

export interface ImportDuplicateInfo {
  filename: string;
  sourcePath?: string;
  fileSize: number;
  existingMediaId: number;
  existingLibrary: string;
  existingPath: string;
}

export interface LocalImportPreview {
  sourcePath: string;
  totalFiles: number;
  newFilesCount: number;
  newFilesBytes: number;
  duplicateCount: number;
  duplicateBytes: number;
  unsupportedCount: number;
  unsupportedFiles: string[];
  errors: string[];
  duplicates: ImportDuplicateInfo[];
  sampleNewFiles: Array<{
    relPath: string;
    filename: string;
    fileSize: number;
    mediaType: MediaType;
  }>;
}

export interface ImportResult {
  totalScanned: number;
  importedCount: number;
  duplicateCount: number;
  skippedUnsupported: number;
  unsupportedFiles: string[];
  errorCount: number;
  importedBytes: number;
  duplicates: ImportDuplicateInfo[];
  errors: string[];
}

export interface MoveToFolderResult {
  movedCount: number;
  copiedCount: number;
  skippedCount: number;
  errors: string[];
}

export type ExportQuality = 'original' | 'high' | 'medium';

export interface ExportRequest {
  scope: 'selection' | 'folder' | 'filter';
  mediaIds?: number[];
  libraryId?: number;
  folderPath?: string;
  includeSubfolders?: boolean;
  filter?: MediaFilterParams;
  quality: ExportQuality;
  preserveFolders: boolean;
  includeLiveVideo: boolean;
  zipName?: string;
  destPath?: string;
  skipExisting?: boolean;
}

export interface LocalExportResult {
  exportedCount: number;
  skippedExistingCount: number;
  totalBytes: number;
  destPath: string;
  errors: string[];
}

export type BatchActionType =
  | 'favorite'
  | 'unfavorite'
  | 'rate'
  | 'addToAlbum'
  | 'removeFromAlbum'
  | 'addTag'
  | 'removeTag'
  | 'trash'
  | 'restore';

export interface BatchActionRequest {
  mediaIds: number[] | 'all_trashed';
  action: BatchActionType;
  rating?: number;
  albumId?: number;
  tagPath?: string;
}

export interface PurgeRequest {
  mediaIds: number[] | 'all_trashed';
  confirm: boolean;
}

export interface PurgeResult {
  purgedCount: number;
  freedBytes: number;
  errors: string[];
}

export interface MemoriesResponse {
  memories: MemoryYearGroup[];
  isNearbyFallback: boolean;
}

export interface LocationCluster {
  locationName: string;
  count: number;
  avgLat: number | null;
  avgLng: number | null;
  coverMediaId: number | null;
  coverMtimeMs?: number;
  latestTakenAt: string;
}

export interface GpsPointCluster {
  key: string;
  lat: number;
  lng: number;
  count: number;
  locationName: string | null;
  coverMediaId: number | null;
  coverMtimeMs?: number;
}

export interface LocationsSummaryResponse {
  totalWithGps: number;
  totalWithLocation: number;
  totalCities: number;
  cities: LocationCluster[];
  points: GpsPointCluster[];
}

export interface SmartAlbum {
  id: number;
  name: string;
  icon: string;
  filter: MediaFilterParams;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BatchDateRequest {
  mediaIds: number[];
  mode: 'offset' | 'set' | 'keep';
  offsetMinutes?: number;
  takenAt?: string;
  incrementSeconds?: number;
  locationName?: string | null;
}

export interface StorageMediaItem extends MediaItem {
  relPath: string;
  folderPath: string;
  libraryName: string;
  ext: string;
  livePhotoSize: number | null;
}

export interface StorageBreakdownResponse {
  totalBytes: number;
  totalCount: number;
  photoBytes: number;
  photoCount: number;
  videoBytes: number;
  videoCount: number;
  screenshotBytes: number;
  screenshotCount: number;
  rawBytes: number;
  rawCount: number;
  livePhotoBytes: number;
  trashBytes: number;
  trashCount: number;
  byLibrary: Array<{
    libraryId: number;
    name: string;
    totalBytes: number;
    itemCount: number;
  }>;
  largestItems: StorageMediaItem[];
}

export interface RotateMediaResult {
  originalBackup: string;
  media: MediaDetail;
  rotatedAngle: number;
}

export interface MediaFaceItem {
  id: number;
  mediaId: number;
  personId: number | null;
  personName: string | null;
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
  confidence: number;
}

export interface PersonSummary {
  id: number;
  name: string | null;
  displayName: string;
  coverFaceId: number | null;
  faceCount: number;
  mediaCount: number;
  isHidden: boolean;
  sampleFaceIds: number[];
  latestTakenAt: string | null;
}

export type AiTaskKey = 'clip' | 'face' | 'ocr';

export interface AiTaskStatus {
  key: AiTaskKey;
  running: boolean;
  paused: boolean;
  modelLoaded: boolean;
  processed: number;
  total: number;
  pending: number;
  currentFile: string | null;
  lastError: string | null;
  downloadProgress?: number | null;
  downloadMessage?: string | null;
}

export interface ClipModelCacheStatus {
  modelId: string;
  cacheDir: string;
  visionCached: boolean;
  textCached: boolean;
  cached: boolean;
  sizeBytes: number;
  downloading: boolean;
  downloadProgress: number | null;
  downloadMessage: string | null;
  lastError: string | null;
}

export interface AiStatusResponse {
  enabled: boolean;
  hfMirror: 'official' | 'mirror';
  ocrScope: 'screenshots' | 'all';
  modelId: string;
  clipModel: ClipModelCacheStatus;
  totalPhotos: number;
  tasks: {
    clip: AiTaskStatus;
    face: AiTaskStatus;
    ocr: AiTaskStatus;
  };
  peopleCount: number;
  facesCount: number;
  ocrWithTextCount: number;
}

export interface SemanticSearchItem {
  media: MediaItem;
  score: number;
}

export interface SemanticSearchResponse {
  query: string;
  model: string;
  indexedCount: number;
  totalPhotos: number;
  elapsedMs: number;
  items: SemanticSearchItem[];
}

export interface ChunkedUploadInitResponse {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
  uploadedChunks: number[];
}

export interface BackupArchiveItem {
  filename: string;
  sizeBytes: number;
  createdAt: string;
  downloadUrl: string;
}

export interface BackupProgress {
  active: boolean;
  phase: 'preparing' | 'fingerprinting' | 'packing';
  done: number;
  total: number;
}

export interface BackupSummaryResponse {
  dbBytes: number;
  cacheBytes: {
    thumbsSm: number;
    thumbsLg: number;
    faces: number;
    videoPreviews: number;
    aiModels: number;
    total: number;
  };
  counts: {
    totalMedia: number;
    favorites: number;
    rated: number;
    albums: number;
    smartAlbums: number;
    tags: number;
    people: number;
    ocrWithText: number;
    users: number;
  };
  backups: BackupArchiveItem[];
}

export interface BackupRestoreResult {
  ok: boolean;
  restoredMediaMeta: number;
  missingMedia: number;
  ambiguousMedia: number;
  restoredAlbums: number;
  restoredTags: number;
  restoredSmartAlbums: number;
  restoredPeople: number;
  safetyBackupFilename: string;
}
