import { useModalFocus } from '../hooks/useModalFocus';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  CheckCircle2,
  CopyCheck,
  FileUp,
  Folder,
  FolderPlus,
  HardDrive,
  SearchCheck,
  Upload,
  X,
} from 'lucide-react';
import { api, ApiHttpError } from '../lib/api';
import { fingerprintUpload } from '../lib/uploadFingerprint';
import { flattenFolderTrees } from '../lib/folderTree';
import { formatBytes } from '../lib/format';
import type {
  ActiveFolderSelection,
  DirBrowseResponse,
  ImportResult,
  LibraryFolderTree,
  LocalImportPreview,
} from '../lib/types';

interface ImportModalProps {
  open: boolean;
  folderTrees: LibraryFolderTree[];
  defaultTarget?: ActiveFolderSelection | null;
  onClose: () => void;
  onImported: () => void;
  onOpenSetup: () => void;
  isAdmin?: boolean;
}

const droppedPaths = new WeakMap<File, string>();
const sourceKey = (file: File) => droppedPaths.get(file) || file.webkitRelativePath || file.name;

// Recursively traverse dropped folders via FileSystemEntry API
async function extractFilesFromDataTransfer(
  dt: DataTransfer, skipped: string[],
): Promise<File[]> {
  const items = dt.items;
  if (!items || items.length === 0) {
    return Array.from(dt.files);
  }

  interface FsEntry {
    isFile: boolean;
    isDirectory: boolean;
    name: string;
    file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void;
    createReader?: () => {
      readEntries: (
        cb: (entries: FsEntry[]) => void,
        err?: (e: unknown) => void,
      ) => void;
    };
  }

  const entries: FsEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as DataTransferItem & {
      webkitGetAsEntry?: () => FsEntry | null;
    };
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    return Array.from(dt.files);
  }

  const collected: File[] = [];
  const walkEntry = async (entry: FsEntry, prefix = ''): Promise<void> => {
    if (entry.name.startsWith('.')) {
      if (!entry.name.startsWith('._') && entry.name.toLowerCase() !== '.ds_store') {
        skipped.push(prefix + entry.name + (entry.isDirectory ? '/' : ''));
      }
      return;
    }
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((resolve, reject) => {
        entry.file!(resolve, () => reject(new Error(`无法读取文件 ${prefix}${entry.name}`)));
      });
      droppedPaths.set(file, prefix + file.name);
      collected.push(file);
    } else if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader();
      while (true) {
        const batch = await new Promise<FsEntry[]>((resolve, reject) => {
          reader.readEntries(resolve, () => reject(new Error(`无法读取目录 ${prefix}${entry.name}`)));
        });
        if (batch.length === 0) break;
        for (const child of batch) {
          await walkEntry(child, prefix + entry.name + '/');
        }
      }
    }
  };

  for (const e of entries) {
    await walkEntry(e);
  }
  return collected;
}

const UPLOAD_BATCH_FILES = 40;
const CHUNK_THRESHOLD_BYTES = 8 * 1024 * 1024;
const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

function isLargeOrVideoFile(f: File): boolean {
  return (
    f.size >= CHUNK_THRESHOLD_BYTES ||
    f.type.startsWith('video/') ||
    /\.(mp4|mov|m4v|avi|mkv|webm|3gp|mts|m2ts)$/i.test(f.name)
  );
}

export const ImportModal: React.FC<ImportModalProps> = ({
  open,
  folderTrees,
  defaultTarget,
  onClose,
  onImported,
  onOpenSetup,
  isAdmin = true,
}) => {
  const [tab, setTab] = useState<'upload' | 'local'>('upload');

  const flatOptions = useMemo(
    () => flattenFolderTrees(folderTrees),
    [folderTrees],
  );

  const [targetKey, setTargetKey] = useState<string>('');
  const [newSubfolderName, setNewSubfolderName] = useState('');
  const [creatingSub, setCreatingSub] = useState(false);

  // Upload tab state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [skippedDropEntries, setSkippedDropEntries] = useState<string[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [organizeByMonth, setOrganizeByMonth] = useState(false);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    percent: number;
    currentBatch: number;
    totalBatches: number;
  } | null>(null);
  const [uploadResult, setUploadResult] = useState<ImportResult | null>(null);

  // Local folder tab state
  const [browse, setBrowse] = useState<DirBrowseResponse | null>(null);
  const [sourcePath, setSourcePath] = useState('');
  const [preview, setPreview] = useState<LocalImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [structureMode, setStructureMode] = useState<
    'flat' | 'preserve' | 'by_month'
  >('flat');
  const [transferMode, setTransferMode] = useState<'copy' | 'move'>('copy');
  const [executingLocal, setExecutingLocal] = useState(false);
  const [localResult, setLocalResult] = useState<ImportResult | null>(null);
  const [showAllDups, setShowAllDups] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setUploadResult(null);
    setUploadProgress(null);
    setLocalResult(null);
    setPreview(null);
    setShowAllDups(false);
    setSelectedFiles([]);
    setSkippedDropEntries([]);

    if (defaultTarget) {
      setTargetKey(`${defaultTarget.libraryId}::${defaultTarget.folderPath}`);
    } else if (folderTrees[0]) {
      setTargetKey(`${folderTrees[0].libraryId}::`);
    } else {
      setTargetKey('');
    }

    if (!isAdmin) {
      setTab('upload');
    } else {
      api
        .browseDirs()
        .then((res) => {
          setBrowse(res);
          if (res.currentPath) setSourcePath(res.currentPath);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isAdmin]);

  useEffect(() => {
    if (open && !targetKey && folderTrees[0]) {
      setTargetKey(`${folderTrees[0].libraryId}::`);
    }
  }, [open, targetKey, folderTrees]);

  const modalRef = useModalFocus(open);

  if (!open) return null;

  const parseTarget = (): { libraryId: number; folderPath: string } | null => {
    if (!targetKey) return null;
    const idx = targetKey.indexOf('::');
    if (idx === -1) return null;
    return {
      libraryId: Number(targetKey.slice(0, idx)),
      folderPath: targetKey.slice(idx + 2),
    };
  };

  const handleCreateSubfolder = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = parseTarget();
    const name = newSubfolderName.trim();
    if (!target || !name) return;
    setError(null);
    try {
      const res = await api.createFolderAlbum(
        target.libraryId,
        target.folderPath,
        name,
      );
      setTargetKey(`${res.libraryId}::${res.folderPath}`);
      setNewSubfolderName('');
      setCreatingSub(false);
      onImported();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const loadBrowseDir = async (p?: string) => {
    setError(null);
    try {
      const res = await api.browseDirs(p);
      setBrowse(res);
      if (res.currentPath) {
        setSourcePath(res.currentPath);
        setPreview(null);
        setLocalResult(null);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Chunked batch upload with live progress bar (supports 1000+ files without hitting 500-file multipart limits!)
  const handleUploadSubmit = async () => {
    const target = parseTarget();
    if (!target || selectedFiles.length === 0) return;
    setUploading(true);
    setError(null);
    setUploadResult(null);

    const totalBytesAll = Math.max(
      1,
      selectedFiles.reduce((acc, f) => acc + f.size, 0),
    );
    const byStem = new Map<string, File[]>();
    for (const file of selectedFiles) {
      const key = sourceKey(file);
      const split = key.lastIndexOf('/') + 1;
      const stem = key.slice(0, split) + key.slice(split).replace(/\.[^./]+$/, '').toLowerCase();
      const group = byStem.get(stem) ?? [];
      group.push(file);
      byStem.set(stem, group);
    }
    const regularFiles: File[] = [];
    const chunkGroups: File[][] = [];
    for (const group of byStem.values()) {
      const photos = group.filter(f => /\.(jpe?g|heic|heif|png|webp|gif|avif|bmp|tiff?|dng|arw|cr[23]|nef|raf|orf|rw2|pef)$/i.test(f.name));
      const movies = group.filter(f => /\.mov$/i.test(f.name));
      const pair = photos.length === 1 && movies.length === 1 ? [photos[0], movies[0]] : [];
      if (pair.length) chunkGroups.push(pair);
      for (const file of group) {
        if (pair.includes(file)) continue;
        if (isLargeOrVideoFile(file)) chunkGroups.push([file]);
        else regularFiles.push(file);
      }
    }
    const regularBatches = Math.ceil(regularFiles.length / UPLOAD_BATCH_FILES);
    const totalSteps = chunkGroups.length + regularBatches;

    const merged: ImportResult = {
      totalScanned: 0,
      importedCount: 0,
      duplicateCount: 0,
      skippedUnsupported: skippedDropEntries.length,
      unsupportedFiles: skippedDropEntries.slice(0, 100),
      errorCount: 0,
      importedBytes: 0,
      duplicates: [],
      errors: [],
    };

    const mergeResult = (res: ImportResult) => {
      merged.totalScanned += res.totalScanned;
      merged.importedCount += res.importedCount;
      merged.duplicateCount += res.duplicateCount;
      merged.skippedUnsupported += res.skippedUnsupported;
      merged.unsupportedFiles.push(...(res.unsupportedFiles ?? []).slice(0, 100 - merged.unsupportedFiles.length));
      merged.errorCount += res.errorCount;
      merged.importedBytes += res.importedBytes;
      merged.duplicates.push(...res.duplicates);
      merged.errors.push(...res.errors);
    };

    try {
      let completedBytesBefore = 0;
      let stepIdx = 0;

      // 1. Small files via fast multipart batches
      for (let b = 0; b < regularBatches; b++) {
        stepIdx++;
        const slice = regularFiles.slice(
          b * UPLOAD_BATCH_FILES,
          (b + 1) * UPLOAD_BATCH_FILES,
        );
        const batchBytes = slice.reduce((acc, f) => acc + f.size, 0);

        const fd = new FormData();
        fd.append('libraryId', String(target.libraryId));
        fd.append('targetFolderPath', target.folderPath);
        fd.append('organizeByMonth', organizeByMonth ? '1' : '0');
        fd.append('skipDuplicates', skipDuplicates ? '1' : '0');
        for (const f of slice) {
          fd.append('files', f, f.name);
        }

        const res = await api.uploadImportWithProgress(fd, (loaded, total) => {
          const batchFrac = total > 0 ? loaded / total : 0;
          const overallBytes = completedBytesBefore + batchBytes * batchFrac;
          const pct = Math.min(
            99,
            Math.round((overallBytes / totalBytesAll) * 100),
          );
          setUploadProgress({
            percent: pct,
            currentBatch: stepIdx,
            totalBatches: Math.max(1, totalSteps),
          });
        });

        completedBytesBefore += batchBytes;
        mergeResult(res);
      }

      // 2. Large files & videos via 4MB resumable chunked upload with automatic retry
      for (const group of chunkGroups) {
        stepIdx++;
        // A lost completion response can arrive after the server has committed and removed the chunks.
        const manifests = await Promise.all(group.map(file => fingerprintUpload(file, CHUNK_SIZE_BYTES)));
        const receiptKey = 'lumina.upload.v2.' + JSON.stringify([target.libraryId, target.folderPath, organizeByMonth,
          skipDuplicates, group.map((file, i) => [sourceKey(file), file.size, file.lastModified, manifests[i].fingerprint])]);
        let previous: { sessions: string[]; operationId: string } | null = null;
        try { previous = JSON.parse(sessionStorage.getItem(receiptKey) ?? 'null'); } catch { /* Storage may be disabled. */ }
        const forget = () => { try { sessionStorage.removeItem(receiptKey); } catch { /* Optional browser storage. */ } };
        if (previous) {
          try {
            const done = await api.completeChunkedUpload(previous.sessions[0], previous.sessions[1], previous.operationId);
            if (done.errorCount) throw new Error(done.errors.join('、'));
            mergeResult(done);
            completedBytesBefore += group.reduce((n, f) => n + f.size, 0);
            forget();
            continue;
          } catch (err) {
            if (!(err instanceof ApiHttpError) || ![400,403,404].includes(err.status)) throw err;
          }
        }
        const operationId = previous?.operationId ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
          byte => byte.toString(16).padStart(2, '0')).join('');
        const sessions: string[] = [];
        for (const [i, file] of group.entries()) {
          const init = await api.initChunkedUpload({
            filename: file.name,
            sourceKey: sourceKey(file),
            fileSize: file.size,
            mtimeMs: file.lastModified,
            libraryId: target.libraryId,
            targetFolderPath: target.folderPath,
            organizeByMonth,
            skipDuplicates,
            chunkSize: CHUNK_SIZE_BYTES,
            chunkHashes: manifests[i].chunkHashes,
          });
          const uploadedSet = new Set(init.uploadedChunks);

          for (let ci = 0; ci < init.totalChunks; ci++) {
            const start = ci * init.chunkSize;
            const end = Math.min(file.size, start + init.chunkSize);
            if (!uploadedSet.has(ci)) {
              const chunkBlob = file.slice(start, end);
              let lastErr: unknown = null;
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  await api.uploadChunk(init.uploadId, ci, chunkBlob);
                  lastErr = null;
                  break;
                } catch (err) {
                  lastErr = err;
                  await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
                }
              }
              if (lastErr) throw lastErr;
            }
            const pct = Math.min(
              99,
              Math.round(((completedBytesBefore + end) / totalBytesAll) * 100),
            );
            setUploadProgress({
              percent: pct,
              currentBatch: stepIdx,
              totalBatches: Math.max(1, totalSteps),
            });
          }

          sessions.push(init.uploadId);
          completedBytesBefore += file.size;
        }
        try { sessionStorage.setItem(receiptKey, JSON.stringify({ sessions, operationId })); } catch { /* Optional browser storage. */ }
        const res = await api.completeChunkedUpload(sessions[0], sessions[1], operationId);
        mergeResult(res);
        if (!res.errorCount) forget();
      }

      setUploadProgress({
        percent: 100,
        currentBatch: Math.max(1, totalSteps),
        totalBatches: Math.max(1, totalSteps),
      });
      setUploadResult(merged);
      setSelectedFiles([]);
      setSkippedDropEntries([]);
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const handlePreviewLocal = async () => {
    if (!sourcePath.trim()) return;
    setPreviewing(true);
    setError(null);
    setPreview(null);
    setLocalResult(null);
    try {
      const res = await api.previewLocalImport(sourcePath.trim());
      setPreview(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const handleExecuteLocal = async () => {
    const target = parseTarget();
    if (!target || !sourcePath.trim()) return;
    setExecutingLocal(true);
    setError(null);
    try {
      const res = await api.executeLocalImport({
        sourcePath: sourcePath.trim(),
        targetLibraryId: target.libraryId,
        targetFolderPath: target.folderPath,
        structureMode,
        transferMode,
        skipDuplicates,
      });
      setLocalResult(res);
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExecutingLocal(false);
    }
  };

  const renderTargetSelector = () => (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
          导入到目标相册文件夹
        </label>
        <button
          type="button"
          onClick={() => setCreatingSub((v) => !v)}
          className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
        >
          <FolderPlus className="w-3 h-3" />
          新建子相册
        </button>
      </div>
      <select
        value={targetKey}
        onChange={(e) => setTargetKey(e.target.value)}
        className="w-full px-3 py-2 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
      >
        {flatOptions.map((opt) => (
          <option
            key={`${opt.libraryId}::${opt.folderPath}`}
            value={`${opt.libraryId}::${opt.folderPath}`}
          >
            {opt.label}
          </option>
        ))}
      </select>

      {creatingSub && (
        <form onSubmit={handleCreateSubfolder} className="flex gap-1.5">
          <input
            autoFocus
            value={newSubfolderName}
            onChange={(e) => setNewSubfolderName(e.target.value)}
            placeholder="新建相册，如 旅行/京都"
            className="flex-1 px-3 py-1.5 rounded-xl text-xs border border-blue-400 bg-white dark:bg-zinc-900 outline-none"
          />
          <button
            type="submit"
            className="px-3 py-1.5 rounded-xl text-xs bg-blue-600 text-white"
          >
            创建
          </button>
        </form>
      )}
    </div>
  );

  const skippedFiles = (count: number, names: string[] = []) => count > 0 && (
    <details className="text-amber-700 dark:text-amber-300">
      <summary>跳过 {count} 个文件或目录{count > names.length && names.length > 0 ? `（列出前 ${names.length} 个）` : ''}</summary>
      <ul className="max-h-32 overflow-y-auto">{names.map((name, i) => <li key={i}>{name}</li>)}</ul>
    </details>
  );

  const renderResultCard = (res: ImportResult) => (
    <div className={`rounded-2xl border p-4 space-y-2.5 text-xs ${res.errorCount
      ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30'
      : 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-950/30'}`}>
      <div className="flex items-center gap-2 font-semibold">
        {res.errorCount ? <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          : <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
        {res.errorCount ? '导入有遗漏' : '导入完成'}，新增 {res.importedCount} 项（{formatBytes(res.importedBytes)}
        ），自动跳过重复 {res.duplicateCount} 项
      </div>
      {skippedFiles(res.skippedUnsupported, res.unsupportedFiles)}
      {res.duplicates.length > 0 && (
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => setShowAllDups((v) => !v)}
            className="text-[11px] text-emerald-700 dark:text-emerald-300 underline"
          >
            {showAllDups
              ? '收起已跳过重复文件列表'
              : `查看已跳过的 ${res.duplicates.length} 个重复文件位置`}
          </button>
          {showAllDups && (
            <div className="max-h-36 overflow-y-auto rounded-xl bg-white/80 dark:bg-zinc-900/70 p-2 space-y-1 text-[11px]">
              {res.duplicates.map((d, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="truncate font-medium">{d.filename}</span>
                  <span className="text-zinc-500 truncate">
                    已存在于 [{d.existingLibrary}] {d.existingPath}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {res.errors.length > 0 && (
        <div className="text-[11px] text-rose-600">
          {res.errors.map((message, i) => <div key={i}>{message}</div>)}
        </div>
      )}
    </div>
  );

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="导入照片" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <CopyCheck className="w-5 h-5 text-blue-500" />
            <div>
              <h2 className="text-base font-semibold">
                导入照片与视频（自动精确查重）
              </h2>
              <p className="text-xs text-zinc-500">
                导入前自动比对文件指纹与 SHA-256，防止重复占用磁盘空间
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭窗口"
            className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {folderTrees.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <HardDrive className="w-10 h-10 text-zinc-400 mx-auto" />
            <div className="text-sm font-medium">尚未设置本地图库根目录</div>
            <div className="text-xs text-zinc-500">
              请先添加一个图库目录用于存放导入的照片和相册文件夹
            </div>
            {isAdmin && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenSetup();
                }}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-medium"
              >
                去添加图库目录
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Mode Tabs */}
            <div className="px-5 pt-3 border-b border-zinc-200 dark:border-zinc-800 flex gap-2">
              <button
                type="button"
                onClick={() => setTab('upload')}
                className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                  tab === 'upload'
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                上传 / 拖拽文件或文件夹导入
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setTab('local')}
                  className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                    tab === 'local'
                      ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                  }`}
                >
                  <HardDrive className="w-3.5 h-3.5" />
                  本地目录 / SD 卡导入（先扫描查重）
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {renderTargetSelector()}

              {tab === 'upload' ? (
                <div className="space-y-4">
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={async (e) => {
                      e.preventDefault();
                      setDragOver(false);
                      setError(null);
                      setUploadResult(null);
                      try {
                        const skipped: string[] = [];
                        const files = await extractFilesFromDataTransfer(e.dataTransfer, skipped);
                        setSkippedDropEntries(skipped);
                        setSelectedFiles(files);
                      } catch (err) {
                        setSelectedFiles([]);
                        setSkippedDropEntries([]);
                        setError((err as Error).message);
                      }
                    }}
                    onClick={() => fileInputRef.current?.click()}
                    className={`rounded-2xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
                      dragOver
                        ? 'border-blue-500 bg-blue-50/70 dark:bg-blue-950/30'
                        : 'border-zinc-300 dark:border-zinc-700 hover:border-blue-400'
                    }`}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept="image/*,video/*,.heic,.heif,.dng,.arw,.cr2,.cr3,.nef,.raf"
                      className="hidden"
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        setSkippedDropEntries([]);
                        setSelectedFiles(files);
                        setUploadResult(null);
                      }}
                    />
                    <FileUp className="w-8 h-8 text-blue-500 mx-auto mb-2" />
                    <div className="text-sm font-medium">
                      {selectedFiles.length > 0
                        ? `已选择 ${selectedFiles.length} 个文件（共 ${formatBytes(
                            selectedFiles.reduce((a, f) => a + f.size, 0),
                          )}）`
                        : '点击选择照片/视频，或直接拖入文件与整个文件夹'}
                    </div>
                    <div className="text-xs text-zinc-400 mt-1">
                      支持任意数量照片分批上传、大视频 4MB 分片断点续传，并自动跳过重复照片
                    </div>
                  </div>
                  {!uploadResult && skippedFiles(skippedDropEntries.length, skippedDropEntries.slice(0, 100))}

                  {uploading && uploadProgress && (
                    <div className="space-y-1.5 text-xs">
                      <div className="flex items-center justify-between text-blue-600 dark:text-blue-300 font-medium">
                        <span>
                          正在上传并精确查重（批次 {uploadProgress.currentBatch}/
                          {uploadProgress.totalBatches}）...
                        </span>
                        <span className="tabular-nums">
                          {uploadProgress.percent}%
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                        <div
                          className="h-full bg-blue-600 transition-all duration-200"
                          style={{ width: `${uploadProgress.percent}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-4 text-xs">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={skipDuplicates}
                        onChange={(e) => setSkipDuplicates(e.target.checked)}
                      />
                      自动查重并跳过重复文件（推荐）
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={organizeByMonth}
                        onChange={(e) => setOrganizeByMonth(e.target.checked)}
                      />
                      按拍摄年月自动建子目录 (YYYY/YYYY-MM)
                    </label>
                  </div>

                  {uploadResult && renderResultCard(uploadResult)}

                  {error && (
                    <div className="text-xs text-red-500 bg-red-50 dark:bg-red-950/40 px-3 py-2 rounded-xl">
                      {error}
                    </div>
                  )}

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className="px-4 py-2 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700"
                    >
                      关闭
                    </button>
                    <button
                      type="button"
                      disabled={uploading || selectedFiles.length === 0}
                      onClick={() => void handleUploadSubmit()}
                      className="px-5 py-2 rounded-xl text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {uploading ? '正在上传并查重...' : '开始查重并导入'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                      选择要导入的来源文件夹（如 SD 卡、微信导出目录、旧硬盘）
                    </label>
                    {browse && browse.quickRoots.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {browse.quickRoots.map((qr) => (
                          <button
                            key={qr.path}
                            type="button"
                            onClick={() => void loadBrowseDir(qr.path)}
                            className="px-2.5 py-1 rounded-lg text-xs border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          >
                            {qr.name}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-50 dark:bg-zinc-800/70 border-b border-zinc-200 dark:border-zinc-800 text-xs">
                        {browse?.parentPath && (
                          <button
                            type="button"
                            onClick={() =>
                              void loadBrowseDir(browse.parentPath!)
                            }
                            className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <input
                          value={sourcePath}
                          onChange={(e) => {
                            setSourcePath(e.target.value);
                            setPreview(null);
                          }}
                          className="flex-1 bg-transparent font-mono text-[11px] outline-none"
                        />
                      </div>
                      <div className="max-h-36 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800/60">
                        {browse?.entries.map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            disabled={!entry.isReadable}
                            onClick={() => void loadBrowseDir(entry.path)}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                          >
                            <Folder className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                            <span className="truncate">{entry.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div>
                      <label className="block text-zinc-500 mb-1">
                        导入后的文件夹整理方式
                      </label>
                      <select
                        value={structureMode}
                        onChange={(e) =>
                          setStructureMode(
                            e.target.value as 'flat' | 'preserve' | 'by_month',
                          )
                        }
                        className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
                      >
                        <option value="flat">直接放入所选相册文件夹</option>
                        <option value="preserve">
                          保留源目录的子文件夹层级
                        </option>
                        <option value="by_month">
                          按拍摄年月自动分目录 (YYYY/YYYY-MM)
                        </option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-zinc-500 mb-1">
                        文件传输方式
                      </label>
                      <select
                        value={transferMode}
                        onChange={(e) =>
                          setTransferMode(e.target.value as 'copy' | 'move')
                        }
                        className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
                      >
                        <option value="copy">
                          复制导入（保留源文件，安全）
                        </option>
                        <option value="move">
                          移动导入（从源目录移入相册）
                        </option>
                      </select>
                    </div>
                  </div>

                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={skipDuplicates}
                      onChange={(e) => setSkipDuplicates(e.target.checked)}
                    />
                    导入时自动跳过已重复的文件
                  </label>

                  {preview && (
                    <div className="rounded-2xl border border-blue-200 dark:border-blue-500/30 bg-blue-50/70 dark:bg-blue-950/30 p-4 space-y-2 text-xs">
                      <div className="font-semibold text-blue-950 dark:text-blue-200">
                        查重扫描结果：共发现 {preview.totalFiles} 个媒体文件
                      </div>
                      <div className="flex flex-wrap gap-4">
                        <span className="text-emerald-700 dark:text-emerald-300 font-medium">
                          全新文件：{preview.newFilesCount} 项（
                          {formatBytes(preview.newFilesBytes)}）
                        </span>
                        <span className="text-amber-700 dark:text-amber-300 font-medium">
                          已重复文件：{preview.duplicateCount} 项（可省{' '}
                          {formatBytes(preview.duplicateBytes)}）
                        </span>
                      </div>
                      {skippedFiles(preview.unsupportedCount, preview.unsupportedFiles)}
                      {!!preview.errors?.length && <div className="text-rose-600">来源未读取完整
                        {preview.errors.map((message, i) => <div key={i}>{message}</div>)}
                      </div>}
                      {preview.duplicates.length > 0 && (
                        <div className="max-h-32 overflow-y-auto rounded-xl bg-white/80 dark:bg-zinc-900/70 p-2 space-y-1 text-[11px]">
                          {preview.duplicates.map((d, idx) => (
                            <div
                              key={idx}
                              className="flex items-center justify-between gap-2"
                            >
                              <span className="truncate font-medium">
                                {d.sourcePath || d.filename}
                              </span>
                              <span className="text-zinc-500 truncate">
                                重复 → [{d.existingLibrary}] {d.existingPath}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {localResult && renderResultCard(localResult)}

                  {error && (
                    <div className="text-xs text-red-500 bg-red-50 dark:bg-red-950/40 px-3 py-2 rounded-xl">
                      {error}
                    </div>
                  )}

                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className="px-4 py-2 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700"
                    >
                      关闭
                    </button>
                    <button
                      type="button"
                      disabled={previewing || !sourcePath.trim()}
                      onClick={() => void handlePreviewLocal()}
                      className="px-4 py-2 rounded-xl text-xs font-medium border border-blue-500 text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 flex items-center gap-1.5"
                    >
                      <SearchCheck className="w-3.5 h-3.5" />
                      {previewing ? '正在扫描查重...' : '第 1 步：扫描并查重'}
                    </button>
                    <button
                      type="button"
                      disabled={executingLocal || !sourcePath.trim()}
                      onClick={() => void handleExecuteLocal()}
                      className="px-5 py-2 rounded-xl text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {executingLocal ? '正在导入...' : '第 2 步：确认导入'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
