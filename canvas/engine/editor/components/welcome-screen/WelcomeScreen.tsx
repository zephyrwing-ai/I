import { Center } from "./WelcomeScreen.Center";
import { MenuHint, ToolbarHint } from "./WelcomeScreen.Hints";

import "./WelcomeScreen.scss";

const WelcomeScreen = (props: { children?: React.ReactNode }) => {
  return (
    <>
      {props.children || (
        <>
          <Center />
          <MenuHint />
          <ToolbarHint />
        </>
      )}
    </>
  );
};

WelcomeScreen.displayName = "WelcomeScreen";

WelcomeScreen.Center = Center;
WelcomeScreen.Hints = { MenuHint, ToolbarHint };

export default WelcomeScreen;
