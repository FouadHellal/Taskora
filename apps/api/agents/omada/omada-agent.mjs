#!/usr/bin/env node
/**
 * Taskora Omada agent — runs next to a TP-Link Omada controller, reads its Open API locally
 * and pushes the sites, devices and connected clients to Taskora over HTTPS.
 *
 * No inbound access to the client network is needed: the agent only makes outgoing calls.
 * The Omada credentials stay on this machine; Taskora only receives the data.
 * Read-only towards Omada. Node.js 16+ and no other dependency.
 *
 *   node omada-agent.mjs                 run continuously (the installers set this up as a service)
 *   node omada-agent.mjs --test          check the connection to Omada and to Taskora, then exit
 *   node omada-agent.mjs --once          one synchronisation, then exit
 *   node omada-agent.mjs --config FILE   use another configuration file
 *
 * Configuration (JSON): { "taskoraUrl", "token", "omadaUrl" (empty = find it on this machine),
 * "omadaClientId", "omadaClientSecret", "omadacId" (optional), "verifyTls" (Omada, default false),
 * "verifyTaskoraTls" (default true) }
 */
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { dirname, join } from 'node:path';

const VERSION = '1.0.0';
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('--version')) {
  console.log(VERSION);
  process.exit(0);
}

const defaultConfig = platform() === 'win32' ? 'C:\\ProgramData\\TaskoraOmadaAgent\\config.json' : '/etc/taskora-omada-agent/config.json';
const configPath = opt('--config') || process.env.TASKORA_OMADA_AGENT_CONFIG || defaultConfig;
const logPath = join(dirname(configPath), 'agent.log');

function log(level, message) {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  (level === 'error' ? console.error : console.log)(line);
  try {
    if (existsSync(logPath) && statSync(logPath).size > 2 * 1024 * 1024) renameSync(logPath, `${logPath}.1`);
    appendFileSync(logPath, `${line}\n`);
  } catch {
    /* the log file is best effort */
  }
}

function loadConfig() {
  let cfg;
  try {
    // Windows PowerShell 5.1 writes UTF-8 with a byte order mark.
    cfg = JSON.parse(readFileSync(configPath, 'utf8').trimStart());
  } catch (err) {
    throw new Error(`Cannot read the configuration ${configPath}: ${err.message}`);
  }
  for (const k of ['taskoraUrl', 'token', 'omadaClientId', 'omadaClientSecret']) if (!cfg[k]) throw new Error(`"${k}" is missing in ${configPath}`);
  cfg.taskoraUrl = String(cfg.taskoraUrl).replace(/\/+$/, '');
  cfg.omadaUrl = String(cfg.omadaUrl || '').replace(/\/+$/, '');
  return cfg;
}

/* ------------------------------------------------------------------ HTTP */

function http(method, url, { headers = {}, body, verifyTls = true, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = (isHttps ? httpsRequest : httpRequest)(
      u,
      {
        method,
        timeout: timeoutMs,
        headers: { accept: 'application/json', 'user-agent': `taskora-omada-agent/${VERSION}`, ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers },
        ...(isHttps ? { rejectUnauthorized: verifyTls } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 0, json, text, retryAfter: Number(res.headers['retry-after']) || null });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no answer from ${u.host} in time`)));
    req.on('error', (err) => {
      const hint = /SELF_SIGNED|UNABLE_TO_VERIFY|CERT_/.test(err.code || '') ? ' (certificate not trusted: set "verifyTls": false for the Omada controller)' : '';
      reject(new Error(`${u.host}: ${err.code || err.message}${hint}`));
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------------- Omada */

class Omada {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = cfg.omadaUrl;
    this.omadacId = cfg.omadacId || null;
    this.token = null;
    this.expires = 0;
    this.v1Clients = false;
    this.controllerVersion = null;
  }

  /** Finds the controller on this machine when no address is configured. */
  async locate() {
    if (this.base) return this.base;
    for (const candidate of ['https://127.0.0.1:8043', 'https://127.0.0.1:443', 'https://127.0.0.1:8843', 'http://127.0.0.1:8088']) {
      try {
        const r = await http('GET', `${candidate}/api/info`, { verifyTls: false, timeoutMs: 5000 });
        if (r.json && r.json.errorCode === 0 && r.json.result && r.json.result.omadacId) {
          this.base = candidate;
          return candidate;
        }
      } catch {
        /* try the next one */
      }
    }
    throw new Error('No Omada controller found on this machine (tried ports 8043, 443, 8843, 8088): set "omadaUrl" in the configuration');
  }

  async info() {
    await this.locate();
    const r = await http('GET', `${this.base}/api/info`, { verifyTls: !!this.cfg.verifyTls });
    const res = r.json && r.json.result;
    if (!r.json || r.json.errorCode !== 0 || !res) throw new Error(`${this.base} does not answer like an Omada controller (/api/info)`);
    this.omadacId = this.omadacId || res.omadacId;
    this.controllerVersion = res.controllerVer || null;
    return res;
  }

  async auth(force) {
    if (!force && this.token && Date.now() < this.expires - 60000) return this.token;
    if (!this.omadacId || !this.base) await this.info();
    const r = await http('POST', `${this.base}/openapi/authorize/token?grant_type=client_credentials`, {
      verifyTls: !!this.cfg.verifyTls,
      body: { omadacId: this.omadacId, client_id: this.cfg.omadaClientId, client_secret: this.cfg.omadaClientSecret },
    });
    const j = r.json;
    if (!j || j.errorCode !== 0 || !j.result || !j.result.accessToken) {
      throw new Error(`Omada refused the credentials (${(j && j.msg) || `HTTP ${r.status}`}): check the Client ID / secret and that the app uses the "Client" mode`);
    }
    this.token = j.result.accessToken;
    this.expires = Date.now() + (j.result.expiresIn || 7200) * 1000;
    return this.token;
  }

  async call(method, path, body) {
    let renewed = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const token = await this.auth(false);
      const r = await http(method, `${this.base}/openapi/${path.replace('{omadacId}', this.omadacId)}`, { verifyTls: !!this.cfg.verifyTls, headers: { authorization: `AccessToken=${token}` }, body });
      const j = r.json;
      if ((r.status === 401 || (j && (j.errorCode === -44112 || j.errorCode === -44113))) && !renewed) {
        renewed = true;
        await this.auth(true);
        continue;
      }
      if (r.status === 429 || (j && j.errorCode === -7132)) {
        await sleep(Math.min(60000, r.retryAfter ? r.retryAfter * 1000 : 2000 * 2 ** attempt));
        continue;
      }
      if (r.status === 404 || !j || j.errorCode !== 0) {
        const e = new Error(`Omada ${path.split('?')[0]}: ${(j && j.msg) || `HTTP ${r.status}`}`);
        e.code = j ? j.errorCode : r.status;
        e.status = r.status;
        throw e;
      }
      return j.result;
    }
    throw new Error('Omada keeps rate-limiting the requests');
  }

  async paged(fetchPage) {
    const out = [];
    for (let page = 1; page <= 200; page++) {
      const r = await fetchPage(page);
      const rows = Array.isArray(r) ? r : (r && r.data) || [];
      out.push(...rows);
      const total = Array.isArray(r) ? rows.length : (r && r.totalRows) || rows.length;
      if (Array.isArray(r) || rows.length < 100 || out.length >= total) break;
    }
    return out;
  }

  sites() {
    return this.paged((p) => this.call('GET', `v1/{omadacId}/sites?page=${p}&pageSize=100`));
  }
  devices(site) {
    return this.paged((p) => this.call('GET', `v1/{omadacId}/sites/${encodeURIComponent(site)}/devices?page=${p}&pageSize=100`));
  }
  async clients(site) {
    const s = encodeURIComponent(site);
    if (!this.v1Clients) {
      try {
        return await this.paged((p) => this.call('POST', `v2/{omadacId}/sites/${s}/clients`, { page: p, pageSize: 100, scope: 1, filters: {} }));
      } catch (err) {
        if (err.status !== 404 && err.code !== -1600) throw err;
        this.v1Clients = true;
      }
    }
    return this.paged((p) => this.call('GET', `v1/{omadacId}/sites/${s}/clients?page=${p}&pageSize=100`));
  }
  async clientStats(site, macs) {
    if (!macs.length) return [];
    try {
      const r = await this.call('POST', 'v1/{omadacId}/clients/stat/devices', { devices: macs.map((mac) => ({ mac, siteId: site })) });
      return Array.isArray(r) ? r : (r && r.data) || [];
    } catch {
      return [];
    }
  }
}

/** Same rule as Taskora: which kind of Omada device. */
function deviceKind(d) {
  const t = `${d.type || ''} ${d.deviceSeriesType || ''}`.toLowerCase();
  if (/gateway|router|\ber\d/.test(t)) return 'gateway';
  if (/switch/.test(t)) return 'switch';
  if (/\bap\b|eap|access/.test(t) || String(d.model || '').toUpperCase().startsWith('EAP')) return 'ap';
  return 'other';
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));
const DEVICE_KEYS = ['mac', 'name', 'type', 'subtype', 'deviceSeriesType', 'model', 'modelName', 'modelVersion', 'sn', 'status', 'statusCategory', 'detailStatus', 'lastSeen', 'ip', 'publicIp', 'uptime', 'cpuUtil', 'memUtil', 'firmwareVersion', 'clientNum', 'uplinkDeviceMac', 'uplinkDeviceName', 'uplinkDevicePort', 'linkSpeed', 'duplex', 'tagName'];
const CLIENT_KEYS = ['mac', 'name', 'hostName', 'ip', 'vendor', 'osName', 'deviceType', 'deviceCategory', 'wireless', 'ssid', 'networkName', 'rssi', 'signalLevel', 'snr', 'wifiMode', 'channel', 'radioId', 'rxRate', 'txRate', 'trafficDown', 'trafficUp', 'uptime', 'apMac', 'apName', 'switchMac', 'switchName', 'gatewayMac', 'port', 'portName', 'guest', 'active', 'lastSeen'];

/* ---------------------------------------------------------------- Taskora */

async function taskora(cfg, method, path, body) {
  const r = await http(method, `${cfg.taskoraUrl}/api/v1/integrations/omada/agent/${path}`, {
    verifyTls: cfg.verifyTaskoraTls !== false,
    headers: { authorization: `Bearer ${cfg.token}` },
    body,
    timeoutMs: 120000,
  });
  if (r.status === 401 || r.status === 403) throw new Error('Taskora refused the agent token (revoked or mistyped): create a new one on the Omada page in Taskora');
  if (r.status >= 400) throw new Error(`Taskora ${path}: HTTP ${r.status} ${(r.json && r.json.error && r.json.error.message) || r.text.slice(0, 200)}`);
  return r.json;
}

const agentInfo = (omada) => ({ version: VERSION, host: hostname(), platform: `${platform()} ${release()} node ${process.versions.node}`, controllerVersion: omada.controllerVersion });

/** One synchronisation. Returns the minutes to wait before the next one. */
async function runOnce(cfg) {
  const omada = new Omada(cfg);
  const remote = await taskora(cfg, 'GET', `config?version=${encodeURIComponent(VERSION)}&host=${encodeURIComponent(hostname())}`);
  if (remote.latestVersion && remote.latestVersion !== VERSION) log('warn', `A newer agent (${remote.latestVersion}) is available: run the install command again to update.`);
  if (!remote.enabled) {
    log('info', 'The Omada integration is not enabled in agent mode in Taskora: nothing to do.');
    return 5;
  }
  try {
    await omada.info();
    const sites = await omada.sites();
    const mapped = new Set(remote.mappedSiteIds || []);
    const kinds = new Set(remote.deviceKinds || ['ap']);
    const payload = { agent: agentInfo(omada), sites: [] };
    let devices = 0;
    let clients = 0;
    for (const site of sites) {
      const siteId = String(site.siteId || site.id || '');
      if (!siteId) continue;
      const entry = { siteId, name: String(site.name || siteId) };
      if (mapped.has(siteId)) {
        const raw = await omada.devices(siteId);
        const wanted = raw.filter((d) => kinds.has(deviceKind(d)));
        entry.devices = wanted.map((d) => pick(d, DEVICE_KEYS));
        entry.clientStats = await omada.clientStats(siteId, wanted.map((d) => d.mac).filter(Boolean));
        entry.clients = (await omada.clients(siteId)).map((c) => pick(c, CLIENT_KEYS));
        devices += entry.devices.length;
        clients += entry.clients.length;
      }
      payload.sites.push(entry);
    }
    const res = await taskora(cfg, 'POST', 'push', payload);
    log('info', `Sent ${sites.length} site(s) (${mapped.size} mapped), ${devices} device(s), ${clients} client(s)${res && res.accepted === false ? ` — not accepted: ${res.reason}` : ''}`);
  } catch (err) {
    log('error', err.message);
    // Tell Taskora what is wrong so it shows on the Omada page.
    await taskora(cfg, 'POST', 'push', { agent: agentInfo(omada), error: err.message }).catch(() => null);
  }
  return Math.max(5, Number(remote.intervalMinutes) || 15);
}

async function test(cfg) {
  let ok = true;
  const omada = new Omada(cfg);
  try {
    const info = await omada.info();
    log('info', `Omada controller found at ${omada.base} (version ${info.controllerVer || '?'})`);
    const sites = await omada.sites();
    log('info', `Omada credentials accepted: ${sites.length} site(s): ${sites.map((s) => s.name).join(', ') || '—'}`);
  } catch (err) {
    ok = false;
    log('error', `Omada: ${err.message}`);
  }
  try {
    const remote = await taskora(cfg, 'GET', `config?version=${encodeURIComponent(VERSION)}&host=${encodeURIComponent(hostname())}`);
    log('info', `Taskora reachable at ${cfg.taskoraUrl}, token accepted${remote.enabled ? '' : ' (integration not enabled in agent mode yet)'}`);
  } catch (err) {
    ok = false;
    log('error', `Taskora: ${err.message}`);
  }
  return ok;
}

async function main() {
  const cfg = loadConfig();
  if (flag('--test')) process.exit((await test(cfg)) ? 0 : 1);
  if (flag('--once')) {
    await runOnce(cfg);
    return;
  }
  log('info', `Taskora Omada agent ${VERSION} started (${hostname()}), sending to ${cfg.taskoraUrl}`);
  for (;;) {
    let minutes = 5;
    try {
      minutes = await runOnce(cfg);
    } catch (err) {
      log('error', err.message);
    }
    await sleep(minutes * 60000);
  }
}

main().catch((err) => {
  log('error', err.message);
  process.exit(1);
});
