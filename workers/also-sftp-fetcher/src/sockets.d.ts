/**
 * C.3.4.4 — tipos mínimos de `cloudflare:sockets` (só o que o fetcher usa).
 *
 * Evita a dependência @cloudflare/workers-types: o worker continua com zero
 * dependências npm e este .d.ts é a única peça de tipos do runtime Edge.
 */
declare module "cloudflare:sockets" {
  export interface SocketAddress {
    hostname: string;
    port: number;
  }
  export interface Socket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    closed: Promise<void>;
    close(): Promise<void>;
  }
  export function connect(address: SocketAddress): Socket;
}
