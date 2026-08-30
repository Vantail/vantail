/**
 * So `tsc` understands `import App from "./App.vue"`.
 *
 * The usual tool for this is `vue-tsc`, which typechecks the templates too -
 * but it drives the compiler through `typescript/lib/tsc`, which TypeScript 7
 * no longer exports, and this repository is on 7. Until that catches up, the
 * `.ts` files are fully checked and the SFC templates are not.
 */
declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
