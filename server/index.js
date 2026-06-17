import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

// ─── WhatsApp Client ────────────────────────────────────────────────────────

let clientStatus = 'disconnected';

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ],
  },
});

client.on('qr', (qr) => {
  clientStatus = 'qr';
  io.emit('status', clientStatus);
  console.log('\n─────────────────────────────────────────');
  console.log('  Scan this QR code with WhatsApp:');
  console.log('  (Linked Devices → Link a Device)');
  console.log('─────────────────────────────────────────\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp connected.\n');
  clientStatus = 'ready';
  io.emit('status', clientStatus);
  addLog('success', 'WhatsApp connected.');
});

client.on('authenticated', () => {
  console.log('Session authenticated.');
  addLog('info', 'Session authenticated.');
});

client.on('auth_failure', (msg) => {
  clientStatus = 'disconnected';
  io.emit('status', clientStatus);
  addLog('error', `Auth failed: ${msg}`);
});

client.on('disconnected', (reason) => {
  clientStatus = 'disconnected';
  io.emit('status', clientStatus);
  addLog('error', `Disconnected: ${reason}`);
});

// ─── Incoming Message Handling ──────────────────────────────────────────────

client.on('message', async (msg) => {
  const text = msg.body.trim().toLowerCase();
  const match = text.match(/^done\s+(\d+)$/);
  
  if (match) {
    const val = parseInt(match[1], 10);
    const msgPhone = msg.from.replace(/\D/g, ''); // Extract digits from sender ID
    
    let found = false;
    let units = 'days';

    for (let task of config.tasks) {
      if (task.status === 'pending_reply' && task.intervalValue === val) {
        const taskPhone = task.phone.replace(/\D/g, '');
        // Match the phone numbers (WhatsApp IDs can sometimes differ slightly with country codes)
        if (msgPhone === taskPhone || msgPhone.endsWith(taskPhone) || taskPhone.endsWith(msgPhone)) {
          task.status = 'scheduled';
          task.nextReminder = calculateNextReminder(task);
          delete task.overdueSince;
          delete task.lastReminderSentAt;
          found = true;
          units = task.intervalType;
        }
      }
    }
    
    if (found) {
      saveConfig(config);
      addLog('success', `Task for interval ${val} completed by user.`);
      await client.sendMessage(msg.from, `✅ Task completed! Next reminder scheduled for ${val} ${units} from now.`);
    } else {
      await client.sendMessage(msg.from, `❌ No pending task found with an interval of ${val}.`);
    }
  }
});

console.log('Starting WhatsApp client...');
client.initialize();

// ─── Dynamic Scheduling Logic ───────────────────────────────────────────────

async function getValidChatId(phone) {
  const cleaned = phone.replace(/\D/g, '');
  const numberId = await client.getNumberId(cleaned);
  if (!numberId) {
    throw new Error(`${phone} is not registered on WhatsApp.`);
  }
  return numberId._serialized;
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
       // Keep adding the interval until the date is in the future
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
  if (clientStatus !== 'ready') return;
  const now = new Date();

  let stateChanged = false;

  for (let task of config.tasks) {
    // 1. Initial Reminder
    if (task.status === 'scheduled') {
      const nextReminder = new Date(task.nextReminder);
      if (now >= nextReminder) {
        task.status = 'pending_reply';
        task.overdueSince = now.toISOString();
        task.lastReminderSentAt = now.toISOString();
        stateChanged = true;

        const message = `🔔 *Task Reminder*\n\n*${task.name}*\n\nPlease reply with "done ${task.intervalValue}" when you finish this task.`;
        
        try {
          const chatId = await getValidChatId(task.phone);
          await client.sendMessage(chatId, message);
          addLog('success', `Sent reminder "${task.name}" → ${task.phone}`);
        } catch (err) {
          addLog('error', `Failed "${task.name}": ${err.message}`);
        }
      }
    } 
    // 2. Overdue Reminders
    else if (task.status === 'pending_reply') {
      const lastSent = new Date(task.lastReminderSentAt);
      const timeSinceLast = now.getTime() - lastSent.getTime();
      
      let isTimeForOverdue = false;
      if (task.intervalType === 'minutes') {
        isTimeForOverdue = timeSinceLast >= 60000; // 1 minute
      } else {
        isTimeForOverdue = timeSinceLast >= 86400000; // 1 day
      }

      if (isTimeForOverdue) {
        task.lastReminderSentAt = now.toISOString();
        stateChanged = true;

        const overdueText = calculateOverdueText(task.overdueSince, task.intervalType);
        const message = `⚠️ *Overdue Task Reminder*\n\n*${task.name}* is overdue by ${overdueText}!\n\nPlease reply with "done ${task.intervalValue}" when you finish it.`;

        try {
          const chatId = await getValidChatId(task.phone);
          await client.sendMessage(chatId, message);
          addLog('warning', `Sent overdue reminder "${task.name}" → ${task.phone}`);
        } catch (err) {
          addLog('error', `Failed overdue "${task.name}": ${err.message}`);
        }
      }
    }
  }

  if (stateChanged) saveConfig(config);

}, 60000); // Check every minute

// ─── REST API ───────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({ status: clientStatus });
});

app.get('/api/tasks', (req, res) => {
  res.json({ tasks: config.tasks });
});

app.post('/api/tasks', (req, res) => {
  const { name, phone, intervalValue, intervalType, time, startDate } = req.body;

  if (!name || !phone || !intervalValue) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const task = {
    id: Date.now().toString(),
    name: name.trim(),
    phone: phone.trim(),
    intervalValue: parseInt(intervalValue, 10),
    intervalType: intervalType || 'days',
    time: time || '09:00',
    startDate: startDate || null,
    status: 'scheduled',
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
  socket.emit('tasks_updated', config.tasks);
  socket.on('disconnect', () => {});
});

// ─── Start ──────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (config.tasks.length > 0) {
    console.log(`Loaded ${config.tasks.length} saved task(s).`);
  }
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await client.destroy();
  process.exit(0);
});
