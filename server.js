#!/usr/bin/env node
/**
 * OpenClaw Console - Gateway RPC 深度整合版
 * Port: 8200
 * Auth: Basic Auth (admin / QJn81u581sX1jecx)
 */

const express = require('express');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { pathToFileURL } = require('url');

const PORT = Number(process.env.PORT || 8200);
const HTML_FILE = path.join(__dirname, 'public.html');
const TASKS_FILE = path.join(__dirname, 'tasks.json');
const TASK_QUEUE_FILE = path.join(__dirname, 'task-queue.json');

const AUTH_USER = 'admin';
const AUTH_PASS = 'QJn81u581sX1jecx';

const GATEWAY_CALL_TIMEOUT_MS = 12000;
const GATEWAY_CLI_OVERHEAD_MS = 30000;
const MONITOR_INTERVAL_MS = 4000;
const SSE_KEEPALIVE_MS = 15000;
const GATEWAY_START_TIMEOUT_MS = 12000;
const DEFAULT_GATEWAY_PORT = 18789;
const GATEWAY_PORT_CACHE_TTL_MS = 60000;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

function basicAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth) {
        res.setHeader('WWW-Authenticate', 'Basic realm="OpenClaw Console"');
        return res.status(401).send('Authentication required');
    }

    try {
        const token = auth.split(' ')[1] || '';
        const [username, password] = Buffer.from(token, 'base64').toString().split(':');
        if (username === AUTH_USER && password === AUTH_PASS) {
            return next();
        }
    } catch (_) {
        // ignore
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="OpenClaw Console"');
    return res.status(401).send('Invalid credentials');
}

app.use(basicAuth);

function nowIso() {
    return new Date().toISOString();
}

const gatewayPortCache = {
    value: DEFAULT_GATEWAY_PORT,
    updatedAt: 0
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeReadJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch (error) {
        console.error(`[json] read failed for ${file}:`, error.message);
        return fallback;
    }
}

function safeWriteJson(file, value) {
    try {
        fs.writeFileSync(file, JSON.stringify(value, null, 2));
        return true;
    } catch (error) {
        console.error(`[json] write failed for ${file}:`, error.message);
        return false;
    }
}

function loadTasks() {
    const tasks = safeReadJson(TASKS_FILE, []);
    return Array.isArray(tasks) ? tasks : [];
}

function saveTasks(tasks) {
    safeWriteJson(TASKS_FILE, tasks);
}

function loadTaskQueue() {
    const tasks = safeReadJson(TASK_QUEUE_FILE, []);
    return Array.isArray(tasks) ? tasks : [];
}

function saveTaskQueue(tasks) {
    safeWriteJson(TASK_QUEUE_FILE, tasks);
}

function sortTasks(tasks) {
    const priorityOrder = { '🔴 高': 0, '🟡 中': 1, '🟢 低': 2, '🔴': 0, '🟡': 1, '🟢': 2 };
    return [...tasks].sort((a, b) => {
        const pa = priorityOrder[a.priority] ?? 3;
        const pb = priorityOrder[b.priority] ?? 3;
        if (pa !== pb) return pa - pb;
        return (b.createdAt || 0) - (a.createdAt || 0);
    });
}

function sortQueueTasks(tasks) {
    const priorityOrder = { '🔴': 0, '🟡': 1, '🟢': 2 };
    return [...tasks].sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        if (a.status === 'pending' && b.status !== 'pending') return -1;
        if (a.status !== 'pending' && b.status === 'pending') return 1;
        const pa = priorityOrder[a.priority] ?? 3;
        const pb = priorityOrder[b.priority] ?? 3;
        if (pa !== pb) return pa - pb;
        return (a.createdAt || 0) - (b.createdAt || 0);
    });
}

function hashObject(value) {
    return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function extractJsonFromOutput(raw) {
    if (raw == null) return null;
    const text = String(raw).trim();
    if (!text) return null;

    const candidates = [];
    candidates.push(text);

    const lineObjectIndex = text.lastIndexOf('\n{');
    if (lineObjectIndex >= 0) candidates.push(text.slice(lineObjectIndex + 1).trim());

    const lineArrayIndex = text.lastIndexOf('\n[');
    if (lineArrayIndex >= 0) candidates.push(text.slice(lineArrayIndex + 1).trim());

    const firstObjectIndex = text.indexOf('{');
    if (firstObjectIndex >= 0) candidates.push(text.slice(firstObjectIndex).trim());

    const firstArrayIndex = text.indexOf('[');
    if (firstArrayIndex >= 0) candidates.push(text.slice(firstArrayIndex).trim());

    const tried = new Set();
    for (const candidate of candidates) {
        if (!candidate || tried.has(candidate)) continue;
        tried.add(candidate);
        try {
            return JSON.parse(candidate);
        } catch (_) {
            // keep trying
        }
    }

    return null;
}

function compactErrorMessage(error) {
    const message = String(error?.message || error || 'Unknown error').trim();
    const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return 'Unknown error';
    const last = lines[lines.length - 1];
    return last.replace(/^Gateway call failed:\s*/i, '').trim();
}

function isUnknownMethodError(error) {
    return /unknown method/i.test(String(error?.message || ''));
}

function isDeleteMainSessionError(error) {
    return /cannot delete the main session/i.test(String(error?.message || ''));
}

function looksLikeSessionKey(value) {
    return typeof value === 'string' && value.startsWith('agent:');
}

function normalizeAgentId(agentId) {
    const raw = String(agentId || '').trim();
    if (!raw) return 'main';
    if (raw === 'coding-agent' || raw === 'default' || raw === 'kimi-coding') return 'main';
    return raw;
}

function parseInteger(value, fallback, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    const n = Math.floor(numeric);
    if (Number.isFinite(min) && n < min) return min;
    if (Number.isFinite(max) && n > max) return max;
    return n;
}

function truncateText(value, maxLength = 240) {
    const text = String(value || '');
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
}

function runOpenclawCommand(args, options = {}) {
    return new Promise((resolve, reject) => {
        const timeoutMs = parseInteger(options.timeoutMs, GATEWAY_START_TIMEOUT_MS, 1000, 120000);

        execFile('openclaw', args, {
            timeout: timeoutMs,
            maxBuffer: 20 * 1024 * 1024
        }, (error, stdout, stderr) => {
            const output = `${stdout || ''}\n${stderr || ''}`.trim();
            const parsed = extractJsonFromOutput(output);

            if (!error) {
                return resolve({
                    args,
                    data: parsed,
                    raw: output
                });
            }

            const detail = output || String(error?.message || 'OpenClaw command failed');
            const wrapped = new Error(detail);
            wrapped.args = args;
            wrapped.raw = output;
            wrapped.parsed = parsed;
            wrapped.cause = error;
            return reject(wrapped);
        });
    });
}

const directGatewayCall = {
    tried: false,
    promise: null,
    fn: null,
    modulePath: null,
    error: null
};

function collectOpenclawCallModuleCandidates() {
    const candidates = [];
    const seen = new Set();

    const pushPath = (candidate) => {
        const raw = String(candidate || '').trim();
        if (!raw) return;
        const resolved = path.resolve(raw);
        if (seen.has(resolved)) return;
        seen.add(resolved);
        candidates.push(resolved);
    };

    const fromEnv = process.env.OPENCLAW_CALL_MODULE_PATH;
    if (fromEnv) pushPath(fromEnv);

    const distDirs = [
        path.join(path.resolve(process.execPath, '..', '..'), 'lib', 'node_modules', 'openclaw', 'dist'),
        path.join(path.resolve(process.execPath, '..', '..', '..'), 'lib', 'node_modules', 'openclaw', 'dist'),
        '/usr/local/lib/node_modules/openclaw/dist',
        '/usr/lib/node_modules/openclaw/dist'
    ];

    for (const distDir of distDirs) {
        try {
            if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) continue;
            const files = fs.readdirSync(distDir)
                .filter((name) => name.startsWith('call-') && name.endsWith('.js'))
                .sort();
            for (const file of files) {
                pushPath(path.join(distDir, file));
            }
        } catch (_) {
            // ignore and continue scanning other locations
        }
    }

    return candidates;
}

async function loadDirectGatewayCall() {
    if (directGatewayCall.fn) return directGatewayCall.fn;
    if (directGatewayCall.tried && !directGatewayCall.promise) return null;
    if (directGatewayCall.promise) return directGatewayCall.promise;

    directGatewayCall.promise = (async () => {
        const candidates = collectOpenclawCallModuleCandidates();
        let lastError = null;

        for (const modulePath of candidates) {
            try {
                const mod = await import(pathToFileURL(modulePath).href);
                const fn = mod?.n || mod?.callGateway;
                if (typeof fn === 'function') {
                    directGatewayCall.fn = fn;
                    directGatewayCall.modulePath = modulePath;
                    directGatewayCall.error = null;
                    return fn;
                }
            } catch (error) {
                lastError = error;
            }
        }

        directGatewayCall.error = lastError || new Error('OpenClaw gateway module not found');
        return null;
    })();

    try {
        return await directGatewayCall.promise;
    } finally {
        directGatewayCall.tried = true;
        directGatewayCall.promise = null;
    }
}

function resolvePortFromValue(value, fallback = DEFAULT_GATEWAY_PORT) {
    let candidate = value;

    if (candidate && typeof candidate === 'object') {
        if (Object.prototype.hasOwnProperty.call(candidate, 'value')) {
            candidate = candidate.value;
        } else if (Object.prototype.hasOwnProperty.call(candidate, 'port')) {
            candidate = candidate.port;
        }
    }

    return parseInteger(candidate, fallback, 1, 65535);
}

async function getGatewayPort(options = {}) {
    const force = options.force === true;
    const now = Date.now();
    if (!force && gatewayPortCache.updatedAt > 0 && now - gatewayPortCache.updatedAt < GATEWAY_PORT_CACHE_TTL_MS) {
        return gatewayPortCache.value;
    }

    try {
        const result = await runOpenclawCommand(['config', 'get', 'gateway.port', '--json'], { timeoutMs: 5000 });
        const port = resolvePortFromValue(result.data ?? result.raw, DEFAULT_GATEWAY_PORT);
        gatewayPortCache.value = port;
        gatewayPortCache.updatedAt = now;
        return port;
    } catch (_) {
        gatewayPortCache.updatedAt = now;
        return gatewayPortCache.value || DEFAULT_GATEWAY_PORT;
    }
}

function probeTcpPort(port, options = {}) {
    const host = options.host || '127.0.0.1';
    const timeoutMs = parseInteger(options.timeoutMs, 1200, 100, 10000);

    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;

        const finish = (ok) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(ok);
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));

        try {
            socket.connect(port, host);
        } catch (_) {
            finish(false);
        }
    });
}

function runGatewayCallViaCli(method, params = {}, options = {}) {
    return new Promise((resolve, reject) => {
        const timeoutMs = parseInteger(options.timeoutMs, GATEWAY_CALL_TIMEOUT_MS, 1000, 120000);
        const args = [
            'gateway',
            'call',
            method,
            '--json',
            '--params',
            JSON.stringify(params || {}),
            '--timeout',
            String(timeoutMs)
        ];

        if (options.expectFinal === true) {
            args.push('--expect-final');
        }

        execFile('openclaw', args, {
            timeout: timeoutMs + GATEWAY_CLI_OVERHEAD_MS,
            maxBuffer: 20 * 1024 * 1024
        }, (error, stdout, stderr) => {
            const output = `${stdout || ''}\n${stderr || ''}`.trim();
            const parsed = extractJsonFromOutput(output);

            if (!error && parsed !== null) {
                return resolve({
                    method,
                    params,
                    data: parsed,
                    raw: output
                });
            }

            const detail = output || String(error?.message || 'Unknown gateway error');
            const wrapped = new Error(detail);
            wrapped.method = method;
            wrapped.params = params;
            wrapped.raw = output;
            wrapped.parsed = parsed;
            wrapped.cause = error;
            return reject(wrapped);
        });
    });
}

async function runGatewayCall(method, params = {}, options = {}) {
    const timeoutMs = parseInteger(options.timeoutMs, GATEWAY_CALL_TIMEOUT_MS, 1000, 120000);
    const callGateway = await loadDirectGatewayCall();

    if (typeof callGateway === 'function') {
        try {
            const data = await callGateway({
                method,
                params: params || {},
                timeoutMs,
                expectFinal: options.expectFinal === true,
                mode: 'cli',
                clientName: 'cli'
            });

            return {
                method,
                params,
                data,
                raw: JSON.stringify(data)
            };
        } catch (error) {
            const detail = String(error?.message || error || 'Unknown gateway error');
            const wrapped = new Error(detail);
            wrapped.method = method;
            wrapped.params = params;
            wrapped.raw = detail;
            wrapped.parsed = extractJsonFromOutput(detail);
            wrapped.cause = error;
            throw wrapped;
        }
    }

    return runGatewayCallViaCli(method, params, options);
}

async function resolveSessionKeyFromAny(input) {
    const raw = String(input || '').trim();
    if (!raw) {
        throw new Error('sessionKey 不能为空');
    }
    if (looksLikeSessionKey(raw)) {
        return raw;
    }

    try {
        const resolved = await runGatewayCall('sessions.resolve', { sessionId: raw }, { timeoutMs: 6000 });
        if (resolved?.data?.ok && typeof resolved.data.key === 'string') {
            return resolved.data.key;
        }
    } catch (_) {
        // fallback to raw
    }

    return raw;
}

async function mapSessionsList(payload) {
    return {
        limit: parseInteger(payload.limit, 200, 1, 500),
        includeLastMessage: payload.includeLastMessage !== false,
        includeDerivedTitles: payload.includeDerivedTitles !== false,
        includeGlobal: payload.includeGlobal !== false,
        includeUnknown: payload.includeUnknown !== false,
        activeMinutes: payload.activeMinutes != null ? parseInteger(payload.activeMinutes, 0, 0, 10080) : undefined,
        agentId: payload.agentId ? normalizeAgentId(payload.agentId) : undefined
    };
}

async function mapSessionsHistory(payload) {
    const sessionKey = await resolveSessionKeyFromAny(payload.sessionKey || payload.key || payload.sessionId);
    return {
        sessionKey,
        limit: parseInteger(payload.limit, 120, 1, 1000)
    };
}

async function mapSessionsSend(payload) {
    const sessionKey = await resolveSessionKeyFromAny(payload.sessionKey || payload.key || payload.sessionId);
    const message = String(payload.message || '').trim();
    if (!message) {
        throw new Error('message 不能为空');
    }

    const params = {
        sessionKey,
        message,
        idempotencyKey: payload.idempotencyKey || crypto.randomUUID(),
        timeoutMs: parseInteger(payload.timeoutMs, 120000, 1000, 300000)
    };

    if (payload.deliver === true) params.deliver = true;
    if (payload.thinking) params.thinking = String(payload.thinking);

    return params;
}

async function mapSessionsSpawn(payload) {
    const task = String(payload.task || payload.message || payload.prompt || '').trim();
    if (!task) {
        throw new Error('task/message 不能为空');
    }

    const agentId = normalizeAgentId(payload.agentId);
    const sessionKey = looksLikeSessionKey(payload.sessionKey)
        ? payload.sessionKey
        : `agent:${agentId}:subagent:${crypto.randomUUID()}`;

    const idempotencyKey = payload.idempotencyKey || crypto.randomUUID();

    return {
        params: {
            idempotencyKey,
            sessionKey,
            message: task,
            deliver: false,
            timeout: parseInteger(payload.timeout, 300, 10, 1800)
        },
        meta: {
            idempotencyKey,
            sessionKey
        }
    };
}

async function mapSessionsKill(payload) {
    const key = await resolveSessionKeyFromAny(payload.sessionKey || payload.key || payload.sessionId);
    return {
        key,
        deleteTranscript: payload.deleteTranscript !== false
    };
}

const RPC_ALIAS_CONFIG = {
    sessions_list: {
        candidates: [
            { method: 'sessions_list', map: async (payload) => payload },
            { method: 'sessions.list', map: mapSessionsList }
        ]
    },
    sessions_history: {
        candidates: [
            { method: 'sessions_history', map: async (payload) => payload },
            { method: 'chat.history', map: mapSessionsHistory }
        ]
    },
    sessions_send: {
        candidates: [
            { method: 'sessions_send', map: async (payload) => payload },
            { method: 'chat.send', map: mapSessionsSend }
        ]
    },
    sessions_spawn: {
        candidates: [
            { method: 'sessions_spawn', map: async (payload) => payload },
            { method: 'sessions.spawn', map: async (payload) => payload },
            {
                method: 'agent',
                map: mapSessionsSpawn,
                postProcess: async (result, payload, mapped) => {
                    const sessionKey = mapped?.meta?.sessionKey;
                    const patch = { key: sessionKey };
                    let needsPatch = false;

                    if (payload.label && String(payload.label).trim()) {
                        patch.label = String(payload.label).trim();
                        needsPatch = true;
                    }

                    if (payload.model && String(payload.model).trim()) {
                        patch.model = String(payload.model).trim();
                        needsPatch = true;
                    }

                    if (needsPatch && sessionKey) {
                        try {
                            await runGatewayCall('sessions.patch', patch, { timeoutMs: 10000 });
                        } catch (patchError) {
                            console.warn('[rpc] sessions.patch after spawn failed:', compactErrorMessage(patchError));
                        }
                    }

                    return {
                        ...result,
                        sessionKey,
                        runId: result?.data?.runId || mapped?.meta?.idempotencyKey
                    };
                }
            }
        ]
    },
    sessions_kill: {
        candidates: [
            { method: 'sessions_kill', map: async (payload) => payload },
            {
                method: 'sessions.delete',
                map: mapSessionsKill,
                fallbackOn: (error) => isDeleteMainSessionError(error)
            },
            {
                method: 'sessions.reset',
                map: async (payload) => {
                    const key = await resolveSessionKeyFromAny(payload.sessionKey || payload.key || payload.sessionId);
                    return { key, reason: 'reset' };
                }
            }
        ]
    }
};

function buildAliasError(alias, attempts, originalError) {
    const brief = attempts.map((x) => `${x.method}: ${x.message}`).join(' | ');
    const error = new Error(`[${alias}] ${brief || 'All methods failed'}`);
    error.attempts = attempts;
    error.originalError = originalError;
    return error;
}

async function callGatewayAlias(alias, payload = {}, options = {}) {
    const config = RPC_ALIAS_CONFIG[alias];
    if (!config) {
        throw new Error(`Unknown RPC alias: ${alias}`);
    }

    const attempts = [];

    for (const candidate of config.candidates) {
        const mapped = await candidate.map(payload || {});
        const params = mapped && Object.prototype.hasOwnProperty.call(mapped, 'params') ? mapped.params : mapped;

        try {
            const result = await runGatewayCall(candidate.method, params || {}, {
                timeoutMs: options.timeoutMs,
                expectFinal: options.expectFinal
            });

            let response = {
                alias,
                usedMethod: candidate.method,
                params,
                data: result.data
            };

            if (typeof candidate.postProcess === 'function') {
                response = await candidate.postProcess(response, payload, mapped);
            }

            return response;
        } catch (error) {
            const message = compactErrorMessage(error);
            attempts.push({ method: candidate.method, message });

            if (isUnknownMethodError(error)) {
                continue;
            }

            if (typeof candidate.fallbackOn === 'function' && candidate.fallbackOn(error)) {
                continue;
            }

            throw buildAliasError(alias, attempts, error);
        }
    }

    throw buildAliasError(alias, attempts);
}

function formatSessionLabel(key, item = {}) {
    if (item.label) return `🏷 ${item.label}`;
    if (item.displayName) return item.displayName;
    if (key === 'agent:main:main') return '🦞 主会话 (main)';

    if (key.includes('feishu:direct:')) {
        const id = key.split(':').pop();
        return `💬 飞书 ${id === 'commander' ? 'Commander' : id}`;
    }

    if (key.includes('hook:')) {
        return `🪝 Hook ${key.split(':').pop()}`;
    }

    if (key.includes('subagent:')) {
        return `🤖 子代理 ${key.split(':').pop()}`;
    }

    return key;
}

function getSessionKind(key) {
    if (key.includes('feishu')) return 'feishu';
    if (key.includes('hook')) return 'hook';
    if (key.includes('subagent')) return 'subagent';
    return 'main';
}

function normalizeSessionItems(payload) {
    const sessions = Array.isArray(payload?.sessions)
        ? payload.sessions
        : Array.isArray(payload?.recent)
            ? payload.recent
            : [];

    return sessions.map((item) => {
        const key = item.key || item.sessionKey || item.id;
        const updatedAt = parseInteger(item.updatedAt, Date.now(), 0);

        return {
            sessionKey: key,
            label: formatSessionLabel(key, item),
            kind: getSessionKind(key),
            status: item.deleted ? 'stopped' : 'running',
            model: item.model || null,
            modelProvider: item.modelProvider || null,
            updatedAt,
            age: item.age != null ? item.age : Math.max(0, Date.now() - updatedAt),
            lastMessagePreview: truncateText(item.lastMessagePreview || '', 280)
        };
    }).filter((x) => typeof x.sessionKey === 'string');
}

function contentToText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    return content.map((block) => {
        if (!block || typeof block !== 'object') return '';
        if (typeof block.text === 'string') return block.text;
        if (typeof block.thinking === 'string') return `[thinking] ${block.thinking}`;
        if (block.type === 'toolCall' && block.name) return `[tool:${block.name}]`;
        if (block.type === 'toolResult') return '[toolResult]';
        return '';
    }).filter(Boolean).join('\n');
}

function normalizeHistory(payload) {
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];

    return messages.map((msg, index) => {
        const timestamp = parseInteger(msg.timestamp, Date.now(), 0);
        const text = contentToText(msg.content);
        return {
            id: `${timestamp}-${index}`,
            role: msg.role || 'unknown',
            text,
            timestamp
        };
    });
}

async function fetchGatewayStatus(options = {}) {
    const timeoutMs = parseInteger(options.timeoutMs, 1200, 100, 10000);
    const gatewayPort = await getGatewayPort(options);
    const reachable = await probeTcpPort(gatewayPort, { timeoutMs });

    return {
        status: reachable ? 'connected' : 'disconnected',
        gateway: reachable ? 'running' : 'stopped',
        gatewayPort,
        timestamp: nowIso()
    };
}

async function waitForGatewayStatus(target = 'connected', options = {}) {
    const timeoutMs = parseInteger(options.timeoutMs, 12000, 1000, 60000);
    const intervalMs = parseInteger(options.intervalMs, 800, 100, 5000);
    const probeTimeoutMs = parseInteger(options.probeTimeoutMs, 2000, 500, 10000);
    const deadline = Date.now() + timeoutMs;
    let lastStatus = null;

    while (Date.now() < deadline) {
        lastStatus = await fetchGatewayStatus({ timeoutMs: probeTimeoutMs });
        if (lastStatus.status === target) {
            return lastStatus;
        }
        await sleep(intervalMs);
    }

    return lastStatus || fetchGatewayStatus({ timeoutMs: probeTimeoutMs });
}

function spawnGatewayRunDetached(port) {
    const child = spawn('openclaw', [
        'gateway',
        'run',
        '--force',
        '--allow-unconfigured',
        '--port',
        String(port)
    ], {
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
    return child.pid || null;
}

async function connectGateway() {
    const attempts = [];
    const gatewayPort = await getGatewayPort({ force: true });
    let status = await fetchGatewayStatus({ timeoutMs: 2000 });

    if (status.status === 'connected') {
        return {
            connected: true,
            alreadyRunning: true,
            gatewayPort,
            status,
            attempts
        };
    }

    try {
        const start = await runOpenclawCommand(['gateway', 'start', '--json'], { timeoutMs: 9000 });
        attempts.push({
            action: 'gateway.start',
            ok: true,
            raw: truncateText(start.raw, 200)
        });
    } catch (error) {
        attempts.push({
            action: 'gateway.start',
            ok: false,
            error: compactErrorMessage(error)
        });
    }

    status = await waitForGatewayStatus('connected', {
        timeoutMs: 6000,
        intervalMs: 700,
        probeTimeoutMs: 2000
    });

    if (status.status === 'connected') {
        return {
            connected: true,
            gatewayPort,
            status,
            attempts
        };
    }

    try {
        const pid = spawnGatewayRunDetached(gatewayPort);
        attempts.push({
            action: 'gateway.run',
            ok: true,
            pid
        });
    } catch (error) {
        attempts.push({
            action: 'gateway.run',
            ok: false,
            error: compactErrorMessage(error)
        });
    }

    status = await waitForGatewayStatus('connected', {
        timeoutMs: 20000,
        intervalMs: 700,
        probeTimeoutMs: 2000
    });

    return {
        connected: status.status === 'connected',
        gatewayPort,
        status,
        attempts
    };
}

async function fetchSessionsSafe(limit = 200) {
    try {
        const result = await callGatewayAlias('sessions_list', {
            limit,
            includeLastMessage: true,
            includeDerivedTitles: true
        }, { timeoutMs: 10000 });
        return normalizeSessionItems(result.data);
    } catch (error) {
        console.error('[sessions] list failed:', compactErrorMessage(error));
        return [];
    }
}

function buildDashboardSnapshot({ gatewayStatus, sessions, tasks, queueTasks }) {
    const pendingTaskCount = tasks.filter((task) => ['pending', 'todo'].includes(task.status)).length;
    const runningTaskCount = tasks.filter((task) => task.status === 'running').length;

    return {
        status: gatewayStatus.status,
        gateway: gatewayStatus.gateway,
        gatewayPort: gatewayStatus.gatewayPort,
        activeSessions: sessions.length,
        recentSessions: sessions.slice(0, 10).map((session) => ({
            key: session.sessionKey,
            label: session.label,
            kind: session.kind,
            age: session.age,
            model: session.model,
            updatedAt: session.updatedAt,
            lastMessagePreview: session.lastMessagePreview
        })),
        taskStats: {
            total: tasks.length,
            pending: pendingTaskCount,
            running: runningTaskCount,
            done: tasks.filter((task) => task.status === 'done').length,
            failed: tasks.filter((task) => task.status === 'failed').length
        },
        queueStats: {
            total: queueTasks.length,
            pending: queueTasks.filter((task) => task.status === 'pending').length,
            running: queueTasks.filter((task) => task.status === 'running').length
        },
        timestamp: nowIso()
    };
}

const sseClients = new Set();

function sseWrite(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
    for (const client of sseClients) {
        try {
            sseWrite(client.res, event, data);
        } catch (_) {
            sseClients.delete(client);
        }
    }
}

const monitorCache = {
    gatewayHash: '',
    sessionsHash: '',
    tasksHash: '',
    queueHash: '',
    dashboardHash: '',
    gateway: { status: 'unknown', gateway: 'unknown', gatewayPort: DEFAULT_GATEWAY_PORT, timestamp: nowIso() },
    sessions: [],
    tasks: sortTasks(loadTasks()),
    queueTasks: sortQueueTasks(loadTaskQueue()),
    dashboard: null
};

async function refreshStateAndBroadcast() {
    const gatewayStatus = await fetchGatewayStatus();
    const sessions = gatewayStatus.status === 'connected' ? await fetchSessionsSafe(250) : [];
    const tasks = sortTasks(loadTasks());
    const queueTasks = sortQueueTasks(loadTaskQueue());

    const dashboard = buildDashboardSnapshot({
        gatewayStatus,
        sessions,
        tasks,
        queueTasks
    });

    const gatewayHash = hashObject(gatewayStatus);
    const sessionsHash = hashObject(sessions.map((session) => [session.sessionKey, session.updatedAt, session.status]));
    const tasksHash = hashObject(tasks.map((task) => [task.id, task.status, task.updatedAt, task.sessionKey || null]));
    const queueHash = hashObject(queueTasks.map((task) => [task.id, task.status, task.updatedAt]));
    const dashboardHash = hashObject(dashboard);

    if (gatewayHash !== monitorCache.gatewayHash) {
        monitorCache.gatewayHash = gatewayHash;
        monitorCache.gateway = gatewayStatus;
        broadcast('gateway_status', gatewayStatus);
    }

    if (sessionsHash !== monitorCache.sessionsHash) {
        monitorCache.sessionsHash = sessionsHash;
        monitorCache.sessions = sessions;
        broadcast('sessions_update', {
            count: sessions.length,
            sessions,
            timestamp: nowIso()
        });
    }

    if (tasksHash !== monitorCache.tasksHash) {
        monitorCache.tasksHash = tasksHash;
        monitorCache.tasks = tasks;
        broadcast('tasks_update', {
            count: tasks.length,
            tasks,
            timestamp: nowIso()
        });
    }

    if (queueHash !== monitorCache.queueHash) {
        monitorCache.queueHash = queueHash;
        monitorCache.queueTasks = queueTasks;
        broadcast('queue_update', {
            count: queueTasks.length,
            tasks: queueTasks,
            timestamp: nowIso()
        });
    }

    if (dashboardHash !== monitorCache.dashboardHash) {
        monitorCache.dashboardHash = dashboardHash;
        monitorCache.dashboard = dashboard;
        broadcast('dashboard_update', dashboard);
    }
}

function scheduleRefresh() {
    setTimeout(() => {
        refreshStateAndBroadcast().catch((error) => {
            console.error('[monitor] refresh failed:', compactErrorMessage(error));
        });
    }, 20);
}

let queueProcessing = false;

async function processTaskQueue() {
    if (queueProcessing) return;
    queueProcessing = true;

    try {
        while (true) {
            const all = sortQueueTasks(loadTaskQueue());
            const next = all.find((task) => task.status === 'pending');
            if (!next) break;

            const tasks = loadTaskQueue();
            const idx = tasks.findIndex((task) => task.id === next.id);
            if (idx < 0) break;

            tasks[idx].status = 'running';
            tasks[idx].startedAt = Date.now();
            tasks[idx].updatedAt = Date.now();
            saveTaskQueue(tasks);
            scheduleRefresh();

            try {
                const spawn = await callGatewayAlias('sessions_spawn', {
                    task: tasks[idx].description || tasks[idx].title,
                    model: tasks[idx].model,
                    label: `queue-${tasks[idx].id.slice(-6)}`,
                    timeout: 300
                }, { timeoutMs: 20000 });

                const doneTasks = loadTaskQueue();
                const doneIdx = doneTasks.findIndex((task) => task.id === next.id);
                if (doneIdx >= 0) {
                    doneTasks[doneIdx].status = 'completed';
                    doneTasks[doneIdx].updatedAt = Date.now();
                    doneTasks[doneIdx].completedAt = Date.now();
                    doneTasks[doneIdx].sessionKey = spawn.sessionKey || spawn.data?.sessionKey || null;
                    doneTasks[doneIdx].runId = spawn.runId || spawn.data?.runId || null;
                    doneTasks[doneIdx].result = JSON.stringify({
                        method: spawn.usedMethod,
                        sessionKey: doneTasks[doneIdx].sessionKey,
                        runId: doneTasks[doneIdx].runId
                    }, null, 2);
                    saveTaskQueue(doneTasks);
                }
            } catch (error) {
                const failTasks = loadTaskQueue();
                const failIdx = failTasks.findIndex((task) => task.id === next.id);
                if (failIdx >= 0) {
                    failTasks[failIdx].status = 'failed';
                    failTasks[failIdx].updatedAt = Date.now();
                    failTasks[failIdx].completedAt = Date.now();
                    failTasks[failIdx].error = compactErrorMessage(error);
                    saveTaskQueue(failTasks);
                }
            }

            scheduleRefresh();
            await sleep(500);
        }
    } finally {
        queueProcessing = false;
    }
}

async function monitorTaskCompletion(taskId, sessionKey, startedAt) {
    if (!sessionKey) return;

    const maxRounds = 20;
    for (let i = 0; i < maxRounds; i += 1) {
        await sleep(3500);

        try {
            const history = await callGatewayAlias('sessions_history', {
                sessionKey,
                limit: 40
            }, { timeoutMs: 10000 });

            const messages = normalizeHistory(history.data);
            const latestAssistant = [...messages]
                .reverse()
                .find((msg) => msg.role === 'assistant' && msg.timestamp >= (startedAt - 3000));

            if (!latestAssistant) {
                continue;
            }

            const tasks = loadTasks();
            const idx = tasks.findIndex((task) => task.id === taskId);
            if (idx < 0) return;

            if (tasks[idx].status === 'running') {
                tasks[idx].status = 'done';
                tasks[idx].updatedAt = Date.now();
                tasks[idx].completedAt = Date.now();
                tasks[idx].output = latestAssistant.text || '(无文本输出)';
                tasks[idx].logs = tasks[idx].logs || [];
                tasks[idx].logs.push({ time: Date.now(), msg: '会话返回结果，任务完成。' });
                saveTasks(tasks);
                scheduleRefresh();
            }
            return;
        } catch (_) {
            // ignore one round failure
        }
    }

    const tasks = loadTasks();
    const idx = tasks.findIndex((task) => task.id === taskId);
    if (idx < 0) return;

    if (tasks[idx].status === 'running') {
        tasks[idx].status = 'done';
        tasks[idx].updatedAt = Date.now();
        tasks[idx].completedAt = Date.now();
        tasks[idx].output = tasks[idx].output || '任务已提交到 Gateway，会话仍可能继续运行。';
        tasks[idx].logs = tasks[idx].logs || [];
        tasks[idx].logs.push({ time: Date.now(), msg: '达到监控上限，按提交成功处理。' });
        saveTasks(tasks);
        scheduleRefresh();
    }
}

// ============ 实时事件流 ============

app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const client = {
        id: crypto.randomUUID(),
        res
    };

    sseClients.add(client);

    sseWrite(res, 'connected', {
        clientId: client.id,
        timestamp: nowIso()
    });

    if (monitorCache.gateway) sseWrite(res, 'gateway_status', monitorCache.gateway);
    if (monitorCache.sessions) sseWrite(res, 'sessions_update', { sessions: monitorCache.sessions, count: monitorCache.sessions.length, timestamp: nowIso() });
    if (monitorCache.tasks) sseWrite(res, 'tasks_update', { tasks: monitorCache.tasks, count: monitorCache.tasks.length, timestamp: nowIso() });
    if (monitorCache.dashboard) sseWrite(res, 'dashboard_update', monitorCache.dashboard);

    const keepAliveTimer = setInterval(() => {
        sseWrite(res, 'heartbeat', { timestamp: nowIso() });
    }, SSE_KEEPALIVE_MS);

    req.on('close', () => {
        clearInterval(keepAliveTimer);
        sseClients.delete(client);
    });
});

// ============ 状态与仪表盘 ============

app.get('/api/status', async (req, res) => {
    const status = await fetchGatewayStatus();
    res.json({
        ...status,
        realtimeClients: sseClients.size
    });
});

app.post('/api/gateway/connect', async (req, res) => {
    try {
        const result = await connectGateway();
        refreshStateAndBroadcast().catch((error) => {
            console.error('[gateway] refresh after connect failed:', compactErrorMessage(error));
        });

        if (result.connected) {
            return res.json(result);
        }

        return res.status(500).json({
            ...result,
            error: `Gateway 未连接（端口 ${result.gatewayPort}）`
        });
    } catch (error) {
        return res.status(500).json({
            error: compactErrorMessage(error)
        });
    }
});

app.get('/api/dashboard', async (req, res) => {
    try {
        await refreshStateAndBroadcast();
        res.json(monitorCache.dashboard || buildDashboardSnapshot({
            gatewayStatus: monitorCache.gateway,
            sessions: monitorCache.sessions,
            tasks: sortTasks(loadTasks()),
            queueTasks: sortQueueTasks(loadTaskQueue())
        }));
    } catch (error) {
        res.status(500).json({ error: compactErrorMessage(error) });
    }
});

// ============ 任务管理 ============

app.get('/api/tasks', (req, res) => {
    res.json({ tasks: sortTasks(loadTasks()) });
});

app.post('/api/tasks', (req, res) => {
    const title = String(req.body.title || '').trim();
    if (!title) {
        return res.status(400).json({ error: '标题不能为空' });
    }

    const tasks = loadTasks();
    const task = {
        id: `task-${Date.now()}`,
        title,
        description: String(req.body.description || '').trim(),
        priority: req.body.priority || '🟡 中',
        status: req.body.status || 'pending',
        agentId: req.body.agentId || 'main',
        model: req.body.model || 'minimax-cn/MiniMax-M2.5',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        logs: []
    };

    tasks.push(task);
    saveTasks(tasks);
    scheduleRefresh();

    res.json({ success: true, task });
});

app.patch('/api/tasks/:id', (req, res) => {
    const id = req.params.id;
    const tasks = loadTasks();
    const idx = tasks.findIndex((task) => task.id === id);

    if (idx < 0) {
        return res.status(404).json({ error: '任务不存在' });
    }

    const editableFields = ['title', 'description', 'priority', 'status', 'logs', 'agentId', 'model', 'output'];
    for (const field of editableFields) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
            tasks[idx][field] = req.body[field];
        }
    }

    tasks[idx].updatedAt = Date.now();
    saveTasks(tasks);
    scheduleRefresh();

    return res.json({ success: true, task: tasks[idx] });
});

app.delete('/api/tasks/:id', (req, res) => {
    const id = req.params.id;
    const tasks = loadTasks();
    const idx = tasks.findIndex((task) => task.id === id);

    if (idx < 0) {
        return res.status(404).json({ error: '任务不存在' });
    }

    tasks.splice(idx, 1);
    saveTasks(tasks);
    scheduleRefresh();

    return res.json({ success: true });
});

app.post('/api/tasks/:id/execute', async (req, res) => {
    const id = req.params.id;
    const tasks = loadTasks();
    const idx = tasks.findIndex((task) => task.id === id);

    if (idx < 0) {
        return res.status(404).json({ error: '任务不存在' });
    }

    const task = tasks[idx];
    task.status = 'running';
    task.startedAt = Date.now();
    task.updatedAt = Date.now();
    task.logs = task.logs || [];
    task.logs.push({ time: Date.now(), msg: '通过 Gateway RPC 提交任务...' });

    saveTasks(tasks);
    scheduleRefresh();

    res.json({ success: true, task, message: '任务已提交' });

    (async () => {
        try {
            const spawn = await callGatewayAlias('sessions_spawn', {
                task: task.description || task.title,
                agentId: task.agentId,
                model: task.model,
                label: `task-${task.id.slice(-6)}`,
                timeout: 300
            }, { timeoutMs: 20000 });

            const afterSpawn = loadTasks();
            const tIdx = afterSpawn.findIndex((entry) => entry.id === id);
            if (tIdx >= 0) {
                afterSpawn[tIdx].sessionKey = spawn.sessionKey || spawn.data?.sessionKey || null;
                afterSpawn[tIdx].runId = spawn.runId || spawn.data?.runId || null;
                afterSpawn[tIdx].updatedAt = Date.now();
                afterSpawn[tIdx].logs = afterSpawn[tIdx].logs || [];
                afterSpawn[tIdx].logs.push({
                    time: Date.now(),
                    msg: `会话已创建: ${afterSpawn[tIdx].sessionKey || 'unknown'} (${spawn.usedMethod})`
                });
                saveTasks(afterSpawn);
                scheduleRefresh();

                monitorTaskCompletion(id, afterSpawn[tIdx].sessionKey, afterSpawn[tIdx].startedAt).catch((error) => {
                    console.error('[tasks] monitor failed:', compactErrorMessage(error));
                });
            }
        } catch (error) {
            const failed = loadTasks();
            const tIdx = failed.findIndex((entry) => entry.id === id);
            if (tIdx >= 0) {
                failed[tIdx].status = 'failed';
                failed[tIdx].updatedAt = Date.now();
                failed[tIdx].completedAt = Date.now();
                failed[tIdx].logs = failed[tIdx].logs || [];
                failed[tIdx].logs.push({ time: Date.now(), msg: `提交失败: ${compactErrorMessage(error)}` });
                failed[tIdx].output = compactErrorMessage(error);
                saveTasks(failed);
                scheduleRefresh();
            }
        }
    })();
});

// ============ 会话管理（Gateway RPC） ============

app.get('/api/sessions', async (req, res) => {
    try {
        const limit = parseInteger(req.query.limit, 250, 1, 500);
        const sessions = await fetchSessionsSafe(limit);

        res.json({
            sessions,
            total: sessions.length,
            timestamp: nowIso(),
            rpc: {
                alias: 'sessions_list',
                methods: ['sessions_list', 'sessions.list']
            }
        });
    } catch (error) {
        res.status(500).json({ error: compactErrorMessage(error), sessions: [] });
    }
});

app.get('/api/sessions/:key/history', async (req, res) => {
    try {
        const key = decodeURIComponent(req.params.key);
        const limit = parseInteger(req.query.limit, 120, 1, 1000);

        const history = await callGatewayAlias('sessions_history', {
            sessionKey: key,
            limit
        }, { timeoutMs: 12000 });

        const messages = normalizeHistory(history.data);

        res.json({
            key,
            usedMethod: history.usedMethod,
            messages
        });
    } catch (error) {
        res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.post('/api/sessions/send', async (req, res) => {
    try {
        const message = String(req.body.message || '').trim();
        const sessionKey = req.body.sessionKey || req.body.key;

        if (!sessionKey || !message) {
            return res.status(400).json({ error: 'sessionKey 和 message 不能为空' });
        }

        const send = await callGatewayAlias('sessions_send', {
            sessionKey,
            message,
            thinking: req.body.thinking,
            deliver: req.body.deliver,
            timeoutMs: req.body.timeoutMs
        }, { timeoutMs: 20000 });

        scheduleRefresh();

        return res.json({
            success: true,
            usedMethod: send.usedMethod,
            result: send.data
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.post('/api/sessions/spawn', async (req, res) => {
    try {
        const task = String(req.body.task || '').trim();
        if (!task) {
            return res.status(400).json({ error: 'task 不能为空' });
        }

        const spawn = await callGatewayAlias('sessions_spawn', {
            task,
            agentId: req.body.agentId,
            label: req.body.label,
            model: req.body.model,
            timeout: req.body.timeout
        }, { timeoutMs: 20000 });

        scheduleRefresh();

        return res.json({
            success: true,
            usedMethod: spawn.usedMethod,
            sessionKey: spawn.sessionKey || spawn.data?.sessionKey || spawn.data?.key || null,
            runId: spawn.runId || spawn.data?.runId || null,
            result: spawn.data
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.post('/api/sessions/kill', async (req, res) => {
    try {
        const sessionKey = String(req.body.sessionKey || req.body.key || '').trim();
        if (!sessionKey) {
            return res.status(400).json({ error: 'sessionKey 不能为空' });
        }

        const kill = await callGatewayAlias('sessions_kill', {
            sessionKey,
            deleteTranscript: req.body.deleteTranscript
        }, { timeoutMs: 15000 });

        scheduleRefresh();

        return res.json({
            success: true,
            usedMethod: kill.usedMethod,
            result: kill.data
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.post('/api/sessions/:key/kill', async (req, res) => {
    try {
        const sessionKey = decodeURIComponent(req.params.key);
        if (!sessionKey) {
            return res.status(400).json({ error: 'sessionKey 不能为空' });
        }

        const kill = await callGatewayAlias('sessions_kill', {
            sessionKey,
            deleteTranscript: req.body?.deleteTranscript
        }, { timeoutMs: 15000 });

        scheduleRefresh();

        return res.json({
            success: true,
            usedMethod: kill.usedMethod,
            result: kill.data
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.patch('/api/sessions/:key', async (req, res) => {
    try {
        const key = decodeURIComponent(req.params.key);
        const patch = { key };

        if (Object.prototype.hasOwnProperty.call(req.body, 'label')) patch.label = req.body.label;
        if (Object.prototype.hasOwnProperty.call(req.body, 'model')) patch.model = req.body.model;
        if (Object.prototype.hasOwnProperty.call(req.body, 'thinkingLevel')) patch.thinkingLevel = req.body.thinkingLevel;

        const result = await runGatewayCall('sessions.patch', patch, { timeoutMs: 12000 });
        scheduleRefresh();

        res.json({
            success: true,
            usedMethod: 'sessions.patch',
            result: result.data
        });
    } catch (error) {
        res.status(500).json({ error: compactErrorMessage(error) });
    }
});

// ============ 元数据 ============

app.get('/api/agents', async (req, res) => {
    try {
        const result = await runGatewayCall('agents.list', {}, { timeoutMs: 10000 });
        const agents = Array.isArray(result.data?.agents)
            ? result.data.agents
            : Array.isArray(result.data)
                ? result.data
                : [];

        if (agents.length) {
            return res.json({
                agents: agents.map((agent) => ({
                    id: agent.agentId || agent.id || 'unknown',
                    name: agent.name || agent.agentId || agent.id || 'Unknown Agent',
                    desc: agent.description || agent.desc || ''
                }))
            });
        }
    } catch (_) {
        // fallback
    }

    return res.json({
        agents: [
            { id: 'main', name: 'Main Agent', desc: '默认主代理' }
        ]
    });
});

function toModelList(payload) {
    if (Array.isArray(payload?.models)) return payload.models;
    if (Array.isArray(payload)) return payload;
    return [];
}

function collectConfigProviderModels(payload) {
    const list = [];
    const providers = payload?.providers && typeof payload.providers === 'object'
        ? payload.providers
        : {};

    for (const [providerId, providerConfig] of Object.entries(providers)) {
        const providerModels = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
        for (const model of providerModels) {
            list.push({
                ...(model || {}),
                provider: providerId
            });
        }
    }

    return list;
}

function normalizeModelEntry(model, options = {}) {
    if (!model || typeof model !== 'object') return null;

    const provider = String(
        model.provider ||
        model.vendor ||
        options.provider ||
        ''
    ).trim();

    const rawId = String(model.id || model.name || '').trim();
    if (!rawId) return null;

    const hasProviderPrefix = rawId.includes('/');
    const modelId = hasProviderPrefix
        ? rawId
        : (provider ? `${provider}/${rawId}` : rawId);

    return {
        id: modelId,
        name: String(model.label || model.name || rawId).trim() || rawId,
        provider: provider || (hasProviderPrefix ? rawId.split('/')[0] : 'unknown')
    };
}

function mergeModelEntries(...groups) {
    const dedup = new Map();

    for (const group of groups) {
        const list = Array.isArray(group) ? group : [];
        for (const model of list) {
            const normalized = normalizeModelEntry(model);
            if (!normalized) continue;
            if (!dedup.has(normalized.id)) {
                dedup.set(normalized.id, normalized);
            }
        }
    }

    return [...dedup.values()]
        .sort((a, b) => {
            const providerCmp = String(a.provider || '').localeCompare(String(b.provider || ''));
            if (providerCmp !== 0) return providerCmp;
            return String(a.id || '').localeCompare(String(b.id || ''));
        })
        .slice(0, 500);
}

function decodeAndSanitizeSkillName(rawValue) {
    let decoded = String(rawValue || '');
    try {
        decoded = decodeURIComponent(decoded);
    } catch (_) {
        // keep raw value
    }

    const name = decoded.trim();
    if (!name) return '';
    if (name.length > 160) return '';
    if (/[/\\\0\r\n]/.test(name)) return '';
    return name;
}

function normalizeSkillList(payload) {
    const list = Array.isArray(payload?.skills)
        ? payload.skills
        : (Array.isArray(payload) ? payload : []);

    return list
        .map((skill) => ({
            name: String(skill?.name || '').trim(),
            description: String(skill?.description || '').trim(),
            source: String(skill?.source || 'unknown').trim() || 'unknown',
            eligible: !!skill?.eligible,
            disabled: !!skill?.disabled,
            blockedByAllowlist: !!skill?.blockedByAllowlist,
            bundled: !!skill?.bundled,
            missing: skill?.missing && typeof skill.missing === 'object'
                ? skill.missing
                : { bins: [], anyBins: [], env: [], config: [], os: [] }
        }))
        .filter((skill) => !!skill.name)
        .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeSkillInfo(skillInfo) {
    if (!skillInfo || typeof skillInfo !== 'object') return null;
    return {
        name: String(skillInfo.name || '').trim(),
        description: String(skillInfo.description || '').trim(),
        source: String(skillInfo.source || 'unknown').trim() || 'unknown',
        bundled: !!skillInfo.bundled,
        eligible: !!skillInfo.eligible,
        disabled: !!skillInfo.disabled,
        blockedByAllowlist: !!skillInfo.blockedByAllowlist,
        baseDir: skillInfo.baseDir ? String(skillInfo.baseDir).trim() : null,
        filePath: skillInfo.filePath ? String(skillInfo.filePath).trim() : null,
        skillKey: skillInfo.skillKey ? String(skillInfo.skillKey).trim() : null,
        requirements: skillInfo.requirements && typeof skillInfo.requirements === 'object'
            ? skillInfo.requirements
            : { bins: [], anyBins: [], env: [], config: [], os: [] },
        missing: skillInfo.missing && typeof skillInfo.missing === 'object'
            ? skillInfo.missing
            : { bins: [], anyBins: [], env: [], config: [], os: [] }
    };
}

async function fetchSkillInfo(skillName) {
    const result = await runOpenclawCommand(['skills', 'info', skillName, '--json'], { timeoutMs: 16000 });
    const parsed = result?.data ?? extractJsonFromOutput(result?.raw);
    const skillInfo = normalizeSkillInfo(parsed);
    if (!skillInfo || !skillInfo.name) {
        throw new Error('未获取到技能详情');
    }
    return skillInfo;
}

function resolveSkillFilePath(skillInfo) {
    const baseDirRaw = String(skillInfo?.baseDir || '').trim();
    const filePathRaw = String(skillInfo?.filePath || '').trim();

    const baseDir = baseDirRaw ? path.resolve(baseDirRaw) : '';
    let filePath = filePathRaw
        ? path.resolve(filePathRaw)
        : (baseDir ? path.join(baseDir, 'SKILL.md') : '');

    if (!filePath) {
        throw new Error('技能文件路径不可用');
    }

    if (baseDir && filePath !== baseDir && !filePath.startsWith(`${baseDir}${path.sep}`)) {
        throw new Error('技能文件路径越界');
    }

    if (path.basename(filePath).toLowerCase() !== 'skill.md') {
        throw new Error('仅支持编辑技能主文件 SKILL.md');
    }

    return filePath;
}

app.get('/api/skills', async (req, res) => {
    try {
        const result = await runOpenclawCommand(['skills', 'list', '--json'], { timeoutMs: 22000 });
        const parsed = result?.data ?? extractJsonFromOutput(result?.raw) ?? {};
        const skills = normalizeSkillList(parsed);

        return res.json({
            skills,
            total: skills.length,
            workspaceDir: parsed?.workspaceDir || null,
            managedSkillsDir: parsed?.managedSkillsDir || null,
            timestamp: nowIso()
        });
    } catch (error) {
        return res.status(500).json({
            error: compactErrorMessage(error),
            skills: []
        });
    }
});

app.get('/api/skills/:name', async (req, res) => {
    try {
        const skillName = decodeAndSanitizeSkillName(req.params.name);
        if (!skillName) {
            return res.status(400).json({ error: 'skill 名称不合法' });
        }

        const skillInfo = await fetchSkillInfo(skillName);
        const filePath = resolveSkillFilePath(skillInfo);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: `技能文件不存在: ${filePath}` });
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const stat = fs.statSync(filePath);
        return res.json({
            skill: {
                ...skillInfo,
                filePath,
                updatedAt: stat.mtimeMs
            },
            content,
            contentBytes: Buffer.byteLength(content, 'utf8'),
            timestamp: nowIso()
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.patch('/api/skills/:name', async (req, res) => {
    try {
        const skillName = decodeAndSanitizeSkillName(req.params.name);
        if (!skillName) {
            return res.status(400).json({ error: 'skill 名称不合法' });
        }

        if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'content')) {
            return res.status(400).json({ error: 'content 不能为空' });
        }

        const content = String(req.body.content ?? '');
        const contentBytes = Buffer.byteLength(content, 'utf8');
        if (contentBytes > 3 * 1024 * 1024) {
            return res.status(400).json({ error: 'content 过大（最大 3MB）' });
        }

        const skillInfo = await fetchSkillInfo(skillName);
        const filePath = resolveSkillFilePath(skillInfo);
        fs.writeFileSync(filePath, content, 'utf8');
        const stat = fs.statSync(filePath);

        return res.json({
            success: true,
            name: skillName,
            filePath,
            bytes: contentBytes,
            updatedAt: stat.mtimeMs,
            timestamp: nowIso()
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.get('/api/models', async (req, res) => {
    const sources = [];

    try {
        const result = await runGatewayCall('models.list', {}, { timeoutMs: 10000 });
        sources.push(toModelList(result.data));
    } catch (_) {
        // keep collecting from fallback sources
    }

    try {
        const config = await runOpenclawCommand(['config', 'get', 'models', '--json'], { timeoutMs: 8000 });
        sources.push(collectConfigProviderModels(config.data));
    } catch (_) {
        // keep collecting from fallback sources
    }

    const mergedModels = mergeModelEntries(...sources);
    if (mergedModels.length) {
        return res.json({ models: mergedModels });
    }

    return res.json({
        models: [
            { id: 'minimax-cn/MiniMax-M2.5', name: 'MiniMax M2.5', provider: 'minimax-cn' },
            { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
            { id: 'kimi-coding/k2p5', name: 'Kimi K2.5', provider: 'kimi-coding' }
        ]
    });
});

app.get('/api/rpc/methods', (req, res) => {
    res.json({
        aliases: {
            sessions_list: ['sessions_list', 'sessions.list'],
            sessions_spawn: ['sessions_spawn', 'sessions.spawn', 'agent(+sessions.patch)'],
            sessions_send: ['sessions_send', 'chat.send'],
            sessions_history: ['sessions_history', 'chat.history'],
            sessions_kill: ['sessions_kill', 'sessions.delete', 'sessions.reset']
        },
        timestamp: nowIso()
    });
});

// ============ 任务队列 ============

app.get('/api/queue', (req, res) => {
    res.json({ tasks: sortQueueTasks(loadTaskQueue()) });
});

app.post('/api/queue', (req, res) => {
    const title = String(req.body.title || '').trim();
    if (!title) {
        return res.status(400).json({ error: '标题不能为空' });
    }

    const tasks = loadTaskQueue();
    tasks.push({
        id: `q_${Date.now()}`,
        title,
        description: String(req.body.description || '').trim(),
        priority: req.body.priority || '🟡',
        model: req.body.model || 'minimax-cn/MiniMax-M2.5',
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: null,
        completedAt: null,
        result: '',
        error: ''
    });

    saveTaskQueue(tasks);
    scheduleRefresh();
    processTaskQueue().catch((error) => {
        console.error('[queue] process failed:', compactErrorMessage(error));
    });

    return res.json({ success: true });
});

app.delete('/api/queue/:id', (req, res) => {
    const id = req.params.id;
    const tasks = loadTaskQueue().filter((task) => task.id !== id);
    saveTaskQueue(tasks);
    scheduleRefresh();

    return res.json({ success: true });
});

app.post('/api/queue/process', async (req, res) => {
    processTaskQueue().catch((error) => {
        console.error('[queue] process failed:', compactErrorMessage(error));
    });

    return res.json({ success: true });
});

// ============ 页面与错误处理 ============

app.get('/', (req, res) => {
    if (!fs.existsSync(HTML_FILE)) {
        return res.status(404).send('public.html not found');
    }
    return res.sendFile(HTML_FILE);
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ============ 启动 ============

app.listen(PORT, async () => {
    console.log(`🦞 OpenClaw Console 运行在端口 ${PORT}`);
    console.log(`   访问: http://localhost:${PORT}`);
    console.log(`   认证: ${AUTH_USER} / ${AUTH_PASS}`);

    try {
        await refreshStateAndBroadcast();
    } catch (error) {
        console.error('[startup] initial refresh failed:', compactErrorMessage(error));
    }

    console.log(`   Gateway: ${monitorCache.gateway.status === 'connected' ? '✅ 已连接' : '❌ 未连接'}`);

    setInterval(() => {
        refreshStateAndBroadcast().catch((error) => {
            console.error('[monitor] interval refresh failed:', compactErrorMessage(error));
        });
    }, MONITOR_INTERVAL_MS);

    setTimeout(() => {
        processTaskQueue().catch((error) => {
            console.error('[queue] initial process failed:', compactErrorMessage(error));
        });
    }, 2000);
});
