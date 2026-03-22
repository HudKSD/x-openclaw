import { randomUUID } from "node:crypto";
import process from "node:process";
import { GatewayClient } from "../../src/gateway/client.js";
import { PROTOCOL_VERSION } from "../../src/gateway/protocol/index.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseScopes(raw: string | undefined): string[] {
  if (!raw) {
    return ["operator.admin"];
  }
  const scopes = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : ["operator.admin"];
}

function bridgeConfig() {
  return {
    url: readEnv("OPENCLAW_UI_GATEWAY_URL") ?? "ws://127.0.0.1:18789",
    token: readEnv("OPENCLAW_UI_GATEWAY_TOKEN"),
    password: readEnv("OPENCLAW_UI_GATEWAY_PASSWORD"),
    tlsFingerprint: readEnv("OPENCLAW_UI_GATEWAY_TLS_FINGERPRINT"),
    scopes: parseScopes(readEnv("OPENCLAW_UI_GATEWAY_SCOPES")),
  };
}

function emitJson(payload: unknown) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function withClient<T>(run: (client: GatewayClient) => Promise<T>): Promise<T> {
  const config = bridgeConfig();
  const deviceIdentity = loadOrCreateDeviceIdentity();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
      client.stop();
    };

    const client = new GatewayClient({
      url: config.url,
      token: config.token,
      password: config.password,
      tlsFingerprint: config.tlsFingerprint,
      clientName: "gateway-client",
      clientDisplayName: "Flask Custom UI Bridge",
      clientVersion: "dev",
      mode: "backend",
      role: "operator",
      scopes: config.scopes,
      deviceIdentity,
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      onHelloOk: async () => {
        try {
          const result = await run(client);
          finish(() => resolve(result));
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      },
      onConnectError: (error) => finish(() => reject(error)),
      onClose: (code, reason) => {
        if (!settled) {
          finish(() => reject(new Error(`gateway closed (${code}): ${reason}`)));
        }
      },
    });

    client.start();
  });
}

async function callMethod(method: string, params: unknown): Promise<void> {
  const result = await withClient(async (client) => await client.request(method, params));
  emitJson(result);
}

async function streamChat(params: {
  sessionKey: string;
  message: string;
  thinking?: string;
}): Promise<void> {
  const config = bridgeConfig();
  const deviceIdentity = loadOrCreateDeviceIdentity();

  await new Promise<void>((resolve, reject) => {
    let currentRunId: string | undefined;
    let done = false;
    const client = new GatewayClient({
      url: config.url,
      token: config.token,
      password: config.password,
      tlsFingerprint: config.tlsFingerprint,
      clientName: "gateway-client",
      clientDisplayName: "Flask Custom UI Bridge",
      clientVersion: "dev",
      mode: "backend",
      role: "operator",
      scopes: config.scopes,
      deviceIdentity,
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      onEvent: (event) => {
        if (event.event !== "chat") {
          return;
        }
        const payload = event.payload as Record<string, unknown> | undefined;
        if (!payload || payload.sessionKey !== params.sessionKey) {
          return;
        }
        if (currentRunId && payload.runId !== currentRunId) {
          return;
        }
        emitJson({ type: "chat", ...payload });
        const state = payload.state;
        if (state === "final" || state === "error" || state === "aborted") {
          done = true;
          client.stop();
          resolve();
        }
      },
      onHelloOk: async () => {
        try {
          const ack = (await client.request("chat.send", {
            sessionKey: params.sessionKey,
            message: params.message,
            thinking: params.thinking,
            idempotencyKey: randomUUID(),
          }));
          currentRunId = ack.runId;
          emitJson({ type: "ack", runId: currentRunId });
        } catch (error) {
          client.stop();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      onConnectError: (error) => {
        if (!done) {
          reject(error);
        }
      },
      onClose: (code, reason) => {
        if (!done) {
          reject(new Error(`gateway closed (${code}): ${reason}`));
        }
      },
    });

    client.start();
  });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "call") {
    const method = rest[0];
    if (!method) {
      fail("usage: gateway_bridge.ts call <method> [jsonParams]");
    }
    const params = rest[1] ? JSON.parse(rest[1]) : {};
    await callMethod(method, params);
    return;
  }

  if (command === "stream-chat") {
    if (!rest[0]) {
      fail("usage: gateway_bridge.ts stream-chat <jsonParams>");
    }
    const payload = JSON.parse(rest[0]);
    await streamChat(payload);
    return;
  }

  fail("unsupported command");
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
