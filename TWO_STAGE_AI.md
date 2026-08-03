# Kiến trúc AI điều phối + SQL catalog

## Luồng chính

```text
Khách gửi câu hỏi
  → Haiku đọc câu hỏi, lịch sử, trạng thái nhu cầu và Catalog Profile liên quan
  → Haiku chọn ASK | SEARCH | ANSWER | HANDOFF
  → ASK: hỏi thêm đúng một thông tin có ảnh hưởng đến lựa chọn
  → SEARCH: backend xác thực SearchPlan và tạo câu SQL tham số hóa
  → SQLite lọc catalog cache được dựng lại từ Haravan
  → Evidence Gate kiểm tra lại mọi điều kiện cứng trên dữ liệu sản phẩm/biến thể
  → Code dựng ảnh, giá, màu, size, tồn kho và phân trang
  → Chỉ gọi Final AI khi cần tư vấn có lý do hoặc so sánh sâu
```

Haravan vẫn là nguồn dữ liệu duy nhất. SQLite không thay Haravan và không được
nhập dữ liệu thủ công; bảng được dựng lại sau mỗi lần `replaceProducts()` chạy.
Mặc định database nằm trong RAM (`CATALOG_DB_PATH=:memory:`), phù hợp với Render
vì catalog luôn được nạp lại từ Haravan khi tiến trình khởi động.

## Quyết định của Router AI

Router trả JSON có trường `action`:

- `ASK`: chưa đủ dữ kiện và thông tin còn thiếu có thể làm chọn sai loại/công năng.
- `SEARCH`: đã đủ để lọc; `search` là SearchPlan, không phải SQL.
- `ANSWER`: chào hỏi/cảm ơn hoặc câu kiến thức cần đi qua nguồn chính thống.
- `HANDOFF`: chuyển cuộc trò chuyện sang nhân viên.

Ví dụ SearchPlan:

```json
{
  "action": "SEARCH",
  "intent": "product_recommendation",
  "showProducts": true,
  "consultation": { "ready": true, "pendingField": "", "missingFields": [] },
  "search": {
    "query": "giày bóng đá Mizuno màu trắng sân cỏ nhân tạo dưới 2 triệu",
    "brands": ["Mizuno"],
    "categories": ["Giày Bóng Đá"],
    "colors": ["trắng"],
    "maxPrice": 2000000,
    "requirements": [
      { "label": "Sân cỏ nhân tạo", "terms": ["TF", "AS", "cỏ nhân tạo"], "scope": "identity" }
    ],
    "preferences": [],
    "excludeTerms": ["FG", "SG"],
    "inStockOnly": true,
    "limit": 3
  }
}
```

`requirements`, category, brand, màu, size, giá và tồn kho là điều kiện cứng.
`preferences` chỉ tăng thứ hạng. Voyage tìm ứng viên cho nhu cầu mềm như “êm
chân” hoặc “bám đường”; ứng viên Voyage vẫn phải qua SQL và Evidence Gate.

Các phủ định được tách theo scope: `excludeBrands`, `excludeCategories`,
`excludeColors`, `excludeSizes` và `excludeTerms`. Với sản phẩm có cả màu đen và
trắng, yêu cầu “không màu đen” giữ sản phẩm nhưng chỉ đưa biến thể trắng.

Nếu khách chỉ nêu nhóm tổng quát, code kiểm tra taxonomy được dựng từ `type`
Haravan và buộc Router hỏi nhánh công năng trước khi chạy SQL. Dữ kiện trong
SearchPlan do AI sinh ra không được ghép ngược vào lời khách để tự xác nhận.

Khi khách tham chiếu “cái vừa xem”, backend nạp lại giá/size của đúng
`contextProductIds` và `matchedVariantId`; so sánh tương đối không phụ thuộc vào
đoạn HISTORY đã bị cắt ngắn.

## Catalog Profile

Không gửi toàn bộ hàng nghìn sản phẩm vào prompt. Mỗi lượt Router nhận:

- Catalog Summary: loại hàng, thương hiệu, số lượng và khoảng giá thật.
- Catalog Context liên quan: type, brand, màu, size, khoảng giá và tối đa 8 mẫu
  đại diện lấy trực tiếp từ Haravan.
- Trạng thái hội thoại đã xác nhận: category, nhu cầu, điều kiện cứng, ưu tiên,
  trường đang hỏi và trường khách cho phép linh hoạt.

Voyage tạo embedding cho toàn bộ catalog sau đồng bộ, nhưng chỉ query khi tìm
từ khóa không đủ hoặc khách cần tư vấn theo mô tả ngữ nghĩa.

## Không tự nới điều kiện

Nếu SQL trả 0 kết quả, chatbot không đổi màu, hãng, size, ngân sách hoặc công
năng. Chatbot nói rõ chưa có và đưa nút xin phép nới từng điều kiện. Chỉ khi
khách đồng ý, Router mới đặt `search.relaxConstraints`, sau đó backend mới bỏ
đúng trường được phép và tìm lại.

## Chi phí AI

- Chào hỏi, mã chính xác, phân trang “Xem thêm”: 0 call hoặc dùng cache.
- Tìm sản phẩm thông thường: 1 Router call; code/SQL dựng câu trả lời và thẻ.
- Tư vấn có lý do/so sánh: 1 Router + 1 Final call rút gọn.
- Kiến thức: kho nội bộ trước; thiếu mới tìm nguồn chính thống rồi gọi Final.
- Ảnh, toàn bộ biến thể và phân trang không đưa vào prompt AI.

## Chẩn đoán dữ liệu

Admin có endpoint `GET /api/admin/catalog-quality` để xem sản phẩm thiếu type,
SKU, ảnh, màu hoặc size. `GET /api/admin/catalog-status` hiển thị trạng thái
Haravan, SQLite và Voyage.
