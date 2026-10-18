/**
 * ============================================================================
 * WHATSAPP AI CUSTOMER SUPPORT BOT — PRODUCTION v6.0
 * ============================================================================
 * NEW FEATURES:
 *  ✅ Admin ON/OFF Toggle: Admin number se ".bot off", ".bot on", ".bot status"
 *     bhej kar pure bot ko all messages ke liye enable/disable kar sakte hain.
 *  ✅ WhatsApp Single Asterisk Formatting: AI response se double asterisks (**)
 *     hata kar single asterisk (*) replace karta hai taaki WhatsApp format sahi dikhe.
 *  ✅ Self-test support (.test <query>)
 *  ✅ Sub-second response via gemini-2.5-flash with fallback
 *  ✅ Zero message drops, smart debouncing & non-blocking execution
 * ============================================================================
 */

'use strict';

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

// ─── IMPORTS ──────────────────────────────────────────────────────────────────
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino   = require('pino');
const fs     = require('fs');
require('dotenv').config();

// ─── BOOT TIME ────────────────────────────────────────────────────────────────
const BOOT_TIME_MS = Date.now();
_orig.log(`\n🚀 Bot starting at ${new Date(BOOT_TIME_MS).toISOString()}\n`);

// ─── BOT GLOBAL STATE (PERSISTENT ON/OFF) ──────────────────────────────────────
const STATE_FILE = './bot_state.json';
let isBotActive = true;

function loadBotState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (typeof data.active === 'boolean') {
                isBotActive = data.active;
            }
        }
    } catch (e) {
        _orig.warn('Could not read bot_state.json, defaulting to active: true');
    }
    _orig.log(`🤖 Initial Bot State: [${isBotActive ? 'ACTIVE (ON)' : 'PAUSED (OFF)'}]`);
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
        } else {
            _orig.log('ℹ️  business_info.txt not found — using default prompt.');
        }
    } catch (e) {
        _orig.error('Failed to load business_info.txt:', e.message);
    }
}
loadBusinessKnowledge();

if (fs.existsSync('./business_info.txt')) {
    fs.watchFile('./business_info.txt', { interval: 3000 }, () => {
        _orig.log('🔄 business_info.txt changed — reloading...');
        loadBusinessKnowledge();
        rebuildGemini();
    });
}

// ─── GEMINI AI ENGINE ─────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    _orig.error('❌ CRITICAL: GEMINI_API_KEY environment variable is NOT set!');
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || 'MISSING_KEY');

const MODEL_LIST = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-1.5-flash',
];

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

// Per-user conversation history (last 3 turns = 6 entries)
const userHistory = new Map();

/**
 * Clean Markdown formatting to match WhatsApp syntax:
 * Replaces Markdown bold (**) with WhatsApp bold (*)
 * Replaces triple asterisks (***) with single bold (*)
 */
function cleanWhatsAppFormatting(text) {
    if (!text) return '';
    return text
        // Replace triple asterisks (bold italic in md) with single asterisk
        .replace(/\*\*\*(.*?)\*\*\*/g, '*$1*')
        // Replace double asterisks (standard md bold) with single asterisk (WhatsApp bold)
        .replace(/\*\*(.*?)\*\*/g, '*$1*')
        // Extra cleanup: replace leftover double asterisks
        .replace(/\*\*/g, '*');
}

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
            if (modelName !== activeModelName) {
                rebuildGemini(modelName);
            }
            const result = await aiModel.generateContent(prompt);
            const rawReply = result.response.text().trim();
            const formattedReply = cleanWhatsAppFormatting(rawReply);
            const ms = Date.now() - t0;

            _orig.log(`⚡ Gemini replied in ${ms}ms [${activeModelName}]`);

            // Save to memory
            history.push({ role: 'Customer',  text: userText });
            history.push({ role: 'Assistant', text: formattedReply });
            if (history.length > 6) history.splice(0, 2);

            return formattedReply;
        } catch (err) {
            _orig.warn(`⚠️ Model [${modelName}] failed: ${err.message.slice(0, 80)}`);
        }
    }

    return 'Namaste! Hamara server thoda busy hai. Hamari team aapse 5 minutes mein contact karegi. 🙏';
}

// ─── MESSAGE STORE (for WhatsApp E2E retry requests) ──────────────────────────
const msgStore = new Map();

function storeMsg(key, message) {
    if (!key?.id || !message) return;
    msgStore.set(key.id, message);
    if (msgStore.size > 1000) {
        msgStore.delete(msgStore.keys().next().value);
    }
}

// ─── DEDUPLICATION SET ────────────────────────────────────────────────────────
const seenIds = new Set();

function isDuplicate(id) {
    if (!id) return false;
    if (seenIds.has(id)) return true;
    seenIds.add(id);
    if (seenIds.size > 3000) seenIds.delete(seenIds.values().next().value);
    return false;
}

// ─── DEBOUNCER — combine rapid double-messages (600ms window) ─────────────────
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

        try {
            await sock.sendPresenceUpdate('composing', from);
        } catch (_) {}

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
        } else {
            _orig.error(`❌ [FAILED ALL 3 ATTEMPTS] → ${from}`);
        }

        try {
            await sock.sendPresenceUpdate('paused', from);
        } catch (_) {}

    }, 600);
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

// ─── WHATSAPP CONNECTION ──────────────────────────────────────────────────────
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

    // ── PAIRING CODE ──────────────────────────────────────────────────────────
    if (!sock.authState.creds.registered) {
        const rawPhone = (process.env.PHONE_NUMBER || '').replace(/\D/g, '');
        if (rawPhone) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(rawPhone);
                    _orig.log('\n==================================================');
                    _orig.log(`👉 PAIRING CODE:  ${code}`);
                    _orig.log('==================================================\n');
                } catch (e) {
                    _orig.error('Pairing code error:', e.message);
                }
            }, 3000);
        } else {
            _orig.error('❌ PHONE_NUMBER env variable not set! Cannot generate pairing code.');
        }
    }

    sock.ev.on('creds.update', saveCreds);

    // ── CONNECTION LIFECYCLE ──────────────────────────────────────────────────
    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            _orig.log(`⚠️ Disconnected (code=${code}). Reconnect: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(startBot, 3000);
            } else {
                _orig.error('❌ Logged out. Delete auth_session folder and restart.');
            }
        } else if (connection === 'open') {
            _orig.log('\n==================================================');
            _orig.log(`⚡ BOT ONLINE — STATUS: [${isBotActive ? 'ACTIVE (ON)' : 'PAUSED (OFF)'}]`);
            _orig.log('==================================================\n');
        } else if (connection === 'connecting') {
            _orig.log('🔗 Connecting...');
        }
    });

    // ── INCOMING MESSAGES ─────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', ({ messages, type }) => {
        _orig.log(`\n📨 [UPSERT] type=${type} | count=${messages.length}`);

        if (type !== 'notify') return;

        for (const msg of messages) {
            setImmediate(() => handleMessage(sock, msg).catch(e =>
                _orig.error('❌ handleMessage crash:', e.message)
            ));
        }
    });
}

// ─── ADMIN CHECK ──────────────────────────────────────────────────────────────
function isAdminMessage(msg, from) {
    // 1. fromMe means message sent from the linked phone itself (e.g. "Message yourself" or chat)
    if (msg?.key?.fromMe) return true;

    // 2. Check if sender number matches PHONE_NUMBER in .env
    const adminPhone = (process.env.PHONE_NUMBER || '').replace(/\D/g, '');
    if (adminPhone && from) {
        const cleanFrom = from.replace(/\D/g, '');
        if (cleanFrom.includes(adminPhone) || adminPhone.includes(cleanFrom)) {
            return true;
        }
    }
    return false;
}

// ─── CORE MESSAGE HANDLER ─────────────────────────────────────────────────────
async function handleMessage(sock, msg) {
    const from  = msg?.key?.remoteJid || 'unknown';
    const msgId = msg?.key?.id || '';
    const fromMe = msg?.key?.fromMe || false;

    _orig.log(`   📩 RAW: from=${from} | fromMe=${fromMe} | id=${msgId}`);

    if (!msg?.message || !msg?.key) return;

    if (isDuplicate(msgId)) return;

    storeMsg(msg.key, msg.message);

    // Skip groups, broadcast status and newsletters
    if (from.endsWith('@g.us') || from.includes('status@broadcast') || from.includes('newsletter')) {
        return;
    }

    const text = extractText(msg);
    if (!text) return;

    _orig.log(`   💬 Text: "${text}"`);
    const cleanLower = text.toLowerCase().trim();

    // ── 1. ADMIN COMMANDS (fromMe OR owner's phone) ───────────────────────────
    if (isAdminMessage(msg, from)) {
        // Toggle OFF
        if (cleanLower === '.bot off') {
            saveBotState(false);
            _orig.log('🛑 [ADMIN COMMAND] Bot turned OFF by admin.');
            await sock.sendMessage(from, { text: '🔴 *Bot is now PAUSED (OFF)*.\nCustomers ke messages ke replies band kar diye gaye hain.' });
            return;
        }

        // Toggle ON
        if (cleanLower === '.bot on') {
            saveBotState(true);
            _orig.log('🟢 [ADMIN COMMAND] Bot turned ON by admin.');
            await sock.sendMessage(from, { text: '🟢 *Bot is now ACTIVE (ON)*.\n24/7 AI Auto-reply dobara chalu ho gaya hai.' });
            return;
        }

        // Check Status
        if (cleanLower === '.bot status') {
            const statusText = isBotActive ? '🟢 *ACTIVE (ON)*' : '🔴 *PAUSED (OFF)*';
            await sock.sendMessage(from, { text: `📊 *Bot Current Status:*\nState: ${statusText}\nModel: *${activeModelName}*` });
            return;
        }

        // Admin Self-Test (.test <query>)
        if (cleanLower.startsWith('.test')) {
            const query = text.slice(5).trim() || 'Hello, test kar raha hoon!';
            _orig.log(`\n🧪 [SELF-TEST] Query: "${query}"`);
            try {
                const aiReply = await askGemini(from, query);
                const sent = await sock.sendMessage(from, { text: aiReply });
                if (sent) storeMsg(sent.key, sent.message);
                _orig.log(`✅ [SELF-TEST REPLY SENT]`);
            } catch (e) {
                _orig.error('❌ Self-test send failed:', e.message);
            }
            return;
        }

        // If message is fromMe but not a command, ignore so we don't reply to our own chat
        if (fromMe) {
            _orig.log('   ↳ fromMe=true and not an admin command — ignoring.');
            return;
        }
    }

    // ── 2. GLOBAL PAUSE CHECK ─────────────────────────────────────────────────
    if (!isBotActive) {
        _orig.log(`   ⏸️ Bot is PAUSED (.bot off). Ignoring customer message from ${from}.`);
        return;
    }

    // ── 3. CUSTOMER AUTO-REPLY ────────────────────────────────────────────────
    _orig.log(`   ✅ Customer message queued for reply`);
    scheduleReply(sock, from, msg, text);
}

// ─── START ────────────────────────────────────────────────────────────────────
startBot().catch(err => {
    _orig.error('❌ Fatal bot crash:', err);
    process.exit(1);
});
