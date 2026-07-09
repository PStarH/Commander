import { useEffect, useMemo, useState } from 'react';
import {
  Users,
  Plus,
  Trash2,
  Edit2,
  KeyRound,
  Shield,
  Eye,
  Wrench,
  Code2,
  ScrollText,
  X,
  Check,
  AlertTriangle,
} from 'lucide-react';
import {
  fetchUsers,
  createUser,
  updateUser,
  deleteUser,
  resetUserPassword,
  type AuthUser,
  type UserRole,
} from '../api';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';

const ROLES: { value: UserRole; label: string; icon: typeof Shield }[] = [
  { value: 'super_admin', label: 'Super Admin / 超级管理员', icon: Shield },
  { value: 'admin', label: 'Admin / 管理员', icon: Shield },
  { value: 'developer', label: 'Developer / 开发者', icon: Code2 },
  { value: 'operator', label: 'Operator / 运维', icon: Wrench },
  { value: 'auditor', label: 'Auditor / 审计员', icon: ScrollText },
  { value: 'viewer', label: 'Viewer / 只读', icon: Eye },
];

const ROLE_VARIANTS: Record<UserRole, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  super_admin: 'error',
  admin: 'success',
  developer: 'info',
  operator: 'info',
  auditor: 'warning',
  viewer: 'default',
};

interface UserFormData {
  username: string;
  email: string;
  password: string;
  role: UserRole;
}

const EMPTY_FORM: UserFormData = {
  username: '',
  email: '',
  password: '',
  role: 'viewer',
};

export function UsersPage() {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<AuthUser | null>(null);
  const [resettingUser, setResettingUser] = useState<AuthUser | null>(null);
  const [deletingUser, setDeletingUser] = useState<AuthUser | null>(null);
  const [form, setForm] = useState<UserFormData>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  const currentUserId = useMemo(() => {
    try {
      return JSON.parse(
        atob((localStorage.getItem('commander.auth.token') ?? '').split('.')[1] ?? ''),
      )?.id as string | undefined;
    } catch {
      return undefined;
    }
  }, []);

  async function loadUsers() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchUsers();
      setUsers(data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  function openCreate() {
    setForm(EMPTY_FORM);
    setIsCreateOpen(true);
  }

  function openEdit(user: AuthUser) {
    setEditingUser(user);
    setForm({
      username: user.username,
      email: user.email,
      password: '',
      role: user.role,
    });
  }

  function closeModal() {
    setIsCreateOpen(false);
    setEditingUser(null);
    setResettingUser(null);
    setDeletingUser(null);
    setForm(EMPTY_FORM);
    setNewPassword('');
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await createUser(form);
      closeModal();
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!editingUser) return;
    setSubmitting(true);
    try {
      await updateUser(editingUser.id, { email: form.email, role: form.role });
      closeModal();
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!resettingUser || !newPassword) return;
    setSubmitting(true);
    try {
      await resetUserPassword(resettingUser.id, newPassword);
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deletingUser) return;
    setSubmitting(true);
    try {
      await deleteUser(deletingUser.id);
      closeModal();
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="users-page">
      <div className="page-header">
        <div className="page-header-title">
          <Users size={20} />
          <h1>User Management</h1>
        </div>
        <Button onClick={openCreate}>
          <Plus size={16} />
          Add User
        </Button>
      </div>

      {error && (
        <div className="banner error" style={{ marginBottom: 16 }}>
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button type="button" className="banner-close" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      <Card>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Email</th>
                <th>Role</th>
                <th>Created</th>
                <th>Last Login</th>
                <th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    <div className="loading-inline">Loading users...</div>
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    No users found.
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                  <tr key={user.id}>
                    <td className="font-mono">{user.username}</td>
                    <td>{user.email}</td>
                    <td>
                      <Badge variant={ROLE_VARIANTS[user.role]}>{user.role}</Badge>
                    </td>
                    <td>{new Date(user.createdAt).toLocaleDateString()}</td>
                    <td>
                      {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}
                    </td>
                    <td className="actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="Edit"
                        onClick={() => openEdit(user)}
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Reset password"
                        onClick={() => setResettingUser(user)}
                      >
                        <KeyRound size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger"
                        title="Delete"
                        disabled={user.id === currentUserId}
                        onClick={() => setDeletingUser(user)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Create / Edit Modal */}
      {(isCreateOpen || editingUser) && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{isCreateOpen ? 'Add User' : 'Edit User'}</h2>
              <button type="button" className="icon-btn" onClick={closeModal}>
                <X size={16} />
              </button>
            </div>
            <form onSubmit={isCreateOpen ? handleCreate : handleUpdate}>
              <div className="modal-body">
                <div className="form-row">
                  <label htmlFor="username">Username</label>
                  <Input
                    id="username"
                    value={form.username}
                    disabled={!isCreateOpen}
                    onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                    placeholder="e.g. jane.doe"
                    required
                  />
                </div>
                <div className="form-row">
                  <label htmlFor="email">Email</label>
                  <Input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                    placeholder="jane@company.com"
                    required
                  />
                </div>
                {isCreateOpen && (
                  <div className="form-row">
                    <label htmlFor="password">Password</label>
                    <Input
                      id="password"
                      type="password"
                      value={form.password}
                      onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                      placeholder="At least 6 characters"
                      required
                    />
                  </div>
                )}
                <div className="form-row">
                  <label htmlFor="role">Role</label>
                  <Select
                    id="role"
                    value={form.role}
                    onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as UserRole }))}
                  >
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <div className="modal-footer">
                <Button type="button" variant="ghost" onClick={closeModal}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  <Check size={16} />
                  {isCreateOpen ? 'Create User' : 'Save Changes'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {resettingUser && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Reset Password</h2>
              <button type="button" className="icon-btn" onClick={closeModal}>
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleResetPassword}>
              <div className="modal-body">
                <p className="muted">
                  Set a new password for <strong>{resettingUser.username}</strong>.
                </p>
                <div className="form-row">
                  <label htmlFor="newPassword">New Password</label>
                  <Input
                    id="newPassword"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 6 characters"
                    required
                  />
                </div>
              </div>
              <div className="modal-footer">
                <Button type="button" variant="ghost" onClick={closeModal}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  <KeyRound size={16} />
                  Reset Password
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingUser && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal danger" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Delete User</h2>
              <button type="button" className="icon-btn" onClick={closeModal}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p>
                Are you sure you want to delete <strong>{deletingUser.username}</strong>? This
                action cannot be undone.
              </p>
            </div>
            <div className="modal-footer">
              <Button type="button" variant="ghost" onClick={closeModal}>
                Cancel
              </Button>
              <Button type="button" variant="danger" disabled={submitting} onClick={handleDelete}>
                <Trash2 size={16} />
                Delete User
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
