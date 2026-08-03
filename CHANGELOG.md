# Changelog

## 1.6.0 – Evidence hội thoại và bộ lọc loại trừ

- Tách dữ kiện khách đã nói khỏi SearchPlan do AI suy luận, ngăn AI tự thêm môn hoặc hãng rồi tự xác nhận.
- Hỏi loại/bộ môn từ taxonomy Haravan cho mọi nhóm tổng quát: giày, vợt, bóng, quần áo, túi, phụ kiện, bảo hộ và dụng cụ.
- Thêm loại trừ có cấu trúc theo hãng, category, màu và size; màu/size bị loại được lọc đúng ở cấp biến thể.
- So sánh “rẻ hơn/đắt hơn/size lớn hơn/nhỏ hơn” bằng sản phẩm và biến thể thật vừa hiển thị.
- Không sửa edit-distance các từ giao tiếp ba ký tự sau khi bỏ dấu, tránh lỗi “hãy” thành “hay/han/hai”.
- Khóa loại sản phẩm bằng facet `product_kind` và cột `type` Haravan, tránh tên “quần vợt/pickleball” khiến giày lọt vào kết quả vợt.

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
