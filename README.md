# WhatsApp AI Customer Support Bot (24/7 with Web Dashboard)

A high-performance, enterprise-ready WhatsApp AI customer support bot built with **Baileys** (WebSocket) and **Google Gemini 2.5 Flash** with custom business knowledge, instant auto-reply, and a **Modern Web Admin Dashboard**.

---

## 🖥️ Web Admin Dashboard Features
- 🔗 **Visual WhatsApp Linking**: View your WhatsApp **Pairing Code** or **QR Code** directly in your browser without digging through server logs.
- 🟢 **One-Click Bot Pause/Resume**: Toggle bot auto-reply on/off instantly with a single button.
- 📝 **Live Knowledge Base & Prompt Editor**: Edit your products, pricing, links, and system instructions in real-time. Changes are saved and applied automatically without server restart!
- 🧪 **AI Response Playground**: Test prompts and queries right in the dashboard to inspect AI responses.
- 💬 **Live WhatsApp Activity Feed**: Real-time log of customer incoming questions and bot responses.

---

## 🚀 Quick Setup & Deployment

### 1. Clone & Install
```bash
git clone https://github.com/parjapatiy455-beep/whatsapp-ai-bot.git
cd whatsapp-ai-bot
npm install
```

### 2. Environment Variables (.env)
Create a `.env` file in the root directory:
```env
GEMINI_API_KEY=your_google_gemini_api_key_here
PHONE_NUMBER=91XXXXXXXXXX
PORT=3000
```

### 3. Start the Bot & Dashboard
```bash
npm start
```
Open your browser and navigate to:
👉 **`http://localhost:3000`** (or your hosting IP/URL).

---

## 📱 WhatsApp Admin Controls (From WhatsApp Itself)
You can also manage the bot directly from your admin phone number:
- `.bot on` - Turn on auto-reply for all incoming messages.
- `.bot off` - Pause bot (incoming customer messages will be ignored).
- `.bot status` - Check current bot status and active model.
- `.test <query>` - Run private self-test from admin number anytime.
