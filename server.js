require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Trang chủ điều hướng mặc định đến driver.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Kết nối PostgreSQL (Neon Cloud)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// API CHÍNH: Cung cấp toàn bộ dữ liệu chuyến xe, danh sách trạm & trạng thái yêu cầu cho 3 giao diện
app.get('/api/trip-info/:idTrip', async (req, res) => {
    try {
        const { idTrip } = req.params;
        
        const result = await pool.query(`
            SELECT 
                s.idStop AS "idStop", 
                s.tenTram AS "tenTram", 
                s.thuTu AS "thuTu", 
                t.currentStopSequence AS "currentStopSequence",
                BOOL_OR(r.loai = 'LEN') AS "coKhachLen",
                BOOL_OR(r.loai = 'XUONG') AS "coKhachXuong"
            FROM Stop s
            JOIN Trip t ON s.idRoute = t.idRoute
            LEFT JOIN Request r 
                   ON s.idStop = r.idStop 
                  AND r.idTrip = t.idTrip 
                  AND r.trangThai = 'Đã xác nhận'
            WHERE t.idTrip = $1
            GROUP BY s.idStop, s.tenTram, s.thuTu, t.currentStopSequence
            ORDER BY s.thuTu ASC
        `, [idTrip]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy thông tin chuyến xe' });
        }

        // Trả về MẢNG danh sách trạm theo đúng kỳ vọng của các file HTML
        res.json(result.rows);
    } catch (err) {
        console.error("❌ Lỗi fetch trip-info:", err);
        res.status(500).json({ error: 'Lỗi máy chủ' });
    }
});

// API: Gửi yêu cầu Lên/Xuống xe từ Hành khách & Mô phỏng
app.post('/api/request', async (req, res) => {
    try {
        const { idTrip, idStop, loai } = req.body;
        
        if (!idTrip || !idStop || !loai) {
            return res.status(400).json({ error: 'Thiếu dữ liệu yêu cầu' });
        }

        await pool.query(`
            INSERT INTO Request (idTrip, idStop, loai, trangThai)
            VALUES ($1, $2, $3, 'Đã xác nhận')
        `, [idTrip, idStop, loai]);

        res.json({ message: 'Gửi yêu cầu thành công!' });
    } catch (err) {
        console.error("❌ Lỗi ghi nhận request:", err);
        res.status(500).json({ error: 'Lỗi ghi nhận yêu cầu' });
    }
});

// API: Tài xế nhấn chuyển sang trạm tiếp theo
app.post('/api/next-stop', async (req, res) => {
    const client = await pool.connect();
    try {
        const { idTrip } = req.body;
        await client.query('BEGIN');

        // 1. Chuyển trạng thái các Request ở trạm hiện tại thành 'Hoàn thành'
        await client.query(`
            UPDATE Request 
            SET trangThai = 'Hoàn thành'
            WHERE idTrip = $1 
              AND trangThai = 'Đã xác nhận'
              AND idStop IN (
                  SELECT s.idStop 
                  FROM Stop s 
                  JOIN Trip t ON s.idRoute = t.idRoute 
                  WHERE t.idTrip = $1 AND s.thuTu = t.currentStopSequence
              )
        `, [idTrip]);

        // 2. Tăng vị trí trạm hiện tại lên 1
        await client.query(`
            UPDATE Trip 
            SET currentStopSequence = currentStopSequence + 1 
            WHERE idTrip = $1
        `, [idTrip]);

        await client.query('COMMIT');
        res.json({ message: 'Đã chuyển sang trạm tiếp theo thành công' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("❌ Lỗi next-stop:", err);
        res.status(500).json({ error: 'Lỗi cập nhật trạm' });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server Smart Bus đang chạy tại port ${PORT}`);
});