# Globe Views — cron job cập nhật YouTube tự động (free, chạy trên GitHub)

Repo này chạy một **GitHub Actions cron job mỗi giờ** để lấy số liệu YouTube của các
kênh trong 2 thị trường — **Tiếng Anh** (`channels-en.json`) và **Tây Ban Nha**
(`channels-es.json`) — trong cùng 1 lần chạy, lưu kết quả vào `data/en/` và `data/es/`
riêng biệt. Trang `youtube-channel-analyzer.html` (đặt riêng, không nằm trong repo này)
có 2 tab để xem từng thị trường, đọc dữ liệu từ đây qua link raw GitHub.

Mọi thứ chạy trên server của GitHub — **không cần máy bạn mở, không cần Chrome mở**.

## Cấu trúc

```
channels-en.json     ← danh sách kênh thị trường Tiếng Anh
channels-es.json     ← danh sách kênh thị trường Tây Ban Nha
scripts/update.mjs   ← script chạy cả 2 thị trường trong 1 lần (xem mảng MARKETS trong file)
data/                ← do Action tự tạo & cập nhật, không cần đụng tới
  en/
    index.json
    UCxxxx.json ...
  es/
    index.json
    UCyyyy.json ...
```

## Setup (làm 1 lần)

1. Tạo repo mới trên GitHub, **Public** (để đọc raw JSON không cần token, và Actions chạy free không giới hạn phút).
2. Upload toàn bộ nội dung trong thư mục này (`channels-en.json`, `channels-es.json`, `scripts/`, `.github/`) lên repo — đẩy đúng cấu trúc, đừng đổi tên file.
3. Vào repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - Name: `YOUTUBE_API_KEY`
   - Value: API key YouTube Data API v3 của bạn (lấy tại [Google Cloud Console](https://console.cloud.google.com/apis/library/youtube.googleapis.com))
4. Sửa `channels-en.json` và `channels-es.json` — thay link mẫu bằng các kênh thật của từng thị trường (link, @handle, hoặc Channel ID — mỗi dòng/phần tử array 1 kênh).
5. Vào tab **Actions** của repo → chọn workflow "Update YouTube stats" → **Run workflow** để chạy thử lần đầu ngay (không cần chờ 1 giờ). Nếu chạy xong không lỗi, bạn sẽ thấy `data/en/` và `data/es/` xuất hiện với các file JSON.
6. Lấy địa chỉ raw base của repo, dạng:
   ```
   https://raw.githubusercontent.com/<username>/<ten-repo>/main
   ```
7. Mở file `youtube-channel-analyzer.html`, dán địa chỉ ở bước 6 vào ô "Nguồn dữ liệu (GitHub Actions)" trên trang, bấm **Lưu**. Trang sẽ tự tải dữ liệu cho cả 2 tab "Thị trường Tiếng Anh" / "Thị trường Tây Ban Nha" — bấm tab nào sẽ hiện dữ liệu thị trường đó ngay, không cần tải lại.

Từ giờ, mỗi giờ GitHub sẽ tự chạy lại script cho cả 2 thị trường, commit số liệu mới — kể cả khi bạn tắt máy.

## Thêm / xoá kênh sau này

Sửa trực tiếp `channels-en.json` hoặc `channels-es.json` trên GitHub (web UI GitHub có nút Edit ngay trên file) → commit.
Lần cron chạy tiếp theo (tối đa 1 giờ sau, hoặc bấm Run workflow để chạy ngay) sẽ tự nhận kênh mới — không cần sửa gì ở trang web.

## Thêm thị trường thứ 3 (nếu cần sau này)

Mở `scripts/update.mjs`, thêm 1 dòng vào mảng `MARKETS` (vd `{ key: 'fr', label: 'Tiếng Pháp', channelsFile: path.join(ROOT, 'channels-fr.json') }`), tạo file `channels-fr.json` tương ứng, rồi thêm 1 tab mới trong HTML (copy đoạn `<button class="btn market-tab" data-market="fr">...</button>`).

## Giới hạn cần biết

- **YouTube Data API quota**: free 10,000 unit/ngày, dùng chung cho cả 2 thị trường. Mỗi
  lần cập nhật 1 kênh tốn khoảng vài unit (1 cho mỗi trang playlistItems + 1 cho mỗi 50
  video lấy view count). Theo dõi vài chục kênh/thị trường, chạy mỗi giờ, thường vẫn nằm
  trong free quota — nhưng nếu kênh có hàng nghìn video hoặc tổng số kênh 2 thị trường
  rất nhiều, có thể cần giảm tần suất cron (vd đổi `cron: '0 * * * *'` trong
  `.github/workflows/update.yml` thành `'0 */2 * * *'` để chạy mỗi 2 giờ) hoặc xin tăng quota.
- **GitHub Actions free tier**: repo public → không giới hạn phút chạy. Repo private →
  2000 phút/tháng free (chạy mỗi giờ, cả 2 thị trường, chỉ tốn ~1-3 phút/lần, dư quota).
- Dữ liệu trên repo Public là công khai — ai cũng xem được danh sách kênh và view count
  bạn theo dõi (không phải thông tin nhạy cảm, nhưng nếu không muốn lộ thì chọn Private
  và sửa trang HTML để gửi kèm token khi fetch).

