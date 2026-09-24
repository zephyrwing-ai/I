import clsx from "clsx";
import type { ActionManager } from "../../actions/manager";
import {
  ExitZenModeAction,
  FinalizeAction,
  UndoRedoActions,
  ZoomActions,
} from "../Actions";
import { useDevice } from "../App";
import { useTunnels } from "../../context/tunnels";
import { Section } from "../Section";
import Stack from "../Stack";
import type { UIAppState } from "../../types";

const Footer = ({
  appState,
  actionManager,
  showExitZenModeBtn,
}: {
  appState: UIAppState;
  actionManager: ActionManager;
  showExitZenModeBtn: boolean;
}) => {
  const { FooterCenterTunnel } = useTunnels();

  const device = useDevice();
  const showFinalize =
    !appState.viewModeEnabled && appState.multiElement && device.isTouchScreen;

  return (
    <footer
      role="contentinfo"
      className="layer-ui__wrapper__footer App-menu App-menu_bottom"
    >
      <div
        className={clsx("layer-ui__wrapper__footer-left zen-mode-transition", {
          "layer-ui__wrapper__footer-left--transition-left":
            appState.zenModeEnabled,
        })}
      >
        <Stack.Col gap={2}>
          <Section
            heading="canvasActions"
            className="footer-controls-section"
          >
            <div className="canvas-footer-controls">
              <ZoomActions renderAction={actionManager.renderAction} />
              {!appState.viewModeEnabled && (
                <>
                  <span className="canvas-footer-divider" aria-hidden="true" />
                  <UndoRedoActions renderAction={actionManager.renderAction} />
                </>
              )}
            </div>
            {showFinalize && (
              <FinalizeAction
                renderAction={actionManager.renderAction}
                className={clsx("zen-mode-transition", {
                  "layer-ui__wrapper__footer-left--transition-left":
                    appState.zenModeEnabled,
                })}
              />
            )}
          </Section>
        </Stack.Col>
      </div>
      <FooterCenterTunnel.Out />
      <ExitZenModeAction
        actionManager={actionManager}
        showExitZenModeBtn={showExitZenModeBtn}
      />
    </footer>
  );
};

export default Footer;
Footer.displayName = "Footer";
