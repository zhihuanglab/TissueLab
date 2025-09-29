import React, { useEffect, useState } from 'react';
import {
  CCard,
  CCardHeader,
  CCardBody
} from '@coreui/react';
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import http from '@/utils/http';
import { Table, Badge, Alert, Tooltip } from "antd";
import { LiaDrawPolygonSolid } from "react-icons/lia";
import { PiRectangle } from "react-icons/pi";
import { useSelector, useDispatch } from "react-redux";
import { RootState } from "@/store";
import { setEditAnnotations } from "@/store/slices/annotationSlice";
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';


const triggerBrowserDownload = (data: any, filename: string, mimeType: string) => {
  const blob = new Blob([data], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  
  // Create temporary download link
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  
  // Add to DOM, trigger download, then clean up
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  // Release URL object
  setTimeout(() => window.URL.revokeObjectURL(url), 100);
};

// Tool function
const handleDownload = (record: { layer_name: any }) => {
  const json = JSON.stringify(record, null, 2);
  triggerBrowserDownload(json, `${record.layer_name}.json`, 'application/json');
};


interface AnnotationFilters {
  state?: string[];
  annotationType?: string[];
  [key: string]: any;
}

const SidebarAnnotation = () => {
  const [userAnnotationFilters, setUserAnnotationFilters] = useState<any>({});
  const [aiAnnotationFilters, setAiAnnotationFilters] = useState<any>({});
  const allAnnotations = useSelector((state: RootState) => state.annotations.annotations);
  const userAnnotations = allAnnotations.filter(annotation => !annotation.isBackend);
  
  // New state for AI annotations from API
  const [aiAnnotations, setAiAnnotations] = useState<any[]>([]);
  const [totalAiAnnotations, setTotalAiAnnotations] = useState(1000);
  const [aiPagination, setAiPagination] = useState({
    offset: 0,
    limit: 20, // Changed from 5 to 20
    current: 1
  });

  // New state for patch annotations from API
  const [aiAnnotationsPatch, setAiAnnotationsPatch] = useState<any[]>([]);
  const [totalAiAnnotationsPatch, setTotalAiAnnotationsPatch] = useState(1000);
  const [aiPaginationPatch, setAiPaginationPatch] = useState({
    offset: 0,
    limit: 20, // Changed from 5 to 20
    current: 1
  });

  const [loading, setLoading] = useState(false);
  
  // New state for download dialog
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const [downloadFormat, setDownloadFormat] = useState<'json' | 'csv'>('json');
  const [downloadLayerName, setDownloadLayerName] = useState("");
  
  const dispatch = useDispatch();

  // Move MoveTo function inside component to access dispatch
  const MoveTo = (record: any) => {
    dispatch(setEditAnnotations(record.id));
  };

  // Optimized table config for sidebar width constraints
const columns = [
  {
    title: 'Layer Name',
    dataIndex: 'layer_name',
    key: 'layer_name',
    width: 150, // Reduced width
    render: (text: string) => (
      <div 
        className="leading-tight text-sm" 
        style={{ 
          lineHeight: '1.3',
          wordBreak: 'break-word',
          whiteSpace: 'normal',
          maxWidth: '140px'
        }}
      >
        {text}
      </div>
    ),
  },
  {
     title: 'Time',
     dataIndex: 'completed_at',
     key: 'completed_at',
     width: 80,
     render: (text: string) => (
       <div 
         className="leading-tight text-center text-sm" 
         style={{ 
           lineHeight: '1.3',
           wordBreak: 'break-word',
           whiteSpace: 'normal'
         }}
       >
         {text ? new Date(text).toLocaleDateString() : 'N/A'}
       </div>
     )
  },
  {
    title: 'Action',
    key: 'operation',
    width: 60,
    align: 'center' as const,
    render: (text: any, record: { layer_name: any }) => (
      <div className="flex justify-center">
        <Button 
          variant="outline" 
          size="sm" 
          className="h-7 px-2 text-sm"
          onClick={() => {
            // Direct download as JSON for all annotation types
            const json = JSON.stringify(record, null, 2);
            triggerBrowserDownload(json, `${record.layer_name}.json`, 'application/json');
          }}
        >
          <Download className="h-4 w-4" />
        </Button>
      </div>
    ),
  },
];

  // Further optimized expandColumns for compact sidebar display
  const expandColumns = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'annotation_id',
      width: 40,
      render: (text: string) => (
        <div className="text-sm text-center" style={{ fontSize: '12px' }}>
          {text}
        </div>
      ),
    },
    {
      title: 'Type',
      key: 'annotationType',
      width: 40,
      render: (text: any, record: any) => {
        const icon = record.target.selector.type === 'RECTANGLE' 
          ? <PiRectangle size={16} /> 
          : record.target.selector.type === 'POLYGON' 
          ? <LiaDrawPolygonSolid size={16} />
          : null;
        
        return (
          <Tooltip 
            title={record.target.selector.type} 
            placement="top"
          >
            <div className="flex justify-center cursor-help">
              {icon}
            </div>
          </Tooltip>
        );
      },
      filters: [
        { 
          text: (
            <div style={{ display: 'flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
              <PiRectangle size={12} style={{ marginRight: 4 }} />
              Rectangle
            </div>
          ), 
          value: 'RECTANGLE'
        }, 
        { 
          text: (
            <div style={{ display: 'flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
              <LiaDrawPolygonSolid size={12} style={{ marginRight: 4 }} />
              Polygon
            </div>
          ), 
          value: 'POLYGON' 
        },
      ],
      filteredValue: userAnnotationFilters?.annotationType || null,
      onFilter: (value: any, record: any) => {
        return record.target.selector.type === value;
      },
    },
    {
      title: 'Time',
      dataIndex: 'time',
      key: 'time',
      width: 60,
      render: (text: any, record: any) => {
        const dateStr = new Date(record.target.created).toLocaleDateString();
        return (
          <div className="text-sm text-center" style={{ fontSize: '12px', lineHeight: '1.3' }}>
            {dateStr}
          </div>
        );
      },
    },
    {
      title: 'Status',
      key: 'state',
      width: 50,
      render: () => <Badge status="success" text="✓" />,
      filters: [
      { text: '✓', value: 'finished' },
      ],
      filteredValue: userAnnotationFilters?.state || null,
      onFilter: (value: any, record: any) => {
        return value === 'finished'; 
      },
    },
    {
      title: 'Action',
      key: 'operation',
      width: 50,
      render: (text: any, record: any) => (
        <div className="flex justify-center">
          <div
            onClick={() => MoveTo(record)}
            className="text-blue-600 hover:text-blue-800 underline cursor-pointer"
            style={{ fontSize: '12px' }}
          >
            View
          </div>
        </div>
      ),
    },
  ];

  // AI-generated annotations specific columns with correct filter state
  const aiExpandColumns = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'annotation_id',
      width: 40,
      render: (text: string) => (
        <div className="text-sm text-center" style={{ fontSize: '12px' }}>
          {text}
        </div>
      ),
    },
    {
      title: 'Type',
      key: 'annotationType',
      width: 40,
      render: (text: any, record: any) => {
        const icon = record.target.selector.type === 'RECTANGLE' 
          ? <PiRectangle size={16} /> 
          : record.target.selector.type === 'POLYGON' 
          ? <LiaDrawPolygonSolid size={16} />
          : null;
        
        return (
          <Tooltip 
            title={record.target.selector.type} 
            placement="top"
          >
            <div className="flex justify-center cursor-help">
              {icon}
            </div>
          </Tooltip>
        );
      },
      filters: [
        { 
          text: (
            <div style={{ display: 'flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
              <PiRectangle size={12} style={{ marginRight: 4 }} />
              Rectangle
            </div>
          ), 
          value: 'RECTANGLE'
        }, 
        { 
          text: (
            <div style={{ display: 'flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
              <LiaDrawPolygonSolid size={12} style={{ marginRight: 4 }} />
              Polygon
            </div>
          ), 
          value: 'POLYGON' 
        },
      ],
      filteredValue: aiAnnotationFilters?.annotationType || null,
      onFilter: (value: any, record: any) => {
        return record.target.selector.type === value;
      },
    },
    {
      title: 'Time',
      dataIndex: ['target', 'created'],
      key: 'time',
      width: 60,
      render: (text: any, record: any) => {
        const dateStr = record.target?.created ? new Date(record.target.created).toLocaleDateString() : 'N/A';
        return (
          <div className="text-sm text-center" style={{ fontSize: '12px', lineHeight: '1.3' }}>
            {dateStr}
          </div>
        );
      },
    },
    {
      title: 'Status',
      key: 'state',
      width: 50,
      render: () => <Badge status="success" text="✓" />,
      filters: [
      { text: '✓', value: 'finished' },
      ],
      filteredValue: aiAnnotationFilters?.state || null,
      onFilter: (value: any, record: any) => {
        return value === 'finished'; 
      },
    },
    {
      title: 'Action',
      key: 'operation',
      width: 50,
      render: (text: any, record: any) => (
        <div className="flex justify-center">
          <div
            onClick={() => MoveTo(record)}
            className="text-blue-600 hover:text-blue-800 underline cursor-pointer"
            style={{ fontSize: '12px' }}
          >
            View
          </div>
        </div>
      ),
    },
  ];

  //  build filter options from current patch data 
  const uniqueIds     = Array.from(new Set(aiAnnotationsPatch.map(p => p.target.selector.class_id)));
  const uniqueNames   = Array.from(new Set(aiAnnotationsPatch.map(p => p.target.selector.class_name)));
  const uniqueColors  = Array.from(new Set(aiAnnotationsPatch.map(p => p.target.selector.class_hex_color)));

  const idFilters    = uniqueIds.map(id => ({ text: String(id), value: id }));
  const nameFilters  = uniqueNames.map(n => ({ text: n, value: n }));
  const colorFilters = uniqueColors.map(c => ({ text: (<div style={{background:c,width:14,height:14,border:'1px solid #ccc'}}/>), value: c }));

  // Further optimized columns for AI-generated patches
  const patchExpandColumns = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'annotation_id',
      width: 35,
      render: (text: string) => (
        <div className="text-sm text-center" style={{ fontSize: '12px' }}>
          {text}
        </div>
      ),
    },
    {
      title: 'Class',
      dataIndex: ['target', 'selector', 'class_name'],
      key: 'class_name',
      width: 70,
      filters: nameFilters,
      filteredValue: aiAnnotationFilters?.class_name || null,
      onFilter: (value: any, record: any) =>
        record.target.selector.class_name === value,
      render: (text: string) => (
        <div 
          className="text-sm text-center" 
          style={{ 
            fontSize: '12px',
            wordBreak: 'break-word',
            whiteSpace: 'normal',
            lineHeight: '1.3'
          }}
        >
          {text}
        </div>
      ),
    },
    {
      title: 'Color',
      dataIndex: ['target', 'selector', 'class_hex_color'],
      key: 'class_hex_color',
      width: 40,
      filters: colorFilters,
      filteredValue: aiAnnotationFilters?.class_hex_color || null,
      onFilter: (value: any, record: any) =>
        record.target.selector.class_hex_color === value,
      render: (color: string) => (
        <div className="flex justify-center">
          <div 
            style={{
              width: 14, 
              height: 14, 
              background: color, 
              border: '1px solid #ccc',
              borderRadius: '2px'
            }}
          />
        </div>
      ),
    },
    {
      title: 'CID',
      dataIndex: ['target', 'selector', 'class_id'],
      key: 'class_id',
      width: 35,
      filters: idFilters,
      filteredValue: aiAnnotationFilters?.class_id || null,
      onFilter: (value: any, record: any) =>
        record.target.selector.class_id === value,
      render: (text: string) => (
        <div className="text-sm text-center" style={{ fontSize: '12px' }}>
          {text}
        </div>
      ),
    },
    {
      title: 'Action',
      key: 'operation',
      width: 50,
      render: (text: any, record: any) => (
        <div className="flex justify-center">
          <div
            onClick={() => MoveTo(record)}
            className="text-blue-600 hover:text-blue-800 underline cursor-pointer"
            style={{ fontSize: '12px' }}
          >
            View
          </div>
        </div>
      ),
    },
  ];

  // Function to fetch AI annotations from API
  const fetchAiAnnotations = async (offset: number, limit: number) => {
    try {
      setLoading(true);
      const response = await http.get(`${AI_SERVICE_API_ENDPOINT}/seg/v1/annotations/?offset=${offset}&limit=${limit}`);
      const responseData = response.data;
      console.log(responseData);
      
      if (responseData.message !== "Success") {
        // If request fails, cap the total at current page
        const currentPage = Math.floor(offset / limit) + 1;
        const newTotal = (currentPage - 1) * limit; // Cap at previous page
        setTotalAiAnnotations(newTotal);
        throw new Error('Failed to fetch AI annotations');
      }
      
      const data = responseData.data;
      setAiAnnotations(data.annotations || []);
      setTotalAiAnnotations(data.count);
      
      // If we get fewer items than requested, we've reached the end
      if (data.annotations && data.annotations.length < limit) {
        const currentPage = Math.floor(offset / limit) + 1;
        const newTotal = offset + data.annotations.length;
        setTotalAiAnnotations(newTotal);
      }
      
    } catch (error) {
      console.error('Error fetching AI annotations:', error);
    } finally {
      setLoading(false);
    }
  };

  // Function to fetch AI annotations from API
  const fetchAiAnnotationsPatch = async (offset: number, limit: number) => {
    try {
      setLoading(true);
      const response = await http.get(`${AI_SERVICE_API_ENDPOINT}/seg/v1/patches/?offset=${offset}&limit=${limit}`);
      const responseData = response.data;
      console.log(responseData);

      if (responseData.message !== "Success") {
        // If request fails, cap the total at current page
        const currentPage = Math.floor(offset / limit) + 1;
        const newTotal = (currentPage - 1) * limit; // Cap at previous page
        setTotalAiAnnotationsPatch(newTotal);
        throw new Error('Failed to fetch AI annotations');
      }

      const data = responseData.data;
      setAiAnnotationsPatch(data.annotations || []);
      setTotalAiAnnotationsPatch(data.count);

      // If we get fewer items than requested, we've reached the end
      if (data.annotations && data.annotations.length < limit) {
        const currentPage = Math.floor(offset / limit) + 1;
        const newTotal = offset + data.annotations.length;
        setTotalAiAnnotationsPatch(newTotal);
      }

    } catch (error) {
      console.error('Error fetching AI annotations:', error);
    } finally {
      setLoading(false);
    }
  };

  // Fetch AI annotations on initial load and when pagination changes
  useEffect(() => {
    fetchAiAnnotations(aiPagination.offset, aiPagination.limit);
  }, [aiPagination.offset, aiPagination.limit]);

  //Fetch patch annotations
  useEffect(() => {
    fetchAiAnnotationsPatch(aiPaginationPatch.offset, aiPaginationPatch.limit);
  }, [aiPaginationPatch.offset, aiPaginationPatch.limit]);

  // Make sure the AI pagination handler is specific to that section
  const handleAiPaginationChange = (page: number, pageSize: number) => {
    console.log("Pagination changed:", page, pageSize); // Debug: confirm handler is called
    const newOffset = (page - 1) * pageSize;
    setAiPagination({
      offset: newOffset,
      limit: pageSize,
      current: page
    });
  };

  const handleAiPaginationPatchChange = (page: number, pageSize: number) => {
    console.log("Pagination changed:", page, pageSize); // Debug: confirm handler is called
    const newOffset = (page - 1) * pageSize;
    setAiPaginationPatch({
      offset: newOffset,
      limit: pageSize,
      current: page
    });
  };
  

  // Layer data with two categories
  const layerData = {
    layer_annotations: [
      {
        layer_name: "User-generated annotations",
        completed_at: userAnnotations.length > 0 
          ? new Date(userAnnotations[userAnnotations.length - 1].target.created).toLocaleString() 
          : 'N/A',
        annotations: userAnnotations,
        isPaginated: false
      },
      {
        layer_name: "AI-generated annotations",
        completed_at: aiAnnotations.length > 0 && aiAnnotations[0]?.target?.created
          ? new Date(aiAnnotations[0].target.created).toLocaleString() 
          : 'N/A',
        annotations: aiAnnotations,
        isPaginated: true,
        pagination: {
          total: totalAiAnnotations,
          current: aiPagination.current,
          pageSize: aiPagination.limit
        }
      },
      {
        layer_name: "AI-generated patches",
        completed_at: aiAnnotationsPatch.length > 0 && aiAnnotationsPatch[0]?.target?.created
          ? new Date(aiAnnotationsPatch[0].target.created).toLocaleString()
          : 'N/A',
        annotations: aiAnnotationsPatch,
        isPaginated: true,
        pagination: {
          total: totalAiAnnotationsPatch,
          current: aiPaginationPatch.current,
          pageSize: aiPaginationPatch.limit
        }
      }
    ]
  };

  const dataSource = layerData.layer_annotations.map((layer, index) => ({
    key: index.toString(),
    layer_name: layer.layer_name,
    completed_at: layer.completed_at,
    annotations: layer.annotations,
    isPaginated: layer.isPaginated,
    pagination: layer.pagination
  }));

  // Custom expanded row renderer that handles pagination
  const customExpandedRowRender = (record: any) => {
    if (record.isPaginated) {
      if (record.layer_name === "AI-generated patches") {
        const visibleRows = record.annotations.map((a: any, i: number) => ({
          key: i.toString(),
          ...a,
        }));

        return (
          <div className="w-full overflow-x-auto" style={{ maxWidth: '100%' }}>
            <Table
              columns={patchExpandColumns}
              dataSource={visibleRows}
              pagination={{
                current: record.pagination.current,
                pageSize: record.pagination.pageSize,
                total: record.pagination.total,
                onChange: handleAiPaginationPatchChange,
                simple: true,
                showSizeChanger: false,
                showQuickJumper: false,
                position: ["bottomCenter"],
              }}
              loading={loading}
              scroll={{ x: 230 }} // Reduced scroll width for patches table
              size="small"
              style={{ 
                fontSize: '12px',
                tableLayout: 'fixed',
                minWidth: '230px'
              }}
              components={{
                body: {
                  cell: ({ children, ...restProps }: any) => (
                    <td {...restProps} style={{ 
                      padding: '6px 3px',
                      verticalAlign: 'middle',
                      lineHeight: '1.3',
                      overflow: 'hidden'
                    }}>
                      {children}
                    </td>
                  ),
                },
              }}
            />

            <div style={{ marginTop: 8, textAlign: "right" }}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  // Create aiVisibleRows data for filtering
                  const aiVisibleRows = record.annotations.map((a: any, i: number) => ({
                    key: i.toString(),
                    ...a,
                  }));

                  let filteredData = aiVisibleRows;

                  const stateFilters = aiAnnotationFilters?.state as string[] | undefined;
                  const typeFilters = aiAnnotationFilters?.annotationType as string[] | undefined;
  
                  if (stateFilters && Array.isArray(stateFilters) && stateFilters.length > 0) {
                    filteredData = filteredData.filter((item: any) => 
                      stateFilters.includes('finished')
                    );
                  }
                  
                  if (typeFilters && Array.isArray(typeFilters) && typeFilters.length > 0) {
                    filteredData = filteredData.filter((item: any) => 
                      typeFilters.includes(item.target?.selector?.type)
                    );
                  }

                  const json = JSON.stringify(filteredData, null, 2);
                  const blob = new Blob([json], { type: "application/json" });
                  const url = window.URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = "AI-generated-patches-filtered.json";
                  link.click();
                }}
              >
                <Download className="h-4 w-4 mr-1" />
                Download filtered
              </Button>
            </div>
          </div>
        );
      }

      // AI-generated annotations
      const aiVisibleRows = record.annotations.map((a: any, i: number) => ({
        key: i.toString(),
        ...a,
      }));

      return (
        <div className="w-full overflow-x-auto">
          <Table
            columns={aiExpandColumns}
            dataSource={aiVisibleRows}
            pagination={{
              current: record.pagination.current,
              pageSize: record.pagination.pageSize,
              total: record.pagination.total,
              onChange: handleAiPaginationChange,
              simple: true,
              showSizeChanger: false,
              showQuickJumper: false,
              position: ["bottomCenter"],
            }}
            loading={loading}
            scroll={{ x: "max-content" }}
            size="small"
            onChange={(pagination, filters, sorter) => {
              console.log('AI Table filters changed:', filters);
              setAiAnnotationFilters(filters);
            }}
          />

          <div style={{ marginTop: 8, textAlign: "right" }}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // Create aiVisibleRows data for filtering
                const aiVisibleRows = record.annotations.map((a: any, i: number) => ({
                  key: i.toString(),
                  ...a,
                }));

                let filteredData = aiVisibleRows;
                const stateFilters = aiAnnotationFilters?.state as string[] | undefined;
                const typeFilters = aiAnnotationFilters?.annotationType as string[] | undefined;
                
                if (stateFilters && Array.isArray(stateFilters) && stateFilters.length > 0) {
                  filteredData = filteredData.filter((item: any) => 
                    stateFilters.includes('finished')
                  );
                }
                
                if (typeFilters && Array.isArray(typeFilters) && typeFilters.length > 0) {
                  filteredData = filteredData.filter((item: any) => 
                    typeFilters.includes(item.target?.selector?.type)
                  );
                }
                
                console.log('AI Filtered data for download:', filteredData);
                
                // User-generated viewport annotations scaled back to normal scale
                const scaledData = filteredData.map((item: any) => {
                  if (item.target?.selector?.geometry) {
                    const geometry = item.target.selector.geometry;
                    return {
                      ...item,
                      target: {
                        ...item.target,
                        selector: {
                          ...item.target.selector,
                          geometry: {
                            ...geometry,
                            bounds: geometry.bounds ? {
                              minX: geometry.bounds.minX / 16,
                              minY: geometry.bounds.minY / 16,
                              maxX: geometry.bounds.maxX / 16,
                              maxY: geometry.bounds.maxY / 16
                            } : geometry.bounds,
                            x: geometry.x ? geometry.x / 16 : geometry.x,
                            y: geometry.y ? geometry.y / 16 : geometry.y,
                            w: geometry.w ? geometry.w / 16 : geometry.w,
                            h: geometry.h ? geometry.h / 16 : geometry.h
                          }
                        }
                      }
                    };
                  }
                  return item;
                });
                
                // Annotorius user marked
                const json = JSON.stringify(scaledData, null, 2);
                const blob = new Blob([json], { type: "application/json" });
                const url = window.URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = "User-generated-annotations-filtered.json";
                link.click();
              }}
            >
              <Download className="h-4 w-4 mr-1" />
              Download filtered
            </Button>
          </div>
        </div>
      );
    }

    // User-generated annotations 
    const userVisibleRows = record.annotations.map((a: any, i: number) => ({
      key: i.toString(),
      ...a,
    }));

    return (
      <div className="w-full overflow-x-auto" style={{ maxWidth: '100%' }}>
        <Table
          columns={expandColumns}
          dataSource={userVisibleRows}
          pagination={{
            pageSize: 5,
            showSizeChanger: true,
            pageSizeOptions: ["5", "10", "20"],
            showQuickJumper: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} items`,
            position: ["bottomCenter"],
          }}
          scroll={{ x: 240 }} // Reduced scroll width for expand table
          size="small"
          className="text-xs"
          style={{ 
            fontSize: '12px',
            tableLayout: 'fixed',
            minWidth: '240px'
          }}
          components={{
            body: {
              cell: ({ children, ...restProps }: any) => (
                <td {...restProps} style={{ 
                  padding: '6px 3px',
                  verticalAlign: 'middle',
                  lineHeight: '1.3',
                  overflow: 'hidden'
                }}>
                  {children}
                </td>
              ),
            },
          }}
          onChange={(pagination, filters, sorter) => {
            console.log('Table filters changed:', filters);
            setUserAnnotationFilters(filters);
          }}
        />
        
        <div style={{ marginTop: 8, textAlign: "right" }}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              let filteredData = userVisibleRows;
              
              // Apply state filter
              if (userAnnotationFilters.state && Array.isArray(userAnnotationFilters.state) && userAnnotationFilters.state.length > 0) {
                filteredData = filteredData.filter((item: any) => 
                  userAnnotationFilters.state.includes('finished')
                );
              }
            
              // Apply annotation type filter
              if (userAnnotationFilters.annotationType && Array.isArray(userAnnotationFilters.annotationType) && userAnnotationFilters.annotationType.length > 0) {
                filteredData = filteredData.filter((item: any) => 
                  userAnnotationFilters.annotationType.includes(item.target?.selector?.type)
                );
              }
              
              console.log('Filtered data for download:', filteredData);

              // User-generated viewport annotations scaled back to normal scale
              const scaledData = filteredData.map((item: any) => {
                if (item.target?.selector?.geometry) {
                  const geometry = item.target.selector.geometry;
                  return {
                    ...item,
                    target: {
                      ...item.target,
                      selector: {
                        ...item.target.selector,
                        geometry: {
                          ...geometry,
                          bounds: geometry.bounds ? {
                            minX: geometry.bounds.minX / 16,
                            minY: geometry.bounds.minY / 16,
                            maxX: geometry.bounds.maxX / 16,
                            maxY: geometry.bounds.maxY / 16
                          } : geometry.bounds,
                          x: geometry.x ? geometry.x / 16 : geometry.x,
                          y: geometry.y ? geometry.y / 16 : geometry.y,
                          w: geometry.w ? geometry.w / 16 : geometry.w,
                          h: geometry.h ? geometry.h / 16 : geometry.h
                        }
                      }
                    }
                  };
                }
                return item;
              });

              const json = JSON.stringify(scaledData, null, 2);
              const blob = new Blob([json], { type: "application/json" });
              const url = window.URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = "User-generated-annotations-filtered.json";
              link.click();
            }}
          >
            <Download className="h-4 w-4 mr-1" />
            Download filtered
          </Button>
        </div>
      </div>
    );
  };

  return (
    <>
      <CCard className="w-full h-full">
        {/*@ts-ignore*/}
        <CCardHeader>
          <h4 style={{ margin: 0 }}>Annotation & Results Management</h4>
        </CCardHeader>
        <CCardBody>
          <Alert
            showIcon
            type="info"
            message="To efficiently manage all annotation labels, we preprocess the data to facilitate further processing by Al models, such as real-time nuclei classification and other advanced analysis tasks."
            className="mb-4"
          />

          <div className="w-full mt-8">
            <div className="overflow-x-auto" style={{ maxWidth: '100%' }}>
              <Table
                columns={columns}
                expandable={{
                  expandedRowRender: (record) => customExpandedRowRender(record)
                }}
                rowKey={(record) => record.key}
                dataSource={dataSource}
                scroll={{ x: 290 }} // Reduced scroll width for compact display
                size="small"
                className="border rounded-lg text-xs"
                pagination={false}
                style={{ 
                  fontSize: '12px',
                  tableLayout: 'fixed',
                  width: '100%',
                  minWidth: '290px'
                }}
                components={{
                  body: {
                    cell: ({ children, ...restProps }: any) => (
                      <td {...restProps} style={{ 
                        padding: '8px 4px',
                        verticalAlign: 'middle',
                        lineHeight: '1.3',
                        overflow: 'hidden'
                      }}>
                        {children}
                      </td>
                    ),
                  },
                }}
              />
            </div>
          </div>
        </CCardBody>
      </CCard>
    </>
  );
};

export default SidebarAnnotation;
