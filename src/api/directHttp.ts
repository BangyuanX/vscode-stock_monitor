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
  /**
   * 预解析 DNS 到 IP 后连接（代替 `net.Socket.connect` 内部 DNS 解析）
   *
   * 部分网络环境（如国内运营商 DNS / GFW）会对 hostname 层面的 TCP 连接进行
   * 干扰导致超时。启用此选项后，先通过 `dns.resolve4()` 获取 IP，再连接 IP，
   * Host 头和 TLS SNI 仍使用原始 hostname。
   *
   * 仅推荐在明确遇到 hostname 连接超时问题的数据源使用。
   */
  resolveDns?: boolean;
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

/**
 * 通过已建立的 socket 发送 HTTP GET 请求并解析响应。
 *
 * 与 Leek Fund 的 axios/http 模块一致，在 data 事件中增量解析 HTTP 响应，
 * 根据 Content-Length 或 Transfer-Encoding: chunked 判断响应是否完整，
 * 不依赖 socket end 事件（避免 keep-alive 连接永不触发 end）。
 */
function sendGetRequest(
  sock: net.Socket | tls.TLSSocket,
  method: 'DIRECT' | 'PROXY',
  hostname: string,
  path: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<DirectHttpResponse> {
  return new Promise((resolve, reject) => {
    let cleaned = false;
    let resolved = false;
    let accumulated = Buffer.alloc(0);
    let headerEnd = -1;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    function cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      sock.destroy();
    }

    function tryComplete(): void {
      if (resolved || cleaned) return;
      if (headerEnd < 0) return; // 头还没收完

      const body = accumulated.subarray(headerEnd + 4);
      if (body.length === 0) return; // 没有 body 数据

      resolved = true;
      cleanup();
      parseHttpResponse(accumulated, () => {/* ignore late errors */}, resolve);
    }

    // 构造请求行
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

    sock.on('data', (chunk: Buffer) => {
      if (resolved || cleaned) return;
      accumulated = Buffer.concat([accumulated, chunk]);

      // 还没有找到头尾，找找看
      if (headerEnd < 0) {
        headerEnd = accumulated.indexOf('\r\n\r\n');
      }

      if (headerEnd >= 0) {
        // 解析头找 Content-Length 或 Transfer-Encoding
        if (!(accumulated as any)._headersParsed) {
          (accumulated as any)._headersParsed = true;
          const headerPart = accumulated.subarray(0, headerEnd).toString('utf8');
          const headerLines_ = headerPart.split('\r\n');
          let contentLength = -1;
          let isChunked = false;
          for (let i = 1; i < headerLines_.length; i++) {
            const lower = headerLines_[i].toLowerCase();
            if (lower.startsWith('content-length:')) {
              contentLength = parseInt(headerLines_[i].split(':')[1].trim(), 10);
            }
            if (lower.startsWith('transfer-encoding:') && lower.includes('chunked')) {
              isChunked = true;
            }
          }

          const bodyOffset = headerEnd + 4;
          const body = accumulated.subarray(bodyOffset);

          if (isChunked) {
            // chunked：检查是否收到结束块 0\r\n\r\n
            if (body.length >= 5 && body.subarray(body.length - 5).toString() === '0\r\n\r\n') {
              resolved = true;
              cleanup();
              parseHttpResponse(accumulated, () => {}, resolve);
              return;
            }
          } else if (contentLength >= 0) {
            // Content-Length：检查 body 长度是否足够
            if (body.length >= contentLength) {
              resolved = true;
              cleanup();
              parseHttpResponse(accumulated, () => {}, resolve);
              return;
            }
          } else {
            // 既没有 Content-Length 也没有 chunked：等 end 事件
            tryComplete();
          }
        }

        // 二次检查：chunked 模式可能后续数据包完成
        if (!resolved && (accumulated as any)._isChunked !== false) {
          // 检查 chunked 是否完整
          const body = accumulated.subarray(headerEnd + 4);
          if (body.length >= 5 && body.subarray(body.length - 5).toString() === '0\r\n\r\n') {
            resolved = true;
            cleanup();
            parseHttpResponse(accumulated, () => {}, resolve);
          }
        }
      }
    });

    sock.once('end', () => {
      if (resolved || cleaned) return;
      // end 触发时尚未完成（无 Content-Length 且非 chunked）
      resolved = true;
      cleanup();
      if (headerEnd >= 0) {
        parseHttpResponse(accumulated, reject, resolve);
      } else {
        reject(new Error(`非HTTP响应: ${accumulated.toString('utf8').substring(0, 100)}`));
      }
    });

    sock.once('error', (e) => {
      if (resolved || cleaned) return;
      cleanup();
      reject(new Error(`套接字错误: ${e.message}`));
    });

    sock.write(request);
  });
}

// ============================================================
// 内部：直连（原始 TCP/TLS）
// ============================================================

/**
 * 直连（原始 TCP/TLS — 支持 DNS 预解析 + 系统 DNS 解析双模式）
 *
 * 默认使用 `net.Socket.connect()` 内部 DNS 解析（系统 getaddrinfo）。
 * 当 resolveDns 为 true 时，先通过 `dns.resolve4()` 预解析 hostname
 * 到 IP，再连接 IP 地址，Host 头和 TLS SNI 仍使用原始 hostname。
 *
 * 预解析模式用于绕过部分网络环境对 hostname 层面 TCP 连接的干扰。
 */
function connectToTarget(
  hostname: string,
  connectTarget: string,
  port: number,
  useTls: boolean,
  timeoutMs: number,
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const netSocket = new net.Socket();
    let settled = false;

    const connTimer = setTimeout(() => {
      fail(new Error(`连接超时 (${timeoutMs}ms): ${hostname}:${port} via ${connectTarget}`));
    }, timeoutMs);

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(connTimer);
      netSocket.destroy();
      reject(error);
    }

    function succeed(socket: net.Socket | tls.TLSSocket): void {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      clearTimeout(connTimer);
      resolve(socket);
    }

    if (!useTls) {
      netSocket.connect(port, connectTarget, () => {
        succeed(netSocket);
      });
    } else {
      netSocket.connect(port, connectTarget, () => {
        const tlsSocket = tls.connect(
          {
            socket: netSocket,
            host: hostname,       // TLS SNI 仍用原始 hostname
            servername: hostname,
            rejectUnauthorized: false, // VS Code Electron 环境证书可能受限，公开数据无需验证
          },
          () => succeed(tlsSocket),
        );
        tlsSocket.once('error', (e) => {
          fail(new Error(`TLS/SSL 连接失败 (${connectTarget}): ${e.message}`));
        });
      });
    }

    netSocket.once('error', (e) => {
      fail(new Error(`网络连接失败 (${connectTarget}): ${e.message}`));
    });
  });
}

async function directConnect(
  hostname: string,
  port: number,
  useTls: boolean,
  timeoutMs: number,
  resolveDns?: boolean,
): Promise<net.Socket | tls.TLSSocket> {
  let connectTargets = [hostname];

  if (resolveDns) {
    try {
      const addresses = await dns.promises.resolve4(hostname);
      if (addresses.length > 0) {
        connectTargets = Array.from(new Set(addresses));
      }
    } catch {
      // DNS 预解析失败，回退到 hostname 连接
    }
  }

  // DNS/CDN 通常返回多个 IP。VS Code Extension Host 偶尔会卡在其中一个
  // 不可达地址上，因此在总超时预算内逐个尝试，而不是固定使用第一个地址。
  const attemptTimeout = connectTargets.length > 1
    ? Math.max(2_000, Math.ceil(timeoutMs / connectTargets.length))
    : timeoutMs;
  let lastError: Error | undefined;

  for (const connectTarget of connectTargets) {
    try {
      return await connectToTarget(hostname, connectTarget, port, useTls, attemptTimeout);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error(`无法连接: ${hostname}:${port}`);
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

  const resolveDns = options?.resolveDns ?? false;
  const MAX_REDIRECTS = 5;
  let currentHost = hostname;
  let currentPath = path;
  let currentTls = useTls;
  let currentPort = port;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await httpFetchOne(currentHost, currentPath, currentTls, currentPort, timeoutMs, headers, resolveDns);

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
 * 执行单次 HTTP GET 请求（直连，不走代理）
 * 使用 raw socket + 增量 HTTP 解析，与 Leek Fund 的 axios 行为一致
 */
async function httpFetchOne(
  hostname: string,
  path: string,
  useTls: boolean,
  port: number,
  timeoutMs: number,
  headers: Record<string, string>,
  resolveDns?: boolean,
): Promise<DirectHttpResponse> {
  const sock = await directConnect(hostname, port, useTls, timeoutMs, resolveDns);
  return await sendGetRequest(sock, 'DIRECT', hostname, path, headers, timeoutMs);
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
  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    throw new Error(`HTTP ${resp.statusCode}: ${resp.body.toString('utf8').trim().substring(0, 100)}`);
  }
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

  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    throw new Error(`HTTP ${resp.statusCode}: ${text.substring(0, 100)}`);
  }

  if (!text.startsWith('{') && !text.startsWith('[')) {
    throw new Error(`非JSON响应 (HTTP ${resp.statusCode}): ${text.substring(0, 100)}`);
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

  const sock = await directConnect(hostname, port, useTls, timeoutMs);
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
    throw new Error(`非JSON响应 (HTTP ${resp.statusCode}): ${text.substring(0, 100)}`);
  }

  return { statusCode: resp.statusCode, data: JSON.parse(text) };
}
