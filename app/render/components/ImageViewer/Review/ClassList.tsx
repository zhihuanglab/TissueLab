"use client";

import { AnnotationClass } from "@/store/slices/viewer/annotationSlice";
import React from "react";

interface ClassListProps {
  nucleiClasses: AnnotationClass[];
  selectedClass: string | null;
  onSelectClass: (className: string | null) => void;
}

const ClassList: React.FC<ClassListProps> = ({
  nucleiClasses,
  selectedClass,
  onSelectClass,
}) => {
  // Add safety checks
  const safeNucleiClasses = nucleiClasses || [];
  
  // Add special Active Learning classes
  const specialClasses = [
    { name: "Other", color: "#F3F4F6" },
    { name: "Not Sure", color: "#FED7AA" },
    { name: "Incorrect Segmentation", color: "#FECACA" }
  ];
  
  // Combine all classes
  const allClasses = [...safeNucleiClasses, ...specialClasses];

  return (
    <div>
      {/* Header with title and instruction */}
      <div className="flex items-center gap-2 mb-2">
        <h6 className="text-xs sm:text-sm font-medium text-foreground m-0">Cell Class</h6>
        <span className="text-[10px] sm:text-xs text-muted-foreground italic">
          Please select cell type
        </span>
      </div>
      
      <div className="flex flex-col gap-1 max-h-[180px] sm:max-h-[240px] overflow-y-auto border border-border rounded-md p-1.5 sm:p-2">
        {/* Class options */}
        {allClasses.map((cls, index) => {
          const isSelected = selectedClass === cls.name;
          
          return (
            <div 
              key={index} 
              className={`flex items-center gap-1.5 sm:gap-2 cursor-pointer p-1 sm:p-1.5 rounded ${isSelected ? 'bg-muted' : 'hover:bg-accent'}`}
              onClick={() => onSelectClass(cls.name)}
            >
              {/* Radio button */}
              <div className="w-3 h-3 sm:w-4 sm:h-4 rounded-full border-2 border-border flex items-center justify-center flex-shrink-0">
                {isSelected && (
                  <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-blue-500" />
                )}
              </div>
              
              {/* Color square */}
              <div 
                className="w-3 h-3 sm:w-4 sm:h-4 rounded border border-border flex-shrink-0"
                style={{ backgroundColor: cls.color }}
              />
              
              {/* Class name */}
              <span className="text-xs sm:text-sm flex-1 whitespace-nowrap overflow-hidden text-ellipsis text-foreground" title={cls.name}>
                {cls.name}
              </span>
            </div>
          );
        })}
      </div>
      <div className="text-[10px] sm:text-xs text-muted-foreground mt-1">
        {selectedClass ? `Selected: ${selectedClass}` : 'No class selected'}
      </div>
    </div>
  );
};

export default ClassList;