declare global {
  interface Window {
    electron: {
      invoke(channel: string, ...args: any[]): Promise<any>;
      send(channel: string, ...args: any[]): void;
      on(channel: string, callback: (...args: any[]) => void): void;
      off(channel: string, callback: (...args: any[]) => void): void;
      // Local file manager APIs
      listLocalFiles: (dirPath: string) => Promise<any[]>;
      createLocalFolder: (folderPath: string) => Promise<any>;
      renameLocalFile: (oldPath: string, newPath: string) => Promise<any>;
      deleteLocalFiles: (paths: string[]) => Promise<any>;
      moveLocalFiles: (paths: string[], destDir: string) => Promise<any>;
      uploadLocalFiles: (destDir: string, files: string[]) => Promise<any>;
      readFile: (filePath: string) => Promise<Buffer>;
      writeFile: (options: { filePath: string; content: string }) => Promise<{ success: boolean }>;
      // OAuth APIs (PKCE-based; clientSecret is the non-confidential Desktop OAuth secret)
      googleOAuth: (credentials: { clientId: string; clientSecret?: string }) => Promise<{
        success: boolean;
        tokens?: {
          access_token: string;
          id_token: string;
          refresh_token?: string;
          expires_in?: number;
        };
        error?: string;
      }>;
      googleRefreshToken: (params: { refreshToken: string; clientId: string; clientSecret?: string }) => Promise<{
        success: boolean;
        tokens?: {
          access_token: string;
          id_token: string;
          expires_in?: number;
        };
        error?: string;
      }>;
      // Refresh token storage APIs
      saveRefreshToken: (params: { token: string }) => Promise<{
        success: boolean;
        warning?: string;
        error?: string;
      }>;
      getRefreshToken: () => Promise<{
        success: boolean;
        token?: string;
        error?: string;
      }>;
      deleteRefreshToken: () => Promise<{
        success: boolean;
        error?: string;
      }>;
    };
  }
}

export {};