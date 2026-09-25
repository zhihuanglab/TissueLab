import React from 'react';
import { ChevronRight } from 'lucide-react';
import { ROOT_DISPLAY } from '../../constants/fm.constants';

interface BreadcrumbsProps {
  currentDirectory: string;
  personalRoot: string;
  onNavigate: (path: string) => void;
}

export const Breadcrumbs: React.FC<BreadcrumbsProps> = ({
  currentDirectory,
  personalRoot,
  onNavigate,
}) => {
  const allParts = (currentDirectory || '').split('/').filter(p => p);

  let baseName: string | null = null;
  let baseParts: string[] = [];
  let baseClickPath: string | null = null;

  if (personalRoot && allParts.slice(0, personalRoot.split('/').length).join('/') === personalRoot) {
    baseName = ROOT_DISPLAY.personal;
    baseParts = personalRoot.split('/');
    baseClickPath = personalRoot;
  } else if (allParts[0] === 'samples') {
    baseName = ROOT_DISPLAY.samples;
    baseParts = ['samples'];
    baseClickPath = 'samples';
  }

  const relativeParts = baseName ? allParts.slice(baseParts.length) : allParts;

  return (
    <div className="flex items-center text-xs sm:text-sm text-gray-500 overflow-x-auto scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent py-1">
      {baseName && (
        <span
          className="cursor-pointer hover:underline p-1 rounded truncate max-w-[80px] sm:max-w-none shrink-0"
          title={baseName}
          onClick={() => {
            if (baseClickPath) {
              onNavigate(baseClickPath);
            } else if (baseParts.length > 0) {
              onNavigate(baseParts.join('/'))
            }
          }}
        >
          {baseName}
        </span>
      )}

      {relativeParts.length > 0 && baseName && (
        <ChevronRight className="h-3 w-3 sm:h-4 sm:w-4 mx-0.5 sm:mx-1 shrink-0" />
      )}
      {relativeParts.map((part, index) => {
        const fullParts = baseName
          ? baseParts.concat(relativeParts.slice(0, index + 1))
          : allParts.slice(0, index + 1);
        const pathUntilThisPart = fullParts.join('/');
        return (
          <React.Fragment key={`${pathUntilThisPart}:${index}`}>
            <span
              className="cursor-pointer hover:underline p-1 rounded truncate max-w-[100px] sm:max-w-[150px] md:max-w-none shrink-0"
              title={part}
              onClick={() => onNavigate(pathUntilThisPart)}
            >
              {part}
            </span>
            {index < relativeParts.length - 1 && <ChevronRight className="h-3 w-3 sm:h-4 sm:w-4 mx-0.5 sm:mx-1 shrink-0" />}
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default Breadcrumbs;
