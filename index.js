require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');

// --- Настройки ---
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // тот же ключ, что и в WPF
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL; // строка подключения к Supabase (PostgreSQL)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // ID пользователя/группы для уведомлений

const app = express();
app.use(bodyParser.json());

// --- Подключение к Supabase ---
const pool = new Pool({
  connectionString: SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }
});

// --- Telegram Bot ---
let bot;
if (TELEGRAM_TOKEN) {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log('Telegram bot started');
}

// --- Middleware: проверка API ключа ---
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
    // Таблица orders
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT PRIMARY KEY,
        ordernumber VARCHAR(50) NOT NULL,
        clientname VARCHAR(200) NOT NULL,
        containercount INT,
        goodstype VARCHAR(100),
        route VARCHAR(200),
        transitport VARCHAR(100),
        documentnumber VARCHAR(100),
        chinesetransportcompany VARCHAR(200),
        iraniantransportcompany VARCHAR(200),
        status VARCHAR(50),
        statuscolor VARCHAR(20),
        creationdate TIMESTAMP,
        loadingdate TIMESTAMP,
        departuredate TIMESTAMP,
        arrivalirandate TIMESTAMP,
        truckloadingdate TIMESTAMP,
        arrivalturkmenistandate TIMESTAMP,
        clientreceivingdate TIMESTAMP,
        arrivalnoticedate TIMESTAMP,
        tkmdate TIMESTAMP,
        etadate TIMESTAMP,
        hasloadingphoto BOOLEAN,
        haslocalcharges BOOLEAN,
        hastex BOOLEAN,
        notes TEXT,
        additionalinfo TEXT,
        lastmodified TIMESTAMP NOT NULL,
        isdeleted BOOLEAN DEFAULT FALSE
      )
    `);
    
    // Таблица containers
    await client.query(`
      CREATE TABLE IF NOT EXISTS containers (
        id INT PRIMARY KEY,
        orderid INT NOT NULL,
        containernumber VARCHAR(50),
        containertype VARCHAR(50),
        weight DECIMAL,
        volume DECIMAL,
        loadingdate TIMESTAMP,
        departuredate TIMESTAMP,
        arrivalirandate TIMESTAMP,
        truckloadingdate TIMESTAMP,
        arrivalturkmenistandate TIMESTAMP,
        clientreceivingdate TIMESTAMP,
        driverfirstname VARCHAR(100),
        driverlastname VARCHAR(100),
        drivercompany VARCHAR(200),
        trucknumber VARCHAR(50),
        driveriranphone VARCHAR(50),
        driverturkmenistanphone VARCHAR(50),
        lastmodified TIMESTAMP NOT NULL,
        isdeleted BOOLEAN DEFAULT FALSE
      )
    `);
    
    // Таблица tasks
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        taskid INT PRIMARY KEY,
        orderid INT NOT NULL,
        description VARCHAR(500) NOT NULL,
        assignedto VARCHAR(100),
        status INT,
        priority INT,
        duedate TIMESTAMP,
        createddate TIMESTAMP,
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

// --- API эндпоинты для синхронизации ---

// Обновление заказа
app.post('/api/sync/order', requireApiKey, async (req, res) => {
  const order = req.body;
  const client = await pool.connect();
  try {
    // UPSERT: вставляем или обновляем
    const query = `
      INSERT INTO orders (
        id, ordernumber, clientname, containercount, goodstype, route, transitport,
        documentnumber, chinesetransportcompany, iraniantransportcompany,
        status, statuscolor, creationdate, loadingdate, departuredate,
        arrivalirandate, truckloadingdate, arrivalturkmenistandate,
        clientreceivingdate, arrivalnoticedate, tkmdate, etadate,
        hasloadingphoto, haslocalcharges, hastex, notes, additionalinfo,
        lastmodified, isdeleted
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
      ON CONFLICT (id) DO UPDATE SET
        ordernumber = EXCLUDED.ordernumber,
        clientname = EXCLUDED.clientname,
        containercount = EXCLUDED.containercount,
        goodstype = EXCLUDED.goodstype,
        route = EXCLUDED.route,
        transitport = EXCLUDED.transitport,
        documentnumber = EXCLUDED.documentnumber,
        chinesetransportcompany = EXCLUDED.chinesetransportcompany,
        iraniantransportcompany = EXCLUDED.iraniantransportcompany,
        status = EXCLUDED.status,
        statuscolor = EXCLUDED.statuscolor,
        creationdate = EXCLUDED.creationdate,
        loadingdate = EXCLUDED.loadingdate,
        departuredate = EXCLUDED.departuredate,
        arrivalirandate = EXCLUDED.arrivalirandate,
        truckloadingdate = EXCLUDED.truckloadingdate,
        arrivalturkmenistandate = EXCLUDED.arrivalturkmenistandate,
        clientreceivingdate = EXCLUDED.clientreceivingdate,
        arrivalnoticedate = EXCLUDED.arrivalnoticedate,
        tkmdate = EXCLUDED.tkmdate,
        etadate = EXCLUDED.etadate,
        hasloadingphoto = EXCLUDED.hasloadingphoto,
        haslocalcharges = EXCLUDED.haslocalcharges,
        hastex = EXCLUDED.hastex,
        notes = EXCLUDED.notes,
        additionalinfo = EXCLUDED.additionalinfo,
        lastmodified = EXCLUDED.lastmodified,
        isdeleted = EXCLUDED.isdeleted
    `;
    const values = [
      order.id, order.orderNumber, order.clientName, order.containerCount,
      order.goodsType, order.route, order.transitPort, order.documentNumber,
      order.chineseTransportCompany, order.iranianTransportCompany,
      order.status, order.statusColor, order.creationDate,
      order.loadingDate, order.departureDate, order.arrivalIranDate,
      order.truckLoadingDate, order.arrivalTurkmenistanDate,
      order.clientReceivingDate, order.arrivalNoticeDate, order.tkmDate, order.etaDate,
      order.hasLoadingPhoto, order.hasLocalCharges, order.hasTex,
      order.notes, order.additionalInfo,
      order.lastModified, order.isDeleted || false
    ];
    await client.query(query, values);
    
    // Отправляем уведомление в Telegram
    if (bot && TELEGRAM_CHAT_ID) {
      let msg = `🔄 *Order Updated*\n`;
      msg += `*Number:* ${order.orderNumber}\n`;
      msg += `*Client:* ${order.clientName}\n`;
      msg += `*Status:* ${order.status}\n`;
      msg += `*Modified:* ${new Date(order.lastModified).toLocaleString()}`;
      bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
    }
    
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Обновление задачи – аналогично
app.post('/api/sync/task', requireApiKey, async (req, res) => {
  // ... аналогично, создайте таблицу tasks и upsert
});

// Эндпоинт для получения отчётов (используется ботом)
app.get('/api/report', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT * FROM orders 
      WHERE isdeleted = false 
      ORDER BY lastmodified DESC LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- Telegram Bot команды ---
if (bot) {
  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
      '👋 *LogisticsManager Bot*\n\n'
      + 'Доступные команды:\n'
      + '/status - общая статистика\n'
      + '/recent - последние 5 изменений\n'
      + '/order [номер] - информация о заказе\n'
      + '/orders - список активных заказов\n'
      + '/tasks - просроченные задачи',
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const client = await pool.connect();
    try {
      const totalOrders = await client.query('SELECT COUNT(*) FROM orders WHERE isdeleted = false');
      const activeOrders = await client.query("SELECT COUNT(*) FROM orders WHERE status NOT IN ('Completed','Cancelled') AND isdeleted = false");
      const totalContainers = await client.query('SELECT SUM(containercount) FROM orders WHERE isdeleted = false');
      const response = 
        `📊 *Общая статистика*\n\n`
        + `Всего заказов: ${totalOrders.rows[0].count}\n`
        + `Активных заказов: ${activeOrders.rows[0].count}\n`
        + `Контейнеров: ${totalContainers.rows[0].sum || 0}`;
      bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, 'Ошибка при получении статистики');
    } finally {
      client.release();
    }
  });

  // ... добавьте другие команды по необходимости
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});