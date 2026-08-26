/** 执行结果 — 所有后端统一返回这个结构 */
export interface ExecResult {
  output: string;
  returncode: number;
  truncated: boolean;
  fullOutputPath?: string;
}

/** BashOperations 接口 — 跟 PI 一样的模式 */
export interface BashOperations {
  exec(command: string, cwd: string, opts: ExecOptions): Promise<ExecResult>;
}

export interface ExecOptions {
  timeout?: number;
  signal?: AbortSignal;
}
