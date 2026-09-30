import "./ToolIcon.scss";

import clsx from "clsx";
import { ToolButton } from "./ToolButton";
import { handIcon } from "./icons";
import { KEYS } from "../keys";

type HandButtonProps = {
  title?: string;
  name?: string;
  checked: boolean;
  onChange?(): void;
};

export const HandButton = (props: HandButtonProps) => {
  return (
    <ToolButton
      className={clsx("Shape", { fillable: false })}
      type="radio"
      icon={handIcon}
      name="editor-current-shape"
      checked={props.checked}
      title={`${props.title} — H`}
      aria-label={`${props.title} — H`}
      aria-keyshortcuts={KEYS.H}
      data-testid={`toolbar-hand`}
      onChange={() => props.onChange?.()}
    />
  );
};
