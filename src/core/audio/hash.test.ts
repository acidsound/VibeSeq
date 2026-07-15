import { describe, expect, it } from 'vitest'
import { sha256Media, verifyMediaIntegrity } from './hash'

describe('source media hashing', () => {
  it('uses the raw bytes for Blob, ArrayBuffer, and sliced views', async () => {
    const expected = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'
    expect(await sha256Media(new Blob([Uint8Array.from([1, 2, 3])]))).toBe(expected)
    expect(await sha256Media(Uint8Array.from([1, 2, 3]).buffer)).toBe(expected)
    expect(await sha256Media(Uint8Array.from([0, 1, 2, 3, 4]).subarray(1, 4))).toBe(expected)
  })

  it('returns auditable expected and actual hashes for available or corrupt media', async () => {
    const bytes = Uint8Array.from([1, 2, 3]).buffer
    const expectedHashSha256 = await sha256Media(bytes)

    await expect(verifyMediaIntegrity({ bytes, contentHashSha256: expectedHashSha256 })).resolves.toEqual({
      state: 'available',
      expectedHashSha256,
      actualHashSha256: expectedHashSha256,
    })

    const corrupt = await verifyMediaIntegrity({
      bytes: Uint8Array.from([3, 2, 1]).buffer,
      contentHashSha256: expectedHashSha256,
    })
    expect(corrupt).toMatchObject({
      state: 'corrupt',
      expectedHashSha256,
    })
    expect(corrupt.actualHashSha256).not.toBe(expectedHashSha256)
  })

  it('distinguishes missing, unverified, and divergent dual representations', async () => {
    await expect(verifyMediaIntegrity({
      contentHashSha256: 'a'.repeat(64),
    })).resolves.toMatchObject({
      state: 'missing',
      expectedHashSha256: 'a'.repeat(64),
    })

    await expect(verifyMediaIntegrity({
      integrity: { state: 'corrupt', message: 'Invalid base64 payload' },
    })).resolves.toEqual({
      state: 'corrupt',
      message: 'Invalid base64 payload',
      expectedHashSha256: undefined,
    })

    await expect(verifyMediaIntegrity({
      blob: new Blob([Uint8Array.from([1, 2, 3])]),
    })).resolves.toMatchObject({
      state: 'unverified',
      actualHashSha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
    })

    await expect(verifyMediaIntegrity({
      blob: new Blob([Uint8Array.from([1, 2, 3])]),
      bytes: Uint8Array.from([3, 2, 1]).buffer,
    })).resolves.toMatchObject({ state: 'corrupt' })
  })
})
