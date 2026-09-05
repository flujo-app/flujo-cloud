import { createCipheriv, createHash, randomBytes } from 'node:crypto';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function encryptSnapshot(plaintext, key = randomBytes(32)) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Snapshot encryption requires a 32-byte key.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    key,
    sha256: sha256(plaintext),
    envelope: Buffer.from(JSON.stringify({
      format: 'flujo-workspace-encrypted', version: 1,
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64'),
    })),
  };
}
