import type { Action, ActionResult } from "./types";
import { UndoIcon, RedoIcon } from "../components/icons";
import { ToolButton } from "../components/ToolButton";
import { t } from "../i18n";
import type { History } from "../history";
import { HistoryChangedEvent } from "../history";
import type { AppClassProperties, AppState } from "../types";
import { KEYS, matchKey } from "../keys";
import { arrayToMap } from "../utils";
import { isWindows } from "../constants";
import type { SceneElementsMap } from "../element/types";
import type { Store } from "../store";
import { CaptureUpdateAction } from "../store";
import { useEmitter } from "../hooks/useEmitter";

const executeHistoryAction = (
  app: AppClassProperties,
  appState: Readonly<AppState>,
  updater: (preserveAppState: boolean) => [SceneElementsMap, AppState] | void,
): ActionResult => {
  const preserveAppState = !!(
    appState.multiElement ||
    appState.resizingElement ||
    appState.editingTextElement ||
    appState.newElement ||
    appState.selectedElementsAreBeingDragged ||
    appState.selectionElement ||
    appState.editingLinearElement ||
    appState.croppingElementId ||
    appState.cursorButton === "down" ||
    app.flowChartCreator.isCreatingChart
  );
  const result = updater(preserveAppState);

  if (!result) {
    return { captureUpdate: CaptureUpdateAction.EVENTUALLY };
  }

  const [nextElementsMap, nextAppState] = result;
  return {
    appState: preserveAppState ? appState : nextAppState,
    elements: Array.from(nextElementsMap.values()),
    captureUpdate: CaptureUpdateAction.NEVER,
  };
};

type ActionCreator = (history: History, store: Store) => Action;

export const createUndoAction: ActionCreator = (history, store) => ({
  name: "undo",
  label: "buttons.undo",
  icon: UndoIcon,
  viewMode: false,
  perform: (elements, appState, value, app) =>
    executeHistoryAction(app, appState, (preserveAppState) =>
      history.undo(
        arrayToMap(elements) as SceneElementsMap, // TODO: #7348 refactor action manager to already include `SceneElementsMap`
        appState,
        store.snapshot,
        (ids) => app.canApplyHumanEdit(ids, "undo"),
        { preserveAppState },
      ),
    ),
  keyTest: (event) =>
    event[KEYS.CTRL_OR_CMD] && matchKey(event, KEYS.Z) && !event.shiftKey,
  PanelComponent: ({ updateData, data }) => {
    const { isUndoStackEmpty } = useEmitter<HistoryChangedEvent>(
      history.onHistoryChangedEmitter,
      new HistoryChangedEvent(
        history.isUndoStackEmpty,
        history.isRedoStackEmpty,
      ),
    );

    return (
      <ToolButton
        type="button"
        icon={UndoIcon}
        aria-label={t("buttons.undo")}
        onClick={updateData}
        size={data?.size || "medium"}
        disabled={isUndoStackEmpty}
        data-testid="button-undo"
      />
    );
  },
});

export const createRedoAction: ActionCreator = (history, store) => ({
  name: "redo",
  label: "buttons.redo",
  icon: RedoIcon,
  viewMode: false,
  perform: (elements, appState, _, app) =>
    executeHistoryAction(app, appState, (preserveAppState) =>
      history.redo(
        arrayToMap(elements) as SceneElementsMap, // TODO: #7348 refactor action manager to already include `SceneElementsMap`
        appState,
        store.snapshot,
        (ids) => app.canApplyHumanEdit(ids, "redo"),
        { preserveAppState },
      ),
    ),
  keyTest: (event) =>
    (event[KEYS.CTRL_OR_CMD] && event.shiftKey && matchKey(event, KEYS.Z)) ||
    (isWindows && event.ctrlKey && !event.shiftKey && matchKey(event, KEYS.Y)),
  PanelComponent: ({ updateData, data }) => {
    const { isRedoStackEmpty } = useEmitter(
      history.onHistoryChangedEmitter,
      new HistoryChangedEvent(
        history.isUndoStackEmpty,
        history.isRedoStackEmpty,
      ),
    );

    return (
      <ToolButton
        type="button"
        icon={RedoIcon}
        aria-label={t("buttons.redo")}
        onClick={updateData}
        size={data?.size || "medium"}
        disabled={isRedoStackEmpty}
        data-testid="button-redo"
      />
    );
  },
});
