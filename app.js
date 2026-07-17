/* ===================== Setup check ===================== */
const cfg = window.__FIREBASE_CONFIG__ || {};
if (!cfg.apiKey || cfg.apiKey === "YOUR_API_KEY") {
  document.getElementById('screen-setup').classList.remove('hidden');
  throw new Error("Firebase not configured yet — see screen-setup");
}

firebase.initializeApp(cfg);
const auth = firebase.auth();
const db = firebase.firestore();

/* ===================== Constants ===================== */
const MEMBER_COLORS = [
  { name: 'sage',     hex: '#7A8B69' },
  { name: 'marigold', hex: '#E8A33D' },
  { name: 'rose',     hex: '#C97064' },
  { name: 'slate',    hex: '#5B7C99' },
  { name: 'plum',     hex: '#8B6A9C' },
  { name: 'teal',     hex: '#4F8A82' },
];
const WEEKDAYS_KO = ['일','월','화','수','목','금','토'];
const MONTHS_KO = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

function colorFor(idx) { return MEMBER_COLORS[idx % MEMBER_COLORS.length].hex; }
function initialsFor(name) { return (name || '?').trim().slice(0,1).toUpperCase(); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function pad2(n){ return String(n).padStart(2,'0'); }

/* ===================== App state ===================== */
const state = {
  user: null,          // firebase auth user
  userDoc: null,       // { name, email, familyId }
  familyId: null,
  familyDoc: null,      // { name, inviteCode }
  members: {},          // uid -> { name, colorIndex, locationSharing, lastLocation }
  events: {},            // eventId -> event data
  tasks: {},             // taskId -> task data
  shopping: {},          // itemId -> shopping item data
  wishes: {},            // wishId -> wishlist item data
  wishFilter: 'all',
  notices: {},           // noticeId -> notice data
  shownNudges: {},       // noticeId -> last nudge timestamp we already toasted
  anniversaries: {},     // annivId -> anniversary data
  viewYear: new Date().getFullYear(),
  viewMonth: new Date().getMonth(), // 0-indexed
  selectedDate: todayStr(),
  editingEventId: null,
  editingTaskId: null,
  editingAnniversaryId: null,
  taskFilter: 'all',
  unsubUser: null,
  unsubFamily: null,
  unsubMembers: null,
  unsubEvents: null,
  unsubTasks: null,
  unsubShopping: null,
  unsubAnniversaries: null,
  eventsLoadedOnce: false,
  notifiedAnniversaryToday: null,
  watchId: null,
  lastPos: null,
  map: null,
  mapMarkers: {},
  locationWriteInterval: null,
};

/* ===================== Screen / tab helpers ===================== */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}
function showTab(name) {
  document.querySelectorAll('.tab-panel').forEach(el => el.classList.add('hidden'));
  document.getElementById(`tab-${name}`).classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'map') setTimeout(initMapIfNeeded, 50);
  if (name === 'notice') markNoticesRead();
}
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

function toast(msg) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ===================== Entry (name + shared password, no signup) ===================== */
let pendingEntry = null; // { name, password } — set when offering to create a new family

document.getElementById('form-entry').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('entry-name').value.trim();
  const password = document.getElementById('entry-password').value.trim();
  const errEl = document.getElementById('entry-error');
  const createBlock = document.getElementById('entry-create-block');
  errEl.textContent = '';
  createBlock.classList.add('hidden');
  pendingEntry = null;
  if (!name || !password) { errEl.textContent = '이름과 우리집 암호를 입력해주세요.'; return; }

  const submitBtn = document.querySelector('#form-entry button[type=submit]');
  submitBtn.disabled = true;
  try {
    if (!auth.currentUser) await auth.signInAnonymously();
    const uid = auth.currentUser.uid;
    await db.collection('users').doc(uid).set(
      { name, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }
    );

    const q = await db.collection('families').where('sharedPassword', '==', password).limit(1).get();
    if (!q.empty) {
      // family exists → join it
      const famDoc = q.docs[0];
      const membersSnap = await famDoc.ref.collection('members').get();
      const alreadyMember = membersSnap.docs.some(d => d.id === uid);
      await famDoc.ref.collection('members').doc(uid).set({
        name,
        colorIndex: alreadyMember ? (membersSnap.docs.find(d => d.id === uid).data().colorIndex ?? 0) : membersSnap.size,
        locationSharing: false, lastLocation: null
      }, { merge: true });
      await db.collection('users').doc(uid).set({ familyId: famDoc.id }, { merge: true });
      // the user-doc onSnapshot listener will drive enterFamily()
    } else {
      // no family with this password — offer to create one
      pendingEntry = { name, password };
      document.getElementById('entry-create-text').textContent =
        `"${password}" 암호로 된 우리집이 아직 없어요. 처음이시면 이 암호로 새로 만들 수 있어요.`;
      createBlock.classList.remove('hidden');
    }
  } catch (err) {
    errEl.textContent = friendlyEntryError(err);
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById('btn-entry-create').addEventListener('click', async () => {
  if (!pendingEntry) return;
  const errEl = document.getElementById('entry-error');
  errEl.textContent = '';
  const btn = document.getElementById('btn-entry-create');
  btn.disabled = true;
  try {
    if (!auth.currentUser) await auth.signInAnonymously();
    const uid = auth.currentUser.uid;
    const familyRef = db.collection('families').doc();
    await familyRef.set({
      name: '우리집',
      sharedPassword: pendingEntry.password,
      createdBy: uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await familyRef.collection('members').doc(uid).set({
      name: pendingEntry.name, colorIndex: 0, locationSharing: false, lastLocation: null
    });
    await db.collection('users').doc(uid).set({ name: pendingEntry.name, familyId: familyRef.id }, { merge: true });
    pendingEntry = null;
  } catch (err) {
    errEl.textContent = friendlyEntryError(err);
  } finally {
    btn.disabled = false;
  }
});

function friendlyEntryError(err) {
  if (err.code === 'auth/configuration-not-found' || err.code === 'auth/operation-not-allowed') {
    return 'Firebase 콘솔에서 "익명" 로그인을 켜주세요 (Authentication → 로그인 방법 → 익명).';
  }
  if (err.code === 'auth/network-request-failed') return '네트워크 연결을 확인해주세요.';
  return `문제가 발생했어요 (${err.code || err.message})`;
}

document.getElementById('btn-logout').addEventListener('click', async () => {
  // leave the current family view but keep the anonymous session (so the same
  // device keeps its identity); returns to the entry screen.
  if (state.user) {
    try { await db.collection('users').doc(state.user.uid).set({ familyId: null }, { merge: true }); } catch (e) {}
  }
});

/* ===================== Auth state observer ===================== */
auth.onAuthStateChanged((user) => {
  teardownFamilyListeners();
  if (state.unsubUser) { state.unsubUser(); state.unsubUser = null; }
  if (!user) {
    state.user = null;
    state.familyId = null;
    showScreen('screen-entry');
    return;
  }
  state.user = user;
  state.unsubUser = db.collection('users').doc(user.uid).onSnapshot(snap => {
    state.userDoc = snap.data() || {};
    if (!state.userDoc.familyId) {
      teardownFamilyListeners();
      state.familyId = null;
      showScreen('screen-entry');
    } else if (state.familyId !== state.userDoc.familyId) {
      state.familyId = state.userDoc.familyId;
      enterFamily(state.familyId);
    }
  });
});

/* ===================== Enter family / realtime listeners ===================== */
function teardownFamilyListeners() {
  if (state.unsubFamily) { state.unsubFamily(); state.unsubFamily = null; }
  if (state.unsubMembers) { state.unsubMembers(); state.unsubMembers = null; }
  if (state.unsubEvents) { state.unsubEvents(); state.unsubEvents = null; }
  if (state.unsubTasks) { state.unsubTasks(); state.unsubTasks = null; }
  if (state.unsubShopping) { state.unsubShopping(); state.unsubShopping = null; }
  if (state.unsubWishes) { state.unsubWishes(); state.unsubWishes = null; }
  if (state.unsubNotices) { state.unsubNotices(); state.unsubNotices = null; }
  if (state.unsubAnniversaries) { state.unsubAnniversaries(); state.unsubAnniversaries = null; }
  stopLocationSharing(false);
  state.eventsLoadedOnce = false;
}

function enterFamily(familyId) {
  state.unsubFamily = db.collection('families').doc(familyId).onSnapshot(snap => {
    if (!snap.exists) return;
    state.familyDoc = snap.data();
    document.getElementById('family-name-label').textContent = state.familyDoc.name || '우리집';
    document.getElementById('invite-code-display').textContent = state.familyDoc.sharedPassword || state.familyDoc.inviteCode || '';
  });

  state.unsubMembers = db.collection('families').doc(familyId).collection('members')
    .onSnapshot(snap => {
      state.members = {};
      snap.forEach(doc => { state.members[doc.id] = doc.data(); });
      renderMembers();
      renderAssigneeOptions();
      renderCalendar();
      renderDayPanel();
      renderMapMembers();
    });

  state.unsubEvents = db.collection('families').doc(familyId).collection('events')
    .orderBy('date')
    .onSnapshot(snap => {
      const wasLoaded = state.eventsLoadedOnce;
      snap.docChanges().forEach(change => {
        if (change.type === 'added') {
          state.events[change.doc.id] = { id: change.doc.id, ...change.doc.data() };
          if (wasLoaded && !change.doc.metadata.hasPendingWrites) {
            const ev = state.events[change.doc.id];
            const who = state.members[ev.createdBy]?.name || '가족';
            if (ev.createdBy !== state.user.uid) {
              notifyUser(`${who}님이 일정을 추가했어요`, ev.title);
            }
          }
        } else if (change.type === 'modified') {
          state.events[change.doc.id] = { id: change.doc.id, ...change.doc.data() };
        } else if (change.type === 'removed') {
          delete state.events[change.doc.id];
        }
      });
      state.eventsLoadedOnce = true;
      renderCalendar();
      renderDayPanel();
    });

  state.unsubTasks = db.collection('families').doc(familyId).collection('tasks')
    .onSnapshot(snap => {
      state.tasks = {};
      snap.forEach(doc => { state.tasks[doc.id] = { id: doc.id, ...doc.data() }; });
      renderTasks();
    });

  state.unsubShopping = db.collection('families').doc(familyId).collection('shopping')
    .orderBy('createdAt', 'desc')
    .onSnapshot(snap => {
      state.shopping = {};
      snap.forEach(doc => { state.shopping[doc.id] = { id: doc.id, ...doc.data() }; });
      renderShopping();
    });

  state.unsubWishes = db.collection('families').doc(familyId).collection('wishes')
    .orderBy('createdAt', 'desc')
    .onSnapshot(snap => {
      state.wishes = {};
      snap.forEach(doc => { state.wishes[doc.id] = { id: doc.id, ...doc.data() }; });
      renderWishes();
    });

  state.unsubNotices = db.collection('families').doc(familyId).collection('notices')
    .orderBy('createdAt', 'desc')
    .onSnapshot(snap => {
      // "콕 찌르기" — toast when someone pokes me about a notice I haven't read
      snap.docChanges().forEach(change => {
        if (change.type !== 'modified') return;
        const n = change.doc.data();
        if (n.nudge && n.nudge.by && n.nudge.by !== state.user.uid && n.nudge.at &&
            (!n.readBy || !n.readBy.includes(state.user.uid)) &&
            !change.doc.metadata.hasPendingWrites) {
          const key = n.nudge.at.seconds || Date.now();
          if (state.shownNudges[change.doc.id] !== key) {
            state.shownNudges[change.doc.id] = key;
            const who = state.members[n.nudge.by]?.name || '가족';
            notifyUser(`${who}님이 확인을 기다리고 있어요!`, (n.text || '').slice(0, 30));
          }
        }
      });
      state.notices = {};
      snap.forEach(doc => { state.notices[doc.id] = { id: doc.id, ...doc.data() }; });
      renderNotices();
      markNoticesReadIfVisible();
    });

  state.unsubAnniversaries = db.collection('families').doc(familyId).collection('anniversaries')
    .onSnapshot(snap => {
      state.anniversaries = {};
      snap.forEach(doc => { state.anniversaries[doc.id] = { id: doc.id, ...doc.data() }; });
      renderAnniversaries();
      renderCalendar();
      renderDayPanel();
      checkUpcomingAnniversaries();
    });

  showScreen('screen-app');
  renderCalendar();
  renderDayPanel();
}

/* ===================== Notifications ===================== */
document.getElementById('btn-notif').addEventListener('click', async () => {
  if (!('Notification' in window)) { toast('이 브라우저는 알림을 지원하지 않아요'); return; }
  const perm = await Notification.requestPermission();
  toast(perm === 'granted' ? '알림이 켜졌어요' : '알림 권한이 필요해요');
});
function notifyUser(title, body) {
  toast(`${title}${body ? ' · ' + body : ''}`);
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: 'icon.svg' }); } catch(e) {}
  }
}

/* ===================== Members render ===================== */
function renderMembers() {
  const list = document.getElementById('member-list');
  list.innerHTML = '';
  Object.entries(state.members).forEach(([uid, m]) => {
    const row = document.createElement('div');
    row.className = 'member-row';
    row.innerHTML = `
      <span class="avatar-dot" style="background:${colorFor(m.colorIndex)}">${initialsFor(m.name)}</span>
      <span>${escapeHtml(m.name)}</span>
      ${uid === state.user.uid ? '<span class="member-you">나</span>' : ''}
    `;
    list.appendChild(row);
  });
}
document.getElementById('btn-copy-invite').addEventListener('click', () => {
  const code = document.getElementById('invite-code-display').textContent;
  navigator.clipboard?.writeText(code).then(() => toast('우리집 암호를 복사했어요'));
});

/* ===================== Change shared family password ===================== */
const passwordModal = document.getElementById('modal-password');
document.getElementById('btn-change-password').addEventListener('click', () => {
  document.getElementById('new-password').value = state.familyDoc?.sharedPassword || '';
  document.getElementById('password-error').textContent = '';
  passwordModal.classList.remove('hidden');
});
document.getElementById('modal-password-close').addEventListener('click', () => passwordModal.classList.add('hidden'));
passwordModal.addEventListener('click', (e) => { if (e.target === passwordModal) passwordModal.classList.add('hidden'); });

document.getElementById('form-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('password-error');
  errEl.textContent = '';
  const newPw = document.getElementById('new-password').value.trim();
  if (!newPw) { errEl.textContent = '새 암호를 입력해주세요.'; return; }
  if (newPw === state.familyDoc?.sharedPassword) { passwordModal.classList.add('hidden'); return; }
  try {
    // make sure another family isn't already using this password
    const dup = await db.collection('families').where('sharedPassword', '==', newPw).limit(1).get();
    if (!dup.empty && dup.docs[0].id !== state.familyId) {
      errEl.textContent = '다른 우리집이 이미 쓰는 암호예요. 다른 암호를 정해주세요.';
      return;
    }
    await db.collection('families').doc(state.familyId).update({ sharedPassword: newPw });
    passwordModal.classList.add('hidden');
    toast('우리집 암호를 변경했어요');
  } catch (err) {
    errEl.textContent = `변경에 실패했어요 (${err.code || err.message})`;
  }
});

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ===================== Calendar ===================== */
document.getElementById('cal-prev').addEventListener('click', () => shiftMonth(-1));
document.getElementById('cal-next').addEventListener('click', () => shiftMonth(1));
function shiftMonth(delta) {
  state.viewMonth += delta;
  if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
  if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
  renderCalendar();
}

/* Recurrence: does an event occur on a given YYYY-MM-DD? */
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}
function eventOccursOn(ev, dateStr) {
  const repeat = ev.repeat || 'none';
  if (repeat === 'none') return ev.date === dateStr;
  if (dateStr < ev.date) return false;                       // before it starts
  if (ev.repeatUntil && dateStr > ev.repeatUntil) return false; // after it ends
  if (repeat === 'daily') return true;
  if (repeat === 'weekly') {
    const list = (ev.weekdays && ev.weekdays.length) ? ev.weekdays : [weekdayOf(ev.date)];
    return list.includes(weekdayOf(dateStr));
  }
  if (repeat === 'monthly') {
    return Number(dateStr.split('-')[2]) === Number(ev.date.split('-')[2]);
  }
  return false;
}
function eventsOnDate(dateStr) {
  return Object.values(state.events).filter(ev => eventOccursOn(ev, dateStr));
}
function repeatLabelFor(ev) {
  const repeat = ev.repeat || 'none';
  if (repeat === 'daily') return '매일';
  if (repeat === 'monthly') return '매월';
  if (repeat === 'weekly') {
    const list = (ev.weekdays && ev.weekdays.length) ? ev.weekdays : [weekdayOf(ev.date)];
    const sorted = [...list].sort((a,b) => a - b);
    if (sorted.length === 7) return '매일';
    return '매주 ' + sorted.map(d => WEEKDAYS_KO[d]).join('·');
  }
  return '';
}

function renderCalendar() {
  const grid = document.getElementById('cal-grid');
  document.getElementById('cal-month-label').textContent = `${state.viewYear}. ${MONTHS_KO[state.viewMonth]}`;
  grid.innerHTML = '';

  const firstOfMonth = new Date(state.viewYear, state.viewMonth, 1);
  const startOffset = firstOfMonth.getDay(); // 0=Sun
  const gridStart = new Date(state.viewYear, state.viewMonth, 1 - startOffset);

  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const dateStr = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
    const cell = document.createElement('div');
    cell.className = 'cal-day';
    if (d.getMonth() !== state.viewMonth) cell.classList.add('other-month');
    if (dateStr === todayStr()) cell.classList.add('today');
    if (dateStr === state.selectedDate) cell.classList.add('selected');

    const num = document.createElement('span');
    num.textContent = d.getDate();
    cell.appendChild(num);

    const annivMatch = Object.values(state.anniversaries).find(a => a.month === d.getMonth()+1 && a.day === d.getDate());
    if (annivMatch) {
      const badge = document.createElement('span');
      badge.className = 'cal-day-badge';
      badge.textContent = annivMatch.type === 'birthday' ? '🎂' : '🎉';
      cell.appendChild(badge);
    }

    const dots = document.createElement('div');
    dots.className = 'cal-day-dots';
    const dayEvents = eventsOnDate(dateStr).slice(0, 4);
    dayEvents.forEach(ev => {
      const dot = document.createElement('span');
      dot.className = 'cal-dot';
      dot.style.background = colorForAssignee(ev.assignee);
      dots.appendChild(dot);
    });
    cell.appendChild(dots);

    cell.addEventListener('click', () => {
      state.selectedDate = dateStr;
      renderCalendar();
      renderDayPanel();
    });
    cell.addEventListener('dblclick', () => {
      state.selectedDate = dateStr;
      renderCalendar();
      renderDayPanel();
      openEventModal(null);
    });
    grid.appendChild(cell);
  }
  if (isListView()) renderEventList();
}

function colorForAssignee(assignee) {
  if (assignee === 'all' || !assignee) return '#B9AE94';
  const m = state.members[assignee];
  return m ? colorFor(m.colorIndex) : '#B9AE94';
}

function renderDayPanel() {
  const [y,mo,da] = state.selectedDate.split('-').map(Number);
  const d = new Date(y, mo-1, da);
  const label = `${mo}월 ${da}일 (${WEEKDAYS_KO[d.getDay()]})` + (state.selectedDate === todayStr() ? ' · 오늘' : '');
  document.getElementById('day-panel-date').textContent = label;

  const list = document.getElementById('day-events-list');
  list.innerHTML = '';

  const [sy, smo, sda] = state.selectedDate.split('-').map(Number);
  const dayAnniversaries = Object.values(state.anniversaries).filter(a => a.month === smo && a.day === sda);
  dayAnniversaries.forEach(a => {
    const card = document.createElement('div');
    card.className = 'day-card-anniversary';
    card.textContent = `${a.type === 'birthday' ? '🎂' : '🎉'} ${a.title}`;
    list.appendChild(card);
  });

  const dayEvents = eventsOnDate(state.selectedDate)
    .sort((a,b) => (a.allDay ? '' : a.startTime||'').localeCompare(b.allDay ? '' : b.startTime||''));

  if (dayEvents.length === 0) {
    if (dayAnniversaries.length === 0) list.innerHTML += '<p class="empty-state">이 날은 일정이 없어요.</p>';
    return;
  }
  dayEvents.forEach(ev => {
    const card = document.createElement('div');
    card.className = 'event-card';
    card.style.setProperty('--pin-color', colorForAssignee(ev.assignee));
    const timeLabel = ev.allDay ? '하루 종일' : [ev.startTime, ev.endTime].filter(Boolean).join(' – ');
    const assigneeName = ev.assignee === 'all' ? '전체' : (state.members[ev.assignee]?.name || '?');
    const repeatLabel = repeatLabelFor(ev);
    card.innerHTML = `
      <p class="event-title">${escapeHtml(ev.title)}${repeatLabel ? ` <span class="repeat-chip">↻ ${repeatLabel}</span>` : ''}</p>
      <div class="event-meta">
        <span>${timeLabel}</span>
        <span class="event-assignee-badge">
          <span class="avatar-dot" style="background:${colorForAssignee(ev.assignee)}">${ev.assignee==='all'?'👪':initialsFor(assigneeName)}</span>
          ${escapeHtml(assigneeName)}
        </span>
      </div>
    `;
    card.addEventListener('click', () => openEventModal(ev));
    list.appendChild(card);
  });
}

/* ===================== Calendar / List view toggle (per-device) ===================== */
function isListView() { return localStorage.getItem('calView') === 'list'; }
function applyCalView(view) {
  localStorage.setItem('calView', view);
  document.getElementById('cal-view').classList.toggle('hidden', view !== 'calendar');
  document.getElementById('list-view').classList.toggle('hidden', view !== 'list');
  document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'list') renderEventList();
}
document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => applyCalView(btn.dataset.view));
});
document.getElementById('btn-add-event-list').addEventListener('click', () => openEventModal(null));

function renderEventList() {
  const wrap = document.getElementById('event-list-upcoming');
  if (!wrap) return;
  wrap.innerHTML = '';
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 0; i < 60; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const dateStr = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const evs = eventsOnDate(dateStr)
      .sort((a, b) => (a.allDay ? '' : a.startTime || '').localeCompare(b.allDay ? '' : b.startTime || ''));
    const annivs = Object.values(state.anniversaries).filter(a => a.month === d.getMonth() + 1 && a.day === d.getDate());
    if (evs.length || annivs.length) days.push({ d, dateStr, evs, annivs });
  }
  if (days.length === 0) {
    wrap.innerHTML = '<p class="empty-state">앞으로 60일간 등록된 일정이 없어요. 위 버튼으로 추가해보세요.</p>';
    return;
  }
  days.forEach(({ d, dateStr, evs, annivs }) => {
    const header = document.createElement('div');
    header.className = 'list-date-header';
    header.innerHTML = `<span class="list-date-day">${d.getDate()}</span>
      <span class="list-date-rest">${MONTHS_KO[d.getMonth()]} · ${WEEKDAYS_KO[d.getDay()]}요일${dateStr === todayStr() ? ' · 오늘' : ''}</span>`;
    wrap.appendChild(header);
    annivs.forEach(a => {
      const card = document.createElement('div');
      card.className = 'day-card-anniversary';
      card.textContent = `${a.type === 'birthday' ? '🎂' : '🎉'} ${a.title}`;
      wrap.appendChild(card);
    });
    evs.forEach(ev => {
      const card = document.createElement('div');
      card.className = 'event-card';
      card.style.setProperty('--pin-color', colorForAssignee(ev.assignee));
      const timeLabel = ev.allDay ? '하루 종일' : [ev.startTime, ev.endTime].filter(Boolean).join(' – ');
      const assigneeName = ev.assignee === 'all' ? '전체' : (state.members[ev.assignee]?.name || '?');
      const repeatLabel = repeatLabelFor(ev);
      card.innerHTML = `
        <p class="event-title">${escapeHtml(ev.title)}${repeatLabel ? ` <span class="repeat-chip">↻ ${repeatLabel}</span>` : ''}</p>
        <div class="event-meta">
          <span>${timeLabel}</span>
          <span class="event-assignee-badge">
            <span class="avatar-dot" style="background:${colorForAssignee(ev.assignee)}">${ev.assignee === 'all' ? '👪' : initialsFor(assigneeName)}</span>
            ${escapeHtml(assigneeName)}
          </span>
        </div>`;
      card.addEventListener('click', () => openEventModal(ev));
      wrap.appendChild(card);
    });
  });
}
applyCalView(localStorage.getItem('calView') || 'calendar');

/* ===================== Event modal ===================== */
const modal = document.getElementById('modal-event');
document.getElementById('btn-add-event').addEventListener('click', () => openEventModal(null));
document.getElementById('modal-event-close').addEventListener('click', closeEventModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeEventModal(); });

document.getElementById('event-allday').addEventListener('change', (e) => {
  document.getElementById('event-time-row').style.display = e.target.checked ? 'none' : 'grid';
});

function syncRepeatRows() {
  const repeat = document.getElementById('event-repeat').value;
  document.getElementById('event-weekdays').classList.toggle('hidden', repeat !== 'weekly');
  document.getElementById('event-until-row').classList.toggle('hidden', repeat === 'none');
}
document.getElementById('event-repeat').addEventListener('change', () => {
  const repeat = document.getElementById('event-repeat').value;
  // when switching to weekly, default-check the weekday of the chosen date
  if (repeat === 'weekly') {
    const anyChecked = [...document.querySelectorAll('#event-weekdays input')].some(c => c.checked);
    if (!anyChecked) {
      const dateVal = document.getElementById('event-date').value;
      if (dateVal) {
        const wd = weekdayOf(dateVal);
        const box = document.querySelector(`#event-weekdays input[value="${wd}"]`);
        if (box) box.checked = true;
      }
    }
  }
  syncRepeatRows();
});

/* ---- 24-hour time selects (no clock icon, no AM/PM) ---- */
function fillTimeSelects() {
  ['event-start', 'event-end'].forEach(p => {
    const hs = document.getElementById(p + '-hour');
    const ms = document.getElementById(p + '-min');
    if (!hs || hs.dataset.filled) return;
    let ho = '<option value="">--</option>';
    for (let h = 0; h < 24; h++) ho += `<option value="${pad2(h)}">${pad2(h)}시</option>`;
    hs.innerHTML = ho;
    let mo = '';
    for (let m = 0; m < 60; m += 5) mo += `<option value="${pad2(m)}">${pad2(m)}분</option>`;
    ms.innerHTML = mo;
    hs.dataset.filled = '1';
  });
}
function setTimeSel(prefix, val) {
  fillTimeSelects();
  const hs = document.getElementById(prefix + '-hour');
  const ms = document.getElementById(prefix + '-min');
  if (val && /^\d{1,2}:\d{2}$/.test(val)) {
    const [h, m] = val.split(':').map(Number);
    hs.value = pad2(h);
    ms.value = pad2(m - (m % 5));
  } else {
    hs.value = ''; ms.value = '00';
  }
}
function getTimeSel(prefix) {
  const h = document.getElementById(prefix + '-hour').value;
  if (!h) return null;
  const m = document.getElementById(prefix + '-min').value || '00';
  return `${h}:${m}`;
}
fillTimeSelects();

function renderAssigneeOptions() {
  ['event-assignee', 'task-assignee'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="all">👪 전체</option>' +
      Object.entries(state.members).map(([uid,m]) => `<option value="${uid}">${escapeHtml(m.name)}</option>`).join('');
    if (prev) sel.value = prev;
  });
}

function openEventModal(ev) {
  state.editingEventId = ev ? ev.id : null;
  document.getElementById('modal-event-title').textContent = ev ? '일정 수정' : '일정 추가';
  document.getElementById('event-title').value = ev ? ev.title : '';
  document.getElementById('event-date').value = ev ? ev.date : state.selectedDate;
  document.getElementById('event-allday').checked = ev ? !!ev.allDay : false;
  document.getElementById('event-time-row').style.display = (ev && ev.allDay) ? 'none' : 'grid';
  setTimeSel('event-start', ev?.startTime);
  setTimeSel('event-end', ev?.endTime);
  document.getElementById('event-notes').value = ev?.notes || '';
  document.getElementById('event-error').textContent = '';
  renderAssigneeOptions();
  document.getElementById('event-assignee').value = ev?.assignee || 'all';
  // recurrence
  document.getElementById('event-repeat').value = ev?.repeat || 'none';
  document.querySelectorAll('#event-weekdays input').forEach(cb => {
    cb.checked = !!(ev?.weekdays && ev.weekdays.includes(Number(cb.value)));
  });
  document.getElementById('event-until').value = ev?.repeatUntil || '';
  syncRepeatRows();
  document.getElementById('btn-delete-event').classList.toggle('hidden', !ev);
  modal.classList.remove('hidden');
}
function closeEventModal() { modal.classList.add('hidden'); state.editingEventId = null; }

document.getElementById('form-event').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('event-error');
  errEl.textContent = '';
  const allDay = document.getElementById('event-allday').checked;
  const repeat = document.getElementById('event-repeat').value;
  const weekdays = repeat === 'weekly'
    ? [...document.querySelectorAll('#event-weekdays input:checked')].map(c => Number(c.value))
    : [];
  const data = {
    title: document.getElementById('event-title').value.trim(),
    date: document.getElementById('event-date').value,
    allDay,
    startTime: allDay ? null : getTimeSel('event-start'),
    endTime: allDay ? null : getTimeSel('event-end'),
    assignee: document.getElementById('event-assignee').value,
    notes: document.getElementById('event-notes').value.trim() || null,
    repeat,
    weekdays,
    repeatUntil: repeat !== 'none' ? (document.getElementById('event-until').value || null) : null,
  };
  if (!data.title || !data.date) { errEl.textContent = '제목과 날짜를 입력해주세요.'; return; }
  if (repeat === 'weekly' && weekdays.length === 0) { errEl.textContent = '반복할 요일을 하나 이상 선택해주세요.'; return; }
  try {
    const col = db.collection('families').doc(state.familyId).collection('events');
    if (state.editingEventId) {
      await col.doc(state.editingEventId).update(data);
    } else {
      await col.add({ ...data, createdBy: state.user.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    }
    closeEventModal();
  } catch (err) {
    errEl.textContent = `저장에 실패했어요 (${err.code || err.message})`;
  }
});

document.getElementById('btn-delete-event').addEventListener('click', async () => {
  if (!state.editingEventId) return;
  if (!confirm('이 일정을 삭제할까요?')) return;
  await db.collection('families').doc(state.familyId).collection('events').doc(state.editingEventId).delete();
  closeEventModal();
});

/* Quick add: type a title on the day panel → all-day event on the selected date */
document.getElementById('form-quick-event').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('quick-event-title');
  const title = input.value.trim();
  if (!title) return;
  try {
    await db.collection('families').doc(state.familyId).collection('events').add({
      title, date: state.selectedDate, allDay: true, startTime: null, endTime: null,
      assignee: 'all', notes: null, repeat: 'none', weekdays: [], repeatUntil: null,
      createdBy: state.user.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    input.value = '';
  } catch (err) { toast('추가 실패: ' + (err.code || err.message)); }
});

/* ===================== Tasks (chores) ===================== */
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.taskFilter = btn.dataset.filter;
    renderTasks();
  });
});

function renderTasks() {
  const list = document.getElementById('tasks-list');
  if (!list) return;
  list.innerHTML = '';
  let tasks = Object.values(state.tasks);
  if (state.taskFilter === 'mine') tasks = tasks.filter(t => t.assignee === state.user.uid);
  if (state.taskFilter === 'done') tasks = tasks.filter(t => t.done);
  tasks.sort((a,b) => (a.done === b.done) ? 0 : (a.done ? 1 : -1));

  if (tasks.length === 0) {
    list.innerHTML = '<p class="empty-state">할일이 없어요. 오른쪽 위 버튼으로 추가해보세요.</p>';
    return;
  }
  tasks.forEach(t => {
    const card = document.createElement('div');
    card.className = 'task-card' + (t.done ? ' done' : '');
    const assigneeName = t.assignee === 'all' ? '전체' : (state.members[t.assignee]?.name || '?');
    let repeatLabel = '';
    if (t.repeat === 'daily') repeatLabel = '매일 반복';
    else if (t.repeat === 'weekly') {
      const list = (t.weekdays && t.weekdays.length) ? [...t.weekdays].sort((a,b) => a - b) : [];
      repeatLabel = list.length ? '매주 ' + list.map(d => WEEKDAYS_KO[d]).join('·') : '매주 반복';
    }
    card.innerHTML = `
      <span class="task-checkbox ${t.done ? 'checked' : ''}">${t.done ? '✓' : ''}</span>
      <div class="task-body">
        <p class="task-title">${escapeHtml(t.title)}</p>
        <div class="task-meta">
          <span class="event-assignee-badge">
            <span class="avatar-dot" style="background:${colorForAssignee(t.assignee)}">${t.assignee==='all'?'👪':initialsFor(assigneeName)}</span>
            ${escapeHtml(assigneeName)}
          </span>
          ${t.dueDate ? `<span>~${t.dueDate}</span>` : ''}
          ${repeatLabel ? `<span>${repeatLabel}</span>` : ''}
        </div>
      </div>
    `;
    card.querySelector('.task-checkbox').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTaskDone(t);
    });
    card.querySelector('.task-body').addEventListener('click', () => openTaskModal(t));
    list.appendChild(card);
  });
}

async function toggleTaskDone(t) {
  await db.collection('families').doc(state.familyId).collection('tasks').doc(t.id).update({
    done: !t.done,
    completedBy: !t.done ? state.user.uid : null,
    completedAt: !t.done ? firebase.firestore.FieldValue.serverTimestamp() : null,
  });
}

const taskModal = document.getElementById('modal-task');
document.getElementById('btn-add-task').addEventListener('click', () => openTaskModal(null));
document.getElementById('modal-task-close').addEventListener('click', closeTaskModal);
taskModal.addEventListener('click', (e) => { if (e.target === taskModal) closeTaskModal(); });

function syncTaskRepeatRows() {
  const repeat = document.getElementById('task-repeat').value;
  document.getElementById('task-weekdays').classList.toggle('hidden', repeat !== 'weekly');
}
document.getElementById('task-repeat').addEventListener('change', () => {
  if (document.getElementById('task-repeat').value === 'weekly') {
    const anyChecked = [...document.querySelectorAll('#task-weekdays input')].some(c => c.checked);
    if (!anyChecked) {
      const box = document.querySelector(`#task-weekdays input[value="${new Date().getDay()}"]`);
      if (box) box.checked = true;
    }
  }
  syncTaskRepeatRows();
});

function openTaskModal(t) {
  state.editingTaskId = t ? t.id : null;
  document.getElementById('modal-task-title').textContent = t ? '할일 수정' : '할일 추가';
  document.getElementById('task-title').value = t ? t.title : '';
  document.getElementById('task-due').value = t?.dueDate || '';
  document.getElementById('task-repeat').value = t?.repeat || 'none';
  document.querySelectorAll('#task-weekdays input').forEach(cb => {
    cb.checked = !!(t?.weekdays && t.weekdays.includes(Number(cb.value)));
  });
  syncTaskRepeatRows();
  document.getElementById('task-error').textContent = '';
  renderAssigneeOptions();
  document.getElementById('task-assignee').value = t?.assignee || 'all';
  document.getElementById('btn-delete-task').classList.toggle('hidden', !t);
  taskModal.classList.remove('hidden');
}
function closeTaskModal() { taskModal.classList.add('hidden'); state.editingTaskId = null; }

document.getElementById('form-task').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('task-error');
  errEl.textContent = '';
  const repeat = document.getElementById('task-repeat').value;
  const weekdays = repeat === 'weekly'
    ? [...document.querySelectorAll('#task-weekdays input:checked')].map(c => Number(c.value))
    : [];
  const data = {
    title: document.getElementById('task-title').value.trim(),
    assignee: document.getElementById('task-assignee').value,
    dueDate: document.getElementById('task-due').value || null,
    repeat,
    weekdays,
  };
  if (!data.title) { errEl.textContent = '할일 내용을 입력해주세요.'; return; }
  if (repeat === 'weekly' && weekdays.length === 0) { errEl.textContent = '반복할 요일을 하나 이상 선택해주세요.'; return; }
  try {
    const col = db.collection('families').doc(state.familyId).collection('tasks');
    if (state.editingTaskId) {
      await col.doc(state.editingTaskId).update(data);
    } else {
      await col.add({ ...data, done: false, createdBy: state.user.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    }
    closeTaskModal();
  } catch (err) {
    errEl.textContent = `저장에 실패했어요 (${err.code || err.message})`;
  }
});

document.getElementById('btn-delete-task').addEventListener('click', async () => {
  if (!state.editingTaskId) return;
  if (!confirm('이 할일을 삭제할까요?')) return;
  await db.collection('families').doc(state.familyId).collection('tasks').doc(state.editingTaskId).delete();
  closeTaskModal();
});

/* ===================== Shopping / household supplies ===================== */
function renderShopping() {
  const list = document.getElementById('shopping-list');
  if (!list) return;
  list.innerHTML = '';
  const items = Object.values(state.shopping).sort((a,b) => (a.purchased === b.purchased) ? 0 : (a.purchased ? 1 : -1));
  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">사고 싶은 물건을 추가해보세요.</p>';
    return;
  }
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'shopping-item' + (item.purchased ? ' purchased' : '');
    const requesterName = state.members[item.requestedBy]?.name || '?';
    row.innerHTML = `
      <span class="task-checkbox ${item.purchased ? 'checked' : ''}">${item.purchased ? '✓' : ''}</span>
      <span class="shopping-name">${escapeHtml(item.name)}</span>
      <span class="shopping-meta">${escapeHtml(requesterName)}님 요청</span>
    `;
    row.querySelector('.task-checkbox').addEventListener('click', () => toggleShoppingPurchased(item));
    row.addEventListener('dblclick', () => {
      if (confirm('이 항목을 삭제할까요?')) {
        db.collection('families').doc(state.familyId).collection('shopping').doc(item.id).delete();
      }
    });
    list.appendChild(row);
  });
}

async function toggleShoppingPurchased(item) {
  await db.collection('families').doc(state.familyId).collection('shopping').doc(item.id).update({
    purchased: !item.purchased,
    purchasedBy: !item.purchased ? state.user.uid : null,
  });
}

document.getElementById('form-shopping-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('shopping-item-name');
  const name = input.value.trim();
  if (!name) return;
  await db.collection('families').doc(state.familyId).collection('shopping').add({
    name, purchased: false, requestedBy: state.user.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  input.value = '';
});

/* ===================== Wishlist (먹고 싶은 것 · 받고 싶은 선물) ===================== */
document.querySelectorAll('.wish-filter').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.wish-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.wishFilter = btn.dataset.wfilter;
    renderWishes();
  });
});

function renderWishes() {
  const list = document.getElementById('wish-list');
  if (!list) return;
  list.innerHTML = '';
  let items = Object.values(state.wishes);
  if (state.wishFilter !== 'all') items = items.filter(w => (w.category || 'gift') === state.wishFilter);
  items.sort((a,b) => (a.done === b.done) ? 0 : (a.done ? 1 : -1));

  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">아직 위시가 없어요. 먹고 싶은 것·받고 싶은 선물을 적어보세요 🎁</p>';
    return;
  }
  items.forEach(w => {
    const emoji = (w.category === 'food') ? '🍰' : '🎁';
    const who = state.members[w.requestedBy]?.name || '?';
    const row = document.createElement('div');
    row.className = 'wish-item' + (w.done ? ' done' : '');
    row.innerHTML = `
      <span class="wish-emoji">${emoji}</span>
      <div class="wish-body">
        <span class="wish-name">${escapeHtml(w.title)}</span>
        <span class="wish-meta">${escapeHtml(who)}</span>
      </div>
      <button class="wish-heart ${w.done ? 'on' : ''}" title="이뤄졌어요">${w.done ? '💖' : '🤍'}</button>
    `;
    row.querySelector('.wish-heart').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWishDone(w);
    });
    row.addEventListener('dblclick', () => {
      if (confirm('이 위시를 삭제할까요?')) {
        db.collection('families').doc(state.familyId).collection('wishes').doc(w.id).delete();
      }
    });
    list.appendChild(row);
  });
}

async function toggleWishDone(w) {
  await db.collection('families').doc(state.familyId).collection('wishes').doc(w.id).update({
    done: !w.done,
    doneBy: !w.done ? state.user.uid : null,
  });
}

document.getElementById('form-wish-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('wish-title');
  const title = input.value.trim();
  if (!title) return;
  const category = document.getElementById('wish-category').value;
  try {
    await db.collection('families').doc(state.familyId).collection('wishes').add({
      title, category, done: false,
      requestedBy: state.user.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    input.value = '';
  } catch (err) {
    if (err.code === 'permission-denied') toast('위시리스트 권한 설정이 필요해요 (규칙 재게시)');
    else toast('추가 실패: ' + (err.code || err.message));
  }
});

/* ===================== Family notice board ===================== */
const REACTIONS = ['확인했어요!', '감사해요', '넵!', '👍', '💗', '😂'];

document.getElementById('form-notice-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ta = document.getElementById('notice-text');
  const text = ta.value.trim();
  if (!text) return;
  const pinned = document.getElementById('notice-pin').checked;
  try {
    await db.collection('families').doc(state.familyId).collection('notices').add({
      text, pinned, reactions: {}, readBy: [state.user.uid],
      createdBy: state.user.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    ta.value = '';
    document.getElementById('notice-pin').checked = false;
  } catch (err) {
    if (err.code === 'permission-denied') toast('공지 권한 설정이 필요해요 (규칙 재게시)');
    else toast('올리기 실패: ' + (err.code || err.message));
  }
});

function noticeRef(id) {
  return db.collection('families').doc(state.familyId).collection('notices').doc(id);
}
async function toggleReaction(id, label) {
  const n = state.notices[id]; if (!n) return;
  const field = 'reactions.' + state.user.uid;
  const mine = (n.reactions || {})[state.user.uid];
  await noticeRef(id).update({ [field]: mine === label ? firebase.firestore.FieldValue.delete() : label });
}
async function toggleNoticePin(id) {
  const n = state.notices[id]; if (!n) return;
  await noticeRef(id).update({ pinned: !n.pinned });
}
async function nudgeNotice(id) {
  await noticeRef(id).update({ nudge: { by: state.user.uid, at: firebase.firestore.FieldValue.serverTimestamp() } });
  toast('안 읽은 가족에게 콕 알림을 보냈어요');
}
async function deleteNotice(id) {
  if (!confirm('이 공지를 삭제할까요?')) return;
  await noticeRef(id).delete();
}
function convertNoticeToTask(id) {
  const n = state.notices[id]; if (!n) return;
  showTab('tasks');
  openTaskModal(null);
  document.getElementById('task-title').value = (n.text || '').slice(0, 60);
}
function markNoticesReadIfVisible() {
  const tab = document.getElementById('tab-notice');
  if (tab && !tab.classList.contains('hidden')) markNoticesRead();
}
function markNoticesRead() {
  if (!state.user) return;
  Object.values(state.notices).forEach(n => {
    if (!n.readBy || !n.readBy.includes(state.user.uid)) {
      noticeRef(n.id).update({ readBy: firebase.firestore.FieldValue.arrayUnion(state.user.uid) }).catch(() => {});
    }
  });
}

function renderNotices() {
  const list = document.getElementById('notice-list');
  if (!list) return;
  list.innerHTML = '';
  const items = Object.values(state.notices).sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
  });
  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">아직 공지가 없어요. 가족에게 한마디 남겨보세요 💌</p>';
    return;
  }
  const memberCount = Object.keys(state.members).length || 1;
  items.forEach(n => {
    const author = state.members[n.createdBy]?.name || '?';
    const mine = (n.reactions || {})[state.user.uid];
    const reactionEntries = Object.entries(n.reactions || {});
    const readBy = n.readBy || [];
    const isAuthor = n.createdBy === state.user.uid;
    const unread = memberCount - readBy.length;

    const summary = reactionEntries.map(([uid, label]) =>
      `<span class="reaction-chip">${escapeHtml(label)} <b>${escapeHtml(state.members[uid]?.name || '?')}</b></span>`
    ).join('');
    const readAvatars = readBy.map(uid => {
      const m = state.members[uid]; if (!m) return '';
      return `<span class="avatar-dot mini" style="background:${colorFor(m.colorIndex)}">${initialsFor(m.name)}</span>`;
    }).join('');

    const card = document.createElement('div');
    card.className = 'notice-card' + (n.pinned ? ' pinned' : '');
    card.innerHTML = `
      ${n.pinned ? '<span class="pin-badge">📌 고정</span>' : ''}
      <p class="notice-text">${escapeHtml(n.text).replace(/\n/g, '<br>')}</p>
      <div class="notice-byline">
        <span class="avatar-dot" style="background:${colorForAssignee(n.createdBy)}">${initialsFor(author)}</span>
        <span>${escapeHtml(author)}</span>
        <span class="notice-time">${n.createdAt ? formatRelativeTime(n.createdAt) : ''}</span>
      </div>
      <div class="reaction-bar">
        ${REACTIONS.map(r => `<button class="react-btn ${mine === r ? 'on' : ''}" data-r="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join('')}
      </div>
      ${summary ? `<div class="reaction-summary">${summary}</div>` : ''}
      <div class="notice-foot">
        <span class="read-info">👀 ${readBy.length}/${memberCount} ${readAvatars}</span>
        <span class="notice-actions">
          <button class="notice-mini todo">할일로</button>
          ${unread > 0 ? '<button class="notice-mini nudge">콕 찌르기</button>' : ''}
          ${isAuthor ? `<button class="notice-mini pin">${n.pinned ? '고정해제' : '고정'}</button>` : ''}
          ${isAuthor ? '<button class="notice-mini del">삭제</button>' : ''}
        </span>
      </div>
    `;
    card.querySelectorAll('.react-btn').forEach(b => b.addEventListener('click', () => toggleReaction(n.id, b.dataset.r)));
    card.querySelector('.todo')?.addEventListener('click', () => convertNoticeToTask(n.id));
    card.querySelector('.nudge')?.addEventListener('click', () => nudgeNotice(n.id));
    card.querySelector('.pin')?.addEventListener('click', () => toggleNoticePin(n.id));
    card.querySelector('.del')?.addEventListener('click', () => deleteNotice(n.id));
    list.appendChild(card);
  });
}

/* ===================== Anniversaries ===================== */
function populateMonthDaySelects() {
  const monthSel = document.getElementById('anniversary-month');
  const daySel = document.getElementById('anniversary-day');
  if (monthSel.options.length === 0) {
    for (let m=1;m<=12;m++) monthSel.innerHTML += `<option value="${m}">${m}월</option>`;
  }
  const refreshDays = () => {
    const days = new Date(2024, parseInt(monthSel.value,10), 0).getDate(); // leap-safe max
    const prev = daySel.value;
    daySel.innerHTML = '';
    for (let d=1; d<=days; d++) daySel.innerHTML += `<option value="${d}">${d}일</option>`;
    if (prev && parseInt(prev,10) <= days) daySel.value = prev;
  };
  monthSel.onchange = refreshDays;
  refreshDays();
}

function nextOccurrence(month, day) {
  const now = new Date();
  let year = now.getFullYear();
  let d = new Date(year, month-1, day);
  if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d = new Date(year+1, month-1, day);
  return d;
}

function renderAnniversaries() {
  const list = document.getElementById('anniversary-list');
  if (!list) return;
  list.innerHTML = '';
  const items = Object.values(state.anniversaries).sort((a,b) => nextOccurrence(a.month,a.day) - nextOccurrence(b.month,b.day));
  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">등록된 생일·기념일이 없어요.</p>';
    return;
  }
  items.forEach(a => {
    const row = document.createElement('div');
    row.className = 'anniversary-row';
    const next = nextOccurrence(a.month, a.day);
    const daysLeft = Math.ceil((next - new Date(new Date().toDateString())) / 86400000);
    row.innerHTML = `
      <span class="anniversary-icon">${a.type === 'birthday' ? '🎂' : '🎉'}</span>
      <span class="anniversary-name">${escapeHtml(a.title)}</span>
      <span class="anniversary-date">${a.month}월 ${a.day}일</span>
      ${daysLeft <= 14 ? `<span class="anniversary-badge">${daysLeft === 0 ? '오늘' : 'D-' + daysLeft}</span>` : ''}
    `;
    row.addEventListener('click', () => openAnniversaryModal(a));
    list.appendChild(row);
  });
}

const annivModal = document.getElementById('modal-anniversary');
document.getElementById('btn-add-anniversary').addEventListener('click', () => openAnniversaryModal(null));
document.getElementById('modal-anniversary-close').addEventListener('click', closeAnniversaryModal);
annivModal.addEventListener('click', (e) => { if (e.target === annivModal) closeAnniversaryModal(); });

function openAnniversaryModal(a) {
  state.editingAnniversaryId = a ? a.id : null;
  populateMonthDaySelects();
  document.getElementById('anniversary-type').value = a?.type || 'birthday';
  document.getElementById('anniversary-title').value = a?.title || '';
  document.getElementById('anniversary-error').textContent = '';
  if (a) {
    document.getElementById('anniversary-month').value = a.month;
    document.getElementById('anniversary-month').onchange();
    document.getElementById('anniversary-day').value = a.day;
  }
  document.getElementById('btn-delete-anniversary').classList.toggle('hidden', !a);
  annivModal.classList.remove('hidden');
}
function closeAnniversaryModal() { annivModal.classList.add('hidden'); state.editingAnniversaryId = null; }

document.getElementById('form-anniversary').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('anniversary-error');
  errEl.textContent = '';
  const data = {
    type: document.getElementById('anniversary-type').value,
    title: document.getElementById('anniversary-title').value.trim(),
    month: parseInt(document.getElementById('anniversary-month').value, 10),
    day: parseInt(document.getElementById('anniversary-day').value, 10),
  };
  if (!data.title) { errEl.textContent = '이름을 입력해주세요.'; return; }
  try {
    const col = db.collection('families').doc(state.familyId).collection('anniversaries');
    if (state.editingAnniversaryId) {
      await col.doc(state.editingAnniversaryId).update(data);
    } else {
      await col.add({ ...data, createdBy: state.user.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    }
    closeAnniversaryModal();
  } catch (err) {
    errEl.textContent = `저장에 실패했어요 (${err.code || err.message})`;
  }
});

document.getElementById('btn-delete-anniversary').addEventListener('click', async () => {
  if (!state.editingAnniversaryId) return;
  if (!confirm('삭제할까요?')) return;
  await db.collection('families').doc(state.familyId).collection('anniversaries').doc(state.editingAnniversaryId).delete();
  closeAnniversaryModal();
});

function checkUpcomingAnniversaries() {
  const key = todayStr();
  if (state.notifiedAnniversaryToday === key) return;
  const todayItems = Object.values(state.anniversaries).filter(a => {
    const next = nextOccurrence(a.month, a.day);
    const daysLeft = Math.ceil((next - new Date(new Date().toDateString())) / 86400000);
    return daysLeft === 0 || daysLeft === 3;
  });
  todayItems.forEach(a => {
    const next = nextOccurrence(a.month, a.day);
    const daysLeft = Math.ceil((next - new Date(new Date().toDateString())) / 86400000);
    if (daysLeft === 0) notifyUser(`오늘은 ${a.title}${a.type === 'birthday' ? ' 생일' : ''}이에요 🎉`);
    else notifyUser(`${a.title}이(가) 3일 뒤예요`, `${a.month}월 ${a.day}일`);
  });
  state.notifiedAnniversaryToday = key;
}

/* ===================== Map & location sharing ===================== */
function initMapIfNeeded() {
  if (state.map || !state.familyId) return;
  state.map = L.map('map').setView([37.5665, 126.9780], 12); // default Seoul; recenters once we have data
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(state.map);
  renderMapMembers();
}

function renderMapMembers() {
  const listEl = document.getElementById('map-member-list');
  listEl.innerHTML = '';
  const sharing = state.members[state.user.uid]?.locationSharing;
  document.getElementById('map-sharing-status').textContent = sharing ? '위치 공유 켜짐' : '위치 공유 꺼짐';
  document.getElementById('btn-toggle-location').textContent = sharing ? '위치 공유 끄기' : '위치 공유 켜기';

  const positions = [];
  Object.entries(state.members).forEach(([uid, m]) => {
    if (!m.lastLocation) return;
    const { lat, lng, updatedAt } = m.lastLocation;
    positions.push([lat, lng]);

    const row = document.createElement('div');
    row.className = 'map-member-row';
    row.innerHTML = `
      <span class="avatar-dot" style="background:${colorFor(m.colorIndex)}">${initialsFor(m.name)}</span>
      <span>${escapeHtml(m.name)}</span>
      <span class="updated">${formatRelativeTime(updatedAt)}</span>
    `;
    listEl.appendChild(row);

    if (state.map) {
      if (state.mapMarkers[uid]) {
        state.mapMarkers[uid].setLatLng([lat, lng]);
      } else {
        const icon = L.divIcon({
          className: '',
          html: `<div class="family-marker" style="background:${colorFor(m.colorIndex)};width:30px;height:30px;">${initialsFor(m.name)}</div>`,
          iconSize: [30,30],
        });
        state.mapMarkers[uid] = L.marker([lat, lng], { icon }).addTo(state.map).bindPopup(escapeHtml(m.name));
      }
    }
  });

  Object.keys(state.mapMarkers).forEach(uid => {
    if (!state.members[uid] || !state.members[uid].lastLocation) {
      state.mapMarkers[uid].remove();
      delete state.mapMarkers[uid];
    }
  });

  if (state.map && positions.length) {
    state.map.fitBounds(positions, { padding: [30,30], maxZoom: 15 });
  }
}

function formatRelativeTime(ts) {
  if (!ts || !ts.toDate) return '';
  const diffMs = Date.now() - ts.toDate().getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return '방금 전';
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.floor(mins/60);
  if (hrs < 24) return `${hrs}시간 전`;
  return `${Math.floor(hrs/24)}일 전`;
}

document.getElementById('btn-toggle-location').addEventListener('click', () => {
  const sharing = state.members[state.user.uid]?.locationSharing;
  if (sharing) stopLocationSharing(true);
  else startLocationSharing();
});

function startLocationSharing() {
  if (!navigator.geolocation) { toast('이 브라우저는 위치 공유를 지원하지 않아요'); return; }
  navigator.geolocation.getCurrentPosition(async () => {
    await db.collection('families').doc(state.familyId).collection('members').doc(state.user.uid)
      .update({ locationSharing: true });

    state.watchId = navigator.geolocation.watchPosition(pos => {
      state.lastPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    }, err => { toast('위치를 가져오지 못했어요'); }, { enableHighAccuracy: true, maximumAge: 15000 });

    writeLocationNow();
    state.locationWriteInterval = setInterval(writeLocationNow, 25000);
  }, err => {
    toast('위치 권한이 필요해요');
  }, { enableHighAccuracy: true });
}

async function writeLocationNow() {
  if (!state.lastPos || !state.familyId) return;
  await db.collection('families').doc(state.familyId).collection('members').doc(state.user.uid).update({
    lastLocation: { lat: state.lastPos.lat, lng: state.lastPos.lng, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }
  });
}

function stopLocationSharing(persist) {
  if (state.watchId != null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
  if (state.locationWriteInterval) { clearInterval(state.locationWriteInterval); state.locationWriteInterval = null; }
  if (persist && state.familyId && state.user) {
    db.collection('families').doc(state.familyId).collection('members').doc(state.user.uid)
      .update({ locationSharing: false, lastLocation: null }).catch(()=>{});
  }
}

/* ===================== PWA service worker ===================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ===================== Install / add-to-home-screen ===================== */
(function initInstallBanner() {
  const banner = document.getElementById('install-banner');
  if (!banner) return;
  const actionBtn = document.getElementById('install-action');
  const dismissBtn = document.getElementById('install-dismiss');
  const subEl = document.getElementById('install-sub');

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const dismissed = () => localStorage.getItem('installBannerDismissed') === '1';

  let deferredPrompt = null;

  function hide() { banner.classList.add('hidden'); }
  function show() { if (!dismissed() && !isStandalone) banner.classList.remove('hidden'); }

  dismissBtn?.addEventListener('click', () => {
    localStorage.setItem('installBannerDismissed', '1');
    hide();
  });

  // Android / Chrome / Edge: capture the native install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    subEl.textContent = '홈 화면에 추가하면 앱처럼 바로 열 수 있어요.';
    actionBtn.textContent = '설치';
    actionBtn.style.display = '';
    show();
  });

  actionBtn?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch (e) {}
    deferredPrompt = null;
    hide();
  });

  window.addEventListener('appinstalled', () => {
    localStorage.setItem('installBannerDismissed', '1');
    hide();
    toast('앱이 설치됐어요 🎉');
  });

  // iOS Safari has no beforeinstallprompt — show manual instructions instead
  if (isIOS && !isStandalone && !dismissed()) {
    subEl.innerHTML = '공유 버튼 <strong>􀈂</strong> → "홈 화면에 추가"를 누르세요.';
    subEl.textContent = '아래 공유 버튼(□↑)을 누른 뒤 "홈 화면에 추가"를 선택하세요.';
    actionBtn.style.display = 'none';
    setTimeout(show, 1200);
  }
})();
