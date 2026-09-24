import React from "react";
import tunnel from "tunnel-rat";
import { createIsolation } from "jotai-scope";

export type Tunnel = ReturnType<typeof tunnel>;

type TunnelsContextValue = {
  WelcomeScreenMenuHintTunnel: Tunnel;
  WelcomeScreenToolbarHintTunnel: Tunnel;
  WelcomeScreenCenterTunnel: Tunnel;
  FooterCenterTunnel: Tunnel;
  OverwriteConfirmDialogTunnel: Tunnel;
  // this can be removed once we create jotai stores per each editor
  // instance
  tunnelsJotai: ReturnType<typeof createIsolation>;
};

export const TunnelsContext = React.createContext<TunnelsContextValue>(null!);

export const useTunnels = () => React.useContext(TunnelsContext);

const tunnelsJotai = createIsolation();

export const useInitializeTunnels = () => {
  return React.useMemo((): TunnelsContextValue => {
    return {
      WelcomeScreenMenuHintTunnel: tunnel(),
      WelcomeScreenToolbarHintTunnel: tunnel(),
      WelcomeScreenCenterTunnel: tunnel(),
      FooterCenterTunnel: tunnel(),
      OverwriteConfirmDialogTunnel: tunnel(),
      tunnelsJotai,
    };
  }, []);
};
