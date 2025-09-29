import { useEffect, useRef } from 'react';
import { useAnnotatorInstance } from '@/contexts/AnnotatorContext';
import { deleteInstance } from '@/utils/file.service';

// Global registry to ensure only one delayed cleanup timer per instanceId
const scheduledCleanupTimers: Map<string, NodeJS.Timeout> = new Map();

export const useInstanceCleanup = () => {
  const { instanceId, setInstanceId } = useAnnotatorInstance();
  const previousInstanceIdRef = useRef<string | null>(null);

  // Clean up previous instance when instanceId changes
  useEffect(() => {
    const previousInstanceId = previousInstanceIdRef.current;
    
    if (previousInstanceId && previousInstanceId !== instanceId) {
      console.log('Cleaning up previous instance:', previousInstanceId);
      deleteInstance(previousInstanceId)
        .then(() => {
          console.log('Successfully cleaned up instance:', previousInstanceId);
        })
        .catch((error) => {
          console.error('Failed to clean up instance:', previousInstanceId, error);
        });
    }
    
    // If there's a pending delayed cleanup for the current instance, cancel it (reconnection/remount)
    if (instanceId && scheduledCleanupTimers.has(instanceId)) {
      const timer = scheduledCleanupTimers.get(instanceId)!;
      clearTimeout(timer);
      scheduledCleanupTimers.delete(instanceId);
      console.log('Cancelled pending delayed cleanup due to remount/reuse:', instanceId);
    }

    previousInstanceIdRef.current = instanceId;
  }, [instanceId]);

  // Clean up on unmount with delayed cleanup (singleton per instanceId)
  useEffect(() => {
    return () => {
      if (instanceId) {
        // Only schedule if no existing timer for this instanceId
        if (!scheduledCleanupTimers.has(instanceId)) {
          console.log('Component unmounting, scheduling delayed instance cleanup:', instanceId);
          const timer = setTimeout(() => {
            // Ensure this is still the active timer for the instance
            if (scheduledCleanupTimers.get(instanceId) === timer) {
              console.log('Executing delayed instance cleanup after component unmount:', instanceId);
              deleteInstance(instanceId)
                .then(() => {
                  console.log('Successfully cleaned up instance after component unmount:', instanceId);
                })
                .catch((error) => {
                  console.error('Failed to clean up instance after component unmount:', instanceId, error);
                })
                .finally(() => {
                  scheduledCleanupTimers.delete(instanceId);
                });
            }
          }, 30000); // 30 seconds delay
          scheduledCleanupTimers.set(instanceId, timer);
        } else {
          console.log('Delayed cleanup already scheduled for instance, skipping duplicate schedule:', instanceId);
        }
      }
    };
  }, [instanceId]);

  const clearInstance = () => {
    if (instanceId) {
      deleteInstance(instanceId)
        .then(() => {
          console.log('Successfully cleared instance:', instanceId);
          setInstanceId(null);
          // Clear any pending global delayed cleanup
          if (scheduledCleanupTimers.has(instanceId)) {
            const timer = scheduledCleanupTimers.get(instanceId)!;
            clearTimeout(timer);
            scheduledCleanupTimers.delete(instanceId);
          }
        })
        .catch((error) => {
          console.error('Failed to clear instance:', instanceId, error);
        });
    }
  };

  return { clearInstance };
};
