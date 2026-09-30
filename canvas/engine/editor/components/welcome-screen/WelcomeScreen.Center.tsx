import type { JSX } from "react";
import { t } from "../../i18n";
import { useDevice } from "../App";
import { useTunnels } from "../../context/tunnels";
import { CanvasEditorLogo } from "../CanvasEditorLogo";

const WelcomeScreenMenuItemContent = ({
  icon,
  shortcut,
  children,
}: {
  icon?: JSX.Element;
  shortcut?: string | null;
  children: React.ReactNode;
}) => {
  const device = useDevice();
  return (
    <>
      <div className="welcome-screen-menu-item__icon">{icon}</div>
      <div className="welcome-screen-menu-item__text">{children}</div>
      {shortcut && !device.editor.isMobile && (
        <div className="welcome-screen-menu-item__shortcut">{shortcut}</div>
      )}
    </>
  );
};
WelcomeScreenMenuItemContent.displayName = "WelcomeScreenMenuItemContent";

const WelcomeScreenMenuItem = ({
  onSelect,
  children,
  icon,
  shortcut,
  className = "",
  ...props
}: {
  onSelect: () => void;
  children: React.ReactNode;
  icon?: JSX.Element;
  shortcut?: string | null;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
  return (
    <button
      {...props}
      type="button"
      className={`welcome-screen-menu-item ${className}`}
      onClick={onSelect}
    >
      <WelcomeScreenMenuItemContent icon={icon} shortcut={shortcut}>
        {children}
      </WelcomeScreenMenuItemContent>
    </button>
  );
};
WelcomeScreenMenuItem.displayName = "WelcomeScreenMenuItem";

const WelcomeScreenMenuItemLink = ({
  children,
  href,
  icon,
  shortcut,
  className = "",
  ...props
}: {
  children: React.ReactNode;
  href: string;
  icon?: JSX.Element;
  shortcut?: string | null;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
  return (
    <a
      {...props}
      className={`welcome-screen-menu-item ${className}`}
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      <WelcomeScreenMenuItemContent icon={icon} shortcut={shortcut}>
        {children}
      </WelcomeScreenMenuItemContent>
    </a>
  );
};
WelcomeScreenMenuItemLink.displayName = "WelcomeScreenMenuItemLink";

const Center = ({ children }: { children?: React.ReactNode }) => {
  const { WelcomeScreenCenterTunnel } = useTunnels();
  return (
    <WelcomeScreenCenterTunnel.In>
      <div className="welcome-screen-center">
        {children || (
          <>
            <Logo />
            <Heading>{t("welcomeScreen.defaults.center_heading")}</Heading>
          </>
        )}
      </div>
    </WelcomeScreenCenterTunnel.In>
  );
};
Center.displayName = "Center";

const Logo = ({ children }: { children?: React.ReactNode }) => {
  return (
    <div className="welcome-screen-center__logo excalifont welcome-screen-decor">
      {children || <CanvasEditorLogo withText />}
    </div>
  );
};
Logo.displayName = "Logo";

const Heading = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="welcome-screen-center__heading welcome-screen-decor excalifont">
      {children}
    </div>
  );
};
Heading.displayName = "Heading";

const Menu = ({ children }: { children?: React.ReactNode }) => {
  return <div className="welcome-screen-menu">{children}</div>;
};
Menu.displayName = "Menu";

// -----------------------------------------------------------------------------

Center.Logo = Logo;
Center.Heading = Heading;
Center.Menu = Menu;
Center.MenuItem = WelcomeScreenMenuItem;
Center.MenuItemLink = WelcomeScreenMenuItemLink;

export { Center };
