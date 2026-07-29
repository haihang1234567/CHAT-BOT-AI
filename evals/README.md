# Bộ câu hỏi đánh giá chatbot

Thêm các câu hỏi thực tế vào `customer-questions.json`. Đây là dữ liệu kiểm thử,
không được gửi vào prompt của khách và không làm phát sinh token khi chatbot chạy.

Mẫu một trường hợp:

```json
{
  "id": "football-field-7-001",
  "question": "Tìm giày đá sân 7 dưới 2 triệu",
  "expected": {
    "intent": "product_recommendation",
    "showProducts": true,
    "productCategoryIncludes": ["bóng đá"],
    "requiredProductTerms": ["TF", "AS", "cỏ nhân tạo"],
    "forbiddenProductTerms": ["FG", "SG"],
    "replyMustInclude": [],
    "replyMustNotInclude": []
  },
  "note": "Câu hỏi thật đã được ẩn thông tin cá nhân."
}
```

Các loại câu hỏi nên bổ sung:

- Tìm sản phẩm theo môn, mặt sân, ngân sách, size, màu và đặc điểm người dùng.
- Câu hỏi kiến thức chỉ trả text, bắt buộc có nguồn.
- Câu hỏi thiếu dữ kiện phải hỏi lại thay vì đoán.
- Câu nói tắt, sai chính tả và câu hỏi nối tiếp dựa trên lịch sử chat.
- Những lỗi đã từng xảy ra để ngăn lỗi quay trở lại.

Chạy `npm run eval:validate` để kiểm tra cấu trúc file mà không gọi AI.
