import { ArrowBigDown, Plus } from "lucide-react";
import React from "react";

export interface ImportModelCardProps {
  onTriggerClick: () => void;
}

export const ImportModelCard: React.FC<ImportModelCardProps> = ({
  onTriggerClick,
}) => {
  return (
    <>
      <div 
        className="relative rounded-xl p-12 pb-16 text-center transition-all duration-200 bg-secondary/30 text-secondary-foreground hover:bg-secondary/80 cursor-pointer flex flex-col items-center justify-center"
        onClick={onTriggerClick}
      >
        {/* Dashed border with more spacing using SVG */}
        <svg className="absolute inset-0 w-full h-full rounded-xl pointer-events-none overflow-visible">
          <rect 
            x="1" 
            y="1" 
            width="calc(100% - 2px)" 
            height="calc(100% - 2px)" 
            rx="0.75rem" 
            fill="none" 
            stroke="hsl(var(--border))" 
            strokeWidth="2" 
            strokeDasharray="6 6"
          />
        </svg>
        <div className="relative z-10 flex flex-col items-center justify-center pt-6">
          <Plus className="h-16 w-16 mb-2 transition-colors text-secondary-foreground/90" strokeWidth={1} />
          <p className="text-sm text-secondary-foreground/50 text-center leading-relaxed">
            Import your models<br className="block mb-1" />and then start workflow
          </p>
        </div>
      </div>
      {/* Arrow between cards */}
      <div className="flex justify-center py-1">
        <ArrowBigDown className="h-5 w-5 text-muted-foreground/15 fill-current" aria-hidden />
      </div>
      {/* Faded duplicate card - visual continuation affordance */}
      <div 
        className="relative rounded-xl p-12 pb-16 text-center bg-secondary/30 text-secondary-foreground flex flex-col items-center justify-center pointer-events-none"
        style={{
          maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.4) 40%, rgba(0,0,0,0.1) 60%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.4) 30%, rgba(0,0,0,0.1) 60%, transparent 100%)',
        }}
      >
        {/* Dashed border with more spacing using SVG */}
        <svg className="absolute inset-0 w-full h-full rounded-xl pointer-events-none overflow-visible">
          <rect 
            x="1" 
            y="1" 
            width="calc(100% - 2px)" 
            height="calc(100% - 2px)" 
            rx="0.75rem" 
            fill="none" 
            stroke="hsl(var(--border))" 
            strokeWidth="2" 
            strokeDasharray="6 6"
          />
        </svg>
        <div className="relative z-10 flex flex-col items-center justify-center pt-6 opacity-40">
        </div>
      </div>
    </>
  );
};
