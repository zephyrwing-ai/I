import clsx from "clsx";
import React from "react";
import type { ActionManager } from "../actions/manager";
import type { NonDeletedCanvasEditorElement } from "../element/types";
import type { Language } from "../i18n";
import { t } from "../i18n";
import type {
  AppProps,
  AppState,
  CanvasEditorProps,
  BinaryFiles,
  UIAppState,
  AppClassProperties,
  PointerCoords,
} from "../types";
import { isShallowEqual } from "../utils";
import { ShapesSwitcher } from "./Actions";
import { ErrorDialog } from "./ErrorDialog";
import { ImageExportDialog } from "./ImageExportDialog";
import { FixedSideContainer } from "./FixedSideContainer";
import { LoadingMessage } from "./LoadingMessage";
import { LockButton } from "./LockButton";
import { Section } from "./Section";
import Stack from "./Stack";
import { PenModeButton } from "./PenModeButton";
import { useDevice } from "./App";
import Footer from "./footer/Footer";
import { ActiveConfirmDialog } from "./ActiveConfirmDialog";
import { OverwriteConfirmDialog } from "./OverwriteConfirm/OverwriteConfirm";
import { HandButton } from "./HandButton";
import { isHandToolActive } from "../appState";
import { TunnelsContext, useInitializeTunnels } from "../context/tunnels";
import { UIAppStateContext } from "../context/ui-appState";
import ElementLinkDialog from "./ElementLinkDialog";
import OffscreenContentIndicator from "./OffscreenContentIndicator";

import "./LayerUI.scss";
import "./Toolbar.scss";

interface LayerUIProps {
  actionManager: ActionManager;
  appState: UIAppState;
  scrollX: number;
  scrollY: number;
  offscreenContentTarget: PointerCoords | null;
  files: BinaryFiles;
  canvas: HTMLCanvasElement;
  setAppState: React.Component<any, AppState>["setState"];
  elements: readonly NonDeletedCanvasEditorElement[];
  selectedElements: readonly NonDeletedCanvasEditorElement[];
  onLockToggle: () => void;
  onHandToolToggle: () => void;
  onPenModeToggle: AppClassProperties["togglePenMode"];
  showExitZenModeBtn: boolean;
  langCode: Language["code"];
  renderTopRightUI?: CanvasEditorProps["renderTopRightUI"];
  UIOptions: AppProps["UIOptions"];
  onExportImage: AppClassProperties["onExportImage"];
  renderWelcomeScreen: boolean;
  children?: React.ReactNode;
  app: AppClassProperties;
  generateLinkForSelection?: AppProps["generateLinkForSelection"];
}

const DefaultOverwriteConfirmDialog = () => {
  return (
    <OverwriteConfirmDialog __fallback>
      <OverwriteConfirmDialog.Actions.SaveToDisk />
      <OverwriteConfirmDialog.Actions.ExportToImage />
    </OverwriteConfirmDialog>
  );
};

const LayerUI = ({
  actionManager,
  appState,
  scrollX,
  scrollY,
  offscreenContentTarget,
  files,
  setAppState,
  elements,
  selectedElements,
  canvas,
  onLockToggle,
  onHandToolToggle,
  onPenModeToggle,
  showExitZenModeBtn,
  renderTopRightUI,
  UIOptions,
  onExportImage,
  renderWelcomeScreen,
  children,
  app,
  generateLinkForSelection,
}: LayerUIProps) => {
  const device = useDevice();
  const tunnels = useInitializeTunnels();

  const TunnelsJotaiProvider = tunnels.tunnelsJotai.Provider;

  const renderImageExportDialog = () => {
    if (
      !UIOptions.canvasActions.saveAsImage ||
      appState.openDialog?.name !== "imageExport"
    ) {
      return null;
    }

    return (
      <ImageExportDialog
        elements={elements}
        appState={appState}
        files={files}
        actionManager={actionManager}
        onExportImage={onExportImage}
        onCloseRequest={() => setAppState({ openDialog: null })}
        name={app.getName()}
      />
    );
  };

  const renderShapesToolbar = () => {
    if (
      appState.viewModeEnabled ||
      appState.openDialog?.name === "elementLinkSelector"
    ) {
      return null;
    }

    return (
      <Section heading="shapes" className="shapes-section shapes-section--bottom">
        {(heading: React.ReactNode) => (
          <>
            {heading}
            <Stack.Row gap={1} className="App-toolbar App-toolbar--canvas">
              <PenModeButton
                zenModeEnabled={appState.zenModeEnabled}
                checked={appState.penMode}
                onChange={() => onPenModeToggle(null)}
                title={t("toolBar.penMode")}
                penDetected={appState.penDetected}
              />
              <LockButton
                checked={appState.activeTool.locked}
                onChange={onLockToggle}
                title={t("toolBar.lock")}
              />
              <div className="App-toolbar__divider" />
              <HandButton
                checked={isHandToolActive(appState)}
                onChange={() => onHandToolToggle()}
                title={t("toolBar.hand")}
              />
              <ShapesSwitcher
                appState={appState}
                activeTool={appState.activeTool}
                UIOptions={UIOptions}
                app={app}
              />
            </Stack.Row>
          </>
        )}
      </Section>
    );
  };

  const renderFixedSideContainer = () => {
    return (
      <FixedSideContainer side="top">
        <div className="App-menu App-menu_top">
          <div
            className={clsx(
              "layer-ui__wrapper__top-right zen-mode-transition",
              {
                "transition-right": appState.zenModeEnabled,
              },
            )}
          >
            {renderTopRightUI?.(device.editor.isMobile, appState)}
          </div>
        </div>
      </FixedSideContainer>
    );
  };

  const layerUIJSX = (
    <>
      {/* ------------------------- tunneled UI ---------------------------- */}
      {/* make sure we render host app components first so that we can detect
          them first on initial render to optimize layout shift */}
      {children}
      {/* render component fallbacks. Can be rendered anywhere as they'll be
          tunneled away. We only render tunneled components that actually
        have defaults when host do not render anything. */}
      <DefaultOverwriteConfirmDialog />
      {/* ------------------------------------------------------------------ */}

      {appState.isLoading && <LoadingMessage delay={250} />}
      {appState.errorMessage && (
        <ErrorDialog onClose={() => setAppState({ errorMessage: null })}>
          {appState.errorMessage}
        </ErrorDialog>
      )}
      <ActiveConfirmDialog />
      {appState.openDialog?.name === "elementLinkSelector" && (
        <ElementLinkDialog
          sourceElementId={appState.openDialog.sourceElementId}
          onClose={() => {
            setAppState({
              openDialog: null,
            });
          }}
          elementsMap={app.scene.getNonDeletedElementsMap()}
          appState={appState}
          generateLinkForSelection={generateLinkForSelection}
        />
      )}
      <tunnels.OverwriteConfirmDialogTunnel.Out />
      {renderImageExportDialog()}
      <div className="layer-ui__wrapper">
        {renderWelcomeScreen && <tunnels.WelcomeScreenCenterTunnel.Out />}
        {renderFixedSideContainer()}
        {renderShapesToolbar()}
        <Footer
          appState={appState}
          actionManager={actionManager}
          showExitZenModeBtn={showExitZenModeBtn}
        />
        <OffscreenContentIndicator
          appState={appState}
          selectedElements={selectedElements}
          scrollX={scrollX}
          scrollY={scrollY}
          offscreenContentTarget={offscreenContentTarget}
          setAppState={setAppState}
        />
      </div>
    </>
  );

  return (
    <UIAppStateContext.Provider value={appState}>
      <TunnelsJotaiProvider>
        <TunnelsContext.Provider value={tunnels}>
          {layerUIJSX}
        </TunnelsContext.Provider>
      </TunnelsJotaiProvider>
    </UIAppStateContext.Provider>
  );
};

const stripIrrelevantAppStateProps = (appState: AppState): UIAppState => {
  const {
    suggestedBindings,
    startBoundElement,
    cursorButton,
    scrollX,
    scrollY,
    ...ret
  } = appState;
  return ret;
};

const areEqual = (prevProps: LayerUIProps, nextProps: LayerUIProps) => {
  // short-circuit early
  if (prevProps.children !== nextProps.children) {
    return false;
  }

  const { canvas: _pC, appState: prevAppState, ...prev } = prevProps;
  const { canvas: _nC, appState: nextAppState, ...next } = nextProps;

  return (
    isShallowEqual(
      // asserting AppState because we're being passed the whole AppState
      // but resolve to only the UI-relevant props
      stripIrrelevantAppStateProps(prevAppState as AppState),
      stripIrrelevantAppStateProps(nextAppState as AppState),
      {
        selectedElementIds: isShallowEqual,
        selectedGroupIds: isShallowEqual,
      },
    ) && isShallowEqual(prev, next)
  );
};

export default React.memo(LayerUI, areEqual);
