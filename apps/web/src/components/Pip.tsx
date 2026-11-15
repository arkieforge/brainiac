import { motion } from "motion/react";
import type { ReactNode } from "react";
import { KuroRocketSticker, PipCoffeeSticker, PipDetectiveSticker, PipThinkingSticker } from "stick-it-up";

// Pip is the record's mascot (DESIGN.md): a sticker that says one short, true thing. Each pose has one job.
const POSES = {
  detective: PipDetectiveSticker,
  thinking: PipThinkingSticker,
  coffee: PipCoffeeSticker,
  rocket: KuroRocketSticker,
} as const;

/** Pip in a pose with a speech bubble. The sticker lifts and straightens on hover, like a peeled corner. */
export function Pip({
  sticker,
  say,
  size = 56,
}: {
  readonly sticker: keyof typeof POSES;
  readonly say: ReactNode;
  readonly size?: number;
}) {
  const Pose = POSES[sticker];
  return (
    <div className="pip">
      <motion.span
        className="pip-sticker"
        initial={{ rotate: -14, scale: 0.6, opacity: 0 }}
        animate={{ rotate: -6, scale: 1, opacity: 1 }}
        whileHover={{ rotate: 0, y: -3, scale: 1.06 }}
        transition={{ type: "spring", stiffness: 380, damping: 16 }}
      >
        <Pose size={size} aria-hidden />
      </motion.span>
      <motion.p
        className="pip-say"
        initial={{ opacity: 0, x: -6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 0.08 }}
      >
        {say}
      </motion.p>
    </div>
  );
}
