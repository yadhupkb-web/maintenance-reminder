import express from 'express';
import crypto from 'crypto';
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
}
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PORT = 3001;

// ─── Express + Socket.IO ────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ─── Config ─────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {
    console.log('Could not load config, starting fresh.');
  }
  return { tasks: [] };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  io.emit('tasks_updated', cfg.tasks);
}

let config = loadConfig();

// ─── Logs ───────────────────────────────────────────────────────────────────

const messageLogs = [];

function addLog(type, message) {
  const entry = { type, message, timestamp: new Date().toISOString() };
  messageLogs.push(entry);
  if (messageLogs.length > 100) messageLogs.shift();
  io.emit('log', entry);
}

// ─── WhatsApp Client (Baileys) ──────────────────────────────────────────────

let clientStatus = 'disconnected';
let currentQR = '';
let sock;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'baileys_auth'));
  
  sock = makeWASocket({
    auth: state,
    browser: ['Mac OS', 'Safari', '10.15.7'],
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }), // Suppress heavy logging
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      clientStatus = 'qr';
      currentQR = qr;
      io.emit('status', clientStatus);
      io.emit('qr', currentQR);
      console.log('\n─────────────────────────────────────────');
      console.log('  Scan this QR code with WhatsApp:');
      console.log('  (Linked Devices → Link a Device)');
      console.log('─────────────────────────────────────────\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      clientStatus = 'disconnected';
      io.emit('status', clientStatus);
      addLog('error', `Disconnected: ${lastDisconnect?.error?.message || 'Unknown'}`);
      
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 10000);
      } else {
        addLog('error', 'Logged out. Please delete the server/baileys_auth folder and restart.');
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connected.\n');
      clientStatus = 'ready';
      currentQR = '';
      io.emit('status', clientStatus);
      addLog('success', 'WhatsApp connected.');
    }
  });

  const awaitingSelection = {}; // { chatId: [taskId1, taskId2] }

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim().toLowerCase();
    const chatId = msg.key.remoteJid;

    if (text === 'done') {
      const pendingTasks = [];
      
      for (let task of config.tasks) {
        let tChatId = task.chatId;
        if (!tChatId) {
          try {
            tChatId = await getValidChatId(task.phone);
            task.chatId = tChatId;
            saveConfig(config);
          } catch(e) {}
        }
        
        if (task.status === 'pending_reply' && tChatId === chatId) {
          pendingTasks.push(task);
        }
      }

      if (pendingTasks.length === 0) {
        await sock.sendMessage(chatId, { text: `❌ There are no pending reminders to complete here.` });
        return;
      }

      awaitingSelection[chatId] = pendingTasks.map(t => t.id);

      let reply = `📋 *Pending Tasks*\n\nPlease reply with the number corresponding to the task you want to complete:\n\n`;
      pendingTasks.forEach((task, index) => {
        reply += `${index + 1}. ${task.name} (every ${task.intervalValue} ${task.intervalType})\n`;
      });

      await sock.sendMessage(chatId, { text: reply });
      return;
    }

    const numMatch = text.match(/^(\d+)$/);
    if (numMatch && awaitingSelection[chatId]) {
      const index = parseInt(numMatch[1], 10) - 1;
      const taskIds = awaitingSelection[chatId];
      
      if (index >= 0 && index < taskIds.length) {
        const completedTaskId = taskIds[index];
        const task = config.tasks.find(t => t.id === completedTaskId);
        
        if (task && task.status === 'pending_reply') {
          task.status = 'scheduled';
          task.nextReminder = calculateNextReminder(task);
          delete task.overdueSince;
          delete task.lastReminderSentAt;
          delete task.lastWarningSentAt;
          
          delete awaitingSelection[chatId];
          saveConfig(config);
          
          addLog('success', `Task "${task.name}" completed by user.`);
          await sock.sendMessage(chatId, { text: `✅ Task *"${task.name}"* completed! Next reminder scheduled for ${task.intervalValue} ${task.intervalType} from now.` });
        }
      } else {
        await sock.sendMessage(chatId, { text: `❌ Invalid number. Please reply with a number between 1 and ${taskIds.length}.` });
      }
      return;
    }
  });
}

console.log('Starting WhatsApp client (Baileys)...');
connectToWhatsApp();

// ─── Dynamic Scheduling Logic ───────────────────────────────────────────────

async function getValidChatId(phoneOrGroup) {
  if (phoneOrGroup.includes('chat.whatsapp.com/')) {
    try {
      const inviteCode = phoneOrGroup.split('chat.whatsapp.com/')[1].replace('/', '').trim();
      const groupId = await sock.groupAcceptInvite(inviteCode);
      return groupId;
    } catch (err) {
      throw new Error(`Invalid group link or bot does not have permission: ${err.message}`);
    }
  } 
  else if (/[a-zA-Z]/.test(phoneOrGroup)) {
    throw new Error(`Please paste the WhatsApp Group Invite Link instead of the group name to prevent server crashes.`);
  } 
  else {
    const cleaned = phoneOrGroup.replace(/\D/g, '');
    const [result] = await sock.onWhatsApp(cleaned);
    if (!result || !result.exists) {
      throw new Error(`${phoneOrGroup} is not registered on WhatsApp.`);
    }
    return result.jid;
  }
}

function calculateInitialReminder(task) {
  const now = new Date();
  if (task.intervalType === 'minutes') {
    return new Date(now.getTime() + task.intervalValue * 60000).toISOString();
  } else {
    const dateStr = task.startDate || now.toISOString().split('T')[0];
    let reminderDate = new Date(`${dateStr}T${task.time}:00`);
    
    if (reminderDate <= now && !task.startDate) {
       reminderDate.setDate(reminderDate.getDate() + 1);
    } else if (reminderDate <= now && task.startDate) {
       while (reminderDate <= now) {
         reminderDate.setDate(reminderDate.getDate() + task.intervalValue);
       }
    }
    return reminderDate.toISOString();
  }
}

function calculateNextReminder(task) {
  const now = new Date();
  if (task.intervalType === 'minutes') {
    return new Date(now.getTime() + task.intervalValue * 60000).toISOString();
  } else {
    const next = new Date(now);
    next.setDate(next.getDate() + task.intervalValue);
    const [h, m] = task.time.split(':');
    next.setHours(parseInt(h, 10), parseInt(m, 10), 0, 0);
    return next.toISOString();
  }
}

function calculateOverdueText(overdueSinceISO, intervalType) {
  const overdueDate = new Date(overdueSinceISO);
  const diffMs = new Date() - overdueDate;
  if (intervalType === 'minutes') {
    const mins = Math.floor(diffMs / 60000);
    return `${mins} minute(s)`;
  } else {
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    return days === 0 ? 'less than a day' : `${days} day(s)`;
  }
}

setInterval(async () => {
  if (clientStatus !== 'ready' || !sock) return;
  const now = new Date();

  let stateChanged = false;

  for (let task of config.tasks) {
    if (task.status === 'scheduled') {
      const nextReminder = new Date(task.nextReminder);
      
      // Advance Warnings for advanced tasks
      if (task.taskType === 'advanced' && task.advanceWarningDays > 0) {
        const warningStart = new Date(nextReminder.getTime() - (task.advanceWarningDays * 86400000));
        if (now >= warningStart && now < nextReminder) {
          const lastWarning = task.lastWarningSentAt ? new Date(task.lastWarningSentAt) : new Date(0);
          if (now.getTime() - lastWarning.getTime() >= 86400000) { 
            task.lastWarningSentAt = now.toISOString();
            stateChanged = true;
            
            const daysLeft = Math.ceil((nextReminder.getTime() - now.getTime()) / 86400000);
            const message = `⏳ *Advance Warning*\n\nYour task *${task.name}* is due in ${daysLeft} day(s)!`;
            
            try {
              let chatId = task.chatId;
              if (!chatId) {
                 chatId = await getValidChatId(task.phone);
                 task.chatId = chatId;
              }
              await sock.sendMessage(chatId, { text: message });
              addLog('success', `Sent advance warning for "${task.name}"`);
            } catch (err) {}
          }
        }
      }

      if (now >= nextReminder) {
        task.status = 'pending_reply';
        task.overdueSince = now.toISOString();
        task.lastReminderSentAt = now.toISOString();
        stateChanged = true;

        const message = `🔔 *Task Reminder*\n\n*${task.name}*\n\nPlease reply with "done" when you finish this task to see your options.`;
        
        try {
          let chatId = task.chatId;
          if (!chatId) {
             chatId = await getValidChatId(task.phone);
             task.chatId = chatId;
          }
          await sock.sendMessage(chatId, { text: message });
          addLog('success', `Sent reminder "${task.name}" → ${task.phone}`);
        } catch (err) {
          addLog('error', `Failed "${task.name}": ${err.message}`);
        }
      }
    } 
    else if (task.status === 'pending_reply') {
      const lastSent = new Date(task.lastReminderSentAt);
      const timeSinceLast = now.getTime() - lastSent.getTime();
      
      let isTimeForOverdue = false;
      if (task.taskType === 'advanced') {
        const nagMs = task.nagIntervalValue * (task.nagIntervalType === 'days' ? 86400000 : 3600000);
        isTimeForOverdue = timeSinceLast >= nagMs;
      } else {
        if (task.intervalType === 'minutes') {
          isTimeForOverdue = timeSinceLast >= 60000;
        } else {
          isTimeForOverdue = timeSinceLast >= 86400000;
        }
      }

      if (isTimeForOverdue) {
        task.lastReminderSentAt = now.toISOString();
        stateChanged = true;

        const overdueText = calculateOverdueText(task.overdueSince, task.intervalType);
        const message = `⚠️ *Overdue Task Reminder*\n\n*${task.name}* is overdue by ${overdueText}!\n\nPlease reply with "done" when you finish it to see your options.`;

        try {
          let chatId = task.chatId;
          if (!chatId) {
             chatId = await getValidChatId(task.phone);
             task.chatId = chatId;
          }
          await sock.sendMessage(chatId, { text: message });
          addLog('warning', `Sent overdue reminder "${task.name}" → ${task.phone}`);
        } catch (err) {
          addLog('error', `Failed overdue "${task.name}": ${err.message}`);
        }
      }
    }
  }

  if (stateChanged) saveConfig(config);

}, 60000);

// ─── REST API ───────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({ status: clientStatus });
});

app.get('/api/tasks', (req, res) => {
  res.json({ tasks: config.tasks });
});

app.post('/api/tasks', async (req, res) => {
  const { 
    name, phone, intervalValue, intervalType, time, startDate,
    taskType, advanceWarningDays, nagIntervalValue, nagIntervalType
  } = req.body;

  if (!name || !phone || !intervalValue) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  let resolvedChatId;
  if (clientStatus === 'ready') {
    try {
      resolvedChatId = await getValidChatId(phone);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  const task = {
    id: Date.now().toString(),
    taskType: taskType || 'reminder',
    name: name.trim(),
    phone: phone.trim(),
    chatId: resolvedChatId || null,
    intervalValue: parseInt(intervalValue, 10),
    intervalType: intervalType || 'days',
    time: time || '09:00',
    startDate: startDate || null,
    status: 'scheduled',
    advanceWarningDays: advanceWarningDays || 0,
    nagIntervalValue: nagIntervalValue || 1,
    nagIntervalType: nagIntervalType || 'days',
    createdAt: new Date().toISOString(),
  };

  task.nextReminder = calculateInitialReminder(task);

  config.tasks.push(task);
  saveConfig(config);

  addLog('success', `Task "${task.name}" added.`);
  res.status(201).json({ task });
});

app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const task = config.tasks.find((t) => t.id === id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  config.tasks = config.tasks.filter((t) => t.id !== id);
  saveConfig(config);
  addLog('info', `Removed "${task.name}".`);
  res.json({ success: true });
});

app.post('/api/test-message', async (req, res) => {
  const { phone, message } = req.body;
  if (clientStatus !== 'ready' || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected. Scan QR in terminal first.' });
  }
  if (!phone) return res.status(400).json({ error: 'Phone number required.' });

  try {
    const chatId = await getValidChatId(phone);
    await sock.sendMessage(chatId, { text: message || 'Test message from WhatsApp Reminder.' });
    addLog('success', `Test sent → ${phone}`);
    res.json({ success: true });
  } catch (err) {
    addLog('error', `Test failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: messageLogs });
});

// ─── Serve Frontend (Production) ──────────────────────────────────────────────

const clientDistPath = path.join(__dirname, '../client/dist');
app.use(express.static(clientDistPath));

app.get('*', (req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// ─── Socket.IO ──────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.emit('status', clientStatus);
  if (clientStatus === 'qr' && currentQR) {
    socket.emit('qr', currentQR);
  }
  socket.emit('tasks_updated', config.tasks);
  socket.on('disconnect', () => {});
});

// ─── Start ──────────────────────────────────────────────────────────────────

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  if (config.tasks.length > 0) {
    console.log(`Loaded ${config.tasks.length} saved task(s).`);
  }
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  process.exit(0);
});
