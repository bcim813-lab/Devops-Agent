/**
 * Authentication & Authorization module
 * - User store (in-memory + JSON file persistence)
 * - Session tokens (UUID-based, 8-hour TTL)
 * - Password hashing (SHA-256 + salt, no external deps)
 * - Roles: admin | operator | viewer
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export type Role = "admin" | "operator" | "viewer";

export interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  salt: string;
  role: Role;
  displayName: string;
  avatar: string; // initials or emoji
  createdAt: string;
  lastLoginAt: string | null;
  active: boolean;
  createdBy: string;
}

export interface Session {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
}

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  role: Role;
  displayName: string;
  avatar: string;
  createdAt: string;
  lastLoginAt: string | null;
  active: boolean;
  createdBy: string;
}

const DATA_PATH = path.join(process.cwd(), "data", "users.json");
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// ── Helpers ────────────────────────────────────────────────────────────────
function hashPassword(password: string, salt: string): string {
  return crypto.createHmac("sha256", salt).update(password).digest("hex");
}

function generateSalt(): string {
  return crypto.randomBytes(32).toString("hex");
}

function generateToken(): string {
  return crypto.randomBytes(48).toString("hex");
}

function generateId(): string {
  return crypto.randomUUID();
}

function avatarFromName(name: string): string {
  const parts = name.trim().split(" ");
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ── Persistence ────────────────────────────────────────────────────────────
function ensureDataDir(): void {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadUsers(): User[] {
  try {
    ensureDataDir();
    if (fs.existsSync(DATA_PATH)) {
      return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    }
  } catch { /* ignore */ }
  return [];
}

function saveUsers(users: User[]): void {
  try {
    ensureDataDir();
    fs.writeFileSync(DATA_PATH, JSON.stringify(users, null, 2));
  } catch { /* ignore */ }
}

// ── Auth Store ─────────────────────────────────────────────────────────────
class AuthStore {
  private users: User[] = [];
  private sessions: Map<string, Session> = new Map();

  constructor() {
    this.users = loadUsers();
    // Seed default admin if no users exist
    if (this.users.length === 0) {
      this.seedAdmin();
    }
  }

  private seedAdmin(): void {
    const salt = generateSalt();
    const admin: User = {
      id: generateId(),
      username: "admin",
      email: "admin@devops.local",
      passwordHash: hashPassword("admin123", salt),
      salt,
      role: "admin",
      displayName: "System Admin",
      avatar: "SA",
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      active: true,
      createdBy: "system",
    };
    this.users.push(admin);
    saveUsers(this.users);
  }

  // ── Session management ────────────────────────────────────────────────
  createSession(userId: string, ip: string): string {
    const token = generateToken();
    const now = Date.now();
    this.sessions.set(token, {
      token,
      userId,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      ip,
    });
    // Prune expired sessions
    for (const [k, s] of this.sessions) {
      if (s.expiresAt < now) this.sessions.delete(k);
    }
    return token;
  }

  validateSession(token: string): User | null {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      if (session) this.sessions.delete(token);
      return null;
    }
    return this.users.find(u => u.id === session.userId && u.active) ?? null;
  }

  destroySession(token: string): void {
    this.sessions.delete(token);
  }

  getActiveSessions(): Array<{ token: string; userId: string; createdAt: number; expiresAt: number; ip: string }> {
    const now = Date.now();
    return [...this.sessions.values()].filter(s => s.expiresAt > now);
  }

  // ── Auth ──────────────────────────────────────────────────────────────
  login(username: string, password: string, ip: string): { token: string; user: PublicUser } | null {
    const user = this.users.find(u => (u.username === username || u.email === username) && u.active);
    if (!user) return null;
    const hash = hashPassword(password, user.salt);
    if (hash !== user.passwordHash) return null;
    user.lastLoginAt = new Date().toISOString();
    saveUsers(this.users);
    const token = this.createSession(user.id, ip);
    return { token, user: this.toPublic(user) };
  }

  // ── User CRUD ─────────────────────────────────────────────────────────
  createUser(data: { username: string; email: string; password: string; role: Role; displayName: string }, createdBy: string): PublicUser {
    if (this.users.find(u => u.username === data.username)) {
      throw new Error("Username already exists");
    }
    if (this.users.find(u => u.email === data.email)) {
      throw new Error("Email already exists");
    }
    const salt = generateSalt();
    const user: User = {
      id: generateId(),
      username: data.username,
      email: data.email,
      passwordHash: hashPassword(data.password, salt),
      salt,
      role: data.role,
      displayName: data.displayName || data.username,
      avatar: avatarFromName(data.displayName || data.username),
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      active: true,
      createdBy,
    };
    this.users.push(user);
    saveUsers(this.users);
    return this.toPublic(user);
  }

  listUsers(): PublicUser[] {
    return this.users.map(u => this.toPublic(u));
  }

  getUser(id: string): User | undefined {
    return this.users.find(u => u.id === id);
  }

  updateUser(id: string, data: Partial<{ email: string; displayName: string; role: Role; active: boolean }>): PublicUser {
    const user = this.users.find(u => u.id === id);
    if (!user) throw new Error("User not found");
    if (data.email !== undefined) user.email = data.email;
    if (data.displayName !== undefined) { user.displayName = data.displayName; user.avatar = avatarFromName(data.displayName); }
    if (data.role !== undefined) user.role = data.role;
    if (data.active !== undefined) user.active = data.active;
    saveUsers(this.users);
    return this.toPublic(user);
  }

  changePassword(id: string, oldPassword: string, newPassword: string): void {
    const user = this.users.find(u => u.id === id);
    if (!user) throw new Error("User not found");
    const hash = hashPassword(oldPassword, user.salt);
    if (hash !== user.passwordHash) throw new Error("Current password is incorrect");
    const newSalt = generateSalt();
    user.salt = newSalt;
    user.passwordHash = hashPassword(newPassword, newSalt);
    saveUsers(this.users);
  }

  adminResetPassword(id: string, newPassword: string): void {
    const user = this.users.find(u => u.id === id);
    if (!user) throw new Error("User not found");
    const newSalt = generateSalt();
    user.salt = newSalt;
    user.passwordHash = hashPassword(newPassword, newSalt);
    saveUsers(this.users);
  }

  deleteUser(id: string): void {
    const idx = this.users.findIndex(u => u.id === id);
    if (idx === -1) throw new Error("User not found");
    this.users.splice(idx, 1);
    saveUsers(this.users);
  }

  private toPublic(u: User): PublicUser {
    return { id: u.id, username: u.username, email: u.email, role: u.role, displayName: u.displayName, avatar: u.avatar, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, active: u.active, createdBy: u.createdBy };
  }

  getUserCount(): number { return this.users.length; }
  getActiveSessionCount(): number { return this.getActiveSessions().length; }
}

export const authStore = new AuthStore();

// ── Middleware helpers ─────────────────────────────────────────────────────
export function extractToken(authHeader?: string, cookieHeader?: string): string | null {
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)devops_token=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

export function requireAuth(token: string | null): User {
  if (!token) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  const user = authStore.validateSession(token);
  if (!user) throw Object.assign(new Error("Session expired or invalid"), { status: 401 });
  return user;
}

export function requireRole(user: User, minRole: Role): void {
  const levels: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
  if (levels[user.role] < levels[minRole]) {
    throw Object.assign(new Error("Insufficient permissions"), { status: 403 });
  }
}
