import { Icon } from "../../dist/react.js";

export function render(name, props) {
  return Icon({ name, ...props });
}
