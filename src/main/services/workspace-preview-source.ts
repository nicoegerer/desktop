/** Main-process only. Never accept a source or a remote URL from a renderer. */
export interface WorkspacePreviewSource {
  root: string
  isActive(): boolean
  listFiles(): Promise<string[]>
  readFile(relativePath: string): Promise<Buffer>
}
