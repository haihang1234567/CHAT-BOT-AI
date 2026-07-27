# Kiến trúc AI hai tầng

## Luồng chính

```text
Khách gửi câu hỏi
  → AI lần 1: Router nhận dạng ý định và trả JSON bộ lọc
  → Backend kiểm tra và làm sạch JSON
  → Code Node.js truy vấn CSV/database
  → AI lần 2 nhận kết quả đã rút gọn
  → AI lần 2 viết câu trả lời tự nhiên
  → Giao diện dựng ảnh, giá, màu, size và link từ database
```

AI không được tự viết SQL và không được tự truy cập database. AI lần 1 chỉ trả một kế hoạch truy vấn có cấu trúc. Backend tự chuyển kế hoạch đó thành các bộ lọc an toàn.

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

## AI lần 2 nhận gì?

AI lần 2 chỉ nhận:

- Câu hỏi khách.
- Kế hoạch đã chuẩn hóa từ AI lần 1.
- Tối đa 5 sản phẩm do code tìm được.
- Tối đa 10 biến thể mỗi sản phẩm.
- Mô tả đã cắt ngắn.
- Một số tin nhắn gần nhất.

Ảnh và link không cần AI diễn đạt; frontend lấy trực tiếp từ dữ liệu sản phẩm.

## Xử lý lỗi

- Chưa có token/model: hệ thống tự dùng bộ tìm kiếm local dự phòng.
- AI lần 1 lỗi hoặc JSON sai: hệ thống dùng bộ xử lý local dự phòng.
- AI lần 2 lỗi: hệ thống vẫn trả sản phẩm tìm được bằng code local.
- Khách gõ `admin`: chuyển thẳng cho nhân viên, không tốn hai lần gọi AI.

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

Tách model giúp lần 1 rẻ và nhanh hơn, trong khi lần 2 vẫn giữ chất lượng tư vấn.
