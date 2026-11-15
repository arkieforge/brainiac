import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names and lets a later Tailwind utility override an earlier one (shadcn's `cn`). */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
