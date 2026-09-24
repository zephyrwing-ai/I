import type { JSX } from "react";
import React from "react";
import type {
  AppClassProperties,
  AppProps,
  AppState,
  PointerCoords,
  ExcalidrawProps,
  UIAppState,
} from "../types";
import type { ActionManager } from "../actions/manager";
import { t } from "../i18n";
import Stack from "./Stack";
import type { NonDeletedExcalidrawElement } from "../element/types";
import { FixedSideContainer } from "./FixedSideContainer";
import { Island } from "./Island";
import { ShapesSwitcher } from "./Actions";
import { Section } from "./Section";
import { SCROLLBAR_WIDTH, SCROLLBAR_MARGIN } from "../scene/scrollbars";
import { LockButton } from "./LockButton";
import { PenModeButton } from "./PenModeButton";
import { HandButton } from "./HandButton";
import { isHandToolActive } from "../appState";
import { useTunnels } from "../context/tunnels";
import OffscreenContentIndicator from "./OffscreenContentIndicator";

type MobileMenuProps = {
  appState: UIAppState;
  scrollX: number;
  scrollY: number;
  offscreenContentTarget: PointerCoords | null;
  actionManager: ActionManager;
  renderImageExportDialog: () => React.ReactNode;
  setAppState: React.Component<any, AppState>["setState"];
  elements: readonly NonDeletedExcalidrawElement[];
  selectedElements: readonly NonDeletedExcalidrawElement[];
  onLockToggle: () => void;
  onHandToolToggle: () => void;
  onPenModeToggle: AppClassProperties["togglePenMode"];

  renderTopRightUI?: (
    isMobile: boolean,
    appState: UIAppState,
  ) => JSX.Element | null;
  renderCustomStats?: ExcalidrawProps["renderCustomStats"];
  renderWelcomeScreen: boolean;
  UIOptions: AppProps["UIOptions"];
  app: AppClassProperties;
};

export const MobileMenu = ({
  appState,
  scrollX,
  scrollY,
  offscreenContentTarget,
  elements,
  selectedElements,
  actionManager,
  setAppState,
  onLockToggle,
  onHandToolToggle,
  onPenModeToggle,

  renderTopRightUI,
  renderCustomStats,
  renderWelcomeScreen,
  UIOptions,
  app,
}: MobileMenuProps) => {
  const {
    WelcomeScreenCenterTunnel,
  } = useTunnels();
  const renderToolbar = () => {
    return (
      <FixedSideContainer side="top" className="App-top-bar">
        {renderWelcomeScreen && <WelcomeScreenCenterTunnel.Out />}
        <Section heading="shapes" className="shapes-section shapes-section--bottom">
          {(heading: React.ReactNode) => (
            <Stack.Col gap={4} align="center">
              {heading}
              <Stack.Row gap={1} className="App-toolbar App-toolbar--mobile App-toolbar--canvas">
                <ShapesSwitcher
                  appState={appState}
                  activeTool={appState.activeTool}
                  UIOptions={UIOptions}
                  app={app}
                />
                {renderTopRightUI && renderTopRightUI(true, appState)}
                <div className="mobile-misc-tools-container">
                  <PenModeButton
                    checked={appState.penMode}
                    onChange={() => onPenModeToggle(null)}
                    title={t("toolBar.penMode")}
                    isMobile
                    penDetected={appState.penDetected}
                  />
                  <LockButton
                    checked={appState.activeTool.locked}
                    onChange={onLockToggle}
                    title={t("toolBar.lock")}
                    isMobile
                  />
                  <HandButton
                    checked={isHandToolActive(appState)}
                    onChange={() => onHandToolToggle()}
                    title={t("toolBar.hand")}
                    isMobile
                  />
                </div>
              </Stack.Row>
            </Stack.Col>
          )}
        </Section>
      </FixedSideContainer>
    );
  };

  const renderAppToolbar = () => {
    if (
      appState.viewModeEnabled ||
      appState.openDialog?.name === "elementLinkSelector"
    ) {
      return (
        <div className="App-toolbar-content">
        </div>
      );
    }

    return (
      <div className="App-toolbar-content">
        {actionManager.renderAction(
          appState.multiElement ? "finalize" : "duplicateSelection",
        )}
        {actionManager.renderAction("deleteSelectedElements")}
        <div>
          {actionManager.renderAction("undo")}
          {actionManager.renderAction("redo")}
        </div>
      </div>
    );
  };

  return (
    <>
      {!appState.viewModeEnabled &&
        appState.openDialog?.name !== "elementLinkSelector" &&
        renderToolbar()}
      <div
        className="App-bottom-bar"
        style={{
          marginBottom: SCROLLBAR_WIDTH + SCROLLBAR_MARGIN * 2,
          marginLeft: SCROLLBAR_WIDTH + SCROLLBAR_MARGIN * 2,
          marginRight: SCROLLBAR_WIDTH + SCROLLBAR_MARGIN * 2,
        }}
      >
        <Island padding={0}>
          <footer className="App-toolbar">
            {renderAppToolbar()}
          </footer>
        </Island>
      </div>
      <OffscreenContentIndicator
        appState={appState}
        selectedElements={selectedElements}
        scrollX={scrollX}
        scrollY={scrollY}
        offscreenContentTarget={offscreenContentTarget}
        setAppState={setAppState}
      />
    </>
  );
};
