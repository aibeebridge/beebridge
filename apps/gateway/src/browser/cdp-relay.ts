/**
 * Loopback WebSocket relay: gateway (Node) <-> Chrome extension (chrome.debugger).
 * Extension forwards CDP method calls and streams CDP events back.
 */
import { WebSocketServer, WebSocket } from "ws";

export type CdpEventHandler = (method: string, params: unknown) => void;

export class CdpRelayServer {
  private wss: WebSocketServer | null = null;
  private extSocket: WebSocket | null = null;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextId = 1;
  private readonly token: string;
  private attachedTabId: number | null = null;
  private eventHandlers: CdpEventHandler[] = [];
  private loadResolvers: Array<{ resolve: () => void }> = [];

  constructor(token: string) {
    this.token = token;
  }

  start(port: number): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({ host: "127.0.0.1", port });
    this.wss.on("connection", (ws, req) => {
      try {
        const host = req.headers.host ?? "127.0.0.1";
        const url = new URL(req.url ?? "/", `http://${host}`);
        const tok = url.searchParams.get("token");
        if (tok !== this.token) {
          ws.close(4001, "unauthorized");
          return;
        }
      } catch {
        ws.close(4001, "bad request");
        return;
      }

      if (this.extSocket && this.extSocket.readyState === WebSocket.OPEN) {
        this.extSocket.close(1000, "replaced by new connection");
      }
      this.extSocket = ws;
      ws.on("message", (data) => {
        try {
          this.handleExtensionMessage(data.toString());
        } catch {
          /* ignore */
        }
      });
      ws.on("close", () => {
        if (this.extSocket === ws) {
          this.extSocket = null;
          this.attachedTabId = null;
        }
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("CDP relay disconnected"));
        }
        this.pending.clear();
      });
    });
  }

  stop(): void {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.extSocket = null;
    this.attachedTabId = null;
  }

  isExtensionConnected(): boolean {
    return this.extSocket !== null && this.extSocket.readyState === 1;
  }

  getAttachedTabId(): number | null {
    return this.attachedTabId;
  }

  /** Extension connected to relay WS and debugger attached to a tab. */
  isReady(): boolean {
    return this.isExtensionConnected() && this.attachedTabId != null;
  }

  onCdpEvent(handler: CdpEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((fn) => fn !== handler);
    };
  }

  private emitEvent(method: string, params: unknown): void {
    if (method === "Page.loadEventFired") {
      for (const r of this.loadResolvers) {
        r.resolve();
      }
      this.loadResolvers = [];
    }
    for (const h of this.eventHandlers) {
      try {
        h(method, params);
      } catch {
        /* ignore */
      }
    }
  }

  /** Wait for next Page.loadEventFired (after Page.navigate). */
  waitForLoadEvent(timeoutMs = 45_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = this.loadResolvers.findIndex((x) => x.resolve === done);
        if (idx >= 0) this.loadResolvers.splice(idx, 1);
        reject(new Error("waitForLoadEvent timeout"));
      }, timeoutMs);
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      this.loadResolvers.push({ resolve: done });
    });
  }

  private handleExtensionMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const t = String(msg.type ?? "");
    if (t === "cdp.attached") {
      this.attachedTabId = typeof msg.tabId === "number" ? msg.tabId : null;
      return;
    }
    if (t === "cdp.detached") {
      this.attachedTabId = null;
      return;
    }
    if (t === "cdp.result") {
      const id = Number(msg.id);
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (typeof msg.error === "string" && msg.error.length > 0) {
          p.reject(new Error(msg.error));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }
    if (t === "cdp.event") {
      this.emitEvent(String(msg.method ?? ""), msg.params);
    }
  }

  /**
   * Send a CDP method to the attached tab via the extension.
   * The extension must call chrome.debugger.sendCommand for the active debuggee.
   */
  sendCommand(method: string, params?: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
    if (!this.extSocket || this.extSocket.readyState !== 1) {
      return Promise.reject(new Error("CDP relay not connected"));
    }
    if (this.attachedTabId == null) {
      return Promise.reject(new Error("No debugger-attached tab — click the beebridge extension icon on a tab to attach."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP command timeout: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.extSocket!.send(
        JSON.stringify({ type: "cdp.send", id, method, params: params ?? {} }),
      );
    });
  }
}
