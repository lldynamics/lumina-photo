import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';

export function getOrCreateHmacSecret(cfg: AppConfig, filename: string): string {
  const secretPath = path.join(cfg.dataDir, filename);
  try {
    if (fs.existsSync(secretPath)) {
      const content = fs.readFileSync(secretPath, 'utf8').trim();
      if (content.length >= 32) return content;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, generated, { mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}

export function hashSecretAsync(secret: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, 32, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

export function verifySecretAsync(
  secret: string,
  stored: string,
): Promise<boolean> {
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return Promise.resolve(false);
  const expected = Buffer.from(expectedHex, 'hex');
  return new Promise((resolve) => {
    crypto.scrypt(secret, salt, 32, (err, actual) => {
      if (err || actual.length !== expected.length) {
        resolve(false);
        return;
      }
      resolve(crypto.timingSafeEqual(actual, expected));
    });
  });
}

export function signTokenHmac(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeCompareHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const clean = ip.trim().toLowerCase();
  return (
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean === '::ffff:127.0.0.1' ||
    clean === 'localhost'
  );
}

export class SlidingWindowRateLimiter {
  private buckets = new Map<string, number[]>();
  private maxAttempts: number;
  private windowMs: number;
  private lastCleanup = Date.now();

  constructor(maxAttempts = 8, windowMs = 5 * 60_000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  isRateLimited(key: string): boolean {
    const now = Date.now();
    this.maybeCleanup(now);
    const hits = this.buckets.get(key);
    if (!hits) return false;
    const valid = hits.filter((ts) => now - ts < this.windowMs);
    if (valid.length === 0) {
      this.buckets.delete(key);
      return false;
    }
    this.buckets.set(key, valid);
    return valid.length >= this.maxAttempts;
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const hits = (this.buckets.get(key) ?? []).filter(
      (ts) => now - ts < this.windowMs,
    );
    hits.push(now);
    this.buckets.set(key, hits);
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanup < 60_000) return;
    this.lastCleanup = now;
    for (const [k, hits] of this.buckets.entries()) {
      const valid = hits.filter((ts) => now - ts < this.windowMs);
      if (valid.length === 0) this.buckets.delete(k);
      else this.buckets.set(k, valid);
    }
  }
}
