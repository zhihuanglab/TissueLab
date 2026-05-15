"use client";

import React, { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSelector } from "react-redux";
import { RootState } from "@/store";
import { useNucleiClasses } from "@/hooks/useReview";
import { apiFetch } from '@/utils/common/apiFetch';
import { getErrorMessage } from '@/utils/common/apiResponse';
import { AGENT_API_ENDPOINT, AI_SERVICE_API_ENDPOINT, CTRL_SERVICE_API_ENDPOINT } from "@/constants/config";
import { z } from 'zod';

interface ShuffleCandidatesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slideId: string;
}

interface Candidate {
  cell_id: string;
  prob?: number;
  class_name?: string; // Original predicted class name
  image_path?: string; // Path to saved JPEG file in tmp folder (512px, main path for backward compatibility)
  image_path_256?: string; // Path to 256px image (detail)
  image_path_512?: string; // Path to 512px image (context)
  crop?: {
    image: string;
    bbox?: any;
    bounds?: any;
    contour?: any;
  };
  centroid?: {
    x: number;
    y: number;
  };
}

interface AISuggestion {
  cell_id?: string;
  suggested_class?: string;
  confidence?: number;
  reasoning?: string;
}

interface ShuffleResponse {
  candidates?: Candidate[];
  items?: Candidate[];
  total?: number;
  output_dir?: string; // Directory where images are saved
}

interface ClassificationResponse {
  suggestions?: AISuggestion[];
  [key: string]: any;
}

// Zod schemas for API response validation and normalization
const ApiResponseSchema = z.object({
  code: z.number().optional(),
  data: z.any().optional(),
  message: z.string().optional(),
}).passthrough();

const ShuffleResponseSchema = z.object({
  candidates: z.array(z.any()).optional(),
  items: z.array(z.any()).optional(),
  total: z.number().optional(),
  output_dir: z.string().optional(),
}).passthrough();

const ClassificationResponseSchema = z.union([
  z.object({
    suggestions: z.array(z.any()).optional(),
    results: z.array(z.any()).optional(),
    classifications: z.array(z.any()).optional(),
  }).passthrough(),
  z.array(z.any()), // Direct array response
]);

const SuggestionItemSchema = z.object({
  cell_id: z.union([z.string(), z.number()]).optional(),
  cellId: z.union([z.string(), z.number()]).optional(),
  filename: z.string().optional(),
  image_name: z.string().optional(),
  file_name: z.string().optional(),
  suggested_class: z.string().optional(),
  correct_class: z.string().optional(),
  class: z.string().optional(),
  classification: z.string().optional(),
  predicted_class: z.string().optional(),
  confidence: z.union([z.string(), z.number()]).optional(),
  confidence_score: z.number().optional(),
  score: z.number().optional(),
  reasoning: z.string().optional(),
  explanation: z.string().optional(),
  reason: z.string().optional(),
}).passthrough();

// Helper functions for response normalization
function normalizeApiResponse<T>(response: any): T | null {
  if (!response) return null;
  
  try {
    const parsed = ApiResponseSchema.parse(response);
    // Handle standard API response format: { code: 0, data: {...} }
    if (parsed.code === 0 && parsed.data) {
      return parsed.data as T;
    }
    // Handle direct data format
    if (parsed.data) {
      return parsed.data as T;
    }
    // Return the response itself if it doesn't match standard format
    return parsed as T;
  } catch {
    // If validation fails, return the original response
    return response as T;
  }
}

function normalizeShuffleResponse(response: any): ShuffleResponse {
  const normalized = normalizeApiResponse<ShuffleResponse>(response);
  if (!normalized) return {};
  
  try {
    return ShuffleResponseSchema.parse(normalized);
  } catch {
    return normalized;
  }
}

function extractSuggestionsArray(response: any): any[] {
  if (!response) return [];
  
  const normalized = normalizeApiResponse(response);
  if (!normalized) return [];
  
  try {
    const parsed = ClassificationResponseSchema.parse(normalized);
    
    // Handle direct array response
    if (Array.isArray(parsed)) {
      return parsed;
    }
    
    // Handle object with suggestions/results/classifications fields
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, any>;
      if (Array.isArray(obj.suggestions)) return obj.suggestions;
      if (Array.isArray(obj.results)) return obj.results;
      if (Array.isArray(obj.classifications)) return obj.classifications;
    }
    
    return [];
  } catch {
    // Fallback: try to extract manually
    if (Array.isArray(normalized)) return normalized;
    if (normalized && typeof normalized === 'object') {
      const obj = normalized as Record<string, any>;
      if (Array.isArray(obj.suggestions)) return obj.suggestions;
      if (Array.isArray(obj.results)) return obj.results;
      if (Array.isArray(obj.classifications)) return obj.classifications;
    }
    return [];
  }
}

function extractCellId(suggestion: any): string | undefined {
  if (!suggestion) return undefined;
  
  try {
    const parsed = SuggestionItemSchema.parse(suggestion);
    
    // Try cell_id or cellId fields
    if (parsed.cell_id) return String(parsed.cell_id);
    if (parsed.cellId) return String(parsed.cellId);
    
    // Try to extract from filename/image_name
    const filename = parsed.filename || parsed.image_name || parsed.file_name;
    if (filename) {
      const match = String(filename).match(/^(\d+)_/);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    return undefined;
  } catch {
    // Fallback: manual extraction
    if (suggestion.cell_id) return String(suggestion.cell_id);
    if (suggestion.cellId) return String(suggestion.cellId);
    const filename = suggestion.filename || suggestion.image_name || suggestion.file_name;
    if (filename) {
      const match = String(filename).match(/^(\d+)_/);
      if (match && match[1]) return match[1];
    }
    return undefined;
  }
}

function normalizeConfidence(confidence: string | number | undefined): number | undefined {
  if (confidence === undefined || confidence === null) return undefined;
  
  // Handle string confidence values
  if (typeof confidence === 'string') {
    const confStr = confidence.toLowerCase().trim();
    if (confStr === 'high') return 0.9;
    if (confStr === 'medium') return 0.7;
    if (confStr === 'low') return 0.5;
    
    // Try to parse as number
    const parsed = parseFloat(confStr);
    if (!isNaN(parsed)) return parsed;
  }
  
  // Handle numeric confidence values
  if (typeof confidence === 'number') {
    return confidence;
  }
  
  return undefined;
}

function extractSuggestionFields(suggestion: any): Partial<AISuggestion> {
  if (!suggestion) return {};
  
  try {
    const parsed = SuggestionItemSchema.parse(suggestion);
    
    const cellId = extractCellId(parsed);
    if (!cellId) return {};
    
    return {
      cell_id: cellId,
      suggested_class: parsed.correct_class || parsed.suggested_class || parsed.class || parsed.classification || parsed.predicted_class,
      confidence: normalizeConfidence(parsed.confidence) || parsed.confidence_score || parsed.score,
      reasoning: parsed.reasoning || parsed.explanation || parsed.reason,
    };
  } catch {
    // Fallback: manual extraction
    const cellId = extractCellId(suggestion);
    if (!cellId) return {};
    
    return {
      cell_id: cellId,
      suggested_class: suggestion.correct_class || suggestion.suggested_class || suggestion.class || suggestion.classification || suggestion.predicted_class,
      confidence: normalizeConfidence(suggestion.confidence) || suggestion.confidence_score || suggestion.score,
      reasoning: suggestion.reasoning || suggestion.explanation || suggestion.reason,
    };
  }
}

// Component to handle async image loading with size switching
const CandidateImageDisplay: React.FC<{
  candidate: Candidate;
  imageUrls: Map<string, string>;
  setImageUrls: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  getImageUrl: (imagePath: string | undefined, cellId: string, size?: string) => Promise<string | null>;
}> = ({ candidate, imageUrls, setImageUrls, getImageUrl }) => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [currentSize, setCurrentSize] = useState<'256' | '512'>('512'); // Default to 512px (context)

  useEffect(() => {
    const loadImage = async () => {
      setIsLoading(true);
      setHasError(false);
      
      // Determine which image path to use based on currentSize
      let imagePath: string | undefined;
      if (currentSize === '256') {
        imagePath = candidate.image_path_256 || candidate.image_path;
      } else {
        imagePath = candidate.image_path_512 || candidate.image_path;
      }
      
      // Fallback to crop.image if no file path available
      if (!imagePath) {
        imagePath = candidate.crop?.image;
      }
      
      if (!imagePath) {
        setIsLoading(false);
        return;
      }
      
      // Create cache key that includes size
      const cacheKey = `${candidate.cell_id}_${currentSize}`;
      
      // Check if we already have a blob URL cached for this size
      if (imageUrls.has(cacheKey)) {
        setImageUrl(imageUrls.get(cacheKey) || null);
        setIsLoading(false);
        return;
      }
      
      // For base64 images, use directly
      if (imagePath.startsWith('data:image') || imagePath.startsWith('data:')) {
        setImageUrl(imagePath);
        setIsLoading(false);
        return;
      }
      
      // For file paths, fetch via API
      try {
        const url = await getImageUrl(imagePath, candidate.cell_id, currentSize);
        setImageUrl(url);
      } catch (error) {
        console.error('Error loading image:', error);
        setHasError(true);
      } finally {
        setIsLoading(false);
      }
    };
    
    loadImage();
  }, [candidate.cell_id, candidate.image_path, candidate.image_path_256, candidate.image_path_512, candidate.crop?.image, imageUrls, getImageUrl, currentSize]);

  // Toggle between 256px (detail) and 512px (context)
  const toggleSize = () => {
    setCurrentSize(prev => prev === '256' ? '512' : '256');
  };

  return (
    <div className="relative w-full aspect-square mb-2 border rounded overflow-hidden bg-muted group">
      {isLoading ? (
        <div className="w-full h-full flex items-center justify-center">
          <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full"></div>
        </div>
      ) : hasError || !imageUrl ? (
        <div className="w-full h-full flex items-center justify-center text-muted-foreground text-sm">No image</div>
      ) : (
        <>
          <Image
            src={imageUrl}
            alt={`Cell ${candidate.cell_id}`}
            fill
            className="object-cover cursor-pointer"
            style={{ imageRendering: 'pixelated' }}
            unoptimized
            onClick={toggleSize}
            onError={(e) => {
              console.error('Failed to load image:', imageUrl, e);
              setHasError(true);
            }}
          />
          {candidate.prob !== undefined && (
            <div className="absolute top-1 left-1 bg-black bg-opacity-60 text-white text-xs px-1 rounded">
              {candidate.prob.toFixed(3)}
            </div>
          )}
          {/* Size indicator and toggle hint */}
          <div className="absolute bottom-1 right-1 bg-black bg-opacity-60 text-white text-xs px-2 py-1 rounded flex items-center gap-1">
            <span>{currentSize}px</span>
            <span className="text-[10px] opacity-75">({currentSize === '256' ? 'Detail' : 'Context'})</span>
          </div>
          {/* Click hint */}
          <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 transition-all flex items-center justify-center pointer-events-none">
            <span className="text-xs text-white bg-black bg-opacity-50 px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity">
              Click to switch
            </span>
          </div>
        </>
      )}
    </div>
  );
};

export const ShuffleCandidatesDialog: React.FC<ShuffleCandidatesDialogProps> = ({
  open,
  onOpenChange,
  slideId,
}) => {
  // Get nuclei classes for available_classes parameter and getting class colors
  const nucleiClasses = useNucleiClasses();
  
  // MULTI-USER ISOLATION: Get activeInstanceId for per-instance storage
  const activeInstanceId = useSelector((state: RootState) => state.wsi.activeInstanceId);
  
  // Helper function to generate headers with instance_id for multi-user isolation
  const getApiHeaders = useCallback(() => {
    return activeInstanceId ? { 'X-Instance-ID': activeInstanceId } : undefined;
  }, [activeInstanceId]);

  // State to store image URLs (blob URLs created from apiFetch responses)
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(new Map());

  // Helper function to fetch image via apiFetch (with Token) and create blob URL
  const getImageUrl = useCallback(async (imagePath: string | undefined, cellId: string, size?: string): Promise<string | null> => {
    if (!imagePath) return null;
    
    // If it's already a URL (http/https), return as-is
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://') || imagePath.startsWith('data:')) {
      return imagePath;
    }
    
    // If it's a base64 image, return as data URL
    if (imagePath.startsWith('data:image')) {
      return imagePath;
    }
    
    // Create cache key that includes size
    const cacheKey = size ? `${cellId}_${size}` : cellId;
    
    // Check if we already have a blob URL for this image and size
    if (imageUrls.has(cacheKey)) {
      return imageUrls.get(cacheKey) || null;
    }
    
    // Fetch image via apiFetch (this will include Token)
    try {
      const encodedPath = encodeURIComponent(imagePath);
      const response = await apiFetch(
        `${AI_SERVICE_API_ENDPOINT}/review/v1/candidates/images?path=${encodedPath}`,
        {
          method: 'GET',
          headers: getApiHeaders(),
          isReturnResponse: true,
        }
      );
      
      if (response.ok) {
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        setImageUrls(prev => new Map(prev).set(cacheKey, blobUrl));
        return blobUrl;
      }
    } catch (error) {
      console.error('Error fetching image:', error);
    }
    
    return null;
  }, [imageUrls, getApiHeaders]);

  const [threshold, setThreshold] = useState<number>(0.5);
  const [limit, setLimit] = useState<number>(10);
  const [exclude, setExclude] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingAiSuggestions, setLoadingAiSuggestions] = useState<boolean>(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [aiSuggestions, setAiSuggestions] = useState<Map<string, AISuggestion>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setCandidates([]);
      setAiSuggestions(new Map());
      setError(null);
    }
  }, [open]);

  const handleShuffle = async () => {
    if (!slideId) {
      setError("Missing slide_id");
      return;
    }

    setLoading(true);
    setError(null);
    setCandidates([]);
    setAiSuggestions(new Map());

    try {
      // Step 1: Request shuffle candidates
      const shufflePayload = {
        slide_id: slideId,
        threshold: threshold,
        limit: limit,
        exclude: exclude,
      };

      const shuffleResponse = await apiFetch(
        `${AI_SERVICE_API_ENDPOINT}/review/v1/candidates/shuffle`,
        {
          method: 'POST',
          body: JSON.stringify(shufflePayload),
          headers: getApiHeaders(),
          returnAxiosFormat: true,
        }
      );

      // Normalize shuffle response using schema
      const shuffleData = normalizeShuffleResponse(shuffleResponse.data);
      const fetchedCandidates = shuffleData.candidates || shuffleData.items || [];
      setCandidates(fetchedCandidates);

      if (fetchedCandidates.length === 0) {
        setError("No candidates found");
        setLoading(false);
        return;
      }

      // Step 2: Request AI classification suggestions after images are saved
      // Get output_dir from shuffle response (tmp folder path)
      const outputDir = shuffleData.output_dir;
      
      if (!outputDir) {
        console.warn("No output_dir in shuffle response, skipping AI suggestions");
        setLoading(false);
        return;
      }

      // Get available classes from nucleiClasses
      const availableClasses = Array.isArray(nucleiClasses) 
        ? nucleiClasses.map(cls => cls.name)
        : [];

      if (availableClasses.length === 0) {
        console.warn("No available classes found, skipping AI suggestions");
        setLoading(false);
        return;
      }

      const suggestionsMap = new Map<string, AISuggestion>();
      
      // Set loading state for AI suggestions
      setLoadingAiSuggestions(true);
      
      try {
        // Request AI suggestions using folder_path and available_classes
        const classificationPayload = {
          folder_path: outputDir,
          available_classes: availableClasses,
        };

        console.log('[Shuffle] Requesting AI suggestions with payload:', classificationPayload);

        const classificationResponse = await apiFetch(
          `${AGENT_API_ENDPOINT}/agent/v1/reflect/classification`,
          {
            method: 'POST',
            body: JSON.stringify(classificationPayload),
            headers: getApiHeaders(),
            returnAxiosFormat: true,
          }
        );

        // Log the response for debugging
        console.log('[Shuffle] AI classification response:', classificationResponse.data);

        // Extract suggestions array using normalized extraction function
        const suggestions = extractSuggestionsArray(classificationResponse.data);
        console.log('[Shuffle] Extracted suggestions:', suggestions);

        // Process suggestions - match by cell_id or filename
        suggestions.forEach((suggestion: any) => {
          const suggestionFields = extractSuggestionFields(suggestion);
          if (suggestionFields.cell_id) {
            suggestionsMap.set(suggestionFields.cell_id, suggestionFields as AISuggestion);
          }
        });

        // If still no matches, try to match by filename pattern (fallback matching)
        if (suggestionsMap.size === 0 && suggestions.length > 0) {
          fetchedCandidates.forEach((candidate: Candidate) => {
            const candidateCellId = String(candidate.cell_id);
            
            // Try to find suggestion by matching cell_id in any field
            const matchingSuggestion = suggestions.find((s: any) => {
              const suggestionCellId = extractCellId(s);
              if (suggestionCellId === candidateCellId) return true;
              
              // Check filename contains cell_id
              const filename = s.filename || s.image_name || s.file_name || '';
              if (filename && filename.includes(candidateCellId)) return true;
              
              return false;
            });
            
            if (matchingSuggestion) {
              const suggestionFields = extractSuggestionFields(matchingSuggestion);
              if (suggestionFields.cell_id) {
                suggestionsMap.set(candidateCellId, suggestionFields as AISuggestion);
              }
            }
          });
        }

        console.log('[Shuffle] Final suggestions map:', Array.from(suggestionsMap.entries()));
        console.log('[Shuffle] Suggestions map size:', suggestionsMap.size);
      } catch (classificationError: any) {
        console.error("Failed to get AI suggestions:", classificationError);
        // Continue even if AI suggestions fail
      } finally {
        setLoadingAiSuggestions(false);
      }

      // Update suggestions state - this should trigger re-render
      setAiSuggestions(new Map(suggestionsMap));
      console.log('[Shuffle] Updated aiSuggestions state, size:', suggestionsMap.size);
    } catch (err: any) {
      setError(getErrorMessage(err, "Request failed"));
      console.error("Shuffle candidates error:", err);
    } finally {
      setLoading(false);
    }
  };

  // Handle save: reclassify all candidates with AI suggestions
  const handleSave = async () => {
    if (!slideId || candidates.length === 0 || aiSuggestions.size === 0) {
      setError("No candidates with AI suggestions to save");
      return;
    }

    setSaving(true);
    setError(null);
    setSaveSuccess(false);

    try {
      const promises = [];
      let successCount = 0;
      let errorCount = 0;

      // Process all candidates with AI suggestions
      for (const candidate of candidates) {
        const suggestion = aiSuggestions.get(candidate.cell_id);
        if (!suggestion || !suggestion.suggested_class) {
          continue; // Skip candidates without suggestions
        }

        // Extract original class from candidate
        let originalClass = candidate.class_name;
        if (!originalClass && candidate.image_path) {
          const filename = candidate.image_path.split(/[/\\]/).pop() || '';
          const match = filename.match(/^\d+_(.+)\.jpe?g$/i);
          if (match && match[1]) {
            originalClass = match[1].replace(/_/g, ' ');
          }
        }

        if (!originalClass) {
          console.warn(`[Shuffle Save] Skipping candidate ${candidate.cell_id}: no original class found`);
          continue;
        }

        // Get color for the new class
        const newClassObj = nucleiClasses.find(cls => cls.name === suggestion.suggested_class);
        const newClassColor = newClassObj?.color || '#808080';

        const payload = {
          slide_id: slideId,
          cell_id: candidate.cell_id,
          original_class: originalClass,
          new_class: suggestion.suggested_class,
          prob: candidate.prob || 0,
          centroid_x: candidate.centroid?.x,
          centroid_y: candidate.centroid?.y,
          cell_color: newClassColor,
          is_manual_reclassification: true,
        };

        promises.push(
          apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/reclassify`, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: getApiHeaders(),
            returnAxiosFormat: true,
          })
            .then(() => {
              successCount++;
            })
            .catch((error) => {
              console.error(`[Shuffle Save] Error reclassifying cell ${candidate.cell_id}:`, error);
              errorCount++;
            })
        );
      }

      await Promise.all(promises);

      if (errorCount === 0) {
        setSaveSuccess(true);
        setError(null);
        // Clear success message after 3 seconds
        setTimeout(() => {
          setSaveSuccess(false);
        }, 3000);
      } else {
        setError(`Saved ${successCount} reclassifications, ${errorCount} failed`);
      }
    } catch (err: any) {
      setError(getErrorMessage(err, "Failed to save reclassifications"));
      console.error("Shuffle save error:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[90vw] w-full max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>Shuffle Candidates & AI Suggestions</DialogTitle>
            {candidates.length > 0 && aiSuggestions.size > 0 && (
              <Button
                onClick={handleSave}
                disabled={saving}
                className="ml-4"
                variant="default"
              >
                {saving ? "Saving..." : "Save"}
              </Button>
            )}
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-4 flex-1 min-h-0 overflow-hidden">
          {/* Form Section */}
          <div className="flex-shrink-0 grid grid-cols-3 gap-4 p-4 border rounded-lg">
            <div className="space-y-2">
              <Label htmlFor="threshold">Threshold</Label>
              <Input
                id="threshold"
                type="number"
                step="0.1"
                min="0"
                max="1"
                value={threshold}
                onChange={(e) => setThreshold(parseFloat(e.target.value) || 0.5)}
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="limit">Limit</Label>
              <Input
                id="limit"
                type="number"
                min="1"
                max="100"
                value={limit}
                onChange={(e) => setLimit(parseInt(e.target.value) || 20)}
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="exclude">Exclude</Label>
              <div className="flex items-center space-x-2 pt-2">
                <input
                  id="exclude"
                  type="checkbox"
                  checked={exclude}
                  onChange={(e) => setExclude(e.target.checked)}
                  disabled={loading}
                  className="w-4 h-4"
                />
                <Label htmlFor="exclude" className="cursor-pointer">
                  Exclude already annotated cells
                </Label>
              </div>
            </div>
            <div className="col-span-3">
              <Button
                onClick={handleShuffle}
                disabled={loading || !slideId}
                className="w-full"
              >
                {loading ? "Loading..." : "Get Candidates"}
              </Button>
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="flex-shrink-0 p-3 bg-red-50 border border-red-200 rounded text-red-700">
              {error}
            </div>
          )}

          {/* Success Display */}
          {saveSuccess && (
            <div className="flex-shrink-0 p-3 bg-green-50 border border-green-200 rounded text-green-700">
              Successfully saved {aiSuggestions.size} reclassifications!
            </div>
          )}

          {/* AI Suggestions Loading Indicator */}
          {loadingAiSuggestions && candidates.length > 0 && (
            <div className="flex-shrink-0 p-3 bg-blue-50 border border-blue-200 rounded text-blue-700">
              <div className="flex items-center gap-2">
                <div className="animate-spin w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full"></div>
                <span>Loading AI suggestions... This may take a few minutes.</span>
              </div>
            </div>
          )}

          {/* Results Section */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {candidates.length > 0 ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-4">
                {candidates.map((candidate) => {
                  const suggestion = aiSuggestions.get(candidate.cell_id);
                  
                  // Extract original class from image_path filename if class_name is not available
                  // Filename format: {cell_id}_{class_name}.jpeg
                  let originalClass = candidate.class_name;
                  if (!originalClass && candidate.image_path) {
                    const filename = candidate.image_path.split(/[/\\]/).pop() || '';
                    const match = filename.match(/^\d+_(.+)\.jpe?g$/i);
                    if (match && match[1]) {
                      originalClass = match[1].replace(/_/g, ' '); // Replace underscores with spaces
                    }
                  }
                  
                  return (
                    <div
                      key={candidate.cell_id}
                      className="border rounded-lg p-3 bg-background hover:shadow-md transition-shadow"
                    >
                      {/* Candidate Image */}
                      <CandidateImageDisplay
                        candidate={candidate}
                        imageUrls={imageUrls}
                        setImageUrls={setImageUrls}
                        getImageUrl={getImageUrl}
                      />

                      {/* Candidate Info */}
                      <div className="text-xs space-y-1">
                        <div className="font-mono text-muted-foreground">
                          ID: {candidate.cell_id}
                        </div>
                        {candidate.centroid && (
                          <div className="text-muted-foreground">
                            position: ({candidate.centroid.x.toFixed(0)}, {candidate.centroid.y.toFixed(0)})
                          </div>
                        )}

                        {/* Original Class */}
                        {originalClass && (
                          <div className="mt-2 p-2 bg-gray-50 border border-gray-200 rounded">
                            <div className="font-semibold text-gray-900 text-xs mb-1">
                              Original Class:
                            </div>
                            <div className="text-gray-800 text-xs">
                              {originalClass}
                            </div>
                          </div>
                        )}

                        {/* AI Suggestion */}
                        {suggestion && (
                          <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded">
                            <div className="font-semibold text-blue-900 text-xs mb-1">
                              AI Suggestion:
                            </div>
                            {suggestion.suggested_class && (
                              <div className="text-blue-800 text-xs font-medium">
                                Suggested Class: {suggestion.suggested_class}
                              </div>
                            )}
                            {suggestion.confidence !== undefined && (
                              <div className="text-blue-700 text-xs">
                                Confidence: {(suggestion.confidence * 100).toFixed(1)}%
                              </div>
                            )}
                            {suggestion.reasoning && (
                              <div className="text-blue-600 text-xs mt-2 p-1 bg-blue-100 rounded max-h-24 overflow-y-auto">
                                <div className="font-medium mb-1">Reasoning:</div>
                                <div className="whitespace-pre-wrap break-words">{suggestion.reasoning}</div>
                              </div>
                            )}
                          </div>
                        )}
                        {!suggestion && !loadingAiSuggestions && (
                          <div className="mt-2 text-xs text-muted-foreground">
                            No AI suggestions
                          </div>
                        )}
                        {!suggestion && loadingAiSuggestions && (
                          <div className="mt-2 text-xs text-muted-foreground">
                            Loading AI suggestions...
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : loading ? (
              <div className="flex items-center justify-center h-64">
                <div className="text-center">
                  <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full mx-auto mb-2"></div>
                  <p className="text-muted-foreground">Loading...</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-64 text-muted-foreground">
                Click the Get Candidates button to start
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
