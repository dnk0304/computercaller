'use client';

import React, { useCallback, useId, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, Pause, Plus, X } from 'lucide-react';

import type { QueueState } from '@/lib/fileTransfer/queue.ts';
import { queueCounts } from '@/lib/fileTransfer/queue.ts';
import type { TransferProgress } from '@/lib/fileTransfer/types.ts';
import {
  FT_QUEUE_ADD, FT_QUEUE_CLEAR_FINISHED, FT_QUEUE_PAUSED, FT_QUEUE_RESUME, FT_QUEUE_TITLE,
  ftFailureCopy, ftQueueCount, ftQueueDoneCount, ftQueueFailedCount,
} from './ftCopy';
import { formatBytes, formatEta, formatRate, percentOf, phaseLabel } from './ftFormat';
import { FileQueueList } from './FileQueueList';
import type { QueueRetryResult } from './FileQueueList';

/**
 * components/fileTransfer/FileQueueTray.tsx — FILE-QUEUE-WEB. The shell-level
 * "Transfers" strip, painted where the single progress row used to be (under
 * the encryption banner, above the call strip) — shell chrome, never inside a
 * thread (ADDENDUM 1: no per-conversation send entry).
 *
 * COLLAPSED: the active transfer (direction, name, %, the one real
 * progressbar, Cancel) + "N queued" + a chevron. With nothing moving it says
 * why: "Paused" with Resume, or what is left ("1 failed", "2 finished").
 * EXPANDED: FileQueueList under the strip, plus "Add files" and "Clear
 * finished". Hidden entirely while the list is empty.
 *
 * `data-cc-ft-progress` stays on the active section with the same
 * direction/phase attributes and the same Cancel, so the FT-3b proof contract
 * for the progress row carries over unchanged.
 *
 * The chevron is a disclosure button (aria-expanded + aria-controls), not a
 * dialog: the list is in-flow and pushes the view, like the row it replaced.
 */

export interface FileQueueTrayProps {
  queue: QueueState;
  progress: TransferProgress | null;
  onCancel: () => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => Promise<QueueRetryResult>;
  onRepick: (id: string, file: File) => void;
  onClear: (id: string) => void;
  onResume: () => void;
  onAdd: (files: File[]) => void;
  openableId?: string | null;
  onOpen?: () => void;
  compact?: boolean;
}

export function FileQueueTray({
  queue, progress, onCancel, onRemove, onRetry, onRepick, onClear, onResume, onAdd,
  openableId, onOpen, compact = false,
}: FileQueueTrayProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const addRef = useRef<HTMLInputElement>(null);

  const onAddChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) onAdd(files);
  }, [onAdd]);

  const clearFinished = useCallback(() => {
    for (const it of queue.items) if (it.state === 'done' || it.state === 'failed') onClear(it.id);
  }, [queue.items, onClear]);

  if (queue.items.length === 0) return null;

  const { queued, active } = queueCounts(queue);
  const failed = queue.items.filter((it) => it.state === 'failed' || it.state === 'needs-file').length;
  const finished = queue.items.filter((it) => it.state === 'done').length;

  // The live numbers come from the transfer machine's own progress record when
  // it is for the active row (rate, ETA); the row alone when it is not yet.
  const live = active && progress && progress.id === active.transferId
    && progress.phase !== 'done' && progress.phase !== 'failed' ? progress : null;
  const phase = live?.phase ?? (active?.state === 'offering' ? 'offered' : 'transferring');
  const measurable = active !== null && phase !== 'offered';
  const pct = active ? percentOf(live?.bytes ?? active.bytes, active.size) : 0;
  const label = active ? phaseLabel(phase, active.direction) : '';
  const eta = live ? formatEta(live.etaSeconds) : null;
  const rate = live ? formatRate(live.bytesPerSecond) : null;
  const detail = active
    ? [`${formatBytes(live?.bytes ?? active.bytes)} of ${formatBytes(active.size)}`, rate, eta].filter(Boolean).join(' · ')
    : '';
  const DirectionIcon = active?.direction === 'receive' ? ArrowDownToLine : ArrowUpFromLine;
  const pausedCopy = queue.paused && queue.lastFailure
    ? ftFailureCopy(queue.lastFailure.reason).message
    : null;

  return (
    <section
      className={`cc-ftq${compact ? ' cc-ftq-compact' : ''}`}
      aria-label={FT_QUEUE_TITLE}
      data-cc-ft-queue="true"
      data-cc-ft-queue-open={open ? 'true' : 'false'}
      data-cc-ft-queue-paused={queue.paused ?? undefined}
    >
      <div className="cc-ftq-strip">
        {active ? (
          <div
            className="cc-ftq-active"
            data-cc-ft-progress="true"
            data-cc-ft-direction={active.direction}
            data-cc-ft-phase={phase}
          >
            <div className="cc-ftq-head">
              <DirectionIcon className="cc-ftq-icon" aria-hidden="true" />
              <span className="cc-ftq-name cc-ftq-grow">{active.name}</span>
              {measurable && <span className="cc-ftq-pct">{pct}%</span>}
              {queued > 0 && <span className="cc-ftq-chip">{ftQueueCount(queued)}</span>}
              <button
                type="button"
                onClick={onCancel}
                data-cc-ft-action="cancel"
                aria-label={`Cancel transfer of ${active.name}`}
                className="cc-ftq-iconbtn"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <p className="cc-ftq-line" aria-live="polite">
              {label}{measurable && detail ? ` — ${detail}` : ''}
            </p>
            <div className="cc-ftq-track">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={measurable ? pct : undefined}
                aria-valuetext={measurable ? [`${pct}%`, eta].filter(Boolean).join(', ') : label}
                aria-label={`${label} ${active.name}`}
                className="cc-ft-bar cc-ftq-fill"
                style={{ width: measurable ? `${pct}%` : '0%' }}
              />
            </div>
          </div>
        ) : (
          <div className="cc-ftq-head cc-ftq-idle">
            {queue.paused ? (
              <>
                <Pause className="cc-ftq-icon cc-ftq-pause" aria-hidden="true" />
                <p className="cc-ftq-grow cc-ftq-summary" aria-live="polite">
                  <span className="cc-ftq-pause">{FT_QUEUE_PAUSED}</span>
                  {pausedCopy && <span className="cc-ftq-line"> {pausedCopy}</span>}
                </p>
                {queued > 0 && <span className="cc-ftq-chip">{ftQueueCount(queued)}</span>}
                <button
                  type="button"
                  onClick={onResume}
                  data-cc-ft-queue-action="resume"
                  className="cc-ftq-btn cc-ftq-btn-strong"
                >
                  {FT_QUEUE_RESUME}
                </button>
              </>
            ) : (
              <p className="cc-ftq-grow cc-ftq-summary">
                <span className="cc-ftq-name">{FT_QUEUE_TITLE}</span>
                <span className="cc-ftq-line">
                  {[
                    queued > 0 ? ftQueueCount(queued) : null,
                    failed > 0 ? ftQueueFailedCount(failed) : null,
                    finished > 0 ? ftQueueDoneCount(finished) : null,
                  ].filter(Boolean).map((t) => ` · ${t}`).join('')}
                </span>
              </p>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`${FT_QUEUE_TITLE}: ${open ? 'hide' : 'show'} list`}
          data-cc-ft-queue-action="toggle"
          className="cc-ftq-iconbtn cc-ftq-chevron"
        >
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {open && (
        <div className="cc-ftq-sheet">
          <FileQueueList
            id={listId}
            items={queue.items}
            onRemove={onRemove}
            onRetry={onRetry}
            onRepick={onRepick}
            onClear={onClear}
            openableId={openableId}
            onOpen={onOpen}
            compact={compact}
          />
          <div className="cc-ftq-foot">
            <input
              ref={addRef}
              type="file"
              multiple
              className="sr-only"
              onChange={onAddChange}
              tabIndex={-1}
              aria-hidden="true"
              data-cc-ft-queue-add-input="true"
            />
            <button
              type="button"
              onClick={() => addRef.current?.click()}
              data-cc-ft-queue-action="add"
              className="cc-ftq-btn"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {FT_QUEUE_ADD}
            </button>
            {(failed > 0 || finished > 0) && (
              <button
                type="button"
                onClick={clearFinished}
                data-cc-ft-queue-action="clear-finished"
                className="cc-ftq-btn"
              >
                {FT_QUEUE_CLEAR_FINISHED}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
