import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import cron from 'node-cron';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── Constants ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, 'config.json');

// ─── Config Persistence ─────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.log('⚠️  Could not load config, starting fresh.');
  }
  return { tasks: [] };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// ─── Formatting Helpers ─────────────────────────────────────────────────────

function formatPhoneForWhatsApp(phone) {
  // Remove all non-digit characters and ensure no leading '+'
  const cleaned = phone.replace(/\D/g, '');
  return `${cleaned}@c.us`;
}

function buildReminderMessage(task) {
  const lines = [
    '🔔 *Task Reminder*',
    '━━━━━━━━━━━━━━━━━━',
    `📋 *Task:* ${task.name}`,
    `📅 *Reminder every:* ${task.intervalDays} day(s)`,
    `⏰ *Scheduled time:* ${task.time}`,
    '━━━━━━━━━━━━━━━━━━',
    "Don't forget to complete this task! 💪",
  ];
  return lines.join('\n');
}

function buildCronExpression(intervalDays, time) {
  // time is in "HH:MM" 24-hour format
  const [hour, minute] = time.split(':').map(Number);

  if (intervalDays === 1) {
    // Every day at the specified time
    return `${minute} ${hour} * * *`;
  } else {
    // Every N days — use "*/N" in the day-of-month field
    return `${minute} ${hour} */${intervalDays} * *`;
  }
}

// ─── WhatsApp Client ────────────────────────────────────────────────────────

let client;
let isClientReady = false;
const activeJobs = new Map(); // taskId -> cron job

function initializeClient() {
  return new Promise((resolve, reject) => {
    client = new Client({
      authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    client.on('qr', (qr) => {
      console.log('\n📱 Scan this QR code with your WhatsApp app:\n');
      qrcode.generate(qr, { small: true });
      console.log('(Open WhatsApp → Linked Devices → Link a Device)\n');
    });

    client.on('ready', () => {
      console.log('✅ WhatsApp client is ready!\n');
      isClientReady = true;
      resolve();
    });

    client.on('authenticated', () => {
      console.log('🔐 Authenticated successfully.');
    });

    client.on('auth_failure', (msg) => {
      console.error('❌ Authentication failed:', msg);
      reject(new Error('Authentication failed'));
    });

    client.on('disconnected', (reason) => {
      console.log('🔌 Client disconnected:', reason);
      isClientReady = false;
    });

    console.log('⏳ Initializing WhatsApp client...');
    client.initialize();
  });
}

// ─── Task Scheduling ────────────────────────────────────────────────────────

function scheduleTask(task) {
  const cronExpr = buildCronExpression(task.intervalDays, task.time);

  if (!cron.validate(cronExpr)) {
    console.log(`❌ Invalid cron expression for task "${task.name}": ${cronExpr}`);
    return;
  }

  const job = cron.schedule(cronExpr, async () => {
    if (!isClientReady) {
      console.log(`⚠️  Client not ready, skipping reminder for "${task.name}"`);
      return;
    }

    const chatId = formatPhoneForWhatsApp(task.phone);
    const message = buildReminderMessage(task);

    try {
      await client.sendMessage(chatId, message);
      console.log(`✅ [${new Date().toLocaleString()}] Reminder sent for "${task.name}" to ${task.phone}`);
    } catch (err) {
      console.error(`❌ Failed to send reminder for "${task.name}":`, err.message);
    }
  });

  activeJobs.set(task.id, job);
  console.log(`⏰ Scheduled "${task.name}" → every ${task.intervalDays} day(s) at ${task.time} → ${task.phone}`);
}

function unscheduleTask(taskId) {
  const job = activeJobs.get(taskId);
  if (job) {
    job.stop();
    activeJobs.delete(taskId);
  }
}

function scheduleAllTasks(config) {
  for (const task of config.tasks) {
    scheduleTask(task);
  }
}

// ─── Interactive CLI ────────────────────────────────────────────────────────

async function promptMainMenu() {
  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { name: '➕  Add a new task reminder', value: 'add' },
        { name: '📋  View all tasks', value: 'view' },
        { name: '🗑️   Remove a task', value: 'remove' },
        { name: '📩  Send a test message', value: 'test' },
        { name: '🚀  Start scheduler & run in background', value: 'start' },
        { name: '❌  Exit', value: 'exit' },
      ],
    },
  ]);
  return action;
}

async function promptAddTask() {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: '📋 Task name:',
      validate: (input) => (input.trim() ? true : 'Task name cannot be empty.'),
    },
    {
      type: 'input',
      name: 'phone',
      message: '📱 Phone number (with country code, e.g. +911234567890):',
      validate: (input) => {
        const cleaned = input.replace(/\D/g, '');
        return cleaned.length >= 10 ? true : 'Please enter a valid phone number with country code.';
      },
    },
    {
      type: 'number',
      name: 'intervalDays',
      message: '📅 Remind every how many days?',
      default: 1,
      validate: (input) => (input >= 1 ? true : 'Interval must be at least 1 day.'),
    },
    {
      type: 'input',
      name: 'time',
      message: '⏰ At what time? (24-hour format, e.g. 09:00):',
      default: '09:00',
      validate: (input) => {
        const match = /^([01]\d|2[0-3]):([0-5]\d)$/.test(input);
        return match ? true : 'Please enter time in HH:MM format (00:00 - 23:59).';
      },
    },
  ]);

  return {
    id: Date.now().toString(),
    name: answers.name.trim(),
    phone: answers.phone.trim(),
    intervalDays: answers.intervalDays,
    time: answers.time.trim(),
    createdAt: new Date().toISOString(),
  };
}

function displayTasks(config) {
  if (config.tasks.length === 0) {
    console.log('\n📭 No tasks configured yet.\n');
    return;
  }

  console.log('\n┌──────────────────────────────────────────────────────┐');
  console.log('│                  📋 YOUR TASK REMINDERS              │');
  console.log('├──────────────────────────────────────────────────────┤');

  config.tasks.forEach((task, index) => {
    console.log(`│ ${index + 1}. ${task.name}`);
    console.log(`│    📱 ${task.phone}  |  📅 Every ${task.intervalDays} day(s)  |  ⏰ ${task.time}`);
    if (index < config.tasks.length - 1) {
      console.log('│──────────────────────────────────────────────────────');
    }
  });

  console.log('└──────────────────────────────────────────────────────┘\n');
}

async function promptRemoveTask(config) {
  if (config.tasks.length === 0) {
    console.log('\n📭 No tasks to remove.\n');
    return config;
  }

  const choices = config.tasks.map((task, index) => ({
    name: `${index + 1}. ${task.name} → ${task.phone} (every ${task.intervalDays}d at ${task.time})`,
    value: task.id,
  }));

  const { taskId } = await inquirer.prompt([
    {
      type: 'list',
      name: 'taskId',
      message: '🗑️  Select a task to remove:',
      choices,
    },
  ]);

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Are you sure you want to remove this task?',
      default: false,
    },
  ]);

  if (confirm) {
    unscheduleTask(taskId);
    config.tasks = config.tasks.filter((t) => t.id !== taskId);
    saveConfig(config);
    console.log('✅ Task removed.\n');
  } else {
    console.log('❎ Cancelled.\n');
  }

  return config;
}

async function promptTestMessage() {
  const { phone, message } = await inquirer.prompt([
    {
      type: 'input',
      name: 'phone',
      message: '📱 Phone number to send test message to (with country code):',
      validate: (input) => {
        const cleaned = input.replace(/\D/g, '');
        return cleaned.length >= 10 ? true : 'Please enter a valid phone number.';
      },
    },
    {
      type: 'input',
      name: 'message',
      message: '💬 Test message:',
      default: '👋 Hello! This is a test message from your WhatsApp Task Reminder.',
    },
  ]);

  const chatId = formatPhoneForWhatsApp(phone);
  try {
    await client.sendMessage(chatId, message);
    console.log('✅ Test message sent successfully!\n');
  } catch (err) {
    console.error('❌ Failed to send test message:', err.message, '\n');
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       📱 WhatsApp Task Reminder                     ║');
  console.log('║       Send recurring reminders via WhatsApp          ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  // Load saved tasks
  let config = loadConfig();
  if (config.tasks.length > 0) {
    console.log(`📂 Loaded ${config.tasks.length} saved task(s) from config.\n`);
  }

  // Initialize WhatsApp client
  await initializeClient();

  // Main menu loop
  let running = true;
  while (running) {
    const action = await promptMainMenu();

    switch (action) {
      case 'add': {
        const task = await promptAddTask();
        config.tasks.push(task);
        saveConfig(config);
        console.log(`\n✅ Task "${task.name}" added!\n`);
        break;
      }

      case 'view':
        displayTasks(config);
        break;

      case 'remove':
        config = await promptRemoveTask(config);
        break;

      case 'test':
        await promptTestMessage();
        break;

      case 'start':
        if (config.tasks.length === 0) {
          console.log('\n⚠️  No tasks to schedule. Add some tasks first!\n');
        } else {
          console.log('\n🚀 Starting scheduler for all tasks...\n');
          scheduleAllTasks(config);
          console.log('\n✅ All tasks scheduled. The program will keep running.');
          console.log('   Press Ctrl+C to stop.\n');
          running = false; // Exit the menu loop, keep process alive
        }
        break;

      case 'exit':
        console.log('\n👋 Goodbye!\n');
        await client.destroy();
        process.exit(0);
    }
  }

  // Keep the process alive for scheduled jobs
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down...');
    for (const [, job] of activeJobs) {
      job.stop();
    }
    await client.destroy();
    console.log('👋 Goodbye!\n');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
