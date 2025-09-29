import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Database, 
  Table2, 
  BarChart3, 
  FileText, 
  X, 
  Eye, 
  Folder,
  Info,
  Settings,
  ChevronRight,
  ChevronDown,
  Hash,
  Type,
  Layers,
  Archive,
  Calendar,
  HardDrive
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';

// Type definitions
interface H5CardProps {
  currentPath: string | null;
}

import {
  getHDF5Structure,
  getHDF5FileInfo,
  getHDF5DatasetInfo,
  readHDF5DatasetData,
  validateHDF5File,
  getEnhancedFileAnalysis,
  DatasetInfo
} from '@/utils/h5.service';

import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import http from '@/utils/http';

// a function to set the current file path
const setCurrentFilePath = async (filePath: string): Promise<void> => {
  const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/seg/v1/reload`, {
    path: filePath
  });

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to set file path');
  }
};

// Utility functions
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatDataType = (dtype: string): string => {
  const typeMap: Record<string, string> = {
    'int32': '32-bit Integer',
    'int64': '64-bit Integer',
    'float32': '32-bit Float',
    'float64': '64-bit Float',
    'string': 'String',
    'bool': 'Boolean'
  };
  return typeMap[dtype] || dtype;
};

const getTypeIcon = (type: string) => {
  switch (type) {
    case 'dataset': return <Table2 className="h-3 w-3 text-blue-500" />;
    case 'group': return <Folder className="h-3 w-3 text-yellow-500" />;
    case 'attribute': return <Hash className="h-3 w-3 text-green-500" />;
    default: return <FileText className="h-3 w-3 text-gray-500" />;
  }
};

// Detail info panel component
const DetailInfoPanel = ({ item, itemKey }: { item: any; itemKey: string }) => {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    general: true,
    attributes: true,
    storage: true,
    datatype: true
  });

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const SectionHeader = ({ title, icon, sectionKey }: { title: string; icon: React.ReactNode; sectionKey: string }) => (
    <div 
      className="flex items-center justify-between p-2.5 bg-gray-50 border-b cursor-pointer hover:bg-gray-100"
      onClick={() => toggleSection(sectionKey)}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
        {icon}
        {title}
      </div>
      {expandedSections[sectionKey] ? 
        <ChevronDown className="h-3 w-3 text-gray-500" /> : 
        <ChevronRight className="h-3 w-3 text-gray-500" />
      }
    </div>
  );

  const PropertyRow = ({ label, value, type = 'text' }: { label: string; value: any; type?: string }) => (
    <div className="grid grid-cols-3 gap-3 py-1.5 text-xs border-b border-gray-100">
      <div className="font-medium text-gray-600">{label}:</div>
      <div className="col-span-2">
        {type === 'badge' ? (
          <span className="inline-block bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded text-xs">
            {value}
          </span>
        ) : type === 'array' ? (
          <span className="font-mono text-xs">
            [{Array.isArray(value) ? value.join(', ') : value}]
          </span>
        ) : (
          <span className="text-gray-800 text-xs">{String(value)}</span>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      {/* General Object Info */}
      <div className="border rounded-lg overflow-hidden">
        <SectionHeader 
          title="General Object Info" 
          icon={<Info className="h-3 w-3" />} 
          sectionKey="general" 
        />
        {expandedSections.general && (
          <div className="p-3 space-y-1">
            <PropertyRow label="Name" value={item.name || itemKey} />
            <PropertyRow label="Path" value={item.full_path || `/${itemKey}`} />
            <PropertyRow 
              label="Type" 
              value={item.type || 'Dataset'} 
              type="badge" 
            />
            <PropertyRow label="Object Reference" value="Auto-generated" />
            
            {item.shape && (
              <>
                <PropertyRow label="Rank" value={item.shape.length} />
                <PropertyRow 
                  label="Dimensions" 
                  value={item.shape} 
                  type="array" 
                />
                <PropertyRow 
                  label="Max Dimensions" 
                  value={item.shape} 
                  type="array" 
                />
                <PropertyRow 
                  label="Total Size" 
                  value={formatBytes(item.nbytes || item.size * 8)} 
                />
              </>
            )}
          </div>
        )}
      </div>

      {/* Data Type Info */}
      <div className="border rounded-lg overflow-hidden">
        <SectionHeader 
          title="Datatype Information" 
          icon={<Type className="h-3 w-3" />} 
          sectionKey="datatype" 
        />
        {expandedSections.datatype && (
          <div className="p-3 space-y-1">
            <PropertyRow 
              label="Class" 
              value={item.dtype ? 'H5T_NATIVE' : 'H5T_UNKNOWN'} 
              type="badge" 
            />
            <PropertyRow 
              label="Base Type" 
              value={item.dtype || 'Unknown'} 
            />
            <PropertyRow 
              label="Size" 
              value={item.dtype ? `${item.dtype.includes('int') ? '8' : '8'} bytes` : 'Unknown'} 
            />
            <PropertyRow 
              label="Byte Order" 
              value="Little Endian" 
            />
            <PropertyRow 
              label="Character Set" 
              value="ASCII" 
            />
          </div>
        )}
      </div>

      {/* Storage Layout */}
      <div className="border rounded-lg overflow-hidden">
        <SectionHeader 
          title="Storage Layout & Filters" 
          icon={<HardDrive className="h-3 w-3" />} 
          sectionKey="storage" 
        />
        {expandedSections.storage && (
          <div className="p-3 space-y-1">
            <PropertyRow label="Storage Layout" value={item.chunks ? "CHUNKED" : "CONTIGUOUS"} type="badge" />
            <PropertyRow label="Compression" value={item.compression || "NONE"} />
            <PropertyRow label="Filters" value={item.compression ? item.compression.toUpperCase() : "NONE"} />
            <PropertyRow label="Fill Value" value={item.fillvalue !== undefined ? String(item.fillvalue) : "Default"} />
            <PropertyRow 
              label="Allocation" 
              value="Late allocation (data written on first write)" 
            />
            <PropertyRow label="External Files" value="None" />
            {item.chunks && (
              <PropertyRow 
                label="Chunk Size" 
                value={item.chunks} 
                type="array" 
              />
            )}
          </div>
        )}
      </div>

      {/* Object Attributes */}
      <div className="border rounded-lg overflow-hidden">
        <SectionHeader 
          title="Object Attributes" 
          icon={<Settings className="h-3 w-3" />} 
          sectionKey="attributes" 
        />
        {expandedSections.attributes && (
          <div className="p-3">
            <div className="text-xs text-gray-600 italic mb-2">
              Attribute Creation Order: Creation Order NOT Tracked
            </div>
            <div className="text-xs text-gray-500">
              Number of attributes = {item.attributes ? Object.keys(item.attributes).length : 0}
            </div>
            <div className="mt-3 border rounded">
              <table className="w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="border px-2 py-1.5 text-left">Name</th>
                    <th className="border px-2 py-1.5 text-left">Type</th>
                    <th className="border px-2 py-1.5 text-left">Array Size</th>
                    <th className="border px-2 py-1.5 text-left">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {item.attributes && Object.keys(item.attributes).length > 0 ? (
                    Object.entries(item.attributes).map(([attrName, attrInfo]: [string, any]) => (
                      <tr key={attrName}>
                        <td className="border px-2 py-1.5 font-mono">{attrName}</td>
                        <td className="border px-2 py-1.5">{attrInfo.dtype || 'unknown'}</td>
                        <td className="border px-2 py-1.5">{attrInfo.shape ? attrInfo.shape.join('×') : '1'}</td>
                        <td className="border px-2 py-1.5 max-w-32 truncate" title={String(attrInfo.value)}>
                          {String(attrInfo.value)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="border px-2 py-3 text-center text-gray-500 italic text-xs">
                        No custom attributes available for this dataset
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Data Preview */}
      {item.preview && (
        <div className="border rounded-lg overflow-hidden">
          <div className="p-2.5 bg-gray-50 border-b">
            <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
              <BarChart3 className="h-3 w-3" />
              Data Preview
            </div>
          </div>
          <div className="p-3">
            <div className="overflow-auto border rounded max-h-80">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-gray-100 sticky top-0">
                  <tr>
                    <th className="border px-1.5 py-1 text-left">#</th>
                    {Array.isArray(item.preview) && Array.isArray(item.preview[0]) ? 
                      item.preview[0].map((_, idx: number) => (
                        <th key={idx} className="border px-1.5 py-1 text-left">
                          Col_{idx}
                        </th>
                      )) : 
                      <th className="border px-1.5 py-1 text-left">Value</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  {Array.isArray(item.preview) ? 
                    item.preview.slice(0, 200).map((row: any, i: number) => (
                      <tr key={i} className={i % 2 ? 'bg-gray-50' : 'bg-white'}>
                        <td className="border px-1.5 py-1 font-medium text-gray-600">{i}</td>
                        {Array.isArray(row) ? 
                          row.map((cell: any, j: number) => (
                            <td key={j} className="border px-1.5 py-1 whitespace-nowrap">
                              {String(cell)}
                            </td>
                          )) : 
                          <td className="border px-1.5 py-1 whitespace-nowrap">
                            {String(row)}
                          </td>
                        }
                      </tr>
                    )) : (
                      <tr>
                        <td className="border px-1.5 py-1 font-medium text-gray-600">0</td>
                        <td className="border px-1.5 py-1 whitespace-nowrap">
                          {String(item.preview)}
                        </td>
                      </tr>
                    )
                  }
                  {Array.isArray(item.preview) && item.preview.length > 200 && (
                    <tr>
                      <td 
                        colSpan={Array.isArray(item.preview[0]) ? item.preview[0].length + 1 : 2}
                        className="border px-1.5 py-1 text-center text-gray-500 text-xs"
                      >
                        … showing first 200 of {item.preview.length} items
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// File info panel component
const FileInfoPanel = ({ h5Structure, h5FilePath, h5FileInfo }: { 
  h5Structure: any; 
  h5FilePath: string;
  h5FileInfo?: any;
}) => {
  const fileName = h5FilePath?.split('/').pop() || 'unknown.h5';
  
  // extract datasets from structure
  const extractDatasets = (obj: any): any[] => {
    const datasets: any[] = [];
    
    if (obj.type === 'dataset') {
      datasets.push(obj);
    } else if (obj.children) {
      obj.children.forEach((child: any) => {
        datasets.push(...extractDatasets(child));
      });
    }
    
    return datasets;
  };
  
  const datasets = h5Structure?.root ? extractDatasets(h5Structure.root) : [];
  
  return (
    <div className="space-y-4">
      {/* File Header */}
      <div className="border rounded-lg overflow-hidden">
        <div className="p-2.5 bg-blue-50 border-b">
          <div className="flex items-center gap-1.5 text-sm font-medium text-blue-800">
            <Database className="h-4 w-4" />
            HDF5 File Information
          </div>
        </div>
        <div className="p-3 space-y-2">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="col-span-2">
              <span className="font-medium text-gray-600">File Name:</span>
              <div className="mt-0.5 font-mono text-xs break-all leading-relaxed">{fileName}</div>
            </div>
            <div>
              <span className="font-medium text-gray-600">Path:</span>
              <div className="mt-0.5 font-mono text-xs">/</div>
            </div>
            <div>
              <span className="font-medium text-gray-600">HDF5 Version:</span>
              <div className="mt-0.5">{h5FileInfo?.hdf5_version || '1.12.x'}</div>
            </div>
            <div>
              <span className="font-medium text-gray-600">File Size:</span>
              <div className="mt-0.5">{h5FileInfo?.file_size ? formatBytes(h5FileInfo.file_size) : 'Unknown'}</div>
            </div>
          </div>
          <div className="pt-1.5 border-t">
            <span className="inline-block bg-green-100 text-green-800 px-2 py-0.5 rounded-full text-xs font-medium">
              HDF5 Root Group
            </span>
          </div>
        </div>
      </div>

      {/* File Statistics */}
      <div className="border rounded-lg overflow-hidden">
        <div className="p-2.5 bg-gray-50 border-b">
          <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
            <BarChart3 className="h-3 w-3" />
            File Contents Summary
          </div>
        </div>
        <div className="p-3">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="text-center p-2.5 bg-blue-50 rounded">
              <div className="text-lg font-bold text-blue-600">{h5Structure?.total_datasets || datasets.length}</div>
              <div className="text-xs text-blue-800">Total Datasets</div>
            </div>
            <div className="text-center p-2.5 bg-green-50 rounded">
              <div className="text-lg font-bold text-green-600">{h5Structure?.total_groups || 1}</div>
              <div className="text-xs text-green-800">Total Groups</div>
            </div>
          </div>
          
          <div className="space-y-1.5">
            <h4 className="text-sm font-medium text-gray-700">Dataset Overview</h4>
            <div className="overflow-x-auto">
              <table className="w-full border border-gray-300 text-xs">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="border border-gray-300 px-2 py-1.5 text-left">Name</th>
                    <th className="border border-gray-300 px-2 py-1.5 text-left">Type</th>
                    <th className="border border-gray-300 px-2 py-1.5 text-left">Dimensions</th>
                    <th className="border border-gray-300 px-2 py-1.5 text-left">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {datasets.length > 0 ? datasets.map((dataset, index) => (
                    <tr key={index} className="hover:bg-gray-50">
                      <td className="border border-gray-300 px-2 py-1.5 font-mono text-xs">{dataset.name}</td>
                      <td className="border border-gray-300 px-2 py-1.5">
                        <span className="inline-block bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded text-xs">
                          {dataset.dtype || 'Dataset'}
                        </span>
                      </td>
                      <td className="border border-gray-300 px-2 py-1.5 font-mono text-xs">
                        {dataset.shape ? dataset.shape.join(' × ') : 'Unknown'}
                      </td>
                      <td className="border border-gray-300 px-2 py-1.5 text-xs">
                        {dataset.nbytes ? formatBytes(dataset.nbytes) : 
                         dataset.size ? formatBytes(dataset.size * 8) : 'Unknown'}
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={4} className="border border-gray-300 px-2 py-3 text-center text-gray-500 italic">
                        No datasets found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* File Attributes */}
      <div className="border rounded-lg overflow-hidden">
        <div className="p-2.5 bg-gray-50 border-b">
          <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
            <Settings className="h-3 w-3" />
            Root Group Attributes
          </div>
        </div>
        <div className="p-3">
          <div className="text-xs text-gray-600 mb-2">
            Number of attributes = {h5FileInfo?.file_attributes ? Object.keys(h5FileInfo.file_attributes).length : 0}
          </div>
          {h5FileInfo?.file_attributes && Object.keys(h5FileInfo.file_attributes).length > 0 ? (
            <div className="space-y-1">
              {Object.entries(h5FileInfo.file_attributes).map(([key, value]) => (
                <div key={key} className="text-xs">
                  <span className="font-medium">{key}:</span> {String(value)}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-gray-500 italic">
              No custom attributes defined for the root group.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Main HDFView style viewer component
const HDFViewStyleH5Viewer = ({ h5Tree, h5FilePath, h5FileInfo, currentPath }: { 
  h5Tree: any; 
  h5FilePath: string;
  h5FileInfo?: any;
  currentPath: string | null;
}) => {
  const [selectedItem, setSelectedItem] = useState('root');
  const [datasetCache, setDatasetCache] = useState<Record<string, any>>({});
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set(['root']));

  const initializeExpandedItems = (obj: any): Set<string> => {
    const expanded = new Set<string>(['root']);
    
    const traverse = (item: any) => {
      if (item.children && item.children.length > 0) {
        expanded.add(item.name);
        item.children.forEach(traverse);
      }
    };
    
    if (obj?.children) {
      obj.children.forEach(traverse);
    }
    
    return expanded;
  };

  const extractAllItems = (obj: any, parentPath: string = ''): Record<string, any> => {
    const items: Record<string, any> = {};
    
    if (obj.children) {
      obj.children.forEach((child: any) => {
        const currentPath = parentPath ? `${parentPath}/${child.name}` : child.name;
        items[child.name] = { ...child, full_path: currentPath, parentPath };
        
        // recursive processing of subprojects
        Object.assign(items, extractAllItems(child, currentPath));
      });
    }
    
    return items;
  };

  // build tree structure data
  const buildTreeStructure = (obj: any, parentPath: string = ''): any[] => {
    if (!obj.children) return [];
    
    return obj.children.map((child: any) => {
      const currentPath = parentPath ? `${parentPath}/${child.name}` : child.name;
      return {
        ...child,
        full_path: currentPath,
        parentPath,
        children: child.children ? buildTreeStructure(child, currentPath) : []
      };
    });
  };

  const allItems = h5Tree?.root ? extractAllItems(h5Tree.root) : {};
  const treeStructure = h5Tree?.root ? buildTreeStructure(h5Tree.root) : [];
  
  // extract datasets for detail panel
  const extractDatasets = (obj: any): Record<string, any> => {
    const datasets: Record<string, any> = {};
    
    if (obj.type === 'dataset') {
      datasets[obj.name] = obj;
    } else if (obj.children) {
      obj.children.forEach((child: any) => {
        Object.assign(datasets, extractDatasets(child));
      });
    }
    
    return datasets;
  };
  
  const datasets = h5Tree?.root ? extractDatasets(h5Tree.root) : {};

  // when h5Tree changes, initialize the expanded state
  useEffect(() => {
    if (h5Tree?.root) {
      setExpandedItems(initializeExpandedItems(h5Tree.root));
    }
  }, [h5Tree]);

  const handleItemClick = async (itemKey: string, event: React.MouseEvent) => {
    event.preventDefault();
    setSelectedItem(itemKey);

    // if chosen item is a dataset and not already cached, try to load its preview
    if (itemKey !== 'root' && allItems[itemKey] && allItems[itemKey].type === 'dataset' && !allItems[itemKey].preview && !datasetCache[itemKey] && currentPath) {
      try {
        const datasetInfo = await getHDF5DatasetInfo(currentPath, allItems[itemKey].full_path, true, 10);
        
        // update datasetCache state
        setDatasetCache(prev => ({
          ...prev,
          [itemKey]: datasetInfo
        }));

        // update original item object
        allItems[itemKey] = { ...allItems[itemKey], ...datasetInfo };
      } catch (error) {
        console.error('Failed to load dataset preview:', error);
      }
    }
  };

  const handleToggleExpand = (itemKey: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setExpandedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(itemKey)) {
        newSet.delete(itemKey);
      } else {
        newSet.add(itemKey);
      }
      return newSet;
    });
  };

  // recursive rendering of tree structure
  const renderTreeNode = (item: any, level: number = 0) => {
    const isExpanded = expandedItems.has(item.name);
    const hasChildren = item.children && item.children.length > 0;
    const indentStyle = { paddingLeft: `${level * 14 + 10}px` }; 

    return (
      <div key={item.name}>
        <div 
          className={`flex items-center gap-1.5 py-1.5 cursor-pointer hover:bg-gray-100 ${
            selectedItem === item.name ? 'bg-yellow-100 border-l-4 border-l-yellow-500' : ''
          }`}
          style={indentStyle}
          onClick={(e) => handleItemClick(item.name, e)}
        >
          {hasChildren ? (
            <button
              onClick={(e) => handleToggleExpand(item.name, e)}
              className="flex-shrink-0 p-0.5 hover:bg-gray-200 rounded"
            >
              {isExpanded ? 
                <ChevronDown className="h-3 w-3 text-gray-500" /> : 
                <ChevronRight className="h-3 w-3 text-gray-500" />
              }
            </button>
          ) : (
            <div className="w-4" /> 
          )}
          
          {getTypeIcon(item.type || 'dataset')}
          <div className="flex-1 min-w-0 flex items-center gap-3">
            <div className="text-xs font-medium text-gray-800 truncate" title={item.name}>
              {item.name}
            </div>
            <div className="text-xs text-gray-500 flex-shrink-0">
              {item.shape ? item.shape.join('×') : item.type === 'group' ? 'group' : 'scalar'}
            </div>
          </div>
        </div>
        
        {hasChildren && isExpanded && (
          <div>
            {item.children.map((child: any) => renderTreeNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  const renderInfoPanel = () => {
    if (selectedItem === 'root') {
      return <FileInfoPanel h5Structure={h5Tree} h5FilePath={h5FilePath} h5FileInfo={h5FileInfo} />;
    }

    const item = datasetCache[selectedItem] || allItems[selectedItem];
    if (!item) return null;

    return <DetailInfoPanel item={item} itemKey={selectedItem} />;
  };

  return (
    <div className="h-full flex bg-gray-50">
      {/* Left sidebar tree navigation */}
      <div className="w-72 bg-white border-r border-gray-300 flex flex-col">
        <div className="border-b border-gray-300 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <Database className="h-4 w-4 text-purple-600" />
              <h2 className="text-sm font-semibold text-gray-800">HDF5 Structure</h2>
            </div>
          </div>
          <div className="text-xs text-gray-500 break-all">
            {h5FilePath?.split(/[\\/]/).pop() || 'unknown.h5'}
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {/* Root group */}
          <div 
            className={`flex items-center gap-1.5 px-3 py-2 cursor-pointer hover:bg-gray-100 border-b border-gray-200 ${
              selectedItem === 'root' ? 'bg-blue-100 border-l-4 border-l-blue-500' : ''
            }`}
            onClick={(e) => handleItemClick('root', e)}
          >
            <Folder className="h-3 w-3 text-blue-500" />
            <span className="text-xs font-medium">
              {'Root'}
            </span>
          </div>

          {/* Tree structure */}
          <div>
            {treeStructure.map((item: any) => renderTreeNode(item, 0))}
          </div>
        </div>
      </div>

      {/* Right info panel */}
      <ScrollArea className="flex-1 bg-white overflow-y-auto">
        <div className="p-4">
          {renderInfoPanel()}
        </div>
      </ScrollArea>
    </div>
  );
};

// Main H5 Card component
const H5Card: React.FC<H5CardProps> = ({ currentPath }) => {
  const [h5FileStructure, setH5FileStructure] = useState<any>(null);
  const [h5FileInfo, setH5FileInfo] = useState<any>(null);
  const [h5FileExists, setH5FileExists] = useState(false);
  const [h5Loading, setH5Loading] = useState(false);
  const [showHDFViewer, setShowHDFViewer] = useState(false);
  const [h5Tree, setH5Tree] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const lastLoadedSlide = useRef<string | null>(null);

  const loadH5FileDirectly = useCallback(async () => {
    if (!currentPath) return;
    if (lastLoadedSlide.current === currentPath) return;
    lastLoadedSlide.current = currentPath;
    
    const fileName = currentPath.split(/[\\/]/).pop();
    if (!fileName) return;

    console.log('Loading H5 data using H5 service:', fileName);
    setH5Loading(true);
    
    try {
      setError(null);
      
      // set currentFilePath
      try {
        await setCurrentFilePath(currentPath);
        console.log('Successfully set file path on backend:', currentPath);
      } catch (pathError) {
        console.error('Failed to set file path on backend:', pathError);
        setH5FileExists(false);
        setError('Failed to set file path on backend');
        return;
      }
      
      // check if h5 file exists and is valid
      try {
        const validationResult = await validateHDF5File(currentPath);
        if (!validationResult.is_valid) {
          setH5FileExists(false);
          setError(validationResult.error || 'File is not a valid HDF5 file');
          return;
        }
        console.log('File validation successful:', validationResult);
      } catch (validationError) {
        console.log('Validation failed, file might not exist or not be HDF5:', validationError);
        setH5FileExists(false);
        setError('H5 file not found or not accessible');
        return;
      }

      // get HDF5 file info and structure
      const [fileInfo, structure] = await Promise.all([
        getHDF5FileInfo(currentPath).catch(e => {
          console.warn('Failed to get HDF5 file info:', e);
          return null;
        }),
        getHDF5Structure(currentPath, '/', true, 3).catch(e => {
          console.warn('Failed to get HDF5 structure:', e);
          return null;
        })
      ]);

      console.log('HDF5 file info:', fileInfo);
      console.log('HDF5 structure:', structure);

      if (structure?.root || fileInfo) {
        setH5Tree(structure);
        setH5FileStructure(structure);
        setH5FileInfo(fileInfo);
        setH5FileExists(true);
        console.log('Successfully loaded HDF5 data');
      } else {
        throw new Error('Failed to load HDF5 file structure or info');
      }

    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unknown error occurred');
      console.error('Failed to load HDF5 data:', error);
      setH5FileExists(false);
    } finally {
      setH5Loading(false);
    }
  }, [currentPath]);

  useEffect(() => {
    if (!currentPath) return;
      // reset states
      setH5FileStructure(null);
      setH5FileInfo(null);
      setH5FileExists(false);
      setError(null);
      
      loadH5FileDirectly();
  }, [currentPath, loadH5FileDirectly]);

  // extracted datasets for display
  const extractDatasets = (obj: any): any[] => {
    const datasets: any[] = [];
    
    if (obj?.type === 'dataset') {
      datasets.push(obj);
    } else if (obj?.children) {
      obj.children.forEach((child: any) => {
        datasets.push(...extractDatasets(child));
      });
    }
    
    return datasets;
  };

  const datasets = h5FileStructure?.root ? extractDatasets(h5FileStructure.root) : [];

  return (
    <>
      <div className="border rounded-lg overflow-hidden bg-white">
        <div className="p-3 border-b bg-gray-50">
          <div className="flex items-center gap-2 text-base font-semibold text-gray-800">
            <Database className="h-4 w-4 text-purple-500" />
            Associated H5 Data
          </div>
        </div>
        <div className="p-3">
          {!currentPath ? (
            <div className="text-gray-500 text-center py-6">
              <div className="flex items-center justify-center gap-2 mb-2">
                <Database className="h-6 w-6 text-gray-400" />
                <span className="text-sm">No file loaded</span>
              </div>
              <div className="text-xs text-gray-400">
                Please select a file to view its H5 data
              </div>
            </div>
          ) : !h5FileExists ? (
            <div className="text-gray-500 text-center py-6">
              <div className="flex items-center justify-center gap-2 mb-2">
                <Database className="h-6 w-6 text-gray-400" />
                <span className="text-sm">No H5 data found</span>
              </div>
              <div className="text-xs text-gray-400 break-all">
                {error || `Expected: ${currentPath.split(/[\\/]/).pop()}.h5`}
              </div>
            </div>
          ) : h5Loading ? (
            <div className="text-gray-500 text-center py-6">
              <div className="flex items-center justify-center gap-2">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-purple-500"></div>
                <span className="text-sm">Loading H5 structure...</span>
              </div>
            </div>
          ) : h5FileStructure && h5FileInfo ? (
            <div className="space-y-3">
              {/* H5 file basic information */}
              <div className="flex items-center justify-between p-3 bg-blue-50 rounded-lg">
                <div className="flex items-center gap-2">
                  <Database className="h-5 w-5 text-blue-600" />
                  <div>
                    <div className="text-sm font-medium text-blue-900 break-all">
                      {currentPath.split(/[\\/]/).pop()}.h5
                    </div>
                    <div className="text-xs text-blue-700">
                      HDF5 Scientific Data Format
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">
                    <div className="w-1.5 h-1.5 bg-green-500 rounded-full"></div>
                    Available
                  </span>
                </div>
              </div>

              {/* Quick statistics cards */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-gradient-to-r from-blue-50 to-blue-100 p-3 rounded-lg border border-blue-200">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Layers className="h-3 w-3 text-blue-600" />
                    <span className="text-xs font-medium text-blue-800">Datasets</span>
                  </div>
                  <div className="text-xl font-bold text-blue-900">
                    {h5FileStructure.total_datasets || datasets.length}
                  </div>
                </div>
                
                <div className="bg-gradient-to-r from-green-50 to-green-100 p-3 rounded-lg border border-green-200">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Folder className="h-3 w-3 text-green-600" />
                    <span className="text-xs font-medium text-green-800">Groups</span>
                  </div>
                  <div className="text-xl font-bold text-green-900">
                    {h5FileStructure.total_groups || 1}
                  </div>
                </div>
                
                <div className="bg-gradient-to-r from-purple-50 to-purple-100 p-3 rounded-lg border border-purple-200">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Archive className="h-3 w-3 text-purple-600" />
                    <span className="text-xs font-medium text-purple-800">Size</span>
                  </div>
                  <div className="text-xs font-medium text-purple-900">
                    {h5FileInfo.file_size ? formatBytes(h5FileInfo.file_size) : 'Unknown'}
                  </div>
                </div>
              </div>

              {/* Dataset preview table */}
              <div className="border rounded-lg overflow-hidden">
                <div className="p-2.5 bg-gray-50 border-b">
                  <h3 className="text-sm font-medium text-gray-800">Dataset Overview</h3>
                </div>
                <div className="overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="border px-1 py-1.5 text-left w-2/5">Name</th>
                        <th className="border px-1 py-1.5 text-left w-1/5">Type</th>
                        <th className="border px-1 py-1.5 text-left w-1/5">Shape</th>
                        <th className="border px-1 py-1.5 text-left w-1/5">Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {datasets.length > 0 ? datasets.map((dataset, index) => (
                        <tr key={index} className="hover:bg-gray-50">
                          <td className="border px-1 py-1.5 font-mono text-xs break-words leading-relaxed">
                            {dataset.name}
                          </td>
                          <td className="border px-1 py-1.5">
                            <span className="inline-block bg-blue-100 text-blue-800 px-1 py-0.5 rounded text-xs">
                              {dataset.dtype || 'Dataset'}
                            </span>
                          </td>
                          <td className="border px-1 py-1.5 font-mono text-xs break-words leading-relaxed">
                            {dataset.shape ? dataset.shape.join(' × ') : 'Unknown'}
                          </td>
                          <td className="border px-1 py-1.5 text-xs break-words leading-relaxed">
                            {dataset.nbytes ? formatBytes(dataset.nbytes) : 
                             dataset.size ? formatBytes(dataset.size * 8) : 'Unknown'}
                          </td>
                        </tr>
                      )) : (
                        <tr>
                          <td colSpan={4} className="border px-1 py-3 text-center text-gray-500 italic">
                            No datasets found
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Open detailed viewer button */}
              <button
                onClick={() => setShowHDFViewer(true)}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-white rounded-lg transition-all duration-200 shadow-md hover:shadow-lg"
                style={{ backgroundColor: '#898AC4' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#7a7bb8'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#898AC4'}
              >
                <Eye className="h-3 w-3" />
                <span className="font-medium text-xs">Open Advanced H5 Viewer</span>
              </button>
            </div>
          ) : (
            <div className="text-red-500 text-center py-6">
              <div className="flex items-center justify-center gap-2 mb-2">
                <Database className="h-6 w-6 text-red-400" />
                <span className="text-sm">Error loading H5 data</span>
              </div>
              <div className="text-xs text-red-400">
                {error || 'Failed to load or parse the H5 file structure'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* HDFView style H5 viewer modal */}
      {showHDFViewer && h5Tree && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-2xl w-full h-full max-w-7xl max-h-[95vh] flex flex-col">
            {/* Title bar */}
            <div className="border-b p-3 flex justify-between items-center text-white rounded-t-lg" style={{ backgroundColor: '#898AC4' }}>
              <div className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                <div>
                  <h2 className="text-lg font-semibold">HDF5 File Viewer</h2>
                  <div className="text-xs opacity-90 break-all">
                    {currentPath?.split(/[\\/]/).pop()}.h5
                  </div>
                </div>
              </div>
              <button 
                onClick={() => setShowHDFViewer(false)}
                className="text-white hover:text-gray-200 p-1.5 hover:bg-white/10 rounded-lg transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            
            {/* Viewer content */}
            <div className="flex-1 overflow-hidden">
              <HDFViewStyleH5Viewer 
                h5Tree={structuredClone(h5Tree)}
                h5FilePath={currentPath + '.h5'} 
                h5FileInfo={h5FileInfo}
                currentPath={currentPath} 
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default H5Card;