/**
 * Constants for the Community module
 */

export const FACTORY_CATEGORIES = [
  { id: 'tissue_segmentation', name: 'Tissue Segmentation', description: 'Advanced tissue segmentation tools and models' },
  { id: 'cell_segmentation', name: 'Cell Segmentation + Embedding', description: 'Cell-level segmentation with embedding generation' },
  { id: 'nuclei_classification', name: 'Nuclei Classification', description: 'Nuclei classification and analysis tools' },
  { id: 'code_calculation', name: 'Code Calculation', description: 'Code-based calculation and analysis tools' },
  { id: 'tissue_classification', name: 'Tissue Classification', description: 'Multi-organ tissue classification systems' }
] as const

export const MODALITY_TAGS = [
  'Pathology',
  'Radiology',
  'Spatial Transcriptomics'
] as const

export const CATEGORY_TO_FACTORY_MAP: Record<string, string> = {
  'TissueSeg': 'tissue_segmentation',
  'NucleiSeg': 'cell_segmentation', 
  'NucleiClassify': 'nuclei_classification',
  'TissueClassify': 'tissue_classification',
  'Scripts': 'code_calculation'
}

export const FACTORY_TO_CATEGORY_MAP: Record<string, string> = {
  'tissue_segmentation': 'TissueSeg',
  'cell_segmentation': 'NucleiSeg',
  'nuclei_classification': 'NucleiClassify', 
  'tissue_classification': 'TissueClassify',
  'code_calculation': 'Scripts'
}

export const INSTALL_STEPS_INITIAL = [
  { key: 'sign', label: 'Authenticate', status: 'pending' as const },
  { key: 'download', label: 'Download tasknode', status: 'pending' as const },
  { key: 'verify', label: 'Verify tasknode', status: 'pending' as const },
  { key: 'unpack', label: 'Unpack to storage', status: 'pending' as const },
  { key: 'persist', label: 'Persist tasknode', status: 'pending' as const },
  { key: 'activate', label: 'Activate tasknode', status: 'pending' as const },
  { key: 'ready', label: 'Ready', status: 'pending' as const },
]

export const ITEMS_PER_PAGE = 8

// Whitelist configuration for factory permissions
export const FACTORY_WHITELIST_CONFIG: Record<string, string[]> = {
  'sdfJ3DBZ1EaLFn2Ye2SSkgqPQs53': ['*'], // Admin user
  'ypL5vaSDrLhlifVSODFkAtZDYoy1': ['*'], // Admin user
  'Ws2ZFfBLRZcRrXMtnvlesE2JwS13': ['*'], // Admin user
  '56sPU8GJljVfiGACiVNVTL75vh03': ['*'], // Admin user
  'zcjUp7q8NkhzYBrlrl2ixhpNaHB3': ['*'], // Admin user
  'eWhm946nQ3OxOCKfa8okyxxUmjS2': ['*'], // Admin user
  'WCR5PrnrwBUGmDufG2bAaSWonLr1': ['*'], // Admin user
  'h5VBPhlW5uWXpJyDGOGcsWUjfoc2': ['*'], // Admin user
  'FDQaGQD50gN0D7JC9bmyKmRITHd2': ['*'], // Admin user
  'n9p2yJr3JiZf1O3FiPvNUFkIMoB2': ['*'], // Admin user
  'default': []
}

