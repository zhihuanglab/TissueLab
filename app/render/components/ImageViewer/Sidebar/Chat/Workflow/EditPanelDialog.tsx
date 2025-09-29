import React, { useState } from "react";
import { Edit, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkflowPanel, ContentItem } from "@/store/slices/workflowSlice";
import { EditPanelDialogProps } from "./types";

export const EditPanelDialog: React.FC<EditPanelDialogProps> = ({ panel, onSave }) => {
  const [editedPanel, setEditedPanel] = useState<WorkflowPanel>({ ...panel });
  const [open, setOpen] = useState(false);

  const handleContentChange = (index: number, field: keyof ContentItem, value: string) => {
    setEditedPanel((prev) => ({
      ...prev,
      content: prev.content.map((item, i) => (i === index ? { ...item, [field]: value } : item)),
    }));
  };

  const handleAddField = () => {
    setEditedPanel((prev) => ({
      ...prev,
      content: [...prev.content, { key: "", type: "input", value: "" }],
    }));
  };

  const handleRemoveField = (index: number) => {
    setEditedPanel((prev) => ({
      ...prev,
      content: prev.content.filter((_, i) => i !== index),
    }));
  };

  const handleSave = () => {
    onSave(editedPanel);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
          <Edit className="h-4 w-4" />
          <span className="sr-only">Edit Parameters</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Edit {panel.title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          {editedPanel.content.map((item, index) => (
            <div key={index} className="grid gap-2">
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor={`key-${index}`} className="text-right">
                  Key
                </Label>
                <Input
                  id={`key-${index}`}
                  value={item.key}
                  onChange={(e) => handleContentChange(index, "key", e.target.value)}
                  className="col-span-3"
                />
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor={`type-${index}`} className="text-right">
                  Type
                </Label>
                <Select
                  value={item.type}
                  onValueChange={(value) => handleContentChange(index, "type", value as ContentItem["type"])}
                  disabled={true}
                >
                  <SelectTrigger className="col-span-3">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="input">Input</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => handleRemoveField(index)}>
                  <X className="h-4 w-4" />
                  <span className="sr-only">Remove Field</span>
                </Button>
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" onClick={handleAddField}>
            Add Field
          </Button>
        </div>
        <div className="flex justify-end">
          <Button type="button" onClick={handleSave}>
            Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}; 