#!/usr/bin/env node
/**
 * OpenClaw Console - Gateway RPC 深度整合版
 * Port: 8200
 * Auth: Basic Auth (set via env CONSOLE_AUTH_USER / CONSOLE_AUTH_PASS)
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
const EXECUTION_QUEUE_FILE = path.join(__dirname, 'execution-queue.json');
const SUBAGENTS_LOCAL_FILE = path.join(__dirname, 'subagents-local.json');
const SUBAGENTS_GATEWAY_META_FILE = path.join(__dirname, 'subagents-gateway-meta.json');

const AUTH_USER = String(process.env.CONSOLE_AUTH_USER || 'admin');
const AUTH_PASS = String(process.env.CONSOLE_AUTH_PASS || 'QJn81u581sX1jecx');

const GATEWAY_CALL_TIMEOUT_MS = 12000;
const GATEWAY_CLI_OVERHEAD_MS = 30000;
const MONITOR_INTERVAL_MS = 4000;
const SSE_KEEPALIVE_MS = 15000;
const GATEWAY_START_TIMEOUT_MS = 12000;
const DEFAULT_GATEWAY_PORT = 18789;
const GATEWAY_PORT_CACHE_TTL_MS = 60000;
const AUTO_CONTINUE_PLACEHOLDER_RE = /^continue where you left off\. the previous model attempt failed or timed out\.?$/i;
const CONSOLE_PROFILE_BLOCK_START = '<!-- OPENCLAW_CONSOLE_PROFILE:START -->';
const CONSOLE_PROFILE_BLOCK_END = '<!-- OPENCLAW_CONSOLE_PROFILE:END -->';
const GATEWAY_WORKSPACE_FILE_MAP = Object.freeze({
    identityMd: 'IDENTITY.md',
    soulMd: 'SOUL.md',
    userMd: 'USER.md',
    memoryMd: 'MEMORY.md'
});
const GATEWAY_WORKSPACE_FILE_MAX_CHARS = 500000;
const GATEWAY_MEMORY_FILE_RE = /^[A-Za-z0-9._-]{1,120}\.md$/;

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
        res.setHeader('WWW-Authenticate', 'Basic realm="OpenClaw Console", charset="UTF-8"');
        return res.status(401).send('Authentication required');
    }

    try {
        const [scheme, token] = String(auth).trim().split(/\s+/, 2);
        if (!/^basic$/i.test(scheme) || !token) {
            throw new Error('invalid authorization scheme');
        }
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        const separatorIndex = decoded.indexOf(':');
        if (separatorIndex < 0) {
            throw new Error('invalid basic token');
        }
        const username = decoded.slice(0, separatorIndex);
        const password = decoded.slice(separatorIndex + 1);
        if (username === AUTH_USER && password === AUTH_PASS) {
            return next();
        }
    } catch (_) {
        // ignore
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="OpenClaw Console", charset="UTF-8"');
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

function loadExecutionQueue() {
    const tasks = safeReadJson(EXECUTION_QUEUE_FILE, []);
    return Array.isArray(tasks) ? tasks : [];
}

function saveExecutionQueue(tasks) {
    safeWriteJson(EXECUTION_QUEUE_FILE, tasks);
}

function loadLocalSubagents() {
    const items = safeReadJson(SUBAGENTS_LOCAL_FILE, []);
    return Array.isArray(items) ? items : [];
}

function saveLocalSubagents(items) {
    safeWriteJson(SUBAGENTS_LOCAL_FILE, items);
}

function loadGatewaySubagentMeta() {
    const items = safeReadJson(SUBAGENTS_GATEWAY_META_FILE, []);
    return Array.isArray(items) ? items : [];
}

function saveGatewaySubagentMeta(items) {
    safeWriteJson(SUBAGENTS_GATEWAY_META_FILE, items);
}

function normalizePriority(rawValue) {
    const raw = String(rawValue || '').trim().toLowerCase();
    if (!raw) return '🟡 中';

    if (raw.includes('🔴') || raw === 'high' || raw === 'p0' || raw === 'p1' || raw.includes('高')) {
        return '🔴 高';
    }
    if (raw.includes('🟢') || raw === 'low' || raw === 'p3' || raw.includes('低')) {
        return '🟢 低';
    }
    if (raw.includes('🟡') || raw === 'medium' || raw === 'normal' || raw === 'p2' || raw.includes('中')) {
        return '🟡 中';
    }
    return '🟡 中';
}

function normalizeTaskStatus(rawStatus) {
    const status = String(rawStatus || '').trim().toLowerCase();
    if (!status) return 'pending';

    if (status === 'todo' || status === 'new' || status === 'created' || status === 'waiting') return 'pending';
    if (status === 'pending') return 'pending';
    if (status === 'queued' || status === 'queue') return 'queued';
    if (status === 'dispatching' || status === 'dispatch') return 'dispatching';
    if (status === 'running' || status === 'in_progress' || status === 'processing') return 'running';
    if (status === 'done' || status === 'completed' || status === 'finished' || status === 'success') return 'done';
    if (status === 'failed' || status === 'error') return 'failed';
    if (status === 'canceled' || status === 'cancelled' || status === 'aborted') return 'canceled';
    return status;
}

function sortTasks(tasks) {
    const priorityOrder = { '🔴 高': 0, '🟡 中': 1, '🟢 低': 2 };
    return [...tasks].sort((a, b) => {
        const pa = priorityOrder[normalizePriority(a.priority)] ?? 3;
        const pb = priorityOrder[normalizePriority(b.priority)] ?? 3;
        if (pa !== pb) return pa - pb;
        return (b.createdAt || 0) - (a.createdAt || 0);
    });
}

function isQueueActiveStatus(status) {
    return ['queued', 'dispatching', 'running'].includes(normalizeExecutionStatus(status));
}

function sortExecutionQueue(tasks) {
    const priorityOrder = { '🔴 高': 0, '🟡 中': 1, '🟢 低': 2 };
    return [...tasks].sort((a, b) => {
        const aActive = isQueueActiveStatus(a.status);
        const bActive = isQueueActiveStatus(b.status);
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;

        if (aActive && bActive) {
            const pa = priorityOrder[normalizePriority(a.priority)] ?? 3;
            const pb = priorityOrder[normalizePriority(b.priority)] ?? 3;
            if (pa !== pb) return pa - pb;
            return (a.createdAt || 0) - (b.createdAt || 0);
        }

        const aDoneAt = a.completedAt || a.updatedAt || a.createdAt || 0;
        const bDoneAt = b.completedAt || b.updatedAt || b.createdAt || 0;
        return bDoneAt - aDoneAt;
    });
}

function sortQueueTasks(tasks) {
    return sortExecutionQueue(tasks);
}

function readTasksForApi() {
    return sortTasks(loadTasks()).map((task) => ({
        ...task,
        status: normalizeTaskStatus(task.status),
        priority: normalizePriority(task.priority)
    }));
}

function ensureExecutionQueueStorage() {
    if (fs.existsSync(EXECUTION_QUEUE_FILE)) return;

    const legacy = loadTaskQueue();
    if (!legacy.length) {
        saveExecutionQueue([]);
        return;
    }

    const migrated = legacy.map((task) => {
        const now = Date.now();
        const status = normalizeExecutionStatus(task.status);

        return {
            id: String(task.id || `eq_${now}_${crypto.randomUUID().slice(0, 8)}`),
            sourceType: 'legacy_queue',
            sourceId: String(task.id || ''),
            title: String(task.title || 'Legacy Queue Task').trim(),
            description: String(task.description || '').trim(),
            priority: normalizePriority(task.priority),
            agentType: 'main',
            agentRef: 'main',
            model: String(task.model || 'minimax-cn/MiniMax-M2.5').trim(),
            status,
            createdAt: parseInteger(task.createdAt, now, 0),
            queuedAt: parseInteger(task.createdAt, now, 0),
            dispatchAt: parseInteger(task.startedAt, 0, 0) || null,
            startedAt: parseInteger(task.startedAt, 0, 0) || null,
            completedAt: parseInteger(task.completedAt, 0, 0) || null,
            updatedAt: parseInteger(task.updatedAt, now, 0),
            sessionKey: task.sessionKey || null,
            runId: task.runId || null,
            result: String(task.result || '').trim(),
            error: String(task.error || '').trim(),
            logs: []
        };
    });

    saveExecutionQueue(migrated);
}

function createExecutionQueueItem(payload = {}) {
    const now = Date.now();
    return {
        id: `eq_${now}_${crypto.randomUUID().slice(0, 8)}`,
        sourceType: String(payload.sourceType || 'manual').trim() || 'manual',
        sourceId: String(payload.sourceId || '').trim(),
        title: String(payload.title || '').trim() || '未命名任务',
        description: String(payload.description || '').trim(),
        priority: normalizePriority(payload.priority),
        agentType: String(payload.agentType || 'main').trim() || 'main',
        agentRef: String(payload.agentRef || 'main').trim() || 'main',
        model: String(payload.model || 'minimax-cn/MiniMax-M2.5').trim() || 'minimax-cn/MiniMax-M2.5',
        status: 'queued',
        createdAt: now,
        queuedAt: now,
        dispatchAt: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
        sessionKey: null,
        runId: null,
        result: '',
        error: '',
        logs: [{
            time: now,
            msg: String(payload.log || '已加入执行队列。')
        }]
    };
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
    const useful = [...lines].reverse().find((line) =>
        /[a-zA-Z0-9\u4e00-\u9fa5]/.test(line) &&
        !/^[│├└┌┐┘┬┴┤├─╭╮╰╯◇]+$/.test(line)
    ) || lines[lines.length - 1];
    return useful.replace(/^Gateway call failed:\s*/i, '').trim();
}

function isUnknownMethodError(error) {
    return /unknown method/i.test(String(error?.message || ''));
}

function isInvalidParamsError(error) {
    const message = String(error?.message || '').toLowerCase();
    return /invalid params|validation|schema|missing required|required property|should have required property|unexpected field|unknown field|unsupported parameter|bad request/.test(message);
}

function isSpawnRetryableError(error) {
    const message = String(error?.message || '').toLowerCase();
    return isInvalidParamsError(error)
        || /invalid model|unknown model|unsupported model|model .* not found/.test(message);
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

function isMainAgent(agentId) {
    return normalizeAgentId(agentId) === 'main';
}

function normalizeGatewayParentAgentId(rawValue) {
    const text = String(rawValue || '').trim();
    if (!text) return null;
    return normalizeAgentId(text);
}

function resolveAgentProfileIdentity(rawIdentity, agentId, fallbackIdentity = '') {
    const explicit = String(rawIdentity || '').trim();
    const fallback = String(fallbackIdentity || '').trim();
    const candidates = explicit ? [explicit, fallback] : [fallback];

    for (const candidate of candidates) {
        const text = String(candidate || '').trim();
        if (!text) continue;
        if (isMainAgent(agentId) && normalizeAgentId(text) === 'main') continue;
        return text;
    }

    return '';
}

function normalizeTaskAgentType(rawType) {
    const type = String(rawType || '').trim().toLowerCase();
    if (type === 'local' || type === 'gateway') return type;
    return 'main';
}

function normalizeTaskAgentRef(agentType, rawRef) {
    const type = normalizeTaskAgentType(agentType);
    const ref = String(rawRef || '').trim();
    if (type === 'main') {
        return normalizeAgentId(ref || 'main');
    }
    return ref || 'main';
}

function resolveTaskAgentTarget(task = {}, overrides = {}) {
    const hasExplicitType = Object.prototype.hasOwnProperty.call(overrides, 'agentType')
        ? overrides.agentType !== undefined
        : Object.prototype.hasOwnProperty.call(task, 'agentType');
    const sourceType = Object.prototype.hasOwnProperty.call(overrides, 'agentType')
        ? overrides.agentType
        : task.agentType;
    const sourceRef = Object.prototype.hasOwnProperty.call(overrides, 'agentRef')
        ? overrides.agentRef
        : (task.agentRef || task.agentId || 'main');

    let agentType = normalizeTaskAgentType(sourceType);
    let agentRef = normalizeTaskAgentRef(agentType, sourceRef);

    if (!hasExplicitType && agentType === 'main' && !isMainAgent(agentRef)) {
        if (getLocalSubagentById(agentRef)) {
            agentType = 'local';
            agentRef = normalizeTaskAgentRef(agentType, agentRef);
        } else {
            agentType = 'gateway';
            agentRef = normalizeTaskAgentRef(agentType, agentRef);
        }
    }

    return {
        agentType,
        agentRef,
        agentId: agentType === 'main' ? normalizeAgentId(agentRef) : agentRef
    };
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

function escapeRegex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildConsoleProfileBlock(profile = {}) {
    const identity = String(profile.identity || profile.name || '').trim() || 'Agent';
    const personality = String(profile.personality || '').trim();
    const memoryLong = String(profile.memoryLong || '').trim();
    const emoji = String(profile.emoji || '').trim();

    const lines = [
        CONSOLE_PROFILE_BLOCK_START,
        '## Console Profile (Auto-Generated)',
        `- Name: ${identity}`,
        `- Personality: ${personality || '(not set)'}`,
        `- Emoji: ${emoji || '(not set)'}`,
        '',
        '### Long-term Memory',
        memoryLong || '(not set)',
        CONSOLE_PROFILE_BLOCK_END
    ];

    return `${lines.join('\n')}\n`;
}

function upsertConsoleProfileBlock(rawText, block) {
    const text = String(rawText || '');
    const pattern = new RegExp(
        `${escapeRegex(CONSOLE_PROFILE_BLOCK_START)}[\\s\\S]*?${escapeRegex(CONSOLE_PROFILE_BLOCK_END)}\\n?`,
        'm'
    );

    if (pattern.test(text)) {
        return text.replace(pattern, `${block}\n`);
    }

    if (!text.trim()) {
        return block;
    }

    return `${block}\n${text}`;
}

function syncGatewayWorkspaceProfile(workspace, profile = {}) {
    const root = String(workspace || '').trim();
    if (!root) return;

    const identityPath = path.join(root, 'IDENTITY.md');
    const soulPath = path.join(root, 'SOUL.md');
    const bootstrapPath = path.join(root, 'BOOTSTRAP.md');
    const block = buildConsoleProfileBlock(profile);

    const targets = [identityPath, soulPath];
    for (const filePath of targets) {
        let current = '';
        try {
            if (fs.existsSync(filePath)) {
                current = fs.readFileSync(filePath, 'utf8');
            }
        } catch (_) {
            current = '';
        }

        const next = upsertConsoleProfileBlock(current, block);
        fs.writeFileSync(filePath, next, 'utf8');
    }

    try {
        if (fs.existsSync(bootstrapPath)) {
            fs.rmSync(bootstrapPath, { force: true });
        }
    } catch (_) {
        // ignore bootstrap cleanup failure
    }
}

async function resolveGatewayWorkspaceById(agentId) {
    const id = String(agentId || '').trim();
    if (!id) return null;
    const gatewayAgents = await listGatewayAgentsViaCli();
    const target = gatewayAgents.find((item) => item.id === id);
    const workspace = String(target?.workspace || '').trim();
    if (!workspace) return null;
    return workspace;
}

function readGatewayWorkspaceFiles(workspace) {
    const root = String(workspace || '').trim();
    if (!root) return {};
    const files = {};

    for (const [key, filename] of Object.entries(GATEWAY_WORKSPACE_FILE_MAP)) {
        const fullPath = path.join(root, filename);
        try {
            files[key] = fs.existsSync(fullPath)
                ? fs.readFileSync(fullPath, 'utf8')
                : '';
        } catch (error) {
            throw new Error(`读取文件失败 ${filename}: ${compactErrorMessage(error)}`);
        }
    }

    return files;
}

function writeGatewayWorkspaceFiles(workspace, payloadFiles = {}) {
    const root = String(workspace || '').trim();
    if (!root) throw new Error('workspace 为空');
    const changed = [];

    for (const [key, filename] of Object.entries(GATEWAY_WORKSPACE_FILE_MAP)) {
        if (!Object.prototype.hasOwnProperty.call(payloadFiles, key)) continue;
        const content = String(payloadFiles[key] ?? '');
        if (content.length > GATEWAY_WORKSPACE_FILE_MAX_CHARS) {
            throw new Error(`${filename} 超过最大长度限制 ${GATEWAY_WORKSPACE_FILE_MAX_CHARS}`);
        }
        const fullPath = path.join(root, filename);
        fs.writeFileSync(fullPath, content, 'utf8');
        changed.push(filename);
    }

    return changed;
}

function sanitizeGatewayMemoryFilename(rawValue) {
    const name = String(rawValue || '').trim();
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0')) {
        return '';
    }
    if (!GATEWAY_MEMORY_FILE_RE.test(name)) {
        return '';
    }
    return name;
}

function ensureGatewayMemoryDir(workspace) {
    const root = String(workspace || '').trim();
    if (!root) throw new Error('workspace 为空');
    const dir = path.join(root, 'memory');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function listGatewayMemoryFiles(workspace) {
    const dir = ensureGatewayMemoryDir(workspace);
    const files = [];
    const names = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of names) {
        if (!entry.isFile()) continue;
        const name = sanitizeGatewayMemoryFilename(entry.name);
        if (!name) continue;
        const fullPath = path.join(dir, name);
        try {
            const stat = fs.statSync(fullPath);
            files.push({
                name,
                size: Number(stat.size || 0),
                updatedAt: stat.mtimeMs ? Math.floor(stat.mtimeMs) : null
            });
        } catch (_) {
            // ignore invalid entry stats
        }
    }

    return files.sort((a, b) => {
        const byUpdated = Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
        if (byUpdated !== 0) return byUpdated;
        return String(b.name || '').localeCompare(String(a.name || ''));
    });
}

function readGatewayMemoryFile(workspace, filename) {
    const name = sanitizeGatewayMemoryFilename(filename);
    if (!name) {
        const error = new Error('memory 文件名不合法');
        error.statusCode = 400;
        throw error;
    }
    const dir = ensureGatewayMemoryDir(workspace);
    const fullPath = path.join(dir, name);
    if (!fs.existsSync(fullPath)) {
        const error = new Error(`memory 文件不存在: ${name}`);
        error.statusCode = 404;
        throw error;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    return {
        name,
        content
    };
}

function writeGatewayMemoryFile(workspace, filename, content) {
    const name = sanitizeGatewayMemoryFilename(filename);
    if (!name) {
        const error = new Error('memory 文件名不合法');
        error.statusCode = 400;
        throw error;
    }
    const text = String(content ?? '');
    if (text.length > GATEWAY_WORKSPACE_FILE_MAX_CHARS) {
        const error = new Error(`memory 文件内容超过最大长度 ${GATEWAY_WORKSPACE_FILE_MAX_CHARS}`);
        error.statusCode = 400;
        throw error;
    }
    const dir = ensureGatewayMemoryDir(workspace);
    const fullPath = path.join(dir, name);
    fs.writeFileSync(fullPath, text, 'utf8');
    const stat = fs.statSync(fullPath);
    return {
        name,
        size: Number(stat.size || 0),
        updatedAt: stat.mtimeMs ? Math.floor(stat.mtimeMs) : null
    };
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
            { method: 'sessions_spawn', map: async (payload) => payload, fallbackOn: isSpawnRetryableError },
            { method: 'sessions.spawn', map: async (payload) => payload, fallbackOn: isSpawnRetryableError },
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

function sanitizeSessionText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildSessionTopic(item = {}) {
    const raw = sanitizeSessionText(
        item.derivedTitle
        || item.title
        || item.lastMessagePreview
        || item.lastUserMessage
        || item.message
        || item.preview
        || ''
    );
    if (!raw) return '';
    return truncateText(raw, 52);
}

function resolveSessionAgentName(key, item = {}, context = {}) {
    const sessionKey = String(key || '');
    if (sessionKey === 'agent:main:main') return 'Main Agent';

    if (sessionKey.includes('feishu:direct:')) {
        const id = sessionKey.split(':').pop();
        return `Feishu ${id === 'commander' ? 'Commander' : id}`;
    }

    if (sessionKey.includes('hook:')) {
        return `Hook ${sessionKey.split(':').pop()}`;
    }

    const agentMatch = sessionKey.match(/^agent:([^:]+)/);
    const subagentMatch = sessionKey.match(/subagent:([^:]+)/);
    const agentId = normalizeAgentId(agentMatch?.[1] || 'main');

    if (subagentMatch && String(subagentMatch[1]).startsWith('local-')) {
        const localSlug = String(subagentMatch[1]).slice('local-'.length);
        const localName = context?.localNameBySlug?.get(localSlug);
        return localName ? `Local ${localName}` : 'Local Agent';
    }

    if (subagentMatch && String(subagentMatch[1]).startsWith('gateway-')) {
        const gatewayName = context?.gatewayNameById?.get(agentId);
        return gatewayName || `Gateway ${agentId}`;
    }

    if (!isMainAgent(agentId)) {
        return context?.gatewayNameById?.get(agentId) || agentId;
    }

    return 'Main Agent';
}

function formatSessionLabel(key, item = {}, context = {}) {
    const agentName = resolveSessionAgentName(key, item, context);
    const explicit = sanitizeSessionText(item.label || item.displayName || '');
    const topic = buildSessionTopic(item);

    if (explicit && explicit !== key && !/^queue-[a-z0-9_-]+$/i.test(explicit)) {
        const text = truncateText(explicit, 52);
        if (text.toLowerCase().startsWith(agentName.toLowerCase() + ' -')) {
            return text;
        }
        return `${agentName} - ${text}`;
    }

    if (topic) {
        return `${agentName} - ${topic}`;
    }

    return agentName;
}

function getSessionKind(key) {
    const text = String(key || '');
    if (text.includes('feishu')) return 'feishu';
    if (text.includes('hook')) return 'hook';
    if (text.includes('subagent')) return 'subagent';
    return 'main';
}

function normalizeSessionItems(payload) {
    const sessions = Array.isArray(payload?.sessions)
        ? payload.sessions
        : Array.isArray(payload?.recent)
            ? payload.recent
            : [];

    const localNameBySlug = new Map(
        loadLocalSubagents().map((item) => [
            slugify(item?.id, 'local'),
            String(item?.name || item?.identity || item?.id || '').trim() || String(item?.id || '')
        ])
    );
    const gatewayNameById = new Map(
        loadGatewaySubagentMeta().map((item) => [
            normalizeAgentId(item?.id || 'main'),
            String(item?.identity || item?.name || item?.id || '').trim() || normalizeAgentId(item?.id || 'main')
        ])
    );

    return sessions.map((item) => {
        const key = item.key || item.sessionKey || item.id;
        const updatedAt = parseInteger(item.updatedAt, Date.now(), 0);
        const lastMessagePreview = truncateText(
            sanitizeSessionText(item.lastMessagePreview || item.lastMessage || item.preview || ''),
            280
        );

        return {
            sessionKey: key,
            label: formatSessionLabel(key, { ...item, lastMessagePreview }, { localNameBySlug, gatewayNameById }),
            kind: getSessionKind(key),
            status: item.deleted ? 'stopped' : 'running',
            model: item.model || null,
            modelProvider: item.modelProvider || null,
            updatedAt,
            age: item.age != null ? item.age : Math.max(0, Date.now() - updatedAt),
            lastMessagePreview
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

function isSyntheticRetryContinuationMessage(role, text) {
    if (String(role || '').trim().toLowerCase() !== 'user') return false;
    return AUTO_CONTINUE_PLACEHOLDER_RE.test(sanitizeSessionText(text));
}

function normalizeHistory(payload) {
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const normalized = [];

    for (let index = 0; index < messages.length; index += 1) {
        const msg = messages[index];
        const timestamp = parseInteger(msg.timestamp, Date.now(), 0);
        const role = msg.role || 'unknown';
        const text = contentToText(msg.content);
        if (isSyntheticRetryContinuationMessage(role, text)) {
            continue;
        }
        normalized.push({
            id: `${timestamp}-${index}`,
            role,
            text,
            timestamp
        });
    }

    return normalized;
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

ensureExecutionQueueStorage();

function buildDashboardSnapshot({ gatewayStatus, sessions, tasks, queueTasks }) {
    const normalizedTasks = (tasks || []).map((task) => ({
        ...task,
        status: normalizeTaskStatus(task.status)
    }));
    const normalizedQueueTasks = (queueTasks || []).map((task) => ({
        ...task,
        status: normalizeExecutionStatus(task.status)
    }));

    const pendingTaskCount = normalizedTasks.filter((task) => ['pending', 'queued', 'dispatching'].includes(task.status)).length;
    const runningTaskCount = normalizedTasks.filter((task) => task.status === 'running').length;

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
            total: normalizedTasks.length,
            pending: pendingTaskCount,
            running: runningTaskCount,
            done: normalizedTasks.filter((task) => task.status === 'done').length,
            failed: normalizedTasks.filter((task) => task.status === 'failed').length
        },
        queueStats: {
            total: normalizedQueueTasks.length,
            pending: normalizedQueueTasks.filter((task) => ['queued', 'dispatching'].includes(task.status)).length,
            running: normalizedQueueTasks.filter((task) => task.status === 'running').length
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
    tasks: readTasksForApi(),
    queueTasks: sortExecutionQueue(loadExecutionQueue()),
    dashboard: null
};

async function refreshStateAndBroadcast() {
    const gatewayStatus = await fetchGatewayStatus();
    const sessions = gatewayStatus.status === 'connected' ? await fetchSessionsSafe(250) : [];
    const tasks = readTasksForApi();
    const queueTasks = readExecutionQueueForApi({ all: '1' });

    const dashboard = buildDashboardSnapshot({
        gatewayStatus,
        sessions,
        tasks,
        queueTasks
    });

    const gatewayHash = hashObject(gatewayStatus);
    const sessionsHash = hashObject(sessions.map((session) => [session.sessionKey, session.updatedAt, session.status]));
    const tasksHash = hashObject(tasks.map((task) => [task.id, task.status, task.updatedAt, task.sessionKey || null]));
    const queueHash = hashObject(queueTasks.map((task) => [task.id, task.status, task.updatedAt, task.sourceId || null]));
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

function slugify(value, fallback = 'subagent') {
    const text = String(value || '').trim().toLowerCase();
    const slug = text
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return slug || fallback;
}

function normalizeExecutionStatus(rawStatus) {
    const status = String(rawStatus || '').trim().toLowerCase();
    if (!status || status === 'pending' || status === 'new' || status === 'created' || status === 'waiting') return 'queued';
    if (status === 'queue' || status === 'queued') return 'queued';
    if (status === 'dispatching' || status === 'dispatch') return 'dispatching';
    if (status === 'running' || status === 'in_progress' || status === 'processing') return 'running';
    if (status === 'completed' || status === 'done' || status === 'finished' || status === 'success') return 'done';
    if (status === 'failed' || status === 'error') return 'failed';
    if (status === 'canceled' || status === 'cancelled' || status === 'aborted') return 'canceled';
    return status;
}

function withTask(taskId, updater) {
    if (!taskId) return null;
    const tasks = loadTasks();
    const idx = tasks.findIndex((task) => task.id === taskId);
    if (idx < 0) return null;

    updater(tasks[idx]);
    tasks[idx].status = normalizeTaskStatus(tasks[idx].status);
    tasks[idx].priority = normalizePriority(tasks[idx].priority);
    tasks[idx].updatedAt = Date.now();
    saveTasks(tasks);
    return tasks[idx];
}

function withExecutionQueueItem(queueId, updater) {
    const queue = loadExecutionQueue();
    const idx = queue.findIndex((item) => item.id === queueId);
    if (idx < 0) return null;

    updater(queue[idx]);
    queue[idx].status = normalizeExecutionStatus(queue[idx].status);
    queue[idx].priority = normalizePriority(queue[idx].priority);
    queue[idx].updatedAt = Date.now();
    saveExecutionQueue(queue);
    return queue[idx];
}

function buildSubagentContext({ identity, personality, memoryLong }) {
    const sections = [];
    if (identity) sections.push(`身份设定: ${identity}`);
    if (personality) sections.push(`个性设定: ${personality}`);
    if (memoryLong) sections.push(`长期记忆:\n${memoryLong}`);
    return sections.join('\n\n').trim();
}

function resolvePersistentSessionKey(agentType, agentRef) {
    if (agentType === 'gateway') {
        const suffix = slugify(agentRef, 'gateway');
        return `agent:${normalizeAgentId(agentRef)}:subagent:gateway-${suffix}`;
    }
    if (agentType === 'local') {
        const suffix = slugify(agentRef, 'local');
        return `agent:main:subagent:local-${suffix}`;
    }
    return `agent:main:subagent:main-${slugify(agentRef || 'default', 'default')}`;
}

function getLocalSubagentById(id) {
    const items = loadLocalSubagents();
    return items.find((item) => item.id === id) || null;
}

function getGatewaySubagentMetaById(id) {
    const items = loadGatewaySubagentMeta();
    return items.find((item) => item.id === id) || null;
}

function updateLocalSubagentSession(id, sessionKey) {
    const items = loadLocalSubagents();
    const idx = items.findIndex((item) => item.id === id);
    if (idx < 0) return;
    items[idx].sessionKey = sessionKey;
    items[idx].updatedAt = Date.now();
    saveLocalSubagents(items);
}

function updateGatewaySubagentMetaSession(id, sessionKey) {
    const items = loadGatewaySubagentMeta();
    const idx = items.findIndex((item) => item.id === id);
    if (idx < 0) return;
    items[idx].sessionKey = sessionKey;
    items[idx].updatedAt = Date.now();
    saveGatewaySubagentMeta(items);
}

function appendQueueLog(queueId, msg) {
    withExecutionQueueItem(queueId, (item) => {
        item.logs = Array.isArray(item.logs) ? item.logs : [];
        item.logs.push({ time: Date.now(), msg });
    });
}

function markTaskFromQueue(taskId, patch = {}, logMsg = '') {
    withTask(taskId, (task) => {
        Object.assign(task, patch);
        task.logs = Array.isArray(task.logs) ? task.logs : [];
        if (logMsg) {
            task.logs.push({ time: Date.now(), msg: logMsg });
        }
    });
}

function buildQueueDispatchPayload(item) {
    const baseTask = String(item.description || item.title || '').trim();
    const payload = {
        task: baseTask,
        label: `queue-${String(item.id || '').slice(-6)}`,
        timeout: 300,
        model: item.model || 'minimax-cn/MiniMax-M2.5'
    };

    if (item.agentType === 'local') {
        const local = getLocalSubagentById(item.agentRef);
        if (!local) {
            throw new Error(`本地子agent不存在: ${item.agentRef}`);
        }
        const context = buildSubagentContext({
            identity: local.identity,
            personality: local.personality,
            memoryLong: local.memoryLong
        });
        payload.agentId = 'main';
        payload.model = item.model || local.defaultModel || payload.model;
        payload.sessionKey = local.sessionKey || resolvePersistentSessionKey('local', local.id);
        payload.task = context
            ? `${context}\n\n用户消息:\n${baseTask}`
            : baseTask;
        return payload;
    }

    if (item.agentType === 'gateway') {
        const meta = getGatewaySubagentMetaById(item.agentRef);
        payload.agentId = normalizeAgentId(item.agentRef || 'main');
        payload.model = item.model || meta?.defaultModel || payload.model;
        payload.sessionKey = meta?.sessionKey || resolvePersistentSessionKey('gateway', item.agentRef);
        // Gateway Agent has its own workspace profile; keep user task raw to avoid prompt conflicts.
        payload.task = baseTask;
        return payload;
    }

    payload.agentId = normalizeAgentId(item.agentRef || 'main');
    return payload;
}

async function monitorExecutionCompletion(queueId, sourceTaskId, sessionKey, startedAt, timeoutSec = 300) {
    if (!sessionKey) {
        withExecutionQueueItem(queueId, (item) => {
            item.status = 'done';
            item.completedAt = Date.now();
            item.result = item.result || '任务已提交，未返回会话 key。';
        });
        if (sourceTaskId) {
            markTaskFromQueue(sourceTaskId, {
                status: 'done',
                completedAt: Date.now(),
                output: '任务已提交到 Gateway。'
            }, '任务执行完成（无会话 key）。');
        }
        scheduleRefresh();
        return;
    }

    const pollIntervalMs = 3500;
    const monitorTimeoutSec = parseInteger(timeoutSec, 300, 30, 1800);
    const maxRounds = Math.max(20, Math.ceil((monitorTimeoutSec * 1000) / pollIntervalMs));
    for (let i = 0; i < maxRounds; i += 1) {
        await sleep(pollIntervalMs);

        try {
            const history = await callGatewayAlias('sessions_history', {
                sessionKey,
                limit: 40
            }, { timeoutMs: 10000 });

            const messages = normalizeHistory(history.data);
            const latestAssistant = [...messages]
                .reverse()
                .find((msg) => msg.role === 'assistant' && msg.timestamp >= (startedAt - 3000));

            if (!latestAssistant) continue;

            withExecutionQueueItem(queueId, (item) => {
                item.status = 'done';
                item.completedAt = Date.now();
                item.result = latestAssistant.text || '(无文本输出)';
                item.logs = Array.isArray(item.logs) ? item.logs : [];
                item.logs.push({ time: Date.now(), msg: '会话返回结果，队列任务完成。' });
            });

            if (sourceTaskId) {
                markTaskFromQueue(sourceTaskId, {
                    status: 'done',
                    completedAt: Date.now(),
                    output: latestAssistant.text || '(无文本输出)'
                }, '会话返回结果，任务完成。');
            }

            scheduleRefresh();
            return;
        } catch (_) {
            // ignore a single polling failure
        }
    }

    withExecutionQueueItem(queueId, (item) => {
        item.status = 'done';
        item.completedAt = Date.now();
        item.result = item.result || `达到监控上限（${monitorTimeoutSec}s），按提交成功处理。`;
        item.logs = Array.isArray(item.logs) ? item.logs : [];
        item.logs.push({ time: Date.now(), msg: `达到监控上限（${monitorTimeoutSec}s），按提交成功处理。` });
    });

    if (sourceTaskId) {
        markTaskFromQueue(sourceTaskId, {
            status: 'done',
            completedAt: Date.now(),
            output: '任务已提交到 Gateway，会话仍可能继续运行。'
        }, `达到监控上限（${monitorTimeoutSec}s），按提交成功处理。`);
    }

    scheduleRefresh();
}

async function processExecutionQueue() {
    if (queueProcessing) return;
    queueProcessing = true;

    try {
        while (true) {
            const all = sortExecutionQueue(loadExecutionQueue());
            const next = all.find((item) => normalizeExecutionStatus(item.status) === 'queued');
            if (!next) break;

            const current = withExecutionQueueItem(next.id, (item) => {
                item.status = 'dispatching';
                item.dispatchAt = Date.now();
                item.logs = Array.isArray(item.logs) ? item.logs : [];
                item.logs.push({ time: Date.now(), msg: '开始分发到 Gateway...' });
            });

            if (!current) {
                await sleep(80);
                continue;
            }

            if (current.sourceType === 'task') {
                markTaskFromQueue(current.sourceId, {
                    status: 'dispatching',
                    startedAt: current.dispatchAt || Date.now()
                }, '任务已进入 dispatching，等待 Gateway 接收。');
            }

            scheduleRefresh();

            try {
                const payload = buildQueueDispatchPayload(current);
                const startedAt = Date.now();
                const monitorTimeoutSec = parseInteger(payload.timeout, 300, 10, 1800);

                withExecutionQueueItem(current.id, (item) => {
                    item.status = 'running';
                    item.startedAt = startedAt;
                    item.logs = Array.isArray(item.logs) ? item.logs : [];
                    item.logs.push({ time: startedAt, msg: '已提交到 Gateway，等待会话响应。' });
                });

                if (current.sourceType === 'task') {
                    markTaskFromQueue(current.sourceId, {
                        status: 'running',
                        startedAt
                    }, '任务已提交到 Gateway，状态更新为 running。');
                }

                const spawn = await callGatewayAlias('sessions_spawn', payload, { timeoutMs: 20000 });
                const sessionKey = spawn.sessionKey || spawn.data?.sessionKey || spawn.data?.key || payload.sessionKey || null;
                const runId = spawn.runId || spawn.data?.runId || null;

                withExecutionQueueItem(current.id, (item) => {
                    item.sessionKey = sessionKey;
                    item.runId = runId;
                    item.result = JSON.stringify({
                        method: spawn.usedMethod,
                        sessionKey,
                        runId
                    }, null, 2);
                    item.logs = Array.isArray(item.logs) ? item.logs : [];
                    item.logs.push({ time: Date.now(), msg: `会话已创建: ${sessionKey || 'unknown'} (${spawn.usedMethod})` });
                });

                if (current.agentType === 'local' && current.agentRef) {
                    updateLocalSubagentSession(current.agentRef, sessionKey);
                }
                if (current.agentType === 'gateway' && current.agentRef) {
                    updateGatewaySubagentMetaSession(current.agentRef, sessionKey);
                }

                if (current.sourceType === 'task') {
                    markTaskFromQueue(current.sourceId, {
                        sessionKey,
                        runId
                    }, `会话已创建: ${sessionKey || 'unknown'} (${spawn.usedMethod})`);
                }

                monitorExecutionCompletion(
                    current.id,
                    current.sourceType === 'task' ? current.sourceId : null,
                    sessionKey,
                    startedAt,
                    monitorTimeoutSec
                ).catch((error) => {
                    console.error('[queue] monitor failed:', compactErrorMessage(error));
                });
            } catch (error) {
                const message = compactErrorMessage(error);
                withExecutionQueueItem(current.id, (item) => {
                    item.status = 'failed';
                    item.error = message;
                    item.completedAt = Date.now();
                    item.logs = Array.isArray(item.logs) ? item.logs : [];
                    item.logs.push({ time: Date.now(), msg: `分发失败: ${message}` });
                });

                if (current.sourceType === 'task') {
                    markTaskFromQueue(current.sourceId, {
                        status: 'failed',
                        completedAt: Date.now(),
                        output: message
                    }, `提交失败: ${message}`);
                }
            }

            scheduleRefresh();
            await sleep(500);
        }
    } finally {
        queueProcessing = false;
    }
}

async function processTaskQueue() {
    return processExecutionQueue();
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
    if (monitorCache.queueTasks) sseWrite(res, 'queue_update', { tasks: monitorCache.queueTasks, count: monitorCache.queueTasks.length, timestamp: nowIso() });
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
            tasks: readTasksForApi(),
            queueTasks: readExecutionQueueForApi({ all: '1' })
        }));
    } catch (error) {
        res.status(500).json({ error: compactErrorMessage(error) });
    }
});

// ============ 任务管理 ============

app.get('/api/tasks', (req, res) => {
    res.json({ tasks: readTasksForApi() });
});

app.post('/api/tasks', (req, res) => {
    const title = String(req.body.title || '').trim();
    if (!title) {
        return res.status(400).json({ error: '标题不能为空' });
    }

    const agentOverrides = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'agentType')) {
        agentOverrides.agentType = req.body.agentType;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'agentRef') || Object.prototype.hasOwnProperty.call(req.body, 'agentId')) {
        agentOverrides.agentRef = req.body.agentRef || req.body.agentId || 'main';
    }
    const resolvedAgent = resolveTaskAgentTarget({ agentId: 'main' }, agentOverrides);

    const tasks = loadTasks();
    const task = {
        id: `task-${Date.now()}`,
        title,
        description: String(req.body.description || '').trim(),
        priority: normalizePriority(req.body.priority),
        status: normalizeTaskStatus(req.body.status || 'pending'),
        agentType: resolvedAgent.agentType,
        agentRef: resolvedAgent.agentRef,
        agentId: resolvedAgent.agentId,
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

    const editableFields = ['title', 'description', 'priority', 'status', 'logs', 'agentId', 'agentType', 'agentRef', 'model', 'output'];
    for (const field of editableFields) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
            if (field === 'agentId' || field === 'agentType' || field === 'agentRef') continue;
            tasks[idx][field] = field === 'priority'
                ? normalizePriority(req.body[field])
                : field === 'status'
                    ? normalizeTaskStatus(req.body[field])
                : req.body[field];
        }
    }

    if (
        Object.prototype.hasOwnProperty.call(req.body, 'agentType')
        || Object.prototype.hasOwnProperty.call(req.body, 'agentRef')
        || Object.prototype.hasOwnProperty.call(req.body, 'agentId')
    ) {
        const agentOverrides = {};
        if (Object.prototype.hasOwnProperty.call(req.body, 'agentType')) {
            agentOverrides.agentType = req.body.agentType;
        }
        if (Object.prototype.hasOwnProperty.call(req.body, 'agentRef') || Object.prototype.hasOwnProperty.call(req.body, 'agentId')) {
            agentOverrides.agentRef = Object.prototype.hasOwnProperty.call(req.body, 'agentRef')
                ? req.body.agentRef
                : req.body.agentId;
        }

        const resolvedAgent = resolveTaskAgentTarget(tasks[idx], agentOverrides);
        tasks[idx].agentType = resolvedAgent.agentType;
        tasks[idx].agentRef = resolvedAgent.agentRef;
        tasks[idx].agentId = resolvedAgent.agentId;
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

    const queue = loadExecutionQueue();
    const nextQueue = queue.filter((item) => !(item.sourceType === 'task' && item.sourceId === id));
    const removedQueueCount = queue.length - nextQueue.length;
    if (removedQueueCount > 0) {
        saveExecutionQueue(nextQueue);
    }

    scheduleRefresh();

    return res.json({ success: true, removedQueueCount });
});

app.post('/api/tasks/:id/execute', async (req, res) => {
    const id = req.params.id;
    const tasks = loadTasks();
    const idx = tasks.findIndex((task) => task.id === id);

    if (idx < 0) {
        return res.status(404).json({ error: '任务不存在' });
    }

    const task = tasks[idx];
    const resolvedAgent = resolveTaskAgentTarget(task);
    const queue = loadExecutionQueue();
    const active = queue.find((item) => item.sourceType === 'task' && item.sourceId === id && isQueueActiveStatus(item.status));
    if (active) {
        return res.status(409).json({
            error: '任务已在执行队列中',
            queueItem: active
        });
    }

    const queueItem = createExecutionQueueItem({
        sourceType: 'task',
        sourceId: id,
        title: task.title,
        description: task.description || task.title,
        priority: task.priority,
        agentType: resolvedAgent.agentType,
        agentRef: resolvedAgent.agentRef,
        model: task.model || 'minimax-cn/MiniMax-M2.5',
        log: '通过任务页触发执行，已进入 queued。'
    });

    queue.push(queueItem);
    saveExecutionQueue(queue);

    task.status = 'queued';
    task.agentType = resolvedAgent.agentType;
    task.agentRef = resolvedAgent.agentRef;
    task.agentId = resolvedAgent.agentId;
    task.startedAt = null;
    task.completedAt = null;
    task.updatedAt = Date.now();
    task.logs = Array.isArray(task.logs) ? task.logs : [];
    task.logs.push({ time: Date.now(), msg: `任务已加入执行队列: ${queueItem.id}` });
    saveTasks(tasks);
    scheduleRefresh();

    processExecutionQueue().catch((error) => {
        console.error('[queue] process failed:', compactErrorMessage(error));
    });

    return res.json({
        success: true,
        task,
        queueItem,
        message: '任务已加入执行队列'
    });
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

// ============ 子Agent看板 ============

app.get('/api/subagents/local', async (req, res) => {
    try {
        const sessions = await fetchSessionsSafe(400);
        const bySessionKey = new Map(sessions.map((session) => [session.sessionKey, session]));
        const local = sortTasks(loadLocalSubagents()).map((item) => {
            const sessionKey = item.sessionKey || createSubagentSessionKey('local', item.id);
            const session = bySessionKey.get(sessionKey);
            return {
                ...item,
                type: 'local',
                sessionKey,
                running: !!session && session.status === 'running',
                sessionUpdatedAt: session?.updatedAt || null
            };
        });

        return res.json({
            subagents: local,
            total: local.length
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error), subagents: [] });
    }
});

app.post('/api/subagents/local', (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) {
        return res.status(400).json({ error: 'name 不能为空' });
    }

    const now = Date.now();
    const id = String(req.body.id || `local_${now}_${crypto.randomUUID().slice(0, 6)}`).trim();
    const local = loadLocalSubagents();
    if (local.some((item) => item.id === id)) {
        return res.status(409).json({ error: '子agent id 已存在' });
    }

    const record = {
        id,
        name,
        identity: String(req.body.identity || name).trim(),
        personality: String(req.body.personality || '').trim(),
        memoryLong: String(req.body.memoryLong || '').trim(),
        defaultModel: String(req.body.defaultModel || req.body.model || 'minimax-cn/MiniMax-M2.5').trim() || 'minimax-cn/MiniMax-M2.5',
        sessionKey: String(req.body.sessionKey || '').trim() || createSubagentSessionKey('local', id, { fresh: true }),
        createdAt: now,
        updatedAt: now
    };

    local.push(record);
    saveLocalSubagents(local);
    scheduleRefresh();

    return res.json({ success: true, subagent: record });
});

app.patch('/api/subagents/local/:id', (req, res) => {
    const id = req.params.id;
    const local = loadLocalSubagents();
    const idx = local.findIndex((item) => item.id === id);
    if (idx < 0) {
        return res.status(404).json({ error: '子agent不存在' });
    }

    const editable = ['name', 'identity', 'personality', 'memoryLong', 'defaultModel', 'sessionKey'];
    for (const key of editable) {
        if (Object.prototype.hasOwnProperty.call(req.body, key)) {
            local[idx][key] = String(req.body[key] || '').trim();
        }
    }

    if (!local[idx].sessionKey) {
        local[idx].sessionKey = createSubagentSessionKey('local', id);
    }
    if (!local[idx].defaultModel) {
        local[idx].defaultModel = 'minimax-cn/MiniMax-M2.5';
    }

    local[idx].updatedAt = Date.now();
    saveLocalSubagents(local);
    scheduleRefresh();

    return res.json({ success: true, subagent: local[idx] });
});

app.delete('/api/subagents/local/:id', (req, res) => {
    const id = req.params.id;
    const local = loadLocalSubagents();
    const idx = local.findIndex((item) => item.id === id);
    if (idx < 0) return res.status(404).json({ error: '子agent不存在' });
    const [removed] = local.splice(idx, 1);
    saveLocalSubagents(local);
    scheduleRefresh();
    return res.json({ success: true, removed });
});

app.post('/api/subagents/local/:id/chat', async (req, res) => {
    try {
        const id = req.params.id;
        const message = String(req.body.message || '').trim();
        if (!message) return res.status(400).json({ error: 'message 不能为空' });

        const local = loadLocalSubagents();
        const idx = local.findIndex((item) => item.id === id);
        if (idx < 0) return res.status(404).json({ error: '子agent不存在' });

        const item = local[idx];
        const sessionKey = item.sessionKey || createSubagentSessionKey('local', item.id);
        const payload = {
            task: buildSubagentPrompt(message, item),
            agentId: 'main',
            model: String(req.body.model || item.defaultModel || 'minimax-cn/MiniMax-M2.5').trim(),
            label: `local-${slugify(item.name || item.id, 'local')}`,
            timeout: parseInteger(req.body.timeout, 300, 10, 1800),
            sessionKey
        };

        const spawn = await callGatewayAlias('sessions_spawn', payload, { timeoutMs: 22000 });
        local[idx].sessionKey = spawn.sessionKey || spawn.data?.sessionKey || payload.sessionKey || sessionKey;
        local[idx].updatedAt = Date.now();
        saveLocalSubagents(local);

        scheduleRefresh();

        return res.json({
            success: true,
            subagent: local[idx],
            usedMethod: spawn.usedMethod,
            sessionKey: local[idx].sessionKey,
            runId: spawn.runId || spawn.data?.runId || null,
            result: spawn.data
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.get('/api/subagents/gateway', async (req, res) => {
    try {
        const sessions = await fetchSessionsSafe(400);
        const bySessionKey = new Map(sessions.map((session) => [session.sessionKey, session]));
        const gatewayAgents = await listGatewayAgentsViaCli();
        const metaList = loadGatewaySubagentMeta();
        const metaMap = new Map(metaList.map((item) => [item.id, item]));
        const parentByAgentId = new Map();
        const childCountByParent = new Map();

        for (const meta of metaList) {
            const childId = String(meta?.id || '').trim();
            const parentId = normalizeGatewayParentAgentId(meta?.parentAgentId);
            if (!childId || !parentId || childId === parentId) continue;
            parentByAgentId.set(childId, parentId);
            childCountByParent.set(parentId, (childCountByParent.get(parentId) || 0) + 1);
        }

        const list = gatewayAgents.map((agent) => {
            const meta = metaMap.get(agent.id) || {};
            const sessionKey = meta.sessionKey || createSubagentSessionKey('gateway', agent.id);
            const session = bySessionKey.get(sessionKey);
            const isProtected = isMainAgent(agent.id) || agent.isDefault;
            const parentAgentId = parentByAgentId.get(agent.id) || null;
            const identity = resolveAgentProfileIdentity(meta.identity, agent.id, agent.name) || agent.name;
            return {
                ...agent,
                type: 'gateway',
                identity,
                personality: meta.personality || '',
                memoryLong: meta.memoryLong || '',
                defaultModel: meta.defaultModel || agent.model || 'minimax-cn/MiniMax-M2.5',
                parentAgentId,
                childCount: childCountByParent.get(agent.id) || 0,
                sessionKey,
                running: !!session && session.status === 'running',
                sessionUpdatedAt: session?.updatedAt || null,
                isProtected,
                canDelete: !isProtected
            };
        });

        return res.json({
            subagents: list,
            total: list.length
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error), subagents: [] });
    }
});

app.post('/api/subagents/gateway', async (req, res) => {
    try {
        const inputName = String(req.body.name || '').trim();
        const inputId = String(req.body.agentId || req.body.id || '').trim();
        const base = inputId || inputName;
        if (!base) {
            return res.status(400).json({ error: 'agentId/name 不能为空' });
        }

        const agentId = slugify(base, `agent-${Date.now()}`);
        const parentAgentId = normalizeGatewayParentAgentId(req.body.parentAgentId);
        if (parentAgentId && parentAgentId === agentId) {
            return res.status(400).json({ error: 'parentAgentId 不能指向自身' });
        }

        if (parentAgentId) {
            const gatewayAgents = await listGatewayAgentsViaCli();
            const parentExists = gatewayAgents.some((item) => item.id === parentAgentId);
            if (!parentExists) {
                return res.status(400).json({ error: `父Agent不存在: ${parentAgentId}` });
            }
        }

        const workspace = String(
            req.body.workspace
            || (parentAgentId
                ? path.join(process.env.HOME || __dirname, '.openclaw', 'workspace-subagents', slugify(parentAgentId, 'main'), 'children', agentId)
                : path.join(process.env.HOME || __dirname, '.openclaw', 'workspace-subagents', agentId))
        ).trim();
        fs.mkdirSync(workspace, { recursive: true });

        const addArgs = ['agents', 'add', agentId, '--non-interactive', '--workspace', workspace, '--json'];
        if (req.body.model) addArgs.push('--model', String(req.body.model).trim());
        const addResult = await runOpenclawCommand(addArgs, { timeoutMs: 26000 });
        const createdAgentId = String(
            addResult.data?.id
            || addResult.data?.agentId
            || addResult.data?.name
            || agentId
        ).trim() || agentId;
        const parentForMeta = parentAgentId && parentAgentId !== createdAgentId
            ? parentAgentId
            : null;

        const identityName = String(req.body.identity || req.body.name || createdAgentId).trim();
        const setIdentityArgs = ['agents', 'set-identity', '--agent', createdAgentId, '--name', identityName, '--json'];
        if (req.body.emoji) setIdentityArgs.push('--emoji', String(req.body.emoji).trim());
        if (req.body.theme) setIdentityArgs.push('--theme', String(req.body.theme).trim());
        await runOpenclawCommand(setIdentityArgs, { timeoutMs: 18000 });

        const meta = upsertGatewaySubagentMeta({
            id: createdAgentId,
            identity: identityName,
            personality: String(req.body.personality || '').trim(),
            memoryLong: String(req.body.memoryLong || '').trim(),
            defaultModel: String(req.body.model || 'minimax-cn/MiniMax-M2.5').trim(),
            sessionKey: createSubagentSessionKey('gateway', createdAgentId, { fresh: true }),
            parentAgentId: parentForMeta
        });
        syncGatewayWorkspaceProfile(workspace, {
            identity: resolveAgentProfileIdentity(meta?.identity || identityName, createdAgentId, createdAgentId),
            personality: meta?.personality || '',
            memoryLong: meta?.memoryLong || '',
            emoji: String(req.body.emoji || '').trim()
        });

        scheduleRefresh();

        return res.json({
            success: true,
            agentId: createdAgentId,
            parentAgentId: parentForMeta,
            workspace,
            meta,
            raw: {
                add: addResult.data ?? addResult.raw
            }
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.patch('/api/subagents/gateway/:id', async (req, res) => {
    try {
        const id = req.params.id;
        if (!id) return res.status(400).json({ error: 'id 不能为空' });
        let gatewayAgentsCache = null;
        const getGatewayAgents = async () => {
            if (!gatewayAgentsCache) {
                gatewayAgentsCache = await listGatewayAgentsViaCli();
            }
            return gatewayAgentsCache;
        };

        const hasIdentityFields = ['identity', 'emoji', 'theme', 'name']
            .some((key) => Object.prototype.hasOwnProperty.call(req.body, key));

        if (hasIdentityFields) {
            const name = String(req.body.identity || req.body.name || id).trim();
            const args = ['agents', 'set-identity', '--agent', id, '--name', name, '--json'];
            if (req.body.emoji) args.push('--emoji', String(req.body.emoji).trim());
            if (req.body.theme) args.push('--theme', String(req.body.theme).trim());
            await runOpenclawCommand(args, { timeoutMs: 18000 });
        }

        let parentAgentId;
        if (Object.prototype.hasOwnProperty.call(req.body, 'parentAgentId')) {
            const normalizedParent = normalizeGatewayParentAgentId(req.body.parentAgentId);
            if (normalizedParent && normalizedParent === id) {
                return res.status(400).json({ error: 'parentAgentId 不能指向自身' });
            }
            if (normalizedParent) {
                const gatewayAgents = await getGatewayAgents();
                const parentExists = gatewayAgents.some((item) => item.id === normalizedParent);
                if (!parentExists) {
                    return res.status(400).json({ error: `父Agent不存在: ${normalizedParent}` });
                }
            }
            parentAgentId = normalizedParent;
        }

        const meta = upsertGatewaySubagentMeta({
            id,
            identity: Object.prototype.hasOwnProperty.call(req.body, 'identity')
                ? String(req.body.identity || '').trim()
                : undefined,
            personality: Object.prototype.hasOwnProperty.call(req.body, 'personality')
                ? String(req.body.personality || '').trim()
                : undefined,
            memoryLong: Object.prototype.hasOwnProperty.call(req.body, 'memoryLong')
                ? String(req.body.memoryLong || '').trim()
                : undefined,
            defaultModel: Object.prototype.hasOwnProperty.call(req.body, 'defaultModel')
                ? String(req.body.defaultModel || '').trim()
                : (Object.prototype.hasOwnProperty.call(req.body, 'model') ? String(req.body.model || '').trim() : undefined),
            sessionKey: Object.prototype.hasOwnProperty.call(req.body, 'sessionKey')
                ? String(req.body.sessionKey || '').trim()
                : undefined,
            parentAgentId
        });
        const shouldSyncProfile = ['identity', 'name', 'personality', 'memoryLong', 'emoji']
            .some((key) => Object.prototype.hasOwnProperty.call(req.body, key));
        if (shouldSyncProfile) {
            let workspace = '';
            try {
                const gatewayAgents = await getGatewayAgents();
                const target = gatewayAgents.find((item) => item.id === id);
                workspace = String(target?.workspace || '').trim();
            } catch (workspaceError) {
                console.warn('[subagent] gateway workspace resolve failed:', compactErrorMessage(workspaceError));
            }
            if (workspace) {
                const requestedIdentity = String(req.body.identity || req.body.name || '').trim();
                syncGatewayWorkspaceProfile(workspace, {
                    identity: resolveAgentProfileIdentity(meta?.identity || requestedIdentity, id, requestedIdentity || id),
                    personality: meta?.personality || '',
                    memoryLong: meta?.memoryLong || '',
                    emoji: String(req.body.emoji || '').trim()
                });
            }
        }

        scheduleRefresh();
        return res.json({ success: true, meta });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.get('/api/subagents/gateway/:id/files', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ error: 'id 不能为空' });
        const workspace = await resolveGatewayWorkspaceById(id);
        if (!workspace) return res.status(404).json({ error: 'Agent工作区不存在' });
        const files = readGatewayWorkspaceFiles(workspace);
        return res.json({
            success: true,
            id,
            workspace,
            files
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.patch('/api/subagents/gateway/:id/files', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ error: 'id 不能为空' });
        const incoming = req.body?.files && typeof req.body.files === 'object'
            ? req.body.files
            : (req.body || {});
        if (!incoming || typeof incoming !== 'object') {
            return res.status(400).json({ error: 'files 不能为空' });
        }

        const workspace = await resolveGatewayWorkspaceById(id);
        if (!workspace) return res.status(404).json({ error: 'Agent工作区不存在' });

        const changed = writeGatewayWorkspaceFiles(workspace, incoming);
        if (!changed.length) {
            return res.status(400).json({ error: '未提供可编辑文件字段' });
        }

        const files = readGatewayWorkspaceFiles(workspace);
        return res.json({
            success: true,
            id,
            workspace,
            changed,
            files
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.get('/api/subagents/gateway/:id/memory-files', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ error: 'id 不能为空' });
        const workspace = await resolveGatewayWorkspaceById(id);
        if (!workspace) return res.status(404).json({ error: 'Agent工作区不存在' });
        const files = listGatewayMemoryFiles(workspace);
        return res.json({
            success: true,
            id,
            workspace,
            files
        });
    } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        return res.status(statusCode).json({ error: compactErrorMessage(error), files: [] });
    }
});

app.get('/api/subagents/gateway/:id/memory-files/:name', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ error: 'id 不能为空' });
        const workspace = await resolveGatewayWorkspaceById(id);
        if (!workspace) return res.status(404).json({ error: 'Agent工作区不存在' });
        const file = readGatewayMemoryFile(workspace, req.params.name || '');
        return res.json({
            success: true,
            id,
            workspace,
            file
        });
    } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        return res.status(statusCode).json({ error: compactErrorMessage(error) });
    }
});

app.patch('/api/subagents/gateway/:id/memory-files/:name', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ error: 'id 不能为空' });
        const workspace = await resolveGatewayWorkspaceById(id);
        if (!workspace) return res.status(404).json({ error: 'Agent工作区不存在' });
        const content = Object.prototype.hasOwnProperty.call(req.body || {}, 'content')
            ? req.body.content
            : '';
        const file = writeGatewayMemoryFile(workspace, req.params.name || '', content);
        const files = listGatewayMemoryFiles(workspace);
        return res.json({
            success: true,
            id,
            workspace,
            file,
            files
        });
    } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        return res.status(statusCode).json({ error: compactErrorMessage(error) });
    }
});

app.delete('/api/subagents/gateway/:id', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ error: 'id 不能为空' });
        if (isMainAgent(id)) {
            return res.status(400).json({ error: '主Agent不可删除' });
        }
        await runOpenclawCommand(['agents', 'delete', id, '--force', '--json'], { timeoutMs: 26000 });
        deleteGatewaySubagentMeta(id);
        scheduleRefresh();
        return res.json({ success: true, id });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.post('/api/subagents/gateway/:id/chat', async (req, res) => {
    try {
        const id = req.params.id;
        const message = String(req.body.message || '').trim();
        if (!message) return res.status(400).json({ error: 'message 不能为空' });

        const meta = getGatewaySubagentMetaById(id) || {};
        let sessionKey = meta.sessionKey || createSubagentSessionKey('gateway', id);
        const requestedModel = String(req.body.model || '').trim();
        const defaultModel = String(meta.defaultModel || 'minimax-cn/MiniMax-M2.5').trim() || 'minimax-cn/MiniMax-M2.5';
        const resolvedIdentity = resolveAgentProfileIdentity(meta.identity, id, id);
        const label = `gateway-${slugify(id, 'gateway')}`;

        try {
            const history = await callGatewayAlias('sessions_history', {
                sessionKey,
                limit: 200
            }, { timeoutMs: 10000 });
            const rawMessages = Array.isArray(history?.data?.messages) ? history.data.messages : [];
            const hasRetryPlaceholder = rawMessages.some((item) =>
                isSyntheticRetryContinuationMessage(item?.role, contentToText(item?.content))
            );
            const hasBootstrapLikeAssistant = rawMessages.some((item) => {
                if (String(item?.role || '').trim().toLowerCase() !== 'assistant') return false;
                const text = sanitizeSessionText(contentToText(item?.content)).toLowerCase();
                return text.includes('workspace looks fresh')
                    || text.includes('we haven\'t officially "met" yet')
                    || text.includes('who am i')
                    || text.includes('bootstrap.md');
            });
            if (hasRetryPlaceholder || hasBootstrapLikeAssistant) {
                sessionKey = createSubagentSessionKey('gateway', id, { fresh: true });
                upsertGatewaySubagentMeta({ id, sessionKey });
            }
        } catch (_) {
            // ignore history probe failure
        }

        const patch = { key: sessionKey, label };
        const effectiveModel = requestedModel || defaultModel;
        if (effectiveModel) patch.model = effectiveModel;
        try {
            await runGatewayCall('sessions.patch', patch, { timeoutMs: 10000 });
        } catch (patchError) {
            console.warn('[subagent] sessions.patch before send failed:', compactErrorMessage(patchError));
        }

        const sendPayload = {
            sessionKey,
            // Gateway Agent profile is persisted in workspace files; send raw user message.
            message,
            deliver: true,
            timeoutMs: parseInteger(req.body.timeoutMs, 120000, 1000, 300000)
        };

        const send = await callGatewayAlias('sessions_send', sendPayload, { timeoutMs: 22000 });
        upsertGatewaySubagentMeta({
            id,
            identity: resolvedIdentity,
            personality: meta.personality || '',
            memoryLong: meta.memoryLong || '',
            defaultModel: requestedModel || defaultModel,
            sessionKey
        });

        scheduleRefresh();
        return res.json({
            success: true,
            usedMethod: send.usedMethod,
            sessionKey,
            runId: send.data?.runId || null,
            result: send.data
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

// ============ 定时任务看板 ============

app.get('/api/schedules', async (req, res) => {
    let status = {
        enabled: false,
        jobs: 0,
        storePath: null,
        nextWakeAtMs: null
    };
    let jobs = [];
    let statusError = '';
    let jobsError = '';

    try {
        status = await getCronStatus();
    } catch (error) {
        statusError = compactErrorMessage(error);
    }

    try {
        jobs = await getCronJobs(true);
    } catch (error) {
        jobsError = compactErrorMessage(error);
    }

    return res.json({
        status: {
            ...status,
            error: statusError || undefined
        },
        jobs,
        jobsError: jobsError || undefined,
        total: jobs.length,
        timestamp: nowIso()
    });
});

app.post('/api/schedules', async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        const message = String(req.body.message || '').trim();
        const agentId = normalizeAgentId(req.body.agentId || 'main');
        if (!name) return res.status(400).json({ error: 'name 不能为空' });
        if (!message) return res.status(400).json({ error: 'message 不能为空' });

        const args = ['cron', 'add', '--json', '--name', name, '--agent', agentId, '--message', message];
        if (req.body.description) args.push('--description', String(req.body.description).trim());
        if (req.body.model) args.push('--model', String(req.body.model).trim());
        if (req.body.tz) args.push('--tz', String(req.body.tz).trim());
        if (req.body.disabled === true) args.push('--disabled');

        if (req.body.cron) {
            args.push('--cron', String(req.body.cron).trim());
        } else if (req.body.at) {
            args.push('--at', String(req.body.at).trim());
        } else if (req.body.every) {
            args.push('--every', String(req.body.every).trim());
        } else {
            return res.status(400).json({ error: 'cron / at / every 至少提供一项' });
        }

        const result = await runOpenclawCommand(args, { timeoutMs: 24000 });
        scheduleRefresh();
        return res.json({
            success: true,
            result: result.data ?? result.raw
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.patch('/api/schedules/:id', async (req, res) => {
    try {
        const id = req.params.id;
        if (!id) return res.status(400).json({ error: 'id 不能为空' });

        if (req.body.action === 'enable') {
            await runOpenclawCommand(['cron', 'enable', id], { timeoutMs: 16000 });
            scheduleRefresh();
            return res.json({ success: true, id, action: 'enable' });
        }
        if (req.body.action === 'disable') {
            await runOpenclawCommand(['cron', 'disable', id], { timeoutMs: 16000 });
            scheduleRefresh();
            return res.json({ success: true, id, action: 'disable' });
        }

        const args = ['cron', 'edit', id];
        if (Object.prototype.hasOwnProperty.call(req.body, 'name')) args.push('--name', String(req.body.name || '').trim());
        if (Object.prototype.hasOwnProperty.call(req.body, 'description')) args.push('--description', String(req.body.description || '').trim());
        if (Object.prototype.hasOwnProperty.call(req.body, 'agentId')) args.push('--agent', normalizeAgentId(req.body.agentId));
        if (Object.prototype.hasOwnProperty.call(req.body, 'message')) args.push('--message', String(req.body.message || '').trim());
        if (Object.prototype.hasOwnProperty.call(req.body, 'model')) args.push('--model', String(req.body.model || '').trim());
        if (Object.prototype.hasOwnProperty.call(req.body, 'cron')) args.push('--cron', String(req.body.cron || '').trim());
        if (Object.prototype.hasOwnProperty.call(req.body, 'at')) args.push('--at', String(req.body.at || '').trim());
        if (Object.prototype.hasOwnProperty.call(req.body, 'every')) args.push('--every', String(req.body.every || '').trim());
        if (Object.prototype.hasOwnProperty.call(req.body, 'tz')) args.push('--tz', String(req.body.tz || '').trim());
        if (Object.prototype.hasOwnProperty.call(req.body, 'enabled')) args.push(req.body.enabled ? '--enable' : '--disable');

        const result = await runOpenclawCommand(args, { timeoutMs: 22000 });
        scheduleRefresh();
        return res.json({
            success: true,
            id,
            result: result.data ?? result.raw
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.delete('/api/schedules/:id', async (req, res) => {
    try {
        const id = req.params.id;
        await runOpenclawCommand(['cron', 'rm', id, '--json'], { timeoutMs: 16000 });
        scheduleRefresh();
        return res.json({ success: true, id });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.post('/api/schedules/:id/run', async (req, res) => {
    try {
        const id = req.params.id;
        const result = await runOpenclawCommand(['cron', 'run', id], { timeoutMs: 20000 });
        scheduleRefresh();
        return res.json({
            success: true,
            id,
            result: result.data ?? result.raw
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
});

app.get('/api/schedules/:id/runs', async (req, res) => {
    try {
        const id = req.params.id;
        const limit = parseInteger(req.query.limit, 20, 1, 500);
        const result = await runOpenclawCommand(['cron', 'runs', '--id', id, '--limit', String(limit)], { timeoutMs: 22000 });
        const data = result?.data ?? extractJsonFromOutput(result?.raw);
        return res.json({
            id,
            limit,
            runs: Array.isArray(data) ? data : firstArrayField(data, 'runs', 'items', 'data'),
            raw: result.raw
        });
    } catch (error) {
        return res.status(500).json({ error: compactErrorMessage(error) });
    }
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

function toArray(value) {
    if (Array.isArray(value)) return value;
    return [];
}

function firstArrayField(payload, ...fieldNames) {
    for (const name of fieldNames) {
        if (Array.isArray(payload?.[name])) return payload[name];
    }
    return [];
}

function normalizeGatewayAgentEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const id = String(entry.id || entry.agentId || entry.name || '').trim();
    if (!id) return null;
    return {
        id,
        name: String(entry.identityName || entry.name || id).trim() || id,
        model: String(entry.model || '').trim() || null,
        workspace: String(entry.workspace || '').trim() || null,
        identityEmoji: String(entry.identityEmoji || '').trim() || '',
        identityTheme: String(entry.identityTheme || '').trim() || '',
        isDefault: !!entry.isDefault
    };
}

async function listGatewayAgentsViaCli() {
    const result = await runOpenclawCommand(['agents', 'list', '--json'], { timeoutMs: 16000 });
    const payload = result?.data ?? extractJsonFromOutput(result?.raw);
    const list = Array.isArray(payload)
        ? payload
        : firstArrayField(payload, 'agents', 'items', 'data');
    return list
        .map(normalizeGatewayAgentEntry)
        .filter(Boolean);
}

function upsertGatewaySubagentMeta(partial = {}) {
    const sanitized = Object.fromEntries(
        Object.entries(partial).filter(([, value]) => value !== undefined)
    );
    if (Object.prototype.hasOwnProperty.call(sanitized, 'parentAgentId')) {
        sanitized.parentAgentId = normalizeGatewayParentAgentId(sanitized.parentAgentId);
    }
    const list = loadGatewaySubagentMeta();
    const id = String(sanitized.id || '').trim();
    if (!id) return null;

    const now = Date.now();
    const idx = list.findIndex((item) => item.id === id);
    if (idx >= 0) {
        list[idx] = {
            ...list[idx],
            ...sanitized,
            id,
            updatedAt: now
        };
    } else {
        list.push({
            id,
            personality: '',
            memoryLong: '',
            identity: '',
            defaultModel: 'minimax-cn/MiniMax-M2.5',
            sessionKey: null,
            parentAgentId: null,
            createdAt: now,
            updatedAt: now,
            ...sanitized
        });
    }

    saveGatewaySubagentMeta(list);
    return list.find((item) => item.id === id) || null;
}

function deleteGatewaySubagentMeta(id) {
    const targetId = String(id || '').trim();
    if (!targetId) return;
    const normalizedTargetId = normalizeAgentId(targetId);
    const now = Date.now();
    const next = [];

    for (const item of loadGatewaySubagentMeta()) {
        const itemId = String(item?.id || '').trim();
        if (!itemId) continue;
        if (itemId === targetId || normalizeAgentId(itemId) === normalizedTargetId) {
            continue;
        }

        const parentAgentId = normalizeGatewayParentAgentId(item?.parentAgentId);
        if (parentAgentId && parentAgentId === normalizedTargetId) {
            next.push({
                ...item,
                parentAgentId: null,
                updatedAt: now
            });
            continue;
        }

        next.push(item);
    }

    saveGatewaySubagentMeta(next);
}

function normalizeCronJob(job) {
    if (!job || typeof job !== 'object') return null;
    const id = String(job.id || job.jobId || '').trim();
    if (!id) return null;

    const schedule = job.schedule && typeof job.schedule === 'object' ? job.schedule : {};
    const stateInfo = job.state && typeof job.state === 'object' ? job.state : {};
    const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
    const everyValue = job.every
        || schedule.every
        || (schedule.everyMs ? `${Math.floor(Number(schedule.everyMs) / 1000)}s` : null);
    const atValue = job.at
        || schedule.at
        || (schedule.atMs ? Number(schedule.atMs) : null);

    return {
        id,
        name: String(job.name || '').trim() || id,
        description: String(job.description || '').trim(),
        enabled: job.enabled !== false,
        cron: job.cron || schedule.cron || null,
        every: everyValue || null,
        at: atValue || null,
        timezone: job.tz || job.timezone || schedule.tz || '',
        nextRunAt: job.nextRunAt || job.nextRunAtMs || stateInfo.nextRunAtMs || null,
        lastRunAt: job.lastRunAt || job.lastRunAtMs || stateInfo.lastRunAtMs || null,
        agentId: String(job.agent || payload.agent || payload.agentId || 'main').trim() || 'main',
        message: String(payload.message || job.message || '').trim(),
        model: String(job.model || payload.model || '').trim() || null
    };
}

async function getCronJobs(all = true) {
    const args = ['cron', 'list', '--json'];
    if (all) args.push('--all');
    const result = await runOpenclawCommand(args, { timeoutMs: 20000 });
    const payload = result?.data ?? extractJsonFromOutput(result?.raw) ?? {};
    const list = Array.isArray(payload)
        ? payload
        : firstArrayField(payload, 'jobs', 'items', 'data');
    return list.map(normalizeCronJob).filter(Boolean);
}

async function getCronStatus() {
    const result = await runOpenclawCommand(['cron', 'status', '--json'], { timeoutMs: 10000 });
    const payload = result?.data ?? extractJsonFromOutput(result?.raw) ?? {};
    return {
        enabled: payload.enabled !== false,
        jobs: parseInteger(payload.jobs, 0, 0),
        storePath: payload.storePath || null,
        nextWakeAtMs: payload.nextWakeAtMs || null
    };
}

function createSubagentSessionKey(type, id, options = {}) {
    const suffix = slugify(id, type || 'subagent');
    const freshSuffix = options.fresh === true ? `-${crypto.randomUUID()}` : '';
    if (type === 'gateway') return `agent:${normalizeAgentId(id)}:subagent:gateway-${suffix}${freshSuffix}`;
    if (type === 'local') return `agent:main:subagent:local-${suffix}${freshSuffix}`;
    return `agent:main:subagent:${suffix}${freshSuffix}`;
}

function buildSubagentPrompt(message, profile = {}) {
    const blocks = [];
    if (profile.identity) blocks.push(`身份设定: ${profile.identity}`);
    if (profile.personality) blocks.push(`个性设定: ${profile.personality}`);
    if (profile.memoryLong) blocks.push(`长期记忆:\n${profile.memoryLong}`);
    blocks.push(`用户消息:\n${message}`);
    return blocks.join('\n\n');
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

// ============ 统一执行队列 ============

function readExecutionQueueForApi(query = {}) {
    const showAll = String(query.all || '').trim() === '1' || String(query.activeOnly || '').trim() === '0';
    const sorted = sortExecutionQueue(loadExecutionQueue())
        .map((item) => ({
            ...item,
            status: normalizeExecutionStatus(item.status),
            priority: normalizePriority(item.priority)
        }));
    return showAll ? sorted : sorted.filter((item) => isQueueActiveStatus(item.status));
}

app.get('/api/execution-queue', (req, res) => {
    const tasks = readExecutionQueueForApi(req.query);
    return res.json({
        tasks,
        total: tasks.length,
        active: tasks.filter((item) => isQueueActiveStatus(item.status)).length
    });
});

app.post('/api/execution-queue', (req, res) => {
    const title = String(req.body.title || '').trim();
    if (!title) {
        return res.status(400).json({ error: '标题不能为空' });
    }

    const queue = loadExecutionQueue();
    const queueItem = createExecutionQueueItem({
        sourceType: req.body.sourceType || 'manual',
        sourceId: req.body.sourceId || '',
        title,
        description: String(req.body.description || '').trim(),
        priority: req.body.priority,
        agentType: req.body.agentType || 'main',
        agentRef: req.body.agentRef || req.body.agentId || 'main',
        model: req.body.model || 'minimax-cn/MiniMax-M2.5',
        log: '手动创建执行队列任务。'
    });

    queue.push(queueItem);
    saveExecutionQueue(queue);
    scheduleRefresh();

    processExecutionQueue().catch((error) => {
        console.error('[queue] process failed:', compactErrorMessage(error));
    });

    return res.json({ success: true, queueItem });
});

app.post('/api/execution-queue/:id/cancel', (req, res) => {
    const id = req.params.id;
    const item = withExecutionQueueItem(id, (queueItem) => {
        if (!isQueueActiveStatus(queueItem.status)) return;
        queueItem.status = 'canceled';
        queueItem.completedAt = Date.now();
        queueItem.logs = Array.isArray(queueItem.logs) ? queueItem.logs : [];
        queueItem.logs.push({ time: Date.now(), msg: '任务已取消。' });
    });

    if (!item) return res.status(404).json({ error: '队列任务不存在' });

    if (item.sourceType === 'task' && item.sourceId) {
        markTaskFromQueue(item.sourceId, {
            status: 'pending'
        }, '任务队列已取消，任务状态回退为 pending。');
    }

    scheduleRefresh();
    return res.json({ success: true, task: item });
});

app.delete('/api/execution-queue/:id', (req, res) => {
    const id = req.params.id;
    const queue = loadExecutionQueue();
    const idx = queue.findIndex((item) => item.id === id);
    if (idx < 0) return res.status(404).json({ error: '队列任务不存在' });
    const [removed] = queue.splice(idx, 1);
    saveExecutionQueue(queue);
    scheduleRefresh();
    return res.json({ success: true, removed });
});

// 兼容旧接口
app.get('/api/queue', (req, res) => {
    const tasks = readExecutionQueueForApi(req.query);
    res.json({ tasks });
});

app.post('/api/queue', (req, res) => {
    const title = String(req.body.title || '').trim();
    if (!title) {
        return res.status(400).json({ error: '标题不能为空' });
    }

    const queue = loadExecutionQueue();
    const queueItem = createExecutionQueueItem({
        sourceType: req.body.sourceType || 'manual',
        sourceId: req.body.sourceId || '',
        title,
        description: String(req.body.description || '').trim(),
        priority: req.body.priority,
        agentType: req.body.agentType || 'main',
        agentRef: req.body.agentRef || req.body.agentId || 'main',
        model: req.body.model || 'minimax-cn/MiniMax-M2.5',
        log: '通过兼容队列接口创建。'
    });

    queue.push(queueItem);
    saveExecutionQueue(queue);
    scheduleRefresh();
    processExecutionQueue().catch((error) => {
        console.error('[queue] process failed:', compactErrorMessage(error));
    });

    return res.json({ success: true, queueItem });
});

app.delete('/api/queue/:id', (req, res) => {
    const id = req.params.id;
    const queue = loadExecutionQueue().filter((item) => item.id !== id);
    saveExecutionQueue(queue);
    scheduleRefresh();
    return res.json({ success: true });
});

app.post('/api/queue/process', async (req, res) => {
    processExecutionQueue().catch((error) => {
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
    console.log(`   认证用户: ${AUTH_USER}`);
    if (AUTH_PASS === 'change-me') {
        console.warn('   警告: 当前使用默认认证口令。请设置环境变量 CONSOLE_AUTH_PASS。');
    }

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
