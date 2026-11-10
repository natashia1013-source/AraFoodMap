"use strict";

const $ = id => document.getElementById(id);
const placeForm = $("place-form");
const settings = $("settings-dialog");
const baseForm = $("base-form");
const mapForm = $("map-form");
const detail = $("detail-dialog");
const placeDialog = $("place-dialog");
const keyStorage = "ara-food-map.maps-id.v1";
const araCenter = {lat: 33.473, lng: 126.546};
const baseName = "더딩글 아라 부티크 스터디카페";
const number = new Intl.NumberFormat("ko-KR");
const date = new Intl.DateTimeFormat("ko-KR", {dateStyle: "medium", timeZone: "Asia/Seoul"});
const categoryOrderKey = "ara-food-map.category-order.v1";
let categoryOrder = [...categories];
try {
  const savedOrder = JSON.parse(localStorage.getItem(categoryOrderKey) || "null");
  if (Array.isArray(savedOrder)) {
    categoryOrder = [...new Set(savedOrder.filter(name => categories.includes(name))), ...categories.filter(name => !savedOrder.includes(name))];
  }
} catch {}
let board = {version: 0, data: emptyData()};
let mode = "local";
let ready = false;
let busy = false;
let refreshing = false;
let originalBase = null;
let category = "전체";
let selected = null;
let editing = null;
let original = null;
let picking = null;
let map = null;
let mapState = "idle";
const markers = new Map();
let mapFocus = null;
let mapPlaceId = null;
let menuHiddenBeforeBanner = null;
let focusedPlaceId = null;
let lastSize = "";
let lastPadding = "";
let noticeTimer;
let stopFlash = null;
let mapKey = CONFIG.mapsClientId || "";
try {
  const storedKey = localStorage.getItem(keyStorage);
  if (storedKey !== null) mapKey = storedKey;
} catch {}
if (!/^[a-z0-9_-]{1,64}$/i.test(mapKey)) mapKey = "";

function message(id, value) {
  const element = $(id);
  element.textContent = value;
  element.hidden = !value;
}
function notify(value) {
  clearTimeout(noticeTimer);
  message("notice", value);
  noticeTimer = setTimeout(() => message("notice", ""), 5500);
}
function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value != null) node.textContent = value;
  if (className) node.className = className;
  return node;
}
const foodIcons = [
    [/맘스터치|버거/u, "burger"], [/치킨|^KFC\b|닭갈비/iu, "chicken"],
    [/리릭|백소정|돈가스|돈까스|카츠/u, "cutlet"],
    [/짬뽕|칼국수|^면아라|마라공방|파스타/u, "noodles"],
    [/찌개|순두부|삼계|샤브/u, "soup"], [/김밥/u, "roll"],
    [/^CU\b|편의점/u, "shop"], [/파리바게뜨|베이커리|빵집/u, "bread"],
    [/에그라니|에그토스트/u, "egg"], [/아일랜드보울|샐러드/u, "salad"],
    [/모닥치기|떡볶이/u, "skewer"]
];
const categoryIcons = {한식: "soup", 중식: "noodles", 분식: "roll", 카페: "coffee"};
function foodIcon(place) {
  const dish = place.name + " " + place.menu;
  const type = foodIcons.find(([pattern]) => pattern.test(dish))?.[1] || categoryIcons[place.category] || "meal";
  const namespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(namespace, "svg");
  icon.setAttribute("class", "icon");
  icon.setAttribute("aria-hidden", "true");
  const symbol = document.createElementNS(namespace, "use");
  symbol.setAttribute("href", "#icon-" + type);
  icon.append(symbol);
  return icon;
}
function link(label, url) {
  const anchor = element("a", label);
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
}
function openSearch(query) {
  window.open(naverSearch(query.trim() || "제주 아라동 음식점"), "_blank", "noopener,noreferrer");
}
function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}
function distance(place) {
  const base = board.data.base;
  if (!base || place.lat === null) return Infinity;
  const rad = Math.PI / 180;
  const a = Math.sin((place.lat - base.lat) * rad / 2) ** 2
    + Math.cos(base.lat * rad) * Math.cos(place.lat * rad) * Math.sin((place.lng - base.lng) * rad / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
function distanceLabel(place) {
  const meters = distance(place);
  if (!Number.isFinite(meters)) return "직선거리 미설정";
  return "직선 " + (meters < 1000 ? Math.round(meters) + " m" : (meters / 1000).toFixed(2) + " km");
}
function filtered() {
  const query = normalize($("search").value);
  const byVisits = $("sort").value === "visits";
  return board.data.places
    .filter(place => (category === "전체" || place.category === category)
      && [place.name, shortPlaceName(place.name), place.address, place.menu].some(field => normalize(field).includes(query)))
    .sort((a, b) => {
      const newest = Date.parse(b.created) - Date.parse(a.created);
      const nearest = distance(a) - distance(b);
      return byVisits ? b.visits - a.visits || nearest || newest : newest || nearest;
    });
}

for (const name of ["전체", ...categoryOrder]) {
  const button = element("button", name);
  button.dataset.category = name;
  button.setAttribute("aria-pressed", String(name === category));
  button.addEventListener("click", () => {
    if (suppressCategoryClick) {
      suppressCategoryClick = false;
      return;
    }
    category = name;
    for (const chip of $("categories").children) chip.setAttribute("aria-pressed", String(chip === button));
    renderList();
  });
  $("categories").append(button);
}
let categoryPress = null;
let categoryPressTimer = null;
let categoryDrag = null;
let suppressCategoryClick = false;
function saveCategoryOrder() {
  categoryOrder = [...$("categories").querySelectorAll("button[data-category]")]
    .map(button => button.dataset.category).filter(name => name !== "전체");
  try {
    localStorage.setItem(categoryOrderKey, JSON.stringify(categoryOrder));
  } catch {
    notify("카테고리 순서를 이 브라우저에 저장하지 못했어요.");
  }
  updateCategoryFade();
}
function stopCategoryPress() {
  clearTimeout(categoryPressTimer);
  categoryPressTimer = null;
  categoryPress = null;
}
function beginCategoryDrag() {
  if (!categoryPress) return;
  const {button, pointerId} = categoryPress;
  const rect = button.getBoundingClientRect();
  const ghost = button.cloneNode(true);
  ghost.classList.add("category-drag-ghost");
  Object.assign(ghost.style, {width: rect.width + "px", height: rect.height + "px", left: rect.left + "px", top: rect.top + "px"});
  document.body.append(ghost);
  categoryDrag = {button, pointerId, ghost};
  button.classList.add("is-dragging");
  $("categories-wrap").classList.add("is-reordering");
  suppressCategoryClick = true;
  try { button.setPointerCapture(pointerId); } catch {}
}
function moveCategoryDrag(event) {
  if (categoryPress && event.pointerId === categoryPress.pointerId && !categoryDrag) {
    if (Math.hypot(event.clientX - categoryPress.x, event.clientY - categoryPress.y) > 12) stopCategoryPress();
    return;
  }
  if (!categoryDrag || event.pointerId !== categoryDrag.pointerId) return;
  event.preventDefault();
  const {button, ghost} = categoryDrag;
  ghost.style.left = event.clientX - ghost.offsetWidth / 2 + "px";
  ghost.style.top = event.clientY - ghost.offsetHeight / 2 + "px";
  const tabs = $("categories");
  const bounds = tabs.getBoundingClientRect();
  if (event.clientX < bounds.left + 26) tabs.scrollLeft -= 12;
  else if (event.clientX > bounds.right - 26) tabs.scrollLeft += 12;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("#categories button[data-category]");
  if (!target || target === button || target.dataset.category === "전체") return;
  const rect = target.getBoundingClientRect();
  if (event.clientX < rect.left + rect.width / 2) {
    if (button.nextElementSibling !== target) tabs.insertBefore(button, target);
  } else if (target.nextElementSibling !== button) {
    tabs.insertBefore(button, target.nextElementSibling);
  }
}
function finishCategoryDrag(event) {
  if (categoryPress && event.pointerId === categoryPress.pointerId && !categoryDrag) {
    stopCategoryPress();
    return;
  }
  if (!categoryDrag || event.pointerId !== categoryDrag.pointerId) return;
  const {button, ghost, pointerId} = categoryDrag;
  button.classList.remove("is-dragging");
  $("categories-wrap").classList.remove("is-reordering");
  ghost.remove();
  try { if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId); } catch {}
  categoryDrag = null;
  stopCategoryPress();
  saveCategoryOrder();
  setTimeout(() => { suppressCategoryClick = false; }, 0);
}
$("categories").addEventListener("pointerdown", event => {
  const button = event.target.closest("button[data-category]");
  if (!button || button.dataset.category === "전체" || event.button !== 0) return;
  stopCategoryPress();
  categoryPress = {button, pointerId: event.pointerId, x: event.clientX, y: event.clientY};
  categoryPressTimer = setTimeout(beginCategoryDrag, 2000);
});
document.addEventListener("pointermove", moveCategoryDrag, {passive: false});
document.addEventListener("pointerup", finishCategoryDrag);
document.addEventListener("pointercancel", finishCategoryDrag);
$("categories").addEventListener("keydown", event => {
  if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const button = event.target.closest("button[data-category]");
  if (!button || button.dataset.category === "전체") return;
  const previous = button.previousElementSibling;
  const next = button.nextElementSibling;
  if (event.key === "ArrowLeft" && previous && previous.dataset.category !== "전체") $("categories").insertBefore(button, previous);
  else if (event.key === "ArrowRight" && next) $("categories").insertBefore(next, button);
  saveCategoryOrder();
  event.preventDefault();
});
function updateCategoryFade() {
  const tabs = $("categories");
  const hasMore = tabs.scrollWidth > tabs.clientWidth + 1 && tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1;
  $("categories-wrap").classList.toggle("has-more", hasMore);
}
$("categories").addEventListener("scroll", updateCategoryFade, {passive: true});
window.addEventListener("resize", updateCategoryFade);
requestAnimationFrame(updateCategoryFade);
let placePress = null;
let placeDrag = null;
let suppressPlaceClick = false;
function beginPlaceDrag() {
  if (!placePress) return;
  const {card, placeId, pointerId} = placePress;
  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add("place-drag-ghost");
  Object.assign(ghost.style, {width: rect.width + "px", height: rect.height + "px", left: rect.left + "px", top: rect.top + "px"});
  document.body.append(ghost);
  placeDrag = {card, placeId, pointerId, ghost, target: null};
  card.classList.add("is-dragging");
  suppressPlaceClick = true;
  try { card.setPointerCapture(pointerId); } catch {}
}
function movePlaceDrag(event) {
  if (placePress && event.pointerId === placePress.pointerId && !placeDrag) {
    if (Math.hypot(event.clientX - placePress.x, event.clientY - placePress.y) > 12) {
      clearTimeout(placePress.timer); placePress = null;
    }
    return;
  }
  if (!placeDrag || event.pointerId !== placeDrag.pointerId) return;
  event.preventDefault();
  placeDrag.ghost.style.left = event.clientX - placeDrag.ghost.offsetWidth / 2 + "px";
  placeDrag.ghost.style.top = event.clientY - placeDrag.ghost.offsetHeight / 2 + "px";
  document.querySelectorAll("#categories button.is-drop-target").forEach(button => button.classList.remove("is-drop-target"));
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("#categories button[data-category]");
  if (target && target.dataset.category !== "전체") {
    target.classList.add("is-drop-target");
    placeDrag.target = target.dataset.category;
  } else placeDrag.target = null;
}
async function finishPlaceDrag(event) {
  if (placePress && event.pointerId === placePress.pointerId && !placeDrag) {
    clearTimeout(placePress.timer); placePress = null; return;
  }
  if (!placeDrag || event.pointerId !== placeDrag.pointerId) return;
  const {card, placeId, ghost, target, pointerId} = placeDrag;
  card.classList.remove("is-dragging"); ghost.remove();
  document.querySelectorAll("#categories button.is-drop-target").forEach(button => button.classList.remove("is-drop-target"));
  try { if (card.hasPointerCapture(pointerId)) card.releasePointerCapture(pointerId); } catch {}
  placeDrag = null; placePress = null;
  if (target) {
    await change(data => ({...data, places: data.places.map(place => place.id === placeId ? {...place, category: target} : place)}));
    notify("카테고리를 변경했습니다.");
  }
  setTimeout(() => { suppressPlaceClick = false; }, 0);
}
$("places").addEventListener("pointerdown", event => {
  const card = event.target.closest(".place-card");
  if (!card || event.button !== 0) return;
  clearTimeout(placePress?.timer);
  placePress = {card, placeId: card.dataset.placeId, pointerId: event.pointerId, x: event.clientX, y: event.clientY};
  placePress.timer = setTimeout(beginPlaceDrag, 2000);
});
$("places").addEventListener("click", event => {
  if (!suppressPlaceClick) return;
  event.preventDefault(); event.stopPropagation(); suppressPlaceClick = false;
}, true);
document.addEventListener("pointermove", movePlaceDrag, {passive: false});
document.addEventListener("pointerup", finishPlaceDrag);
document.addEventListener("pointercancel", finishPlaceDrag);
for (const name of categories) {
  const option = element("option", name);
  option.value = name;
  $("place-category").append(option);
}

function renderList() {
  const totals = new Map(categories.map(name => [name, 0]));
  for (const place of board.data.places) totals.set(place.category, totals.get(place.category) + 1);
  totals.set("전체", board.data.places.length);
  for (const chip of $("categories").children) {
    const name = chip.dataset.category;
    chip.textContent = name + "(" + totals.get(name) + ")";
  }
  const rows = filtered();
  if (focusedPlaceId && !rows.some(place => place.id === focusedPlaceId)) {
    focusedPlaceId = null;
    mapFocus = null;
  }
  const list = $("places");
  list.replaceChildren();
  if (!rows.length) {
    const empty = element("div", null, "empty");
    const title = !ready ? "목록을 불러올 수 없어요" : board.data.places.length ? "검색 조건과 맞는 장소가 없어요" : "아직 저장한 장소가 없어요";
    empty.append(element("h3", title));
    if (ready && !board.data.places.length) {
      empty.append(element("p", "자주 가는 식당이나 가 보고 싶은 카페를 추가해 보세요."));
      const add = element("button", "첫 장소 추가");
      add.onclick = () => openPlace();
      empty.append(add);
    }
    list.append(empty);
  }
  for (const place of rows) {
    const row = element("div", null, "place-row");
    const card = element("button", null, "place-card");
    card.dataset.placeId = place.id;
    if (place.id === focusedPlaceId) card.setAttribute("aria-current", "true");
    const name = shortPlaceName(place.name);
    const label = element("span", null, "place-name");
    label.append(foodIcon(place), element("strong", name));
    card.append(label);
    const desc = [place.menu, place.price === null ? "" : number.format(place.price) + "원"].filter(Boolean).join(" · ");
    if (desc) card.append(element("span", desc, "place-description"));
    const meta = element("span", null, "card-meta");
    for (const label of [place.category, "방문 " + place.visits + "회", distanceLabel(place), "탐나는전 " + payLabels[place.pay]]) {
      meta.append(element("span", label));
    }
    card.append(meta);
    const canFocus = place.lat !== null && mapKey && mapState !== "failed" && location.protocol !== "file:";
    card.onclick = () => {
      if (picking) return;
      if (canFocus && mapState !== "failed") {
        if (focusedPlaceId === place.id && mapPlaceId === place.id) renderMapBanner(null);
        else showPlaceOnMap(place, focusedPlaceId === place.id);
      }
      else showDetail(place.id);
    };
    row.append(card);
    if (canFocus) {
      const info = element("button", null, "place-info quiet");
      const infoIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      infoIcon.setAttribute("class", "icon");
      infoIcon.setAttribute("aria-hidden", "true");
      const infoUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
      infoUse.setAttribute("href", "#icon-info");
      infoIcon.append(infoUse);
      info.append(infoIcon);
      info.setAttribute("aria-label", name + " 상세");
      info.title = "상세 보기";
      info.onclick = () => {
        if (!picking) showDetail(place.id);
      };
      row.append(info);
    }
    list.append(row);
  }
  drawMarkers(rows.filter(place => place.lat !== null));
  if (mapPlaceId) renderMapBanner(rows.find(place => place.id === mapPlaceId));
}

function closeSortOptions() {
  const options = $("sort-options");
  options.hidden = true;
  $("sort-menu").classList.remove("is-open");
  $("sort-trigger").setAttribute("aria-expanded", "false");
}
$("sort-trigger").onclick = () => {
  const options = $("sort-options");
  const open = options.hidden;
  options.hidden = !open;
  $("sort-menu").classList.toggle("is-open", open);
  $("sort-trigger").setAttribute("aria-expanded", String(open));
};
$("sort-options").addEventListener("click", event => {
  const option = event.target.closest("[data-sort]");
  if (!option || option.disabled) return;
  $("sort").value = option.dataset.sort;
  $("sort-label").textContent = option.textContent;
  for (const item of $("sort-options").querySelectorAll('[role="option"]')) {
    item.setAttribute("aria-selected", String(item === option));
  }
  closeSortOptions();
  renderList();
  $("sort-trigger").focus();
});
document.addEventListener("pointerdown", event => {
  if (!$("sort-menu").contains(event.target)) closeSortOptions();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("sort-options").hidden) {
    closeSortOptions();
    $("sort-trigger").focus();
  }
});

function renderAccount() {
  $("account").textContent = mode === "shared" ? session.email + " · 승인된 공유 목록"
    : mode === "pending" ? "공유 목록을 열려면 다시 로그인하거나 새로고침하세요."
    : supabaseReady ? "로그인하면 친구와 같은 목록을 사용할 수 있어요." : "공유를 사용하려면 Supabase 설정이 필요합니다.";
  $("login-form").hidden = !supabaseReady || mode === "shared";
  $("logout").hidden = !session;
  $("sync").hidden = mode === "local";
  $("add").disabled = !ready;
  $("export").disabled = !ready;
  $("import").disabled = !ready;
  baseForm.querySelector('[type="submit"]').disabled = !ready;
  $("pick-base").disabled = !ready;
}

function render() {
  renderAccount();
  renderList();
  if (detail.open) renderDetail();
}

function activePlace() {
  return board.data.places.find(place => place.id === selected);
}

function showDetail(id) {
  renderMapBanner();
  selected = id;
  renderDetail();
  if (activePlace()) openDialog(detail);
}

function renderDetail() {
  const place = activePlace();
  if (!place) {
    detail.close();
    return;
  }
  $("detail-title").textContent = place.name;
  const values = [
    ["카테고리", place.category], ["주소", place.address], ["스터디카페", distanceLabel(place)],
    ["대표 메뉴", place.menu], ["가격", place.price === null ? "" : number.format(place.price) + "원"],
    ["탐나는전", payLabels[place.pay]], ["확인 출처", place.source], ["확인일", place.checked],
    ["등록일", date.format(new Date(place.created))], ["방문", place.visits + "회"], ["메모", place.note]
  ];
  const dl = element("dl");
  for (const [label, value] of values) dl.append(element("dt", label), element("dd", value || "—"));
  const actions = element("div", null, "form-tools");
  actions.append(naverPlaceLink(place));
  $("detail-body").replaceChildren(dl, actions);
  $("undo").disabled = !place.visits;
}

function naverPlaceLink(place) {
  const url = place.link || naverSearch([place.name, place.address || "제주 아라동"].join(" "));
  return link(linkKey(url) ? "네이버지도 상세 ↗" : "네이버지도에서 검색 ↗", url);
}

function renderMapBanner(place) {
  const banner = $("map-place-banner");
  const frameSlot = $("map-place-frame");
  const wasOpen = !banner.hidden;
  const restoreMenu = !place && wasOpen ? menuHiddenBeforeBanner : null;
  if (banner.hidden === Boolean(place)) requestAnimationFrame(updateMap);
  banner.hidden = !place;
  mapPlaceId = place?.id ?? null;
  if (restoreMenu !== null) {
    menuHiddenBeforeBanner = null;
    if (window.matchMedia("(max-width: 720px)").matches) setMenuPanelHidden(restoreMenu);
  }
  if (!place) {
    frameSlot.replaceChildren();
    return;
  }

  const placeId = linkKey(place.link).match(/^place:(\d+)$/)?.[1];
  const url = placeId ? "https://pcmap.place.naver.com/place/" + placeId + "/home" : "";
  banner.setAttribute("aria-label", place.name + " 상세");
  banner.classList.toggle("has-place-frame", Boolean(url));
  if (url) {
    // Reload the Place panel on every open. Naver's cross-origin iframe cannot
    // be scrolled from this page, and reusing it can preserve a previous scroll
    // position when the same store is selected again.
    const frame = element("iframe");
    frame.title = place.name + " 네이버 플레이스";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
    frame.src = url;
    frameSlot.replaceChildren(frame);
    banner.scrollTop = 0;
    frameSlot.scrollTop = 0;
    return;
  }
  frameSlot.replaceChildren();
  $("map-place-title").textContent = shortPlaceName(place.name);
  const summary = element("p", [place.category, distanceLabel(place), "방문 " + place.visits + "회"].join(" · "), "map-place-meta");
  const address = element("p", place.address || "주소 미등록", "map-place-address");
  const payment = element("p", "탐나는전 " + payLabels[place.pay], "map-place-pay");
  const body = $("map-place-body");
  body.replaceChildren(summary, address, payment);
  if (place.menu || place.price !== null) {
    const price = place.price === null ? "" : number.format(place.price) + "원";
    body.append(element("p", [place.menu, price].filter(Boolean).join(" · ")));
  }

  $("map-place-actions").replaceChildren(naverPlaceLink(place));
  banner.scrollTop = 0;
}

function openPlace(place = null) {
  if (!ready || busy) return;
  editing = place?.id ?? null;
  original = place ? JSON.stringify(place) : null;
  placeForm.reset();
  for (const [key, value] of Object.entries(place || {category: category === "전체" ? "기타" : category})) {
    const input = placeForm.elements.namedItem(key);
    if (input) input.value = value ?? "";
  }
  $("place-title").textContent = place ? "장소 수정" : "장소 추가";
  message("place-error", "");
  openDialog(placeDialog);
}

function populateBase() {
  originalBase = JSON.stringify(board.data.base);
  baseForm.elements.lat.value = board.data.base?.lat ?? "";
  baseForm.elements.lng.value = board.data.base?.lng ?? "";
}
function openSettings() {
  mapForm.elements.key.value = mapKey;
  populateBase();
  renderAccount();
  message("settings-error", "");
  openDialog(settings);
}

async function reloadBoard() {
  if (mode === "local") {
    board = readLocal();
  } else {
    board = await readShared();
    mode = "shared";
  }
  ready = true;
}

function handleError(error, errorId) {
  if (error instanceof SessionExpired) {
    setSession(null);
    mode = "pending";
    ready = false;
    board = {version: 0, data: emptyData()};
    placeDialog.close();
    if (picking) finishPick();
    openSettings();
    message("settings-error", error.message);
  } else if (errorId) {
    message(errorId, error.message);
  } else {
    notify(error.message);
  }
  render();
}

async function run(work, errorId) {
  if (busy) return false;
  busy = true;
  if (errorId) message(errorId, "");
  try {
    await work();
    render();
    return true;
  } catch (error) {
    if (error instanceof Conflict) {
      try { await reloadBoard(); } catch (readError) { error = readError; }
    }
    handleError(error, errorId);
    return false;
  } finally {
    busy = false;
  }
}

async function change(makeData, errorId) {
  if (!ready) return false;
  return run(async () => {
    const data = makeData(board.data);
    board = await writeData(mode === "shared", board.version, data);
  }, errorId);
}

placeForm.addEventListener("submit", async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(placeForm));
  const saved = await change(data => {
    const fields = placeFields(values);
    const prior = data.places.find(place => place.id === editing);
    if (editing && (!prior || JSON.stringify(prior) !== original)) {
      throw new Error("이 장소가 다른 화면에서 변경되었습니다. 창을 닫고 최신 상세에서 다시 수정해 주세요.");
    }
    if (data.places.some(place => place.id !== editing && duplicate(place, fields))) {
      throw new Error("같은 장소가 이미 저장되어 있습니다.");
    }
    const place = {...fields, id: prior?.id ?? newId(), created: prior?.created ?? new Date().toISOString(), visits: prior?.visits ?? 0};
    return {...data, places: prior ? data.places.map(row => row.id === editing ? place : row) : [...data.places, place]};
  }, "place-error");
  if (saved) {
    placeDialog.close();
    notify("장소를 저장했습니다.");
  }
});

function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("");
}

async function visit(delta) {
  const id = selected;
  if (await change(data => ({
    ...data, places: data.places.map(place => place.id === id ? {...place, visits: Math.max(0, place.visits + delta)} : place)
  }))) notify(delta > 0 ? "방문을 기록했습니다." : "방문 1회를 취소했습니다.");
}
$("visit").onclick = () => visit(1);
$("undo").onclick = () => visit(-1);
$("edit").onclick = () => {
  const place = activePlace();
  if (!place || busy) return;
  detail.close();
  openPlace(place);
};
$("remove").onclick = async () => {
  const place = activePlace();
  if (!place || busy || !window.confirm(place.name + " 장소를 삭제할까요?")) return;
  if (await change(data => {
    const current = data.places.find(row => row.id === place.id);
    if (current !== place) throw new Error("최신 장소 정보를 확인한 뒤 삭제해 주세요.");
    return {...data, places: data.places.filter(row => row.id !== place.id)};
  })) notify("장소를 삭제했습니다.");
};

$("settings").onclick = openSettings;
$("add").onclick = () => openPlace();
$("search").oninput = renderList;
$("sort").onchange = renderList;
$("lookup-place").onclick = () => openSearch("제주 아라동 " + placeForm.elements.name.value);
for (const button of document.querySelectorAll("[data-close]")) button.onclick = () => $(button.dataset.close).close();
for (const form of [placeForm, baseForm, $("login-form")]) form.addEventListener("keydown", event => {
  if (busy && event.key === "Enter") event.preventDefault();
});

baseForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (await change(data => {
    if (JSON.stringify(data.base) !== originalBase) {
      populateBase();
      throw new Error("기준점이 다른 화면에서 변경되었습니다. 최신 좌표를 확인한 뒤 다시 저장해 주세요.");
    }
    return {...data, base: coords(baseForm.elements.lat.value, baseForm.elements.lng.value)};
  }, "settings-error")) {
    populateBase();
    if (map && board.data.base) map.setCenter(latLng(board.data.base));
    notify("직선거리 기준점을 저장했습니다.");
  }
});

$("login-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = event.currentTarget;
  run(async () => {
    try { await signIn(form.elements.email.value.trim(), form.elements.password.value); }
    finally { form.elements.password.value = ""; }
    mode = "pending";
    ready = false;
    board = {version: 0, data: emptyData()};
    await reloadBoard();
    populateBase();
    settings.close();
    notify("공유 목록에 연결했습니다.");
  }, "settings-error");
});
$("logout").onclick = () => run(async () => {
  const previous = session?.access_token;
  setSession(null);
  mode = "local";
  ready = false;
  board = {version: 0, data: emptyData()};
  await reloadBoard();
  populateBase();
  if (previous) {
    fetch(CONFIG.supabaseUrl.replace(/\/$/, "") + "/auth/v1/logout?scope=local", {
      method: "POST", headers: {apikey: CONFIG.supabasePublishableKey, Authorization: "Bearer " + previous}
    }).catch(() => {});
  }
}, "settings-error");
$("sync").onclick = () => run(async () => {
  await reloadBoard();
  notify("공유 목록을 새로고침했습니다.");
});
window.addEventListener("storage", event => {
  if (event.key === LOCAL_KEY && mode === "local") run(reloadBoard);
});
async function refreshInBackground() {
  if (busy || refreshing || mode !== "shared") return;
  refreshing = true;
  const previous = board;
  const isCurrent = () => !busy && mode === "shared" && board === previous;
  try {
    const current = await readShared();
    if (isCurrent() && current.version > previous.version) {
      board = current;
      render();
    }
  } catch (error) {
    if (isCurrent() && error instanceof SessionExpired) handleError(error);
  } finally {
    refreshing = false;
  }
}
window.addEventListener("focus", refreshInBackground);
setInterval(() => {
  if (document.visibilityState === "visible") refreshInBackground();
}, 20000);

$("export").onclick = () => {
  const payload = JSON.stringify({format: "ara-food-map", version: 1, ...board.data}, null, 2);
  const url = URL.createObjectURL(new Blob([payload], {type: "application/json"}));
  const anchor = element("a");
  anchor.href = url;
  anchor.download = "ara-food-map-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
$("import").onclick = () => $("backup-file").click();
$("backup-file").onchange = async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  let added = 0;
  let skipped = 0;
  try {
    if (file.size > 3000000) throw new Error("3 MB 이하의 JSON 백업을 선택해 주세요.");
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch { throw new Error("JSON 백업을 읽을 수 없습니다."); }
    if (parsed?.format !== "ara-food-map" || parsed.version !== 1) throw new Error("아라동 밥지도 버전 1 백업을 선택해 주세요.");
    const imported = cleanData(parsed);
    if (await change(data => {
      const places = [...data.places];
      for (const place of imported.places) {
        if (places.some(row => row.id === place.id || duplicate(row, place))) skipped++;
        else { places.push(place); added++; }
      }
      return {places, base: data.base ?? imported.base};
    }, "settings-error")) {
      populateBase();
      settings.close();
      notify(added + "곳 추가 · 중복 " + skipped + "곳 건너뜀");
    }
  } catch (error) {
    message("settings-error", error.message);
  }
};

function setView(view) {
  if (view === "list" && picking) finishPick();
  if (view === "list") renderMapBanner();
  const mobile = window.matchMedia("(max-width: 720px)").matches;
  $("layout").dataset.view = mobile ? "map" : view;
  if (view === "map" || mobile) requestAnimationFrame(updateMap);
}
function setMenuPanelHidden(hidden) {
  const layout = $("layout");
  const handle = $("menu-panel-handle");
  layout.classList.toggle("menu-hidden", hidden);
  handle.setAttribute("aria-expanded", String(!hidden));
  handle.setAttribute("aria-label", hidden ? "저장 목록 보이기" : "저장 목록 숨기기");
  handle.title = hidden ? "위로 끌어서 저장 목록 열기" : "아래로 끌어서 저장 목록 숨기기";
  requestAnimationFrame(updateMap);
}
let panelPointerStart = null;
let suppressPanelClick = false;
$("menu-panel-handle").addEventListener("pointerdown", event => {
  const mobile = window.matchMedia("(max-width: 720px)").matches;
  const hidden = $("layout").classList.contains("menu-hidden");
  const rect = $("list-panel").getBoundingClientRect();
  panelPointerStart = {x: event.clientX, y: event.clientY, hidden, mobile, width: rect.width, height: rect.height, currentHeight: rect.height, pointerId: event.pointerId};
  suppressPanelClick = false;
  if (mobile) event.preventDefault();
  $("layout").classList.add("panel-dragging");
  $("layout").style.setProperty(mobile ? "--mobile-list-height" : "--panel-drag-offset", mobile ? `${rect.height}px` : "0px");
  $("menu-panel-handle").setPointerCapture(event.pointerId);
});
$("menu-panel-handle").addEventListener("pointermove", event => {
  if (!panelPointerStart || event.pointerId !== panelPointerStart.pointerId) return;
  if (panelPointerStart.mobile) {
    const delta = event.clientY - panelPointerStart.y;
    const maxHeight = Math.max(180, window.innerHeight - 160 - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-area-inset-bottom")) || 0));
    const defaultHeight = Math.min(maxHeight, Math.round(window.innerHeight * .54));
    const height = panelPointerStart.hidden && delta < -32
      ? Math.max(defaultHeight, Math.min(maxHeight, panelPointerStart.height - delta))
      : Math.max(26, Math.min(maxHeight, panelPointerStart.height - delta));
    panelPointerStart.currentHeight = height;
    $("layout").style.setProperty("--mobile-list-height", `${height}px`);
    $("layout").classList.toggle("panel-dragging", panelPointerStart.hidden && delta < -32 && height > 100);
    requestAnimationFrame(updateMap);
    return;
  }
  const delta = event.clientX - panelPointerStart.x;
  const maxOffset = Math.max(0, panelPointerStart.width - 28);
  const offset = panelPointerStart.hidden ? Math.max(0, Math.min(maxOffset, delta)) : Math.min(0, Math.max(-maxOffset, delta));
  $("layout").style.setProperty("--panel-drag-offset", offset + "px");
  requestAnimationFrame(updateMap);
});
$("menu-panel-handle").addEventListener("pointerup", event => {
  if (!panelPointerStart || event.pointerId !== panelPointerStart.pointerId) return;
  if (panelPointerStart.mobile) {
    const delta = event.clientY - panelPointerStart.y;
    const maxHeight = Math.max(180, window.innerHeight - 160);
    const defaultHeight = Math.min(maxHeight, Math.round(window.innerHeight * .54));
    const reveal = panelPointerStart.hidden && delta < -32;
    const hidden = !reveal && (panelPointerStart.height < 105 || (!panelPointerStart.hidden && delta > 48));
    const height = hidden ? 26 : reveal ? Math.max(defaultHeight, panelPointerStart.currentHeight) : panelPointerStart.currentHeight;
    const moved = Math.abs(delta) > 8;
    panelPointerStart = null;
    setMenuPanelHidden(hidden);
    $("layout").classList.remove("panel-dragging");
    $("layout").style.setProperty("--mobile-list-height", hidden ? "26px" : `${height}px`);
    suppressPanelClick = moved;
    setTimeout(() => { suppressPanelClick = false; }, 0);
    requestAnimationFrame(updateMap);
    return;
  }
  const delta = event.clientX - panelPointerStart.x;
  const startHidden = panelPointerStart.hidden;
  const width = panelPointerStart.width;
  panelPointerStart = null;
  const moved = Math.abs(delta) > 8;
  const threshold = Math.min(110, Math.max(48, width * .22));
  if (delta < -threshold && !startHidden) setMenuPanelHidden(true);
  else if (delta > threshold && startHidden) setMenuPanelHidden(false);
  $("layout").classList.remove("panel-dragging");
  $("layout").style.removeProperty("--panel-drag-offset");
  suppressPanelClick = moved;
  setTimeout(() => { suppressPanelClick = false; }, 0);
});
$("menu-panel-handle").addEventListener("pointercancel", () => {
  const mobile = panelPointerStart?.mobile;
  panelPointerStart = null;
  $("layout").classList.remove("panel-dragging");
  $("layout").style.removeProperty(mobile ? "--mobile-list-height" : "--panel-drag-offset");
  requestAnimationFrame(updateMap);
});
$("menu-panel-handle").onclick = () => {
  if (suppressPanelClick) return;
  setMenuPanelHidden(!$("layout").classList.contains("menu-hidden"));
};

function showPlaceOnMap(place, openBanner = true) {
  mapFocus = place;
  focusedPlaceId = place.id;
  $("places").querySelector("[aria-current=true]")?.removeAttribute("aria-current");
  $("places").querySelector(`[data-place-id="${CSS.escape(place.id)}"]`)?.setAttribute("aria-current", "true");
  setView("map");
  if (openBanner && window.matchMedia("(max-width: 720px)").matches) {
    if (!mapPlaceId) menuHiddenBeforeBanner = $("layout").classList.contains("menu-hidden");
    setMenuPanelHidden(true);
  }
  renderMapBanner(openBanner ? place : null);
}
$("random-recommend").addEventListener("click", () => {
  const candidates = board.data.places.filter(place => Number.isFinite(place.lat) && Number.isFinite(place.lng));
  if (!candidates.length) {
    notify("지도에 표시할 수 있는 저장 매장이 없어요.");
    return;
  }
  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  showPlaceOnMap(picked, true);
  requestAnimationFrame(() => scrollSavedPlaceToTop(picked.id));
});
function scrollSavedPlaceToTop(placeId) {
  const viewport = document.querySelector(".places");
  const card = $("places").querySelector(`[data-place-id="${CSS.escape(placeId)}"]`);
  const stickyHead = $("list-panel").querySelector(".list-head");
  if (!viewport || !card || !stickyHead) return;
  const cardTop = card.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  const headerHeight = stickyHead.getBoundingClientRect().height;
  viewport.scrollTo({top: viewport.scrollTop + cardTop - headerHeight, behavior: "smooth"});
}
$("map-place-back").onclick = () => renderMapBanner(null);
$("map-place-dismiss").onclick = () => renderMapBanner(null);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && mapPlaceId && !document.querySelector("dialog[open]")) renderMapBanner();
});
$("search-toggle").onclick = () => {
  const open = !$("layout").classList.contains("search-open");
  $("layout").classList.toggle("search-open", open);
  $("search-toggle").setAttribute("aria-expanded", String(open));
  if (open) requestAnimationFrame(() => $("search").focus());
  else {
    $("search").value = "";
    renderList();
  }
};
$("search").addEventListener("keydown", event => {
  if (event.key === "Escape") $("search-toggle").click();
});
$("zoom-in").onclick = () => { if (map) map.setZoom(map.getZoom() + 1); };
$("zoom-out").onclick = () => { if (map) map.setZoom(map.getZoom() - 1); };
$("map-setup").onclick = openSettings;

mapForm.addEventListener("submit", event => {
  event.preventDefault();
  if (busy) return;
  try {
    localStorage.setItem(keyStorage, mapForm.elements.key.value.trim());
    location.reload();
  } catch {
    message("settings-error", "이 브라우저에 설정을 저장할 수 없습니다.");
  }
});

function mapMessage(title, copy, action = true) {
  $("map-status-title").textContent = title;
  $("map-status-copy").textContent = copy;
  $("map-status").hidden = false;
  $("map-setup").hidden = !action;
}

function mapFailed(title, copy) {
  mapState = "failed";
  renderMapBanner();
  if (picking) {
    finishPick();
    message(placeDialog.open ? "place-error" : "settings-error", copy);
  }
  mapMessage(title, copy);
}

function loadMap() {
  if (location.protocol === "file:") {
    mapFailed("브라우저 주소로 열어 주세요", "파일 미리보기 대신 웹서버 주소를 Safari에서 열어 주세요.");
    return;
  }
  if (!mapKey || mapState !== "idle") return;
  mapState = "loading";
  mapMessage("네이버 지도 불러오는 중", "연결이 완료되면 저장한 장소가 표시됩니다.", false);
  const script = document.createElement("script");
  const sdk = new URL("https://oapi.map.naver.com/openapi/v3/maps.js");
  sdk.searchParams.set("ncpKeyId", mapKey);
  sdk.searchParams.set("callback", "araMapsReady");
  const timeout = setTimeout(() => mapFailed("지도 연결 시간 초과", "네트워크를 확인한 뒤 페이지를 새로고침해 주세요."), 15000);
  window.navermap_authFailure = () => {
    clearTimeout(timeout);
    mapFailed("네이버 지도 인증 실패", "Client ID와 Dynamic Map 선택 여부, 현재 접속 주소의 호스트 등록을 확인해 주세요.");
  };
  window.araMapsReady = () => {
    clearTimeout(timeout);
    if (mapState !== "loading") return;
    mapState = "ready";
    requestAnimationFrame(updateMap);
  };
  script.onerror = () => {
    clearTimeout(timeout);
    mapFailed("지도를 불러올 수 없어요", "네트워크 연결을 확인한 뒤 페이지를 새로고침해 주세요.");
  };
  script.src = sdk.href;
  script.async = true;
  document.head.append(script);
}

function latLng(point) {
  return new naver.maps.LatLng(point.lat, point.lng);
}

function updateMap() {
  const canvas = $("map");
  const viewport = canvas.parentElement;
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (!width || !height) return;
  const mobile = window.matchMedia("(max-width: 720px)").matches;
  const list = $("list-panel");
  const menuHidden = $("layout").classList.contains("menu-hidden");
  const inset = !mobile && !menuHidden && list.offsetWidth
    ? Math.round(list.getBoundingClientRect().right - viewport.getBoundingClientRect().left + parseFloat(getComputedStyle($("layout")).columnGap))
    : 0;
  viewport.parentElement.style.setProperty("--map-inset", inset + "px");
  const banner = $("map-place-banner");
  const left = menuHidden ? 0 : inset + (mobile ? 0 : banner.offsetWidth);
  viewport.parentElement.style.setProperty("--map-controls-inset", left + "px");
  const bottom = mobile && !banner.hidden ? 0 : document.querySelector(".bottom-actions").offsetHeight;
  const padding = {top: 0, right: 0, bottom, left};
  const paddingKey = left + "/" + bottom;
  if (mapState === "idle") loadMap();
  if (mapState !== "ready") return;
  try {
    const size = width + "x" + height;
    if (!map) {
      map = new naver.maps.Map(canvas, {
        center: latLng(mapFocus || board.data.base || araCenter),
        size: new naver.maps.Size(width, height), zoom: 16, padding, zoomControl: false, mapDataControl: false
      });
      lastSize = size;
      lastPadding = paddingKey;
      naver.maps.Event.addListener(map, "click", event => {
        if (picking) finishPick({lat: event.coord.lat(), lng: event.coord.lng()});
      });
      if (mapState !== "ready") return;
      $("map-status").hidden = true;
      renderList();
    }
    if (size !== lastSize) {
      map.setSize(new naver.maps.Size(width, height));
      lastSize = size;
    }
    if (paddingKey !== lastPadding) {
      map.setOptions({padding});
      lastPadding = paddingKey;
    }
    if (mapFocus) {
      const place = mapFocus;
      mapFocus = null;
      map.setZoom(17);
      map.setCenter(latLng(place));
      requestAnimationFrame(() => flashMarker(place.id));
    }
  } catch {
    mapFailed("지도를 표시할 수 없어요", "페이지를 새로고침하고 브라우저와 지도 설정을 확인해 주세요.");
  }
}

function flashMarker(id) {
  const marker = $("map-place-" + id);
  const overlay = markers.get(id);
  if (!marker || !overlay) return;
  if (stopFlash) stopFlash();
  void marker.offsetWidth;
  marker.classList.add("is-flashing");
  overlay.setZIndex(1000);
  const timer = setTimeout(() => stopFlash(), 1700);
  stopFlash = () => {
    clearTimeout(timer);
    marker.classList.remove("is-flashing");
    overlay.setZIndex(0);
    stopFlash = null;
  };
}

function shortPlaceName(name) {
  return name
    .replace(/^CU\s+제주\s*아라(?=(?:센터|스위첸)점$)/u, "CU ")
    .replace(/\s*(?:제주(?:시)?\s*)?아라(?:동)?(?:점|지점)$/u, "")
    .replace(/\s+(?:제주(?:시)?(?:점|지점)?|(?:제주(?:시)?\s*)?아라(?:동)?|본점|직영점|\d+호점)$/u, "") || name;
}

function drawMarkers(places) {
  if (!map || mapState !== "ready") return;
  if (stopFlash) stopFlash();
  markers.forEach(marker => {
    naver.maps.Event.clearInstanceListeners(marker);
    marker.setMap(null);
  });
  markers.clear();
  const addMarker = (point, title, color, action, label = "") => {
    const pin = element("span", null, "map-pin");
    pin.style.backgroundColor = color;
    const icon = element("span", null, "map-marker");
    icon.append(pin);
    if (label) {
      icon.id = "map-place-" + point.id;
      icon.append(element("span", label, "map-label"));
    }
    const marker = new naver.maps.Marker({
      position: latLng(point), map, title,
      icon: {content: icon, size: new naver.maps.Size(16, 16), anchor: new naver.maps.Point(8, 8)}
    });
    naver.maps.Event.addListener(marker, "click", () => {
      if (picking) finishPick(point);
      else action();
    });
    markers.set(point.id, marker);
  };
  for (const place of places) addMarker(place, place.name, "#146445c7", () => {
    showPlaceOnMap(place);
    requestAnimationFrame(() => scrollSavedPlaceToTop(place.id));
  }, shortPlaceName(place.name));
  if (board.data.base) addMarker(board.data.base, baseName, "#91462acc", () => notify(baseName + " · 직선거리 기준점"));
}

function startPick(form, dialog, errorId) {
  if (!mapKey || mapState === "failed" || location.protocol === "file:") {
    message(errorId, "지도 연결을 먼저 설정해 주세요. 위도와 경도를 직접 입력할 수도 있습니다.");
    return;
  }
  picking = {form, dialog};
  renderMapBanner();
  dialog.close();
  $("pick-bar").hidden = false;
  setView("map");
}

function finishPick(point) {
  if (!picking) return;
  const {form, dialog} = picking;
  picking = null;
  $("pick-bar").hidden = true;
  requestAnimationFrame(updateMap);
  if (point) {
    form.elements.lat.value = point.lat.toFixed(7);
    form.elements.lng.value = point.lng.toFixed(7);
  }
  openDialog(dialog);
}

$("pick-place").onclick = () => startPick(placeForm, placeDialog, "place-error");
$("pick-base").onclick = () => startPick(baseForm, settings, "settings-error");
$("pick-cancel").onclick = () => finishPick();
const resize = new ResizeObserver(updateMap);
resize.observe($("map").parentElement);

restoreSession();
if (session) mode = "pending";
renderAccount();
run(reloadBoard);
