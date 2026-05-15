import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Edit, MoreHorizontal, Trash2 } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { isNegativeControl, NEGATIVE_CONTROL_COLOR } from "@/utils/patchClassificationUtils";

export interface PatchClassRowProps {
  name: string;
  index: number;
  count: number;
  color: string;
  isSelected: boolean;
  isDeletable: boolean;
  onSelect: (index: number) => void;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
  onColorChange: (index: number, color: string) => void;
}

export const PatchClassRow: React.FC<PatchClassRowProps> = ({
  name,
  index,
  count,
  color,
  isSelected,
  isDeletable,
  onSelect,
  onEdit,
  onDelete,
  onColorChange,
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
            className="relative w-8 h-4 rounded-[4px] shadow-sm shadow-border border border-border overflow-hidden flex-shrink-0 cursor-not-allowed"
          >
            <div className="absolute inset-0" style={{ backgroundColor: NEGATIVE_CONTROL_COLOR }} />
          </div>
        ) : (
          <button
            className="relative w-8 h-4 rounded-[4px] shadow-sm shadow-border border border-border overflow-hidden flex-shrink-0"
            onClick={(e) => {
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
              className="absolute inset-0 opacity-0 cursor-pointer p-0 border-0"
              onChange={(e) => onColorChange(index, e.target.value)}
            />
          </button>
        )}
      </div>

      {/* Right side: count, edit / more actions pinned to the right edge */}
      <div className="flex items-center gap-1.5 flex-shrink-0 pr-1">
        {/* Count to the left of buttons */}
        <span className="text-xs text-foreground min-w-[1.5rem] text-right">
          {count}
        </span>
        {isDeletable && (
          <div className="flex items-center gap-0.5 flex-shrink-0" ref={menuRef}>
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


