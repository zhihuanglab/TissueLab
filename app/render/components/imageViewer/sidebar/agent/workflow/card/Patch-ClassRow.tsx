import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Ban, Edit, MoreHorizontal, Save, Trash2, Upload, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { isNegativeControl, NEGATIVE_CONTROL_COLOR } from "@/utils/agent/patchClassification.utils";

export interface PatchClassRowProps {
  name: string;
  index: number;
  /** Cells labelled AS this class. */
  count: number;
  /** Cells marked "not this type" for this class; hidden when zero. */
  negativeCount?: number;
  color: string;
  isSelected: boolean;
  isDeletable: boolean;
  onSelect: (index: number) => void;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
  onColorChange: (index: number, color: string) => void;
  /** Viewer / samples — color picker is display-only. */
  writeDisabled?: boolean;
  writeDisabledTitle?: string;
  /** One-vs-rest: show a per-class ".tlcls" attach control on this row. */
  ovrEnabled?: boolean;
  /** Basename of the .tlcls currently attached to this class (null = none). */
  ovrClassifierName?: string | null;
  /** Open the Load dialog bound to this class. */
  onOvrLoad?: () => void;
  /** Detach this class's .tlcls. */
  onOvrClear?: () => void;
  /** Basename of the .tlcls this class is configured to TRAIN+SAVE to (null = none). */
  ovrSaveName?: string | null;
  /** Remove this class's save destination (drop it from save_classifier_paths). */
  onOvrSaveClear?: () => void;
}

export const PatchClassRow: React.FC<PatchClassRowProps> = ({
  name,
  index,
  count,
  negativeCount = 0,
  color,
  isSelected,
  isDeletable,
  onSelect,
  onEdit,
  onDelete,
  onColorChange,
  writeDisabled = false,
  writeDisabledTitle,
  ovrEnabled = false,
  ovrClassifierName = null,
  onOvrLoad,
  onOvrClear,
  ovrSaveName = null,
  onOvrSaveClear,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Check if this is Negative control
  const isNegativeControlClass = isNegativeControl(name);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  return (
    <div className="flex items-center justify-between py-2 pt-3 border-b border-border/20 last:border-b-0 text-sm">
      {/* Left side: name, color */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate font-medium" title={name}>
          {name}
        </span>

        {/* Color swatch: small rounded rectangle next to name */}
        {isNegativeControlClass ? (
          <div
            className="relative w-8 h-4 rounded-[4px] shadow-sm shadow-border border border-border overflow-hidden shrink-0 cursor-not-allowed"
          >
            <div className="absolute inset-0" style={{ backgroundColor: NEGATIVE_CONTROL_COLOR }} />
          </div>
        ) : (
          <button
            type="button"
            disabled={writeDisabled}
            title={writeDisabled ? writeDisabledTitle : undefined}
            className="relative w-8 h-4 rounded-[4px] shadow-sm shadow-border border border-border overflow-hidden shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={(e) => {
              if (writeDisabled) return;
              const input = e.currentTarget.querySelector(
                "input[type='color']"
              ) as HTMLInputElement | null;
              input?.click();
            }}
          >
            <div className="absolute inset-0" style={{ backgroundColor: color }} />
            <Input
              type="color"
              value={color}
              disabled={writeDisabled}
              className="absolute inset-0 opacity-0 cursor-pointer p-0 border-0 disabled:cursor-not-allowed"
              onChange={(e) => onColorChange(index, e.target.value)}
            />
          </button>
        )}
      </div>

      {/* Right side: count, edit / more actions pinned to the right edge */}
      <div className="flex items-center gap-1.5 shrink-0 pr-1">
        {/* One-vs-rest: per-class .tlcls attach control */}
        {ovrEnabled && (
          ovrClassifierName ? (
            <div
              className="flex items-center gap-1 max-w-[120px] rounded-[4px] border border-border bg-muted px-1.5 py-0.5"
              title={ovrClassifierName}
            >
              <span className="truncate font-mono text-[10px] text-foreground">{ovrClassifierName}</span>
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                title="Detach classifier"
                onClick={onOvrClear}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 gap-1 px-1.5 rounded-[4px] text-[10px] text-muted-foreground/90 hover:text-foreground"
              title="Load a classifier for this class (one-vs-rest)"
              onClick={onOvrLoad}
              disabled={!onOvrLoad}
            >
              <Upload className="h-2.5 w-2.5" />
              Load
            </Button>
          )
        )}
        {/* One-vs-rest: per-class TRAIN+SAVE destination indicator (mirrors Load) */}
        {ovrEnabled && ovrSaveName && (
          <div
            className="flex items-center gap-1 max-w-[120px] rounded-[4px] border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5"
            title={`Will train + save to ${ovrSaveName}`}
          >
            <Save className="h-2.5 w-2.5 shrink-0 text-emerald-600" />
            <span className="truncate font-mono text-[10px] text-emerald-700 dark:text-emerald-400">{ovrSaveName}</span>
            {onOvrSaveClear && (
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                title="Remove save destination"
                onClick={onOvrSaveClear}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
        )}
        {/* "Not this type" marks, as their own chip. A signed number next to the
            count ("12 −4") reads as arithmetic on the count rather than as a
            second, different thing; the slashed circle says "not" on its own.
            Placed before the count so the count stays in one column across rows,
            whether or not a class has any. */}
        {negativeCount > 0 && (
          <span
            className="flex items-center gap-0.5 shrink-0 rounded-[4px] border border-border bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
            title={`${negativeCount} cell${negativeCount === 1 ? "" : "s"} marked "not ${name}"`}
          >
            <Ban className="h-2.5 w-2.5" />
            {negativeCount}
          </span>
        )}
        {/* Cells labelled AS this class. */}
        <span
          className="text-xs text-foreground min-w-[1.5rem] text-right"
          title={`${count} cell${count === 1 ? "" : "s"} labelled "${name}"`}
        >
          {count}
        </span>
        {isDeletable && (
          <div className="flex items-center gap-0.5 shrink-0" ref={menuRef}>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 p-0 rounded-[4px] text-muted-foreground/80 bg-transparent hover:bg-muted"
              onClick={() => onEdit(index)}
            >
              <Edit className="h-2.5 w-2.5" />
            </Button>
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 p-0 rounded-[4px] text-muted-foreground/80 bg-transparent hover:bg-muted"
                onClick={() => setMenuOpen((prev) => !prev)}
              >
                <MoreHorizontal className="h-2.5 w-2.5" />
                <span className="sr-only">More actions</span>
              </Button>
              {menuOpen && (
                <div className="absolute right-0 mt-1 z-20 rounded-sm border border-border bg-card shadow-md">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/5"
                    onClick={() => {
                      onDelete(index);
                      setMenuOpen(false);
                    }}
                  >
                    <Trash2 className="h-3 w-3 mr-1" /> Delete
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};


