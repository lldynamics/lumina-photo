import type { AuthStatusResponse, UserRole } from './types';

export interface UserPermissions {
  userRole: UserRole;
  isScoped: boolean;
  canEdit: boolean;
  isGlobalAdmin: boolean;
  canShareAlbum: boolean;
}

export function getUserPermissions(
  authStatus: AuthStatusResponse | null | undefined,
): UserPermissions {
  const userRole: UserRole = authStatus?.currentUser?.role ?? 'admin';
  const isScoped = authStatus?.currentUser?.allowedLibraryIds != null;
  const canEdit = userRole !== 'viewer';
  const isGlobalAdmin = userRole === 'admin' && !isScoped;
  const canShareAlbum = canEdit && !isScoped;
  return { userRole, isScoped, canEdit, isGlobalAdmin, canShareAlbum };
}
