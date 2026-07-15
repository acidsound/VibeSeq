import { describe, expect, it } from 'vitest';
import { verifyMediaIntegrity } from './audio/hash';
import { assertProjectArrangementInvariants } from './projectInvariants';
import {
  CAPACITY_REFERENCE_TARGET,
  createCapacityReferenceFixture,
  inspectCapacityReference,
} from './capacityReference';

describe('capacity reference project', () => {
  it('builds the exact supported 10-minute reference shape without inventing automation', async () => {
    const fixture = await createCapacityReferenceFixture();
    assertProjectArrangementInvariants(fixture.project);
    expect(inspectCapacityReference(fixture.project)).toEqual(fixture.summary);
    expect(fixture.summary).toMatchObject({
      durationSeconds: CAPACITY_REFERENCE_TARGET.durationSeconds,
      durationBeats: CAPACITY_REFERENCE_TARGET.durationBeats,
      trackCount: CAPACITY_REFERENCE_TARGET.trackCount,
      clipCount: CAPACITY_REFERENCE_TARGET.clipCount,
      midiNoteCount: CAPACITY_REFERENCE_TARGET.midiNoteCount,
      automationTrackCount: 0,
      importedSampleRates: [...CAPACITY_REFERENCE_TARGET.importedSampleRates],
    });
    expect(fixture.summary.unsupportedFeatures).toEqual([
      'Track automation is not represented in the current Project schema.',
    ]);
    expect(await Promise.all(fixture.project.assets.map(verifyMediaIntegrity))).toEqual(
      fixture.project.assets.map((asset) => ({
        state: 'available',
        expectedHashSha256: asset.contentHashSha256,
        actualHashSha256: asset.contentHashSha256,
      })),
    );
  }, 30_000);
});
