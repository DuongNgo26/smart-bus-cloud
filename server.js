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

// ===== HÀM TÍNH TRẠM KẾ TIẾP CHO XE CHẠY 2 CHIỀU =====
// huong = 1: chiều đi (tăng dần), huong = -1: chiều về (giảm dần)
// Tới trạm cuối thì quay đầu: O -> P, tới trạm đầu thì quay đầu: A -> B
function tinhTramKeTiep(seq, huong, minSeq, maxSeq) {
    if (huong === 1) {
        if (seq >= maxSeq) return { seq: Math.max(maxSeq - 1, minSeq), huong: -1 };
        return { seq: seq + 1, huong: 1 };
    } else {
        if (seq <= minSeq) return { seq: Math.min(minSeq + 1, maxSeq), huong: 1 };
        return { seq: seq - 1, huong: -1 };
    }
}

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
                COALESCE(t.huong, 1) AS "huong",
                COALESCE(BOOL_OR(r.loai = 'LEN'), false) AS "coKhachLen",
                COALESCE(BOOL_OR(r.loai = 'XUONG'), false) AS "coKhachXuong"
            FROM Stop s
            JOIN Trip t ON s.idRoute = t.idRoute
            LEFT JOIN Request r 
                   ON s.idStop = r.idStop 
                  AND r.idTrip = t.idTrip 
                  AND r.trangThai = 'Đã xác nhận'
            WHERE t.idTrip = $1
            GROUP BY s.idStop, s.tenTram, s.thuTu, t.currentStopSequence, t.huong
            ORDER BY s.thuTu ASC
        `, [idTrip]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy thông tin chuyến xe' });
        }

        // Tính sẵn thứ tự trạm kế tiếp và gắn vào mỗi dòng
        const minSeq = result.rows[0].thuTu;
        const maxSeq = result.rows[result.rows.length - 1].thuTu;
        const { currentStopSequence, huong } = result.rows[0];
        const next = tinhTramKeTiep(currentStopSequence, huong, minSeq, maxSeq);

        const rows = result.rows.map(r => ({ ...r, nextSequence: next.seq }));
        res.json(rows);
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

        // 3. Nút trên xe (idStop = 0 hoặc không truyền): server tự chọn trạm kế tiếp THEO CHIỀU
        if (!idStop || idStop === 0) {
            const tripInfo = await pool.query(`
                SELECT t.idRoute, t.currentStopSequence, COALESCE(t.huong, 1) AS huong
                FROM Trip t 
                WHERE t.idTrip = $1
            `, [idTrip]);

            if (tripInfo.rows.length === 0) {
                return res.status(404).json({ error: 'Không tìm thấy chuyến xe' });
            }

            const { idroute, currentstopsequence, huong } = tripInfo.rows[0];

            const range = await pool.query(`
                SELECT MIN(thuTu) AS minseq, MAX(thuTu) AS maxseq 
                FROM Stop WHERE idRoute = $1
            `, [idroute]);

            const next = tinhTramKeTiep(
                currentstopsequence, huong,
                range.rows[0].minseq, range.rows[0].maxseq
            );

            const stopQuery = await pool.query(`
                SELECT idStop FROM Stop WHERE idRoute = $1 AND thuTu = $2
            `, [idroute, next.seq]);

            if (stopQuery.rows.length === 0) {
                return res.status(400).json({ error: 'Không xác định được trạm kế tiếp!' });
            }
            idStop = stopQuery.rows[0].idstop;
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

// API: Tài xế chuyển trạm (chạy 2 chiều, tới đầu/cuối tuyến thì quay đầu)
app.post('/api/next-stop', async (req, res) => {
    const { idTrip } = req.body;

    if (!idTrip) {
        return res.status(400).json({ error: 'Thiếu idTrip trong yêu cầu' });
    }

    try {
        // Lần 1: đọc chuyến xe + đầu/cuối tuyến trong 1 câu truy vấn
        const info = await pool.query(`
            SELECT t.idRoute, t.currentStopSequence, COALESCE(t.huong, 1) AS huong,
                   MIN(s.thuTu) AS minseq, MAX(s.thuTu) AS maxseq
            FROM Trip t
            JOIN Stop s ON s.idRoute = t.idRoute
            WHERE t.idTrip = $1
            GROUP BY t.idRoute, t.currentStopSequence, t.huong
        `, [idTrip]);

        if (info.rows.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy chuyến xe' });
        }

        const { idroute, currentstopsequence, huong, minseq, maxseq } = info.rows[0];
        const next = tinhTramKeTiep(currentstopsequence, huong, minseq, maxseq);

        // Lần 2: hoàn thành request ở trạm cũ + cập nhật trạm/chiều mới (1 câu lệnh, tự động atomic)
        await pool.query(`
            WITH done AS (
                UPDATE Request
                SET trangThai = 'Hoàn thành'
                WHERE idTrip = $1
                  AND trangThai = 'Đã xác nhận'
                  AND idStop IN (
                      SELECT idStop FROM Stop WHERE idRoute = $2 AND thuTu = $3
                  )
            )
            UPDATE Trip SET currentStopSequence = $4, huong = $5 WHERE idTrip = $1
        `, [idTrip, idroute, currentstopsequence, next.seq, next.huong]);

        res.json({
            message: 'Đã chuyển sang trạm tiếp theo thành công',
            nextStopSequence: next.seq,
            huong: next.huong
        });
    } catch (err) {
        console.error("❌ Lỗi next-stop:", err);
        res.status(500).json({ error: 'Lỗi cập nhật trạm' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server Smart Bus đang chạy tại port ${PORT}`);
});