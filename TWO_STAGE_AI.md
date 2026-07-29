# Kiến trúc code-first và AI hai tầng dự phòng

## Luồng chính

```text
Khách gửi câu hỏi
  → Code Router nhận dạng ý định và tạo bộ lọc
  → Chỉ khi code thiếu dữ kiện: AI Router bổ sung JSON bộ lọc
  → Code Node.js truy vấn CSV/database
  → Haiku nhận kết quả đã rút gọn và viết câu trả lời
  → Giao diện dựng ảnh, giá, màu, size và link từ database
```

Phần lớn câu hỏi chỉ gọi Haiku một lần. AI không được tự viết SQL và không được tự truy cập database. Nếu cần AI Router, nó chỉ trả một kế hoạch truy vấn có cấu trúc và backend vẫn tự kiểm tra bộ lọc.

## JSON AI lần 1

```json
{
  "intent": "product_recommendation",
  "needDatabase": true,
  "needFinalAi": true,
  "needsAdmin": false,
  "responseMode": "recommend",
  "clarificationQuestion": "",
  "search": {
    "query": "giày bóng chuyền Mizuno màu trắng khoảng 2 triệu size 42",
    "codes": [],
    "productIds": [],
    "names": [],
    "brands": ["Mizuno"],
    "categories": ["giày bóng chuyền"],
    "colors": ["trắng"],
    "sizes": ["42"],
    "minPrice": 1500000,
    "maxPrice": 2500000,
    "inStockOnly": true,
    "limit": 5
  }
}
```

## Haiku trả lời nhận gì?

Ở chế độ `balanced`, Haiku chỉ nhận:

- Câu hỏi khách.
- Kế hoạch đã chuẩn hóa từ code hoặc AI Router.
- Tối đa 3 sản phẩm do code tìm được.
- Tối đa 4 biến thể khi câu hỏi thật sự hỏi màu, size, SKU, giá hoặc tồn kho.
- Tối đa 260 ký tự mô tả và 2 tin nhắn gần nhất.

Ảnh, link và toàn bộ biến thể không cần AI diễn đạt; frontend lấy trực tiếp từ Haravan theo `productId`.

## Câu hỏi kiến thức

- Chỉ trả lời text ngắn, không hiện thẻ sản phẩm.
- AI trả kèm tối đa 3 gợi ý hỏi tiếp trong cùng request.
- Khách bấm **Xem giải thích chi tiết** mới tạo phần trả lời dài.
- Khách bấm gợi ý sản phẩm thì code mới truy vấn kho và dựng ảnh/biến thể.

## Xử lý lỗi

- Chưa có token/model: hệ thống tự dùng bộ tìm kiếm local dự phòng.
- AI Router lỗi hoặc JSON sai: hệ thống dùng Code Router.
- Haiku trả lời lỗi: hệ thống vẫn trả sản phẩm tìm được bằng code local.
- Khách gõ `admin`: chuyển thẳng cho nhân viên, không gọi AI.

## Cấu hình model

Dùng một model chung:

```env
AI_MODEL=ten-model
```

Hoặc tách hai model:

```env
AI_ROUTER_MODEL=model-nhe-nhanh
AI_CHAT_MODEL=model-tu-van-tot
```

Thông thường có thể dùng Haiku cho cả hai biến. AI Router chỉ phát sinh ở các câu code không hiểu đủ.
