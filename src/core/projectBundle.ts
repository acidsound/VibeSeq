import { verifyMediaIntegrity } from './audio/hash'
import {
  deserializeProjectCheckpoint,
  serializeProjectCheckpoint,
  validateProjectCheckpoint,
} from './projectSerialization'
import type { GenerationCandidateSnapshot, ProjectCheckpoint } from './projectSerialization'
import type { AudioAsset, MediaIntegrity } from '../types'

export const PROJECT_BUNDLE_EXTENSION = '.vibeseq'
export const PROJECT_BUNDLE_MIME_TYPE = 'application/vnd.vibeseq.project+json'

export type ProjectBundleErrorCode = 'media-missing' | 'media-corrupt' | 'media-unverified'

export class ProjectBundleError extends Error {
  readonly code: ProjectBundleErrorCode
  readonly mediaPath: string

  constructor(code: ProjectBundleErrorCode, mediaPath: string, message: string) {
    super(`${mediaPath}: ${message}`)
    this.name = 'ProjectBundleError'
    this.code = code
    this.mediaPath = mediaPath
  }
}

type PortableMedia = Pick<AudioAsset, 'blob' | 'bytes' | 'contentHashSha256' | 'integrity'>

const integrityFailure = (
  path: string,
  integrity: MediaIntegrity,
): ProjectBundleError => {
  const state = integrity.state
  const code: ProjectBundleErrorCode = state === 'missing'
    ? 'media-missing'
    : state === 'corrupt'
      ? 'media-corrupt'
      : 'media-unverified'
  return new ProjectBundleError(
    code,
    path,
    integrity.message ?? `media integrity is ${state}`,
  )
}

/**
 * Verify one portable media record and establish a hash for legacy bytes that
 * predate content-addressed persistence. Missing or damaged bytes are never
 * exported as a seemingly complete bundle.
 */
const makeMediaPortable = async (
  media: PortableMedia,
  path: string,
): Promise<void> => {
  if (media.integrity?.state === 'corrupt') {
    throw integrityFailure(path, media.integrity)
  }
  let integrity = await verifyMediaIntegrity(media)
  if (integrity.state === 'unverified' && !media.contentHashSha256 && integrity.actualHashSha256) {
    media.contentHashSha256 = integrity.actualHashSha256
    integrity = await verifyMediaIntegrity(media)
  }
  media.integrity = integrity
  if (integrity.state !== 'available') throw integrityFailure(path, integrity)
}

const verifyCheckpointForBundle = async (
  checkpoint: ProjectCheckpoint,
): Promise<ProjectCheckpoint> => {
  const portable = validateProjectCheckpoint(structuredClone(checkpoint))
  await Promise.all([
    ...portable.project.assets.map((asset: AudioAsset, index: number) =>
      makeMediaPortable(asset, `project.assets[${index}] (${asset.name || asset.id})`)),
    ...portable.session.candidates.map((candidate: GenerationCandidateSnapshot, index: number) =>
      makeMediaPortable(candidate, `session.candidates[${index}] (${candidate.name || candidate.id})`)),
  ])
  return portable
}

/** Serialize a complete, self-contained project/session checkpoint. */
export async function serializeProjectBundle(checkpoint: ProjectCheckpoint): Promise<string> {
  return serializeProjectCheckpoint(await verifyCheckpointForBundle(checkpoint))
}

/** Parse, validate, decode, and byte-verify a portable project bundle. */
export async function deserializeProjectBundle(serialized: string): Promise<ProjectCheckpoint> {
  return verifyCheckpointForBundle(deserializeProjectCheckpoint(serialized))
}
