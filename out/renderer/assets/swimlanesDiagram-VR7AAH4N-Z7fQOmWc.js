import { c as createFlowDiagram, s as styles_default } from "./flowDiagram-HODETNUW-CkRZHGtf.js";
import { _ as __name } from "./index-CqW0jvAG.js";
import "./chunk-5VM5RSS4-igbm8z9W.js";
import "./chunk-XXDRQBXY-B2uRGa7x.js";
import "./chunk-POPQ4Y6H-B9cuv5nW.js";
import "./chunk-F27PBJKO-DRzi_C7Y.js";
import "./channel-CEESYjJg.js";
import "./index-Y7B1nPdt.js";
var getStyles = /* @__PURE__ */ __name((options) => `${styles_default(options)}
  .swimlane.cluster rect {
    stroke: ${options.clusterBorder} !important;
  }
  [data-look="neo"].cluster rect {
    filter: none;
  }
`, "getStyles");
var styles_default2 = getStyles;
var diagram = createFlowDiagram({ defaultLayout: "swimlane", styles: styles_default2 });
export {
  diagram
};
