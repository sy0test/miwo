import { ref } from "vue";
import { io, Socket } from "socket.io-client";
import userStore from "@/stores/user";

export interface SocketEventMap {
  //scriptAgent
  getPlanData: (data: any, callback: (response: any) => void) => void;
  setPlanData: (data: any) => void;
  //productionAgent
  getFlowData: (data: any, callback: (response: any) => void) => void;
  setFlowData: (data: any) => void;
  //公共
  message: string;
  setKeyScript: { scriptId: number; key: string };
  stop: string;
  textMessage: { type: "start" | "content" | "end"; messageId: string; delta: string | null; role: "assistant"; name: string };
  systemMessage: { messageId: string; content: string };
  thinkMessage: { type: "start" | "content" | "end"; messageId: string; delta: string | null; role: "assistant"; name: string };
}

// ⚠ 默认 url 不写死 localhost：本机当服务器、用户机用浏览器访问时 localhost 指用户自己的机器。
// 不传就用同源（页面由后端吐出，同源即后端）。
export function useSocket<T extends SocketEventMap = SocketEventMap>(url?: string, authOptions?: Record<string, any>) {
  let socket: Socket | null = null;
  const connected = ref(false);

  const connect = () => {
    if (socket) {
      if (socket.disconnected) socket.connect();
      return;
    }

    // ⚠ 默认值不能写死 localhost：本机当服务器、用户机用浏览器访问时，localhost 指的是**用户自己的机器**。
    // 不传 url 就用**同源**（页面由后端吐出，同源即后端）。
    socket = io(url || (typeof location !== "undefined" ? location.origin : ""), {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
      // ⚠【Phase 1c Task 11】令牌从**内存 store** 取（原来读 `localStorage.getItem("token")`）：
      //   access 已不落盘 ⇒ 读 localStorage 会拿到 `null`，socket 连接会被 `decodeSocketToken` 直接拒掉
      //   （表现为"AI 生成整条链路静默连不上"）。形状与后端一致：`Bearer <jwt>`。
      auth: { token: userStore().token || null, ...authOptions },
    });

    socket.on("connect", () => (connected.value = true));
    socket.on("disconnect", () => (connected.value = false));
    socket.on("connect_error", () => (connected.value = false));
  };

  const disconnect = () => {
    socket?.disconnect();
    connected.value = false;
  };

  const send = <E extends keyof T & string>(event: E, ...args: T[E] extends void ? [] : [T[E]]) => socket?.emit(event, ...args);
  const on = <E extends keyof T & string>(event: E, callback: T[E] extends (...args: any[]) => any ? T[E] : (data: T[E]) => void) =>
    socket?.on(event, callback as any);
  const off = <E extends keyof T & string>(event: E, callback?: T[E] extends (...args: any[]) => any ? T[E] : (data: T[E]) => void) =>
    socket?.off(event, callback as any);

  return { connected, socket: { connect, disconnect, send, on, off } };
}
