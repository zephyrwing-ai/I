import React from "react";
import type {
  Action,
  UpdaterFn,
  ActionName,
  ActionResult,
  PanelComponentProps,
} from "./types";
import type { OrderedCanvasEditorElement } from "../element/types";
import type { AppClassProperties, AppState } from "../types";
import { isPromiseLike } from "../utils";
import { getActionHumanEditTargets } from "./editProtection";

export class ActionManager {
  actions = {} as Record<ActionName, Action>;

  updater: (actionResult: ActionResult | Promise<ActionResult>) => void;

  getAppState: () => Readonly<AppState>;
  getElementsIncludingDeleted: () => readonly OrderedCanvasEditorElement[];
  app: AppClassProperties;

  constructor(
    updater: UpdaterFn,
    getAppState: () => AppState,
    getElementsIncludingDeleted: () => readonly OrderedCanvasEditorElement[],
    app: AppClassProperties,
  ) {
    this.updater = (actionResult) => {
      if (isPromiseLike(actionResult)) {
        actionResult.then((actionResult) => {
          return updater(actionResult);
        });
      } else {
        return updater(actionResult);
      }
    };
    this.getAppState = getAppState;
    this.getElementsIncludingDeleted = getElementsIncludingDeleted;
    this.app = app;
  }

  registerAction(action: Action) {
    this.actions[action.name] = action;
  }

  registerAll(actions: readonly Action[]) {
    actions.forEach((action) => this.registerAction(action));
  }

  handleKeyDown(event: React.KeyboardEvent | KeyboardEvent) {
    const canvasActions = this.app.props.UIOptions.canvasActions;
    const data = Object.values(this.actions)
      .sort((a, b) => (b.keyPriority || 0) - (a.keyPriority || 0))
      .filter(
        (action) =>
          (action.name in canvasActions
            ? canvasActions[action.name as keyof typeof canvasActions]
            : true) &&
          action.keyTest &&
          action.keyTest(
            event,
            this.getAppState(),
            this.getElementsIncludingDeleted(),
            this.app,
          ),
      );

    if (data.length !== 1) {
      if (data.length > 1) {
        console.warn("Canceling as multiple actions match this shortcut", data);
      }
      return false;
    }

    const action = data[0];

    if (this.getAppState().viewModeEnabled && action.viewMode !== true) {
      return false;
    }

    const elements = this.getElementsIncludingDeleted();
    const appState = this.getAppState();
    const value = null;

    event.preventDefault();
    event.stopPropagation();
    this.performAction(action, elements, appState, value);
    return true;
  }

  executeAction<T extends Action>(
    action: T,
    value: Parameters<T["perform"]>[2] = null,
  ) {
    const elements = this.getElementsIncludingDeleted();
    const appState = this.getAppState();

    this.performAction(action, elements, appState, value);
  }

  private performAction(
    action: Action,
    elements: readonly OrderedCanvasEditorElement[],
    appState: Readonly<AppState>,
    value: Parameters<Action["perform"]>[2],
  ) {
    const targets = getActionHumanEditTargets(action.name, elements, appState);
    if (targets !== null && !this.app.canApplyHumanEdit(targets, action.name)) {
      return;
    }
    this.updater(action.perform(elements, appState, value, this.app));
  }

  /**
   * @param data additional data sent to the PanelComponent
   */
  renderAction = (name: ActionName, data?: PanelComponentProps["data"]) => {
    const canvasActions = this.app.props.UIOptions.canvasActions;

    if (
      this.actions[name] &&
      "PanelComponent" in this.actions[name] &&
      (name in canvasActions
        ? canvasActions[name as keyof typeof canvasActions]
        : true)
    ) {
      const action = this.actions[name];
      const PanelComponent = action.PanelComponent!;
      PanelComponent.displayName = "PanelComponent";
      const updateData = (formState?: any) => {
        this.executeAction(action, formState);
      };

      return (
        <PanelComponent
          elements={this.getElementsIncludingDeleted()}
          appState={this.getAppState()}
          updateData={updateData}
          appProps={this.app.props}
          app={this.app}
          data={data}
        />
      );
    }

    return null;
  };

  isActionEnabled = (action: Action) => {
    const elements = this.getElementsIncludingDeleted();
    const appState = this.getAppState();

    return (
      !action.predicate ||
      action.predicate(elements, appState, this.app.props, this.app)
    );
  };
}
