"use client";
import React, { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Edit, Trash2, Plus, RotateCcw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

// Classification class interface
interface ClassificationClass {
  name: string;
  color: string;
  count?: number;
}

// Component Props interface
interface SimpleClassificationUIProps {
  title?: string;
  className?: string;
  classes?: ClassificationClass[];
  onClassesChange?: (classes: ClassificationClass[]) => void;
  onAddClass?: () => void;
  onEditClass?: (index: number) => void;
  onDeleteClass?: (index: number) => void;
  onReset?: () => void;
  onColorChange?: (index: number, color: string) => void;
  onActiveClassSelect?: (classItem: ClassificationClass | number) => void;
  activeClass?: ClassificationClass | null;
  activeClassIndex?: number | null;
  showModal?: boolean;
  editingIndex?: number | null;
  newClassName?: string;
  onNewClassNameChange?: (name: string) => void;
  onModalSave?: () => void;
  onModalClose?: () => void;
  cellTypeOptions?: string[];
  panelKey?: string;
  presetOptions?: string[];
}

export const SimpleClassificationUI: React.FC<SimpleClassificationUIProps> = ({
  title = "Classes",
  className = "",
  classes = [],
  onAddClass,
  onEditClass,
  onDeleteClass,
  onReset,
  onColorChange,
  showModal = false,
  editingIndex = null,
  newClassName = "",
  onNewClassNameChange,
  onModalSave,
  onModalClose,
  panelKey,
  presetOptions = [],
}) => {
  const ensureHash = (hex: string | undefined | null): string => {
    if (!hex) return '#000000';
    return hex.startsWith('#') ? hex : `#${hex}`;
  };

  const handleColorChange = (index: number, color: string) => {
    onColorChange?.(index, color);
  };

  const handleEditClass = (index: number) => {
    onEditClass?.(index);
  };

  const handleDeleteClass = (index: number) => {
    onDeleteClass?.(index);
  };

  const handleReset = () => {
    onReset?.();
  };

  return (
    <div className={`p-3 space-y-3 rounded-lg bg-card border ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {panelKey && (
            <p className="text-xs text-muted-foreground mt-1">Key: {panelKey}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onAddClass}
            className="flex items-center gap-1 h-5 px-2 text-xs"
          >
            <Plus className="h-2.5 w-2.5" />
            Add
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            className="flex items-center gap-1 h-5 px-2 text-xs text-destructive hover:text-destructive/80"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </Button>
        </div>
      </div>

      {/* Classes List */}
      <div className="space-y-1">
        {classes.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground text-sm">
            <p>No classes defined</p>
            <p className="text-xs">Click &quot;Add&quot; to create your first class</p>
          </div>
        ) : (
          <div className="space-y-1">
            {classes.map((classItem, index) => {
              return (
                <div
                  key={index}
                  className="flex items-center gap-2 p-2 rounded border transition-colors bg-muted/40 border-border hover:bg-muted/80"
                >

                  {/* Class name */}
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-foreground truncate block">
                      {classItem.name}
                    </span>
                  </div>

                  {/* Color picker */}
                  <div className="flex-shrink-0">
                    <Input
                      type="color"
                      value={ensureHash(classItem.color)}
                      onChange={(e) => handleColorChange(index, e.target.value)}
                      className="w-6 h-6 p-0 border-0 rounded cursor-pointer"
                      title="Change color"
                    />
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEditClass(index)}
                      className="h-5 w-5 p-0"
                      title="Edit class"
                    >
                      <Edit className="h-2.5 w-2.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteClass(index)}
                      className="h-5 w-5 p-0 text-destructive hover:text-destructive/80"
                      title="Delete class"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      <Dialog open={showModal} onOpenChange={onModalClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingIndex !== null ? 'Edit Class' : 'Add New Class'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="class-name">Class Name</Label>
              <Input
                id="class-name"
                value={newClassName}
                onChange={(e) => onNewClassNameChange?.(e.target.value)}
                placeholder="Enter class name"
                className="mt-1 rounded-[6px]"
              />
            </div>
            {presetOptions.length > 0 && (
              <div>
                <Label htmlFor="class-type">Or select from preset options</Label>
                <select
                  id="class-type"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) {
                      onNewClassNameChange?.(e.target.value);
                    }
                  }}
                  className="flex-1 p-2 border border-border rounded-md mt-1 w-full"
                >
                  <option value="">Select a preset...</option>
                  {presetOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onModalClose}>
              Cancel
            </Button>
            <Button onClick={onModalSave} disabled={!newClassName.trim()}>
              {editingIndex !== null ? 'Save' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
