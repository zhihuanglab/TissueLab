import { useState, useEffect, useRef } from "react"
import { useDispatch, useSelector } from "react-redux"
import { AppDispatch, RootState } from "@/store"
import { setNodeHighestProgress } from "@/store/slices/chat/workflowSlice"
import { AI_SERVICE_HOST } from "@/constants/config";

// SSE reconnection configuration
const SSE_MAX_RETRIES = 5;
const SSE_BASE_DELAY_MS = 1000; // 1 second
const SSE_MAX_DELAY_MS = 15000; // 15 seconds

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
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousStatusRef = useRef<number | null>(null);
  
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = nodeStatus;

    // Node restarted after completion/failure/interruption: reset completion/progress first.
    if (nodeStatus === 1 && previousStatus !== 1) {
      setIsComplete(false);
      if (highestProgress > 0) {
        dispatch(setNodeHighestProgress({ nodeType, progress: -1 }));
      }
    }

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
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      retryCountRef.current = 0;
      return;
    }
    
    // Skip connection for unsupported node types
    if (nodeType === "CodingAgent" || !nodeType || !nodePortsInfo) return;
    
    // Get node port info
    const nodeInfo = nodePortsInfo[nodeType];
    // Only connect when the node is actually running and has a valid port
    if (!nodeInfo?.port || nodeInfo.running !== true) return;

    const connectSSE = () => {
      // Clean up previous connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

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
        retryCountRef.current = 0; // Reset retry count on successful connection
      };
      
      eventSource.onerror = () => {
        // Close the broken connection
        eventSource.close();
        eventSourceRef.current = null;

        // Only retry if the node is still supposed to be running
        if (retryCountRef.current < SSE_MAX_RETRIES) {
          const delay = Math.min(
            SSE_BASE_DELAY_MS * Math.pow(2, retryCountRef.current),
            SSE_MAX_DELAY_MS
          );
          retryCountRef.current += 1;
          console.log(`SSE reconnecting for ${nodeType} in ${delay}ms (attempt ${retryCountRef.current}/${SSE_MAX_RETRIES})`);
          retryTimerRef.current = setTimeout(() => {
            // Re-check that we should still be connecting
            if (eventSourceRef.current === null) {
              connectSSE();
            }
          }, delay);
        } else {
          console.warn(`SSE max retries reached for ${nodeType}, giving up`);
        }
      };
    };

    connectSSE();
    
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      retryCountRef.current = 0;
    };
  }, [nodeType, nodeStatus, nodePortsInfo, highestProgress, dispatch]);
  
  return { progress: highestProgress, isComplete };
}; 