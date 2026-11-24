export type * from '../../../server/src/types';

export type NavSection =
  | 'all'
  | 'inbox'
  | 'favorites'
  | 'folderAlbum'
  | 'album'
  | 'smartAlbum'
  | 'map'
  | 'people'
  | 'semantic'
  | 'storage'
  | 'tag'
  | 'duplicates'
  | 'trash';

export interface ActiveFolderSelection {
  libraryId: number;
  folderPath: string; // '' for library root
}

export type GridDensity = 'compact' | 'standard' | 'comfortable';
