// ค่าเชื่อมต่อ Firebase ไม่ใช่ความลับ ใส่ใน repo public ได้ สิ่งที่ปกป้องข้อมูลคือ firestore.rules
export const firebaseConfig = {
  apiKey: "AIzaSyAnR-4BIBWS283xYLqwHD9lrAisJPCzpm4",
  authDomain: "dime-5765a.firebaseapp.com",
  projectId: "dime-5765a",
  storageBucket: "dime-5765a.firebasestorage.app",
  messagingSenderId: "913601887333",
  appId: "1:913601887333:web:ab552d30fec267f0505a8c"
};

// URL ของ news worker บน Cloudflare (ได้หลัง deploy เช่น https://dime-news.<ชื่อ>.workers.dev) ว่างไว้ = กดชื่อหุ้นแล้วเปิด Yahoo Finance
export const newsApi = 'https://dime-news.atiwatdesu.workers.dev';
