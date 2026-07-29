# GHS Local Chatbot – AI hai tầng

Chatbot tư vấn sản phẩm Green Holding Sport có thể đọc sản phẩm trực tiếp từ Haravan API hoặc dùng `data/products.csv` làm nguồn dự phòng. AI hoạt động theo kiến trúc:

```text
AI lần 1 nhận dạng câu hỏi
→ Code truy vấn dữ liệu sản phẩm
→ AI lần 2 viết câu trả lời cuối
```

## Chức năng

- Tìm theo Mã sản phẩm, Mã biến thể, SKU/Mã phiên bản sản phẩm, Barcode và tên sản phẩm.
- Lọc theo thương hiệu, loại sản phẩm, màu, size, khoảng giá và tình trạng còn hàng.
- Hiển thị ảnh, màu, size, **Còn hàng/Hết hàng**, giá bán, giá gốc/khuyến mãi và link `https://www.greenholdingsport.vn`.
- Tư vấn, so sánh và giải thích sản phẩm bằng AI dựa trên dữ liệu thật.
- Tạo đơn nháp local, chưa đẩy đơn hàng thật lên Haravan hoặc KiotViet.
- Khách gõ `admin` để chuyển sang nhân viên.
- Trang `admin.html` nhận chat trực tiếp, tìm sản phẩm theo tên/mã/SKU/Barcode, gửi tối đa 5 thẻ sản phẩm cho khách, chuyển lại cho AI và quản lý đơn nháp.
- Không cần cài thư viện npm ngoài.

## Cách AI hai tầng hoạt động

### Lần gọi AI 1 – Router

AI chỉ nhận câu hỏi và một ít lịch sử chat. AI trả JSON gồm:

- Ý định của khách.
- Có cần truy vấn database hay không.
- Tên, mã, thương hiệu, màu, size, khoảng giá cần tìm.
- Có cần AI lần 2 viết câu trả lời hay không.

AI lần 1 **không được viết SQL, không được truy cập database và không được tự trả giá/tồn kho**.

### Code truy vấn dữ liệu

Backend kiểm tra JSON, giới hạn độ dài và số lượng bộ lọc, sau đó tự tìm trong dữ liệu đã đồng bộ bằng code Node.js. Dữ liệu giá, màu, size, tồn kho, ảnh, nhóm sản phẩm và link đều lấy từ Haravan hoặc CSV dự phòng.

### Lần gọi AI 2 – Trả lời cuối

AI lần 2 chỉ nhận tối đa một nhóm sản phẩm đã lọc. AI dùng dữ liệu đó để trả lời tự nhiên như nhân viên tư vấn. Giao diện tự dựng thẻ ảnh, giá, màu, size và nút xem chi tiết từ database.

Xem chi tiết tại `TWO_STAGE_AI.md`.

## Yêu cầu

- Windows 10/11.
- Node.js 18 trở lên.
- Internet khi gọi API AI và tải ảnh sản phẩm từ CDN.

## Chạy nhanh

1. Giải nén dự án.
2. Nhấp đúp `start-chatbot.cmd`.
3. Lần đầu hệ thống tự tạo `.env` từ `.env.example`.
4. Mở:
   - Khách: `http://localhost:3100`
   - Nhân viên: `http://localhost:3100/admin.html`

Mật khẩu admin mặc định của bản test: `123456`.

### Gửi sản phẩm thủ công từ Admin

1. Mở một cuộc trò chuyện và bấm **Nhận hỗ trợ**.
2. Bấm **Tìm và gửi sản phẩm**.
3. Tìm theo tên, mã sản phẩm, SKU hoặc Barcode.
4. Chọn tối đa 5 sản phẩm, sửa lời nhắn nếu cần rồi bấm **Gửi sản phẩm đã chọn**.

Khách đang online sẽ nhận thẻ sản phẩm ngay. Mã sản phẩm được lưu cùng tin nhắn nên khi khách tải lại trang, ảnh, giá, màu, size, tồn kho và nút xem chi tiết vẫn được khôi phục từ dữ liệu hiện tại.

## Cấu hình API AI

Dùng cùng một model cho cả hai lần gọi:

```env
ANTHROPIC_BASE_URL=https://llm.wokushop.com
ANTHROPIC_AUTH_TOKEN=TOKEN_CUA_BAN
AI_MODEL=TEN_MODEL
```

Hoặc dùng hai model riêng:

```env
AI_ROUTER_MODEL=MODEL_NHE_NHANH
AI_CHAT_MODEL=MODEL_TU_VAN
```

Khi `AI_ROUTER_MODEL` hoặc `AI_CHAT_MODEL` để trống, hệ thống tự dùng `AI_MODEL`.

Mặc định API kiểu Anthropic Messages:

```env
AI_API_STYLE=anthropic
AI_MESSAGES_PATH=/v1/messages
AI_AUTH_MODE=bearer
```

Nếu máy chủ yêu cầu `x-api-key`:

```env
AI_AUTH_MODE=x-api-key
```

Nếu API tương thích OpenAI:

```env
AI_API_STYLE=openai
AI_MESSAGES_PATH=/v1/chat/completions
AI_AUTH_MODE=bearer
```

Sau khi sửa `.env`, dừng bằng `Ctrl+C`, chạy lại `start-chatbot.cmd`, vào trang admin và bấm **Test API AI**. Nút kiểm tra sẽ gọi thử cả Router và AI trả lời cuối.

## Cấu hình số token

```env
AI_ROUTER_MAX_TOKENS=240
AI_FINAL_MAX_TOKENS=520
AI_MAX_CANDIDATES=5
AI_MAX_VARIANTS=10
AI_DESCRIPTION_CHARS=650
AI_ALWAYS_FINAL=true
AI_CACHE_TTL_MS=1800000
```

`AI_ALWAYS_FINAL=true` là chế độ đã chốt: sau AI Router, hệ thống gọi AI lần 2 để soạn lời đáp. Lệnh `admin` và cuộc chat đang do nhân viên xử lý không gọi AI.

## Kết nối Haravan

Tạo Private App trong trang quản trị Haravan và cấp các quyền đọc:

- `com.read_products`: sản phẩm, biến thể, nhóm sản phẩm.
- `com.read_inventories`: tồn kho theo địa điểm.
- `com.read_shop`: danh sách địa điểm kho.

Điền các biến sau trong `.env` khi chạy local hoặc phần Environment của Render:

```env
PRODUCT_SOURCE=haravan
HARAVAN_API_BASE_URL=https://apis.haravan.com/com
HARAVAN_ACCESS_TOKEN=TOKEN_PRIVATE_APP
HARAVAN_SYNC_INTERVAL_MS=600000
HARAVAN_USE_LOCATION_INVENTORY=true
HARAVAN_FALLBACK_TO_CSV=true
```

Hệ thống tải dữ liệu khi khởi động và tự đồng bộ lại mỗi 10 phút. Chatbot tìm trong bộ nhớ nên không gọi Haravan cho từng tin nhắn. Nếu đồng bộ lỗi, dữ liệu lần gần nhất vẫn được giữ nguyên.

Không ghi `HARAVAN_ACCESS_TOKEN` vào GitHub hoặc file `.env.example`.

## Dùng CSV dự phòng

Nếu chưa dùng Haravan, đặt:

```env
PRODUCT_SOURCE=csv
```

Sau đó thay `data/products.csv` bằng CSV mới có cùng cấu trúc và khởi động lại máy chủ.

## Dữ liệu local

Tin nhắn và đơn nháp được lưu ở:

```text
data/local-store.json
```

Muốn xóa dữ liệu thử, dừng máy chủ rồi xóa file này.

## Lưu ý bảo mật

Đây là bản test local. Không đưa trực tiếp lên Internet công khai. Khi triển khai thật cần HTTPS, đăng nhập bảo mật, phân quyền, rate limit, lưu token trong biến môi trường và database chính thức.
