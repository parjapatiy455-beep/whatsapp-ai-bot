# WhatsApp AI Customer Support Bot (24/7 Auto-Reply)

A high-performance, production-ready WhatsApp AI customer support bot built with **Baileys** (WebSocket) and **Google Gemini 2.5 Flash** with custom business knowledge and instant auto-reply.

## ✨ Features
- ⚡ **Sub-second Response Time**: Ultra-low latency responses using Gemini 2.5 Flash with fallback logic.
- 🧠 **Business Knowledge Base**: Pre-loaded system prompt via `business_info.txt` with live hot-reloading (zero disk latency).
- 📱 **Admin Controls via WhatsApp**:
  - `.bot on` - Turn on auto-reply for all incoming messages.
  - `.bot off` - Pause bot (incoming messages will be ignored).
  - `.bot status` - Check whether bot is active or paused.
  - `.test <query>` - Run private self-test from admin number anytime.
- 🔤 **WhatsApp Native Bold Formatting**: Automatically converts Markdown `**text**` to WhatsApp `*text*`.
- 🛡️ **Zero Message Drops**: Non-blocking concurrency via `setImmediate`, duplicate prevention, and retry mechanism.
- 🧹 **Console Spam Filter**: Suppresses verbose `libsignal` session keys and ratchet debug spam.

## 🚀 Quick Setup & Deployment

### 1. Clone & Install
```bash
git clone https://github.com/parjapatiy455-beep/whatsapp-ai-bot.git
cd whatsapp-ai-bot
npm install
```

### 2. Environment Variables (.env)
Create a `.env` file with:
```env
GEMINI_API_KEY=your_google_gemini_api_key_here
PHONE_NUMBER=91XXXXXXXXXX
```

### 3. Customize Business Knowledge
Edit `business_info.txt` to include your company's products, services, FAQs, and links.

### 4. Start the Bot
```bash
node index.js
```
On first run, a pairing code will appear in the console. Go to:
**WhatsApp > Linked Devices > Link a Device > Link with phone number** and enter the code.
