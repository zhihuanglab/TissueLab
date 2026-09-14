/**
 * Offline fallback data for the Community page's factory/model browser.
 * Seeds the factory cards + model sidebar from the bundled model registry so the
 * structure renders without the backend; real fetches overwrite this seed.
 * (Demo classifier/model placeholders were removed — those lists now start empty
 * and show a loading state until the real data is fetched.)
 */

import modelRegistryFallback from "@/constants/modelRegistryFallback.json"
import type { NodeInfo, NodeExtended } from "@/types/community.types"

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
