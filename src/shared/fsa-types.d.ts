// FSA 权限扩展类型声明。
// 标准 TS lib 不包含 queryPermission/requestPermission（属于 spec 扩展，所有现代 Chromium 浏览器都支持）。
// 仅声明我们用到的那部分，不重复定义 FileSystemDirectoryHandle 主体。

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

type PermissionState = 'granted' | 'denied' | 'prompt';

interface FileSystemHandle {
  queryPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
}

interface Window {
  showDirectoryPicker(options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
  }): Promise<FileSystemDirectoryHandle>;
}
