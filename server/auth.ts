import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { getDb, type RoleName } from './db.ts';

const JWT_SECRET = process.env.JWT_SECRET || 'civicledger-dev-secret-change-in-production-2026';
const TOKEN_TTL_SECONDS = 60 * 60 * 8; // 8 hours

export interface AuthenticatedUser {
  user_id: string;
  name: string;
  email: string;
  contact: string;
  status: string;
  mfa_enabled: boolean;
  is_demo: boolean;
  roles: RoleName[];
}

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export function signAuthToken(user: AuthenticatedUser): string {
  return jwt.sign(
    {
      sub: user.user_id,
      email: user.email,
      roles: user.roles
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL_SECONDS }
  );
}

export function getUserWithRolesById(userId: string): AuthenticatedUser | null {
  const db = getDb();
  const userRow = db
    .prepare(
      'SELECT user_id, name, email, contact, status, mfa_enabled, is_demo FROM users WHERE user_id = ?'
    )
    .get(userId) as
    | {
        user_id: string;
        name: string;
        email: string;
        contact: string;
        status: string;
        mfa_enabled: number;
        is_demo: number;
      }
    | undefined;

  if (!userRow) return null;

  const roleRows = db
    .prepare(
      `SELECT r.role_name FROM user_roles ur
       JOIN roles r ON ur.role_id = r.role_id
       WHERE ur.user_id = ?`
    )
    .all(userId) as Array<{ role_name: RoleName }>;

  return {
    user_id: userRow.user_id,
    name: userRow.name,
    email: userRow.email,
    contact: userRow.contact,
    status: userRow.status,
    mfa_enabled: Boolean(userRow.mfa_enabled),
    is_demo: Boolean(userRow.is_demo),
    roles: roleRows.map((r) => r.role_name)
  };
}

export function logAudit(params: {
  actorId: string | null;
  actorRole: string | null;
  action: string;
  objectType: string;
  objectId: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}): void {
  const db = getDb();
  const logId = `LOG-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  db.prepare(
    `INSERT INTO audit_logs (log_id, actor_id, actor_role, action, object_type, object_id, details_json, ip_address, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    logId,
    params.actorId || 'ANONYMOUS',
    params.actorRole || 'NONE',
    params.action,
    params.objectType,
    params.objectId,
    JSON.stringify(params.details || {}),
    params.ipAddress || '127.0.0.1',
    new Date().toISOString()
  );
}

export function createNotification(params: {
  userId: string;
  title: string;
  message: string;
  type: string;
  relatedObjectId?: string;
}): void {
  const db = getDb();
  const ntfId = `NTF-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  db.prepare(
    `INSERT INTO notifications (notification_id, user_id, title, message, type, related_object_id, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    ntfId,
    params.userId,
    params.title,
    params.message,
    params.type,
    params.relatedObjectId || null,
    new Date().toISOString()
  );
}

export function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies?.civicledger_token;
  if (cookieToken) return cookieToken;
  return null;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required. Please log in.' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub: string };
    const user = getUserWithRolesById(decoded.sub);
    if (!user) {
      res.status(401).json({ error: 'Invalid session user.' });
      return;
    }
    if (user.status !== 'ACTIVE') {
      res.status(403).json({ error: `Account is currently ${user.status}. Contact an administrator.` });
      return;
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired or invalid token.' });
  }
}

export function requireRole(...allowedRoles: RoleName[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const hasRole = req.user.roles.some((r) => allowedRoles.includes(r));
    if (!hasRole) {
      logAudit({
        actorId: req.user.user_id,
        actorRole: req.user.roles.join(','),
        action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
        objectType: 'ENDPOINT',
        objectId: req.originalUrl,
        details: { requiredRoles: allowedRoles, userRoles: req.user.roles },
        ipAddress: req.ip || '127.0.0.1'
      });
      res.status(403).json({
        error: 'Access denied. Your role does not have permission for this operation.',
        requiredRoles: allowedRoles
      });
      return;
    }
    next();
  };
}

export function hasAnyRole(user: AuthenticatedUser, roles: RoleName[]): boolean {
  return user.roles.some((r) => roles.includes(r));
}
