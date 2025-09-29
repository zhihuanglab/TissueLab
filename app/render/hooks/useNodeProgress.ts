import { useState, useEffect, useRef } from "react"
import { useDispatch, useSelector } from "react-redux"
import { AppDispatch, RootState } from "@/store"
import { setNodeHighestProgress } from "@/store/slices/workflowSlice"
import { AI_SERVICE_HOST } from "@/constants/config";

export const useNodeProgress = (
  nodeType: string,
  nodeStatus: number,
  nodePortsInfo?: Record<string, { port: number, running: boolean }>
) => {
  const dispatch = useDispatch<AppDispatch>();
  // Read highest progress directly from Redux
  const highestProgress = useSelector((state: RootState) => 
    state.workflow.highestProgress[nodeType] || 0
  );
  const [isComplete, setIsComplete] = useState(highestProgress === 100);
  const eventSourceRef = useRef<EventSource | null>(null);
  
  useEffect(() => {
    // Mark as complete if node status is complete or failed
    if (nodeStatus === 2 || nodeStatus === -1) {
      setIsComplete(true);
      // Ensure progress is 100% when node is complete
      if (highestProgress < 100) {
        dispatch(setNodeHighestProgress({ nodeType, progress: 100 }));
      }
    }
    
    // Only connect if node is running
    if (nodeStatus !== 1) {
      // Close any existing connection when not running
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }
    
    // Skip connection for unsupported node types
    if (nodeType === "Scripts" || !nodeType || !nodePortsInfo) return;
    
    // Get node port info
    const nodeInfo = nodePortsInfo[nodeType];
    // Only connect when the node is actually running and has a valid port
    if (!nodeInfo?.port || nodeInfo.running !== true) return;

    // Use current host instead of hardcoded localhost to avoid cross-host issues
    const host = (typeof window !== 'undefined' && window.location && window.location.hostname) ? window.location.hostname : 'localhost';
    // Create the connection
    const progressEndpoint = `http://${AI_SERVICE_HOST}:${nodeInfo.port}/progress`;
    const eventSource = new EventSource(progressEndpoint);
    eventSourceRef.current = eventSource;
    
    // Handle progress updates
    eventSource.onmessage = (event) => {
      try {
        const progressValue = parseInt(event.data, 10);
        // Store in Redux if higher than current value
        dispatch(setNodeHighestProgress({ nodeType, progress: progressValue }));
      } catch (error) {
        console.error(`Error parsing progress message:`, error);
      }
    };
    
    // Standard event handlers
    eventSource.onopen = () => {
      console.log(`SSE connection opened for ${nodeType}`);
      setIsComplete(false);
    };
    
    eventSource.onerror = (error) => {
      console.error(`SSE connection error:`, error);
      // Implementation of reconnection logic here
    };
    
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [nodeType, nodeStatus, nodePortsInfo, highestProgress, dispatch]);
  
  return { progress: highestProgress, isComplete };
}; 