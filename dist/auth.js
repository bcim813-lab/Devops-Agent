"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.authStore = void 0;
exports.extractToken = extractToken;
exports.requireAuth = requireAuth;
exports.requireRole = requireRole;
/**
 * Authentication & Authorization module
 * - User store (in-memory + JSON file persistence)
 * - Session tokens (UUID-based, 8-hour TTL)
 * - Password hashing (SHA-256 + salt, no external deps)
 * - Roles: admin | operator | viewer
 */
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DATA_PATH = path.join(process.cwd(), "data", "users.json");
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
// ── Helpers ────────────────────────────────────────────────────────────────
function hashPassword(password, salt) {
    return crypto.createHmac("sha256", salt).update(password).digest("hex");
}
function generateSalt() {
    return crypto.randomBytes(32).toString("hex");
}
function generateToken() {
    return crypto.randomBytes(48).toString("hex");
}
function generateId() {
    return crypto.randomUUID();
}
function avatarFromName(name) {
    const parts = name.trim().split(" ");
    if (parts.length >= 2)
        return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
}
// ── Persistence ────────────────────────────────────────────────────────────
function ensureDataDir() {
    const dir = path.dirname(DATA_PATH);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
}
function loadUsers() {
    try {
        ensureDataDir();
        if (fs.existsSync(DATA_PATH)) {
            return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
        }
    }
    catch { /* ignore */ }
    return [];
}
function saveUsers(users) {
    try {
        ensureDataDir();
        fs.writeFileSync(DATA_PATH, JSON.stringify(users, null, 2));
    }
    catch { /* ignore */ }
}
// ── Auth Store ─────────────────────────────────────────────────────────────
class AuthStore {
    constructor() {
        this.users = [];
        this.sessions = new Map();
        this.users = loadUsers();
        // Seed default admin if no users exist
        if (this.users.length === 0) {
            this.seedAdmin();
        }
    }
    seedAdmin() {
        const salt = generateSalt();
        const admin = {
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
    createSession(userId, ip) {
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
            if (s.expiresAt < now)
                this.sessions.delete(k);
        }
        return token;
    }
    validateSession(token) {
        const session = this.sessions.get(token);
        if (!session || session.expiresAt < Date.now()) {
            if (session)
                this.sessions.delete(token);
            return null;
        }
        return this.users.find(u => u.id === session.userId && u.active) ?? null;
    }
    destroySession(token) {
        this.sessions.delete(token);
    }
    getActiveSessions() {
        const now = Date.now();
        return [...this.sessions.values()].filter(s => s.expiresAt > now);
    }
    // ── Auth ──────────────────────────────────────────────────────────────
    login(username, password, ip) {
        const user = this.users.find(u => (u.username === username || u.email === username) && u.active);
        if (!user)
            return null;
        const hash = hashPassword(password, user.salt);
        if (hash !== user.passwordHash)
            return null;
        user.lastLoginAt = new Date().toISOString();
        saveUsers(this.users);
        const token = this.createSession(user.id, ip);
        return { token, user: this.toPublic(user) };
    }
    // ── User CRUD ─────────────────────────────────────────────────────────
    createUser(data, createdBy) {
        if (this.users.find(u => u.username === data.username)) {
            throw new Error("Username already exists");
        }
        if (this.users.find(u => u.email === data.email)) {
            throw new Error("Email already exists");
        }
        const salt = generateSalt();
        const user = {
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
    listUsers() {
        return this.users.map(u => this.toPublic(u));
    }
    getUser(id) {
        return this.users.find(u => u.id === id);
    }
    updateUser(id, data) {
        const user = this.users.find(u => u.id === id);
        if (!user)
            throw new Error("User not found");
        if (data.email !== undefined)
            user.email = data.email;
        if (data.displayName !== undefined) {
            user.displayName = data.displayName;
            user.avatar = avatarFromName(data.displayName);
        }
        if (data.role !== undefined)
            user.role = data.role;
        if (data.active !== undefined)
            user.active = data.active;
        saveUsers(this.users);
        return this.toPublic(user);
    }
    changePassword(id, oldPassword, newPassword) {
        const user = this.users.find(u => u.id === id);
        if (!user)
            throw new Error("User not found");
        const hash = hashPassword(oldPassword, user.salt);
        if (hash !== user.passwordHash)
            throw new Error("Current password is incorrect");
        const newSalt = generateSalt();
        user.salt = newSalt;
        user.passwordHash = hashPassword(newPassword, newSalt);
        saveUsers(this.users);
    }
    adminResetPassword(id, newPassword) {
        const user = this.users.find(u => u.id === id);
        if (!user)
            throw new Error("User not found");
        const newSalt = generateSalt();
        user.salt = newSalt;
        user.passwordHash = hashPassword(newPassword, newSalt);
        saveUsers(this.users);
    }
    deleteUser(id) {
        const idx = this.users.findIndex(u => u.id === id);
        if (idx === -1)
            throw new Error("User not found");
        this.users.splice(idx, 1);
        saveUsers(this.users);
    }
    toPublic(u) {
        return { id: u.id, username: u.username, email: u.email, role: u.role, displayName: u.displayName, avatar: u.avatar, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, active: u.active, createdBy: u.createdBy };
    }
    getUserCount() { return this.users.length; }
    getActiveSessionCount() { return this.getActiveSessions().length; }
}
exports.authStore = new AuthStore();
// ── Middleware helpers ─────────────────────────────────────────────────────
function extractToken(authHeader, cookieHeader) {
    if (authHeader?.startsWith("Bearer "))
        return authHeader.slice(7);
    if (cookieHeader) {
        const match = cookieHeader.match(/(?:^|;\s*)devops_token=([^;]+)/);
        if (match)
            return match[1];
    }
    return null;
}
function requireAuth(token) {
    if (!token)
        throw Object.assign(new Error("Unauthorized"), { status: 401 });
    const user = exports.authStore.validateSession(token);
    if (!user)
        throw Object.assign(new Error("Session expired or invalid"), { status: 401 });
    return user;
}
function requireRole(user, minRole) {
    const levels = { viewer: 0, operator: 1, admin: 2 };
    if (levels[user.role] < levels[minRole]) {
        throw Object.assign(new Error("Insufficient permissions"), { status: 403 });
    }
}
//# sourceMappingURL=auth.js.map