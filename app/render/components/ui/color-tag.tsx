import { cn } from "@/utils/twMerge"
import { cva, type VariantProps } from "class-variance-authority"
import * as React from "react"

const colorTagVariants = cva(
  "inline-flex items-center font-medium rounded-[4px] px-2 py-0.5 text-xs cursor-pointer transition-colors border [&>*]:text-inherit",
  {
    variants: {
      color: {
        purple: `
          bg-[hsl(var(--purple))/20]
          text-[hsl(var(--purple))]
          border-[hsl(var(--purple))/40]
          hover:bg-[hsl(var(--purple))/30]
          dark:bg-[hsl(var(--purple))/20]
          dark:text-[hsl(var(--purple))]
          dark:border-[hsl(var(--purple))/40]
          dark:hover:bg-[hsl(var(--purple))/30]
        `,
        blue: `
          bg-[hsl(var(--blue))/20]
          text-[hsl(var(--blue))]
          border-[hsl(var(--blue))/40]
          hover:bg-[hsl(var(--blue))/30]
          dark:bg-[hsl(var(--blue))/20]
          dark:text-[hsl(var(--blue))]
          dark:border-[hsl(var(--blue))/40]
          dark:hover:bg-[hsl(var(--blue))/30]
        `,
        yellow: `
          bg-[hsl(var(--yellow))/35]
          text-[hsl(var(--yellow))]
          border-[hsl(var(--yellow))/50]
          hover:bg-[hsl(var(--yellow))/45]
          dark:bg-[hsl(var(--yellow))/20]
          dark:text-[hsl(var(--yellow))]
          dark:border-[hsl(var(--yellow))/40]
          dark:hover:bg-[hsl(var(--yellow))/30]
        `,
        green: `
          bg-[hsl(var(--green))/35]
          text-[hsl(var(--green))]
          border-[hsl(var(--green))/50]
          hover:bg-[hsl(var(--green))/45]
          dark:bg-[hsl(var(--green))/20]
          dark:text-[hsl(var(--green))]
          dark:border-[hsl(var(--green))/40]
          dark:hover:bg-[hsl(var(--green))/30]
        `,
        orange: `
          bg-[hsl(var(--orange))/20]
          text-[hsl(var(--orange))]
          border-[hsl(var(--orange))/40]
          hover:bg-[hsl(var(--orange))/30]
          dark:bg-[hsl(var(--orange))/20]
          dark:text-[hsl(var(--orange))]
          dark:border-[hsl(var(--orange))/40]
          dark:hover:bg-[hsl(var(--orange))/30]
        `,
        cyan: `
          bg-[hsl(var(--cyan))/20]
          text-[hsl(var(--cyan))]
          border-[hsl(var(--cyan))/40]
          hover:bg-[hsl(var(--cyan))/30]
          dark:bg-[hsl(var(--cyan))/20]
          dark:text-[hsl(var(--cyan))]
          dark:border-[hsl(var(--cyan))/40]
          dark:hover:bg-[hsl(var(--cyan))/30]
        `,
        pink: `
          bg-[hsl(var(--pink))/20]
          text-[hsl(var(--pink))]
          border-[hsl(var(--pink))/40]
          hover:bg-[hsl(var(--pink))/30]
          dark:bg-[hsl(var(--pink))/20]
          dark:text-[hsl(var(--pink))]
          dark:border-[hsl(var(--pink))/40]
          dark:hover:bg-[hsl(var(--pink))/30]
        `,
        default: `
          bg-muted/20 text-muted-foreground border-border
          hover:bg-muted/40
          dark:bg-muted/20 dark:text-muted-foreground dark:hover:bg-muted/40
        `,
      }
    },
    defaultVariants: {
      color: "default",
    },
  }
)

export interface ColorTagProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'color'> {
  color?: NonNullable<VariantProps<typeof colorTagVariants>["color"]>
}

function ColorTag({ className, color = "default", ...props }: ColorTagProps) {
  return (
    <div 
      className={cn(colorTagVariants({ color }), className)} 
      {...props}
    />
  )
}

/**
 * Helper to map tag text → color
 */
export function getTagColor(
  tagText: string,
  isFactory?: boolean,
  factoryName?: string
): NonNullable<VariantProps<typeof colorTagVariants>["color"]> {

  const lower = tagText.toLowerCase();

  // Check modality classes first
  if (["pathology", "radiology", "spatial transcriptomics"].includes(lower))
    return "purple";

  // Check tag text itself for factory patterns (regardless of isFactory flag)
  if (lower.includes("tissue segmentation")) return "blue";
  if (lower.includes("cell segmentation")) return "yellow";
  if (lower.includes("nuclei classification") || lower === "classificationnode") return "green";
  if (lower.includes("coding agent")) return "orange";
  if (lower.includes("tissue classification") || lower === "muskclassification" || lower.includes("musk classification")) return "cyan";

  // Check factoryName parameter
  if (factoryName) {
    const f = factoryName.toLowerCase();
    if (f.includes("tissue segmentation") || f === "tissueseg") return "blue";
    if (f.includes("cell segmentation") || f === "nucleiseg") return "yellow";
    if (f.includes("nuclei classification") || f === "nucleiclassify" || f.includes("nucleiclassify")) return "green";
    if (f.includes("coding agent") || f === "codecalculation") return "orange";
    if (f.includes("tissue classification") || f === "tissueclassify" || f.includes("tissueclassify") || f.includes("musk")) return "cyan";
  }

  return "default";
}
export { ColorTag, colorTagVariants }


