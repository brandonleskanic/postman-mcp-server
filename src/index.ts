#!/usr/bin/env node

import dotenv from 'dotenv';
import express from 'express';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  ErrorCode,
  isInitializeRequest,
  IsomorphicHeaders,
  McpError,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import packageJson from '../package.json' with { type: 'json' };
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Server as HTTPServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { enabledResources } from './enabledResources.js';
import { PostmanAPIClient } from './clients/postman.js';

const SUPPORTED_REGIONS = {
  us: 'https://api.postman.com',
  eu: 'https://api.eu.postman.com',
} as const;

function isValidRegion(region: string): region is keyof typeof SUPPORTED_REGIONS {
  return region in SUPPORTED_REGIONS;
}

function setRegionEnvironment(region: string): void {
  if (!isValidRegion(region)) {
    throw new Error(`Invalid region: ${region}. Supported regions: us, eu`);
  }
  process.env.POSTMAN_API_BASE_URL = SUPPORTED_REGIONS[region];
}

function getArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function getListArg(args: string[], flag: string): string[] | undefined {
  const value = getArgValue(args, flag);
  if (!value) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function extractApiKeyFromHeaders(headers?: IsomorphicHeaders): string | undefined {
  if (!headers) return undefined;

  const normalized = new Map<string, string>();

  for (const [key, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (typeof value !== 'string') continue;
    normalized.set(key.toLowerCase(), value.trim());
  }

  const directKeys = ['x-postman-api-key', 'postman-api-key', 'postman_api_key', 'x-api-key'];
  for (const key of directKeys) {
    const candidate = normalized.get(key);
    if (candidate) return candidate;
  }

  const authHeader = normalized.get('authorization');
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  return undefined;
}

function getSessionIdFromExtra(extra: any): string | undefined {
  if (!extra) return undefined;
  if (typeof extra.sessionId === 'string') return extra.sessionId;

  const headers = extra.requestInfo?.headers as IsomorphicHeaders | undefined;
  if (!headers) return undefined;

  const rawSessionId = headers['mcp-session-id'];
  if (!rawSessionId) return undefined;

  return Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
}

function normalizeHttpPath(path: string): string {
  if (!path.startsWith('/')) {
    return `/${path}`;
  }
  return path;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function log(level: LogLevel, message: string, context?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const suffix = context ? ` ${JSON.stringify(context)}` : '';
  console.error(`[${timestamp}] [${level.toUpperCase()}] ${message}${suffix}`);
}

function sendClientLog(server: McpServer, level: LogLevel, data: string) {
  try {
    (server as any).sendLoggingMessage?.({ level, data });
  } catch {
    // ignore
  }
}

function logBoth(
  server: McpServer | null | undefined,
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>
) {
  log(level, message, context);
  if (server) sendClientLog(server, level, message);
}

type FullResourceMethod = (typeof enabledResources.full)[number];
type MinimalResourceMethod = (typeof enabledResources.minimal)[number];
type EnabledResourceMethod = FullResourceMethod;

interface ToolModule {
  method: EnabledResourceMethod;
  description: string;
  parameters: z.ZodObject<any>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  handler: (
    args: any,
    extra: {
      client: PostmanAPIClient;
      headers?: IsomorphicHeaders;
    }
  ) => Promise<CallToolResult>;
}

async function loadAllTools(): Promise<ToolModule[]> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const toolsDir = join(__dirname, 'tools');

  try {
    log('info', 'Loading tools from directory', { toolsDir });
    const files = await readdir(toolsDir);
    const toolFiles = files.filter((file) => file.endsWith('.js'));
    log('debug', 'Discovered tool files', { count: toolFiles.length });

    const tools: ToolModule[] = [];

    for (const file of toolFiles) {
      try {
        const toolPath = join(toolsDir, file);
        // If the OS is windows, prepend 'file://' to the path
        const isWindows = process.platform === 'win32';
        const toolModule = await import(isWindows ? `file://${toolPath}` : toolPath);

        if (
          toolModule.method &&
          toolModule.description &&
          toolModule.parameters &&
          toolModule.handler
        ) {
          tools.push(toolModule as ToolModule);
          log('info', 'Loaded tool', { method: toolModule.method, file });
        } else {
          log('warn', 'Tool module missing required exports; skipping', { file });
        }
      } catch (error: any) {
        log('error', 'Failed to load tool module', {
          file,
          error: String(error?.message || error),
        });
      }
    }

    log('info', 'Tool loading completed', { totalLoaded: tools.length });
    return tools;
  } catch (error: any) {
    log('error', 'Failed to read tools directory', {
      toolsDir,
      error: String(error?.message || error),
    });
    return [];
  }
}

dotenv.config();

const SERVER_NAME = packageJson.name;
const APP_VERSION = packageJson.version;
export const USER_AGENT = `${SERVER_NAME}/${APP_VERSION}`;

const STDIO_SESSION_ID = 'stdio';
const clientInfosBySession = new Map<
  string,
  InitializeRequest['params']['clientInfo'] | undefined
>();

async function run() {
  const args = process.argv.slice(2);
  const mode = args.includes('--http') ? 'http' : 'stdio';
  const useFull = args.includes('--full');

  const region = getArgValue(args, '--region') ?? process.env.POSTMAN_API_REGION;
  if (region) {
    if (isValidRegion(region)) {
      setRegionEnvironment(region);
      log('info', `Using region: ${region}`, {
        region,
        baseUrl: process.env.POSTMAN_API_BASE_URL,
      });
    } else {
      log('error', `Invalid region: ${region}`);
      console.error(`Supported regions: ${Object.keys(SUPPORTED_REGIONS).join(', ')}`);
      process.exit(1);
    }
  }

  // For STDIO mode, validate API key is available in environment
  const apiKey = process.env.POSTMAN_API_KEY;
  if (!apiKey && mode === 'stdio') {
    log('error', 'POSTMAN_API_KEY environment variable is required for STDIO mode');
    process.exit(1);
  }

  if (!apiKey && mode === 'http') {
    log('warn', 'POSTMAN_API_KEY not set; HTTP requests must include an API key header');
  }

  const allGeneratedTools = await loadAllTools();
  log('info', 'Server initialization starting', {
    serverName: SERVER_NAME,
    version: APP_VERSION,
    toolCount: allGeneratedTools.length,
  });

  const fullTools = allGeneratedTools.filter((t) => enabledResources.full.includes(t.method));
  const minimalTools = allGeneratedTools.filter((t) =>
    enabledResources.minimal.includes(t.method as MinimalResourceMethod)
  );
  const tools = useFull ? fullTools : minimalTools;

  const baseUrl = process.env.POSTMAN_API_BASE_URL || 'https://api.postman.com';
  const clientCache = new Map<string, PostmanAPIClient>();

  const getClientForApiKey = (key: string): PostmanAPIClient => {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'POSTMAN_API_KEY is required via environment variable or request header'
      );
    }

    const cached = clientCache.get(trimmedKey);
    if (cached) return cached;

    const newClient = new PostmanAPIClient(trimmedKey, baseUrl);
    clientCache.set(trimmedKey, newClient);
    return newClient;
  };

  const defaultClient = apiKey ? getClientForApiKey(apiKey) : undefined;

  // Create McpServer instance
  const server = new McpServer({ name: SERVER_NAME, version: APP_VERSION });
  let httpServer: HTTPServer | undefined;

  // Surface MCP server errors to stderr and notify client if possible
  (server as any).onerror = (error: unknown) => {
    const msg = String((error as any)?.message || error);
    logBoth(server, 'error', `MCP server error: ${msg}`, { error: msg });
  };

  process.on('SIGINT', async () => {
    logBoth(server, 'warn', 'SIGINT received; shutting down');

    try {
      await server.close();
    } catch (error: any) {
      log('error', 'Error while closing MCP server', {
        error: String(error?.message || error),
      });
    }

    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer?.close(() => resolve());
      });
    }

    process.exit(0);
  });

  log('info', 'Registering tools with McpServer');

  // Register all tools using the McpServer .tool() method
  for (const tool of tools) {
    server.tool(
      tool.method,
      tool.description,
      tool.parameters.shape,
      tool.annotations || {},
      async (args, extra) => {
        const toolName = tool.method;
        // Keep start event on stderr only to reduce client noise
        log('info', `Tool invocation started: ${toolName}`, { toolName });

        try {
          const start = Date.now();

          const incomingHeaders = extra?.requestInfo?.headers;
          const headerApiKey = extractApiKeyFromHeaders(incomingHeaders);
          const effectiveClient = headerApiKey ? getClientForApiKey(headerApiKey) : defaultClient;

          if (!effectiveClient) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'POSTMAN_API_KEY must be provided via environment variable or x-postman-api-key header.'
            );
          }

          const sessionId = getSessionIdFromExtra(extra) ?? STDIO_SESSION_ID;
          const sessionClientInfo =
            clientInfosBySession.get(sessionId) ?? clientInfosBySession.get(STDIO_SESSION_ID);

          const forwardedHeaders: IsomorphicHeaders = {
            ...(incomingHeaders ?? {}),
          };

          if (sessionClientInfo?.name) {
            forwardedHeaders['user-agent'] = sessionClientInfo.name;
          }

          const result = await tool.handler(args, {
            client: effectiveClient,
            headers: forwardedHeaders,
          });

          const durationMs = Date.now() - start;
          // Completion: stderr only to avoid spamming client logs
          log('info', `Tool invocation completed: ${toolName} (${durationMs}ms)`, {
            toolName,
            durationMs,
          });
          return result;
        } catch (error: any) {
          const errMsg = String(error?.message || error);
          // Failures: notify both server stderr and client
          logBoth(server, 'error', `Tool invocation failed: ${toolName}: ${errMsg}`, { toolName });
          if (error instanceof McpError) throw error;
          throw new McpError(ErrorCode.InternalError, `API error: ${error.message}`);
        }
      }
    );
  }

  if (mode === 'http') {
    const portArg = getArgValue(args, '--port') ?? process.env.PORT;
    const host = getArgValue(args, '--host') ?? process.env.HOST ?? '0.0.0.0';
    const ssePath = normalizeHttpPath(
      getArgValue(args, '--sse-path') ?? process.env.MCP_SSE_PATH ?? '/sse'
    );
    const messagesPath = normalizeHttpPath(
      getArgValue(args, '--messages-path') ?? process.env.MCP_MESSAGES_PATH ?? '/messages'
    );

    const allowedHostsEnv = process.env.MCP_ALLOWED_HOSTS;
    const allowedOriginsEnv = process.env.MCP_ALLOWED_ORIGINS;
    const allowedHosts =
      getListArg(args, '--allowed-hosts') ??
      (allowedHostsEnv
        ? allowedHostsEnv
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined);
    const allowedOrigins =
      getListArg(args, '--allowed-origins') ??
      (allowedOriginsEnv
        ? allowedOriginsEnv
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined);

    const enableDnsProtection =
      args.includes('--enable-dns-protection') || process.env.MCP_ENABLE_DNS_PROTECTION === 'true';

    const sseOptions = enableDnsProtection
      ? {
          enableDnsRebindingProtection: true,
          allowedHosts,
          allowedOrigins,
        }
      : undefined;

    const defaultPort = 3000;
    const port = portArg ? Number.parseInt(portArg, 10) : defaultPort;
    if (Number.isNaN(port)) {
      log('error', `Invalid port value: ${portArg}`);
      process.exit(1);
    }

    const app = express();
    app.use(express.json({ limit: '4mb' }));

    app.get('/healthz', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        server: SERVER_NAME,
        version: APP_VERSION,
        tools: useFull ? 'full' : 'minimal',
        transport: 'sse',
      });
    });

    const sseTransports = new Map<string, SSEServerTransport>();

    app.get(ssePath, async (req: Request, res: Response) => {
      let sessionId: string | undefined;
      try {
        const transport = new SSEServerTransport(messagesPath, res, sseOptions);
        sessionId = transport.sessionId;
        const activeSessionId = sessionId;

        sseTransports.set(activeSessionId, transport);

        transport.onmessage = (message) => {
          if (isInitializeRequest(message)) {
            clientInfosBySession.set(activeSessionId, message.params.clientInfo);
            log('debug', '📥 Received MCP initialize request', {
              sessionId: activeSessionId,
              clientInfo: message.params.clientInfo,
            });
          }
        };

        transport.onclose = () => {
          sseTransports.delete(activeSessionId);
          clientInfosBySession.delete(activeSessionId);
          log('info', 'SSE session closed', { sessionId: activeSessionId });
        };

        transport.onerror = (error: unknown) => {
          log('error', 'SSE transport error', {
            sessionId: activeSessionId,
            error: String((error as any)?.message || error),
          });
        };

        await server.connect(transport);
      } catch (error: any) {
        log('error', 'Failed to establish SSE connection', {
          error: String(error?.message || error),
        });
        if (sessionId) {
          sseTransports.delete(sessionId);
          clientInfosBySession.delete(sessionId);
        }
        if (!res.headersSent) {
          res.status(500).send('Failed to establish SSE connection');
        }
      }
    });

    app.post(messagesPath, async (req: Request, res: Response) => {
      const rawSessionId = req.query.sessionId;
      const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

      if (!sessionId || typeof sessionId !== 'string') {
        res.status(400).json({ error: 'Missing sessionId query parameter' });
        return;
      }

      const transport = sseTransports.get(sessionId);
      if (!transport) {
        res.status(404).json({ error: `Unknown sessionId: ${sessionId}` });
        return;
      }

      try {
        await transport.handlePostMessage(req, res, req.body);
      } catch (error: any) {
        log('error', 'Failed to handle SSE message', {
          sessionId,
          error: String(error?.message || error),
        });
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to handle message' });
        }
      }
    });

    httpServer = app.listen(port, host, () => {
      log(
        'info',
        `HTTP SSE transport ready at http://${host}:${port}${ssePath} (${useFull ? 'full' : 'minimal'})`,
        {
          host,
          port,
          ssePath,
          messagesPath,
          dnsProtection: enableDnsProtection,
        }
      );
    });

    httpServer.on('error', (error: Error) => {
      log('error', 'HTTP server error', {
        error: String(error.message || error),
      });
    });

    return;
  }

  log('info', 'Starting stdio transport');
  const transport = new StdioServerTransport();
  transport.onmessage = (message) => {
    if (isInitializeRequest(message)) {
      clientInfosBySession.set(STDIO_SESSION_ID, message.params.clientInfo);
      log('debug', '📥 Received MCP initialize request', {
        sessionId: STDIO_SESSION_ID,
        clientInfo: message.params.clientInfo,
      });
    }
  };
  await server.connect(transport);
  logBoth(
    server,
    'info',
    `Server connected and ready: ${SERVER_NAME}@${APP_VERSION} with ${tools.length} tools (${useFull ? 'full' : 'minimal'})`
  );
}

run().catch((error: unknown) => {
  log('error', 'Unhandled error during server execution', {
    error: String((error as any)?.message || error),
  });
  process.exit(1);
});
