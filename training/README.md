# Dữ liệu huấn luyện Router AI

`router-policy.json` là bộ quy tắc và ví dụ ngắn được đưa vào prompt của Haiku
khi phân tích câu hỏi khách hàng. Đây là nơi bổ sung các cách nói thực tế, lỗi
chính tả theo ngữ cảnh và quan hệ đúng giữa loại sản phẩm với bộ môn.

Khi thêm ví dụ:

- Viết theo một tình huống tổng quát, không gắn cứng vào một mã sản phẩm.
- Ghi đủ `history`, `message`, `decision` và kết quả AI phải hiểu.
- Với câu trả lời mở như “hãng nào cũng được”, thêm trường tương ứng vào
  `flexibleFields` để chatbot không hỏi lại.
- Không thêm giá, tồn kho, công nghệ hoặc kiến thức sản phẩm chưa kiểm chứng.
- Sau khi sửa phải chạy `npm test` và `npm run eval:validate`.
