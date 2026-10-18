/**
 * ============================================================================
 * HIGH-PERFORMANCE WHATSAPP AI AGENT (ENTERPRISE / ULTRA-FAST HYBRID v12.0)
 * ============================================================================
 * Combines:
 *  1. Original Ultra-Fast Engine (<1.2s instant response, minimal latency).
 *  2. Web Dashboard with PIN 2580 authentication.
 *  3. Admin control (.bot on / .bot off / .bot status).
 *  4. Direct AI auto-reply on normal messages for both admin & customers.
 *  5. Clean console output (mutes libsignal internal dumps).
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

// ─── 1. CLEAN CONSOLE & FILTER NOISE ─────────────────────────────────────────
const originalLog = console.log;
console.log = function (...args) {
    const text = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    if (text.includes('Closing session') || 
        text.includes('SessionEntry') || 
        text.includes('incoming prekey bundle') ||
        text.includes('currentRatchet') ||
        text.includes('registrationId') ||
        text.includes('Bad MAC')) {
        return;
    }
    originalLog.apply(console, args);
};

// ─── 2. CONFIG & STATE ────────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '2580';
const ADMIN_PHONE_RAW    = (process.env.ADMIN_PHONE || '917500167987').replace(/\D/g, '');
const BOOT_TIMESTAMP     = Math.floor(Date.now() / 1000);
const BOOT_TIME_MS       = Date.now();
const STATE_FILE         = './bot_state.json';

let isBotActive          = true;
let isConnected          = false;
let currentPairingCode   = null;
let currentQrDataUrl     = null;
let activeSocket         = null;
const activityLogs       = [];

// Track message IDs sent by our bot so it never self-replies
const botSentMsgIds      = new Set();

function addActivityLog(sender, message, reply, status) {
    const time = new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    activityLogs.unshift({ sender, message, reply, status: status || 'replied', time });
    if (activityLogs.length > 80) activityLogs.pop();
}

function loadBotState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (typeof d.active === 'boolean') isBotActive = d.active;
        }
    } catch (_) {}
    console.log('🤖 Bot state on boot: ' + (isBotActive ? 'ACTIVE' : 'PAUSED'));
}

function saveBotState(active) {
    isBotActive = active;
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            active: isBotActive,
            updated: new Date().toISOString()
        }), 'utf8');
    } catch (e) {}
}
loadBotState();

// ─── 3. BUSINESS KNOWLEDGE IN-MEMORY CACHE ────────────────────────────────────
let cachedBusinessPrompt = 'You are a polite, helpful and professional AI Customer Support Assistant for GrabNext - an Indian digital marketplace. Reply in friendly Hinglish (Hindi + English mix). Keep replies to max 3-4 lines. Use WhatsApp formatting (*bold* with single asterisk). End every reply asking if customer needs more help.';

function loadBusinessKnowledge() {
    try {
        if (fs.existsSync('./business_info.txt')) {
            const c = fs.readFileSync('./business_info.txt', 'utf8').trim();
            if (c.length > 10) cachedBusinessPrompt = c;
            console.log('⚡ Business knowledge loaded into high-speed memory cache.');
        }
    } catch (e) {}
}
loadBusinessKnowledge();

if (fs.existsSync('./business_info.txt')) {
    fs.watchFile('./business_info.txt', { interval: 2000 }, () => {
        console.log('🔄 business_info.txt updated on disk. Reloading cache...');
        loadBusinessKnowledge();
        reinitGeminiModel();
    });
}

// ─── 4. GEMINI AI ULTRA-FAST ENGINE ──────────────────────────────────────────
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.error('❌ CRITICAL: GEMINI_API_KEY is missing!');
const genAI = new GoogleGenerativeAI(apiKey || 'dummy_key');

const ACTIVE_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];
let aiModel = null;
let currentModelName = ACTIVE_MODELS[0];

function reinitGeminiModel() {
    try {
        aiModel = genAI.getGenerativeModel({
            model: currentModelName,
            systemInstruction: cachedBusinessPrompt,
            generationConfig: {
                maxOutputTokens: 250,
                temperature: 0.6,
                topP: 0.95
            }
        });
    } catch (e) {}
}
reinitGeminiModel();

const conversationMemories = new Map();

function fixFormatting(text) {
    return (text || '')
        .replace(/\*\*\*(.*?)\*\*\*/g, '*$1*')
        .replace(/\*\*(.*?)\*\*/g, '*$1*')
        .replace(/\*\*/g, '*');
}

async function generateAIResponse(userJid, userMessage) {
    if (!conversationMemories.has(userJid)) {
        conversationMemories.set(userJid, []);
    }
    const history = conversationMemories.get(userJid);

    const conversationContext = history.length > 0 
        ? `Recent Context:\n${history.map(h => `${h.role}: ${h.text}`).join('\n')}\n\n`
        : '';
    const prompt = `${conversationContext}Customer: ${userMessage}\nAssistant:`;

    const startTime = Date.now();

    for (const modelCandidate of ACTIVE_MODELS) {
        try {
            if (modelCandidate !== currentModelName) {
                currentModelName = modelCandidate;
                reinitGeminiModel();
            }

            const result = await aiModel.generateContent(prompt);
            const rawText = result.response.text();
            const text = fixFormatting(rawText.trim());
            const latency = Date.now() - startTime;

            console.log(`⚡ AI Generated in ${latency}ms using ${currentModelName}`);

            history.push({ role: 'Customer', text: userMessage });
            history.push({ role: 'Assistant', text: text });
            if (history.length > 6) history.splice(0, 2);

            return text;
        } catch (err) {
            console.warn(`⚠️ Model ${modelCandidate} failed. Trying fallback...`);
        }
    }

    return 'Namaste! 🙏 Abhi network thoda busy hai. Kripya thodi der baad dobara message karein ya visit karein: https://grabnext.pages.dev';
}

// ─── 5. RETRY STORE & DEDUPLICATION ───────────────────────────────────────────
const messageStore = new Map();
const processedMessageIds = new Set();

function saveToMessageStore(key, message) {
    if (key?.id && message) {
        messageStore.set(key.id, message);
        if (messageStore.size > 1500) {
            const oldest = messageStore.keys().next().value;
            messageStore.delete(oldest);
        }
    }
}

// ─── 6. FAST DEBOUNCER & DIRECT DELIVERY (NO SLEEP WAITS) ────────────────────
const customerQueues = new Map();

function enqueueCustomerMessage(sock, from, originalMsg, text) {
    if (!customerQueues.has(from)) {
        customerQueues.set(from, { messages: [], latestMsg: originalMsg, timer: null });
    }

    const queue = customerQueues.get(from);
    queue.messages.push(text);
    queue.latestMsg = originalMsg;

    if (queue.timer) clearTimeout(queue.timer);

    queue.timer = setTimeout(async () => {
        const combinedText = queue.messages.join(' ').trim();
        customerQueues.delete(from);

        console.log(`\n🚀 [PROCESSING] User: ${from} | Query: "${combinedText}"`);

        try {
            // Typing indicator
            sock.sendPresenceUpdate('composing', from).catch(() => {});

            // Generate AI Response (Ultra Fast)
            const reply = await generateAIResponse(from, combinedText);

            // Direct instant send
            const sent = await sock.sendMessage(from, { text: reply });
            if (sent?.key?.id) {
                botSentMsgIds.add(sent.key.id);
                if (botSentMsgIds.size > 2000) botSentMsgIds.delete(botSentMsgIds.values().next().value);
                saveToMessageStore(sent.key, sent.message);
            }

            sock.sendPresenceUpdate('paused', from).catch(() => {});
            console.log(`✅ [DELIVERED to ${from}] Instant Reply!`);
            addActivityLog(from.replace(/@.+/, ''), combinedText, reply, 'replied');

        } catch (err) {
            console.error(`❌ Delivery error:`, err.message);
            addActivityLog(from.replace(/@.+/, ''), combinedText, 'Delivery error', 'failed');
        }
    }, 600); // 600ms quick debounce for typing bursts
}

function extractCleanText(msg) {
    if (!msg || !msg.message) return '';
    const m = msg.message;
    const real = m.ephemeralMessage?.message ||
                 m.viewOnceMessage?.message ||
                 m.viewOnceMessageV2?.message ||
                 m.documentWithCaptionMessage?.message ||
                 m;

    return (real.conversation ||
            real.extendedTextMessage?.text ||
            real.imageMessage?.caption ||
            real.videoMessage?.caption ||
            '').trim();
}

function isAdminUser(msg, from, fromMe) {
    if (fromMe) return true;
    if (ADMIN_PHONE_RAW) {
        const par = (msg && msg.key && msg.key.participant) ? msg.key.participant : '';
        if (from.startsWith(ADMIN_PHONE_RAW + '@') || par.startsWith(ADMIN_PHONE_RAW + '@')) {
            return true;
        }
    }
    return false;
}

// ─── 7. HIGH-THROUGHPUT BAILEYS CONNECTION ───────────────────────────────────
async function connectToWhatsApp() {
    console.log('🔄 Initializing High-Speed WhatsApp Socket...');
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
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        getMessage: async (key) => {
            if (key?.id && messageStore.has(key.id)) {
                return messageStore.get(key.id);
            }
            return { conversation: '' };
        }
    });

    activeSocket = sock;

    const rawNumber = process.env.PHONE_NUMBER || ADMIN_PHONE_RAW || '';
    const phoneNumber = rawNumber.replace(/[^0-9]/g, '');

    if (!sock.authState.creds.registered && phoneNumber) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                currentPairingCode = code;
                console.log('\n==================================================');
                console.log(`👉 AAPKA PAIRING CODE:  ${code}`);
                console.log('==================================================\n');
            } catch (err) {}
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            QRCode.toDataURL(qr).then(url => { currentQrDataUrl = url; }).catch(() => {});
        }
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(connectToWhatsApp, 2500);
        } else if (connection === 'open') {
            isConnected = true;
            currentPairingCode = null;
            currentQrDataUrl = null;
            console.log('\n==================================================');
            console.log(`⚡ HIGH-SPEED 24/7 AI AGENT FULLY OPERATIONAL! [${isBotActive ? 'ACTIVE' : 'PAUSED'}]`);
            console.log('==================================================\n');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!messages) return;

        for (const msg of messages) {
            setImmediate(async () => {
                try {
                    if (!msg.message || !msg.key) return;

                    const msgId = msg.key.id;
                    if (botSentMsgIds.has(msgId)) return; // Ignore own outgoing replies
                    if (processedMessageIds.has(msgId)) return;
                    processedMessageIds.add(msgId);
                    if (processedMessageIds.size > 3000) {
                        const first = processedMessageIds.values().next().value;
                        processedMessageIds.delete(first);
                    }

                    saveToMessageStore(msg.key, msg.message);

                    const msgTimestamp = Number(msg.messageTimestamp || 0);
                    if (msgTimestamp > 0 && msgTimestamp < BOOT_TIMESTAMP - 15) {
                        return; // Ignore old stored history
                    }

                    const from = msg.key.remoteJid;
                    if (!from || from.endsWith('@g.us') || from.includes('status@broadcast') || from.includes('newsletter')) {
                        return;
                    }

                    const text = extractCleanText(msg);
                    if (!text) return;

                    const cleanLower = text.toLowerCase().trim();

                    // ── ADMIN CONTROL COMMANDS (.bot on / .bot off / .bot status) ────────
                    if (cleanLower.startsWith('.bot')) {
                        const isAuth = isAdminUser(msg, from, msg.key.fromMe);
                        if (!isAuth) {
                            const sent = await sock.sendMessage(from, { text: '❌ *Access Denied:* Yeh command sirf admin ke liye reserved hai.' });
                            if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
                            return;
                        }

                        if (cleanLower === '.bot off') {
                            saveBotState(false);
                            const sent = await sock.sendMessage(from, { text: '🔴 *Bot PAUSED* — Customers ko ab AI reply nahi jayega.' });
                            if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
                            console.log('🛑 Bot PAUSED by Admin');
                            return;
                        }
                        if (cleanLower === '.bot on') {
                            saveBotState(true);
                            const sent = await sock.sendMessage(from, { text: '🟢 *Bot ACTIVE* — Auto-reply chalu ho gaya hai! Direct instant reply active.' });
                            if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
                            console.log('▶️ Bot ACTIVATED by Admin');
                            return;
                        }
                        if (cleanLower === '.bot status') {
                            const st = isBotActive ? '🟢 ACTIVE' : '🔴 PAUSED';
                            const up = Math.round((Date.now() - BOOT_TIME_MS) / 60000);
                            const sent = await sock.sendMessage(from, {
                                text: `📊 *Bot Status Report*\nStatus: *${st}*\nModel: *${currentModelName}*\nUptime: *${up} min*\nLogs: ${activityLogs.length}`
                            });
                            if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
                            return;
                        }
                        if (cleanLower === '.bot help') {
                            const sent = await sock.sendMessage(from, {
                                text: '🤖 *Admin Commands:*\n.bot on — Bot chalu karein\n.bot off — Bot band karein\n.bot status — Status check karein\n\n💡 *Note:* Normal message par bot instant AI reply deta hai.'
                            });
                            if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
                            return;
                        }
                    }

                    // ── CHECK IF BOT IS PAUSED ───────────────────────────────
                    if (!isBotActive) {
                        return; // Bot paused, skip customer message
                    }

                    // ── DIRECT ULTRA-FAST AI REPLY (Customers & Admin) ────────
                    enqueueCustomerMessage(sock, from, msg, text);

                } catch (err) {}
            });
        }
    });
}

// ─── 8. EXPRESS DASHBOARD (PIN: 2580) ─────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
const HOST = '0.0.0.0';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    const p = path.join(__dirname, 'public', 'index.html');
    fs.existsSync(p) ? res.sendFile(p) : res.send('<h2>GrabNext Ultra-Fast AI Bot Running ✅</h2>');
});

function requireAuth(req, res, next) {
    const pass = req.headers['x-admin-password'] || (req.body && req.body.pass) || req.query.pass;
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
        activeModel:   currentModelName,
        pairingCode:   currentPairingCode,
        qrCode:        currentQrDataUrl,
        uptimeMinutes: Math.round((Date.now() - BOOT_TIME_MS) / 60000),
    });
});

app.post('/api/toggle', requireAuth, (req, res) => {
    saveBotState(!isBotActive);
    console.log('🔘 Bot toggled via Dashboard: ' + (isBotActive ? 'ACTIVE' : 'PAUSED'));
    res.json({ success: true, active: isBotActive });
});

app.get('/api/knowledge', requireAuth, (req, res) => {
    const content = fs.existsSync('./business_info.txt')
        ? fs.readFileSync('./business_info.txt', 'utf8')
        : cachedBusinessPrompt;
    res.json({ content });
});

app.post('/api/knowledge', requireAuth, (req, res) => {
    const content = req.body && req.body.content ? req.body.content : '';
    if (!content) return res.status(400).json({ error: 'Content required' });
    fs.writeFileSync('./business_info.txt', content, 'utf8');
    cachedBusinessPrompt = content;
    reinitGeminiModel();
    console.log('📝 Knowledge updated via Dashboard');
    res.json({ success: true });
});

app.post('/api/test-ai', requireAuth, async (req, res) => {
    const query = req.body && req.body.query ? req.body.query : '';
    if (!query) return res.status(400).json({ error: 'Query required' });
    const reply = await generateAIResponse('web-test-' + Date.now(), query);
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

// Disconnect / Unlink WhatsApp from Dashboard
app.post('/api/disconnect-whatsapp', requireAuth, async (req, res) => {
    console.log('⚠️ Disconnect / Unlink WhatsApp requested from Dashboard...');
    try {
        if (activeSocket) {
            try {
                await activeSocket.logout();
            } catch (err) {}
            try {
                activeSocket.end();
            } catch (err) {}
        }
        
        // Remove auth_session folder contents so fresh pairing code can be generated
        const sessionPath = path.join(__dirname, 'auth_session');
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log('🗑️ auth_session cleared for new login.');
        }

        res.json({ success: true, message: 'WhatsApp unlinked successfully! Reconnecting for fresh pairing...' });

        // Trigger fresh connection in 1.5s
        setTimeout(() => {
            connectToWhatsApp();
        }, 1500);

    } catch (e) {
        console.error('Disconnect error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/activity', requireAuth, (req, res) => {
    res.json(activityLogs);
});

// ─── CODE EDITOR & AUTO-RESTART API ──────────────────────────────────────────
// Get index.js code
app.get('/api/code', requireAuth, (req, res) => {
    try {
        const filePath = path.join(__dirname, 'index.js');
        const content = fs.readFileSync(filePath, 'utf8');
        res.json({ content });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Save index.js code
app.post('/api/code', requireAuth, (req, res) => {
    const { content } = req.body || {};
    if (typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: 'Valid code content required' });
    }
    try {
        const filePath = path.join(__dirname, 'index.js');
        // Create backup of old code first
        fs.writeFileSync(path.join(__dirname, 'index.backup.js'), fs.readFileSync(filePath, 'utf8'), 'utf8');
        // Write new updated code
        fs.writeFileSync(filePath, content, 'utf8');
        console.log('💾 index.js updated via Web Dashboard Editor!');
        res.json({ success: true, message: 'Code saved successfully! Click Restart to apply.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 1-Click Server Restart (triggers Pterodactyl/Docker container auto-restart)
app.post('/api/restart-bot', requireAuth, (req, res) => {
    console.log('🔄 Restart requested via Web Dashboard...');
    res.json({ success: true, message: 'Server restarting now... Reconnecting in 5 seconds.' });

    // Gracefully exit; Pterodactyl daemon immediately boots up fresh process with new code
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

app.listen(PORT, HOST, () => {
    console.log('\n==================================================');
    console.log(`🌐 ULTRA-FAST DASHBOARD: http://0.0.0.0:${PORT}`);
    console.log(`🔒 DASHBOARD PASSWORD: ${DASHBOARD_PASSWORD}`);
    console.log(`👑 ADMIN PHONE: ${ADMIN_PHONE_RAW}`);
    console.log('==================================================\n');
});

connectToWhatsApp();
