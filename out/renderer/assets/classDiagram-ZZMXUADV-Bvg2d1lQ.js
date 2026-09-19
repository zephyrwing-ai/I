import { s as styles_default, c as classRenderer_v3_unified_default, a as classDiagram_default, C as ClassDB } from "./chunk-TICWLB2K-DgBeTU7n.js";
import { _ as __name } from "./index-CqW0jvAG.js";
import "./chunk-5VM5RSS4-igbm8z9W.js";
import "./chunk-XXDRQBXY-B2uRGa7x.js";
import "./chunk-POPQ4Y6H-B9cuv5nW.js";
import "./chunk-F27PBJKO-DRzi_C7Y.js";
import "./index-Y7B1nPdt.js";
var diagram = {
  parser: classDiagram_default,
  get db() {
    return new ClassDB();
  },
  renderer: classRenderer_v3_unified_default,
  styles: styles_default,
  init: /* @__PURE__ */ __name((cnf) => {
    if (!cnf.class) {
      cnf.class = {};
    }
    cnf.class.arrowMarkerAbsolute = cnf.arrowMarkerAbsolute;
  }, "init")
};
export {
  diagram
};
