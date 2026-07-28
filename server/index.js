import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';

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

// ─── WhatsApp Client (whatsapp-web.js) ──────────────────────────────────────

let clientStatus = 'disconnected';
let currentQR = '';

// CRITICAL: Aggressive low-memory flags to prevent 1GB EC2 crashes
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--js-flags="--max-old-space-size=256"'
    ],
  }
});

client.on('qr', (qr) => {
  clientStatus = 'qr';
  currentQR = qr;
  io.emit('status', clientStatus);
  io.emit('qr', currentQR);
  console.log('\n─────────────────────────────────────────');
  console.log('  Scan this QR code with WhatsApp:');
  console.log('  (Linked Devices → Link a Device)');
  console.log('─────────────────────────────────────────\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  clientStatus = 'ready';
  io.emit('status', clientStatus);
  addLog('success', 'WhatsApp connected.');
  console.log('WhatsApp connected.\n');
});

client.on('disconnected', (reason) => {
  clientStatus = 'disconnected';
  io.emit('status', clientStatus);
  addLog('error', `Disconnected from WhatsApp: ${reason}`);
  console.log('Client was logged out', reason);
  client.initialize(); // Auto-restart on disconnect
});

client.on('auth_failure', msg => {
  clientStatus = 'disconnected';
  io.emit('status', clientStatus);
  addLog('error', `Authentication failure: ${msg}`);
  console.error('AUTHENTICATION FAILURE', msg);
});

// Task selection state for replies
const awaitingSelection = {};

client.on('message', async (msg) => {
  if (msg.from === 'status@broadcast') return;

  const text = msg.body.trim().toLowerCase();
  const chatId = msg.from;

  if (text === 'done') {
    const pendingTasks = config.tasks.filter(t => t.chatId === chatId && t.status === 'pending_reply');
    
    if (pendingTasks.length === 1) {
      const task = pendingTasks[0];
      task.status = 'scheduled';
      task.nextReminder = calculateNextReminder(task);
      delete task.overdueSince;
      delete task.lastReminderSentAt;
      delete task.lastWarningSentAt;
      
      saveConfig(config);
      addLog('success', `Task "${task.name}" completed by user.`);
      await client.sendMessage(chatId, `✅ Task *"${task.name}"* completed! Next reminder scheduled for ${task.intervalValue} ${task.intervalType} from now.`);
      return;
    }

    if (pendingTasks.length === 0) {
      await client.sendMessage(chatId, `❌ There are no pending reminders to complete here.`);
      return;
    }

    awaitingSelection[chatId] = pendingTasks.map(t => t.id);
    let reply = `📋 *Pending Tasks*\n\nPlease reply with the number corresponding to the task you want to complete:\n\n`;
    pendingTasks.forEach((task, index) => {
      reply += `${index + 1}. ${task.name} (every ${task.intervalValue} ${task.intervalType})\n`;
    });
    await client.sendMessage(chatId, reply);
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
        await client.sendMessage(chatId, `✅ Task *"${task.name}"* completed! Next reminder scheduled for ${task.intervalValue} ${task.intervalType} from now.`);
      }
    } else {
      await client.sendMessage(chatId, `❌ Invalid number. Please reply with a number between 1 and ${taskIds.length}.`);
    }
  }
});

console.log('Starting WhatsApp client (whatsapp-web.js)...');
client.initialize();

// ─── Dynamic Scheduling Logic ───────────────────────────────────────────────

async function getValidChatId(phoneOrGroup) {
  if (phoneOrGroup.includes('chat.whatsapp.com/')) {
    try {
      const match = phoneOrGroup.match(/chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9]+)/);
      if (!match) throw new Error('Invalid WhatsApp group link format.');
      const inviteCode = match[1];
      
      const inviteInfo = await client.getInviteInfo(inviteCode);
      if (!inviteInfo || !inviteInfo.id) {
        throw new Error('Could not resolve group ID from link.');
      }
      return typeof inviteInfo.id === 'string' ? inviteInfo.id : inviteInfo.id._serialized;
    } catch (err) {
      throw new Error(`Invalid group link: ${err.message}`);
    }
  } else if (/[a-zA-Z]/.test(phoneOrGroup)) {
    throw new Error(`Group Name searching is disabled on low-memory servers. Please use the Group Invite Link instead.`);
  } else {
    const cleaned = phoneOrGroup.replace(/\D/g, '');
    const chatId = `${cleaned}@c.us`;
    const isRegistered = await client.isRegisteredUser(chatId);
    if (!isRegistered) {
      throw new Error(`${phoneOrGroup} is not registered on WhatsApp.`);
    }
    return chatId;
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
    let reminderDate = new Date(task.nextReminder);
    while (reminderDate <= now) {
      if (task.intervalType === 'days') reminderDate.setDate(reminderDate.getDate() + task.intervalValue);
      if (task.intervalType === 'weeks') reminderDate.setDate(reminderDate.getDate() + (task.intervalValue * 7));
      if (task.intervalType === 'months') reminderDate.setMonth(reminderDate.getMonth() + task.intervalValue);
    }
    return reminderDate.toISOString();
  }
}

function calculateOverdueText(overdueSince, originalIntervalType) {
  const diffMs = new Date() - new Date(overdueSince);
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (originalIntervalType === 'minutes') {
    return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''}`;
  }
  if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''}`;
  if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? 's' : ''}`;
  return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''}`;
}

// ─── Task Runner ────────────────────────────────────────────────────────────

setInterval(async () => {
  if (clientStatus !== 'ready') return;
  const now = new Date();
  let stateChanged = false;

  for (let task of config.tasks) {
    if (task.status === 'scheduled') {
      const nextTime = new Date(task.nextReminder);
      
      if (now >= nextTime) {
        task.status = 'pending_reply';
        task.overdueSince = now.toISOString();
        task.lastReminderSentAt = now.toISOString();
        task.lastWarningSentAt = null;
        stateChanged = true;

        const message = `🔔 *Reminder*\n\nTime to complete: *${task.name}*\n\nPlease reply with "done" when you finish it.`;
        try {
          let chatId = task.chatId;
          if (!chatId) {
             chatId = await getValidChatId(task.phone);
             task.chatId = chatId;
          }
          await client.sendMessage(chatId, message);
          addLog('info', `Sent reminder "${task.name}" → ${task.phone}`);
        } catch (err) {
          addLog('error', `Failed to send "${task.name}": ${err.message}`);
        }
      } 
      else if (task.advanceWarningDays > 0) {
        const warningTime = new Date(nextTime.getTime() - (task.advanceWarningDays * 24 * 60 * 60 * 1000));
        
        if (now >= warningTime && !task.lastWarningSentAt) {
          task.lastWarningSentAt = now.toISOString();
          stateChanged = true;
          const warningMessage = `⏳ *Upcoming Task*\n\nJust a heads up! *${task.name}* is due in ${task.advanceWarningDays} day(s) on ${nextTime.toLocaleDateString()}.`;
          try {
            let chatId = task.chatId;
            if (!chatId) {
               chatId = await getValidChatId(task.phone);
               task.chatId = chatId;
            }
            await client.sendMessage(chatId, warningMessage);
            addLog('info', `Sent advance warning "${task.name}"`);
          } catch (err) {
            addLog('error', `Failed warning "${task.name}": ${err.message}`);
          }
        }
      }
    } 
    
    else if (task.status === 'pending_reply') {
      const timeSinceLast = now.getTime() - new Date(task.lastReminderSentAt).getTime();
      let isTimeForOverdue = false;

      if (task.nagIntervalType === 'days') {
        isTimeForOverdue = timeSinceLast >= task.nagIntervalValue * 86400000;
      } else if (task.nagIntervalType === 'hours') {
        isTimeForOverdue = timeSinceLast >= task.nagIntervalValue * 3600000;
      } else if (task.nagIntervalType === 'minutes') {
        isTimeForOverdue = timeSinceLast >= task.nagIntervalValue * 60000;
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
          await client.sendMessage(chatId, message);
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
  if (clientStatus !== 'ready') {
    return res.status(503).json({ error: 'WhatsApp not connected. Scan QR in terminal first.' });
  }
  if (!phone) return res.status(400).json({ error: 'Phone number required.' });

  try {
    const chatId = await getValidChatId(phone);
    await client.sendMessage(chatId, message || 'Test message from WhatsApp Reminder.');
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
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (client) await client.destroy();
  process.exit(0);
});
