import { useEffect, useRef } from 'react';
import type { ActiveFolderSelection, NavSection } from '../lib/types';

interface NavHistoryState {
  luminaNav: true;
  section: NavSection;
  activeFolder: ActiveFolderSelection | null;
  activeAlbumId: number | null;
  activeSmartAlbumId: number | null;
  activePersonId: number | null;
  activeTagPath: string | null;
  lightboxOpen: boolean;
}

interface UseNavHistoryParams {
  section: NavSection;
  activeFolder: ActiveFolderSelection | null;
  activeAlbumId: number | null;
  activeSmartAlbumId: number | null;
  activePersonId: number | null;
  activeTagPath: string | null;
  lightboxOpen: boolean;
  onRestoreState: (state: {
    section?: NavSection;
    activeFolder: ActiveFolderSelection | null;
    activeAlbumId: number | null;
    activeSmartAlbumId: number | null;
    activePersonId: number | null;
    activeTagPath: string | null;
    closeLightbox: boolean;
  }) => void;
}

export function useNavHistory({
  section,
  activeFolder,
  activeAlbumId,
  activeSmartAlbumId,
  activePersonId,
  activeTagPath,
  lightboxOpen,
  onRestoreState,
}: UseNavHistoryParams): void {
  const suppressPushRef = useRef(false);
  const onRestoreRef = useRef(onRestoreState);
  onRestoreRef.current = onRestoreState;

  useEffect(() => {
    if (suppressPushRef.current) {
      suppressPushRef.current = false;
      return;
    }
    const nextState: NavHistoryState = {
      luminaNav: true,
      section,
      activeFolder,
      activeAlbumId,
      activeSmartAlbumId,
      activePersonId,
      activeTagPath,
      lightboxOpen,
    };
    const cur = window.history.state as Partial<NavHistoryState> | null;
    if (!cur?.luminaNav) {
      window.history.replaceState(nextState, '');
      return;
    }
    const isSame =
      cur.section === nextState.section &&
      cur.activeFolder?.libraryId === nextState.activeFolder?.libraryId &&
      cur.activeFolder?.folderPath === nextState.activeFolder?.folderPath &&
      cur.activeAlbumId === nextState.activeAlbumId &&
      cur.activeSmartAlbumId === nextState.activeSmartAlbumId &&
      cur.activePersonId === nextState.activePersonId &&
      cur.activeTagPath === nextState.activeTagPath &&
      cur.lightboxOpen === nextState.lightboxOpen;
    if (!isSame) {
      window.history.pushState(nextState, '');
    }
  }, [
    section,
    activeFolder,
    activeAlbumId,
    activeSmartAlbumId,
    activePersonId,
    activeTagPath,
    lightboxOpen,
  ]);

  useEffect(() => {
    const onPopState = (ev: PopStateEvent) => {
      const st = ev.state as Partial<NavHistoryState> | null;
      if (!st?.luminaNav) return;
      suppressPushRef.current = true;
      onRestoreRef.current({
        section: st.section,
        activeFolder: st.activeFolder ?? null,
        activeAlbumId: st.activeAlbumId ?? null,
        activeSmartAlbumId: st.activeSmartAlbumId ?? null,
        activePersonId: st.activePersonId ?? null,
        activeTagPath: st.activeTagPath ?? null,
        closeLightbox: !st.lightboxOpen,
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
}
