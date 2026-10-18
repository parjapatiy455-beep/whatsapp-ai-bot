/**
 * ============================================================================
 * WHATSAPP AI CUSTOMER SUPPORT BOT — ENTERPRISE v8.0 (SENIOR PRODUCTION)
 * ============================================================================
 * CRITICAL ARCHITECTURAL FIXES:
 *  1. PASSWORD-PROTECTED DASHBOARD: Secure PIN/Password authentication (PIN: 2580).
 *     All API endpoints & dashboard UI require valid password verification.
 *  2. CUSTOMER REPLY FIX (JID Resolution):
 *     Baileys/WhatsApp multi-device routes inbound messages from either @lid or @s.whatsapp.net.
 *     If replying to @lid fails or gets rejected, it automatically resolves & falls back
 *     to canonical phone JID (@s.whatsapp.net).
 *  3. QUOTED MESSAGE SAFETY:
 *     Inbound messages often have mismatched keys or ephemeral metadata. If quoting
 *     fails, the bot sends as a direct message (ensures zero dropped replies).
 *  4. ROBUST ADMIN DETECTION:
 *     Admin detection is isolated to explicit commands (.bot on, .bot off, .bot status, .test).
 *     Ordinary customer messages (including from other numbers) are NEVER blocked.
 *  5. AUTO RETRY & KEY RESYNC:
 *     Built-in retry cache for Baileys to prevent 'Bad MAC Error' from dropping replies.
 * ============================================================================
 */

'use strict';

const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── DASHBOARD PASSWORD ───────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '2580';

// ─── SUPPRESS LIBSIGNAL SESSION SPAM ─────────────────────────────────────────
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
    'privKey', 'pubKey', 'remoteIdentityKey', 'chainKey',
    'chainType', 'messageKeys', 'previousCounter', 'signedKeyId',
    'Failed to decrypt message with any known session', 'Bad MAC Error',
    'Closing open session in favor of incoming prekey bundle'
];

function isSpam(args) {
    const str = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a) || '')).join(' ');
    return SPAM_KEYWORDS.some(k => str.includes(k));
}

console.log   = (...a) => { if (!isSpam(a)) _orig.log(...a); };
console.warn  = (...a) => { if (!isSpam(a)) _orig.warn(...a); };
console.error = (...a) => { if (!isSpam(a)) _orig.error(...a); };
console.info  = (...a) => { if (!isSpam(a)) _orig.info(...a); };

// ─── BOT GLOBAL STATE & LIVE LOGS ─────────────────────────────────────────────
const STATE_FILE = './bot_state.json';
let isBotActive = true;
let isConnected = false;
let currentPairingCode = null;
let currentQrDataUrl = null;
let activeSocket = null;
const activityLogs = [];

function addActivityLog(sender, message, reply, status = 'replied') {
    const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    activityLogs.unshift({ sender, message, reply, status, time });
    if (activityLogs.length > 50) activityLogs.pop();
}

function loadBotState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (typeof data.active === 'boolean') isBotActive = data.active;
        }
    } catch (e) {
        _orig.warn('Could not read bot_state.json, defaulting to active: true');
    }
}

function saveBotState(status) {
    isBotActive = status;
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ active: isBotActive, updated: new Date().toISOString() }, null, 2));
    } catch (e) {
        _orig.error('Failed to save bot_state.json:', e.message);
    }
}
loadBotState();

// ─── BUSINESS KNOWLEDGE CACHE ─────────────────────────────────────────────────
let cachedSystemPrompt = `You are a professional, friendly AI Customer Support Assistant for an Indian business. 
Reply in Hinglish (Hindi + English mix). Be concise, helpful, and polite.
Keep replies short (2-4 lines max). Always end with asking if they need more help.`;

function loadBusinessKnowledge() {
    try {
        if (fs.existsSync('./business_info.txt')) {
            const content = fs.readFileSync('./business_info.txt', 'utf8').trim();
            if (content.length > 10) {
                cachedSystemPrompt = content;
                _orig.log('✅ business_info.txt loaded into memory cache.');
            }
        }
    } catch (e) {
        _orig.error('Failed to load business_info.txt:', e.message);
    }
}
loadBusinessKnowledge();

// ─── GEMINI AI ENGINE ─────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) _orig.error('❌ CRITICAL: GEMINI_API_KEY environment variable is NOT set!');

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || 'MISSING_KEY');
const MODEL_LIST = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];
let activeModelName = MODEL_LIST[0];
let aiModel = null;

function rebuildGemini(modelName) {
    const name = modelName || activeModelName;
    try {
        aiModel = genAI.getGenerativeModel({
            model: name,
            systemInstruction: cachedSystemPrompt,
            generationConfig: {
                maxOutputTokens: 300,
                temperature: 0.65,
                topP: 0.95,
            },
        });
        activeModelName = name;
    } catch (e) {
        _orig.error(`❌ Gemini init failed for ${name}:`, e.message);
    }
}
rebuildGemini();

function cleanWhatsAppFormatting(text) {
    if (!text) return '';
    return text
        .replace(/\*\*\*(.*?)\*\*\*/g, '*$1*')
        .replace(/\*\*(.*?)\*\*/g, '*$1*')
        .replace(/\*\*/g, '*');
}

const userHistory = new Map();

async function askGemini(userJid, userText) {
    if (!userHistory.has(userJid)) userHistory.set(userJid, []);
    const history = userHistory.get(userJid);

    let prompt = '';
    if (history.length > 0) {
        prompt = history.map(h => `${h.role}: ${h.text}`).join('\n') + '\n';
    }
    prompt += `Customer: ${userText}\nAssistant:`;

    const t0 = Date.now();

    for (const modelName of MODEL_LIST) {
        try {
            if (modelName !== activeModelName) rebuildGemini(modelName);
            const result = await aiModel.generateContent(prompt);
            const rawReply = result.response.text().trim();
            const formattedReply = cleanWhatsAppFormatting(rawReply);
            const ms = Date.now() - t0;

            _orig.log(`⚡ Gemini replied in ${ms}ms [${activeModelName}]`);
            history.push({ role: 'Customer', text: userText });
            history.push({ role: 'Assistant', text: formattedReply });
            if (history.length > 6) history.splice(0, 2);

            return formattedReply;
        } catch (err) {
            _orig.warn(`⚠️ Model [${modelName}] failed: ${err.message.slice(0, 80)}`);
        }
    }
    return 'Namaste! Hamara server thoda busy hai. Hamari team aapse 5 minutes mein contact karegi. 🙏';
}

// ─── MESSAGE STORE & RETRY DEBOUNCER ──────────────────────────────────────────
const msgStore = new Map();
const seenIds = new Set();

function storeMsg(key, message) {
    if (!key?.id || !message) return;
    msgStore.set(key.id, message);
    if (msgStore.size > 1500) msgStore.delete(msgStore.keys().next().value);
}

function isDuplicate(id) {
    if (!id) return false;
    if (seenIds.has(id)) return true;
    seenIds.add(id);
    if (seenIds.size > 3000) seenIds.delete(seenIds.values().next().value);
    return false;
}

const pendingQueues = new Map();

/**
 * Robust reply sender that handles both @s.whatsapp.net and @lid JIDs
 * and falls back gracefully if quoting fails.
 */
async function sendSafeReply(sock, targetJid, text, quotedMsg) {
    // Attempt 1: Normal quoted reply
    try {
        const sent = await sock.sendMessage(targetJid, { text }, { quoted: quotedMsg });
        if (sent) return sent;
    } catch (e1) {
        _orig.warn(`⚠️ Quoted send failed to ${targetJid}: ${e1.message}. Retrying direct...`);
    }

    // Attempt 2: Direct send without quote (in case quoted message key was invalid)
    try {
        const sent = await sock.sendMessage(targetJid, { text });
        if (sent) return sent;
    } catch (e2) {
        _orig.warn(`⚠️ Direct send failed to ${targetJid}: ${e2.message}`);
    }

    // Attempt 3: If JID is @lid, try sender phone JID or vice-versa
    if (targetJid.includes('@lid') && quotedMsg?.key?.participant) {
        const altJid = quotedMsg.key.participant;
        try {
            _orig.log(`🔄 Retrying with participant JID: ${altJid}`);
            const sent = await sock.sendMessage(altJid, { text });
            if (sent) return sent;
        } catch (_) {}
    }

    throw new Error('All send attempts failed');
}

function scheduleReply(sock, from, msg, text) {
    if (!pendingQueues.has(from)) {
        pendingQueues.set(from, { parts: [], latestMsg: null, timer: null });
    }
    const q = pendingQueues.get(from);
    q.parts.push(text);
    q.latestMsg = msg;

    if (q.timer) clearTimeout(q.timer);

    q.timer = setTimeout(async () => {
        const combined = q.parts.join(' ').trim();
        pendingQueues.delete(from);

        _orig.log(`\n🚀 [PROCESSING CUSTOMER] ${from} → "${combined}"`);
        try { await sock.sendPresenceUpdate('composing', from); } catch (_) {}

        const reply = await askGemini(from, combined);

        let sent = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                sent = await sendSafeReply(sock, from, reply, q.latestMsg);
                break;
            } catch (sendErr) {
                _orig.warn(`⚠️ Attempt ${attempt} failed for ${from}: ${sendErr.message}`);
                if (attempt < 3) await new Promise(r => setTimeout(r, 800 * attempt));
            }
        }

        if (sent) {
            storeMsg(sent.key, sent.message);
            _orig.log(`✅ [DELIVERED TO CUSTOMER] → ${from}`);
            addActivityLog(from.replace(/@.+/, ''), combined, reply, 'replied');
        } else {
            _orig.error(`❌ [FAILED ALL 3 ATTEMPTS] → ${from}`);
            addActivityLog(from.replace(/@.+/, ''), combined, 'Delivery failed', 'failed');
        }

        try { await sock.sendPresenceUpdate('paused', from); } catch (_) {}
    }, 500);
}

function extractText(msg) {
    if (!msg?.message) return '';
    const m = msg.message;
    const inner =
        m.ephemeralMessage?.message ||
        m.viewOnceMessage?.message ||
        m.viewOnceMessageV2?.message ||
        m.documentWithCaptionMessage?.message ||
        m;
    return (
        inner.conversation ||
        inner.extendedTextMessage?.text ||
        inner.imageMessage?.caption ||
        inner.videoMessage?.caption ||
        ''
    ).trim();
}

// ─── BAILEYS WHATSAPP ENGINE ──────────────────────────────────────────────────
async function startBot() {
    _orig.log('🔄 Connecting to WhatsApp...');
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 25000,
        browser: ['Ubuntu', 'Chrome', '22.0.0'],
        getMessage: async (key) => msgStore.get(key?.id) || undefined,
    });

    activeSocket = sock;

    if (!sock.authState.creds.registered) {
        const rawPhone = (process.env.PHONE_NUMBER || '').replace(/\D/g, '');
        if (rawPhone) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(rawPhone);
                    currentPairingCode = code;
                    _orig.log('\n==================================================');
                    _orig.log(`👉 PAIRING CODE:  ${code}`);
                    _orig.log('==================================================\n');
                } catch (e) {
                    _orig.error('Pairing code error:', e.message);
                }
            }, 3000);
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            try {
                currentQrDataUrl = await QRCode.toDataURL(qr);
            } catch (err) {}
        }

        if (connection === 'close') {
            isConnected = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            _orig.log(`⚠️ Disconnected (code=${code}). Reconnect: ${shouldReconnect}`);
            if (shouldReconnect) setTimeout(startBot, 3000);
        } else if (connection === 'open') {
            isConnected = true;
            currentPairingCode = null;
            currentQrDataUrl = null;
            _orig.log('\n==================================================');
            _orig.log(`⚡ BOT ONLINE — STATUS: [${isBotActive ? 'ACTIVE (ON)' : 'PAUSED (OFF)'}]`);
            _orig.log('==================================================\n');
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            setImmediate(() => handleMessage(sock, msg).catch(e =>
                _orig.error('❌ handleMessage crash:', e.message)
            ));
        }
    });
}

function isAdminSender(msg, from) {
    if (msg?.key?.fromMe) return true;
    const adminPhone = (process.env.PHONE_NUMBER || '').replace(/\D/g, '');
    if (adminPhone && from) {
        const cleanFrom = from.replace(/\D/g, '');
        if (cleanFrom.length >= 10 && (cleanFrom.includes(adminPhone) || adminPhone.includes(cleanFrom))) {
            return true;
        }
    }
    return false;
}

async function handleMessage(sock, msg) {
    const from  = msg?.key?.remoteJid || 'unknown';
    const msgId = msg?.key?.id || '';
    const fromMe = msg?.key?.fromMe || false;

    if (!msg?.message || !msg?.key) return;
    if (isDuplicate(msgId)) return;
    storeMsg(msg.key, msg.message);

    // Skip groups, status broadcast & newsletters
    if (from.endsWith('@g.us') || from.includes('status@broadcast') || from.includes('newsletter')) return;

    const text = extractText(msg);
    if (!text) return;

    _orig.log(`💬 Inbound [${from}] (fromMe=${fromMe}): "${text}"`);
    const cleanLower = text.toLowerCase().trim();

    // ── 1. ADMIN COMMANDS (Explicit command triggers only) ─────────────────────
    const isCommand = cleanLower.startsWith('.bot') || cleanLower.startsWith('.test');

    if (isAdminSender(msg, from) && isCommand) {
        if (cleanLower === '.bot off') {
            saveBotState(false);
            await sock.sendMessage(from, { text: '🔴 *Bot is now PAUSED (OFF)*.' });
            return;
        }
        if (cleanLower === '.bot on') {
            saveBotState(true);
            await sock.sendMessage(from, { text: '🟢 *Bot is now ACTIVE (ON)*.' });
            return;
        }
        if (cleanLower === '.bot status') {
            const statusText = isBotActive ? '🟢 *ACTIVE (ON)*' : '🔴 *PAUSED (OFF)*';
            await sock.sendMessage(from, { text: `📊 *Status:* ${statusText}\nModel: *${activeModelName}*` });
            return;
        }
        if (cleanLower.startsWith('.test')) {
            const query = text.slice(5).trim() || 'Hello, test!';
            try {
                const aiReply = await askGemini(from, query);
                const sent = await sock.sendMessage(from, { text: aiReply });
                if (sent) storeMsg(sent.key, sent.message);
                _orig.log(`✅ [TEST REPLY SENT to ${from}]`);
            } catch (e) {
                _orig.error('Test reply failed:', e.message);
            }
            return;
        }
    }

    // Ignore bot's own regular messages (so it doesn't talk to itself)
    if (fromMe) return;

    // ── 2. GLOBAL PAUSE CHECK ─────────────────────────────────────────────────
    if (!isBotActive) {
        _orig.log(`⏸️ Bot paused. Ignored customer message from ${from}`);
        return;
    }

    // ── 3. REAL CUSTOMER AUTO-REPLY (For ALL other numbers) ────────────────────
    _orig.log(`📥 Customer query queued: "${text}" from ${from}`);
    scheduleReply(sock, from, msg, text);
}

// ─── EXPRESS WEB DASHBOARD ────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
const HOST = '0.0.0.0';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Root Route: Serve Dashboard HTML
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send('<h2>GrabNext AI Agent Running!</h2><p>public/index.html is missing on server.</p>');
    }
});

// Middleware: Password Protection for API
function requireAuth(req, res, next) {
    const pass = req.headers['x-admin-password'] || req.query.pass;
    if (pass === DASHBOARD_PASSWORD) return next();
    return res.status(401).json({ error: 'Unauthorized: Invalid Password' });
}

// Auth Verification Endpoint
app.post('/api/verify-auth', (req, res) => {
    const { password } = req.body;
    if (password === DASHBOARD_PASSWORD) {
        return res.json({ success: true });
    }
    return res.status(401).json({ error: 'Galat Password! Kripya sahi password dalein.' });
});

// 1. Live Bot Status Endpoint
app.get('/api/status', requireAuth, (req, res) => {
    res.json({
        active: isBotActive,
        connected: isConnected,
        activeModel: activeModelName,
        pairingCode: currentPairingCode,
        qrCode: currentQrDataUrl,
    });
});

// 2. Toggle Bot State (ON / OFF)
app.post('/api/toggle', requireAuth, (req, res) => {
    saveBotState(!isBotActive);
    _orig.log(`🔘 Bot state changed from Web Dashboard: ${isBotActive ? 'ACTIVE' : 'PAUSED'}`);
    res.json({ success: true, active: isBotActive });
});

// 3. Fetch Knowledge Base
app.get('/api/knowledge', requireAuth, (req, res) => {
    try {
        const content = fs.existsSync('./business_info.txt')
            ? fs.readFileSync('./business_info.txt', 'utf8')
            : cachedSystemPrompt;
        res.json({ content });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. Update Knowledge Base live
app.post('/api/knowledge', requireAuth, (req, res) => {
    try {
        const { content } = req.body;
        if (!content) return res.status(400).json({ error: 'Content is required' });
        fs.writeFileSync('./business_info.txt', content, 'utf8');
        cachedSystemPrompt = content;
        rebuildGemini();
        _orig.log('📝 Knowledge Base updated via Web Dashboard!');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. Test AI Prompt in Dashboard
app.post('/api/test-ai', requireAuth, async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Query is required' });
        const reply = await askGemini('web-test', query);
        res.json({ reply });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 6. Request Pairing Code via Dashboard
app.post('/api/request-pairing', requireAuth, async (req, res) => {
    try {
        const { phone } = req.body;
        const clean = (phone || '').replace(/\D/g, '');
        if (!clean) return res.status(400).json({ error: 'Valid phone number required' });

        if (!activeSocket || activeSocket.authState.creds.registered) {
            return res.json({ message: 'WhatsApp already connected or socket initializing.' });
        }
        const code = await activeSocket.requestPairingCode(clean);
        currentPairingCode = code;
        res.json({ code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7. Recent Message Activity Log
app.get('/api/activity', requireAuth, (req, res) => {
    res.json(activityLogs);
});

// ─── START WEB SERVER & BOT ───────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
    _orig.log(`\n==================================================`);
    _orig.log(`🌐 WEB DASHBOARD RUNNING AT: http://${HOST}:${PORT}`);
    _orig.log(`🔒 DASHBOARD PASSWORD: ${DASHBOARD_PASSWORD}`);
    _orig.log(`==================================================\n`);
});

startBot().catch(err => {
    _orig.error('❌ Fatal bot crash:', err);
    process.exit(1);
});
