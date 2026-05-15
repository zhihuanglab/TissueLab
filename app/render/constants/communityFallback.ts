/**
 * Offline fallback data for the Community page.
 * Used to seed initial state so the UI renders without the backend or Firebase.
 * When real fetches succeed, they overwrite this seed.
 */

import modelRegistryFallback from "@/constants/modelRegistryFallback.json"
import type { NodeInfo, NodeExtended } from "@/types/community.types"
import type { ClassifierData as FirebaseClassifierData } from "@/services/classifiers.service"

export const factoryCategoriesFallback: Record<string, string[]> =
  modelRegistryFallback.category_map as Record<string, string[]>

export const factoryCategoryDisplayNamesFallback: Record<string, string> =
  modelRegistryFallback.category_display_names as Record<string, string>

export const factoryNodesExtendedFallback: Record<string, NodeExtended> =
  modelRegistryFallback.nodes as unknown as Record<string, NodeExtended>

export const factoryNodeInfoFallback: Record<string, NodeInfo> = Object.fromEntries(
  Object.keys(modelRegistryFallback.nodes).map((name) => [
    name,
    { running: true, ready: true, starting: false },
  ])
)

const nowIso = new Date().toISOString()

export const firebaseClassifiersFallback: FirebaseClassifierData[] = [
  {
    id: "sample-clf-1",
    ownerId: "demo-user",
    fileName: "tumor_lymphocyte.classifier",
    localPath: "",
    title: "Tumor vs Lymphocyte (Demo)",
    description: "Per-nucleus classifier distinguishing tumor cells from lymphocytes.",
    factory: "NucleiClassify",
    model: "ClassificationNode",
    downloadLink: "",
    tags: ["pathology", "nuclei", "tumor"],
    classesCount: 2,
    fileSize: 12_345_678,
    isPublic: true,
    createdAt: nowIso,
    updatedAt: nowIso,
    stats: { classes: 2, downloads: 142, size: 12_345_678, stars: 18 },
  },
  {
    id: "sample-clf-2",
    ownerId: "demo-user",
    fileName: "her2_status.classifier",
    localPath: "",
    title: "HER2 Status (Demo)",
    description: "Whole-slide HER2 IHC scoring across 4 classes.",
    factory: "TissueClassify",
    model: "MuskClassification",
    downloadLink: "",
    tags: ["pathology", "her2", "tissue"],
    classesCount: 4,
    fileSize: 24_500_000,
    isPublic: true,
    createdAt: nowIso,
    updatedAt: nowIso,
    stats: { classes: 4, downloads: 91, size: 24_500_000, stars: 11 },
  },
  {
    id: "sample-clf-3",
    ownerId: "demo-user-2",
    fileName: "stroma_seg.classifier",
    localPath: "",
    title: "Stromal Region Map (Demo)",
    description: "Tissue segmentation refinement focused on stromal regions.",
    factory: "TissueSeg",
    model: "BiomedParseSegmentation",
    downloadLink: "",
    tags: ["pathology", "tissue", "stroma"],
    fileSize: 8_900_000,
    isPublic: true,
    createdAt: nowIso,
    updatedAt: nowIso,
    stats: { classes: 3, downloads: 56, size: 8_900_000, stars: 7 },
  },
]

export const firebaseModelsFallback: any[] = [
  {
    id: "sample-model-1",
    ownerId: "demo-user",
    title: "Lung Adeno Subtype (Demo)",
    description: "Patch-based subtype classifier built on MUSK embeddings.",
    factory: "TissueClassify",
    model: "MuskClassification",
    tags: ["pathology", "lung", "musk"],
    fileSize: 312_000_000,
    isPublic: true,
    author: { name: "Demo User", avatar: "/avatars/default.jpg", user_id: "demo-user", username: "demo-user" },
    stats: { size: "297.55 MB", downloads: 220, stars: 34, updatedAt: nowIso, createdAt: nowIso },
  },
  {
    id: "sample-model-2",
    ownerId: "demo-user-2",
    title: "Cardiac MRI Refinement (Demo)",
    description: "Fine-tuned cardiac MR segmentation for hypertrophy cohorts.",
    factory: "TaskSpecific",
    model: "CardiacMRSegmentation",
    tags: ["radiology", "cardiac", "mri"],
    fileSize: 184_000_000,
    isPublic: true,
    author: { name: "Demo Cardiologist", avatar: "/avatars/default.jpg", user_id: "demo-user-2", username: "demo-user-2" },
    stats: { size: "175.5 MB", downloads: 88, stars: 12, updatedAt: nowIso, createdAt: nowIso },
  },
]
