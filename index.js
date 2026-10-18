/**
 * ============================================================================
 * WHATSAPP AI CUSTOMER SUPPORT BOT — PRODUCTION v10.0 (EXPERT FINAL FIX)
 * ============================================================================
 * CRITICAL FIXES IN v10.0:
 *  1. ADMIN DETECTION: Uses PHONE NUMBER match (917500167987), NOT fromMe.
 *     fromMe=true means BOT sent the msg — admin's OWN messages have fromMe=false.
 *     Old v9.0 admin commands never worked because of this wrong assumption.
 *  2. CUSTOMER REPLY: All non-admin, non-group messages get AI reply when bot ON.
 *  3. SAFE SEND: Never uses quoted. Retries on @lid JIDs.
 *  4. GEMINI GUARD: One active call per user. No concurrent duplicates.
 *  5. SESSION STABLE: retryRequestDelayMs=2000, getMessage for retry protocol.
 *  6. DASHBOARD: PIN 2580, full controls — toggle, test, knowledge, logs.
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

// Admin phone number (digits only, with country code). 
// This is how we detect admin — by phone number, NOT by fromMe.
// fromMe=true means BOT ITSELF sent the message (e.g., bot's auto-reply).
// Admin's own typed messages have fromMe=false.
const ADMIN_PHONE_RAW = (process.env.ADMIN_PHONE || '917500167987').replace(/\D/g, '');

// ─── PRESERVE ORIGINAL CONSOLE (before spam filter) ──────────────────────────
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
let currentQrDataUrl = null;
let activeSocket     = null;
const activityLogs   = [];

function addActivityLog(sender, message, reply, status = 'replied') {
    const time = new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    activityLogs.unshift({ sender, message, reply, status, time });
    if (activityLogs.length > 100) activityLogs.pop();
}

function loadBotState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (typeof d.active === 'boolean') isBotActive = d.active;
        }
    } catch (_) {}
    _orig.log(`🤖 Bot State on boot: ${isBotActive ? '🟢 ACTIVE' : '🔴 PAUSED'}`);
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
let cachedSystemPrompt = `You are a professional AI Customer Support agent for GrabNext — an Indian digital marketplace.
Reply in Hinglish (Hindi + English mix). Be concise, helpful, warm and friendly.
Keep replies to max 3-4 lines. Use WhatsApp formatting (*bold* with single asterisk only).
End every reply by asking if customer needs more help.`;

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
        _orig.log(`🧠 Gemini model ready: ${name}`);
    } catch (e) {
        _orig.error(`Gemini init failed [${name}]:`, e.message);
    }
}
rebuildGemini();

// Fix markdown bold (**text** → *text* for WhatsApp)
function fixFormatting(text) {
    return (text || '')
        .replace(/\*\*\*(.*?)\*\*\*/g, '*$1*')
        .replace(/\*\*(.*?)\*\*/g, '*$1*')
        .replace(/\*\*/g, '*');
}

const userHistory    = new Map();
const activeGenerations = new Set(); // Rate-limit guard: one Gemini call per user

async function askGemini(userId, userText) {
    if (activeGenerations.has(userId)) {
        _orig.log(`⏳ [${userId}] Still processing previous message — skipping duplicate`);
        return null;
    }
    activeGenerations.add(userId);

    if (!userHistory.has(userId)) userHistory.set(userId, []);
    const history = userHistory.get(userId);

    // Build conversation context (last 6 turns)
    let prompt = '';
    if (history.length > 0) {
        prompt = history.slice(-6).map(h => `${h.role}: ${h.text}`).join('\n') + '\n';
    }
    prompt += `Customer: ${userText}\nAssistant:`;

    const t0 = Date.now();
    let reply = null;

    for (const modelName of MODEL_LIST) {
        try {
            if (modelName !== activeModelName) rebuildGemini(modelName);
            const result = await aiModel.generateContent(prompt);
            reply = fixFormatting(result.response.text().trim());
            const ms = Date.now() - t0;
            _orig.log(`⚡ Gemini replied in ${ms}ms [${activeModelName}]`);
            history.push({ role: 'Customer', text: userText });
            history.push({ role: 'Assistant', text: reply });
            if (history.length > 10) history.splice(0, 2);
            break;
        } catch (err) {
            _orig.warn(`⚠️ Gemini [${modelName}] error: ${err.message.slice(0, 120)}`);
        }
    }

    activeGenerations.delete(userId);

    if (!reply) {
        return 'Namaste! 🙏 Abhi server thoda busy hai. Kripya 2 minute baad dobara message karein. Hamare products ke liye visit karein: https://grabnext.pages.dev';
    }
    return reply;
}

// ─── MESSAGE STORE & DEDUP ────────────────────────────────────────────────────
const msgStore = new Map();
const seenIds  = new Set();

function storeMsg(key, message) {
    if (!key?.id || !message) return;
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

// ─── ROBUST SENDER (no quoted messages ever) ──────────────────────────────────
/**
 * CRITICAL: Never pass quoted key for customer replies.
 * @lid JID + quoted = silent delivery failure on WhatsApp Multi-Device.
 * Always send plain text. Retry up to 3 times with delay.
 */
async function deliverReply(sock, targetJid, text) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const sent = await sock.sendMessage(targetJid, { text });
            if (sent) {
                _orig.log(`✅ Delivered to ${targetJid} (attempt ${attempt})`);
                return sent;
            }
        } catch (e) {
            _orig.warn(`⚠️ Send attempt ${attempt} to ${targetJid} failed: ${e.message}`);
        }
        if (attempt < 3) {
            await new Promise(r => setTimeout(r, attempt * 1000)); // 1s, 2s delays
        }
    }
    _orig.error(`❌ ALL 3 DELIVERY ATTEMPTS FAILED for ${targetJid}`);
    return null;
}

// ─── MESSAGE DEBOUNCER (batch rapid messages) ─────────────────────────────────
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

        _orig.log(`\n🚀 [PROCESSING] ${from}`);
        _orig.log(`   📝 Query: "${combined}"`);

        // Show typing indicator to customer
        try { await sock.sendPresenceUpdate('composing', from); } catch (_) {}

        const reply = await askGemini(from, combined);

        if (!reply) {
            _orig.warn(`   ⚠️ AI returned null (likely duplicate guard). Skipping send.`);
            try { await sock.sendPresenceUpdate('paused', from); } catch (_) {}
            return;
        }

        _orig.log(`   🤖 AI Reply: "${reply.slice(0, 80)}..."`);

        const sent = await deliverReply(sock, from, reply);

        if (sent) {
            storeMsg(sent.key, sent.message);
            _orig.log(`   ✅ SUCCESS — reply delivered to ${from}`);
            addActivityLog(from.replace(/@.+/, ''), combined, reply, 'replied');
        } else {
            _orig.error(`   ❌ FAILED — could not deliver to ${from}`);
            addActivityLog(from.replace(/@.+/, ''), combined, 'Delivery failed', 'failed');
        }

        try { await sock.sendPresenceUpdate('paused', from); } catch (_) {}
    }, 600); // 600ms debounce — waits for rapid follow-up messages
}

// ─── TEXT EXTRACTOR ───────────────────────────────────────────────────────────
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

// ─── ADMIN DETECTOR ───────────────────────────────────────────────────────────
/**
 * Admin is detected by PHONE NUMBER, not fromMe.
 *
 * WHY: When admin types ".bot on" on their phone, WhatsApp delivers it to
 * the bot with fromMe=false (it's not sent by the bot, it's sent by the human).
 * fromMe=true only happens for messages the BOT ITSELF sends (e.g., auto-replies).
 *
 * The admin JID will be:  917500167987@s.whatsapp.net
 * or on Multi-Device LID: <some_lid>@lid
 *
 * We check if the remoteJid or participant contains the admin phone number.
 */
function isAdminSender(msg) {
    if (!ADMIN_PHONE_RAW) return false;
    const remoteJid  = msg?.key?.remoteJid || '';
    const participant = msg?.key?.participant || '';

    // Direct chat: remoteJid = "917500167987@s.whatsapp.net"
    if (remoteJid.startsWith(ADMIN_PHONE_RAW + '@')) return true;

    // Group message from admin
    if (participant.startsWith(ADMIN_PHONE_RAW + '@')) return true;

    // fromMe=true means BOT sent the message — only trust for status commands
    // to avoid treating bot's own auto-replies as admin commands
    return false;
}

// ─── CORE MESSAGE HANDLER ─────────────────────────────────────────────────────
async function handleMessage(sock, msg) {
    const from   = msg?.key?.remoteJid || '';
    const msgId  = msg?.key?.id        || '';
    const fromMe = msg?.key?.fromMe    || false;

    // Basic validity checks
    if (!msg?.message || !from || !msgId) return;

    // Deduplication
    if (isDuplicate(msgId)) {
        _orig.log(`🔁 Duplicate skipped: ${msgId}`);
        return;
    }

    // Store for WhatsApp message retry requests
    storeMsg(msg.key, msg.message);

    // Skip groups, status broadcasts, newsletter channels
    if (from.endsWith('@g.us'))             return;
    if (from.includes('status@broadcast'))  return;
    if (from.includes('newsletter'))        return;

    // Skip messages sent by the bot itself (its own auto-replies coming back)
    // Exception: .bot commands from the bot's own phone are handled below
    if (fromMe) {
        _orig.log(`   ↳ Skipping own sent message (fromMe=true)`);
        return;
    }

    const text = extractText(msg);
    if (!text) return;

    const cmd = text.toLowerCase().trim();
    _orig.log(`\n📩 [MSG] from=${from} | fromMe=${fromMe} | text="${text}"`);

    // ── ADMIN COMMANDS ────────────────────────────────────────────────────────
    if (isAdminSender(msg)) {
        _orig.log(`   👑 Admin message detected from ${from}`);

        if (cmd === '.bot off') {
            saveBotState(false);
            await deliverReply(sock, from, '🔴 *Bot PAUSED* — Customers ko ab AI reply nahi jayega. Dashboard se bhi control kar sakte hain.');
            _orig.log('🛑 Bot PAUSED by admin');
            return;
        }

        if (cmd === '.bot on') {
            saveBotState(true);
            await deliverReply(sock, from, '🟢 *Bot ACTIVE* — 24/7 auto-reply chalu ho gaya! Customers ko instantly reply milega.');
            _orig.log('▶️ Bot ACTIVATED by admin');
            return;
        }

        if (cmd === '.bot status') {
            const st     = isBotActive ? '🟢 ACTIVE' : '🔴 PAUSED';
            const uptime = Math.round((Date.now() - BOOT_TIME) / 60000);
            await deliverReply(sock, from,
                `📊 *Bot Status Report*\n` +
                `Status: *${st}*\n` +
                `Model: *${activeModelName}*\n` +
                `Uptime: *${uptime} minutes*\n` +
                `Logs: ${activityLogs.length} conversations`
            );
            return;
        }

        if (cmd.startsWith('.test')) {
            const q = text.slice(5).trim() || 'Hello, tell me about GrabNext products.';
            _orig.log(`🧪 Admin self-test: "${q}"`);
            const r = await askGemini('__admin_test__', q);
            await deliverReply(sock, from, r || '❌ No reply generated. Check GEMINI_API_KEY.');
            return;
        }

        if (cmd === '.bot help') {
            await deliverReply(sock, from,
                `🤖 *Bot Commands*\n` +
                `.bot on — Bot chalu karo\n` +
                `.bot off — Bot band karo\n` +
                `.bot status — Current status dekho\n` +
                `.test <query> — AI se test karo\n` +
                `.bot help — Yeh message`
            );
            return;
        }

        // Admin's non-command message — don't process as customer, don't reply
        _orig.log(`   ↳ Admin non-command message — ignored`);
        return;
    }

    // ── BOT PAUSE CHECK ───────────────────────────────────────────────────────
    if (!isBotActive) {
        _orig.log(`   ⏸️ Bot PAUSED — message from ${from} dropped (no reply sent)`);
        return;
    }

    // ── CUSTOMER MESSAGE → AI REPLY ───────────────────────────────────────────
    _orig.log(`   👤 Customer message — queuing AI reply for ${from}`);
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
        keepAliveIntervalMs: 25_000,
        retryRequestDelayMs: 2_000,
        connectTimeoutMs: 60_000,
        browser: ['Ubuntu', 'Chrome', '22.0.0'],
        getMessage: async (key) => {
            const stored = msgStore.get(key?.id);
            if (stored) return stored;
            return { conversation: '' }; // fallback to avoid "Waiting for this message"
        },
    });

    activeSocket = sock;

    // Request pairing code if not yet registered
    if (!sock.authState.creds.registered) {
        const rawPhone = (process.env.PHONE_NUMBER || ADMIN_PHONE_RAW).replace(/\D/g, '');
        if (rawPhone) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(rawPhone);
                    currentPairingCode = code;
                    _orig.log(`\n${'='.repeat(50)}\n👉 PAIRING CODE:  ${code}\n${'='.repeat(50)}\n`);
                } catch (e) {
                    _orig.error('Pairing code error:', e.message);
                }
            }, 3000);
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            try { currentQrDataUrl = await QRCode.toDataURL(qr); } catch (_) {}
        }
        if (connection === 'close') {
            isConnected = false;
            const code      = lastDisconnect?.error?.output?.statusCode;
            const reconnect = code !== DisconnectReason.loggedOut;
            _orig.log(`⚠️ Disconnected (code=${code}). Reconnect: ${reconnect}`);
            if (reconnect) setTimeout(startBot, 4000);
            else           _orig.error('❌ Logged out — delete auth_session and restart server.');
        } else if (connection === 'open') {
            isConnected      = true;
            currentPairingCode = null;
            currentQrDataUrl   = null;
            _orig.log(`\n${'='.repeat(50)}\n⚡ BOT ONLINE — STATUS: [${isBotActive ? 'ACTIVE (ON)' : 'PAUSED (OFF)'}]\n${'='.repeat(50)}\n`);
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            setImmediate(() =>
                handleMessage(sock, msg).catch(e =>
                    _orig.error('❌ handleMessage crash:', e.message, e.stack?.split('\n')[1])
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
        req.body?.pass ||
        req.query?.pass;
    if (pass === DASHBOARD_PASSWORD) return next();
    return res.status(401).json({ error: 'Unauthorized — Wrong PIN' });
}

// Auth verify
app.post('/api/verify-auth', (req, res) => {
    const { password } = req.body || {};
    if (password === DASHBOARD_PASSWORD) return res.json({ success: true });
    res.status(401).json({ error: 'Galat Password! Try 2580.' });
});

// Bot status
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

// Toggle bot on/off
app.post('/api/toggle', requireAuth, (req, res) => {
    saveBotState(!isBotActive);
    _orig.log(`🔘 Bot toggled via Dashboard → ${isBotActive ? 'ACTIVE' : 'PAUSED'}`);
    res.json({ success: true, active: isBotActive });
});

// Get business knowledge
app.get('/api/knowledge', requireAuth, (req, res) => {
    const content = fs.existsSync('./business_info.txt')
        ? fs.readFileSync('./business_info.txt', 'utf8')
        : cachedSystemPrompt;
    res.json({ content });
});

// Update business knowledge
app.post('/api/knowledge', requireAuth, (req, res) => {
    const { content } = req.body || {};
    if (!content) return res.status(400).json({ error: 'Content required' });
    fs.writeFileSync('./business_info.txt', content, 'utf8');
    cachedSystemPrompt = content;
    rebuildGemini();
    _orig.log('📝 Business knowledge updated via Dashboard');
    res.json({ success: true });
});

// Test AI from dashboard
app.post('/api/test-ai', requireAuth, async (req, res) => {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Query required' });
    const reply = await askGemini('web-test-' + Date.now(), query);
    res.json({ reply });
});

// Request WhatsApp pairing code via dashboard
app.post('/api/request-pairing', requireAuth, async (req, res) => {
    const phone = (req.body?.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ error: 'Phone number required (digits only)' });
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

// Activity logs
app.get('/api/activity', requireAuth, (req, res) => {
    res.json(activityLogs);
});

// ─── LAUNCH ───────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
    _orig.log(`\n${'='.repeat(50)}`);
    _orig.log(`🌐 WEB DASHBOARD RUNNING AT: http://localhost:${PORT}`);
    _orig.log(`🔒 Dashboard PIN: ${DASHBOARD_PASSWORD}`);
    _orig.log(`👑 Admin Phone: ${ADMIN_PHONE_RAW}`);
    _orig.log(`${'='.repeat(50)}\n`);
});

startBot().catch(err => {
    _orig.error('❌ Fatal startup error:', err.message);
    process.exit(1);
});
