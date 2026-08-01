# Changelog

## 1.5.0 – AI điều phối và SQL catalog

- Router AI chọn rõ `ASK`, `SEARCH`, `ANSWER` hoặc `HANDOFF` và quản lý dữ kiện qua nhiều lượt chat.
- Thêm Catalog Profile động lấy type, hãng, màu, size, giá và mẫu đại diện từ Haravan.
- Dựng SQLite catalog cache sau mỗi lần đồng bộ Haravan; mọi truy vấn đều tham số hóa.
- Thêm Evidence Gate kiểm chứng điều kiện cứng trước khi gửi thẻ sản phẩm.
- Voyage chỉ bổ sung ứng viên theo ngữ nghĩa; không được vượt bộ lọc SQL.
- Không tự nới màu/hãng/size/ngân sách khi hết kết quả; chỉ nới sau khi khách đồng ý.
- Thêm báo cáo chất lượng catalog tại `/api/admin/catalog-quality`.

## 1.3.0 – AI hai tầng

- Thêm AI Router gọi lần 1 để nhận dạng ý định và xuất bộ lọc JSON.
- Backend tự kiểm tra JSON và truy vấn catalog Haravan đã đồng bộ bằng code; AI không viết SQL.
- Thêm AI lần 2 để nhận dữ liệu đã lọc và tạo câu trả lời cuối.
- Hỗ trợ dùng một model chung hoặc hai model riêng cho Router và Chat.
- Thêm truy vấn có cấu trúc theo mã, tên, thương hiệu, loại, màu, size, khoảng giá và tồn kho.
- Thêm cache riêng cho Router và câu trả lời cuối.
- Nút Test API kiểm tra cả hai lượt gọi.
- Giữ nguyên trang khách, admin trực tiếp, giỏ hàng và đơn nháp local.
- Có fallback local khi AI chưa cấu hình hoặc API lỗi.
