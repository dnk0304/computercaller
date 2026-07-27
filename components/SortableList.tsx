'use client';

import React from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Announcements,
  type ScreenReaderInstructions,
} from '@dnd-kit/core';
import {
  restrictToVerticalAxis,
  restrictToParentElement,
} from '@dnd-kit/modifiers';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { clsx } from 'clsx';

// ---------------------------------------------------------------------------
// SortableList — shared drag-and-drop reorder primitive for the settings
// template lists (SMS templates + quick replies). Both lists are near-identical
// card-row lists, so the <li> shell and drag handle live here once.
//
// Dispatch CC-reorder-drag-drop (2026-07, Pixel). Replaces the up/down arrow
// reorder (af523ea) with drag-and-drop per Dennis. Built on @dnd-kit — chosen
// over a custom pointer sortable because it ships pointer + touch + keyboard
// sensors AND screen-reader announcements out of the box, so we don't regress
// the a11y the arrows provided (the arrows were the keyboard path).
//
// Accessibility:
//   - The grip handle carries dnd-kit's sortable `attributes` + `listeners`:
//     it is focusable (Tab), lifts on Space/Enter, moves on ↑/↓ (KeyboardSensor
//     + sortableKeyboardCoordinates), and drops on Space/Enter. This is the
//     keyboard reorder path that replaces the removed arrow buttons.
//   - Named live-region announcements (item label + position) so a screen
//     reader user hears "Picked up <label>. Position 2 of 5." etc.
//   - TouchSensor uses press-and-hold (150ms) so a tap-scroll on mobile isn't
//     hijacked into a drag; PointerSensor uses a 6px activation distance so a
//     plain click on a row's Edit/Delete button never starts a drag.
//
// The drop handler computes the new ordered id array and hands it to the caller
// (which calls the hook's optimistic `reorder(orderedIds)`), exactly like the
// old arrow handler did — the list is NOT re-sorted here.
// ---------------------------------------------------------------------------

const screenReaderInstructions: ScreenReaderInstructions = {
  draggable:
    'To reorder, press Space or Enter to pick up an item, use the Up and Down arrow keys to move it, then press Space or Enter again to drop it. Press Escape to cancel.',
};

interface SortableListProps {
  /** The ordered ids currently rendered — the source of truth for positions. */
  ids: string[];
  /** Called with the new front-to-back ordered ids after a drop. */
  onReorder: (orderedIds: string[]) => void;
  /** Human label for an id, used in screen-reader announcements. */
  getItemLabel: (id: string) => string;
  /** Accessible name for the whole list (e.g. "message templates"). */
  listLabel: string;
  className?: string;
  children: React.ReactNode;
}

export function SortableList({
  ids,
  onReorder,
  getItemLabel,
  listLabel,
  className,
  children,
}: SortableListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // A small distance so clicking a row's action button never starts a drag.
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      // Press-and-hold on touch so vertical scrolling still works normally.
      activationConstraint: { delay: 150, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(ids, oldIndex, newIndex));
  };

  // Named announcements — dnd-kit's defaults use the raw id, so we override to
  // speak the item's label and 1-based position for a clearer SR experience.
  const announcements: Announcements = {
    onDragStart({ active }) {
      const pos = ids.indexOf(String(active.id)) + 1;
      return `Picked up ${getItemLabel(String(active.id))}. It is in position ${pos} of ${ids.length}.`;
    },
    onDragOver({ active, over }) {
      if (!over) return undefined;
      const pos = ids.indexOf(String(over.id)) + 1;
      return `${getItemLabel(String(active.id))} was moved to position ${pos} of ${ids.length}.`;
    },
    onDragEnd({ active, over }) {
      if (!over) return `${getItemLabel(String(active.id))} was dropped.`;
      const pos = ids.indexOf(String(over.id)) + 1;
      return `${getItemLabel(String(active.id))} was dropped at position ${pos} of ${ids.length}.`;
    },
    onDragCancel({ active }) {
      return `Reordering cancelled. ${getItemLabel(String(active.id))} was returned to its original position.`;
    },
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      accessibility={{ announcements, screenReaderInstructions }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className={className} aria-label={listLabel}>
          {children}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

interface SortableRowProps {
  /** Must match an id in the parent SortableList's `ids`. */
  id: string;
  /** Accessible label for the drag handle (e.g. the item name). */
  label: string;
  /** Row content — rendered after the drag handle inside the shared card shell. */
  children: React.ReactNode;
}

/**
 * A single draggable card row. Renders the shared `<li>` card shell + a grip
 * drag handle, then the caller's row content. The handle is the drag activator
 * and the keyboard reorder control.
 */
export function SortableRow({ id, label, children }: SortableRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={clsx(
        'group bg-white rounded-2xl border transition-all p-4 flex items-center gap-3',
        isDragging
          ? 'border-blue-300 shadow-lg ring-2 ring-blue-500/20 relative z-10'
          : 'border-slate-200 hover:border-slate-300 hover:shadow-sm',
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${label}`}
        title={`Drag to reorder ${label}`}
        className="flex-shrink-0 -ml-1 cursor-grab touch-none rounded-lg p-1.5 text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" aria-hidden="true" />
      </button>
      {children}
    </li>
  );
}
