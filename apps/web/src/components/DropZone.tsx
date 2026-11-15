import { CloudArrowUp } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useState, type DragEvent } from "react";

import { cn } from "../lib/cn.ts";
import { SPRING } from "../motion.ts";

const RINGS = [0, 1];

/**
 * Where a file goes in: nested dashed frames that open outward while a file is held over them, and settle
 * when it lands. Click or Enter picks a file the usual way.
 */
export function DropZone({
  busy,
  onFile,
}: {
  readonly busy: boolean;
  readonly onFile: (file: File) => void;
}) {
  const [over, setOver] = useState(false);
  const take = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file && !busy) onFile(file);
  };
  return (
    <label
      className={cn(
        "dropzone relative grid h-12 cursor-pointer place-items-center overflow-hidden rounded-[14px] bg-raised text-faint transition-colors",
        over && "text-fg",
        busy && "cursor-progress opacity-70",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={take}
    >
      {RINGS.map((ring) => (
        <motion.span
          key={ring}
          aria-hidden
          className={cn(
            "pointer-events-none absolute rounded-[12px] border border-dashed border-line-strong",
            over && "border-accent",
          )}
          initial={false}
          animate={{ inset: over ? 2 + ring * 6 : 5 + ring * 5, opacity: 1 - ring * 0.3 }}
          transition={{ ...SPRING, delay: ring * 0.03 }}
        />
      ))}
      <motion.span
        className="pointer-events-none relative flex items-center gap-2 text-xs"
        animate={{ scale: over ? 1.06 : 1, y: over ? -2 : 0 }}
        transition={SPRING}
      >
        <CloudArrowUp size={16} weight={over ? "fill" : "regular"} />
        {busy ? "Uploading…" : over ? "Let go to add it" : "Drop a file, or choose one"}
      </motion.span>
      <input
        type="file"
        className="sr-only"
        disabled={busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onFile(file);
        }}
      />
    </label>
  );
}
