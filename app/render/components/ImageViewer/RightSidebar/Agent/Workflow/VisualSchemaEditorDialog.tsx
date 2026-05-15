"use client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import { ContentItem, WorkflowPanel } from "@/store/slices/chat/workflowSlice";
import { apiFetch } from '@/utils/common/apiFetch';
import { getErrorMessage } from "@/utils/common/apiResponse";
import { ArrowDown, ArrowUp, Edit as EditIcon, FileText, Hash, Lightbulb, List, Palette, Type } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";

type VisualSchemaEditorDialogProps = {
  panel: WorkflowPanel;
  onSave: (updated: WorkflowPanel) => void;
  trigger?: React.ReactNode;
  dialogTitle?: string;
  disableNodeTypeEdit?: boolean;
  inline?: boolean;
  storageKey?: string;
  /** Controlled: open/close by parent (no trigger rendered; used when opening from dropdown) */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

type DraftField = {
  key: string;
  type: ContentItem["type"];
  value: string;
  options?: { label: string; value: string }[];
  presetOptions?: string[];
};

export const VisualSchemaEditorDialog: React.FC<VisualSchemaEditorDialogProps> = ({ panel, onSave, trigger, dialogTitle, disableNodeTypeEdit = false, inline = false, storageKey = 'tissuelab_custom_workflow_panels', open: controlledOpen, onOpenChange: controlledOnOpenChange }) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined && controlledOnOpenChange !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = isControlled ? (v: boolean) => controlledOnOpenChange!(v) : setInternalOpen;
  const [title, setTitle] = useState(panel.title || "Custom Panel");
  const [nodeType, setNodeType] = useState(panel.type || "CustomNode");
  const [availableNodeTypes, setAvailableNodeTypes] = useState<string[]>([]);
  const [scrollAreaHeight, setScrollAreaHeight] = useState<number>(300);
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFields = useMemo<DraftField[]>(() => {
    return (panel.content || [])
      .filter((c) => String(c.key || '').toLowerCase() !== 'path')
      .map((c) => ({
        key: c.key,
        type: c.type as DraftField["type"],
        value: String((c as any).value ?? ""),
        options: (c as any).options,
        presetOptions: (c as any).presetOptions,
      }));
  }, [panel]);
  const [fields, setFields] = useState<DraftField[]>(initialFields);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchNodes = async () => {
      try {
        const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_nodes_extended`, {
          method: 'GET',
          returnAxiosFormat: true,
        });
        const nodes = Object.keys(resp?.data?.nodes ?? {});
        setAvailableNodeTypes(nodes);
      } catch {}
    };
    fetchNodes();
  }, []);

  const addField = () => setFields((prev) => [...prev, { key: "", type: "input", value: "" }]);
  const removeField = (idx: number) => setFields((prev) => prev.filter((_, i) => i !== idx));

  // Calculate the height of the ScrollArea
  useEffect(() => {
    const updateScrollAreaHeight = () => {
      if (dialogRef.current) {
        const dialogContent = dialogRef.current.querySelector('[data-radix-dialog-content]');
        if (dialogContent) {
          // Calculate the available height of the DialogContent
          const dialogRect = dialogContent.getBoundingClientRect();
          const totalHeight = dialogRect.height;

          // Subtract the height of the top region (approximately 120px, including the title and form fields)
          const headerHeight = 120;
          // Subtract the height of the bottom region (approximately 80px, including the button region)
          const footerHeight = 80;

          const availableHeight = totalHeight - headerHeight - footerHeight;
          const calculatedHeight = Math.max(availableHeight, 200); // Minimum height 200px

          setScrollAreaHeight(calculatedHeight);
        }
      }
    };

    // Listen to the Dialog open state and window size changes
    if (open) {
      // Delay execution, ensure the Dialog is fully rendered
      const timeoutId = setTimeout(updateScrollAreaHeight, 100);

      window.addEventListener('resize', updateScrollAreaHeight);

      return () => {
        clearTimeout(timeoutId);
        window.removeEventListener('resize', updateScrollAreaHeight);
      };
    }
  }, [open, fields.length]); // Depend on fields changes, because the content changes will affect the layout

  // Removed ScrollArea height calculation for inline mode - no longer needed

  const moveFieldUp = (idx: number) => {
    if (idx <= 0) return;
    setFields((prev) => {
      const next = prev.slice();
      const tmp = next[idx - 1];
      next[idx - 1] = next[idx];
      next[idx] = tmp;
      return next;
    });
  };

  const moveFieldDown = (idx: number) => {
    setFields((prev) => {
      if (idx < 0 || idx >= prev.length - 1) return prev;
      const next = prev.slice();
      const tmp = next[idx + 1];
      next[idx + 1] = next[idx];
      next[idx] = tmp;
      return next;
    });
  };

  const updateField = (idx: number, patch: Partial<DraftField>) => {
    setFields((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };

  const addOption = (idx: number) => {
    const opts = fields[idx].options || [];
    updateField(idx, { options: [...opts, { label: "", value: "" }] });
  };

  const updateOption = (idx: number, optIdx: number, patch: Partial<{ label: string; value: string }>) => {
    const opts = fields[idx].options || [];
    const next = opts.map((o, i) => (i === optIdx ? { ...o, ...patch } : o));
    updateField(idx, { options: next });
  };

  const removeLastOption = (idx: number) => {
    const opts = fields[idx].options || [];
    if (opts.length === 0) return;
    updateField(idx, { options: opts.slice(0, -1) });
  };

  const handleSave = () => {
    setError(null);
    try {
      if (!title.trim()) throw new Error("Title is required");
      if (!nodeType.trim()) throw new Error("Node type is required");
      if (fields.length === 0) throw new Error("At least one field is required");
      // Validate reserved keys
      const hasReservedPath = fields.some((f) => String(f.key || '').trim().toLowerCase() === 'path')
      if (hasReservedPath) {
        throw new Error("'path' is a reserved key and cannot be used.")
      }

      // Validate empty keys (tips type can have empty key)
      const emptyKeys = fields.filter(f => f.type !== "tips" && !f.key.trim())
      if (emptyKeys.length > 0) {
        throw new Error("All fields except tips must have a key. Please fill in all key fields.")
      }

      // Validate select options
      const selectFields = fields.filter(f => f.type === "select")
      for (const field of selectFields) {
        if (field.options) {
          const emptyOptions = field.options.filter(opt => !opt.value.trim())
          if (emptyOptions.length > 0) {
            throw new Error(`Select field "${field.key}" has empty option values. Please fill in all option values.`)
          }
        }
      }

      // Validate duplicate keys (exclude tips with empty keys)
      const keys = fields
        .filter(f => f.type !== "tips" || f.key.trim())
        .map(f => f.key.trim().toLowerCase())
        .filter(k => k.length > 0)
      const keyCounts = keys.reduce((acc, key) => {
        acc[key] = (acc[key] || 0) + 1
        return acc
      }, {} as Record<string, number>)
      const duplicates = Object.entries(keyCounts).filter(([_, count]) => count > 1)
      if (duplicates.length > 0) {
        const duplicateKeys = duplicates.map(([key, _]) => key).join(', ')
        throw new Error(`Duplicate keys found: ${duplicateKeys}. Please ensure all keys are unique.`)
      }

      const content: ContentItem[] = fields.map((f) => {
        const isNumber = f.type === "number";
        const numeric = Number(f.value);
        const typedValue = isNumber ? (Number.isFinite(numeric) ? numeric : 0) : (f.value ?? "");
        return ({
          key: f.key,
          type: f.type,
          value: typedValue,
          label: f.key, // keep label in sync with key since label editing is removed
          options: f.options,
          presetOptions: f.presetOptions,
        } as any)
      });
      const updated: WorkflowPanel = {
        ...panel,
        title,
        type: nodeType,
        content,
      };
      // Ensure each new/edited field has a default value string to avoid undefined rendering
      updated.content = (updated.content || []).map((c: any) => ({
        ...c,
        value: c.type === 'number' ? (Number.isFinite(Number(c.value)) ? Number(c.value) : 0) : (typeof c.value === 'string' ? c.value : (c.value ?? '')),
      }));
      onSave(updated);

      // Panel data is now persisted to model_registry via backend API

      setOpen(false);
    } catch (e: any) {
      setError(getErrorMessage(e, "Failed to save panel"));
    }
  };


  // Call onSave when form changes in inline mode (but don't save to localStorage)
  React.useEffect(() => {
    if (inline && onSave) {
      const currentPanel: WorkflowPanel = {
        id: panel.id,
        title,
        type: nodeType,
        progress: 0,
        content: fields.map(f => ({
          key: f.key,
          type: f.type,
          value: f.value,
          options: f.options,
          presetOptions: f.presetOptions
        })),
        ui: null
      };
      onSave(currentPanel);
    }
  }, [inline, title, nodeType, fields, panel.id, onSave]);


  // In inline mode, directly render the content
  if (inline) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-4 items-center gap-4 pr-2">
          <Label className="text-right">Title</Label>
          <Input className="col-span-3 rounded-[6px]" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="grid grid-cols-4 items-center gap-4 pr-2">
          <Label className="text-right">Node Type</Label>
          {disableNodeTypeEdit ? (
            <Input
              className="col-span-3 rounded-[6px]"
              value={nodeType}
              disabled
              placeholder="Node type is set by factory selection"
            />
          ) : (
            <Select value={nodeType} onValueChange={setNodeType}>
              <SelectTrigger className="col-span-3">
                <SelectValue placeholder="Select node" />
              </SelectTrigger>
              <SelectContent>
                {availableNodeTypes.map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="space-y-3">
          {fields.map((f, idx) => (
              <div key={idx} className="rounded-md border p-2 mb-2 space-y-1 bg-card">
                <div className="grid grid-cols-4 items-center gap-2">
                  <Label className="text-right text-sm">Key</Label>
                  <Input
                    className="col-span-3 h-8 rounded-[6px]"
                    value={f.key}
                    onChange={(e) => {
                      const v = e.target.value;
                      const lower = v.trim().toLowerCase();
                      if (lower === 'prompt') {
                        updateField(idx, { key: v, type: 'textarea' });
                      } else {
                        updateField(idx, { key: v });
                      }
                    }}
                  />
                </div>
                <div className="grid grid-cols-4 items-center gap-2">
                  <Label className="text-right text-sm">Type</Label>
                  <Select
                    value={f.type}
                    onValueChange={(v) => updateField(idx, { type: v as DraftField["type"] })}
                    disabled={f.key.trim().toLowerCase() === 'prompt'}
                  >
                    <SelectTrigger className="col-span-3 h-8">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                    <SelectItem value="input">
                        <div className="flex items-center gap-2">
                          <Type className="h-4 w-4" />
                          Text
                        </div>
                      </SelectItem>
                      <SelectItem value="number">
                        <div className="flex items-center gap-2">
                          <Hash className="h-4 w-4" />
                          Number
                        </div>
                      </SelectItem>
                      <SelectItem value="textarea">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4" />
                          Textarea
                        </div>
                      </SelectItem>
                      <SelectItem value="select">
                        <div className="flex items-center gap-2">
                          <List className="h-4 w-4" />
                          Select
                        </div>
                      </SelectItem>
                      <SelectItem value="tips">
                        <div className="flex items-center gap-2">
                          <Lightbulb className="h-4 w-4" />
                          Tips
                        </div>
                      </SelectItem>
                      <SelectItem value="color-selector">
                        <div className="flex items-center gap-2">
                          <Palette className="h-4 w-4" />
                          Color Selector
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {f.type === "textarea" || f.type === "tips" ? (
                  <div className="grid grid-cols-4 items-start gap-2">
                    <Label className="text-right text-sm">Text</Label>
                    <Textarea className="col-span-3" value={f.value} onChange={(e) => updateField(idx, { value: e.target.value })} rows={2} />
                  </div>
                ) : null}
                {f.type === "color-selector" ? (
                  <div className="grid grid-cols-4 items-start gap-2">
                    <Label className="text-right text-sm">Configuration</Label>
                    <div className="col-span-3">
                      <Label className="text-sm font-medium">Preset Options</Label>
                      <div className="space-y-1 mt-1">
                        {((f as any).presetOptions || []).map((option: string, oi: number) => (
                          <div key={oi} className="flex items-center gap-2">
                            <Input 
                              value={option} 
                              onChange={(e) => {
                                const newOptions = [...((f as any).presetOptions || [])];
                                newOptions[oi] = e.target.value;
                                updateField(idx, { presetOptions: newOptions });
                              }}
                              className="h-8 text-sm flex-1 rounded-[6px]"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                const newOptions = ((f as any).presetOptions || []).filter((_: any, i: number) => i !== oi);
                                updateField(idx, { presetOptions: newOptions });
                              }}
                              className="h-8 w-8 p-0 text-destructive hover:text-destructive/80"
                            >
                              ×
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const newOptions = [...((f as any).presetOptions || []), "New Option"];
                            updateField(idx, { presetOptions: newOptions });
                          }}
                          className="h-8 text-sm"
                        >
                          + Add Preset Option
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
                {f.type !== "textarea" && f.type !== "tips" && f.type !== "select" && f.type !== "color-selector" && (
                  <div className="grid grid-cols-4 items-center gap-2">
                    <Label className="text-right text-sm">Value</Label>
                    <Input className="col-span-3 h-8 rounded-[6px]" value={f.value} onChange={(e) => updateField(idx, { value: e.target.value })} />
                  </div>
                )}
                {f.type === "select" && (
                  <div className="grid grid-cols-4 items-start gap-2">
                    <Label className="text-right text-sm">Options</Label>
                    <div className="col-span-3 space-y-1">
                      {(f.options || []).map((opt, oi) => (
                        <div key={oi} className="grid grid-cols-6 gap-1 items-center">
                          <Input className="col-span-3 h-7 rounded-[6px] placeholder:text-muted-foreground/40" placeholder="Label" value={opt.label} onChange={(e) => updateOption(idx, oi, { label: e.target.value })} />
                          <Input className="col-span-3 h-7 rounded-[6px] placeholder:text-muted-foreground/40" placeholder="Value" value={opt.value} onChange={(e) => updateOption(idx, oi, { value: e.target.value })} />
                        </div>
                      ))}
                      <div className="flex gap-1">
                        <Button variant="outline" type="button" size="sm" onClick={() => addOption(idx)}>Add Option</Button>
                        {(f.options || []).length > 0 && (
                          <Button variant="ghost" type="button" size="sm" onClick={() => removeLastOption(idx)}>Remove Last</Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => moveFieldUp(idx)}
                      disabled={idx === 0}
                      title="Move up"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => moveFieldDown(idx)}
                      disabled={idx === fields.length - 1}
                      title="Move down"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeField(idx)}>Remove</Button>
                </div>
              </div>
            ))}
            <div className="pt-2">
              <Button type="button" variant="outline" size="sm" onClick={addField}>Add Field</Button>
            </div>
        </div>

        {error && <div className="text-destructive text-sm">{error}</div>}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!isControlled && (
        <DialogTrigger asChild>
          {trigger || (
            <Button variant="outline" size="icon" className="h-7 w-7 ml-1 rounded-[4px] border border-border bg-transparent text-muted-foreground hover:text-foreground hover:bg-card" title="Edit Panel">
              <EditIcon className="h-4 w-4" />
              <span className="sr-only">Edit Panel</span>
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent
        ref={dialogRef}
        className="sm:max-w-[600px] max-h-[85vh] overflow-hidden grid grid-rows-[auto_1fr_auto]"
      >
        <DialogHeader>
          <DialogTitle>{dialogTitle || "Edit Custom Panel"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-4 items-center gap-4 pr-2">
            <Label className="text-right">Title</Label>
            <Input className="col-span-3 rounded-[6px]" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-4 items-center gap-4 pr-2">
            <Label className="text-right">Node Type</Label>
            {disableNodeTypeEdit ? (
              <Input 
                className="col-span-3 rounded-[6px]" 
                value={nodeType} 
                disabled 
                placeholder="Node type is set by factory selection"
              />
            ) : (
              <Select value={nodeType} onValueChange={setNodeType}>
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder="Select node" />
                </SelectTrigger>
                <SelectContent>
                  {availableNodeTypes.map((n) => (
                    <SelectItem key={n} value={n}>{n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
        <div className="space-y-3 h-full flex flex-col">
          <div className="flex-1 min-h-0">
            <ScrollArea className="pr-2" style={{ height: scrollAreaHeight }}>
            {fields.map((f, idx) => (
              <div key={idx} className="rounded-md border p-3 mb-2 space-y-2 bg-card">
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label className="text-right">Key</Label>
                  <Input
                    className="col-span-3 rounded-[6px]"
                    value={f.key}
                    onChange={(e) => {
                      const v = e.target.value;
                      const lower = v.trim().toLowerCase();
                      if (lower === 'prompt') {
                        updateField(idx, { key: v, type: 'textarea' });
                      } else {
                        updateField(idx, { key: v });
                      }
                    }}
                  />
                </div>
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label className="text-right">Value Type</Label>
                  <Select
                    value={f.type}
                    onValueChange={(v) => updateField(idx, { type: v as DraftField["type"] })}
                    disabled={f.key.trim().toLowerCase() === 'prompt'}
                  >
                    <SelectTrigger className="col-span-3">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="input">
                        <div className="flex items-center gap-2">
                          <Type className="h-4 w-4" />
                          Text
                        </div>
                      </SelectItem>
                      <SelectItem value="number">
                        <div className="flex items-center gap-2">
                          <Hash className="h-4 w-4" />
                          Number
                        </div>
                      </SelectItem>
                      <SelectItem value="textarea">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4" />
                          Textarea
                        </div>
                      </SelectItem>
                      <SelectItem value="select">
                        <div className="flex items-center gap-2">
                          <List className="h-4 w-4" />
                          Select
                        </div>
                      </SelectItem>
                      <SelectItem value="tips">
                        <div className="flex items-center gap-2">
                          <Lightbulb className="h-4 w-4" />
                          Tips
                        </div>
                      </SelectItem>
                      <SelectItem value="color-selector">
                        <div className="flex items-center gap-2">
                          <Palette className="h-4 w-4" />
                          Color Selector
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {f.type === "textarea" || f.type === "tips" ? (
                  <div className="grid grid-cols-4 items-start gap-4">
                    <Label className="text-right">Text</Label>
                    <Textarea className="col-span-3" value={f.value} onChange={(e) => updateField(idx, { value: e.target.value })} rows={3} />
                  </div>
                ) : null}
                {f.type === "color-selector" ? (
                  <div className="grid grid-cols-4 items-start gap-4">
                    <Label className="text-right">Configuration</Label>
                    <div className="col-span-3">
                      <Label className="text-sm font-medium">Preset Options</Label>
                      <div className="space-y-1 mt-1">
                        {((f as any).presetOptions || []).map((option: string, oi: number) => (
                          <div key={oi} className="flex items-center gap-2">
                            <Input 
                              value={option} 
                              onChange={(e) => {
                                const newOptions = [...((f as any).presetOptions || [])];
                                newOptions[oi] = e.target.value;
                                updateField(idx, { presetOptions: newOptions });
                              }}
                              className="h-8 text-sm flex-1 rounded-[6px]"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                const newOptions = ((f as any).presetOptions || []).filter((_: any, i: number) => i !== oi);
                                updateField(idx, { presetOptions: newOptions });
                              }}
                              className="h-8 w-8 p-0 text-destructive hover:text-destructive/80"
                            >
                              ×
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const newOptions = [...((f as any).presetOptions || []), "New Option"];
                            updateField(idx, { presetOptions: newOptions });
                          }}
                          className="h-8 text-sm"
                        >
                          + Add Preset Option
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
                {f.type !== "textarea" && f.type !== "tips" && f.type !== "select" && f.type !== "color-selector" && (
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label className="text-right">Default Value</Label>
                    <Input className="col-span-3 rounded-[6px]" value={f.value} onChange={(e) => updateField(idx, { value: e.target.value })} />
                  </div>
                )}
                {f.type === "select" && (
                  <div className="grid grid-cols-4 items-start gap-4">
                    <Label className="text-right">Options</Label>
                    <div className="col-span-3 space-y-2">
                      {(f.options || []).map((opt, oi) => (
                        <div key={oi} className="grid grid-cols-6 gap-2 items-center">
                          <Input className="col-span-3 rounded-[6px] placeholder:text-muted-foreground/40" placeholder="Label" value={opt.label} onChange={(e) => updateOption(idx, oi, { label: e.target.value })} />
                          <Input className="col-span-3 rounded-[6px] placeholder:text-muted-foreground/40" placeholder="Value" value={opt.value} onChange={(e) => updateOption(idx, oi, { value: e.target.value })} />
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <Button variant="outline" type="button" onClick={() => addOption(idx)}>Add Option</Button>
                        {(f.options || []).length > 0 && (
                          <Button variant="ghost" type="button" onClick={() => removeLastOption(idx)}>Remove Last</Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => moveFieldUp(idx)}
                      disabled={idx === 0}
                      title="Move up"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => moveFieldDown(idx)}
                      disabled={idx === fields.length - 1}
                      title="Move down"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                  </div>
                  <Button type="button" variant="ghost" onClick={() => removeField(idx)}>Remove Field</Button>
                </div>
              </div>
            ))}
            </ScrollArea>
            <div className="pt-2">
              <Button type="button" variant="outline" size="sm" onClick={addField}>Add Field</Button>
            </div>
          </div>
        </div>

        {error && <div className="text-destructive text-sm">{error}</div>}
        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="secondary" onClick={() => {
            setError(null); // Clear error when canceling
            setOpen(false);
          }}>Cancel</Button>
          <Button onClick={handleSave}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default VisualSchemaEditorDialog;

