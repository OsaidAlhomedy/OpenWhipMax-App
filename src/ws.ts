// WebSocket connection manager for openwhipmax-phone.
// Handles connect, reconnect with exponential backoff, message queuing,
// ping/pong keepalive, and protocol framing.

import { Crack } from './detector';

// ─── Message types (wire format must match openwhipmax-agent exactly) ────────

interface HelloMsg    { type: 'hello'; device: string; protocolVersion: 1 }
interface CrackMsg    { type: 'crack'; ts: number; peakJerk: number; peakGyro: number; confidence: number; durationMs: number }
interface PingMsg     { type: 'ping'; ts: number }
interface WelcomeMsg  { type: 'welcome'; sessionId: string; config: { cooldownMs: number } }
interface PongMsg     { type: 'pong'; ts: number }
interface StruckMsg   { type: 'struck'; ts: number; messageIndex: number }

type IncomingMsg = WelcomeMsg | PongMsg | StruckMsg;

// ─── Public types ─────────────────────────────────────────────────────────────

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface WSConfig {
  host: string;
  port: number;
  token: string;
  deviceName: string;
}

export type WSEvent =
  | { kind: 'state'; state: ConnectionState }
  | { kind: 'struck'; ts: number; messageIndex: number }
  | { kind: 'cooldown'; ms: number };

// ─── Connection manager ───────────────────────────────────────────────────────

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const PING_INTERVAL_MS = 2000;
const QUEUE_MAX = 20;

export class WhipWSClient {
  private config: WSConfig | null = null;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private backoffMs = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private queue: CrackMsg[] = [];   // cracks buffered while offline
  private active = false;           // false = caller wants disconnected
  private listeners: ((event: WSEvent) => void)[] = [];
  private cooldownMs = 0;           // from server welcome

  on(listener: (event: WSEvent) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  connect(cfg: WSConfig): void {
    this.config = cfg;
    this.active = true;
    this.backoffMs = BACKOFF_MIN_MS;
    this.attempt();
  }

  disconnect(): void {
    this.active = false;
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
  }

  sendCrack(crack: Crack): void {
    const msg: CrackMsg = {
      type: 'crack',
      ts: crack.ts,
      peakJerk: crack.peakJerk,
      peakGyro: crack.peakGyro,
      confidence: crack.confidence,
      durationMs: crack.durationMs,
    };

    if (this.state === 'connected' && this.ws) {
      this.flushQueue();
      this.send(msg);
    } else {
      if (this.queue.length < QUEUE_MAX) {
        this.queue.push(msg);
      }
    }
  }

  get connectionState(): ConnectionState { return this.state; }

  // ── Internals ────────────────────────────────────────────────────────────

  private attempt(): void {
    if (!this.active || !this.config) return;
    this.setState('connecting');
    const { host, port, token } = this.config;
    const url = `ws://${host}:${port}/whip?token=${encodeURIComponent(token)}`;

    console.log('[WS] attempt url:', url);

    const ws = new WebSocket(url);

    this.ws = ws;

    ws.onopen = () => {
      console.log('[WS] onopen — connected');
      this.backoffMs = BACKOFF_MIN_MS;
      this.setState('connected');
      this.send<HelloMsg>({ type: 'hello', device: this.config!.deviceName, protocolVersion: 1 });
      this.startPing();
      this.flushQueue();
    };

    ws.onmessage = (evt) => {
      try {
        const msg: IncomingMsg = JSON.parse(evt.data as string);
        this.handleIncoming(msg);
      } catch { /* ignore malformed */ }
    };

    ws.onerror = (evt) => {
      console.log('[WS] onerror:', JSON.stringify(evt));
    };

    ws.onclose = (evt) => {
      console.log('[WS] onclose code:', evt.code, 'reason:', evt.reason, 'wasClean:', evt.wasClean);
      this.ws = null;
      this.stopPing();
      if (this.active) {
        this.setState('disconnected');
        this.scheduleReconnect();
      }
    };
  }

  private handleIncoming(msg: IncomingMsg): void {
    if (msg.type === 'welcome') {
      if (msg.config?.cooldownMs) {
        this.cooldownMs = msg.config.cooldownMs;
        this.emit({ kind: 'cooldown', ms: this.cooldownMs });
      }
    } else if (msg.type === 'struck') {
      this.emit({ kind: 'struck', ts: msg.ts, messageIndex: msg.messageIndex });
    }
    // pong is silently consumed (we just track that the connection is alive)
  }

  private send<T>(msg: T): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private flushQueue(): void {
    while (this.queue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.send(this.queue.shift()!);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send<PingMsg>({ type: 'ping', ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attempt();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(s: ConnectionState): void {
    if (this.state !== s) {
      this.state = s;
      this.emit({ kind: 'state', state: s });
    }
  }

  private emit(event: WSEvent): void {
    this.listeners.forEach(l => l(event));
  }
}
