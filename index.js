/**
 * ============================================================================
 * WHATSAPP AI CUSTOMER SUPPORT BOT — ENTERPRISE v7.0 (WITH WEB DASHBOARD)
 * ============================================================================
 * ARCHITECTURE:
 *  ✅ Express Web Dashboard on PORT (default 3000 or process.env.PORT)
 *  ✅ Visual Pairing Code / QR Code display right in Browser
 *  ✅ Realtime One-Click Pause/Resume Bot Toggle
 *  ✅ Live System Prompt & Business Knowledge Editor
 *  ✅ Live AI Playground to test prompts
 *  ✅ Live Message Feed with real-time logs
 *  ✅ Native WhatsApp formatting (*bold*, clean layout)
 *  ✅ Multi-device Baileys engine with Zero-Message-Drop queue
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
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
const activityLogs = []; // Stores recent 30 message events for dashboard

function addActivityLog(sender, message, reply, status = 'replied') {
    const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    activityLogs.unshift({ sender, message, reply, status, time });
    if (activityLogs.length > 40) activityLogs.pop();
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
    if (msgStore.size > 1000) msgStore.delete(msgStore.keys().next().value);
}

function isDuplicate(id) {
    if (!id) return false;
    if (seenIds.has(id)) return true;
    seenIds.add(id);
    if (seenIds.size > 3000) seenIds.delete(seenIds.values().next().value);
    return false;
}

const pendingQueues = new Map();

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

        _orig.log(`\n🚀 [PROCESSING] ${from} → "${combined}"`);
        try { await sock.sendPresenceUpdate('composing', from); } catch (_) {}

        const reply = await askGemini(from, combined);

        let sent = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                sent = await sock.sendMessage(from, { text: reply }, { quoted: q.latestMsg });
                break;
            } catch (sendErr) {
                _orig.warn(`⚠️ Send attempt ${attempt} failed: ${sendErr.message}`);
                if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }

        if (sent) {
            storeMsg(sent.key, sent.message);
            _orig.log(`✅ [SENT] → ${from}`);
            addActivityLog(from.replace('@s.whatsapp.net', ''), combined, reply, 'replied');
        } else {
            _orig.error(`❌ [FAILED ALL 3 ATTEMPTS] → ${from}`);
            addActivityLog(from.replace('@s.whatsapp.net', ''), combined, 'Delivery failed', 'failed');
        }

        try { await sock.sendPresenceUpdate('paused', from); } catch (_) {}
    }, 600);
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
        keepAliveIntervalMs: 20000,
        browser: ['Ubuntu', 'Chrome', '22.0.0'],
        getMessage: async (key) => msgStore.get(key?.id) || undefined,
    });

    activeSocket = sock;

    // Pairing code logic
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

function isAdminMessage(msg, from) {
    if (msg?.key?.fromMe) return true;
    const adminPhone = (process.env.PHONE_NUMBER || '').replace(/\D/g, '');
    if (adminPhone && from) {
        const cleanFrom = from.replace(/\D/g, '');
        if (cleanFrom.includes(adminPhone) || adminPhone.includes(cleanFrom)) return true;
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

    if (from.endsWith('@g.us') || from.includes('status@broadcast') || from.includes('newsletter')) return;

    const text = extractText(msg);
    if (!text) return;

    _orig.log(`💬 Inbound [${from}]: "${text}"`);
    const cleanLower = text.toLowerCase().trim();

    // Admin commands
    if (isAdminMessage(msg, from)) {
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
            } catch (e) {}
            return;
        }
        if (fromMe) return;
    }

    if (!isBotActive) {
        _orig.log(`⏸️ Bot paused. Dropped message from ${from}`);
        return;
    }

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



// 1. Live Bot Status Endpoint
app.get('/api/status', (req, res) => {
    res.json({
        active: isBotActive,
        connected: isConnected,
        activeModel: activeModelName,
        pairingCode: currentPairingCode,
        qrCode: currentQrDataUrl,
    });
});

// 2. Toggle Bot State (ON / OFF)
app.post('/api/toggle', (req, res) => {
    saveBotState(!isBotActive);
    _orig.log(`🔘 Bot state changed from Web Dashboard: ${isBotActive ? 'ACTIVE' : 'PAUSED'}`);
    res.json({ success: true, active: isBotActive });
});

// 3. Fetch Knowledge Base
app.get('/api/knowledge', (req, res) => {
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
app.post('/api/knowledge', (req, res) => {
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
app.post('/api/test-ai', async (req, res) => {
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
app.post('/api/request-pairing', async (req, res) => {
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
app.get('/api/activity', (req, res) => {
    res.json(activityLogs);
});

// ─── START WEB SERVER & BOT ───────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
    _orig.log(`\n==================================================`);
    _orig.log(`🌐 WEB DASHBOARD RUNNING AT: http://${HOST}:${PORT}`);
    _orig.log(`==================================================\n`);
});

startBot().catch(err => {
    _orig.error('❌ Fatal bot crash:', err);
    process.exit(1);
});


