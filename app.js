/*
 * Public browser configuration. Do not put a service_role key here.
 * Either edit this object, or define window.HARFI_CONFIG in a small config.js
 * loaded before this file. The anon key is safe to expose when RLS is enabled.
 */
const CONFIG = window.HARFI_CONFIG || {
  supabaseUrl: "",
  supabaseAnonKey: ""
};
const OPEN_FEE = 10000;
const FREE_REQUESTS = 4;
const ACTIVE_REQUEST_CAP = 3;
const services = ["كهرباء", "سباكة", "صيانة أجهزة منزلية", "تكييف وتدفئة", "دهان", "نجارة", "حدادة", "تنظيف", "نقل", "خدمات سيارات", "خدمات أخرى"];
const db = CONFIG.supabaseUrl && CONFIG.supabaseAnonKey && window.supabase
  ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey)
  : null;

let session = null;
let profile = null;
let requests = [];
let requestContacts = {};
let adminUsers = [];
let adminReceipts = [];

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[char]));
const formatDate = value => value ? new Date(value).toLocaleString("ar-SY", { dateStyle: "medium", timeStyle: "short" }) : "—";
const safeUrl = value => {
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch (_error) {
    return "";
  }
};
const showToast = text => {
  $("toast").textContent = text;
  $("toast").classList.remove("hidden");
  window.setTimeout(() => $("toast").classList.add("hidden"), 3200);
};
const statusLabel = status => ({
  new: "طلب جديد", contacted: "تم فتح التواصل", scheduled: "تم تحديد موعد",
  visited: "تمت الزيارة", completed: "تم الإصلاح", no_agreement: "لم يتم الاتفاق",
  cancelled: "ملغى"
}[status] || status);
const receiptStatusLabel = status => ({ pending: "قيد المراجعة", approved: "معتمد", rejected: "مرفوض" }[status] || status);
const statusClass = status => status === "completed" ? "success" : ["cancelled", "no_agreement"].includes(status) ? "cancelled" : status !== "new" ? "open" : "";
const stat = (label, value) => `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${label}</span></div>`;
const empty = text => `<div class="empty">${escapeHtml(text)}</div>`;

function init() {
  $("serviceType").innerHTML = services.map(service => `<option>${escapeHtml(service)}</option>`).join("");
  document.querySelectorAll("[data-auth-tab]").forEach(button => button.addEventListener("click", () => switchAuth(button.dataset.authTab)));
  $("loginForm").addEventListener("submit", login);
  $("registerForm").addEventListener("submit", register);
  $("logoutButton").addEventListener("click", logout);
  $("newRequestButton").addEventListener("click", () => $("requestFormCard").classList.remove("hidden"));
  $("cancelRequestButton").addEventListener("click", () => $("requestFormCard").classList.add("hidden"));
  $("requestForm").addEventListener("submit", createRequest);
  $("topUpButton").addEventListener("click", () => $("topUpCard").classList.toggle("hidden"));
  $("topUpForm").addEventListener("submit", submitTopUp);
  if (!db) {
    $("authView").classList.add("hidden");
    $("setupView").classList.remove("hidden");
    return;
  }
  db.auth.onAuthStateChange((_event, nextSession) => {
    session = nextSession;
    void refresh();
  });
  void refresh();
}

async function refresh() {
  if (!session) {
    profile = null;
    requests = [];
    render();
    return;
  }
  const { data, error } = await db.from("profiles").select("*").eq("id", session.user.id).single();
  if (error) {
    authError("تعذر تحميل ملف الحساب. تأكد من تشغيل supabase-schema.sql.");
    return;
  }
  profile = data;
  await loadRequests();
  if (profile.role === "admin") await loadAdminData();
  render();
}

async function loadRequests() {
  let query = db.from("service_requests").select("*").order("created_at", { ascending: false });
  if (profile.role === "customer") query = query.eq("customer_id", profile.id);
  if (profile.role === "technician") {
    const result = await Promise.all([
      db.from("service_requests").select("*").is("technician_id", null).eq("status", "new").order("created_at", { ascending: false }),
      db.from("service_requests").select("*").eq("technician_id", profile.id).order("created_at", { ascending: false })
    ]);
    if (result.some(item => item.error)) return showError(result.find(item => item.error).error);
    requests = [...result[0].data, ...result[1].data];
    await loadContacts();
    return;
  }
  const { data, error } = await query;
  if (error) return showError(error);
  requests = data || [];
  await loadContacts();
}

async function loadContacts() {
  requestContacts = {};
  const unlocked = requests.filter(item => item.contact_unlocked && item.technician_id);
  const results = await Promise.all(unlocked.map(item => db.rpc("get_request_contact", { p_request_id: item.id })));
  results.forEach((result, index) => {
    if (!result.error && result.data) requestContacts[unlocked[index].id] = result.data;
  });
}

async function loadAdminData() {
  const [users, receipts] = await Promise.all([
    db.from("profiles").select("*").order("created_at", { ascending: false }),
    db.from("topup_receipts").select("*").order("created_at", { ascending: false })
  ]);
  if (!users.error) adminUsers = users.data || [];
  if (!receipts.error) adminReceipts = receipts.data || [];
}

function switchAuth(tab) {
  $("loginForm").classList.toggle("hidden", tab !== "login");
  $("registerForm").classList.toggle("hidden", tab !== "register");
  document.querySelectorAll("[data-auth-tab]").forEach(button => button.classList.toggle("active", button.dataset.authTab === tab));
  $("authMessage").classList.add("hidden");
}

async function login(event) {
  event.preventDefault();
  const email = $("loginIdentifier").value.trim().toLowerCase();
  const password = $("loginPassword").value;
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) return authError(error.message.includes("Invalid") ? "بيانات الدخول غير صحيحة." : error.message);
  $("loginForm").reset();
}

async function register(event) {
  event.preventDefault();
  const email = $("registerEmail").value.trim().toLowerCase();
  const role = $("registerRole").value;
  const { data, error } = await db.auth.signUp({
    email,
    password: $("registerPassword").value,
    options: {
      emailRedirectTo: window.location.origin,
      data: { full_name: $("registerName").value.trim(), phone: $("registerPhone").value.trim(), role }
    }
  });
  if (error) return authError(error.message);
  $("registerForm").reset();
  if (!data.session) authError("تم إنشاء الحساب. افتح رسالة تأكيد البريد ثم سجّل الدخول.");
  else showToast("تم إنشاء الحساب بنجاح.");
}

function authError(text) {
  $("authMessage").textContent = text;
  $("authMessage").classList.remove("hidden");
}

async function logout() {
  await db.auth.signOut();
  session = null;
  profile = null;
  render();
}

function render() {
  ["authView", "setupView", "customerView", "technicianView", "adminView"].forEach(id => $(id).classList.add("hidden"));
  $("logoutButton").classList.toggle("hidden", !session);
  $("currentUserLabel").textContent = profile ? profile.full_name : "";
  if (!db) return $("setupView").classList.remove("hidden");
  if (!session || !profile) return $("authView").classList.remove("hidden");
  if (profile.role === "customer") renderCustomer();
  if (profile.role === "technician") renderTechnician();
  if (profile.role === "admin") renderAdmin();
}

function renderCustomer() {
  $("customerView").classList.remove("hidden");
  const own = requests;
  $("customerStats").innerHTML = stat("طلباتي", own.length) +
    stat("قيد المتابعة", own.filter(item => !["completed", "cancelled"].includes(item.status)).length) +
    stat("مكتملة", own.filter(item => item.status === "completed").length);
  $("customerRequests").innerHTML = own.length ? own.map(requestCardForCustomer).join("") : empty("لسا ما عندك طلبات. اضغط «طلب جديد» للبدء.");
  bindActions("customerRequests", customerAction);
}

function renderTechnician() {
  $("technicianView").classList.remove("hidden");
  const own = requests.filter(item => item.technician_id === profile.id);
  const available = requests.filter(item => !item.technician_id);
  const active = own.filter(item => !["completed", "cancelled", "no_agreement"].includes(item.status)).length;
  $("technicianStats").innerHTML = stat("الرصيد", `${Number(profile.balance || 0).toLocaleString()} ل.س`) +
    stat("المجاني المستخدم", `${profile.free_requests_used || 0} / ${FREE_REQUESTS}`) +
    stat("الطلبات النشطة", `${active} / ${ACTIVE_REQUEST_CAP}`);
  $("availableRequests").innerHTML = available.length ? available.map(requestCardForTechnician).join("") : empty("لا توجد طلبات مناسبة حاليًا.");
  $("technicianRequests").innerHTML = own.length ? own.map(requestCardForOwnedTechnician).join("") : empty("عندما تفتح طلبًا سيظهر هنا.");
  bindActions("availableRequests", technicianAction);
  bindActions("technicianRequests", technicianAction);
}

function renderAdmin() {
  $("adminView").classList.remove("hidden");
  const pendingReceipts = adminReceipts.filter(receipt => receipt.status === "pending");
  const notification = $("adminNotification");
  notification.classList.toggle("hidden", pendingReceipts.length === 0);
  notification.innerHTML = pendingReceipts.length
    ? `<span>لديك ${pendingReceipts.length} إيصال شحن بانتظار المراجعة. تحقق من وصول التحويل عبر شام كاش ثم اعتمد الإيصال.</span><button class="button secondary" type="button" id="reviewReceiptsButton">عرض الإيصالات</button>`
    : "";
  if (pendingReceipts.length) {
    $("reviewReceiptsButton").addEventListener("click", () => $("adminReceipts").scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  $("adminStats").innerHTML = stat("المستخدمون", adminUsers.length) + stat("الطلبات", requests.length) +
    stat("إيصالات بانتظار المراجعة", pendingReceipts.length);
  $("adminRequests").innerHTML = requests.length ? requests.map(requestCardForAdmin).join("") : empty("لا توجد طلبات.");
  $("adminUsers").innerHTML = adminUsers.length ? adminUsers.map(user => `<div class="request"><strong>${escapeHtml(user.full_name)}</strong><p>${escapeHtml(user.phone || "—")} · ${user.role === "technician" ? "فني" : user.role === "admin" ? "مدير" : "زبون"}</p></div>`).join("") : empty("لا يوجد مستخدمون.");
  $("adminReceipts").innerHTML = adminReceipts.length ? adminReceipts.map(receiptCardForAdmin).join("") : empty("لا توجد إيصالات.");
  bindActions("adminReceipts", adminAction);
}

function bindActions(containerId, handler) {
  $(containerId).querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => void handler(button.dataset.action, button.dataset.id)));
}

function requestBase(request) {
  const image = safeUrl(request.image_url || "");
  return `<div class="request"><div class="request-head"><div><h4>${escapeHtml(request.service_type)} <small>#${escapeHtml(request.id.slice(-5))}</small></h4><p>${escapeHtml(request.area)} · ${escapeHtml(request.preferred_time)}</p></div><span class="status ${statusClass(request.status)}">${statusLabel(request.status)}</span></div><p>${escapeHtml(request.description)}</p>${image ? `<a href="${escapeHtml(image)}" target="_blank" rel="noopener">عرض الصورة</a>` : ""}<p class="hint">${formatDate(request.created_at)}</p>`;
}

function requestCardForCustomer(request) {
  const technician = requestContacts[request.id]?.technician;
  return requestBase(request) +
    (technician ? `<p><strong>الفني:</strong> ${escapeHtml(technician.full_name)} · ${escapeHtml(technician.phone || "لا يوجد رقم")}</p>` : request.technician_id ? "<p><strong>الفني:</strong> تم فتح التواصل ويمكنه التواصل معك.</p>" : "") +
    `<div class="request-actions">${!["completed", "cancelled", "no_agreement"].includes(request.status) ? `<button class="button secondary" data-action="complete" data-id="${request.id}">تم الإصلاح</button><button class="button ghost" data-action="no_agreement" data-id="${request.id}">لم يتم الاتفاق</button>` : ""}${request.technician_id && ["completed", "no_agreement"].includes(request.status) ? `<button class="button ghost" data-action="rate" data-id="${request.id}">تقييم الفني</button>` : ""}</div></div>`;
}

function requestCardForTechnician(request) {
  const free = (profile.free_requests_used || 0) < FREE_REQUESTS;
  return requestBase(request) + `<div class="request-actions"><button class="button primary" data-action="claim" data-id="${request.id}">${free ? "فتح مجانًا" : `فتح الطلب · ${OPEN_FEE.toLocaleString()} ل.س`}</button></div></div>`;
}

function requestCardForOwnedTechnician(request) {
  const customer = requestContacts[request.id]?.customer;
  return requestBase(request) + `<p><strong>الزبون:</strong> ${customer ? `${escapeHtml(customer.full_name)} · ${escapeHtml(customer.phone || "لا يوجد رقم")}` : "تم فتح بيانات التواصل لهذا الطلب."}</p><div class="request-actions">${request.status === "contacted" ? `<button class="button secondary" data-action="scheduled" data-id="${request.id}">تحديد موعد</button>` : ""}${request.status === "scheduled" ? `<button class="button secondary" data-action="visited" data-id="${request.id}">تمت الزيارة</button>` : ""}${request.status === "visited" ? `<button class="button secondary" data-action="completed" data-id="${request.id}">تم الإصلاح</button>` : ""}${["completed", "no_agreement"].includes(request.status) ? `<button class="button ghost" data-action="rate" data-id="${request.id}">تقييم الزبون</button>` : ""}</div></div>`;
}

function requestCardForAdmin(request) {
  return requestBase(request) + `<p><strong>الزبون:</strong> ${escapeHtml(request.customer_id)} · <strong>الفني:</strong> ${escapeHtml(request.technician_id || "لم يتم التعيين")}</p></div>`;
}

function receiptCardForAdmin(receipt) {
  const receiptUrl = safeUrl(receipt.receipt_url || "");
  const technician = adminUsers.find(user => user.id === receipt.technician_id);
  return `<div class="request"><p><strong>${escapeHtml(technician?.full_name || "فني غير معروف")}</strong> · ${Number(receipt.amount).toLocaleString()} ل.س · ${escapeHtml(receiptStatusLabel(receipt.status))}</p><p class="hint">${formatDate(receipt.created_at)}</p>${receiptUrl ? `<a href="${escapeHtml(receiptUrl)}" target="_blank" rel="noopener">عرض الإيصال</a>` : ""}${receipt.status === "pending" ? `<div class="request-actions"><button class="button secondary" data-action="approve-receipt" data-id="${receipt.id}">اعتماد</button><button class="button ghost" data-action="reject-receipt" data-id="${receipt.id}">رفض</button></div>` : ""}</div>`;
}

async function uploadFile(bucket, file, folder) {
  if (!file) return null;
  if (file.size > 8 * 1024 * 1024) throw new Error("حجم الملف أكبر من 8 ميغابايت.");
  const safeName = file.name.replace(/[^\w.-]+/g, "-");
  const path = `${folder}/${Date.now()}-${safeName}`;
  const { error } = await db.storage.from(bucket).upload(path, file, { upsert: false });
  if (error) throw error;
  const { data } = db.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

async function createRequest(event) {
  event.preventDefault();
  try {
    const fileUrl = await uploadFile("request-images", $("imageFile").files[0], profile.id);
    const { error } = await db.from("service_requests").insert({
      customer_id: profile.id,
      service_type: $("serviceType").value,
      area: $("area").value.trim(),
      description: $("description").value.trim(),
      preferred_time: $("preferredTime").value,
      image_url: fileUrl || $("imageUrl").value.trim() || null
    });
    if (error) throw error;
    $("requestForm").reset();
    $("area").value = "جرمانا";
    $("requestFormCard").classList.add("hidden");
    showToast("تم نشر طلبك للفنيين المناسبين.");
    await refresh();
  } catch (error) { showError(error); }
}

async function technicianAction(action, requestId) {
  if (action === "claim") {
    const { error } = await db.rpc("claim_request", { p_request_id: requestId });
    if (error) return showError(error);
    showToast("تم فتح بيانات التواصل بنجاح.");
  } else if (action === "rate") {
    return rateRequest(requestId, "customer");
  } else {
    const { error } = await db.rpc("update_request_status", { p_request_id: requestId, p_status: action });
    if (error) return showError(error);
    showToast("تم تحديث حالة الطلب.");
  }
  await refresh();
}

async function customerAction(action, requestId) {
  if (action === "rate") return rateRequest(requestId, "technician");
  const status = action === "complete" ? "completed" : "no_agreement";
  const { error } = await db.rpc("update_request_status", { p_request_id: requestId, p_status: status });
  if (error) return showError(error);
  showToast("تم تسجيل ردك على الطلب.");
  await refresh();
}

async function rateRequest(requestId, role) {
  const value = window.prompt("قيّم الخدمة من 1 إلى 5:");
  if (!value || !/^[1-5]$/.test(value)) return;
  const comment = window.prompt("ملاحظة (اختياري):") || "";
  const { error } = await db.rpc("submit_rating", { p_request_id: requestId, p_score: Number(value), p_comment: comment });
  if (error) return showError(error);
  showToast(`شكرًا لتقييم ${role === "technician" ? "الفني" : "الزبون"}.`);
  await refresh();
}

async function submitTopUp(event) {
  event.preventDefault();
  try {
    const file = $("topUpReceipt").files[0];
    const receiptUrl = await uploadFile("topup-receipts", file, profile.id);
    const { error } = await db.from("topup_receipts").insert({ technician_id: profile.id, amount: Math.floor(Number($("topUpAmount").value)), receipt_url: receiptUrl });
    if (error) throw error;
    $("topUpForm").reset();
    $("topUpCard").classList.add("hidden");
    showToast("تم إرسال الإيصال للمراجعة.");
    await refresh();
  } catch (error) { showError(error); }
}

async function adminAction(action, receiptId) {
  const status = action === "approve-receipt" ? "approved" : "rejected";
  const { error } = await db.rpc("review_topup_receipt", { p_receipt_id: receiptId, p_status: status });
  if (error) return showError(error);
  showToast(status === "approved" ? "تم اعتماد الشحن." : "تم رفض الإيصال.");
  await refresh();
}

function showError(error) {
  console.error(error);
  showToast(error?.message || "حدث خطأ، حاول مرة أخرى.");
}

init();
