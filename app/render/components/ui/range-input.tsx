import { cn } from "@/utils/twMerge"
import * as React from "react"

interface RangeInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  label?: React.ReactNode
  defaultHint?: string
  showNumberInput?: boolean
  showValue?: boolean
  numberInputClassName?: string
  formatValue?: (value: number) => string
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
  onNumberChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
  containerClassName?: string
  labelClassName?: string
}

const RangeInput = React.forwardRef<HTMLInputElement, RangeInputProps>(
  (
    {
      label,
      defaultHint,
      showNumberInput = false,
      showValue = false,
      numberInputClassName,
      formatValue,
      onChange,
      onNumberChange,
      containerClassName,
      labelClassName,
      className,
      value,
      ...props
    },
    ref
  ) => {
    const numericValue = typeof value === 'string' ? parseFloat(value) : (value as number)
    const displayValue = formatValue ? formatValue(numericValue) : numericValue.toString()

    const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (onNumberChange) {
        onNumberChange(e)
      } else if (onChange) {
        onChange(e)
      }
    }

    return (
      <div className={cn("w-full", containerClassName)}>
        {(label || defaultHint) && (
          <div className={cn("flex items-center gap-2 mb-0.5", labelClassName)}>
            {label && <div className="text-xs text-foreground">{label}</div>}
            {defaultHint && <span className="text-xs text-muted-foreground">{defaultHint}</span>}
          </div>
        )}
        <div className="flex items-center gap-2 w-full">
          <input
            ref={ref}
            type="range"
            value={value}
            onChange={onChange}
            className={cn("flex-1 range-input-primary", className)}
            {...props}
          />
          {showNumberInput && (
            <input
              type="number"
              min={props.min}
              max={props.max}
              step={props.step}
              value={displayValue}
              onChange={handleNumberChange}
              className={cn(
                "text-xs text-foreground w-14 text-right font-mono bg-muted/50 rounded px-1 py-0.5 border border-border ml-2",
                numberInputClassName
              )}
            />
          )}
          {showValue && !showNumberInput && (
            <span>{displayValue}</span>
          )}
        </div>
      </div>
    )
  }
)

RangeInput.displayName = "RangeInput"

export { RangeInput }

