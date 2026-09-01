'use client';

import React, { useId } from 'react';
import { clsx } from 'clsx';

type Placement = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  /** Text shown in the floating bubble AND wired to the trigger via
   *  aria-describedby, so screen-reader + pointer + keyboard users all get it. */
  label: string;
  placement?: Placement;
  /** A single focusable/hoverable element (button, a, role=button div). */
  children: React.ReactElement;
  className?: string;
}

const POS: Record<Placement, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
  left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
  right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
};

/**
 * Shared tooltip primitive for icon-only controls. No library.
 *
 * Shows on pointer hover AND on keyboard focus (group-focus-within), so
 * icon-only buttons that lost their text label stay discoverable for both
 * mouse and keyboard users. The bubble is linked to the trigger with
 * aria-describedby for assistive tech; keep the trigger's own aria-label too.
 * Respects prefers-reduced-motion (motion-reduce disables the transition).
 */
export const Tooltip: React.FC<TooltipProps> = ({
  label,
  placement = 'top',
  children,
  className,
}) => {
  const id = useId();
  return (
    <span className="group/tt relative inline-flex">
      {React.cloneElement(children as React.ReactElement<Record<string, unknown>>, { 'aria-describedby': id })}
      <span
        role="tooltip"
        id={id}
        className={clsx(
          'pointer-events-none absolute z-[60] whitespace-nowrap rounded-md',
          'bg-slate-900 px-2 py-1 text-[11px] font-medium text-white shadow-lg',
          'opacity-0 scale-95 transition duration-150 ease-out',
          'group-hover/tt:opacity-100 group-hover/tt:scale-100',
          'group-focus-within/tt:opacity-100 group-focus-within/tt:scale-100',
          'motion-reduce:transition-none',
          POS[placement],
          className
        )}
      >
        {label}
      </span>
    </span>
  );
};

export default Tooltip;
