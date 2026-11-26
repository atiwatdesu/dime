# พอร์ตหุ้น US

แอพสรุปพอร์ตหุ้นอเมริกา คิดต้นทุนแบบ FIFO หรือต้นทุนเฉลี่ย มีหน้าต่างจำลองการถัว และอัปเดตราคาอัตโนมัติทุกเช้า

- **หน้าเว็บ:** GitHub Pages (โฟลเดอร์ `site/`)
- **ข้อมูล:** Firebase Firestore + ล็อกอินด้วย Google
- **ราคา:** GitHub Actions ดึงจาก Finnhub (หุ้น) และ Frankfurter (USD/THB) ทุกวันอังคาร–เสาร์ 06:47 เวลาไทย

```
site/index.html              แอพ
site/config.js               ค่าเชื่อมต่อ Firebase (ต้องแก้)
firestore.rules              สิทธิ์การเข้าถึง (ต้องแก้อีเมล)
scripts/update-prices.mjs    สคริปต์อัปเดตราคา
.github/workflows/deploy.yml deploy ขึ้น GitHub Pages
.github/workflows/prices.yml อัปเดตราคาตามเวลา
```

## ตั้งค่า (ทำครั้งเดียว)

### 1. Firebase
1. สร้างโปรเจกต์ที่ [console.firebase.google.com](https://console.firebase.google.com) ใช้แพลน Spark (ฟรี) ได้
2. **Authentication → Sign-in method** → เปิด **Google**
3. **Authentication → Settings → Authorized domains** → เพิ่ม `<username>.github.io`
4. **Firestore Database** → Create database (Production mode, เลือก region เช่น `asia-southeast1`)
5. **Firestore → Rules** → วางเนื้อหาจาก `firestore.rules` **แก้ `you@gmail.com` เป็นอีเมลของคุณ** แล้วกด Publish
6. **Project settings → Your apps → Add app (Web)** → คัดลอก `firebaseConfig` มาใส่ใน `site/config.js`
7. **Project settings → Service accounts → Generate new private key** → ได้ไฟล์ JSON (เก็บเป็นความลับ ห้าม commit)

### 2. Finnhub
สมัครที่ [finnhub.io](https://finnhub.io) แล้วคัดลอก API key (free tier ไม่ต้องผูกบัตร)

### 3. GitHub
1. สร้าง repo แล้ว push ไฟล์ทั้งหมดขึ้น branch `main`
2. **Settings → Pages → Source** เลือก **GitHub Actions**
3. **Settings → Secrets and variables → Actions → New repository secret**
   - `FIREBASE_SERVICE_ACCOUNT` = เนื้อหาไฟล์ JSON จากข้อ 1.7 ทั้งก้อน
   - `FINNHUB_KEY` = API key จาก Finnhub
4. รอ workflow **Deploy to GitHub Pages** เสร็จ แล้วเปิด `https://<username>.github.io/<repo>/`
5. ทดสอบราคา: **Actions → Update prices → Run workflow**

## การใช้งาน
- **บันทึกรายการ:** กด "+ บันทึกรายการ" หรือ "นำเข้า PDF"
- **นำเข้า PDF:** ตอนนี้ใช้ตัวอ่านแบบทั่วไป ต้องตรวจทุกแถวในหน้าพรีวิวก่อนบันทึก จะปรับเป็นตัวอ่านเฉพาะ statement ของ Dime เมื่อได้ไฟล์ตัวอย่าง
- **แก้ราคาเอง:** ราคาที่ใส่เองใช้แทนราคาอัตโนมัติจนกว่าจะมีราคาที่ใหม่กว่าเข้ามา
- **สำรองข้อมูล:** ตั้งค่า → ส่งออก JSON / นำเข้า JSON

## ข้อควรรู้
- ราคาเป็นราคาปิดล่าสุด ไม่ใช่เรียลไทม์
- GitHub จะปิด workflow แบบตั้งเวลาเองอัตโนมัติ ถ้า repo public ไม่มีความเคลื่อนไหวนาน 60 วัน ถ้าราคาหยุดอัปเดต ให้เข้าไปเปิดใหม่ในแท็บ Actions
- ห้าม commit ไฟล์ service account JSON
