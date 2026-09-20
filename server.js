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

// Trang chủ điều hướng đến trang Menu chính (index.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Kết nối PostgreSQL (Neon Cloud)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// API CHÍNH: Cung cấp toàn bộ dữ liệu chuyến xe, danh sách trạm & trạng thái yêu cầu
app.get('/api/trip-info/:idTrip', async (req, res) => {
    try {
        const { idTrip } = req.params;
        
        const result = await pool.query(`
            SELECT 
                s.idStop AS "idStop", 
                s.tenTram AS "tenTram", 
                s.thuTu AS "thuTu", 
                t.currentStopSequence AS "currentStopSequence",
                COALESCE(BOOL_OR(r.loai = 'LEN'), false) AS "coKhachLen",
                COALESCE(BOOL_OR(r.loai = 'XUONG'), false) AS "coKhachXuong"
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

        res.json(result.rows);
    } catch (err) {
        console.error("❌ Lỗi fetch trip-info:", err);
        res.status(500).json({ error: 'Lỗi máy chủ' });
    }
});

// API: Gửi yêu cầu Lên/Xuống xe từ Hành khách & Mô phỏng / ESP32
app.post('/api/request', async (req, res) => {
    try {
        let { idTrip, idStop, loai } = req.body;
        
        // 1. Kiểm tra thiếu dữ liệu cơ bản (idTrip và loai là bắt buộc)
        if (!idTrip || !loai) {
            return res.status(400).json({ error: 'Thiếu dữ liệu yêu cầu' });
        }

        // 2. Validate giá trị 'loai' chỉ chấp nhận LEN hoặc XUONG
        if (!['LEN', 'XUONG'].includes(loai)) {
            return res.status(400).json({ error: 'Loại yêu cầu không hợp lệ (chỉ chấp nhận LEN hoặc XUONG)' });
        }

        // 3. XỬ LÝ THÔNG MINH CHO NÚT TRÊN XE (Khi idStop = 0 hoặc không truyền)
        if (!idStop || idStop === 0) {
            // Lấy route và thứ tự trạm hiện tại của chuyến xe
            const tripInfo = await pool.query(`
                SELECT t.idRoute, t.currentStopSequence 
                FROM Trip t 
                WHERE t.idTrip = $1
            `, [idTrip]);

            if (tripInfo.rows.length === 0) {
                return res.status(404).json({ error: 'Không tìm thấy chuyến xe' });
            }

            const { idroute, currentstopsequence } = tripInfo.rows[0];

            // Tìm trạm kế tiếp (trạm có thứ tự lớn hơn trạm hiện tại gần nhất)
            // Nếu muốn khách bấm xuống ở chính trạm hiện tại xe đang đứng, bạn có thể đổi thành `s.thuTu >= currentstopsequence`
            const nextStopQuery = await pool.query(`
                SELECT idStop 
                FROM Stop 
                WHERE idRoute = $1 AND thuTu > $2 
                ORDER BY thuTu ASC 
                LIMIT 1
            `, [idroute, currentstopsequence]);

            if (nextStopQuery.rows.length > 0) {
                idStop = nextStopQuery.rows[0].idstop;
            } else {
                return res.status(400).json({ error: 'Xe đã ở trạm cuối, không thể tạo yêu cầu xuống!' });
            }
        }

        // 4. Lưu request vào Database
        await pool.query(`
            INSERT INTO Request (idTrip, idStop, loai, trangThai)
            VALUES ($1, $2, $3, 'Đã xác nhận')
        `, [idTrip, idStop, loai]);

        res.json({ message: 'Gửi yêu cầu thành công!', idStopUsed: idStop });
    } catch (err) {
        console.error("❌ Lỗi ghi nhận request:", err);
        res.status(500).json({ error: 'Lỗi ghi nhận yêu cầu' });
    }
});

// API: Tài xế nhấn chuyển sang trạm tiếp theo (Tự động xoay vòng về trạm 1 khi ở trạm cuối)
app.post('/api/next-stop', async (req, res) => {
    const { idTrip } = req.body;

    if (!idTrip) {
        return res.status(400).json({ error: 'Thiếu idTrip trong yêu cầu' });
    }

    const client = await pool.connect();
    try {
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

        // 2. Tăng vị trí trạm (Nếu đang ở trạm cuối thì tự động quay về trạm nhỏ nhất)
        const updatedTrip = await client.query(`
            UPDATE Trip 
            SET currentStopSequence = CASE 
                WHEN currentStopSequence >= (
                    SELECT MAX(s.thuTu) 
                    FROM Stop s 
                    JOIN Trip t ON s.idRoute = t.idRoute 
                    WHERE t.idTrip = $1
                ) THEN (
                    SELECT MIN(s.thuTu) 
                    FROM Stop s 
                    JOIN Trip t ON s.idRoute = t.idRoute 
                    WHERE t.idTrip = $1
                )
                ELSE currentStopSequence + 1 
            END
            WHERE idTrip = $1
            RETURNING currentStopSequence
        `, [idTrip]);

        await client.query('COMMIT');

        const newSequence = updatedTrip.rows[0]?.currentstopsequence;
        res.json({ 
            message: 'Đã chuyển sang trạm tiếp theo thành công',
            nextStopSequence: newSequence
        });
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