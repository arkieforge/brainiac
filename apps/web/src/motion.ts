// The design system's timing for JS animation (motion, auto-animate); styles.css holds the same as --ease, --base
// and --spring. Short and decisive, with a little overshoot on springs: everything here answers something the
// person did.
const EASE = [0.23, 1, 0.32, 1] as const;
export const BASE = { duration: 0.16, ease: EASE };
/** Pills, cards and anything that follows the hand. */
export const SPRING = { type: "spring", stiffness: 420, damping: 26, mass: 0.8 } as const;
/** Whether the person asked for less motion. Animations started by hand (`element.animate`) check it themselves. */
export const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** The same, for auto-animate's lists. */
export const LIST = { duration: 160, easing: `cubic-bezier(${EASE.join(", ")})` };
