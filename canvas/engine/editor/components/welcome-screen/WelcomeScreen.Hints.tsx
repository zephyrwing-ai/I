import { t } from "../../i18n";
import { useTunnels } from "../../context/tunnels";
import {
  WelcomeScreenMenuArrow,
  WelcomeScreenTopToolbarArrow,
} from "../icons";

const MenuHint = ({ children }: { children?: React.ReactNode }) => {
  const { WelcomeScreenMenuHintTunnel } = useTunnels();
  return (
    <WelcomeScreenMenuHintTunnel.In>
      <div className="excalifont welcome-screen-decor welcome-screen-decor-hint welcome-screen-decor-hint--menu">
        {WelcomeScreenMenuArrow}
        <div className="welcome-screen-decor-hint__label">
          {children || t("welcomeScreen.defaults.menuHint")}
        </div>
      </div>
    </WelcomeScreenMenuHintTunnel.In>
  );
};
MenuHint.displayName = "MenuHint";

const ToolbarHint = ({ children }: { children?: React.ReactNode }) => {
  const { WelcomeScreenToolbarHintTunnel } = useTunnels();
  return (
    <WelcomeScreenToolbarHintTunnel.In>
      <div className="excalifont welcome-screen-decor welcome-screen-decor-hint welcome-screen-decor-hint--toolbar">
        <div className="welcome-screen-decor-hint__label">
          {children || t("welcomeScreen.defaults.toolbarHint")}
        </div>
        {WelcomeScreenTopToolbarArrow}
      </div>
    </WelcomeScreenToolbarHintTunnel.In>
  );
};
ToolbarHint.displayName = "ToolbarHint";

export { MenuHint, ToolbarHint };
