require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Подключение к Supabase (PostgreSQL)
const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }
});

// Эндпоинт для синхронизации заказа
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
      // Удаляем старые контейнеры и задачи
      await client.query(`DELETE FROM public."Containers" WHERE "OrderId" = $1`, [orderId]);
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
            task.Status,
            task.Priority,
            task.DueDate,
            task.CreatedDate
          ]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, orderId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API service running on port ${PORT}`);
});
