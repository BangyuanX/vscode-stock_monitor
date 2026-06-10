import * as net from 'net';
import * as tls from 'tls';
import * as dns from 'dns';
import * as vscode from 'vscode';
import * as iconv from 'iconv-lite';

// 优先 IPv4 — 家庭网络常因 IPv6 配置不佳导致超时
dns.setDefaultResultOrder('ipv4first');

/**
 * 统一 HTTP(S) 请求 — 支持先试代理、失败回退直连。
 *
 * 设计目标：
 * - 家里有代理（AtlasCore :6850）：走代理访问外部 API（Yahoo / OKX）
 * - 公司无代理：直连，不受 VSCode http.proxy 设置影响
 * - 代理配了但不可达：自动回退直连，不阻塞
 */

// ============================================================
// 类型定义
// ============================================================

export interface DirectHttpResponse {
  statusCode: number;
  /** 原始字节（用于非 UTF-8 编码响应） */
  body: Buffer;
  /** 响应头（仅 smartGet 和 smartGetWithHeaders 返回） */
  headers?: Record<string, string>;
}

export interface HttpOptions {
  port?: number;
  useTls?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 响应编码，仅 smartGetText 使用 */
  encoding?: string;
}

interface ProxyConfig {
  host: string;
  port: number;
  auth?: string; // base64 "user:pass"
}

// ============================================================
// 内部：代理 URL 解析
// ============================================================

function parseProxyUrl(url: string): ProxyConfig | null {
  try {
    // 支持格式: http://user:pass@host:port 或 http://host:port 或 host:port
    const u = new URL(url.startsWith('http') ? url : `http://${url}`);
    const host = u.hostname;
    const port = parseInt(u.port, 10) || 80;
    const auth =
      u.username
        ? Buffer.from(`${u.username}:${u.password || ''}`).toString('base64')
        : undefined;
    return { host, port, auth };
  } catch {
    return null;
  }
}

// ============================================================
// 内部：读取 VSCode 代理设置
// ============================================================

/**
 * 读取代理设置，优先级：
 *   1. VSCode 设置 http.proxy（显式用户配置）
 *   2. 环境变量（Clash 等代理工具自动设置）
 *
 * 这样用户在家用 Clash 时无需配 VSCode，在公司无代理时自动直连。
 */
function getVscodeProxy(): ProxyConfig | null {
  // Priority 1: VSCode http.proxy setting（显式配置）
  try {
    const proxyUrl = vscode.workspace.getConfiguration('http').get<string>('proxy');
    if (proxyUrl) return parseProxyUrl(proxyUrl);
  } catch {
    // VSCode API 不可用时忽略（比如测试环境）
  }

  // Priority 2: 环境变量（Clash / ClashX / 系统代理自动设置）
  const envVar =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;

  if (envVar) return parseProxyUrl(envVar);

  return null;
}

// ============================================================
// 内部：HTTP 响应解析（含 chunked transfer-encoding 解码）
// ============================================================

/**
 * 解码 HTTP 分块传输编码（Transfer-Encoding: chunked）
 */
function decodeChunkedBody(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let pos = 0;

  while (pos < body.length) {
    // 查找块大小的行尾
    let lineEnd = pos;
    while (lineEnd < body.length && body[lineEnd] !== 0x0a) lineEnd++;
    if (lineEnd >= body.length) break;

    const sizeStr = body.subarray(pos, lineEnd).toString('utf8').trim();
    pos = lineEnd + 1;

    // 末块（size = 0）
    if (sizeStr === '0') break;

    const size = parseInt(sizeStr, 16);
    if (isNaN(size) || size === 0) break;

    // 读取块数据
    const chunkEnd = Math.min(pos + size, body.length);
    chunks.push(body.subarray(pos, chunkEnd));
    pos = chunkEnd;

    // 跳过尾部 \r\n
    if (pos < body.length && body[pos] === 0x0d) pos++;
    if (pos < body.length && body[pos] === 0x0a) pos++;
  }

  return Buffer.concat(chunks);
}

function parseHttpResponse(
  raw: Buffer,
  reject: (err: Error) => void,
  resolve: (resp: DirectHttpResponse) => void,
): void {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    reject(new Error(`非HTTP响应: ${raw.toString('utf8').substring(0, 100)}`));
    return;
  }

  const headerPart = raw.subarray(0, headerEnd).toString('utf8');
  const headerLines = headerPart.split('\r\n');
  const statusLine = headerLines[0];
  const statusCode = parseInt(statusLine.split(' ')[1], 10);

  // 解析所有响应头
  const headers: Record<string, string> = {};
  let isChunked = false;
  for (let i = 1; i < headerLines.length; i++) {
    const colonIdx = headerLines[i].indexOf(':');
    if (colonIdx > 0) {
      const name = headerLines[i].substring(0, colonIdx).trim().toLowerCase();
      const value = headerLines[i].substring(colonIdx + 1).trim();
      // 同名头合并（如 Set-Cookie 可能有多个）
      if (name === 'set-cookie') {
        headers[name] = (headers[name] ? headers[name] + '\n' : '') + value;
      } else {
        headers[name] = value;
      }
    }
    const lower = headerLines[i].toLowerCase();
    if (lower.startsWith('transfer-encoding:') && lower.includes('chunked')) {
      isChunked = true;
    }
  }

  let body = raw.subarray(headerEnd + 4);
  if (isChunked) {
    body = decodeChunkedBody(body);
  }

  resolve({ statusCode, body, headers });
}

// ============================================================
// 内部：构建 HTTP 请求报文并发送
// ============================================================

function sendGetRequest(
  sock: net.Socket | tls.TLSSocket,
  method: 'DIRECT' | 'PROXY',
  hostname: string,
  path: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<DirectHttpResponse> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    let cleaned = false;

    function cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      sock.destroy();
    }

    // 构造请求行
    //   DIRECT:  GET /path HTTP/1.1
    //   PROXY (HTTP):  GET http://hostname/path HTTP/1.1
    //   PROXY (CONNECT/HTTPS): GET /path HTTP/1.1 (隧道建立后直接用相对路径)
    const isConnectTunnel = method === 'PROXY' && sock instanceof tls.TLSSocket;
    const requestPath = isConnectTunnel ? path : method === 'PROXY' ? `http://${hostname}${path}` : path;

    const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
    const request = [
      `GET ${requestPath} HTTP/1.1`,
      `Host: ${hostname}`,
      ...headerLines,
      'Connection: close',
      '',
      '',
    ].join('\r\n');

    const chunks: Buffer[] = [];
    sock.on('data', (chunk: Buffer) => chunks.push(chunk));
    sock.once('end', () => {
      cleanup();
      parseHttpResponse(Buffer.concat(chunks), reject, resolve);
    });
    sock.once('error', (e) => {
      cleanup();
      reject(new Error(`套接字错误: ${e.message}`));
    });

    sock.write(request);
  });
}

// ============================================================
// 内部：直连（原始 TCP/TLS）
// ============================================================

function directConnect(
  hostname: string,
  port: number,
  useTls: boolean,
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const netSocket = new net.Socket();
    let cleaned = false;

    function cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      netSocket.destroy();
    }

    if (!useTls) {
      netSocket.connect(port, hostname, () => {
        resolve(netSocket);
      });
    } else {
      netSocket.connect(port, hostname, () => {
        const tlsSocket = tls.connect(
          {
            socket: netSocket,
            host: hostname,
            servername: hostname,
            rejectUnauthorized: true,
          },
          () => resolve(tlsSocket),
        );
        tlsSocket.once('error', (e) => {
          cleanup();
          reject(new Error(`TLS/SSL 连接失败: ${e.message}`));
        });
      });
    }

    netSocket.once('error', (e) => {
      cleanup();
      reject(new Error(`网络连接失败: ${e.message}`));
    });
  });
}

// ============================================================
// 内部：通过 HTTP 代理连接（CONNECT 隧道 / Forward Proxy）
// ============================================================

function proxyConnect(
  proxy: ProxyConfig,
  hostname: string,
  port: number,
  useTls: boolean,
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const netSocket = new net.Socket();
    let cleaned = false;

    function cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      netSocket.destroy();
    }

    netSocket.connect(proxy.port, proxy.host, () => {
      if (!useTls) {
        // HTTP 使用 Forward Proxy — 不需要隧道，直接返回 socket
        // 调用方会用 GET http://hostname/path 格式
        resolve(netSocket);
      } else {
        // HTTPS 需要 CONNECT 隧道
        const connectHeaders = [`CONNECT ${hostname}:${port} HTTP/1.1`, `Host: ${hostname}:${port}`];
        if (proxy.auth) {
          connectHeaders.push(`Proxy-Authorization: Basic ${proxy.auth}`);
        }
        connectHeaders.push('', '');

        const connectReq = connectHeaders.join('\r\n');
        let data = '';

        const onData = (chunk: Buffer) => {
          data += chunk.toString();

          // 收到完整响应头（以 \r\n\r\n 结束）
          const headerEnd = data.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;

          netSocket.removeListener('data', onData);
          const statusLine = data.split('\r\n')[0];
          const statusCode = parseInt(statusLine.split(' ')[1], 10);

          if (statusCode !== 200) {
            cleanup();
            reject(new Error(`代理 CONNECT 返回 ${statusCode}: ${data.substring(0, 100)}`));
            return;
          }

          // CONNECT 成功后升级到 TLS
          const tlsSocket = tls.connect(
            {
              socket: netSocket,
              host: hostname,
              servername: hostname,
              rejectUnauthorized: true,
            },
            () => resolve(tlsSocket),
          );
          tlsSocket.once('error', (e) => {
            cleanup();
            reject(new Error(`TLS/SSL 连接失败 (通过代理): ${e.message}`));
          });
        };

        netSocket.on('data', onData);
        netSocket.write(connectReq);
      }
    });

    netSocket.once('error', (e) => {
      cleanup();
      reject(new Error(`代理连接失败 (${proxy.host}:${proxy.port}): ${e.message}`));
    });
  });
}

// ============================================================
// 内部：代理失败缓存（避免每次请求都重试无效代理）
// ============================================================

/** 代理重试间隔：失败后等待 N 毫秒再重试 */
const PROXY_RETRY_MS = 120_000; // 2 分钟

let proxyLastFailTime = 0;
let proxyHostPort = '';

function shouldSkipProxy(proxy: ProxyConfig): boolean {
  // 如果代理地址变了（用户改了设置），立即清除缓存
  const key = `${proxy.host}:${proxy.port}`;
  if (key !== proxyHostPort) {
    proxyHostPort = key;
    proxyLastFailTime = 0;
    return false;
  }
  // 在冷却期内跳过代理尝试
  if (proxyLastFailTime === 0) return false;
  return Date.now() - proxyLastFailTime < PROXY_RETRY_MS;
}

function markProxyFailed(proxy: ProxyConfig): void {
  proxyHostPort = `${proxy.host}:${proxy.port}`;
  proxyLastFailTime = Date.now();
}

function markProxyOk(): void {
  proxyLastFailTime = 0;
}

// ============================================================
// 统一入口函数
// ============================================================

async function smartGetInternal(
  hostname: string,
  path: string,
  options?: HttpOptions,
): Promise<DirectHttpResponse> {
  const useTls = options?.useTls ?? (hostname !== 'qt.gtimg.cn');
  const port = options?.port ?? (useTls ? 443 : 80);
  const timeoutMs = options?.timeoutMs ?? 10000;
  const headers: Record<string, string> = { ...options?.headers };

  const MAX_REDIRECTS = 5;
  let currentHost = hostname;
  let currentPath = path;
  let currentTls = useTls;
  let currentPort = port;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await httpFetchOne(currentHost, currentPath, currentTls, currentPort, timeoutMs, headers);

    // 跟随 3xx 重定向（Yahoo 可能因地区/语言重定向）
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers?.location) {
      const location = response.headers.location;
      const parsed = new URL(location, `http${currentTls ? 's' : ''}://${currentHost}${currentPath}`);
      currentHost = parsed.hostname;
      currentPath = parsed.pathname + parsed.search;
      currentTls = parsed.protocol === 'https:';
      currentPort = currentTls ? 443 : 80;
      console.log(`[StockBar] 跟随重定向 (${response.statusCode}): ${location}`);
      continue;
    }

    return response;
  }

  throw new Error(`[StockBar] 重定向次数超过 ${MAX_REDIRECTS} 次`);
}

/**
 * 执行单次 HTTP 请求（代理优先，失败回退直连）
 */
async function httpFetchOne(
  hostname: string,
  path: string,
  useTls: boolean,
  port: number,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<DirectHttpResponse> {
  const proxy = getVscodeProxy();

  async function attemptDirect(): Promise<DirectHttpResponse> {
    const sock = await directConnect(hostname, port, useTls);
    return await sendGetRequest(sock, 'DIRECT', hostname, path, headers, timeoutMs);
  }

  async function attemptProxy(): Promise<DirectHttpResponse> {
    const sock = await proxyConnect(proxy!, hostname, port, useTls);
    return await sendGetRequest(sock, 'PROXY', hostname, path, headers, timeoutMs);
  }

  if (!proxy) {
    return attemptDirect();
  }

  if (shouldSkipProxy(proxy)) {
    return attemptDirect();
  }

  return attemptProxy()
    .then((result) => {
      markProxyOk();
      return result;
    })
    .catch((err) => {
      markProxyFailed(proxy);
      console.warn(
        `[StockBar] 代理 ${proxy.host}:${proxy.port} 不可用 (${err.message}), ` +
          `回退到直连，${PROXY_RETRY_MS / 60_000} 分钟内不再尝试代理`,
      );
      return attemptDirect();
    });
}

// ============================================================
// 对外导出
// ============================================================

/**
 * 智能 HTTP(S) GET — 先试代理，失败回退直连
 */
export function smartGet(
  hostname: string,
  path: string,
  options?: HttpOptions,
): Promise<DirectHttpResponse> {
  return smartGetInternal(hostname, path, options);
}

/**
 * 智能 HTTP(S) GET 并返回文本
 */
export async function smartGetText(
  hostname: string,
  path: string,
  options?: HttpOptions & { encoding?: string },
): Promise<{ statusCode: number; text: string }> {
  const resp = await smartGetInternal(hostname, path, options);
  const encoding = options?.encoding ?? 'utf-8';
  const text =
    encoding === 'utf-8'
      ? resp.body.toString('utf8')
      : iconv.decode(resp.body, encoding);
  return { statusCode: resp.statusCode, text };
}

/**
 * 智能 HTTP(S) GET 并返回 JSON
 */
export async function smartGetJson<T = any>(
  hostname: string,
  path: string,
  options?: HttpOptions,
): Promise<{ statusCode: number; data: T }> {
  const resp = await smartGetInternal(hostname, path, options);
  const text = resp.body.toString('utf8').trim();

  if (!text.startsWith('{') && !text.startsWith('[')) {
    throw new Error(`非JSON响应: ${text.substring(0, 100)}`);
  }

  return { statusCode: resp.statusCode, data: JSON.parse(text) };
}

// ============================================================
// 向下兼容：保留直连专用导出，供需要强制直连的场景使用
// ============================================================

/**
 * 强制直连（绕过代理）
 */
export async function directGet(
  hostname: string,
  path: string,
  options?: HttpOptions,
): Promise<DirectHttpResponse> {
  const useTls = options?.useTls ?? (hostname !== 'qt.gtimg.cn');
  const port = options?.port ?? (useTls ? 443 : 80);
  const timeoutMs = options?.timeoutMs ?? 10000;
  const headers: Record<string, string> = { ...options?.headers };

  const sock = await directConnect(hostname, port, useTls);
  return await sendGetRequest(sock, 'DIRECT', hostname, path, headers, timeoutMs);
}

export async function directGetText(
  hostname: string,
  path: string,
  options?: HttpOptions & { encoding?: string },
): Promise<{ statusCode: number; text: string }> {
  const resp = await directGet(hostname, path, options);
  const encoding = options?.encoding ?? 'utf-8';
  const text =
    encoding === 'utf-8'
      ? resp.body.toString('utf8')
      : iconv.decode(resp.body, encoding);
  return { statusCode: resp.statusCode, text };
}

export async function directGetJson<T = any>(
  hostname: string,
  path: string,
  options?: HttpOptions,
): Promise<{ statusCode: number; data: T }> {
  const resp = await directGet(hostname, path, options);
  const text = resp.body.toString('utf8').trim();

  if (!text.startsWith('{') && !text.startsWith('[')) {
    throw new Error(`非JSON响应: ${text.substring(0, 100)}`);
  }

  return { statusCode: resp.statusCode, data: JSON.parse(text) };
}
