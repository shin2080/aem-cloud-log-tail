import { hash, verify, Algorithm } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import type { MsgKey, MsgParams } from '../i18n/messages.js';

const OPTS = { algorithm: Algorithm.Argon2id } as const;

export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain, OPTS);
  } catch {
    return false;
  }
}

/** 문제가 있으면 화면에 띄울 메시지의 키를 준다. 없으면 null. */
export function validatePassword(
  plain: string,
): { key: MsgKey; params?: MsgParams } | null {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return { key: 'password_too_short', params: { min: MIN_PASSWORD_LENGTH } };
  }
  return null;
}

/**
 * 계정이 없을 때 대신 검증할 더미 해시.
 *
 * 없는 계정에서 argon2 를 건너뛰면 응답이 눈에 띄게 빨라져, 메시지를 통일해놔도
 * **응답 시간이 계정 존재 여부를 알려준다.** 같은 비용을 치르게 한다.
 */
let dummyHash: string | null = null;

export async function verifyAgainstDummy(plain: string): Promise<false> {
  dummyHash ??= await hashPassword('아무도-쓰지-않는-값-timing-equalizer');
  await verifyPassword(dummyHash, plain);
  return false;
}

/** 관리자가 계정을 만들거나 초기화할 때 1회 노출하는 임시 비밀번호. 저장하지 않는다. */
export function generateTempPassword(): string {
  // 혼동되는 글자(0/O, 1/l/I)를 뺀 알파벳
  const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(20);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}
