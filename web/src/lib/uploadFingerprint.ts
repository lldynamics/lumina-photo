import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export async function fingerprintUpload(file: Blob, chunkSize: number) {
  const chunkHashes: string[] = [];
  const identity = sha256.create();
  for (let start = 0; start < file.size; start += chunkSize) {
    const content = new Uint8Array(await file.slice(start, start + chunkSize).arrayBuffer());
    const digest = globalThis.crypto?.subtle
      ? new Uint8Array(await crypto.subtle.digest('SHA-256', content))
      : sha256(content);
    identity.update(digest);
    chunkHashes.push(bytesToHex(digest));
  }
  return { chunkHashes, fingerprint: bytesToHex(identity.digest()) };
}
