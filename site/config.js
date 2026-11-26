// คัดลอกค่าจาก Firebase Console → Project settings → Your apps → Web app → SDK setup and configuration
// ค่าเหล่านี้ไม่ใช่ความลับ ใส่ใน repo public ได้ สิ่งที่ปกป้องข้อมูลคือ firestore.rules
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000"
};
