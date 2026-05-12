import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';

export interface JwtPayload {
  userId: string;
  email: string;
}

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

export function signEmailToken(userId: string): string {
  return jwt.sign({ userId, purpose: 'verify-email' }, JWT_SECRET, { expiresIn: '24h' });
}

export function signResetToken(userId: string): string {
  return jwt.sign({ userId, purpose: 'reset-password' }, JWT_SECRET, { expiresIn: '1h' });
}
