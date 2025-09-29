import React from 'react';
import { Folder, ChevronRight } from 'lucide-react';
import { VIRTUAL_ROOT, SHARED_ROOT, ROOT_DISPLAY } from '../../constants/fm.constants';

interface BreadcrumbsProps {
  currentDirectory: string;
  personalRoot: string;
  isLoggedIn: boolean;
  isInSharedContext: (path: string) => boolean;
  onNavigate: (path: string) => void;
}

export const Breadcrumbs: React.FC<BreadcrumbsProps> = ({
  currentDirectory,
  personalRoot,
  isLoggedIn,
  isInSharedContext,
  onNavigate,
}) => {
  const allParts = (currentDirectory || '').split('/').filter(p => p);

  let baseName: string | null = null;
  let baseParts: string[] = [];
  let baseClickPath: string | null = null;

  if (isLoggedIn) {
    if (currentDirectory === VIRTUAL_ROOT) {
      baseName = null;
      baseParts = [];
      baseClickPath = null;
    } else if (currentDirectory === SHARED_ROOT) {
      baseName = ROOT_DISPLAY.shared;
      baseParts = [SHARED_ROOT];
      baseClickPath = SHARED_ROOT;
    } else if (!isInSharedContext(currentDirectory) && personalRoot && allParts.slice(0, personalRoot.split('/').length).join('/') === personalRoot) {
      baseName = ROOT_DISPLAY.personal;
      baseParts = personalRoot.split('/');
      baseClickPath = personalRoot;
    } else if (allParts[0] === 'samples') {
      baseName = ROOT_DISPLAY.samples;
      baseParts = ['samples'];
      baseClickPath = 'samples';
    } else if (allParts[0] === 'users' && allParts[1]) {
      baseName = ROOT_DISPLAY.shared;
      baseParts = ['users', allParts[1]];
      baseClickPath = SHARED_ROOT;
    } else if (isInSharedContext(currentDirectory)) {
      baseName = ROOT_DISPLAY.shared;
      baseClickPath = SHARED_ROOT;
      baseParts = [SHARED_ROOT];
    }
  }

  const relativeParts = isLoggedIn
    ? (baseName ? allParts.slice(baseParts.length) : (currentDirectory === VIRTUAL_ROOT ? [] : allParts))
    : allParts.slice(allParts[0] === 'samples' ? 1 : 0);

  return (
    <div className="flex items-center text-sm text-gray-500">
      <span 
        className="cursor-pointer hover:underline p-1 rounded flex items-center gap-2"
        onClick={() => {
          if (isLoggedIn) {
            onNavigate(VIRTUAL_ROOT);
          } else {
            onNavigate('samples');
          }
        }}
      >
        <Folder className="h-4 w-4" />
        {isLoggedIn ? ROOT_DISPLAY.root : ROOT_DISPLAY.samples}
      </span>

      {isLoggedIn && baseName && <ChevronRight className="h-4 w-4 mx-1" />}
      {isLoggedIn && baseName && (
        <span
          className="cursor-pointer hover:underline p-1 rounded"
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

      {relativeParts.length > 0 && <ChevronRight className="h-4 w-4 mx-1" />}
      {relativeParts.map((part, index) => {
        const fullParts = baseName
          ? baseParts.concat(relativeParts.slice(0, index + 1))
          : allParts.slice(0, index + 1);
        const pathUntilThisPart = fullParts.join('/');
        return (
          <React.Fragment key={`${pathUntilThisPart}:${index}`}>
            <span
              className="cursor-pointer hover:underline p-1 rounded"
              onClick={() => onNavigate(pathUntilThisPart)}
            >
              {part}
            </span>
            {index < relativeParts.length - 1 && <ChevronRight className="h-4 w-4 mx-1" />}
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default Breadcrumbs;


