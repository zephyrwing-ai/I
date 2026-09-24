import type { ActionManager } from "../actions/manager";
import { t } from "../i18n";
import { SHAPES } from "../shapes";
import type { AppClassProperties, AppProps, UIAppState } from "../types";
import { capitalizeString } from "../utils";
import { ToolButton } from "./ToolButton";
import { trackEvent } from "../analytics";
import clsx from "clsx";
import { actionToggleZenMode } from "../actions";
import { Tooltip } from "./Tooltip";
import "./Actions.scss";

export const ShapesSwitcher = ({
  activeTool,
  appState,
  app,
  UIOptions,
}: {
  activeTool: UIAppState["activeTool"];
  appState: UIAppState;
  app: AppClassProperties;
  UIOptions: AppProps["UIOptions"];
}) => (
  <>
    {SHAPES.map(({ value, icon, key, numericKey, fillable }) => {
      if (
        UIOptions.tools?.[
          value as Extract<typeof value, keyof AppProps["UIOptions"]["tools"]>
        ] === false
      ) {
        return null;
      }

      const label = t(`toolBar.${value}`);
      const letter = key && capitalizeString(typeof key === "string" ? key : key[0]);
      const shortcut = letter
        ? `${letter} ${t("helpDialog.or")} ${numericKey}`
        : `${numericKey}`;
      return (
        <ToolButton
          className={clsx("Shape", { fillable })}
          key={value}
          type="radio"
          icon={icon}
          checked={activeTool.type === value}
          name="editor-current-shape"
          title={`${capitalizeString(label)} — ${shortcut}`}
          keyBindingLabel={numericKey || letter}
          aria-label={capitalizeString(label)}
          aria-keyshortcuts={shortcut}
          data-testid={`toolbar-${value}`}
          onPointerDown={({ pointerType }) => {
            if (!appState.penDetected && pointerType === "pen") {
              app.togglePenMode(true);
            }
          }}
          onChange={({ pointerType }) => {
            if (appState.activeTool.type !== value) {
              trackEvent("toolbar", value, "ui");
            }
            if (value === "image") {
              app.setActiveTool({
                type: value,
                insertOnCanvasDirectly: pointerType !== "mouse",
              });
            } else {
              app.setActiveTool({ type: value });
            }
          }}
        />
      );
    })}
  </>
);

export const ZoomActions = ({
  renderAction,
}: {
  renderAction: ActionManager["renderAction"];
}) => renderAction("setZoom");

export const UndoRedoActions = ({
  renderAction,
}: {
  renderAction: ActionManager["renderAction"];
}) => (
  <>
    <Tooltip label={t("buttons.undo")}>
      {renderAction("undo", { size: "small" })}
    </Tooltip>
    <span className="canvas-footer-divider" aria-hidden="true" />
    <Tooltip label={t("buttons.redo")}>
      {renderAction("redo", { size: "small" })}
    </Tooltip>
  </>
);

export const ExitZenModeAction = ({
  actionManager,
  showExitZenModeBtn,
}: {
  actionManager: ActionManager;
  showExitZenModeBtn: boolean;
}) => (
  <button
    type="button"
    className={clsx("disable-zen-mode", {
      "disable-zen-mode--visible": showExitZenModeBtn,
    })}
    onClick={() => actionManager.executeAction(actionToggleZenMode)}
  >
    {t("buttons.exitZenMode")}
  </button>
);

export const FinalizeAction = ({
  renderAction,
  className,
}: {
  renderAction: ActionManager["renderAction"];
  className?: string;
}) => (
  <div className={`finalize-button ${className}`}>
    {renderAction("finalize", { size: "small" })}
  </div>
);
