/**
 * ============================================================================
 * WHATSAPP AI CUSTOMER SUPPORT BOT — PRODUCTION v11.0 (DIRECT WORK FIX)
 * ============================================================================
 * USER REQUIREMENT:
 *  1. ".test" bilkul HATA DIYA! Admin aur customer dono se DIRECT message pe
 *     AI reply karega (jaise "hi", "products list", "kya price hai").
 *  2. Self-chat (fromMe=true): Bot ke apne replies ko ignore karega (by botSentMsgIds),
 *     lekin jab Admin khud kuch bhi type karega (bina kisi command ke),
 *     toh direct AI reply dega!
 *  3. Admin control commands (.bot on, .bot off, .bot status, .bot help)
 *     abhi bhi available hain bot pause/resume karne ke liye.
 *  4. Other customers (fromMe=false): Har incoming message par direct AI reply!
 *  5. Upsert types: handles both 'notify' and 'append'.
 *  6. Safe send to both standard JIDs and @lid Multi-Device JIDs.
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
const ADMIN_PHONE_RAW    = (process.env.ADMIN_PHONE || '917500167987').replace(/\D/g, '');

// ─── CONSOLE LOGGING WITH SPAM FILTER ────────────────────────────────────────
const _orig = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    info:  console.info.bind(console),
};

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

let isBotActive        = true;
let isConnected        = false;
let currentPairingCode = null;
let currentQrDataUrl   = null;
let activeSocket       = null;
const activityLogs     = [];

// Track message IDs sent by our bot so we don't reply to our own echo
const botSentMsgIds = new Set();

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
        _orig.log('✅ business_info.txt loaded into memory cache.');
    } catch (e) {
        _orig.error('business_info.txt load error:', e.message);
    }
}
loadBusinessKnowledge();

if (fs.existsSync('./business_info.txt')) {
    fs.watchFile('./business_info.txt', { interval: 5000 }, () => {
        _orig.log('🔄 business_info.txt changed — reloading AI prompt...');
        loadBusinessKnowledge();
        rebuildGemini();
    });
}

// ─── GEMINI ENGINE ────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) _orig.error('❌ CRITICAL: GEMINI_API_KEY is missing in .env!');

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
        _orig.log('🧠 Gemini model ready: ' + name);
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
        _orig.log('⏳ Already processing for ' + userId + ' — skipping duplicate');
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
            _orig.log('⚡ Gemini replied in ' + ms + 'ms [' + activeModelName + ']');
            history.push({ role: 'Customer', text: userText });
            history.push({ role: 'Assistant', text: reply });
            if (history.length > 10) history.splice(0, 2);
            break;
        } catch (err) {
            _orig.warn('⚠️ Gemini [' + modelName + '] error: ' + err.message.slice(0, 120));
        }
    }

    activeGenerations.delete(userId);

    if (!reply) {
        return 'Namaste! 🙏 Abhi server thoda busy hai. Kripya 2 minute baad dobara message karein.\nHamare digital products check karne ke liye visit karein: https://grabnext.pages.dev';
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

// ─── ROBUST SENDER (NO QUOTED KEYS) ───────────────────────────────────────────
async function deliverReply(sock, targetJid, text) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const sent = await sock.sendMessage(targetJid, { text: text });
            if (sent && sent.key && sent.key.id) {
                botSentMsgIds.add(sent.key.id);
                if (botSentMsgIds.size > 2000) botSentMsgIds.delete(botSentMsgIds.values().next().value);
                storeMsg(sent.key, sent.message);
                _orig.log('✅ Delivered to ' + targetJid + ' (attempt ' + attempt + ')');
                return sent;
            }
        } catch (e) {
            _orig.warn('⚠️ Send attempt ' + attempt + ' to ' + targetJid + ' failed: ' + e.message);
        }
        if (attempt < 3) {
            await new Promise(r => setTimeout(r, attempt * 1000));
        }
    }
    _orig.error('❌ ALL 3 DELIVERY ATTEMPTS FAILED for ' + targetJid);
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

        _orig.log('\n🚀 [AI PROCESSING] Target: ' + from);
        _orig.log('   📝 Query: "' + combined + '"');

        try { await sock.sendPresenceUpdate('composing', from); } catch (_) {}

        const reply = await askGemini(from, combined);

        if (!reply) {
            _orig.warn('   ⚠️ AI returned null. Skipping send.');
            try { await sock.sendPresenceUpdate('paused', from); } catch (_) {}
            return;
        }

        _orig.log('   🤖 AI Reply ready: "' + reply.slice(0, 80) + '..."');

        const sent = await deliverReply(sock, from, reply);

        if (sent) {
            _orig.log('   ✅ SUCCESS — reply sent to ' + from);
            addActivityLog(from.replace(/@.+/, ''), combined, reply, 'replied');
        } else {
            _orig.error('   ❌ FAILED — could not deliver to ' + from);
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

// ─── CORE MESSAGE HANDLER ─────────────────────────────────────────────────────
async function handleMessage(sock, msg) {
    const from   = (msg && msg.key && msg.key.remoteJid) ? msg.key.remoteJid : '';
    const msgId  = (msg && msg.key && msg.key.id)        ? msg.key.id        : '';
    const fromMe = (msg && msg.key && msg.key.fromMe)    ? msg.key.fromMe    : false;

    if (!msg || !msg.message || !from || !msgId) return;

    // Ignore messages that were sent by the bot process itself (prevent reply loops)
    if (botSentMsgIds.has(msgId)) {
        return;
    }

    if (isDuplicate(msgId)) {
        return;
    }

    storeMsg(msg.key, msg.message);

    // Skip groups, status broadcasts, newsletters
    if (from.endsWith('@g.us'))            return;
    if (from.includes('status@broadcast')) return;
    if (from.includes('newsletter'))       return;

    const text = extractText(msg);
    if (!text) return;

    const cleanLower = text.toLowerCase().trim();
    _orig.log('\n📩 [MSG INBOUND] from=' + from + ' | fromMe=' + fromMe + ' | text="' + text + '"');

    // ── 1. CONTROL COMMANDS (.bot on / off / status / help) ────────────────────
    if (cleanLower === '.bot off') {
        saveBotState(false);
        await deliverReply(sock, from, '🔴 *Bot PAUSED* — Customers ko ab AI reply nahi jayega.');
        _orig.log('🛑 Bot PAUSED');
        return;
    }
    if (cleanLower === '.bot on') {
        saveBotState(true);
        await deliverReply(sock, from, '🟢 *Bot ACTIVE* — Auto-reply chalu ho gaya hai! Direct message par AI reply karega.');
        _orig.log('▶️ Bot ACTIVATED');
        return;
    }
    if (cleanLower === '.bot status') {
        const st = isBotActive ? '🟢 ACTIVE' : '🔴 PAUSED';
        const up = Math.round((Date.now() - BOOT_TIME) / 60000);
        await deliverReply(sock, from, '📊 *Bot Status Report*\nStatus: *' + st + '*\nModel: *' + activeModelName + '*\nUptime: *' + up + ' min*\nTotal Logs: ' + activityLogs.length);
        return;
    }
    if (cleanLower === '.bot help') {
        await deliverReply(sock, from, '🤖 *Available Commands:*\n.bot on — Bot chalu karein\n.bot off — Bot band karein\n.bot status — Status check karein\n\n💡 *Note:* Kisi bhi normal message ("Hi", "products", "price") par bot DIRECT reply karega! (.test likhne ki zaroorat nahi hai)');
        return;
    }

    // ── 2. CHECK IF BOT IS PAUSED ─────────────────────────────────────────────
    if (!isBotActive) {
        _orig.log('   ⏸️ Bot is PAUSED — dropping message from ' + from);
        return;
    }

    // ── 3. DIRECT AI REPLY (FOR BOTH ADMIN AND OTHER USERS) ────────────────────
    // Har normal message par direct AI reply dega (bina kisi .test prefix ke)!
    _orig.log('   ✨ Direct message detected — queuing AI reply for ' + from);
    scheduleReply(sock, from, text);
}

// ─── WHATSAPP CONNECTION ──────────────────────────────────────────────────────
async function startBot() {
    _orig.log('🔄 Connecting to WhatsApp...');

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
                    _orig.log('\n' + '='.repeat(50) + '\n👉 PAIRING CODE:  ' + code + '\n' + '='.repeat(50) + '\n');
                } catch (e) {
                    _orig.error('Pairing code error:', e.message);
                }
            }, 3000);
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const connection     = update.connection;
        const lastDisconnect = update.lastDisconnect;
        const qr             = update.qr;

        if (qr) {
            try { currentQrDataUrl = await QRCode.toDataURL(qr); } catch (_) {}
        }
        if (connection === 'close') {
            isConnected = false;
            const code      = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : 0;
            const reconnect = code !== DisconnectReason.loggedOut;
            _orig.log('⚠️ Disconnected (code=' + code + '). Reconnect=' + reconnect);
            if (reconnect) setTimeout(startBot, 4000);
            else           _orig.error('❌ Logged out — delete auth_session and restart server.');
        } else if (connection === 'open') {
            isConnected        = true;
            currentPairingCode = null;
            currentQrDataUrl   = null;
            _orig.log('\n' + '='.repeat(50) + '\n⚡ BOT ONLINE — STATUS: [' + (isBotActive ? 'ACTIVE (ON)' : 'PAUSED (OFF)') + ']\n' + '='.repeat(50) + '\n');
        }
    });

    // Listen to incoming messages (handles notify and all message updates)
    sock.ev.on('messages.upsert', (upsert) => {
        if (!upsert || !upsert.messages) return;
        for (const msg of upsert.messages) {
            setImmediate(() =>
                handleMessage(sock, msg).catch(e =>
                    _orig.error('❌ handleMessage crash:', e.message, e.stack ? e.stack.split('\n')[1] : '')
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
    fs.existsSync(p) ? res.sendFile(p) : res.send('<h2>GrabNext AI Bot Running ✅</h2>');
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
    _orig.log('🔘 Bot toggled via Dashboard: ' + (isBotActive ? 'ACTIVE' : 'PAUSED'));
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
    _orig.log('📝 Knowledge updated via Dashboard');
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
    _orig.log('\n' + '='.repeat(50));
    _orig.log('🌐 WEB DASHBOARD: http://0.0.0.0:' + PORT);
    _orig.log('🔒 DASHBOARD PASSWORD: ' + DASHBOARD_PASSWORD);
    _orig.log('👑 Admin Phone: ' + ADMIN_PHONE_RAW);
    _orig.log('='.repeat(50) + '\n');
});

startBot().catch(err => {
    _orig.error('❌ Fatal startup error:', err.message);
    process.exit(1);
});
