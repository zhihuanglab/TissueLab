"use client";
import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { WorkflowPanel } from "@/store/slices/chat/workflowSlice";
import { Wand2 } from "lucide-react";
import VisualSchemaEditorDialog from "./VisualSchemaEditorDialog";

type VisualSchemaBuilderDialogProps = {
  onCreatePanel: (panel: WorkflowPanel) => void;
};

export const VisualSchemaBuilderDialog: React.FC<VisualSchemaBuilderDialogProps> = ({ onCreatePanel }) => {
  const [createKey, setCreateKey] = useState(0);

  const getDefaultPanel = () => ({
    id: Date.now().toString(),
    title: "Custom Panel",
    type: "CustomNode",
    progress: 0,
    content: [
      { key: "", type: "input", value: "" } as any,
    ],
    ui: null,
  });

  const handleSave = (updated: WorkflowPanel) => {
    onCreatePanel(updated);
    setCreateKey(prev => prev + 1); // reset state
  };

  return (
    <VisualSchemaEditorDialog
      key={createKey} // use key to reset state
      panel={getDefaultPanel()}
      onSave={handleSave}
      dialogTitle="Create Custom Panel"
      trigger={
        <Button variant="outline">
          <Wand2 className="h-4 w-4 mr-2" />
          Create Custom Panel
        </Button>
      }
    />
  );
};

export default VisualSchemaBuilderDialog;


