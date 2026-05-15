/**
 * Color utility functions
 * Used for color validation and generation, avoiding pure black and pure white colors
 */

/**
 * Check if a color is pure black or pure white
 * @param color - Hexadecimal color string (e.g., #000000 or #FFFFFF)
 * @returns Returns true if the color is pure black or pure white, otherwise returns false
 */
export function isBlackOrWhite(color: string): boolean {
  if (!color) return false;
  
  const normalizedColor = color.toUpperCase().trim();
  
  // Check for pure black
  if (normalizedColor === '#000000' || normalizedColor === '000000') {
    return true;
  }
  
  // Check for pure white
  if (normalizedColor === '#FFFFFF' || normalizedColor === 'FFFFFF') {
    return true;
  }
  
  return false;
}

/**
 * Generate a random color, ensuring it's not pure black or pure white
 * @param existingColors - Optional array of existing colors, the generated color will try to avoid being the same as these colors
 * @returns Hexadecimal color string (e.g., #A1B2C3)
 */
export function generateRandomColor(existingColors?: string[]): string {
  const maxAttempts = 100; // Maximum 100 attempts
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    // Generate random number, range from 1 to 16777214 (avoiding 0 and 16777215)
    // 0 is black #000000
    // 16777215 is white #FFFFFF
    const randomNum = Math.floor(Math.random() * 16777214) + 1;
    const color = '#' + randomNum.toString(16).padStart(6, '0').toUpperCase();
    
    // Double-check that it's not black or white
    if (isBlackOrWhite(color)) {
      attempts++;
      continue;
    }
    
    // If existing colors list is provided, try to avoid duplicates
    if (existingColors && existingColors.length > 0) {
      const normalizedExisting = existingColors.map(c => 
        c.toUpperCase().startsWith('#') ? c.toUpperCase() : `#${c.toUpperCase()}`
      );
      
      if (!normalizedExisting.includes(color)) {
        return color;
      }
    } else {
      return color;
    }
    
    attempts++;
  }
  
  // If 100 attempts haven't found a non-duplicate color, return a color that's guaranteed not to be black or white
  // Use timestamp to ensure it's different each time
  const timestamp = Date.now() % 16777214 + 1;
  return '#' + timestamp.toString(16).padStart(6, '0').toUpperCase();
}

/**
 * Validate and fix color, replace with random color if it's black or white
 * @param color - Input color
 * @param existingColors - Optional array of existing colors
 * @returns Valid color (non-black/white)
 */
export function validateAndFixColor(color: string, existingColors?: string[]): string {
  if (isBlackOrWhite(color)) {
    return generateRandomColor(existingColors);
  }
  
  // Ensure color starts with #
  return color.startsWith('#') ? color : `#${color}`;
}
