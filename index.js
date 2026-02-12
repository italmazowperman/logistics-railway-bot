require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// --- Подключение к Supabase (с принудительным IPv4 через пулер) ---
const pool = new Pool({
  connectionString: SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

// --- Telegram Bot ---
let bot;
if (TELEGRAM_TOKEN) {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log('Telegram bot started');
}

// --- Проверка API ключа ---
const requireApiKey = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key && key === API_KEY) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// --- Создание таблиц в Supabase (если их нет) ---
async function initDatabase() {
  const client = await pool.connect();
  try {
    // Таблица для заказов (JSONB)
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders_sync (
        id INT PRIMARY KEY,
        data JSONB NOT NULL,
        lastmodified TIMESTAMP NOT NULL,
        isdeleted BOOLEAN DEFAULT FALSE
      )
    `);
    // Таблица для задач
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks_sync (
        taskid INT PRIMARY KEY,
        data JSONB NOT NULL,
        lastmodified TIMESTAMP NOT NULL,
        isdeleted BOOLEAN DEFAULT FALSE
      )
    `);
    console.log('Tables ensured in Supabase');
  } catch (err) {
    console.error('Error creating tables:', err);
  } finally {
    client.release();
  }
}
initDatabase();

// --- Эндпоинт: приём заказа ---
app.post('/api/sync/order', requireApiKey, async (req, res) => {
  const order = req.body;
  const client = await pool.connect();
  try {
    const query = `
      INSERT INTO orders_sync (id, data, lastmodified, isdeleted)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET
        data = EXCLUDED.data,
        lastmodified = EXCLUDED.lastmodified,
        isdeleted = EXCLUDED.isdeleted
    `;
    await client.query(query, [
      order.id,
      JSON.stringify(order),
      order.lastModified || new Date(),
      order.isDeleted || false
    ]);

    // Уведомление в Telegram
    if (bot && TELEGRAM_CHAT_ID) {
      let msg = `🔄 *Заказ обновлён*\n`;
      msg += `*№:* ${order.orderNumber}\n`;
      msg += `*Клиент:* ${order.clientName}\n`;
      msg += `*Статус:* ${order.status}\n`;
      msg += `*Контейнеров:* ${order.containerCount}\n`;
      msg += `*TKM:* ${order.tkmDate ? new Date(order.tkmDate).toLocaleDateString('ru-RU') : '—'}`;
      bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- Эндпоинт: приём задачи ---
app.post('/api/sync/task', requireApiKey, async (req, res) => {
  const task = req.body;
  const client = await pool.connect();
  try {
    const query = `
      INSERT INTO tasks_sync (taskid, data, lastmodified, isdeleted)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (taskid) DO UPDATE SET
        data = EXCLUDED.data,
        lastmodified = EXCLUDED.lastmodified,
        isdeleted = EXCLUDED.isdeleted
    `;
    await client.query(query, [
      task.taskId,
      JSON.stringify(task),
      task.lastModified || new Date(),
      task.isDeleted || false
    ]);

    if (bot && TELEGRAM_CHAT_ID) {
      let msg = `📋 *Задача обновлена*\n`;
      msg += `*Описание:* ${task.description}\n`;
      msg += `*Исполнитель:* ${task.assignedTo || '—'}\n`;
      msg += `*Статус:* ${['ToDo','InProgress','Completed'][task.status]}\n`;
      msg += `*Срок:* ${task.dueDate ? new Date(task.dueDate).toLocaleDateString('ru-RU') : '—'}`;
      bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- Telegram команды ---
if (bot) {
  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
      '👋 *LogisticsManager Bot*\n\n'
      + 'Доступные команды:\n'
      + '/status — общая статистика\n'
      + '/recent — последние 5 заказов\n'
      + '/order [номер] — информация о заказе\n'
      + '/help — помощь',
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const client = await pool.connect();
    try {
      const total = await client.query('SELECT COUNT(*) FROM orders_sync WHERE isdeleted = false');
      const orders = await client.query(`
        SELECT data FROM orders_sync 
        WHERE isdeleted = false 
        ORDER BY lastmodified DESC 
        LIMIT 100
      `);
      
      let active = 0, containers = 0;
      orders.rows.forEach(row => {
        const o = row.data;
        if (o.status !== 'Completed' && o.status !== 'Cancelled') active++;
        containers += o.containerCount || 0;
      });

      const resp = 
        `📊 *Общая статистика*\n\n`
        + `Всего заказов: ${total.rows[0].count}\n`
        + `Активных: ${active}\n`
        + `Контейнеров: ${containers}`;
      bot.sendMessage(chatId, resp, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, 'Ошибка при получении статистики');
    } finally {
      client.release();
    }
  });

  bot.onText(/\/recent/, async (msg) => {
    const chatId = msg.chat.id;
    const client = await pool.connect();
    try {
      const res = await client.query(`
        SELECT data FROM orders_sync 
        WHERE isdeleted = false 
        ORDER BY lastmodified DESC 
        LIMIT 5
      `);
      if (res.rows.length === 0) {
        bot.sendMessage(chatId, 'Нет заказов');
        return;
      }
      let text = '🕒 *Последние 5 заказов:*\n\n';
      res.rows.forEach((row, i) => {
        const o = row.data;
        text += `${i+1}. *${o.orderNumber}* — ${o.clientName}\n`;
        text += `   Статус: ${o.status}\n`;
        text += `   Изменён: ${new Date(o.lastModified).toLocaleString('ru-RU')}\n\n`;
      });
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, 'Ошибка');
    } finally {
      client.release();
    }
  });

  bot.onText(/\/order (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderNumber = match[1].trim();
    const client = await pool.connect();
    try {
      const res = await client.query(`
        SELECT data FROM orders_sync 
        WHERE data->>'orderNumber' = $1 AND isdeleted = false
        ORDER BY lastmodified DESC LIMIT 1
      `, [orderNumber]);
      if (res.rows.length === 0) {
        bot.sendMessage(chatId, `Заказ ${orderNumber} не найден`);
        return;
      }
      const o = res.rows[0].data;
      let msgText = `📦 *Заказ ${o.orderNumber}*\n\n`;
      msgText += `*Клиент:* ${o.clientName}\n`;
      msgText += `*Груз:* ${o.goodsType || '—'}\n`;
      msgText += `*Маршрут:* ${o.route || '—'}\n`;
      msgText += `*Контейнеров:* ${o.containerCount || 0}\n`;
      msgText += `*Вес:* ${o.totalWeight || 0} кг\n`;
      msgText += `*Статус:* ${o.status}\n`;
      msgText += `*TKM:* ${o.tkmDate ? new Date(o.tkmDate).toLocaleDateString('ru-RU') : '—'}\n`;
      msgText += `*Последнее изменение:* ${new Date(o.lastModified).toLocaleString('ru-RU')}`;
      bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, 'Ошибка');
    } finally {
      client.release();
    }
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
