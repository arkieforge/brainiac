import { motion } from "motion/react";

import { SPRING } from "../motion.ts";

// Three folders standing in an open cardboard box, back to front, each with a sheet peeking out of it; the box's
// front face covers their feet.
const FOLDERS = [
  { tab: 12, color: "#6ea8ff" },
  { tab: 36, color: "#fbbf24" },
  { tab: 58, color: "#4ade80" },
];

/** Files' empty state: a drawn file box whose folders lift a little when you point at it. Decoration only. */
export function FileBox() {
  return (
    <motion.svg
      viewBox="0 0 160 110"
      className="file-box"
      aria-hidden
      initial="rest"
      whileHover="lift"
      animate="rest"
    >
      <path d="M22 44 L118 44 L138 34 L42 34 Z" fill="#3a2f22" />
      {FOLDERS.map(({ tab, color }, i) => (
        <motion.g
          key={color}
          variants={{ rest: { y: 0 }, lift: { y: -5 - i * 3 } }}
          transition={{ ...SPRING, delay: i * 0.04 }}
        >
          <rect x={30 + i * 6} y={31 + i * 7} width="70" height="40" rx="1.5" fill="#f4f4f2" />
          <rect x={24 + i * 6 + tab} y={30 + i * 7} width="20" height="9" rx="2" fill={color} />
          <rect x={24 + i * 6} y={36 + i * 7} width="82" height="50" rx="2" fill={color} />
        </motion.g>
      ))}
      <path d="M20 58 L118 58 L118 100 L20 100 Z" fill="#8a6a45" />
      <path d="M118 58 L140 46 L140 88 L118 100 Z" fill="#6e5436" />
      <path d="M20 58 L118 58 L108 70 L10 70 Z" fill="#a07c52" />
      <rect x="54" y="78" width="30" height="10" rx="2" fill="#f4f4f2" opacity="0.85" />
    </motion.svg>
  );
}
