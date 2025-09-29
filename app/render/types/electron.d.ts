declare global {
  interface Window {
    electron: {
      invoke(channel: string, ...args: any[]): Promise<any>;
      send(channel: string, ...args: any[]): void;
      on(channel: string, callback: (...args: any[]) => void): void;
      removeAllListeners(channel: string): void;
      removeListener(channel: string, listener: (...args: any[]) => void): void;
      receive(channel: string, func: (...args: any[]) => void): void;
      getGPUStatus: () => Promise<any>;
      // Local file manager APIs
      listLocalFiles: (dirPath: string) => Promise<any[]>;
      createLocalFolder: (folderPath: string) => Promise<any>;
      renameLocalFile: (oldPath: string, newPath: string) => Promise<any>;
      deleteLocalFiles: (paths: string[]) => Promise<any>;
      moveLocalFiles: (paths: string[], destDir: string) => Promise<any>;
      uploadLocalFiles: (destDir: string, files: string[]) => Promise<any>;
      pathJoin: (...paths: string[]) => string;
      readFile: (filePath: string) => Promise<Buffer>;
    };
  }
}

export {};
