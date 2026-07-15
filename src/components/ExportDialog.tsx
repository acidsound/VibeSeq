import { useState } from 'react';
import { CircleStop, Download, FileArchive, FileAudio, FileMusic, Sparkles, X } from 'lucide-react';
import type { WavExportProgress } from '../core';
import { useModalFocus } from '../hooks/useModalFocus';
import type { Project, ProjectSampleRate } from '../types';
import type { WavExportTarget } from '../ui/wavExportTarget';

interface ExportDialogProps {
  project: Project;
  progress: WavExportProgress | null;
  onClose: () => void;
  onSampleRateChange: (sampleRate: ProjectSampleRate) => void;
  onExportMix: (
    target: WavExportTarget,
    bitDepth: 16 | 24 | 32,
    protectPeaks: boolean,
    sampleRate: ProjectSampleRate,
  ) => void;
  onExportAllTracks: (
    bitDepth: 16 | 24 | 32,
    protectPeaks: boolean,
    sampleRate: ProjectSampleRate,
  ) => void;
  onCancelMix: () => void;
  onExportMidi: () => void;
}

const phaseLabel = (progress: WavExportProgress): string => {
  if (progress.phase === 'preparing') return 'Saving project state';
  if (progress.phase === 'decoding') return 'Decoding verified source audio';
  if (progress.phase === 'mixing') return 'Mixing tracks';
  if (progress.phase === 'analyzing') return 'Analyzing inter-sample peaks';
  if (progress.phase === 'encoding') return 'Encoding WAV frames';
  if (progress.phase === 'packaging') return 'Packaging aligned stems';
  return 'Cancelling local render';
};

export function ExportDialog({
  project,
  progress,
  onClose,
  onSampleRateChange,
  onExportMix,
  onExportAllTracks,
  onCancelMix,
  onExportMidi,
}: ExportDialogProps) {
  const [bitDepth, setBitDepth] = useState<16 | 24 | 32>(24);
  const [sampleRate, setSampleRate] = useState<ProjectSampleRate>(project.sampleRate);
  const [protectPeaks, setProtectPeaks] = useState(true);
  const [renderLabel, setRenderLabel] = useState('Arrangement');
  const dialogRef = useModalFocus<HTMLElement>();
  const busy = progress !== null;
  const progressPercent = Math.round((progress?.progress ?? 0) * 100);
  const formatLabel = bitDepth === 16
    ? '16-bit PCM · deterministic TPDF dither'
    : bitDepth === 24
      ? '24-bit PCM · no dither'
      : '32-bit float · no dither';
  const rateLabel = sampleRate === 44_100 ? '44.1 kHz' : '48 kHz';
  const requestWavExport = (target: WavExportTarget, label: string) => {
    setRenderLabel(label);
    onExportMix(target, bitDepth, protectPeaks, sampleRate);
  };
  const requestAllTracksExport = () => {
    setRenderLabel('All individual tracks');
    onExportAllTracks(bitDepth, protectPeaks, sampleRate);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="dialog export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div><p className="eyebrow">LOCAL RENDER</p><h2 id="export-dialog-title">Export arrangement</h2></div>
          <button
            autoFocus
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label={busy ? 'Cancel render and close export dialog' : 'Close export dialog'}
          ><X /></button>
        </header>
        <p>Rendering happens in a local background worker. Generated source files and project data are not uploaded.</p>

        <div className="export-settings">
          <label>
            <span>Project sample rate</span>
            <select
              aria-label="Project sample rate"
              value={sampleRate}
              disabled={busy}
              onChange={(event) => {
                const next = Number(event.target.value) as ProjectSampleRate;
                setSampleRate(next);
                onSampleRateChange(next);
              }}
            >
              <option value={44_100}>44.1 kHz</option>
              <option value={48_000}>48 kHz</option>
            </select>
          </label>
          <label>
            <span>WAV depth</span>
            <select
              aria-label="WAV bit depth"
              value={bitDepth}
              disabled={busy}
              onChange={(event) => setBitDepth(Number(event.target.value) as 16 | 24 | 32)}
            >
              <option value={16}>16-bit PCM + TPDF</option>
              <option value={24}>24-bit PCM</option>
              <option value={32}>32-bit float</option>
            </select>
          </label>
          <p className="export-format-note" aria-live="polite">{formatLabel}</p>
          <label className="export-protection">
            <input
              type="checkbox"
              checked={protectPeaks}
              disabled={busy}
              onChange={(event) => setProtectPeaks(event.target.checked)}
            />
            <span>
              <b>Protect 4× inter-sample peaks above −0.18 dBFS</b>
              <small>Attenuates only clipping-risk mixes and reports applied gain. This deterministic cubic estimate is not a certified true-peak meter.</small>
            </span>
          </label>
        </div>

        {progress && (
          <div className="export-render-progress" role="status" aria-live="polite">
            <span><b>{renderLabel} · {phaseLabel(progress)}</b><output>{progressPercent}%</output></span>
            <div
              role="progressbar"
              aria-label="WAV export progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent}
            ><i style={{ width: `${progressPercent}%` }} /></div>
            <button type="button" onClick={onCancelMix} disabled={progress.phase === 'cancelling'}>
              <CircleStop />{progress.phase === 'cancelling' ? 'Cancelling…' : 'Cancel render'}
            </button>
          </div>
        )}

        <div className="export-options">
          <button type="button" onClick={() => requestWavExport({ kind: 'project' }, 'Full mix')} disabled={busy}>
            <span><FileAudio /></span><div><b>Full mix · WAV</b><small>{rateLabel} · {formatLabel} · stereo · project length</small></div><Download />
          </button>
          <button type="button" onClick={() => requestWavExport({ kind: 'loop' }, 'Loop range')} disabled={busy || !project.loop.enabled}>
            <span><Sparkles /></span><div><b>Loop range · WAV</b><small>{rateLabel} · {project.loop.startBeat.toFixed(1)} → {project.loop.endBeat.toFixed(1)} beats</small></div><Download />
          </button>
          <button type="button" onClick={onExportMidi} disabled={busy}>
            <span><FileMusic /></span><div><b>MIDI structure</b><small>All MIDI tracks · SMF format 1</small></div><Download />
          </button>
        </div>

        <section className="export-track-list" aria-labelledby="export-track-list-title">
          <div className="section-label"><span id="export-track-list-title">INDIVIDUAL TRACKS · WAV</span><FileAudio /></div>
          <p>Each track is rendered in isolation from project time zero to the project end. Track gain, pan, clips, fades, instruments, and master gain are retained; track Mute and other Solo states are ignored for the requested file.</p>
          {project.tracks.length === 0
            ? <small className="export-track-empty">Add an Audio or MIDI track before exporting an individual track.</small>
            : <>
              <button
                className="export-track-zip"
                type="button"
                disabled={busy}
                onClick={requestAllTracksExport}
              >
                <span><FileArchive /></span>
                <span><b>All individual tracks · ZIP</b><small>{project.tracks.length} aligned WAV file{project.tracks.length === 1 ? '' : 's'} + manifest</small></span>
                <Download />
              </button>
              <div className="export-track-rows">
                {project.tracks.map((track, index) => {
                  const sequence = String(index + 1).padStart(2, '0');
                  return <button
                    type="button"
                    key={track.id}
                    disabled={busy}
                    aria-label={`Export track ${index + 1} ${track.name} as WAV`}
                    onClick={() => requestWavExport({ kind: 'track', trackId: track.id }, `Track ${sequence} · ${track.name}`)}
                  >
                    <span>{track.kind === 'audio' ? <FileAudio /> : <FileMusic />}</span>
                    <span><b>{sequence} · {track.name}</b><small>{track.kind === 'audio' ? 'Audio' : 'MIDI'} · {track.clips.length} region{track.clips.length === 1 ? '' : 's'}{track.mute ? ' · muted in arrangement' : ''}</small></span>
                    <Download />
                  </button>;
                })}
              </div>
            </>}
        </section>
      </section>
    </div>
  );
}
