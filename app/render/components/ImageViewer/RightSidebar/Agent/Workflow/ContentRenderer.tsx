"use client";
import React, { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SimpleClassificationUI } from "@/components/imageViewer/RightSidebar/Agent/Workflow/SimpleClassificationUI";
import { ContentRendererProps } from "./types";

export const ContentRenderer: React.FC<ContentRendererProps> = ({ item, onChange }) => {
  const [inputValue, setInputValue] = useState(item.value);
  const [isTyping, setIsTyping] = useState(false);
  const [nucleiClasses, setNucleiClasses] = useState([
    { name: "Epithelial", color: "#FF6B6B", count: 0 },
    { name: "Lymphocyte", color: "#4ECDC4", count: 0 },
    { name: "Neutrophil", color: "#45B7D1", count: 0 },
  ]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [presetOptions, setPresetOptions] = useState(() => {
    // Try to get preset options from the field, fallback to default
    const fieldPresetOptions = (item as any).presetOptions;
    if (fieldPresetOptions && Array.isArray(fieldPresetOptions)) {
      return fieldPresetOptions;
    }
    return [
      'Epithelial',
      'Lymphocyte', 
      'Neutrophil',
      'Macrophage',
      'Tumor',
      'Stroma',
      'Necrosis',
      'Normal',
      'Cancer',
      'Benign'
    ];
  });

  // Event handlers for ClassificationUI
  const handleAddClass = () => {
    const newClass = {
      name: `Class ${nucleiClasses.length + 1}`,
      color: `#${Math.floor(Math.random()*16777215).toString(16).padStart(6, '0')}`,
      count: 0
    };
    const updatedClasses = [...nucleiClasses, newClass];
    setNucleiClasses(updatedClasses);
    onChange?.(updatedClasses);
  };

  const handleEditClass = (index: number) => {
    setEditingIndex(index);
    setEditingName(nucleiClasses[index].name);
  };

  const handleSaveEdit = () => {
    if (editingName.trim() && editingIndex !== null) {
      const updatedClasses = [...nucleiClasses];
      updatedClasses[editingIndex] = { ...updatedClasses[editingIndex], name: editingName.trim() };
      setNucleiClasses(updatedClasses);
      onChange?.(updatedClasses);
    }
    setEditingIndex(null);
    setEditingName("");
  };

  const handleCancelEdit = () => {
    setEditingIndex(null);
    setEditingName("");
  };

  const handleDeleteClass = (index: number) => {
    const updatedClasses = nucleiClasses.filter((_, i) => i !== index);
    setNucleiClasses(updatedClasses);
    onChange?.(updatedClasses);
  };

  const handleReset = () => {
    setNucleiClasses([]);
    onChange?.([]);
  };

  const handleColorChange = (index: number, color: string) => {
    const updatedClasses = [...nucleiClasses];
    updatedClasses[index] = { ...updatedClasses[index], color };
    setNucleiClasses(updatedClasses);
    onChange?.(updatedClasses);
  };


  // Keep local input state in sync when parent updates item.value (e.g., after editing panel schema)
  useEffect(() => {
    setInputValue(item.value);
  }, [item.value]);

  // use ref to track if the component has been initialized
  const hasInitialized = React.useRef(false);
  // when the component is mounted, pass the initial classes to the parent component
  useEffect(() => {
    if (item.type === "color-selector" && !hasInitialized.current) {
      onChange?.(nucleiClasses);
      hasInitialized.current = true;
    }
  }, [item.type, nucleiClasses, onChange]);

  // Update preset options when item changes
  useEffect(() => {
    const fieldPresetOptions = (item as any).presetOptions;
    if (fieldPresetOptions && Array.isArray(fieldPresetOptions)) {
      setPresetOptions(fieldPresetOptions);
    }
  }, [item]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTyping && event.key === " ") {
        event.stopPropagation();
        event.preventDefault();

        setInputValue((prev) => {
          const newValue = prev + " ";
          onChange(newValue);
          return newValue;
        });
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isTyping, onChange]);

  // Always reflect the current key as the visible label to avoid stale labels after edits
  const labelText = item.key;
  const computedBase = (labelText || '').toLowerCase();
  const defaultPlaceholder = item.type === "select" ? `Select ${computedBase}` : `Enter ${computedBase}`;
  const placeholder = item.placeholder ?? defaultPlaceholder;

  // Tips-only row for contextual help
  if (item.type === "tips") {
    return (
      <div className="text-xs text-muted-foreground px-1 py-0.5">
        {item.value || item.key}
      </div>
    );
  }

  // Color Selector component
  if (item.type === "color-selector") {
    return (
      <div className="w-full">
        <SimpleClassificationUI
          title="Classes"
          classes={nucleiClasses}
          onAddClass={handleAddClass}
          onEditClass={handleEditClass}
          onDeleteClass={handleDeleteClass}
          onReset={handleReset}
          onColorChange={handleColorChange}
          onActiveClassSelect={(classItem) => console.log("Active class selected", classItem)}
          activeClass={undefined}
          activeClassIndex={undefined}
          showModal={editingIndex !== null}
          editingIndex={editingIndex}
          newClassName={editingName}
          onNewClassNameChange={setEditingName}
          onModalSave={handleSaveEdit}
          onModalClose={handleCancelEdit}
          presetOptions={presetOptions}
          panelKey={item.key}
          className="w-full"
        />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <Label
        htmlFor={item.key}
        className="text-xs text-muted-foreground font-light"
      >
        {labelText}
      </Label>
      {item.type === "input" && (
        <Input
          id={item.key}
          type="text"
          value={inputValue}
          onFocus={() => setIsTyping(true)}
          onBlur={() => setIsTyping(false)}
          onChange={(e) => {
            setInputValue(e.target.value);
            onChange(e.target.value);
          }}
          placeholder={placeholder}
          className="font-light focus:ring-1 focus:ring-ring focus:ring-offset-1 m-0 w-48 px-[12px] py-[0px] rounded-[6px] placeholder:text-muted-foreground/40"
        />
      )}
      {item.type === "number" && (
        <Input
          id={item.key}
          type="number"
          value={inputValue}
          onFocus={() => setIsTyping(true)}
          onBlur={() => setIsTyping(false)}
          onChange={(e) => {
            setInputValue(e.target.value);
            onChange(e.target.value);
          }}
          placeholder={placeholder}
          className="font-light focus:ring-1 focus:ring-ring focus:ring-offset-1 m-0 w-48 px-[12px] py-[0px] rounded-[6px] placeholder:text-muted-foreground/40"
        />
      )}
      {item.type === "textarea" && (
        <Textarea
          id={item.key}
          value={inputValue}
          onFocus={() => setIsTyping(true)}
          onBlur={() => setIsTyping(false)}
          onChange={(e) => {
            setInputValue(e.target.value);
            onChange(e.target.value);
          }}
          placeholder={placeholder}
          className="font-light focus:ring-1 focus:ring-ring focus:ring-offset-1 m-0 w-64 px-[12px] py-[6px] placeholder:text-muted-foreground/40"
        />
      )}
      {item.type === "select" && (
        <Select value={typeof inputValue === 'string' ? inputValue : ''} onValueChange={(v) => { setInputValue(v); onChange(v); }}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {(((item as any).options as any[]) || []).map((opt: any) => (
              <SelectItem key={`${item.key}-${opt?.value ?? ''}`} value={opt?.value ?? ''}>
                {opt?.label ?? ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
};