"use strict";

const CONFIG = window.ARA_CONFIG || {};
const LOCAL_KEY = "ara-food-map.data.v1";
const SESSION_KEY = "ara-food-map.session.v1";
const categories = ["한식", "중식", "일식", "분식", "양식", "기타", "카페"];
const payLabels = {yes: "사용 가능", no: "사용 불가", unknown: "미확인"};
const emptyData = () => ({places: [], base: null});
const clean = (value, length) => typeof value === "string" ? value.trim().slice(0, length) : "";
const normalize = value => value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const naverSearch = query => "https://map.naver.com/p/search/" + encodeURIComponent(query);
const supabaseReady = window.isSecureContext
  && /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(CONFIG.supabaseUrl || "")
  && /^sb_publishable_[A-Za-z0-9_-]+$/.test(CONFIG.supabasePublishableKey || "");

function coords(lat, lng) {
  if ((lat === "" || lat == null) && (lng === "" || lng == null)) return null;
  const numeric = value => ["string", "number"].includes(typeof value) && String(value).trim() !== "";
  if (!numeric(lat) || !numeric(lng) || !Number.isFinite(+lat) || !Number.isFinite(+lng)
    || Math.abs(+lat) > 90 || Math.abs(+lng) > 180) {
    throw new Error("위도와 경도를 모두 올바르게 입력해 주세요.");
  }
  return {lat: +lat, lng: +lng};
}

function safeLink(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port
      && ["map.naver.com", "naver.me", "place.naver.com", "m.place.naver.com", "pcmap.place.naver.com"].includes(url.hostname)) {
      return url.href;
    }
  } catch {}
  throw new Error("https로 시작하는 네이버지도 장소 링크를 입력해 주세요.");
}

function placeFields(raw) {
  const name = clean(raw.name, 120);
  if (!name) throw new Error("장소 이름을 입력해 주세요.");
  const point = coords(raw.lat, raw.lng);
  const price = raw.price === "" || raw.price == null ? null : Number(raw.price);
  if (price !== null && (!["string", "number"].includes(typeof raw.price)
    || !Number.isInteger(price) || price < 0 || price > 100000000)) {
    throw new Error("가격은 0원 이상의 정수로 입력해 주세요.");
  }
  const checked = clean(raw.checked, 10);
  if (checked && (!/^\d{4}-\d{2}-\d{2}$/.test(checked)
    || !Number.isFinite(Date.parse(checked)) || new Date(checked).toISOString().slice(0, 10) !== checked)) {
    throw new Error("탐나는전 확인일을 확인해 주세요.");
  }
  return {
    name, category: categories.includes(raw.category) ? raw.category : "기타",
    address: clean(raw.address, 240), link: safeLink(clean(raw.link, 1000)),
    lat: point?.lat ?? null, lng: point?.lng ?? null, menu: clean(raw.menu, 120), price,
    pay: Object.hasOwn(payLabels, raw.pay) ? raw.pay : "unknown",
    checked, source: clean(raw.source, 240), note: clean(raw.note, 600)
  };
}

function linkKey(link) {
  if (!link) return "";
  const url = new URL(link);
  const id = url.pathname.match(/\/(?:place|restaurant|cafe)\/(\d+)(?:\/|$)/)?.[1];
  if (id) return "place:" + id;
  // Search and folder URLs can legitimately refer to multiple places.
  if (url.hostname === "naver.me") return url.hostname + url.pathname.replace(/\/$/, "");
  return "";
}

function duplicate(a, b) {
  const key = linkKey(a.link);
  if (key && key === linkKey(b.link)) return true;
  if (normalize(a.name) !== normalize(b.name)) return false;
  if (a.address && b.address && normalize(a.address) === normalize(b.address)) return true;
  if (a.lat !== null && b.lat !== null) {
    return Math.abs(a.lat - b.lat) < .0001 && Math.abs(a.lng - b.lng) < .0001;
  }
  return !a.address || !b.address;
}

function cleanData(data) {
  if (!data || !Array.isArray(data.places) || data.places.length > 1000) {
    throw new Error("장소가 1,000개 이하인 아라동 밥지도 JSON이 필요합니다.");
  }
  const ids = new Set();
  const places = data.places.map(raw => {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !/^[a-z0-9-]{1,80}$/i.test(raw.id)
      || ids.has(raw.id) || !Number.isFinite(Date.parse(raw.created))
      || !Number.isSafeInteger(raw.visits) || raw.visits < 0) {
      throw new Error("백업 또는 저장 데이터의 장소 기록을 확인해 주세요.");
    }
    ids.add(raw.id);
    return {...placeFields(raw), id: raw.id, created: new Date(raw.created).toISOString(), visits: raw.visits};
  });
  return {places, base: data.base == null ? null : coords(data.base.lat, data.base.lng)};
}

function readLocal() {
  const raw = localStorage.getItem(LOCAL_KEY);
  if (!raw) return {version: 0, data: emptyData()};
  const record = JSON.parse(raw);
  if (!Number.isSafeInteger(record.version) || record.version < 0) throw new Error("이 기기의 저장 기록을 읽을 수 없습니다.");
  return {version: record.version, data: cleanData(record.data)};
}

let session = null;
let refreshPromise = null;
class Conflict extends Error {
  constructor() { super("다른 화면에서 목록이 바뀌었습니다. 최신 목록을 불러왔으니 확인 후 다시 저장해 주세요."); }
}
class SessionExpired extends Error {}

function setSession(value) {
  session = value;
  if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else sessionStorage.removeItem(SESSION_KEY);
}

function restoreSession() {
  if (!supabaseReady) return;
  try {
    const cached = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (cached?.project === CONFIG.supabaseUrl && cached.refresh_token && cached.access_token) session = cached;
  } catch {}
}

async function cloudRequest(path, body, token) {
  let response;
  try {
    response = await fetch(CONFIG.supabaseUrl.replace(/\/$/, "") + path, {
      method: "POST",
      headers: {"Content-Type": "application/json", apikey: CONFIG.supabasePublishableKey,
        ...(token ? {Authorization: "Bearer " + token} : {})},
      body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(12000)
    });
  } catch {
    throw new Error("공유 서버에 연결할 수 없습니다. 연결을 확인한 후 새로고침해 주세요.");
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    if (path.includes("grant_type=password")) throw new Error("로그인할 수 없습니다. 이메일과 비밀번호를 확인해 주세요.");
    if (path.includes("grant_type=refresh_token") && [400, 401, 403].includes(response.status)) {
      throw new SessionExpired("로그인 시간이 지났습니다. 다시 로그인해 주세요.");
    }
    if (result?.code === "42501") throw new Error("공유 목록 접근 권한이 없습니다. 관리자가 계정을 등록해야 합니다.");
    if (response.status === 401) throw new SessionExpired("로그인 시간이 지났습니다. 다시 로그인해 주세요.");
    throw new Error("공유 서버 요청을 처리할 수 없습니다. 설정이나 네트워크를 확인해 주세요.");
  }
  return result;
}

function rememberAuth(auth) {
  if (!auth?.access_token || !auth.refresh_token) throw new Error("로그인 응답을 확인할 수 없습니다.");
  setSession({project: CONFIG.supabaseUrl, access_token: auth.access_token,
    refresh_token: auth.refresh_token, expires: Date.now() + auth.expires_in * 1000,
    email: auth.user?.email || session?.email || ""});
}

async function signIn(email, password) {
  rememberAuth(await cloudRequest("/auth/v1/token?grant_type=password", {email, password}));
}

async function token() {
  if (!session) throw new SessionExpired("공유 목록에 로그인해 주세요.");
  if (session.expires > Date.now() + 30000) return session.access_token;
  if (!refreshPromise) {
    const current = session;
    refreshPromise = cloudRequest("/auth/v1/token?grant_type=refresh_token", {refresh_token: current.refresh_token})
      .then(auth => {
        if (session !== current) throw new SessionExpired("공유 목록에 다시 로그인해 주세요.");
        rememberAuth(auth);
      }).finally(() => { refreshPromise = null; });
  }
  await refreshPromise;
  return session.access_token;
}

async function readShared() {
  const result = await cloudRequest("/rest/v1/rpc/ara_read", {}, await token());
  if (!Number.isSafeInteger(result?.version) || result.version < 0) throw new Error("공유 목록 설정을 확인해 주세요.");
  return {version: result.version, data: cleanData(result.data)};
}

async function writeData(shared, version, data) {
  data = cleanData(data);
  if (shared) {
    const next = await cloudRequest("/rest/v1/rpc/ara_write", {expected: version, payload: data}, await token());
    if (next === null) throw new Conflict();
    if (next !== version + 1) throw new Error("저장 결과를 확인할 수 없습니다. 공유 목록을 새로고침해 주세요.");
    return {version: next, data};
  }
  const save = () => {
    if (readLocal().version !== version) throw new Conflict();
    const result = {version: version + 1, data};
    localStorage.setItem(LOCAL_KEY, JSON.stringify(result));
    return result;
  };
  return navigator.locks ? navigator.locks.request(LOCAL_KEY, save) : save();
}
