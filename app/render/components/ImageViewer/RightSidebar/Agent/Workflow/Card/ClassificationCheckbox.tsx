import { Checkbox } from "@/components/ui/checkbox";
import React from "react";

export interface ClassificationCheckboxProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  labelClassName?: string;
}

export const ClassificationCheckbox: React.FC<ClassificationCheckboxProps> = ({
  id,
  checked,
  onCheckedChange,
  label,
  disabled = false,
  title,
  className = "flex items-center gap-2",
  labelClassName = "text-xs text-muted-foreground cursor-pointer",
}) => {
  return (
    <div className={className}>
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(checked) => onCheckedChange(checked === true)}
        disabled={disabled}
        title={title}
        className="rounded-[2px] w-3 h-3 flex items-center justify-center [&>svg]:scale-[0.55] border-foreground/60 data-[state=checked]:bg-foreground/40"
      />
      <label
        htmlFor={id}
        className={labelClassName}
      >
        {label}
      </label>
    </div>
  );
};

