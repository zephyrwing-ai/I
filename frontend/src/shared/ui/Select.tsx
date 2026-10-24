import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type Ref } from "react";
import { Icon } from "./Icon";
import "./Select.css";

interface SelectProps<T extends string> {
  id: string;
  labelledBy?: string;
  label?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onValueChange: (value: T) => void;
  disabled?: boolean;
  displayValue?: string;
  emptyText?: string;
  side?: "top" | "bottom";
  align?: "center" | "end";
  size?: "default" | "compact";
  triggerRef?: Ref<HTMLButtonElement>;
  labelRef?: Ref<HTMLSpanElement>;
  triggerProps?: Pick<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style" | "title">;
  contentClassName?: string;
}

/** A select-only combobox: focus stays on the trigger while its listbox is open. */
export function Select<T extends string>({
  id, labelledBy, label, value, options, onValueChange, disabled = false,
  displayValue, emptyText, side = "bottom", align = "end", size = "default",
  triggerRef, labelRef, triggerProps, contentClassName = "",
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const restoreFocus = useRef(true);
  const selectedIndex = options.findIndex(option => option.value === value);
  const listboxId = `${id}-listbox`;
  const valueId = `${id}-value`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const changeOpen = (nextOpen: boolean): void => {
    if (nextOpen) {
      restoreFocus.current = true;
      setActiveIndex(options.length ? Math.max(0, selectedIndex) : -1);
    }
    setOpen(nextOpen);
  };

  const choose = (index: number): void => {
    const option = options[index];
    if (option) onValueChange(option.value);
    setOpen(false);
  };

  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, id, open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) changeOpen(true);
      else if (options.length) setActiveIndex(index => (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (!open) changeOpen(true);
      setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
    } else if (open && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      choose(activeIndex);
    } else if (open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (open && event.key === "Tab") {
      restoreFocus.current = false;
      setOpen(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger asChild>
        <button
          {...triggerProps}
          ref={triggerRef}
          id={id}
          type="button"
          role="combobox"
          className={`${triggerProps?.className ?? ""} ui-select-trigger`.trim()}
          data-size={size}
          value={value}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-labelledby={labelledBy ? `${labelledBy} ${valueId}` : undefined}
          aria-label={label}
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          onKeyDown={onKeyDown}
        >
          <span id={valueId} ref={labelRef}>{options[selectedIndex]?.label ?? displayValue ?? ""}</span>
          <Icon name="chevron-right" width="15" height="15" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          id={listboxId}
          role="listbox"
          aria-labelledby={labelledBy}
          aria-label={label}
          className={`ui-select-content ${contentClassName}`.trim()}
          data-size={size}
          side={side}
          align={align}
          sideOffset={8}
          avoidCollisions={false}
          onOpenAutoFocus={event => event.preventDefault()}
          onCloseAutoFocus={event => { if (!restoreFocus.current) event.preventDefault(); }}
        >
          {options.length === 0 && <div className="ui-select-empty">{emptyText}</div>}
          {options.map((option, index) => (
            <div
              id={optionId(index)}
              key={option.value}
              role="option"
              className="ui-select-option"
              data-value={option.value}
              data-highlighted={index === activeIndex ? "" : undefined}
              aria-selected={option.value === value}
              onPointerMove={() => setActiveIndex(index)}
              onPointerDown={event => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Icon name="check" width="16" height="16" strokeWidth={2} />}
            </div>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
