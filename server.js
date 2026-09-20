require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
// Phục vụ các file tĩnh trong thư mục public (index.html, css, js)
app.use(express.static(path.join(__dirname, 'public')));

// Kết nối PostgreSQL trên Cloud
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// API 1: Lấy danh sách trạm dừng của chuyến xe
app.get('/api/stops/:idTrip', async (req, res) => {
    try {
        const { idTrip } = req.params;
        const result = await pool.query(`
            SELECT s.idStop, s.tenTram, s.thuTu, t.currentStopSequence
            FROM Stop s
            JOIN Trip t ON s.idRoute = t.idRoute
            WHERE t.idTrip = $1
            ORDER BY s.thuTu ASC
        `, [idTrip]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Lỗi máy chủ' });
    }
});

// API 2: Gửi yêu cầu Lên/Xuống xe từ Hành khách / Mô phỏng
app.post('/api/request', async (req, res) => {
    try {
        const { idTrip, idStop, loai } = req.body;
        await pool.query(`
            INSERT INTO Request (idTrip, idStop, loai)
            VALUES ($1, $2, $3)
        `, [idTrip, idStop, loai]);
        res.json({ message: 'Gửi yêu cầu thành công!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Lỗi ghi nhận yêu cầu' });
    }
});

// API 3: Dành cho Màn hình Tài xế (Polling 3s/lần) - Lấy trạng thái yêu cầu
app.get('/api/driver-status/:idTrip', async (req, res) => {
    try {
        const { idTrip } = req.params;
        
        // Lấy thông tin chuyến xe
        const tripRes = await pool.query('SELECT currentStopSequence FROM Trip WHERE idTrip = $1', [idTrip]);
        if (tripRes.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy chuyến xe' });
        
        const currentStopSequence = tripRes.rows[0].currentstopsequence;

        // Lấy tất cả yêu cầu chưa xử lý
        const reqRes = await pool.query(`
            SELECT r.idRequest, r.idStop, r.loai, s.thuTu
            FROM Request r
            JOIN Stop s ON r.idStop = s.idStop
            WHERE r.idTrip = $1 AND r.trangThai = 'Đã xác nhận'
        `, [idTrip]);

        res.json({
            currentStopSequence,
            requests: reqRes.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Lỗi dữ liệu tài xế' });
    }
});

// API 4: Tài xế nhấn chuyển sang trạm tiếp theo
app.post('/api/next-stop', async (req, res) => {
    try {
        const { idTrip } = req.body;
        await pool.query(`
            UPDATE Trip 
            SET currentStopSequence = currentStopSequence + 1 
            WHERE idTrip = $1
        `, [idTrip]);
        res.json({ message: 'Đã sang trạm tiếp theo' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Lỗi cập nhật trạm' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server Cloud đang chạy tại port ${PORT}`);
});