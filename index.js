require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { Telegraf } = require('telegraf');

const app = express();
app.use(express.json());

// ========== PostgreSQL (Supabase) ==========
const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL, // postgresql://postgres:Margsh2026x2@db.nkxnbvssbdtfniogcdfd.supabase.co:5432/postgres
  ssl: { rejectUnauthorized: false }
});

// ========== Telegram Bot ==========
const bot = new Telegraf(process.env.BOT_TOKEN); // Токен из BotFather

// Команды бота
bot.start((ctx) => ctx.reply('Добро пожаловать! Используйте /help для списка команд.'));
bot.help((ctx) => ctx.reply(
  'Доступные команды:\n' +
  '/orders - список активных заказов\n' +
  '/report - сводный отчёт\n' +
  '/order_123 - информация о заказе №123\n' +
  '/tasks_123 - задачи по заказу №123'
));

bot.command('orders', async (ctx) => {
  try {
    const res = await pool.query(
      `SELECT "OrderNumber", "ClientName", "Status", "EtaDate" 
       FROM public."Orders" 
       WHERE "Status" NOT IN ('Completed','Cancelled')
       ORDER BY "OrderNumber"`
    );
    if (res.rows.length === 0) return ctx.reply('Нет активных заказов.');
    let msg = '📦 **Активные заказы:**\n\n';
    res.rows.forEach(o => {
      msg += `• ${o.OrderNumber} — ${o.ClientName}\n  Статус: ${o.Status}, ETA: ${o.EtaDate ? new Date(o.EtaDate).toLocaleDateString('ru') : 'не указано'}\n`;
    });
    ctx.reply(msg);
  } catch (err) {
    console.error(err);
    ctx.reply('Ошибка получения заказов.');
  }
});

bot.command('report', async (ctx) => {
  try {
    const total = await pool.query(`SELECT COUNT(*) FROM public."Orders"`);
    const active = await pool.query(`SELECT COUNT(*) FROM public."Orders" WHERE "Status" NOT IN ('Completed','Cancelled')`);
    const containers = await pool.query(`SELECT SUM("ContainerCount") FROM public."Orders"`);
    const weight = await pool.query(`SELECT SUM(c."Weight") FROM public."Containers" c`);
    ctx.reply(
      `📊 **Сводный отчёт**\n\n` +
      `Всего заказов: ${total.rows[0].count}\n` +
      `Активных: ${active.rows[0].count}\n` +
      `Контейнеров: ${containers.rows[0].sum || 0}\n` +
      `Общий вес: ${weight.rows[0].sum || 0} кг`
    );
  } catch (err) {
    console.error(err);
    ctx.reply('Ошибка формирования отчёта.');
  }
});

// Динамические команды /order_123 и /tasks_123
bot.use(async (ctx, next) => {
  const text = ctx.message?.text;
  if (!text) return next();

  const orderMatch = text.match(/^\/order_(\d+)$/);
  if (orderMatch) {
    const id = orderMatch[1];
    try {
      const order = await pool.query(
        `SELECT * FROM public."Orders" WHERE "OrderNumber" = $1 OR "Id" = $1::int`,
        [id]
      );
      if (order.rows.length === 0) return ctx.reply('Заказ не найден.');
      const o = order.rows[0];
      let msg = `🔹 **Заказ ${o.OrderNumber}**\n`;
      msg += `Клиент: ${o.ClientName}\n`;
      msg += `Тип груза: ${o.GoodsType || '—'}\n`;
      msg += `Маршрут: ${o.Route || '—'}\n`;
      msg += `Контейнеров: ${o.ContainerCount}\n`;
      msg += `Статус: ${o.Status}\n`;
      msg += `ETA: ${o.EtaDate ? new Date(o.EtaDate).toLocaleDateString('ru') : '—'}\n`;
      msg += `TKM дата: ${o.TkmDate ? new Date(o.TkmDate).toLocaleDateString('ru') : '—'}`;
      ctx.reply(msg);
    } catch (err) {
      ctx.reply('Ошибка получения заказа.');
    }
    return;
  }

  const tasksMatch = text.match(/^\/tasks_(\d+)$/);
  if (tasksMatch) {
    const id = tasksMatch[1];
    try {
      const tasks = await pool.query(
        `SELECT t.*, o."OrderNumber" 
         FROM public."Tasks" t 
         JOIN public."Orders" o ON t."OrderId" = o."Id" 
         WHERE o."OrderNumber" = $1 OR o."Id" = $1::int`,
        [id]
      );
      if (tasks.rows.length === 0) return ctx.reply('Нет задач для этого заказа.');
      let msg = `📋 **Задачи по заказу ${tasks.rows[0].OrderNumber}:**\n\n`;
      tasks.rows.forEach(t => {
        const status = ['🔴 To Do', '🟡 In Progress', '✅ Completed'][t.Status] || 'Неизвестно';
        msg += `• ${t.Description}\n  ${status}, срок: ${t.DueDate ? new Date(t.DueDate).toLocaleDateString('ru') : '—'}\n`;
      });
      ctx.reply(msg);
    } catch (err) {
      ctx.reply('Ошибка получения задач.');
    }
    return;
  }

  next();
});

bot.launch().then(() => console.log('Telegram bot started'));

// ========== API для синхронизации ==========
app.post('/api/sync-order', async (req, res) => {
  const order = req.body;
  if (!order || !order.OrderNumber) {
    return res.status(400).json({ error: 'Invalid order data' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Проверяем существование заказа по номеру
    const existing = await client.query(
      `SELECT "Id" FROM public."Orders" WHERE "OrderNumber" = $1`,
      [order.OrderNumber]
    );

    let orderId;
    if (existing.rows.length > 0) {
      orderId = existing.rows[0].Id;
      // Обновляем заказ
      await client.query(
        `UPDATE public."Orders" SET
          "ClientName" = $1,
          "ContainerCount" = $2,
          "GoodsType" = $3,
          "Route" = $4,
          "TransitPort" = $5,
          "DocumentNumber" = $6,
          "ChineseTransportCompany" = $7,
          "IranianTransportCompany" = $8,
          "Status" = $9,
          "CreationDate" = $10,
          "LoadingDate" = $11,
          "DepartureDate" = $12,
          "ArrivalIranDate" = $13,
          "TruckLoadingDate" = $14,
          "ArrivalTurkmenistanDate" = $15,
          "ClientReceivingDate" = $16,
          "ArrivalNoticeDate" = $17,
          "TkmDate" = $18,
          "EtaDate" = $19,
          "HasLoadingPhoto" = $20,
          "HasLocalCharges" = $21,
          "HasTex" = $22,
          "Notes" = $23,
          "AdditionalInfo" = $24,
          "StatusColor" = $25
        WHERE "Id" = $26`,
        [
          order.ClientName,
          order.ContainerCount,
          order.GoodsType,
          order.Route,
          order.TransitPort,
          order.DocumentNumber,
          order.ChineseTransportCompany,
          order.IranianTransportCompany,
          order.Status,
          order.CreationDate,
          order.LoadingDate,
          order.DepartureDate,
          order.ArrivalIranDate,
          order.TruckLoadingDate,
          order.ArrivalTurkmenistanDate,
          order.ClientReceivingDate,
          order.ArrivalNoticeDate,
          order.TkmDate,
          order.EtaDate,
          order.HasLoadingPhoto,
          order.HasLocalCharges,
          order.HasTex,
          order.Notes,
          order.AdditionalInfo,
          order.StatusColor,
          orderId
        ]
      );
      // Удаляем старые контейнеры
      await client.query(`DELETE FROM public."Containers" WHERE "OrderId" = $1`, [orderId]);
      // Удаляем старые задачи
      await client.query(`DELETE FROM public."Tasks" WHERE "OrderId" = $1`, [orderId]);
    } else {
      // Вставляем новый заказ
      const insertOrder = await client.query(
        `INSERT INTO public."Orders" (
          "OrderNumber", "ClientName", "ContainerCount", "GoodsType", "Route",
          "TransitPort", "DocumentNumber", "ChineseTransportCompany", "IranianTransportCompany",
          "Status", "CreationDate", "LoadingDate", "DepartureDate", "ArrivalIranDate",
          "TruckLoadingDate", "ArrivalTurkmenistanDate", "ClientReceivingDate",
          "ArrivalNoticeDate", "TkmDate", "EtaDate", "HasLoadingPhoto", "HasLocalCharges",
          "HasTex", "Notes", "AdditionalInfo", "StatusColor"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
        RETURNING "Id"`,
        [
          order.OrderNumber,
          order.ClientName,
          order.ContainerCount,
          order.GoodsType,
          order.Route,
          order.TransitPort,
          order.DocumentNumber,
          order.ChineseTransportCompany,
          order.IranianTransportCompany,
          order.Status,
          order.CreationDate,
          order.LoadingDate,
          order.DepartureDate,
          order.ArrivalIranDate,
          order.TruckLoadingDate,
          order.ArrivalTurkmenistanDate,
          order.ClientReceivingDate,
          order.ArrivalNoticeDate,
          order.TkmDate,
          order.EtaDate,
          order.HasLoadingPhoto,
          order.HasLocalCharges,
          order.HasTex,
          order.Notes,
          order.AdditionalInfo,
          order.StatusColor
        ]
      );
      orderId = insertOrder.rows[0].Id;
    }

    // Вставляем контейнеры
    if (order.Containers && order.Containers.length > 0) {
      for (const container of order.Containers) {
        await client.query(
          `INSERT INTO public."Containers" (
            "OrderId", "ContainerNumber", "ContainerType", "Weight", "Volume",
            "LoadingDate", "DepartureDate", "ArrivalIranDate", "TruckLoadingDate",
            "ArrivalTurkmenistanDate", "ClientReceivingDate", "DriverFirstName",
            "DriverLastName", "DriverCompany", "TruckNumber", "DriverIranPhone",
            "DriverTurkmenistanPhone"
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            orderId,
            container.ContainerNumber,
            container.ContainerType,
            container.Weight,
            container.Volume,
            container.LoadingDate,
            container.DepartureDate,
            container.ArrivalIranDate,
            container.TruckLoadingDate,
            container.ArrivalTurkmenistanDate,
            container.ClientReceivingDate,
            container.DriverFirstName,
            container.DriverLastName,
            container.DriverCompany,
            container.TruckNumber,
            container.DriverIranPhone,
            container.DriverTurkmenistanPhone
          ]
        );
      }
    }

    // Вставляем задачи
    if (order.Tasks && order.Tasks.length > 0) {
      for (const task of order.Tasks) {
        await client.query(
          `INSERT INTO public."Tasks" (
            "OrderId", "Description", "AssignedTo", "Status", "Priority", "DueDate", "CreatedDate"
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            orderId,
            task.Description,
            task.AssignedTo,
            task.Status, // числовое значение enum
            task.Priority,
            task.DueDate,
            task.CreatedDate
          ]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, orderId });

    // Отправляем уведомление в Telegram (если нужно)
    // Можно отправить сообщение в чат администратору
    const adminChatId = process.env.ADMIN_CHAT_ID; // ID чата @pepe116 = 1119439099
    if (adminChatId) {
      bot.telegram.sendMessage(
        adminChatId,
        `🔄 Заказ ${order.OrderNumber} обновлён в облаке.`
      ).catch(console.error);
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Простой эндпоинт для проверки работы
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
