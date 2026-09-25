"use client"

import { useState, useEffect } from "react"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { ChevronLeft, Layers } from "lucide-react"
import { useSelector, useDispatch } from "react-redux"
import { RootState } from "@/store"
import { setFilterHighlightIndices } from "@/store/slices/viewer/shapeSlice"
import { selectPatchClassificationData } from "@/store/slices/viewer/annotationSlice"
import DistributionControl from "./DistributionControl"

export type SelectedClass = {
  source: "nuclei" | "tissue"
  index: number
  name: string
  color: string
}

export type ShapeCoords = { x1: number; y1: number; x2: number; y2: number }

export default function FilterContent({
  shapeCoords = null,
  instanceId = null,
}: {
  shapeCoords?: ShapeCoords | null
  instanceId?: string | null
}) {
  const dispatch = useDispatch()
  const nucleiClasses = useSelector((state: RootState) => state.annotations.nucleiClasses)
  const reduxPatchClassificationData = useSelector(selectPatchClassificationData)
  const [selectedClass, setSelectedClass] = useState<SelectedClass | null>(null)

  // When filter popup is open with no class selected (right side empty), show no cell/contour highlight
  useEffect(() => {
    dispatch(setFilterHighlightIndices([]))
    return () => {
      dispatch(setFilterHighlightIndices(null))
    }
  }, [dispatch])

  const handleBackToClassList = () => {
    setSelectedClass(null)
    dispatch(setFilterHighlightIndices([]))
  }

  return (
    <div className={selectedClass === null ? "h-full" : "flex flex-col gap-3 h-full"}>
      {/* step 1: select a class; step 2: top = selected class, bottom = curve */}
      {selectedClass === null ? (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label>Select a class to view distribution:</Label>
            <Label className="text-xs text-muted-foreground block font-normal">
              Nuclei:
            </Label>
            <div className="space-y-0 bg-secondary/20 p-0.5 rounded-md overflow-y-auto max-h-[150px]">
              <div
                role="button"
                tabIndex={0}
                className="flex items-center gap-2 py-0 px-0.5 rounded-md hover:bg-secondary/30 cursor-pointer border-b border-border/50"
                onClick={() =>
                  setSelectedClass({
                    source: "nuclei",
                    index: -1,
                    name: "All classes",
                    color: "",
                  })
                }
              >
                <Layers className="w-3 h-3 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium">All classes</span>
              </div>
              {nucleiClasses.map((item, index) => (
                <div
                  key={`nuclei-${index}`}
                  role="button"
                  tabIndex={0}
                  className="flex items-center gap-2 py-0 px-0.5 rounded-md hover:bg-secondary/30 cursor-pointer"
                  onClick={() =>
                    setSelectedClass({
                      source: "nuclei",
                      index,
                      name: item.name,
                      color: item.color,
                    })
                  }
                >
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="text-sm">{item.name}</span>
                </div>
              ))}
            </div>
          </div>

          {reduxPatchClassificationData && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground block font-normal">
                Mark this region as tissue type:
              </Label>
              <div className="space-y-0 bg-secondary/20 p-0.5 rounded-md overflow-y-auto max-h-[150px]">
                {reduxPatchClassificationData?.class_name?.map((name, index) => (
                  <div
                    key={`tissue-${index}`}
                    role="button"
                    tabIndex={0}
                    className="flex items-center gap-2 py-0 px-0.5 rounded-md hover:bg-secondary/30 cursor-pointer"
                    onClick={() =>
                      setSelectedClass({
                        source: "tissue",
                        index,
                        name,
                        color:
                          reduxPatchClassificationData.class_hex_color[index] ?? "#FFFF00",
                      })
                    }
                  >
                    <div
                      className="w-3 h-3 rounded shrink-0"
                      style={{
                        backgroundColor:
                          reduxPatchClassificationData.class_hex_color[index] ?? "#FFFF00",
                      }}
                    />
                    <span className="text-sm">{name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* top: selected class */}
          <div className="shrink-0 flex flex-col gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-1 text-muted-foreground hover:text-foreground w-fit"
              onClick={handleBackToClassList}
            >
              <ChevronLeft className="h-3.5 w-3.5 mr-0.5" />
              Change class
            </Button>
            <div className="flex items-center gap-2 py-1.5 px-2 rounded-md bg-secondary/20 w-fit">
              {selectedClass.index >= 0 && selectedClass.color ? (
                <div
                  className="w-3 h-3 rounded shrink-0"
                  style={{
                    backgroundColor: selectedClass.color,
                    borderRadius: selectedClass.source === "nuclei" ? "9999px" : "4px",
                  }}
                />
              ) : (
                <Layers className="w-3 h-3 shrink-0 text-muted-foreground" />
              )}
              <span className="text-sm font-medium">{selectedClass.name}</span>
              <span className="text-xs text-muted-foreground">
                ({selectedClass.source === "nuclei" ? "cell" : "tissue"})
              </span>
            </div>
          </div>
          {/* bottom: probability curve */}
          <div className="flex-1 min-h-0 flex flex-col">
            <DistributionControl selectedClass={selectedClass} shapeCoords={shapeCoords} instanceId={instanceId} />
          </div>
        </>
      )}
    </div>
  )
}
