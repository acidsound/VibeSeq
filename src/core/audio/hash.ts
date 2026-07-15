import type { MediaIntegrity } from '../../types'

export type HashableMedia = Blob | ArrayBuffer | ArrayBufferView

export interface VerifiableMedia {
  blob?: Blob
  bytes?: ArrayBuffer
  contentHashSha256?: string
  integrity?: MediaIntegrity
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/

const bytesFor = async (media: HashableMedia): Promise<ArrayBuffer> => {
  if (media instanceof Blob) return media.arrayBuffer()
  if (media instanceof ArrayBuffer) return media.slice(0)
  return media.buffer.slice(media.byteOffset, media.byteOffset + media.byteLength) as ArrayBuffer
}

/** Content identity for persisted source media. The digest never includes project metadata. */
export async function sha256Media(media: HashableMedia): Promise<string> {
  const bytes = await bytesFor(media)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/**
 * Verifies persisted encoded media without changing it or manufacturing an
 * expected identity. Blob is the primary representation because playback uses
 * it first; when both Blob and bytes exist, both must identify the same source.
 */
export async function verifyMediaIntegrity(media: VerifiableMedia): Promise<MediaIntegrity> {
  const representations: Array<{ label: 'blob' | 'bytes'; value: HashableMedia }> = []
  if (media.blob) representations.push({ label: 'blob', value: media.blob })
  if (media.bytes) representations.push({ label: 'bytes', value: media.bytes })

  const suppliedExpected = media.contentHashSha256?.trim().toLowerCase()
  const expectedHashSha256 = suppliedExpected && SHA256_PATTERN.test(suppliedExpected)
    ? suppliedExpected
    : undefined

  if (representations.length === 0) {
    if (media.integrity?.state === 'corrupt') {
      return {
        ...media.integrity,
        state: 'corrupt',
        expectedHashSha256: expectedHashSha256 ?? media.integrity.expectedHashSha256,
      }
    }
    return {
      state: 'missing',
      expectedHashSha256,
      message: 'Local media bytes are missing; integrity cannot be verified.',
    }
  }

  const hashes = await Promise.all(representations.map(async ({ label, value }) => ({
    label,
    hash: await sha256Media(value),
  })))
  const actualHashSha256 = hashes[0].hash

  if (suppliedExpected && !expectedHashSha256) {
    return {
      state: 'corrupt',
      actualHashSha256,
      message: 'The stored SHA-256 content hash is malformed.',
    }
  }

  const divergentRepresentation = hashes.find(({ hash }) => hash !== actualHashSha256)
  if (divergentRepresentation) {
    return {
      state: 'corrupt',
      expectedHashSha256,
      actualHashSha256,
      message: `Stored Blob and bytes identify different media (${hashes[0].label} vs ${divergentRepresentation.label}).`,
    }
  }

  if (!expectedHashSha256) {
    return {
      state: 'unverified',
      actualHashSha256,
      message: 'No SHA-256 content hash is stored; media remains unverified.',
    }
  }

  if (actualHashSha256 !== expectedHashSha256) {
    return {
      state: 'corrupt',
      expectedHashSha256,
      actualHashSha256,
      message: 'Encoded media does not match its stored SHA-256 content hash.',
    }
  }

  return {
    state: 'available',
    expectedHashSha256,
    actualHashSha256,
  }
}
