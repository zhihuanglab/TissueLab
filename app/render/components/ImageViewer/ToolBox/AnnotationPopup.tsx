"use client"

import {useEffect, useState} from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Tag } from "lucide-react"
import { ImageAnnotation } from "@annotorious/react";
import { useDispatch, useSelector} from "react-redux";
import { AppDispatch, RootState } from "@/store";
import {
  selectPatchClassificationData,
  setPatchClassificationData,
} from "@/store/slices/viewer/annotationSlice";
import { validateAndFixColor } from "@/utils/colorUtils";
import FilterContent from "./FilterContent";
import RulerContent from "./RulerContent";
import SelectionContent, { SelectionContentFooter } from "./SelectionContent";

interface AnnotationPopupProps {
  annotation: ImageAnnotation
  selectedTool: string
  onSave: (color: string, customText?: string) => void
  onCancel: () => void
  annotatorInstance: any
  instanceId?: string | null
}

export default function AnnotationPopup({
annotation,
selectedTool,
onSave = () => {},
onCancel = () => {},
annotatorInstance,
instanceId: instanceIdProp
}: AnnotationPopupProps) {
  const [selectedColor, setSelectedColor] = useState(() => {
    const styleBody = annotation.bodies.find(b => b.purpose === 'style');
    return styleBody?.value || '#00ff00';
  });
  const [customText, setCustomText] = useState(() => {
    const commentBody = annotation.bodies.find(b => b.purpose === 'comment');
    return commentBody?.value || "";
  });

  const nucleiClasses = useSelector((state: RootState) => state.annotations.nucleiClasses)
  const reduxPatchClassificationData = useSelector(selectPatchClassificationData);
  const dispatch = useDispatch<AppDispatch>();
  const shapeCoords = useSelector((state: RootState) => state.shape.shapeData?.rectangleCoords);

  // Check if this is a ruler tool or filter tool
  const isRulerTool = selectedTool === 'line' || annotation.target.selector?.type === 'LINE';
  const isFilterTool = selectedTool === 'filter';

  useEffect(() => {
    if (!reduxPatchClassificationData || !reduxPatchClassificationData.class_name || reduxPatchClassificationData.class_name.length === 0) {
      dispatch(setPatchClassificationData({
        class_id: [0],
        class_name: ['Negative control'],
        class_hex_color: ['#aaaaaa']
      }));
    }
  }, [reduxPatchClassificationData, dispatch]);

  const handleColorChange = async (color: string) => {
    // Get existing colors from nuclei classes and patch classification data
    const existingColors = [
      ...nucleiClasses.map(c => c.color),
      ...(reduxPatchClassificationData?.class_hex_color || [])
    ];
    
    // Validate and fix color if it's black or white
    const validatedColor = validateAndFixColor(color, existingColors);
    setSelectedColor(validatedColor);
  }

  const classificationBody = annotation.bodies.find(b => b.purpose === 'classification');

  const handleCancel = () => {
    // close the popup
    onCancel();
  };

  useEffect(() => {
    const commentBody = annotation.bodies.find(b => b.purpose === 'comment');
    setCustomText(commentBody?.value || "");
  }, [annotation]);

  return (
      <Card
          className="w-full max-w-lg relative z-50 shadow-lg border-0"
      >
        <div className="flex flex-col">
          <CardHeader className="py-1 px-3 shrink-0">
            <CardTitle className="flex items-center space-x-2 text-sm">
              <Tag className="w-4 h-4"/>
              <span>Annotation</span>
            </CardTitle>
          </CardHeader>

          <CardContent className="py-0.5 px-3 overflow-hidden">
            <div className="space-y-2">
              {isRulerTool ? (
                <RulerContent annotation={annotation} />
              ) : isFilterTool ? (
                <FilterContent shapeCoords={shapeCoords || null} instanceId={instanceIdProp} />
              ) : (
                <SelectionContent 
                  annotation={annotation}
                  customText={customText} 
                  onTextChange={setCustomText}
                  selectedColor={selectedColor}
                  onColorChange={handleColorChange}
                  selectedTool={selectedTool}
                  annotatorInstance={annotatorInstance}
                  instanceId={instanceIdProp}
                  onCancel={onCancel}
                  onSave={onSave}
                  shapeCoords={shapeCoords || null}
                />
              )}
              {classificationBody && (
                  <div className="mt-2 text-sm">
                    <Label>Current Class:</Label>
                    <div className="text-foreground">{classificationBody.value}</div>
                  </div>
              )}
            </div>
          </CardContent>

          {isRulerTool ? (
            <div className="px-3 py-1 flex justify-end items-center">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleCancel}>
                  Delete
                </Button>
                <Button
                  size="sm"
                  onClick={() => onSave(selectedColor, customText)}
                  disabled={!selectedColor}
                >
                  Save
                </Button>
              </div>
            </div>
          ) : isFilterTool ? (
            <div className="px-3 py-1 flex justify-end items-center">
              <Button variant="outline" size="sm" onClick={handleCancel}>
                Close
              </Button>
            </div>
          ) : (
            <SelectionContentFooter
              selectedColor={selectedColor}
              customText={customText}
              onSave={onSave}
              onCancel={onCancel}
              annotatorInstance={annotatorInstance}
              shapeCoords={shapeCoords || null}
            />
          )}
        </div>
      </Card>
  );
}
