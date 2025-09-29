"use client";

import React from "react";
import { AnnotationClass } from "@/store/slices/annotationSlice";

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
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <h6 style={{ fontSize: '14px', fontWeight: '500', color: '#374151', margin: 0 }}>Cell Class</h6>
        <span style={{ 
          fontSize: '12px', 
          color: '#6b7280', 
          fontStyle: 'italic'
        }}>
          Please select cell type
        </span>
      </div>
      
      <div style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        gap: '4px', 
        maxHeight: '240px', 
        overflowY: 'auto', 
        border: '1px solid #e5e7eb', 
        borderRadius: '6px', 
        padding: '8px' 
      }}>
        {/* Class options */}
        {allClasses.map((cls, index) => {
          const isSelected = selectedClass === cls.name;
          
          return (
            <div 
              key={index} 
              style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '8px',
                cursor: 'pointer',
                padding: '4px',
                borderRadius: '4px',
                backgroundColor: isSelected ? '#f3f4f6' : 'transparent'
              }}
              onClick={() => onSelectClass(cls.name)}
            >
              {/* Radio button */}
              <div style={{
                width: '16px',
                height: '16px',
                borderRadius: '50%',
                border: '2px solid #d1d5db',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}>
                {isSelected && (
                  <div style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: '#3b82f6'
                  }} />
                )}
              </div>
              
              {/* Color square */}
              <div 
                style={{ 
                  width: '16px', 
                  height: '16px', 
                  borderRadius: '4px', 
                  border: '1px solid #d1d5db', 
                  flexShrink: 0,
                  backgroundColor: cls.color 
                }}
              />
              
              {/* Class name */}
              <span style={{ 
                fontSize: '14px', 
                flex: 1, 
                whiteSpace: 'nowrap', 
                overflow: 'hidden', 
                textOverflow: 'ellipsis' 
              }} title={cls.name}>
                {cls.name}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>
        {selectedClass ? `Selected: ${selectedClass}` : 'No class selected'}
      </div>
    </div>
  );
};

export default ClassList;