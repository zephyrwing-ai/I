import React, { useState } from "react";
import { t } from "../i18n";

import { Dialog } from "./Dialog";
import { useCanvasEditorContainer } from "./App";

export const ErrorDialog = ({
  children,
  onClose,
}: {
  children?: React.ReactNode;
  onClose?: () => void;
}) => {
  const [modalIsShown, setModalIsShown] = useState(!!children);
  const { container: canvasContainer } = useCanvasEditorContainer();

  const handleClose = React.useCallback(() => {
    setModalIsShown(false);

    if (onClose) {
      onClose();
    }
    // TODO: Fix the A11y issues so this is never needed since we should always focus on last active element
    canvasContainer?.focus();
  }, [onClose, canvasContainer]);

  return (
    <>
      {modalIsShown && (
        <Dialog
          size="small"
          onCloseRequest={handleClose}
          title={t("errorDialog.title")}
        >
          <div style={{ whiteSpace: "pre-wrap" }}>{children}</div>
        </Dialog>
      )}
    </>
  );
};
