/**
 * BoundedIntInput — a number field for admin knobs with a hard [min, max] range.
 *
 * Edits a local DRAFT string and commits (parsed + clamped) only on blur / Enter — clamping on
 * every keystroke snapped an emptied field to the minimum and fought the next digit (the bug the
 * auto-submit seconds input hit first). Garbage or an empty field reverts to the saved value. An
 * unchanged value emits no `onCommit`. Shared by the auto-submit seconds, the two judge knobs and the
 * question editor's max-follow-ups (issue #114, review D9) so the behaviour can't drift.
 */
import { useEffect, useState } from "react";
import { Input } from "@fluentui/react-components";

export interface BoundedIntInputProps {
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  disabled?: boolean;
  "data-testid"?: string;
  "aria-label"?: string;
  size?: "small" | "medium" | "large";
}

export function BoundedIntInput({
  value,
  min,
  max,
  onCommit,
  disabled,
  size,
  "data-testid": testId,
  "aria-label": ariaLabel,
}: BoundedIntInputProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n) || draft.trim() === "") {
      setDraft(String(value)); // garbage / empty → revert to the saved value
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <Input
      type="number"
      value={draft}
      min={min}
      max={max}
      step={1}
      size={size}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(_, d) => setDraft(d.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      data-testid={testId}
    />
  );
}
