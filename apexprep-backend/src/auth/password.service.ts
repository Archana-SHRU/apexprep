import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { argon2id, hash, needsRehash, verify, type Options } from 'argon2';
import type { Env } from '../config/env.schema';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Returns a reason the password is unacceptable, or null. Length limits are also in the DTOs. */
export function passwordPolicyViolation(password: string, email?: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > PASSWORD_MAX_LENGTH) return `password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  if (password.trim().length === 0) return 'password must not be blank';
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) return 'password must not be your email address';
  return null;
}

/** argon2id hashing. Hashes are self-describing, so parameters can be raised later (see needsRehash). */
@Injectable()
export class PasswordService {
  private readonly options: Options & { raw?: false };
  private dummyHash?: Promise<string>;

  constructor(config: ConfigService<Env, true>) {
    this.options = {
      type: argon2id,
      memoryCost: config.get('ARGON2_MEMORY_KIB', { infer: true }),
      timeCost: config.get('ARGON2_TIME_COST', { infer: true }),
      parallelism: 1,
    };
  }

  hash(plain: string): Promise<string> {
    return hash(plain, this.options);
  }

  async verify(encoded: string, plain: string): Promise<boolean> {
    try {
      return await verify(encoded, plain);
    } catch {
      return false;
    }
  }

  needsRehash(encoded: string): boolean {
    try {
      return needsRehash(encoded, this.options);
    } catch {
      return false;
    }
  }

  /** Spend the same time as a real verification so unknown emails can't be detected by timing. */
  async burnVerification(plain: string): Promise<void> {
    this.dummyHash ??= this.hash('apexprep-timing-equaliser');
    await this.verify(await this.dummyHash, plain);
  }
}
