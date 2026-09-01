export type Role = "admin" | "operator" | "viewer";
export interface User {
    id: string;
    username: string;
    email: string;
    passwordHash: string;
    salt: string;
    role: Role;
    displayName: string;
    avatar: string;
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
declare class AuthStore {
    private users;
    private sessions;
    constructor();
    private seedAdmin;
    createSession(userId: string, ip: string): string;
    validateSession(token: string): User | null;
    destroySession(token: string): void;
    getActiveSessions(): Array<{
        token: string;
        userId: string;
        createdAt: number;
        expiresAt: number;
        ip: string;
    }>;
    login(username: string, password: string, ip: string): {
        token: string;
        user: PublicUser;
    } | null;
    createUser(data: {
        username: string;
        email: string;
        password: string;
        role: Role;
        displayName: string;
    }, createdBy: string): PublicUser;
    listUsers(): PublicUser[];
    getUser(id: string): User | undefined;
    updateUser(id: string, data: Partial<{
        email: string;
        displayName: string;
        role: Role;
        active: boolean;
    }>): PublicUser;
    changePassword(id: string, oldPassword: string, newPassword: string): void;
    adminResetPassword(id: string, newPassword: string): void;
    deleteUser(id: string): void;
    private toPublic;
    getUserCount(): number;
    getActiveSessionCount(): number;
}
export declare const authStore: AuthStore;
export declare function extractToken(authHeader?: string, cookieHeader?: string): string | null;
export declare function requireAuth(token: string | null): User;
export declare function requireRole(user: User, minRole: Role): void;
export {};
//# sourceMappingURL=auth.d.ts.map