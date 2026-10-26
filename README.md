# Camp Score

กระดานคะแนนค่ายแบบเรียลไทม์ พร้อมมาสคอตการ์ตูนประจำทีม

- หน้าเว็บ: `index.html` ไฟล์เดียว โฮสต์บน GitHub Pages
- ข้อมูลสด: Cloudflare Worker + Durable Object ใน `worker/` (Workers Free plan)

ผู้ชมเปิดลิงก์แล้วเห็นคะแนนเปลี่ยนทันทีผ่าน WebSocket ส่วนผู้ดูแลกดปุ่ม "แอดมิน" มุมขวาบน แล้วใส่ PIN

## Deploy เซิร์ฟเวอร์ (ครั้งแรก)

```sh
cd worker
npm install
npx wrangler login                      # เปิดเบราว์เซอร์ให้ล็อกอิน Cloudflare
npx wrangler secret put ADMIN_PIN       # PIN ผู้ดูแล
openssl rand -base64 32 | npx wrangler secret put TOKEN_SECRET
npx wrangler deploy                     # ได้ URL เช่น https://camp-score-api.<subdomain>.workers.dev
```

จากนั้นนำ URL ไปใส่ใน `CONFIG.apiUrl` ใน `index.html` แล้ว push ขึ้น GitHub

## ทดสอบในเครื่อง

```sh
cd worker && npx wrangler dev           # ใช้ค่าใน worker/.dev.vars (PIN 1234)
```

ตั้ง `apiUrl: 'http://localhost:8787'` แล้วเปิด `index.html` ผ่าน local server ถ้าปล่อย `apiUrl` ว่างไว้ หน้าเว็บจะทำงานในโหมดเดโม (เก็บข้อมูลในเบราว์เซอร์อย่างเดียว ใช้ PIN 1234)

## หมายเหตุ

- ใช้ `?camp=ชื่อค่าย` เพื่อแยกกระดานของแต่ละค่าย (PIN ผู้ดูแลใช้ร่วมกันทุกค่าย)
- เพิ่ม ลบ เปลี่ยนชื่อ ตัวการ์ตูน และสีของทีมได้จากปุ่ม "จัดการทีม" ในโหมดแอดมิน (2–12 ทีม) รายชื่อทีมเก็บบนเซิร์ฟเวอร์และอัปเดตทุกจอทันที
- ถ้าเปลี่ยน PIN ให้เปลี่ยน `TOKEN_SECRET` ด้วย เครื่องที่เคยปลดล็อกไว้จะต้องใส่ PIN ใหม่
- ถ้าใส่ PIN ผิดเกิน 15 ครั้งใน 10 นาที IP นั้นจะถูกล็อกชั่วคราว (ทั้งค่ายมักใช้ Wi-Fi เดียวกัน จึงควรปลดล็อกเครื่องสตาฟไว้ก่อนเริ่มงาน เครื่องที่ปลดล็อกแล้วไม่โดนล็อก)
