import { useModalFocus } from '../hooks/useModalFocus';
import React, { useCallback, useEffect, useState } from 'react';
import { isUnencryptedRemoteUrl } from '../lib/shareUrl';
import {
  DownloadCloud,
  Lock,
  LogOut,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import type {
  AuthStatusResponse,
  FamilyUser,
  Library,
  UserRole,
} from '../lib/types';

interface AdminLoginGateProps {
  authStatus?: AuthStatusResponse | null;
  onUnlocked: (status: AuthStatusResponse) => void;
}

export const AdminLoginGate: React.FC<AdminLoginGateProps> = ({
  authStatus,
  onUnlocked,
}) => {
  const [username, setUsername] = useState('');
  const [passcode, setPasscode] = useState('');
  const [memberMode, setMemberMode] = useState(Boolean(authStatus?.hasUsers));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.loginAdmin(
        passcode.trim(),
        memberMode ? username.trim() : undefined,
      );
      onUnlocked(res.status);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const adminPasscodeMissingOnLan = Boolean(
    !memberMode && authStatus?.hasUsers && !authStatus?.hasPasscode,
  );

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-zinc-50 dark:bg-[#0f1115] text-zinc-900 dark:text-zinc-100">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl p-6 space-y-4"
      >
        <div className="flex items-center gap-3">
          <img
            src="/icon.svg?v=2"
            alt="自己用的一个相册"
            className="w-11 h-11 rounded-2xl shadow-md shrink-0"
          />
          <div>
            <h1 className="text-base font-semibold">自己用的一个相册 · 登录</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              主相册已启用访问保护，请验证口令或成员账号
            </p>
          </div>
        </div>

        {isUnencryptedRemoteUrl(window.location.href) && (
          <div role="note" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
            当前地址使用 HTTP。普通局域网连接的口令和照片未加密；请优先使用可信 HTTPS 或 Tailscale 加密网络。
          </div>
        )}

        {(authStatus?.hasUsers || memberMode) && (
          <div className="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-800 p-0.5 rounded-xl text-xs">
            <button
              type="button"
              onClick={() => {
                setMemberMode(false);
                setError(null);
              }}
              className={`flex-1 py-1.5 rounded-lg transition-colors ${
                !memberMode
                  ? 'bg-white dark:bg-zinc-700 font-medium shadow-xs'
                  : 'text-zinc-500'
              }`}
            >
              管理员口令
            </button>
            <button
              type="button"
              onClick={() => {
                setMemberMode(true);
                setError(null);
              }}
              className={`flex-1 py-1.5 rounded-lg transition-colors ${
                memberMode
                  ? 'bg-white dark:bg-zinc-700 font-medium shadow-xs'
                  : 'text-zinc-500'
              }`}
            >
              家庭成员账号
            </button>
          </div>
        )}

        {adminPasscodeMissingOnLan ? (
          <div className="rounded-xl p-3 text-xs bg-amber-50 border border-amber-200 text-amber-900 dark:bg-amber-950/30 dark:border-amber-500/30 dark:text-amber-200 leading-relaxed">
            尚未设置远程管理员口令。请切换至上方「家庭成员账号」使用成员用户名登录，或在相册主机本机浏览器（127.0.0.1）进入「安全与成员」设置管理员口令。
          </div>
        ) : (
          <div className="space-y-2.5">
            {memberMode && (
              <input
                type="text"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="成员用户名（如 mom）"
                className="w-full px-3.5 py-2.5 rounded-xl text-sm border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-blue-500"
              />
            )}
            <input
              type="password"
              autoFocus={!memberMode}
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder={
                memberMode ? '输入成员访问口令...' : '输入管理员口令 / PIN...'
              }
              className="w-full px-3.5 py-2.5 rounded-xl text-sm border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-blue-500"
            />
          </div>
        )}

        {error && <div className="text-xs text-red-500">{error}</div>}

        <button
          type="submit"
          disabled={
            submitting ||
            adminPasscodeMissingOnLan ||
            !passcode.trim() ||
            (memberMode && !username.trim())
          }
          className="w-full py-2.5 rounded-xl text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          <Lock className="w-4 h-4" />
          {submitting ? '验证中...' : '解锁进入相册'}
        </button>
      </form>
    </div>
  );
};

interface AdminSecurityModalProps {
  open: boolean;
  authStatus: AuthStatusResponse | null;
  libraries?: Library[];
  onLogout?: () => void;
  onOpenAiSettings?: () => void;
  onClose: () => void;
  onUpdated: (status: AuthStatusResponse) => void;
  embedded?: boolean;
}

const ROLE_LABELS: Record<UserRole, string> = {
  admin: '管理员',
  member: '家庭成员 (可整理/上传)',
  viewer: '只读访客 (仅查看/导出)',
};

export const AdminSecurityModal: React.FC<AdminSecurityModalProps> = ({
  open,
  authStatus,
  libraries = [],
  onLogout,
  onOpenAiSettings,
  onClose,
  onUpdated,
  embedded = false,
}) => {
  const [tab, setTab] = useState<'passcode' | 'users'>('passcode');
  const [currentPasscode, setCurrentPasscode] = useState('');
  const [newPasscode, setNewPasscode] = useState('');
  const [requireOnLoopback, setRequireOnLoopback] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Family member state
  const [users, setUsers] = useState<FamilyUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newUserPasscode, setNewUserPasscode] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('viewer');
  const [restrictLibs, setRestrictLibs] = useState(false);
  const [selectedLibIds, setSelectedLibIds] = useState<number[]>([]);
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('viewer');
  const [editPasscode, setEditPasscode] = useState('');
  const [editRestrictLibs, setEditRestrictLibs] = useState(false);
  const [editSelectedLibIds, setEditSelectedLibIds] = useState<number[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);

  const isAdmin = (authStatus?.currentUser?.role ?? 'admin') === 'admin' && authStatus?.currentUser?.allowedLibraryIds == null;
  const needCurrentPasscode = Boolean(
    authStatus?.hasPasscode && !authStatus?.isLoopback,
  );

  const loadUsers = useCallback(async () => {
    if (!isAdmin) return;
    setLoadingUsers(true);
    try {
      const res = await api.getUsers();
      setUsers(res.users);
    } catch {
      // ignore if non-admin
    } finally {
      setLoadingUsers(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!open) return;
    setCurrentPasscode('');
    setNewPasscode('');
    setRequireOnLoopback(authStatus?.requireOnLoopback ?? false);
    setError(null);
    setSuccess(null);
    if (isAdmin) {
      void loadUsers();
    }
  }, [open, authStatus, isAdmin, loadUsers]);

  const modalRef = useModalFocus(open && !embedded);

  if (!open) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (needCurrentPasscode && !currentPasscode.trim()) {
      setError('局域网修改安全设置前请先输入当前管理员口令');
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const payload: {
        newPasscode?: string;
        requireOnLoopback: boolean;
        currentPasscode?: string;
      } = { requireOnLoopback };
      if (newPasscode.trim()) {
        payload.newPasscode = newPasscode.trim();
      }
      if (needCurrentPasscode) {
        payload.currentPasscode = currentPasscode.trim();
      }
      const res = await api.updateAdminPasscode(payload);
      onUpdated(res.status);
      setCurrentPasscode('');
      setNewPasscode('');
      setSuccess('安全设置已保存生效');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleClearPasscode = async () => {
    if (needCurrentPasscode && !currentPasscode.trim()) {
      setError('局域网关闭管理员口令保护前请先输入当前管理员口令');
      return;
    }
    const hasFamilyUsers = users.length > 0 || Boolean(authStatus?.hasUsers);
    const confirmMsg = hasFamilyUsers
      ? '确认清除独立管理员口令吗？局域网设备将只能使用家庭成员账号登录。'
      : '确认清除管理员口令吗？重新设置口令或添加家庭成员前，只有本机可以访问主相册。';
    if (!confirm(confirmMsg)) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.updateAdminPasscode({
        newPasscode: null,
        requireOnLoopback: false,
        ...(needCurrentPasscode
          ? { currentPasscode: currentPasscode.trim() }
          : {}),
      });
      onUpdated(res.status);
      setCurrentPasscode('');
      setSuccess('已关闭管理口令保护');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await api.createUser({
        username: newUsername.trim(),
        displayName: newDisplayName.trim() || newUsername.trim(),
        role: newRole,
        passcode: newUserPasscode.trim(),
        allowedLibraryIds: restrictLibs ? selectedLibIds : null,
      });
      setNewUsername('');
      setNewDisplayName('');
      setNewUserPasscode('');
      setRestrictLibs(false);
      setSelectedLibIds([]);
      await loadUsers();
      const st = await api.getAuthStatus();
      onUpdated(st);
      setSuccess('已添加家庭成员账号');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const body = (
    <>
        {/* Tabs */}
        <div className="px-5 pt-2 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-2 text-xs shrink-0">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTab('passcode')}
              className={`px-3 py-2 font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                tab === 'passcode'
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800'
              }`}
            >
              <Lock className="w-3.5 h-3.5" />
              管理员口令
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setTab('users')}
                className={`px-3 py-2 font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                  tab === 'users'
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-zinc-500 hover:text-zinc-800'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                家庭成员与权限 ({users.length})
              </button>
            )}
            {!embedded && isAdmin && onOpenAiSettings && (
              <button
                type="button"
                onClick={onOpenAiSettings}
                className="mb-1 px-2.5 py-1 rounded-lg text-[11px] font-medium text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/30 flex items-center gap-1"
                title="前往本地离线 AI 设置，一键下载或管理 SigLIP2 模型"
              >
                <DownloadCloud className="w-3 h-3" />
                AI 模型下载
              </button>
            )}
          </div>

          {onLogout && authStatus?.currentUser && (
            <button
              type="button"
              onClick={onLogout}
              className="mb-1 px-2.5 py-1 rounded-lg text-[11px] text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 flex items-center gap-1"
            >
              <LogOut className="w-3 h-3" />
              退出 ({authStatus.currentUser.displayName})
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {tab === 'passcode' ? (
            <>
              <div
                className={`rounded-xl p-3 border ${
                  authStatus?.hasPasscode
                    ? 'bg-emerald-50/70 border-emerald-200 text-emerald-900 dark:bg-emerald-950/30 dark:border-emerald-500/30 dark:text-emerald-200'
                    : 'bg-amber-50/80 border-amber-200 text-amber-900 dark:bg-amber-950/30 dark:border-amber-500/30 dark:text-amber-200'
                }`}
              >
                {authStatus?.hasPasscode
                  ? authStatus.envManaged
                    ? '已通过环境变量 LUMINA_ADMIN_PASSCODE 强制启用口令保护。'
                    : '当前已启用管理员口令保护：公开分享链接 /s/... 独立受控，局域网设备访问主相册需先验证口令。'
                  : '尚未设置管理员口令。局域网设备访问主相册需要管理员口令或家庭成员账号。'}
              </div>

              {isAdmin && !authStatus?.envManaged && (
                <form onSubmit={handleSave} className="space-y-3.5">
                  {needCurrentPasscode && (
                    <div>
                      <label className="block text-zinc-600 dark:text-zinc-300 font-medium mb-1">
                        验证当前管理员口令
                      </label>
                      <input
                        type="password"
                        value={currentPasscode}
                        onChange={(e) => setCurrentPasscode(e.target.value)}
                        placeholder="非本机修改或关闭口令需验证当前管理员口令..."
                        className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-blue-500"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-zinc-600 dark:text-zinc-300 font-medium mb-1">
                      {authStatus?.hasPasscode
                        ? '修改管理员口令（留空保持原口令不变）'
                        : '设置管理员口令（至少 4 位）'}
                    </label>
                    <input
                      type="password"
                      value={newPasscode}
                      onChange={(e) => setNewPasscode(e.target.value)}
                      placeholder={
                        authStatus?.hasPasscode
                          ? '输入新口令以更新...'
                          : '例如：设置 4-16 位访问 PIN 码'
                      }
                      className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-blue-500"
                    />
                  </div>

                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={requireOnLoopback}
                      onChange={(e) => setRequireOnLoopback(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-zinc-600 dark:text-zinc-300 leading-relaxed">
                      本机电脑浏览器（localhost / 127.0.0.1）访问时也要求输入口令（默认不勾选，本机免密直连更顺手）
                    </span>
                  </label>

                  {error && (
                    <div className="text-red-500 bg-red-50 dark:bg-red-950/40 px-3 py-2 rounded-xl">
                      {error}
                    </div>
                  )}
                  {success && (
                    <div className="text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 rounded-xl">
                      {success}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2 pt-2">
                    {authStatus?.hasPasscode ? (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void handleClearPasscode()}
                        className="px-3 py-2 rounded-xl text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                      >
                        关闭口令保护
                      </button>
                    ) : (
                      <span />
                    )}

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700"
                      >
                        关闭
                      </button>
                      <button
                        type="submit"
                        disabled={
                          saving ||
                          (!authStatus?.hasPasscode && !newPasscode.trim())
                        }
                        className="px-4 py-2 rounded-xl font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {saving ? '保存中...' : '保存安全设置'}
                      </button>
                    </div>
                  </div>
                </form>
              )}
            </>
          ) : (
            <div className="space-y-4">
              {!authStatus?.hasPasscode && (
                <div className="rounded-xl p-3 border bg-amber-50/80 border-amber-200 text-amber-900 dark:bg-amber-950/30 dark:border-amber-500/30 dark:text-amber-200 leading-relaxed">
                  提示：启用家庭成员账号后，局域网设备将强制进入登录页。建议同时在「管理员口令」页签设置管理员口令，以便你在手机/平板等局域网设备上也能用管理员身份登录。
                </div>
              )}

              {/* Create User Form */}
              <form
                onSubmit={handleCreateUser}
                className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3.5 space-y-3 bg-zinc-50/70 dark:bg-zinc-800/30"
              >
                <div className="font-semibold flex items-center gap-1.5">
                  <Plus className="w-3.5 h-3.5 text-blue-500" />
                  新建家庭成员账号
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <input
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="用户名（英文/数字，如 mom）"
                    required
                    className="px-2.5 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 outline-none"
                  />
                  <input
                    value={newDisplayName}
                    onChange={(e) => setNewDisplayName(e.target.value)}
                    placeholder="称呼/昵称（如 妈妈）"
                    className="px-2.5 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 outline-none"
                  />
                  <input
                    type="password"
                    value={newUserPasscode}
                    onChange={(e) => setNewUserPasscode(e.target.value)}
                    placeholder="成员登录口令（至少 4 位）"
                    required
                    className="px-2.5 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 outline-none"
                  />
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as UserRole)}
                    className="px-2.5 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 outline-none"
                  >
                    <option value="viewer">只读访客（仅浏览/导出，禁止修改删图）</option>
                    <option value="member">家庭成员（可上传/收藏/建相册，禁止彻底清空）</option>
                    <option value="admin">联合管理员</option>
                  </select>
                </div>

                {libraries.length > 0 && (
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={restrictLibs}
                        onChange={(e) => setRestrictLibs(e.target.checked)}
                      />
                      <span>限制该成员仅可查看指定的照片目录（图库）</span>
                    </label>
                    {restrictLibs && (
                      <div className="flex flex-wrap gap-2 pl-5">
                        {libraries.map((lib) => {
                          const checked = selectedLibIds.includes(lib.id);
                          return (
                            <label
                              key={lib.id}
                              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() =>
                                  setSelectedLibIds((prev) =>
                                    checked
                                      ? prev.filter((id) => id !== lib.id)
                                      : [...prev, lib.id],
                                  )
                                }
                              />
                              <span>{lib.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {error && (
                  <div className="text-red-500 bg-red-50 dark:bg-red-950/40 px-3 py-2 rounded-lg">
                    {error}
                  </div>
                )}
                {success && (
                  <div className="text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 rounded-lg">
                    {success}
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={
                      saving || !newUsername.trim() || !newUserPasscode.trim()
                    }
                    className="px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50"
                  >
                    添加成员
                  </button>
                </div>
              </form>

              {/* Members List */}
              <div className="space-y-2">
                <div className="font-medium text-zinc-500">
                  已配置成员 ({users.length})
                </div>
                {loadingUsers ? (
                  <div className="py-6 text-center text-zinc-400">加载中...</div>
                ) : users.length === 0 ? (
                  <div className="py-6 text-center rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 text-zinc-400">
                    暂无独立家庭成员账号，可在上方添加
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800">
                    {users.map((u) => {
                      const isEditing = editingUserId === u.id;
                      return (
                        <div key={u.id} className="px-3.5 py-2.5 space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <UserCheck className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                                <span className="font-medium truncate">
                                  {u.displayName}
                                </span>
                                <span className="text-zinc-400 font-mono">
                                  @{u.username}
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-[10px]">
                                  {ROLE_LABELS[u.role]}
                                </span>
                              </div>
                              <div className="text-[11px] text-zinc-400 mt-0.5 pl-5">
                                {u.allowedLibraryIds
                                  ? `仅限 ${u.allowedLibraryIds.length} 个图库目录`
                                  : '可访问全部图库'}{' '}
                                · {u.isActive ? '已启用' : '已停用'}
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => {
                                  if (isEditing) {
                                    setEditingUserId(null);
                                  } else {
                                    setEditingUserId(u.id);
                                    setEditDisplayName(u.displayName);
                                    setEditRole(u.role);
                                    setEditPasscode('');
                                    setEditRestrictLibs(u.allowedLibraryIds !== null);
                                    setEditSelectedLibIds(u.allowedLibraryIds ?? []);
                                    setError(null);
                                    setSuccess(null);
                                  }
                                }}
                                className="p-1.5 rounded-lg text-zinc-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30"
                                title="编辑成员权限或重置口令"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  setError(null);
                                  try {
                                    await api.updateUser(u.id, {
                                      isActive: !u.isActive,
                                    });
                                    await loadUsers();
                                  } catch (err) {
                                    setError((err as Error).message || '更新成员状态失败');
                                  }
                                }}
                                className="px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-[11px]"
                              >
                                {u.isActive ? '停用' : '启用'}
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  if (
                                    !confirm(
                                      `确认删除成员「${u.displayName}」？该成员创建的分享链接也会一并撤销。`,
                                    )
                                  ) {
                                    return;
                                  }
                                  setError(null);
                                  try {
                                    await api.deleteUser(u.id);
                                    if (editingUserId === u.id) {
                                      setEditingUserId(null);
                                    }
                                    await loadUsers();
                                    const st = await api.getAuthStatus();
                                    onUpdated(st);
                                  } catch (err) {
                                    setError((err as Error).message || '删除成员失败');
                                  }
                                }}
                                className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                                title="删除成员"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          {isEditing && (
                            <form
                              onSubmit={async (e) => {
                                e.preventDefault();
                                setSavingEdit(true);
                                setError(null);
                                setSuccess(null);
                                try {
                                  await api.updateUser(u.id, {
                                    displayName: editDisplayName.trim() || u.username,
                                    role: editRole,
                                    passcode: editPasscode.trim() || undefined,
                                    allowedLibraryIds: editRestrictLibs
                                      ? editSelectedLibIds
                                      : null,
                                  });
                                  setEditingUserId(null);
                                  setSuccess(`已更新成员「${editDisplayName.trim() || u.username}」的配置`);
                                  await loadUsers();
                                  const st = await api.getAuthStatus();
                                  onUpdated(st);
                                } catch (err) {
                                  setError((err as Error).message || '保存成员配置失败');
                                } finally {
                                  setSavingEdit(false);
                                }
                              }}
                              className="rounded-xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 p-3 space-y-2.5"
                            >
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                <input
                                  value={editDisplayName}
                                  onChange={(e) => setEditDisplayName(e.target.value)}
                                  placeholder="称呼/昵称"
                                  required
                                  className="px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 outline-none"
                                />
                                <select
                                  value={editRole}
                                  onChange={(e) => setEditRole(e.target.value as UserRole)}
                                  className="px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 outline-none"
                                >
                                  <option value="viewer">只读访客</option>
                                  <option value="member">家庭成员</option>
                                  <option value="admin">联合管理员</option>
                                </select>
                                <input
                                  type="password"
                                  value={editPasscode}
                                  onChange={(e) => setEditPasscode(e.target.value)}
                                  placeholder="新口令（留空不改）"
                                  className="px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 outline-none"
                                />
                              </div>

                              {libraries.length > 0 && (
                                <div className="space-y-1.5">
                                  <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={editRestrictLibs}
                                      onChange={(e) => setEditRestrictLibs(e.target.checked)}
                                    />
                                    <span>限制仅可查看指定图库目录</span>
                                  </label>
                                  {editRestrictLibs && (
                                    <div className="flex flex-wrap gap-2 pl-5">
                                      {libraries.map((lib) => {
                                        const checked = editSelectedLibIds.includes(lib.id);
                                        return (
                                          <label
                                            key={lib.id}
                                            className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 cursor-pointer"
                                          >
                                            <input
                                              type="checkbox"
                                              checked={checked}
                                              onChange={() =>
                                                setEditSelectedLibIds((prev) =>
                                                  checked
                                                    ? prev.filter((id) => id !== lib.id)
                                                    : [...prev, lib.id],
                                                )
                                              }
                                            />
                                            <span>{lib.name}</span>
                                          </label>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              )}

                              <div className="flex justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEditingUserId(null)}
                                  className="px-3 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300"
                                >
                                  取消
                                </button>
                                <button
                                  type="submit"
                                  disabled={savingEdit}
                                  className="px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50"
                                >
                                  {savingEdit ? '保存中...' : '保存修改'}
                                </button>
                              </div>
                            </form>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
    </>
  );

  if (embedded) return body;

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="安全与成员" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-emerald-500" />
            <div>
              <h2 className="text-base font-semibold">访问安全与家庭成员权限</h2>
              <p className="text-xs text-zinc-500">
                支持独立管理口令与家庭多成员（管理员 / 可整理成员 / 只读访客）角色隔离
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
        {body}
      </div>
    </div>
  );
};
