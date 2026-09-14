// Predefined cell-class taxonomy (Huang Lab roadmap), ported from
// tissuelab.org/src/components/huanglab/classifierData.ts. Used by the
// "Class library (by type)" picker in the Load Classifier dialog so annotators
// add consistent, designed class names instead of free-typing.
//
// Cell classes only for now (patch/tissue-area groups are a follow-up).

export interface CellTaxonomyGroup {
  group: string;
  classes: string[];
}

export const CELL_TAXONOMY: CellTaxonomyGroup[] = [
  {
    group: 'Cancer-agnostic',
    classes: [
      'Mitotic figure',
      'Apoptotic / necrotic cell',
      'Lymphocyte (TIL)',
      'Plasma cell',
      'Neutrophil',
      'Eosinophil',
      'Macrophage / histiocyte',
      'Fibroblast / stromal cell',
      'Endothelial cell',
      'Adipocyte',
      'Smooth muscle cell',
      'Red blood cell',
      'Nerve / ganglion cell',
    ],
  },
  {
    group: 'Skin',
    classes: [
      'Melanoma cell (atypical melanocyte)',
      'Benign melanocyte',
      'Keratinocyte (epidermal)',
      'Basal cell carcinoma cell',
      'Squamous cell carcinoma cell',
      'Sebaceous cell',
      'Epidermis',
      'Dermis',
      'Melanocytic cells',
    ],
  },
  {
    group: 'Prostate',
    classes: [
      'Benign secretory epithelium',
      'Basal cell',
      'Gleason 3 tumor cell',
      'Gleason 4 tumor cell',
      'Gleason 5 tumor cell',
    ],
  },
  {
    group: 'Breast',
    classes: [
      'Invasive carcinoma cell',
      'DCIS cell (in-situ)',
      'Lobular carcinoma cell',
      'Normal ductal / lobular epithelium',
      'Myoepithelial cell',
    ],
  },
  {
    group: 'Colon / Rectum',
    classes: [
      'Adenocarcinoma cell',
      'Normal colonocyte (absorptive)',
      'Goblet cell',
      'Signet-ring cell',
      'Paneth cell',
    ],
  },
  {
    group: 'Lung',
    classes: [
      'Adenocarcinoma cell',
      'Squamous cell carcinoma cell',
      'Pneumocyte (alveolar)',
      'Bronchial epithelial cell',
    ],
  },
  {
    group: 'Lymph node',
    classes: [
      'Metastatic carcinoma cell',
      'Germinal-center lymphoid cell',
      'Sinus histiocyte',
    ],
  },
  {
    group: 'Bladder',
    classes: ['Urothelial carcinoma cell', 'Normal urothelium'],
  },
  {
    group: 'Stomach / GI (upper)',
    classes: ['Gastric adenocarcinoma cell', 'Foveolar / glandular epithelium', 'Signet-ring cell'],
  },
  {
    group: 'Pancreas',
    classes: ['Ductal adenocarcinoma cell', 'Acinar cell', 'Islet cell'],
  },
  {
    group: 'Liver',
    classes: ['Hepatocellular carcinoma cell', 'Normal hepatocyte', 'Bile duct epithelium'],
  },
  {
    group: 'Kidney',
    classes: ['Renal cell carcinoma cell', 'Tubular epithelium'],
  },
];
