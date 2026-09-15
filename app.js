const STORAGE_KEY = "harfi-qarib-state-v1";
const OPEN_FEE = 10000;
const FREE_REQUESTS = 4;
const services = ["كهرباء", "سباكة", "صيانة أجهزة منزلية", "تكييف وتدفئة", "دهان", "نجارة", "حدادة", "تنظيف", "نقل", "خدمات سيارات", "خدمات أخرى"];

const seedState = {
  users: [
    { id: "u-customer", name: "زبون تجريبي", identifier: "customer@example.com", phone: "0999000000", password: "123456", role: "customer" },
    { id: "u-tech", name: "فني تجريبي", identifier: "technician@example.com", phone: "0999111111", password: "123456", role: "technician", specialties: ["كهرباء", "سباكة", "خدمات أخرى"], balance: 30000, freeUsed: 0 },
    { id: "u-admin", name: "مدير المنصة", identifier: "admin@example.com", phone: "0999222222", password: "123456", role: "admin" }
  ],
  requests: []
};
let state = loadState();
let currentUser = null;

const $ = id => document.getElementById(id);
const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
function loadState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || structuredClone(seedState); }
  catch (error) { console.error("Unable to load local data", error); return structuredClone(seedState); }
}
function id(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[char])); }
function showToast(text) { $("toast").textContent = text; $("toast").classList.remove("hidden"); setTimeout(() => $("toast").classList.add("hidden"), 3200); }
function formatDate(value) { return new Date(value).toLocaleString("ar-SY", { dateStyle: "medium", timeStyle: "short" }); }
function userById(userId) { return state.users.find(user => user.id === userId); }
function statusLabel(status) { return ({ new: "طلب جديد", contacted: "تم فتح التواصل", scheduled: "تم تحديد موعد", visited: "تمت الزيارة", completed: "تم الإصلاح", no_agreement: "لم يتم الاتفاق", cancelled: "ملغى" })[status] || status; }
function statusClass(status) { return ["completed"].includes(status) ? "success" : ["cancelled", "no_agreement"].includes(status) ? "cancelled" : status !== "new" ? "open" : ""; }

function init() {
  $("serviceType").innerHTML = services.map(service => `<option>${service}</option>`).join("");
  document.querySelectorAll("[data-auth-tab]").forEach(button => button.addEventListener("click", () => switchAuth(button.dataset.authTab)));
  $("loginForm").addEventListener("submit", login);
  $("registerForm").addEventListener("submit", register);
  $("logoutButton").addEventListener("click", logout);
  $("newRequestButton").addEventListener("click", () => $("requestFormCard").classList.remove("hidden"));
  $("cancelRequestButton").addEventListener("click", () => $("requestFormCard").classList.add("hidden"));
  $("requestForm").addEventListener("submit", createRequest);
  $("topUpButton").addEventListener("click", topUp);
  render();
}
function switchAuth(tab) {
  $("loginForm").classList.toggle("hidden", tab !== "login");
  $("registerForm").classList.toggle("hidden", tab !== "register");
  document.querySelectorAll("[data-auth-tab]").forEach(button => button.classList.toggle("active", button.dataset.authTab === tab));
  $("authMessage").classList.add("hidden");
}
function login(event) {
  event.preventDefault();
  const identifier = $("loginIdentifier").value.trim().toLowerCase();
  const password = $("loginPassword").value;
  const user = state.users.find(item => item.identifier.toLowerCase() === identifier || item.phone === identifier);
  if (!user || user.password !== password) return authError("بيانات الدخول غير صحيحة.");
  currentUser = user.id;
  $("loginForm").reset();
  render();
}
function register(event) {
  event.preventDefault();
  const identifier = $("registerPhone").value.trim();
  if (state.users.some(user => user.phone === identifier)) return authError("رقم الهاتف مستخدم مسبقًا.");
  const role = $("registerRole").value;
  const user = { id: id("user"), name: $("registerName").value.trim(), identifier: identifier, phone: identifier, password: $("registerPassword").value, role };
  if (role === "technician") Object.assign(user, { specialties: [], balance: 0, freeUsed: 0 });
  state.users.push(user); save(); currentUser = user.id; $("registerForm").reset(); render();
}
function authError(text) { $("authMessage").textContent = text; $("authMessage").classList.remove("hidden"); }
function logout() { currentUser = null; render(); }
function current() { return userById(currentUser); }
function render() {
  ["authView", "customerView", "technicianView", "adminView"].forEach(id => $(id).classList.add("hidden"));
  $("logoutButton").classList.toggle("hidden", !currentUser);
  $("currentUserLabel").textContent = currentUser ? current().name : "";
  if (!currentUser) return $("authView").classList.remove("hidden");
  if (current().role === "customer") renderCustomer();
  if (current().role === "technician") renderTechnician();
  if (current().role === "admin") renderAdmin();
}
function renderCustomer() {
  $("customerView").classList.remove("hidden");
  const requests = state.requests.filter(request => request.customerId === currentUser);
  $("customerStats").innerHTML = stat("طلباتي", requests.length) + stat("قيد المتابعة", requests.filter(item => !["completed", "cancelled"].includes(item.status)).length) + stat("مكتملة", requests.filter(item => item.status === "completed").length);
  $("customerRequests").innerHTML = requests.length ? requests.map(requestCardForCustomer).join("") : empty("لسا ما عندك طلبات. اضغط «طلب جديد» للبدء.");
  $("customerRequests").querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => customerAction(button.dataset.action, button.dataset.id)));
}
function renderTechnician() {
  $("technicianView").classList.remove("hidden");
  const tech = current();
  const own = state.requests.filter(request => request.technicianId === tech.id);
  const available = state.requests.filter(request => !request.technicianId && !request.claimedBy.includes(tech.id) && (!tech.specialties?.length || tech.specialties.includes(request.serviceType) || tech.specialties.includes("خدمات أخرى")));
  $("technicianStats").innerHTML = stat("الرصيد", `${tech.balance.toLocaleString()} ل.س`) + stat("المجاني المستخدم", `${tech.freeUsed} / ${FREE_REQUESTS}`) + stat("طلباتي", own.length);
  $("availableRequests").innerHTML = available.length ? available.map(requestCardForTechnician).join("") : empty("لا توجد طلبات مناسبة حاليًا.");
  $("technicianRequests").innerHTML = own.length ? own.map(requestCardForOwnedTechnician).join("") : empty("عندما تفتح طلبًا سيظهر هنا.");
  document.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => technicianAction(button.dataset.action, button.dataset.id)));
}
function renderAdmin() {
  $("adminView").classList.remove("hidden");
  $("adminStats").innerHTML = stat("المستخدمون", state.users.length) + stat("الطلبات", state.requests.length) + stat("طلبات مكتملة", state.requests.filter(item => item.status === "completed").length);
  $("adminRequests").innerHTML = state.requests.length ? state.requests.slice().reverse().map(request => requestCardForAdmin(request)).join("") : empty("لا توجد طلبات.");
  document.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => adminAction(button.dataset.action, button.dataset.id)));
}
function stat(label, value) { return `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${label}</span></div>`; }
function empty(text) { return `<div class="empty">${text}</div>`; }
function requestBase(request) {
  return `<div class="request"><div class="request-head"><div><h4>${escapeHtml(request.serviceType)} <small>#${request.id.slice(-5)}</small></h4><p>${escapeHtml(request.area)} · ${escapeHtml(request.preferredTime)}</p></div><span class="status ${statusClass(request.status)}">${statusLabel(request.status)}</span></div><p>${escapeHtml(request.description)}</p>${request.imageUrl ? `<a href="${escapeHtml(request.imageUrl)}" target="_blank" rel="noopener">عرض الصورة</a>` : ""}<p class="hint">${formatDate(request.createdAt)}</p>`;
}
function requestCardForCustomer(request) {
  const tech = userById(request.technicianId);
  return requestBase(request) + (tech ? `<p><strong>الفني:</strong> ${escapeHtml(tech.name)} ${request.contactUnlocked ? `· ${escapeHtml(tech.phone)}` : ""}</p>` : "") + `<div class="request-actions">${request.status !== "completed" && request.status !== "cancelled" ? `<button class="button secondary" data-action="complete" data-id="${request.id}">تم الإصلاح</button><button class="button ghost" data-action="no_agreement" data-id="${request.id}">لم يتم الاتفاق</button>` : ""}<button class="button ghost" data-action="rate" data-id="${request.id}">تقييم</button></div></div>`;
}
function requestCardForTechnician(request) {
  return requestBase(request) + `<div class="request-actions"><button class="button primary" data-action="claim" data-id="${request.id}">${current().freeUsed < FREE_REQUESTS ? "فتح مجانًا" : `فتح الطلب · ${OPEN_FEE.toLocaleString()} ل.س`}</button></div></div>`;
}
function requestCardForOwnedTechnician(request) {
  const customer = userById(request.customerId);
  return requestBase(request) + `<p><strong>الزبون:</strong> ${escapeHtml(customer?.name)} · ${request.contactUnlocked ? escapeHtml(customer?.phone) : ""}</p><div class="request-actions">${request.status === "contacted" ? `<button class="button secondary" data-action="scheduled" data-id="${request.id}">تحديد موعد</button>` : ""}${request.status === "scheduled" ? `<button class="button secondary" data-action="visited" data-id="${request.id}">تمت الزيارة</button>` : ""}${request.status === "visited" ? `<button class="button secondary" data-action="completed" data-id="${request.id}">تم الإصلاح</button>` : ""}</div></div>`;
}
function requestCardForAdmin(request) {
  const customer = userById(request.customerId), tech = userById(request.technicianId);
  return requestBase(request) + `<p><strong>الزبون:</strong> ${escapeHtml(customer?.name || "—")} · <strong>الفني:</strong> ${escapeHtml(tech?.name || "لم يتم التعيين")}</p></div>`;
}
function createRequest(event) {
  event.preventDefault();
  state.requests.push({ id: id("req"), customerId: currentUser, serviceType: $("serviceType").value, area: $("area").value.trim(), description: $("description").value.trim(), preferredTime: $("preferredTime").value, imageUrl: $("imageUrl").value.trim(), status: "new", technicianId: null, contactUnlocked: false, claimedBy: [], createdAt: new Date().toISOString() });
  save(); $("requestForm").reset(); $("area").value = "جرمانا"; $("requestFormCard").classList.add("hidden"); showToast("تم نشر طلبك للفنيين المناسبين."); renderCustomer();
}
function technicianAction(action, requestId) {
  const request = state.requests.find(item => item.id === requestId);
  if (action === "claim") {
    const tech = current();
    if (request.technicianId) return showToast("تم حجز هذا الطلب من فني آخر.");
    if (tech.freeUsed >= FREE_REQUESTS && tech.balance < OPEN_FEE) return showToast("رصيدك غير كافٍ. اشحن الرصيد أولًا.");
    if (tech.freeUsed < FREE_REQUESTS) tech.freeUsed += 1; else tech.balance -= OPEN_FEE;
    request.technicianId = tech.id; request.contactUnlocked = true; request.claimedBy.push(tech.id); request.status = "contacted";
    save(); showToast("تم فتح بيانات التواصل بنجاح."); renderTechnician();
  } else {
    request.status = action; save(); showToast("تم تحديث حالة الطلب."); renderTechnician();
  }
}
function customerAction(action, requestId) {
  const request = state.requests.find(item => item.id === requestId);
  if (action === "rate") {
    const rating = prompt("قيّم الخدمة من 1 إلى 5:");
    if (rating && /^[1-5]$/.test(rating)) { request.rating = Number(rating); save(); showToast("شكرًا لتقييمك."); }
  } else { request.status = action === "complete" ? "completed" : "no_agreement"; save(); showToast("تم تسجيل ردك على الطلب."); }
  renderCustomer();
}
function adminAction() { renderAdmin(); }
function topUp() {
  const amount = Number(prompt("أدخل قيمة الرصيد التجريبي المراد شحنه:", "50000"));
  if (!Number.isFinite(amount) || amount <= 0) return;
  current().balance += Math.floor(amount); save(); showToast("تمت إضافة الرصيد التجريبي."); renderTechnician();
}
init();
