# Kho kiến thức đã kiểm duyệt

Chatbot tìm trong thư mục này trước khi gọi Tavily. Chỉ tài liệu có nguồn thuộc
`KNOWLEDGE_OFFICIAL_DOMAINS` mới được nạp. Tài liệu hết `expiresAt` bị bỏ qua và
chatbot tự chuyển sang tìm nguồn trên web.

Thêm một phần tử vào `entries.json` theo mẫu:

```json
{
  "id": "football-outsole-tf",
  "title": "Đế TF cho sân cỏ nhân tạo",
  "sports": ["bóng đá"],
  "questions": [
    "Đế TF dùng cho sân nào?",
    "Giày TF có dùng chạy bộ được không?"
  ],
  "keywords": ["TF", "turf", "sân cỏ nhân tạo"],
  "content": "Các dữ kiện ngắn đã được kiểm tra từ nguồn chính thức.",
  "source": {
    "title": "Tên tài liệu chính thức",
    "url": "https://ten-mien-chinh-thuc.example/tai-lieu"
  },
  "verifiedAt": "2026-07-29",
  "expiresAt": "2027-07-29",
  "enabled": true
}
```

Quy tắc:

- Một mục chỉ nên chứa một chủ đề rõ ràng.
- `content` là dữ kiện đã kiểm tra, không phải nội dung quảng cáo.
- Luôn lưu URL gốc; không dùng blog tổng hợp hoặc nguồn không xác định.
- Khi nội dung thay đổi, cập nhật `verifiedAt` và `expiresAt`.
- Có thể tạo thêm nhiều file `.json` theo từng môn trong thư mục này.
