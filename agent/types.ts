/** 仅在 Agent / Main 内部流转的结构化文件产物。绝对路径不得进入 Renderer。 */
export interface FileArtifact {
  path: string;
  operation: "created" | "updated";
  mediaType: string;
  byteSize: number;
  updatedAt: string;
}

/** 执行结果 — 所有后端统一返回这个结构 */
export interface ExecResult {
  output: string;
  returncode: number;
  truncated: boolean;
  fullOutputPath?: string;
  artifacts?: FileArtifact[];
}

/** BashOperations 接口 — 跟 PI 一样的模式 */
export interface BashOperations {
  exec(command: string, cwd: string, opts: ExecOptions): Promise<ExecResult>;
}

export interface ExecOptions {
  timeout?: number;
  signal?: AbortSignal;
}
