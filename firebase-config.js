// ─────────────────────────────────────────────────────────────
// Firebase 프로젝트 설정
// 1) https://console.firebase.google.com 에서 새 프로젝트를 만드세요.
// 2) 프로젝트 설정(톱니바퀴) > 일반 > 내 앱 > "</>" (웹 앱)을 추가하세요.
// 3) 아래 firebaseConfig 값을 발급받은 값으로 교체하세요.
// 4) Authentication > Sign-in method 에서 "이메일/비밀번호"를 사용 설정하세요.
// 5) Firestore Database 를 만드세요 (테스트 모드로 시작해도 됩니다).
// ─────────────────────────────────────────────────────────────

const firebaseConfig = {
  apiKey: "AIzaSyBlWzOpmh_nteioih50GcOiYmLw4T4RRVQ",
  authDomain: "kimgane-240e5.firebaseapp.com",
  projectId: "kimgane-240e5",
  storageBucket: "kimgane-240e5.firebasestorage.app",
  messagingSenderId: "1044112562685",
  appId: "1:1044112562685:web:5f4041d74c0ce252a3e194",
  measurementId: "G-FWE02TDL08"
};

window.__FIREBASE_CONFIG__ = firebaseConfig;
