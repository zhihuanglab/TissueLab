"use client";
import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { WorkflowPanel, ContentItem } from "@/store/slices/chat/workflowSlice";
import { getErrorMessage } from "@/utils/common/apiResponse";

type SchemaImportDialogProps = {
  onImportPanel: (panel: WorkflowPanel) => void;
};

type JsonPanelSchema = {
  title: string;
  type?: string; // backend node type
  ui?: Record<string, any> | null;
  panel: Array<{
    key: string;
    type: string; // input | number | textarea | select
    value?: string;
    label?: string;
    placeholder?: string;
    options?: { label: string; value: string }[];
  }>;
};

export const SchemaImportDialog: React.FC<SchemaImportDialogProps> = ({ onImportPanel }) => {
  const [open, setOpen] = useState(false);
  const [jsonText, setJsonText] = useState<string>(`{
  "title": "TotalSegmentator",
  "type": "TotalSegmentatorNode",
  "panel": [
    { "key": "region", "type": "select", "value": "total", "label": "Region", "options": [
      { "label": "Total (all organs)", "value": "total" },
      { "label": "Thorax", "value": "thorax" },
      { "label": "Abdomen", "value": "abdomen" },
      { "label": "Head & Neck", "value": "headneck" },
      { "label": "Cardiac", "value": "cardiac" }
    ]},
    { "key": "target_spacing", "type": "input", "value": "1.5,1.5,1.5", "label": "Target Spacing (mm)" },
    { "key": "confidence_threshold", "type": "number", "value": "0.5", "label": "Confidence Threshold" },
    { "key": "batch_size", "type": "number", "value": "1", "label": "Batch Size" }
  ]
}`);
  const [error, setError] = useState<string | null>(null);

  const parseAndImport = () => {
    setError(null);
    try {
      const schema = JSON.parse(jsonText) as JsonPanelSchema;
      if (!schema || !schema.title || !Array.isArray(schema.panel)) {
        throw new Error("Invalid schema: missing title or panel array");
      }
      const panel: WorkflowPanel = {
        id: Date.now().toString(),
        title: schema.title,
        type: (schema.type && typeof schema.type === 'string') ? schema.type : 'CustomNode',
        progress: 0,
        content: schema.panel.map((c) => ({
          key: c.key,
          type: c.type,
          value: c.value ?? "",
          label: c.label,
          placeholder: c.placeholder,
          options: c.options,
        })) as ContentItem[],
        ui: (schema?.ui && typeof schema.ui === 'object') ? schema.ui : null,
      };
      onImportPanel(panel);
      setOpen(false);
    } catch (e: any) {
      setError(getErrorMessage(e, 'Failed to parse schema'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Import From JSON</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>Import Panel From JSON</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} rows={14} />
          {error && <div className="text-destructive text-sm">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={parseAndImport}>Import</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SchemaImportDialog;

