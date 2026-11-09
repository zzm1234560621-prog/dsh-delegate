'use strict';

/**
 * Tiny HTTPS GET with proxy support, no dependencies.
 *
 * Many Windows/macOS setups route outbound traffic through a local HTTP proxy
 * while Node's built-in fetch ignores system proxy settings. We try a direct
 * request first and fall back to an HTTP CONNECT tunnel.
 */

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { URL } = require('node:url');

const DEFAULT_TIMEOUT = 8000;

function proxyUrl() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null
  );
}

function directGet(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers,
        timeout: timeoutMs,
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode, body: text }));
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

function tunnelGet(url, headers, timeoutMs, proxy) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const proxyTarget = new URL(proxy);
    const port = target.port || 443;

    const connectRequest = http.request({
      host: proxyTarget.hostname,
      port: proxyTarget.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}` },
      timeout: timeoutMs,
    });

    connectRequest.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${response.statusCode}`));
        return;
      }
      const secured = tls.connect({ socket, servername: target.hostname }, () => {
        const lines = [
          `GET ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${target.hostname}`,
          ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
          'Connection: close',
          '',
          '',
        ].join('\r\n');
        secured.write(lines);
      });

      let raw = '';
      secured.setEncoding('utf8');
      secured.on('data', (chunk) => {
        raw += chunk;
      });
      secured.on('end', () => {
        const split = raw.indexOf('\r\n\r\n');
        if (split === -1) return reject(new Error('bad proxy response'));
        const head = raw.slice(0, split);
        let body = raw.slice(split + 4);
        const status = Number((head.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0);
        if (/transfer-encoding:\s*chunked/i.test(head)) {
          const parts = [];
          let rest = body;
          for (;;) {
            const index = rest.indexOf('\r\n');
            if (index === -1) break;
            const size = parseInt(rest.slice(0, index), 16);
            if (!Number.isFinite(size) || size === 0) break;
            parts.push(rest.slice(index + 2, index + 2 + size));
            rest = rest.slice(index + 2 + size + 2);
          }
          body = parts.join('');
        }
        resolve({ status, body });
      });
      secured.on('error', reject);
    });

    connectRequest.on('timeout', () => connectRequest.destroy(new Error('proxy timeout')));
    connectRequest.on('error', reject);
    connectRequest.end();
  });
}

/**
 * GET a JSON document, trying direct first and the env proxy second.
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @param {number} [timeoutMs]
 */
async function getJson(url, headers = {}, timeoutMs = DEFAULT_TIMEOUT) {
  const merged = { accept: 'application/json', 'user-agent': 'dsh-delegate', ...headers };
  const proxy = proxyUrl();
  let firstError = null;
  try {
    const result = await directGet(url, merged, timeoutMs);
    if (result.status >= 200 && result.status < 300) return JSON.parse(result.body);
    firstError = new Error(`HTTP ${result.status}`);
  } catch (cause) {
    firstError = cause;
  }
  if (proxy) {
    const result = await tunnelGet(url, merged, timeoutMs, proxy);
    if (result.status >= 200 && result.status < 300) return JSON.parse(result.body);
    throw new Error(`HTTP ${result.status} via proxy`);
  }
  throw firstError || new Error('request failed');
}

module.exports = { getJson, proxyUrl };
