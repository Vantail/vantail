import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * shadcn's class helper, unchanged.
 *
 * `clsx` flattens the conditional bits; `twMerge` is what makes a `className`
 * passed in from outside beat the component's own - without it `p-0` next to a
 * built-in `p-4` is a coin toss on source order.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
