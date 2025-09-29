/**
 * Formats a file path based on the operating system.
 * Converts forward slashes to backslashes on Windows and vice versa on macOS/Linux.
 * @param path The path to format
 * @returns The formatted path
 */
export const formatPath = (path: string): string => {
  const isWindows = typeof window !== 'undefined' && navigator.userAgent.includes("Windows");
  if (isWindows) {
    return path.replace(/\//g, "\\"); // macOS/Linux → Windows
  } else {
    return path.replace(/\\/g, "/"); // Windows → macOS/Linux
  }
}; 