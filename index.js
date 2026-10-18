/**
 * ============================================================================
 * WHATSAPP AI CUSTOMER SUPPORT BOT — PRODUCTION v10.1 (FINAL EXPERT FIX)
 * ============================================================================
 * FIXES IN v10.1:
 *  1. ADMIN SELF-CHAT: When admin types ".bot on" to their OWN number,
 *     WhatsApp sends it with fromMe=true. We allow dot-commands from self-chat.
 *  2. ADMIN OTHER DEVICE: fromMe=false + phone number 917500167987 → admin.
 *  3. CUSTOMER: fromMe=false + not admin phone → AI reply (when bot active).
 *  4. BAD MAC FIX: getMessage fallback prevents "Waiting for this message".
 *  5. Session: retryRequestDelayMs=2000, connectTimeoutMs=60000.
 *  6. NEVER use quoted messages → no @lid delivery failure.
 * ============================================================================
 */

'use strict';

const express = require('express');
const QRCode  = require('qrcode');
const path    = require('path');
const fs      = require('fs');
const pino    = require('pino');
require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '2580';

// Admin phone number (with country code, digits only)
const ADMIN_PHONE_RAW = (process.env.ADMIN_PHONE || '917500167987').replace(/\D/g, '');

// ─── PRESERVE ORIGINAL CONSOLE ───────────────────────────────────────────────
const _orig = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    info:  console.info.bind(console),
};

// Suppress noisy Baileys crypto/session logs
const SPAM_KEYWORDS = [
    'SessionEntry', 'Closing session', '_chains', 'currentRatchet',
    'ephemeralKeyPair', 'lastRemoteEphemeralKey', 'registrationId',
    'indexInfo', 'pendingPreKey', 'baseKeyType', 'rootKey',
    'privKey', 'pubKey', 'remoteIdentityKey', 'chainKey', 'chainType',
    'messageKeys', 'previousCounter', 'signedKeyId',
    'Failed to decrypt message with any known session',
    'Closing open session in favor of incoming prekey bundle',
    'Bad MAC',
];

function isSpam(args) {
    const str = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
    return SPAM_KEYWORDS.some(k => str.includes(k));
}

console.log   = (...a) => { if (!isSpam(a)) _orig.log(...a); };
console.warn  = (...a) => { if (!isSpam(a)) _orig.warn(...a); };
console.error = (...a) => { if (!isSpam(a)) _orig.error(...a); };
console.info  = (...a) => { if (!isSpam(a)) _orig.info(...a); };

// ─── GLOBAL STATE ─────────────────────────────────────────────────────────────
const BOOT_TIME      = Date.now();
const STATE_FILE     = './bot_state.json';

let isBotActive      = true;
let isConnected      = false;
let currentPairingCode = null;
let currentQrDataUrl   = null;
let activeSocket       = null;
const activityLogs     = [];

function addActivityLog(sender, message, reply, status) {
    const time = new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    activityLogs.unshift({ sender, message, reply, status: status || 'replied', time });
    if (activityLogs.length > 100) activityLogs.pop();
}

function loadBotState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (typeof d.active === 'boolean') isBotActive = d.active;
        }
    } catch (_) {}
    _orig.log('Bot state on boot: ' + (isBotActive ? 'ACTIVE' : 'PAUSED'));
}

function saveBotState(active) {
    isBotActive = active;
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            active: isBotActive,
            updated: new Date().toISOString()
        }), 'utf8');
    } catch (e) {
        _orig.error('saveBotState error:', e.message);
    }
}
loadBotState();

// ─── BUSINESS KNOWLEDGE ───────────────────────────────────────────────────────
let cachedSystemPrompt = 'You are a professional AI Customer Support agent for GrabNext - an Indian digital marketplace. Reply in Hinglish (Hindi + English mix). Be concise, helpful, warm and friendly. Keep replies to max 3-4 lines. Use WhatsApp formatting (*bold* with single asterisk only). End every reply by asking if customer needs more help.';

function loadBusinessKnowledge() {
    try {
        if (fs.existsSync('./business_info.txt')) {
            const c = fs.readFileSync('./business_info.txt', 'utf8').trim();
            if (c.length > 10) { cachedSystemPrompt = c; }
        }
        _orig.log('business_info.txt loaded.');
    } catch (e) {
        _orig.error('business_info.txt load error:', e.message);
    }
}
loadBusinessKnowledge();

if (fs.existsSync('./business_info.txt')) {
    fs.watchFile('./business_info.txt', { interval: 5000 }, () => {
        _orig.log('business_info.txt changed — reloading AI prompt...');
        loadBusinessKnowledge();
        rebuildGemini();
    });
}

// ─── GEMINI ENGINE ────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) _orig.error('CRITICAL: GEMINI_API_KEY is missing in .env!');

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || 'MISSING');
const MODEL_LIST = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];
let activeModelName = MODEL_LIST[0];
let aiModel = null;

function rebuildGemini(modelName) {
    const name = modelName || activeModelName;
    try {
        aiModel = genAI.getGenerativeModel({
            model: name,
            systemInstruction: cachedSystemPrompt,
            generationConfig: { maxOutputTokens: 300, temperature: 0.7, topP: 0.95 },
        });
        activeModelName = name;
        _orig.log('Gemini model ready: ' + name);
    } catch (e) {
        _orig.error('Gemini init failed [' + name + ']:', e.message);
    }
}
rebuildGemini();

function fixFormatting(text) {
    return (text || '')
        .replace(/\*\*\*(.*?)\*\*\*/g, '*$1*')
        .replace(/\*\*(.*?)\*\*/g, '*$1*')
        .replace(/\*\*/g, '*');
}

const userHistory       = new Map();
const activeGenerations = new Set();

async function askGemini(userId, userText) {
    if (activeGenerations.has(userId)) {
        _orig.log('Already processing for ' + userId + ' — skipping duplicate');
        return null;
    }
    activeGenerations.add(userId);

    if (!userHistory.has(userId)) userHistory.set(userId, []);
    const history = userHistory.get(userId);

    let prompt = '';
    if (history.length > 0) {
        prompt = history.slice(-6).map(h => h.role + ': ' + h.text).join('\n') + '\n';
    }
    prompt += 'Customer: ' + userText + '\nAssistant:';

    const t0 = Date.now();
    let reply = null;

    for (const modelName of MODEL_LIST) {
        try {
            if (modelName !== activeModelName) rebuildGemini(modelName);
            const result = await aiModel.generateContent(prompt);
            reply = fixFormatting(result.response.text().trim());
            const ms = Date.now() - t0;
            _orig.log('Gemini replied in ' + ms + 'ms [' + activeModelName + ']');
            history.push({ role: 'Customer', text: userText });
            history.push({ role: 'Assistant', text: reply });
            if (history.length > 10) history.splice(0, 2);
            break;
        } catch (err) {
            _orig.warn('Gemini [' + modelName + '] error: ' + err.message.slice(0, 120));
        }
    }

    activeGenerations.delete(userId);

    if (!reply) {
        return 'Namaste! Abhi server thoda busy hai. Kripya 2 minute baad dobara message karein. Products ke liye visit karein: https://grabnext.pages.dev';
    }
    return reply;
}

// ─── MESSAGE STORE & DEDUP ────────────────────────────────────────────────────
const msgStore = new Map();
const seenIds  = new Set();

function storeMsg(key, message) {
    if (!key || !key.id || !message) return;
    msgStore.set(key.id, message);
    if (msgStore.size > 3000) msgStore.delete(msgStore.keys().next().value);
}

function isDuplicate(id) {
    if (!id) return false;
    if (seenIds.has(id)) return true;
    seenIds.add(id);
    if (seenIds.size > 8000) seenIds.delete(seenIds.values().next().value);
    return false;
}

// ─── ROBUST SENDER — NEVER uses quoted messages ───────────────────────────────
async function deliverReply(sock, targetJid, text) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const sent = await sock.sendMessage(targetJid, { text: text });
            if (sent) {
                _orig.log('Delivered to ' + targetJid + ' (attempt ' + attempt + ')');
                return sent;
            }
        } catch (e) {
            _orig.warn('Send attempt ' + attempt + ' to ' + targetJid + ' failed: ' + e.message);
        }
        if (attempt < 3) {
            await new Promise(r => setTimeout(r, attempt * 1200));
        }
    }
    _orig.error('ALL 3 DELIVERY ATTEMPTS FAILED for ' + targetJid);
    return null;
}

// ─── MESSAGE DEBOUNCER ────────────────────────────────────────────────────────
const pendingQueues = new Map();

function scheduleReply(sock, from, text) {
    if (!pendingQueues.has(from)) {
        pendingQueues.set(from, { parts: [], timer: null });
    }
    const q = pendingQueues.get(from);
    q.parts.push(text);
    if (q.timer) clearTimeout(q.timer);

    q.timer = setTimeout(async () => {
        const combined = q.parts.join(' ').trim();
        pendingQueues.delete(from);

        _orig.log('\nPROCESSING: ' + from);
        _orig.log('   Query: "' + combined + '"');

        try { await sock.sendPresenceUpdate('composing', from); } catch (_) {}

        const reply = await askGemini(from, combined);

        if (!reply) {
            _orig.warn('   AI returned null (duplicate guard). Skipping.');
            try { await sock.sendPresenceUpdate('paused', from); } catch (_) {}
            return;
        }

        _orig.log('   AI Reply ready: "' + reply.slice(0, 80) + '..."');

        const sent = await deliverReply(sock, from, reply);

        if (sent) {
            storeMsg(sent.key, sent.message);
            _orig.log('   SUCCESS — reply delivered to ' + from);
            addActivityLog(from.replace(/@.+/, ''), combined, reply, 'replied');
        } else {
            _orig.error('   FAILED — could not deliver to ' + from);
            addActivityLog(from.replace(/@.+/, ''), combined, 'Delivery failed', 'failed');
        }

        try { await sock.sendPresenceUpdate('paused', from); } catch (_) {}
    }, 600);
}

// ─── TEXT EXTRACTOR ───────────────────────────────────────────────────────────
function extractText(msg) {
    if (!msg || !msg.message) return '';
    const m = msg.message;
    const inner =
        (m.ephemeralMessage && m.ephemeralMessage.message) ||
        (m.viewOnceMessage && m.viewOnceMessage.message) ||
        (m.viewOnceMessageV2 && m.viewOnceMessageV2.message) ||
        (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message) ||
        m;
    return (
        inner.conversation ||
        (inner.extendedTextMessage && inner.extendedTextMessage.text) ||
        (inner.imageMessage && inner.imageMessage.caption) ||
        (inner.videoMessage && inner.videoMessage.caption) ||
        ''
    ).trim();
}

// ─── ADMIN DETECTOR (by phone number, for messages from other devices) ────────
function isAdminPhone(msg) {
    if (!ADMIN_PHONE_RAW) return false;
    const jid = msg && msg.key && msg.key.remoteJid ? msg.key.remoteJid : '';
    const par = msg && msg.key && msg.key.participant ? msg.key.participant : '';
    return jid.startsWith(ADMIN_PHONE_RAW + '@') || par.startsWith(ADMIN_PHONE_RAW + '@');
}

// ─── CORE MESSAGE HANDLER ─────────────────────────────────────────────────────
/**
 * MESSAGE ROUTING LOGIC:
 *
 * WhatsApp Multi-Device has 3 types of inbound messages:
 *
 * 1. ADMIN SELF-CHAT (fromMe=true):
 *    Admin types ".bot on" to their OWN WhatsApp number → fromMe=true
 *    → Allow dot-commands, skip non-dot (those are bot's own outgoing replies)
 *
 * 2. ADMIN FROM DIFFERENT DEVICE (fromMe=false, phone=917500167987):
 *    Admin uses a second phone/device to send commands → fromMe=false
 *    → Allow dot-commands AND ignore non-commands
 *
 * 3. CUSTOMER (fromMe=false, phone=different):
 *    Any other person messages → Customer
 *    → Send AI reply if bot is ACTIVE
 */
async function handleMessage(sock, msg) {
    const from   = (msg && msg.key && msg.key.remoteJid) ? msg.key.remoteJid : '';
    const msgId  = (msg && msg.key && msg.key.id)        ? msg.key.id        : '';
    const fromMe = (msg && msg.key && msg.key.fromMe)    ? msg.key.fromMe    : false;

    if (!msg || !msg.message || !from || !msgId) return;

    if (isDuplicate(msgId)) {
        _orig.log('Duplicate skipped: ' + msgId);
        return;
    }

    storeMsg(msg.key, msg.message);

    if (from.endsWith('@g.us'))            return;
    if (from.includes('status@broadcast')) return;
    if (from.includes('newsletter'))       return;

    const text = extractText(msg);
    if (!text) return;

    const cmd = text.toLowerCase().trim();
    _orig.log('\n[MSG] from=' + from + ' | fromMe=' + fromMe + ' | text="' + text + '"');

    // ── CASE 1: ADMIN SELF-CHAT (fromMe=true) ─────────────────────────────────
    if (fromMe) {
        // Non-dot messages = bot's own outgoing replies echoing back → SKIP
        if (!cmd.startsWith('.')) {
            _orig.log('   Bot own outgoing reply — skipped');
            return;
        }

        // Dot-command from admin self-chat
        _orig.log('   [ADMIN SELF-CHAT COMMAND]');

        if (cmd === '.bot off') {
            saveBotState(false);
            try { await sock.sendMessage(from, { text: 'Bot PAUSED — Customers ko reply nahi jayega.' }); } catch (_) {}
            _orig.log('Bot PAUSED by admin');
            return;
        }
        if (cmd === '.bot on') {
            saveBotState(true);
            try { await sock.sendMessage(from, { text: 'Bot ACTIVE — Customers ko auto-reply milega!' }); } catch (_) {}
            _orig.log('Bot ACTIVATED by admin');
            return;
        }
        if (cmd === '.bot status') {
            const st = isBotActive ? 'ACTIVE' : 'PAUSED';
            const up = Math.round((Date.now() - BOOT_TIME) / 60000);
            try { await sock.sendMessage(from, { text: 'Status: ' + st + '\nModel: ' + activeModelName + '\nUptime: ' + up + ' min\nLogs: ' + activityLogs.length }); } catch (_) {}
            return;
        }
        if (cmd.startsWith('.test')) {
            const q = text.slice(5).trim() || 'GrabNext products batao.';
            _orig.log('Self-test: "' + q + '"');
            const r = await askGemini('__test__', q);
            try { await sock.sendMessage(from, { text: r || 'No reply generated.' }); } catch (_) {}
            return;
        }
        if (cmd === '.bot help') {
            try { await sock.sendMessage(from, { text: 'Commands:\n.bot on\n.bot off\n.bot status\n.test <query>\n.bot help' }); } catch (_) {}
            return;
        }
        _orig.log('   Unknown self-chat command — ignored');
        return;
    }

    // ── CASE 2: ADMIN FROM DIFFERENT DEVICE (fromMe=false, phone match) ────────
    if (isAdminPhone(msg)) {
        _orig.log('   [ADMIN PHONE MATCH]: ' + from);

        if (cmd === '.bot off') {
            saveBotState(false);
            await deliverReply(sock, from, 'Bot PAUSED — Customers ko reply nahi jayega.');
            _orig.log('Bot PAUSED by admin');
            return;
        }
        if (cmd === '.bot on') {
            saveBotState(true);
            await deliverReply(sock, from, 'Bot ACTIVE — Customers ko auto-reply milega!');
            _orig.log('Bot ACTIVATED by admin');
            return;
        }
        if (cmd === '.bot status') {
            const st = isBotActive ? 'ACTIVE' : 'PAUSED';
            const up = Math.round((Date.now() - BOOT_TIME) / 60000);
            await deliverReply(sock, from, 'Status: ' + st + '\nModel: ' + activeModelName + '\nUptime: ' + up + ' min');
            return;
        }
        if (cmd.startsWith('.test')) {
            const q = text.slice(5).trim() || 'GrabNext products batao.';
            _orig.log('Admin test: "' + q + '"');
            const r = await askGemini('__admin_test__', q);
            await deliverReply(sock, from, r || 'No reply generated.');
            return;
        }
        if (cmd === '.bot help') {
            await deliverReply(sock, from, 'Commands:\n.bot on\n.bot off\n.bot status\n.test <query>\n.bot help');
            return;
        }
        _orig.log('   Admin non-command — ignored');
        return;
    }

    // ── CASE 3: CUSTOMER MESSAGE ───────────────────────────────────────────────
    if (!isBotActive) {
        _orig.log('   Bot PAUSED — dropped message from ' + from);
        return;
    }

    _orig.log('   [CUSTOMER] Queuing AI reply for ' + from);
    scheduleReply(sock, from, text);
}

// ─── WHATSAPP CONNECTION ──────────────────────────────────────────────────────
async function startBot() {
    _orig.log('Connecting to WhatsApp...');

    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 2000,
        connectTimeoutMs: 60000,
        browser: ['Ubuntu', 'Chrome', '22.0.0'],
        getMessage: async (key) => {
            if (key && key.id) {
                const stored = msgStore.get(key.id);
                if (stored) return stored;
            }
            // Fallback: return empty message to prevent "Waiting for this message"
            return { conversation: '' };
        },
    });

    activeSocket = sock;

    // Request pairing code if not registered yet
    if (!sock.authState.creds.registered) {
        const rawPhone = (process.env.PHONE_NUMBER || ADMIN_PHONE_RAW).replace(/\D/g, '');
        if (rawPhone) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(rawPhone);
                    currentPairingCode = code;
                    _orig.log('\n' + '='.repeat(50) + '\nPAIRING CODE: ' + code + '\n' + '='.repeat(50) + '\n');
                } catch (e) {
                    _orig.error('Pairing code error:', e.message);
                }
            }, 3000);
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const connection    = update.connection;
        const lastDisconnect = update.lastDisconnect;
        const qr            = update.qr;

        if (qr) {
            try { currentQrDataUrl = await QRCode.toDataURL(qr); } catch (_) {}
        }
        if (connection === 'close') {
            isConnected = false;
            const code      = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : 0;
            const reconnect = code !== DisconnectReason.loggedOut;
            _orig.log('Disconnected (code=' + code + '). Reconnect=' + reconnect);
            if (reconnect) setTimeout(startBot, 4000);
            else           _orig.error('Logged out — delete auth_session and restart server.');
        } else if (connection === 'open') {
            isConnected        = true;
            currentPairingCode = null;
            currentQrDataUrl   = null;
            _orig.log('\n' + '='.repeat(50) + '\nBOT ONLINE — STATUS: ' + (isBotActive ? 'ACTIVE (ON)' : 'PAUSED (OFF)') + '\n' + '='.repeat(50) + '\n');
        }
    });

    sock.ev.on('messages.upsert', (upsert) => {
        if (!upsert || upsert.type !== 'notify') return;
        for (const msg of upsert.messages) {
            setImmediate(() =>
                handleMessage(sock, msg).catch(e =>
                    _orig.error('handleMessage crash:', e.message, e.stack ? e.stack.split('\n')[1] : '')
                )
            );
        }
    });
}

// ─── EXPRESS DASHBOARD ────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
const HOST = '0.0.0.0';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    const p = path.join(__dirname, 'public', 'index.html');
    fs.existsSync(p) ? res.sendFile(p) : res.send('<h2>GrabNext AI Bot Running</h2>');
});

function requireAuth(req, res, next) {
    const pass =
        req.headers['x-admin-password'] ||
        (req.body && req.body.pass) ||
        req.query.pass;
    if (pass === DASHBOARD_PASSWORD) return next();
    return res.status(401).json({ error: 'Unauthorized — Wrong PIN' });
}

app.post('/api/verify-auth', (req, res) => {
    const password = req.body && req.body.password ? req.body.password : '';
    if (password === DASHBOARD_PASSWORD) return res.json({ success: true });
    res.status(401).json({ error: 'Galat Password! Try 2580.' });
});

app.get('/api/status', requireAuth, (req, res) => {
    res.json({
        active:        isBotActive,
        connected:     isConnected,
        activeModel:   activeModelName,
        pairingCode:   currentPairingCode,
        qrCode:        currentQrDataUrl,
        uptimeMinutes: Math.round((Date.now() - BOOT_TIME) / 60000),
    });
});

app.post('/api/toggle', requireAuth, (req, res) => {
    saveBotState(!isBotActive);
    _orig.log('Bot toggled via Dashboard: ' + (isBotActive ? 'ACTIVE' : 'PAUSED'));
    res.json({ success: true, active: isBotActive });
});

app.get('/api/knowledge', requireAuth, (req, res) => {
    const content = fs.existsSync('./business_info.txt')
        ? fs.readFileSync('./business_info.txt', 'utf8')
        : cachedSystemPrompt;
    res.json({ content });
});

app.post('/api/knowledge', requireAuth, (req, res) => {
    const content = req.body && req.body.content ? req.body.content : '';
    if (!content) return res.status(400).json({ error: 'Content required' });
    fs.writeFileSync('./business_info.txt', content, 'utf8');
    cachedSystemPrompt = content;
    rebuildGemini();
    _orig.log('Knowledge updated via Dashboard');
    res.json({ success: true });
});

app.post('/api/test-ai', requireAuth, async (req, res) => {
    const query = req.body && req.body.query ? req.body.query : '';
    if (!query) return res.status(400).json({ error: 'Query required' });
    const reply = await askGemini('web-test-' + Date.now(), query);
    res.json({ reply });
});

app.post('/api/request-pairing', requireAuth, async (req, res) => {
    const phone = ((req.body && req.body.phone) ? req.body.phone : '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    if (!activeSocket || activeSocket.authState.creds.registered) {
        return res.json({ message: 'Already connected or still initializing' });
    }
    try {
        const code = await activeSocket.requestPairingCode(phone);
        currentPairingCode = code;
        res.json({ code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/activity', requireAuth, (req, res) => {
    res.json(activityLogs);
});

// ─── LAUNCH ───────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
    _orig.log('='.repeat(50));
    _orig.log('WEB DASHBOARD: http://localhost:' + PORT);
    _orig.log('Dashboard PIN: ' + DASHBOARD_PASSWORD);
    _orig.log('Admin Phone: ' + ADMIN_PHONE_RAW);
    _orig.log('='.repeat(50));
});

startBot().catch(err => {
    _orig.error('Fatal startup error:', err.message);
    process.exit(1);
});
