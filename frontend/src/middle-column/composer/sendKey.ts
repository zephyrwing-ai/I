/** Enter 且未按 Shift 且不在输入法组字状态时，回车具备提交语义。 */
export function isSendKey(key: string, shiftKey: boolean, composing: boolean): boolean {
  return key === "Enter" && !shiftKey && !composing;
}
