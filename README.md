# GHS Local Chatbot – AI code-first tiết kiệm token

Chatbot tư vấn sản phẩm Green Holding Sport có thể đọc sản phẩm trực tiếp từ Haravan API hoặc dùng `data/products.csv` làm nguồn dự phòng. AI hoạt động theo kiến trúc:

```text
Haiku phân tích nhu cầu thành JSON ngắn
→ Sản phẩm: code lọc Haravan và dựng thẻ
→ Kiến thức: kho nội bộ có nguồn → thiếu mới gọi Tavily → Haiku tổng hợp có trích dẫn
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

## Cách AI tiết kiệm chi phí hoạt động

### Tư vấn theo hội thoại

Chatbot không còn hiện sản phẩm ngay khi câu hỏi còn quá chung chung. Hệ thống
giữ một trạng thái nhu cầu ngắn trong cuộc trò chuyện và hỏi lần lượt thông tin
có ảnh hưởng lớn đến lựa chọn, ví dụ bộ môn, mặt sân hoặc mục đích sử dụng và
ngân sách. Những dữ kiện khách đã nói được giữ lại nên chatbot không hỏi lại.

Khi chatbot đang chờ một thông tin, câu trả lời tiếp theo luôn được Haiku đọc
cùng câu hỏi gần nhất và trạng thái nhu cầu đã thu thập. Nhờ vậy các cách trả lời
ngắn như `2tr`, `tầm hai triệu`, `trong nhà` hoặc `chân hơi bè` được hiểu theo
ngữ cảnh thay vì xử lý bằng bộ từ khóa cố định và lặp lại câu hỏi cũ.

Khi câu hỏi đã đủ điều kiện lọc cơ bản, ví dụ “giày chạy bộ dưới 1,5 triệu”,
backend trả 3 sản phẩm mỗi lượt. Sản phẩm được hiển thị dạng danh sách gọn phù
hợp với cửa sổ chat nhỏ. Nếu còn kết quả, nút **Xem thêm sản phẩm** giữ nguyên
tiêu chí, loại các sản phẩm đã hiển thị và lấy trang tiếp theo hoàn toàn bằng
code. Thao tác này không gọi Router hoặc Final AI nên không phát sinh token AI.

Từ viết tắt và lỗi chính tả được chuẩn hóa bằng từ vựng lấy từ danh mục Haravan.
Mã sản phẩm, SKU, Barcode và size không bị tự sửa. Nếu AI Router lỗi, Router bằng
code vẫn tiếp tục xử lý các câu hỏi sản phẩm rõ ràng thay vì trả thông báo chung.

### Haiku phân tích câu hỏi

Router AI đọc câu hỏi và tách thành JSON:

- Bộ môn, loại hàng, mục đích, mặt sân và đặc điểm người dùng.
- Tên, mã, thương hiệu, màu, size, ngân sách và tồn kho.
- Điều kiện bắt buộc, điều kiện ưu tiên và điều cần loại trừ.
- Câu hỏi kiến thức cần tìm web hoặc câu hỏi còn thiếu dữ kiện cần hỏi lại.

Router đọc cả lịch sử và trạng thái đang chờ để hiểu câu trả lời ngắn như `pcik
đi`, `2tr`, `bao nhiêu cũng được`. Quan hệ giữa loại hàng và bộ môn, lỗi gõ theo
ngữ cảnh cùng các ví dụ hội thoại được nạp từ `training/router-policy.json`.
Nếu quyết định đầu tiên lặp câu hỏi cũ hoặc ghép sai loại hàng với bộ môn, Haiku
chỉ khi đó mới tự phân tích lại một lần.

Đầu ra ngắn và có giới hạn token. Câu chào, cảm ơn, chuyển nhân viên và mã sản phẩm chính xác vẫn được code xử lý để tránh gọi AI không cần thiết.

Để bổ sung cách nói mới, xem `training/README.md`. Đây là dữ liệu huấn luyện
router hội thoại; còn `knowledge/` chỉ chứa kiến thức thể thao đã kiểm chứng.

### Code truy vấn dữ liệu

Backend kiểm tra JSON, giới hạn độ dài và số lượng bộ lọc, sau đó tự tìm trong dữ liệu đã đồng bộ bằng code Node.js. Dữ liệu giá, màu, size, tồn kho, ảnh, nhóm sản phẩm và link đều lấy từ Haravan hoặc CSV dự phòng.

### Tối ưu số lần gọi AI cho sản phẩm

Sau khi Haiku phân tích, code lọc sản phẩm theo JSON rồi tự dựng câu trả lời và thẻ. Giao diện lấy đầy đủ ảnh, màu, size, SKU, tồn kho và biến thể từ Haravan theo `productId`; những dữ liệu này không được gửi lại cho AI. Vì vậy câu hỏi sản phẩm thông thường chỉ tốn một lần gọi Haiku.

Riêng câu khách yêu cầu tư vấn có lý do hoặc so sánh, hệ thống gọi thêm final AI
với tối đa 3 kết quả đã rút gọn. Lần sửa router chỉ phát sinh khi quyết định đầu
bị lặp hoặc mâu thuẫn, không chạy ở mọi câu hỏi.

### Kiến thức phải có nguồn

Chatbot ưu tiên các tài liệu đã kiểm duyệt trong `knowledge/`. Nếu chưa có kết quả
đủ phù hợp hoặc tài liệu đã hết hạn, Tavily mới tìm tối đa 3 kết quả trong danh
sách website liên đoàn thể thao và nhà sản xuất chính thức. Mỗi nguồn chỉ đưa tối
đa một đoạn ngắn vào Haiku. Chatbot trả text kèm liên kết nguồn; nếu không có
nguồn đủ tin cậy thì báo chưa đủ thông tin thay vì suy đoán. Kết quả tìm kiếm
được cache 24 giờ.

Thêm kiến thức theo mẫu trong `knowledge/README.md`. Thêm các câu hỏi thực tế cần
kiểm thử vào `evals/customer-questions.json`, sau đó chạy `npm run eval:validate`.
File đánh giá không được đưa vào prompt nên không làm tăng token khi khách chat.

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

### Nhờ AI gợi ý câu trả lời cho nhân viên

Trong cuộc trò chuyện do nhân viên hỗ trợ, mỗi tin nhắn của khách có nút **Gợi ý trả lời**:

1. Nhân viên bấm **Gợi ý trả lời** ở đúng câu hỏi cần hỗ trợ.
2. AI đọc câu hỏi, lịch sử trước câu hỏi đó và tra dữ liệu sản phẩm khi cần.
3. Admin hiển thị bản nháp để nhân viên sửa lại.
4. Bấm **Chèn vào ô trả lời** để duyệt rồi gửi bằng tay.
5. Nếu AI tìm được sản phẩm liên quan, có thể chọn **Dùng câu trả lời và sản phẩm** để chuyển sang bước duyệt thẻ sản phẩm.

AI không tự chạy trong trạng thái nhân viên và không tự gửi bản nháp cho khách. Câu hỏi sản phẩm dùng một lần Haiku; câu hỏi kiến thức tìm nguồn rồi mới tổng hợp. Các lần bấm lại cùng nội dung có thể dùng cache hiện có.

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

Sau khi sửa `.env`, dừng bằng `Ctrl+C`, chạy lại `start-chatbot.cmd`, vào trang admin và bấm **Test API AI**. Nút kiểm tra dùng luồng code-first và gọi thử một lần AI trả lời.

## Cấu hình số token

```env
AI_COST_MODE=balanced
AI_ROUTER_MAX_TOKENS=500
AI_FINAL_MAX_TOKENS=320
AI_MAX_CANDIDATES=3
CHAT_PRODUCT_PAGE_SIZE=3
AI_MAX_VARIANTS=4
AI_DESCRIPTION_CHARS=260
AI_HISTORY_MESSAGES=2
AI_HISTORY_CHARS=220
AI_ALWAYS_FINAL=true
AI_ROUTER_ALWAYS=true
AI_PRODUCT_FINAL_ENABLED=false
AI_CACHE_TTL_MS=1800000
```

`AI_ROUTER_ALWAYS=true` yêu cầu Haiku phân tích mọi câu hỏi tự nhiên. `AI_PRODUCT_FINAL_ENABLED=false` giúp câu hỏi sản phẩm không gọi Haiku lần hai. Lệnh `admin`, câu chào, cảm ơn, mã chính xác và cuộc chat đang do nhân viên xử lý không tự gọi AI.

Mỗi request thành công ghi một dòng `[AI_USAGE]` trong Render Logs gồm model, mục đích gọi, input token, output token và kích thước prompt. Có thể dùng các dòng này để đối chiếu trực tiếp với chi phí trên Woku.

## Tra cứu kiến thức chính thống

Tạo API key miễn phí tại `https://app.tavily.com`, sau đó thêm vào `.env` hoặc Render Environment:

```env
KNOWLEDGE_WEB_ENABLED=true
TAVILY_API_KEY=KEY_CUA_BAN
KNOWLEDGE_WEB_MAX_RESULTS=3
KNOWLEDGE_WEB_CONTENT_CHARS=550
KNOWLEDGE_WEB_CACHE_TTL_MS=86400000
```

Danh sách nguồn cho phép nằm trong `KNOWLEDGE_OFFICIAL_DOMAINS`. Không có key hoặc không tìm thấy nguồn trong danh sách này thì chatbot không tự trả lời kiến thức.

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
