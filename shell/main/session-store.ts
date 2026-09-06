import type { ModelMessage } from "../../agent/model/types.js";

/**
 * 会话级模型上下文（单会话，跨 run 累积）。
 *
 * 每个 run 开始时 Runner 将 snapshot() 作为 history 传给 loop；
 * loop 在 onMessageFinalized 里把本 run 产生的新消息追加回来。
 * 只服务模型上下文；Renderer 展示仍走事件流投影，不存在第二份真相。
 *
 * 消息被视为不可变（loop 每次 push 新对象、从不改写既有项），
 * 因此快照只需浅拷贝数组即可。
 */
class SessionStore {
  private messages: ModelMessage[] = [];

  append(message: ModelMessage): void {
    this.messages.push(message);
  }

  snapshot(): ModelMessage[] {
    return this.messages.slice();
  }

  clear(): void {
    this.messages = [];
  }
}

export const sessionStore = new SessionStore();
