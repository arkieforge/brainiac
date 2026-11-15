import { useEffect, useRef } from "react";

import { calm } from "../motion.ts";

const COLORS = ["var(--accent)", "var(--ok)", "var(--warn)", "var(--fg)"];

/** A one-shot burst of confetti from its centre, for finishing a review. Skipped under reduced motion. */
export function Burst() {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = host.current;
    if (!node || calm()) return;
    const pieces = Array.from({ length: 28 }, (_, i) => {
      const piece = document.createElement("i");
      piece.style.background = COLORS[i % COLORS.length] ?? "";
      node.append(piece);
      const angle = Math.random() * Math.PI * 2;
      const distance = 60 + Math.random() * 100;
      return piece.animate(
        [
          { transform: "translate(0, 0) rotate(0deg)", opacity: 1 },
          {
            transform: `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance + 40}px) rotate(${Math.random() * 360}deg)`,
            opacity: 0,
          },
        ],
        { duration: 900 + Math.random() * 400, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "forwards" },
      );
    });
    return () => {
      for (const animation of pieces) animation.cancel();
      node.replaceChildren();
    };
  }, []);
  return <span className="burst" ref={host} aria-hidden />;
}
