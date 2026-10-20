import {
  openProvisioningPackage,
  createProvisioningPackage,
  verifyEmployeePin
} from "../shared/core.js";
import { createAttendanceStore } from "./store.js";

const appVersion = "1.4";
const cacheName = "attendance-shell-v7";
const get = id => document.getElementById(id);
const store = createAttendanceStore();
const dateFormat = new Intl.DateTimeFormat("it-IT", {
  day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit"
});
const themeModes = ["light", "auto", "dark"];
const themeSymbols = { light: "☀", auto: "◐", dark: "☾" };
const themeNames = { light: "Chiaro", auto: "Automatico", dark: "Scuro" };

let state = null;
let pendingSetup = null;
let adminPinSession = null;
let adminTimer = null;
let clockPin = "";
let clockTimer = null;
let busy = false;
let appReady = false;
let lastInteractionAt = Date.now();
let registration = null;
let checkingUpdates = false;
let pendingUpdate = null;
let applyingUpdate = false;
let updateTimer = null;
let themeMode = "auto";

/* interfaccia */
function message(id, value = "", kind = "") {
  const element = get(id);
  element.textContent = value;
  element.className = kind ? `message ${kind}` : "message";
}

function screen(id) {
  document.querySelectorAll(".screen").forEach(element => {
    element.hidden = element.id !== id;
  });
  get("adminOpen").hidden = id !== "clockScreen";
  get("adminBack").hidden = id !== "adminScreen";
  window.scrollTo(0, 0);
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll(".key").forEach(button => {
    button.disabled = value;
  });
}

/* pin dipendente */
function renderClockPin() {
  get("pinDisplay").setAttribute(
    "aria-label", `PIN: ${clockPin.length} cifre su 4`
  );
  get("pinDisplay").querySelectorAll(".pin-dot").forEach((dot, index) => {
    dot.classList.toggle("filled", index < clockPin.length);
  });
}

function cancelClockTimer() {
  if (clockTimer !== null) clearTimeout(clockTimer);
  clockTimer = null;
}

function resetClockPin() {
  cancelClockTimer();
  clockPin = "";
  renderClockPin();
}

function addClockDigit(digit) {
  if (busy || get("clockScreen").hidden || clockPin.length >= 4 || !/^[0-9]$/.test(digit)) return;
  lastInteractionAt = Date.now();
  if (!clockPin.length) message("clockMessage");
  clockPin += digit;
  renderClockPin();
  if (clockPin.length !== 4) return;

  const enteredPin = clockPin;
  cancelClockTimer();
  clockTimer = setTimeout(() => {
    clockTimer = null;
    if (!busy && !get("clockScreen").hidden && clockPin === enteredPin) {
      void registerPunch(enteredPin);
    }
  }, 120);
}

function eraseClockDigit() {
  if (busy) return;
  lastInteractionAt = Date.now();
  cancelClockTimer();
  clockPin = clockPin.slice(0, -1);
  renderClockPin();
}

function refreshClock() {
  get("deviceName").textContent = state.device.name;
  resetClockPin();
  message("clockMessage");
}

/* archivio */
function validState(data) {
  return data?.schemaVersion === 1 &&
    data.center === "attendance" &&
    typeof data.originId === "string" &&
    typeof data.device?.id === "string" &&
    typeof data.device?.name === "string" &&
    Array.isArray(data.employees) &&
    Array.isArray(data.punches) &&
    Array.isArray(data.imports) &&
    Boolean(data.adminChallenge);
}

function security(kind) {
  return state.security?.[kind] || { failures: 0, lockedUntil: 0 };
}

function checkLock(kind) {
  const guard = security(kind);
  if (guard.lockedUntil > Date.now()) {
    const seconds = Math.ceil((guard.lockedUntil - Date.now()) / 1000);
    throw new Error(`Riprova tra ${seconds} secondi`);
  }
}

async function updateSecurity(kind, success) {
  const next = structuredClone(state);
  if (!next.security) next.security = {};
  const guard = next.security[kind] || { failures: 0, lockedUntil: 0 };
  if (success) {
    if (!guard.failures && !guard.lockedUntil) return;
    guard.failures = 0;
    guard.lockedUntil = 0;
  } else {
    guard.failures += 1;
    if (guard.failures >= 5) {
      guard.failures = 0;
      guard.lockedUntil = Date.now() + 60000;
    }
  }
  next.security[kind] = guard;
  await store.save(next);
  state = next;
  if (!success) throw new Error(
    guard.lockedUntil > Date.now()
      ? "Troppi tentativi. Attendi 60 secondi."
      : "PIN non riconosciuto"
  );
}

async function readJsonFile(file) {
  if (!file || file.size > 5 * 1024 * 1024) {
    throw new Error("Seleziona un JSON valido (massimo 5 MB)");
  }
  try { return JSON.parse(await file.text()); }
  catch { throw new Error("JSON non leggibile"); }
}

/* configurazione iniziale */
get("setupForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  const button = get("setupContinue");
  button.disabled = true;
  message("setupMessage");
  try {
    const pin = get("setupPin").value;
    const json = await readJsonFile(get("setupJson").files[0]);
    const config = await openProvisioningPackage(json, pin);
    if (!config.employees.length) throw new Error("Il JSON non contiene dipendenti attivi");
    pendingSetup = { config, pin };
    get("setupImport").hidden = true;
    get("setupDevice").hidden = false;
    get("setupCount").textContent = "Configurazione pronta";
    get("setupPin").value = "";
    get("deviceInput").focus();
  } catch (error) {
    message("setupMessage", error.message, "error");
  } finally {
    setBusy(false);
    button.disabled = false;
  }
});

get("deviceForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !pendingSetup) return;
  setBusy(true);
  const button = get("activateButton");
  button.disabled = true;
  message("setupMessage");
  try {
    const name = get("deviceInput").value.trim();
    if (!name || name.length > 80) throw new Error("Inserisci il nome dispositivo");
    const { config, pin } = pendingSetup;
    const now = new Date().toISOString();
    const challenge = await createProvisioningPackage({
      schemaVersion: 1, kind: "center-provisioning", sourceCenter: "core",
      targetCenter: "attendance", originId: config.originId,
      exportId: crypto.randomUUID(), issuedAt: now, employees: []
    }, pin);
    const newState = {
      schemaVersion: 1, center: "attendance", originId: config.originId,
      device: { id: crypto.randomUUID(), name, createdAt: now },
      adminChallenge: challenge, employees: structuredClone(config.employees),
      punches: [], imports: [{
        exportId: config.exportId, at: now,
        added: config.employees.length, skipped: 0, conflicts: 0
      }],
      security: {
        employee: { failures: 0, lockedUntil: 0 },
        admin: { failures: 0, lockedUntil: 0 }
      }
    };
    await store.initialize(newState);
    state = newState;
    pendingSetup = null;
    get("deviceForm").reset();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    screen("clockScreen");
    refreshClock();
  } catch (error) {
    message("setupMessage", error.message, "error");
  } finally {
    setBusy(false);
    button.disabled = false;
  }
});

get("setupBack").addEventListener("click", () => {
  if (busy) return;
  pendingSetup = null;
  get("setupImport").hidden = false;
  get("setupDevice").hidden = true;
  message("setupMessage");
});

/* tastierino */
document.querySelectorAll("[data-digit]").forEach(button => {
  button.addEventListener("click", () => addClockDigit(button.dataset.digit));
});
get("erasePin").addEventListener("click", eraseClockDigit);
get("clearPin").addEventListener("click", () => {
  if (busy) return;
  lastInteractionAt = Date.now();
  resetClockPin();
});

document.addEventListener("keydown", event => {
  if (get("clockScreen").hidden || busy || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement &&
      (target.matches("input, textarea, select") || target.isContentEditable)) return;
  if (/^[0-9]$/.test(event.key)) {
    event.preventDefault();
    addClockDigit(event.key);
  } else if (event.key === "Backspace") {
    event.preventDefault();
    eraseClockDigit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    lastInteractionAt = Date.now();
    resetClockPin();
  }
});

/* timbratura automatica alla quarta cifra */
async function registerPunch(pin) {
  if (busy || !state) return;
  setBusy(true);
  cancelClockTimer();
  try {
    checkLock("employee");
    if (!/^[0-9]{4}$/.test(pin)) throw new Error("Inserisci un PIN di 4 cifre");
    let found = null;
    for (const employee of state.employees) {
      if (employee.active && await verifyEmployeePin(pin, employee.pinVerifier)) {
        found = employee;
        break;
      }
    }
    if (!found) await updateSecurity("employee", false);
    await updateSecurity("employee", true);
    const previous = [...state.punches].reverse()
      .find(punch => punch.employeeId === found.id);
    const type = previous?.type === "in" ? "out" : "in";
    const at = new Date().toISOString();
    const next = structuredClone(state);
    next.punches.push({
      id: crypto.randomUUID(), employeeId: found.id,
      deviceId: state.device.id, type, at
    });
    await store.save(next);
    state = next;
    message("clockMessage",
      `${found.firstName} · ${type === "in" ? "Entrata" : "Uscita"} · ` +
      `${dateFormat.format(new Date(at))} · ` +
      `${type === "in" ? "Buon lavoro!" : "Buon riposo!"}`, "success");
  } catch (error) {
    message("clockMessage", error.message, "error");
  } finally {
    resetClockPin();
    lastInteractionAt = Date.now();
    setBusy(false);
  }
}

/* amministrazione */
function closeAdmin() {
  if (busy) return;
  clearTimeout(adminTimer);
  adminTimer = null;
  adminPinSession = null;
  get("adminLogin").reset();
  get("importForm").reset();
  get("adminGate").hidden = false;
  get("adminPanel").hidden = true;
  message("adminMessage");
  message("importMessage");
  if (state) {
    screen("clockScreen");
    refreshClock();
  }
  lastInteractionAt = Date.now();
}

function refreshAdminTimeout() {
  clearTimeout(adminTimer);
  adminTimer = setTimeout(() => {
    if (busy) return refreshAdminTimeout();
    closeAdmin();
  }, 120000);
}

function renderAdmin() {
  get("adminDeviceName").textContent = state.device.name;
  get("adminDeviceId").textContent = state.device.id;
  get("adminPunchCount").textContent = String(state.punches.length);
  const names = new Map(state.employees.map(employee => [
    employee.id, `${employee.firstName} ${employee.lastName}`
  ]));
  const list = get("punchList");
  list.replaceChildren();
  for (const punch of state.punches.slice(-20).reverse()) {
    const row = document.createElement("div");
    row.className = "log-row";
    const person = document.createElement("strong");
    person.textContent = names.get(punch.employeeId) || "Dipendente non trovato";
    const details = document.createElement("span");
    details.textContent = `${punch.type === "in" ? "Entrata" : "Uscita"} · ` +
      dateFormat.format(new Date(punch.at));
    row.append(person, details);
    list.append(row);
  }
  if (!state.punches.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Nessuna timbratura";
    list.append(empty);
  }
}

get("adminOpen").addEventListener("click", () => {
  if (busy) return;
  lastInteractionAt = Date.now();
  screen("adminScreen");
  get("adminGate").hidden = false;
  get("adminPanel").hidden = true;
  get("adminLogin").reset();
  message("adminMessage");
  get("adminPin").focus();
});
get("adminBack").addEventListener("click", closeAdmin);
get("adminExit").addEventListener("click", closeAdmin);

get("adminLogin").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  const button = get("adminLoginButton");
  button.disabled = true;
  message("adminMessage");
  try {
    checkLock("admin");
    const pin = get("adminPin").value;
    let valid = false;
    try {
      const proof = await openProvisioningPackage(state.adminChallenge, pin);
      valid = proof.originId === state.originId;
    } catch { valid = false; }
    if (!valid) await updateSecurity("admin", false);
    await updateSecurity("admin", true);
    adminPinSession = pin;
    get("adminLogin").reset();
    get("adminGate").hidden = true;
    get("adminPanel").hidden = false;
    renderAdmin();
    refreshAdminTimeout();
  } catch (error) {
    message("adminMessage", error.message, "error");
  } finally {
    setBusy(false);
    button.disabled = false;
  }
});

/* importazione additiva */
get("importForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !adminPinSession) return;
  setBusy(true);
  const button = get("importButton");
  button.disabled = true;
  message("importMessage");
  try {
    const json = await readJsonFile(get("importJson").files[0]);
    const incoming = await openProvisioningPackage(json, adminPinSession);
    if (incoming.originId !== state.originId) {
      throw new Error("Configurazione di un altro Core Center");
    }
    if (state.imports.some(item => item.exportId === incoming.exportId)) {
      message("importMessage", "JSON già importato", "success");
      return;
    }
    const currentById = new Map(state.employees.map(employee => [employee.id, employee]));
    const names = new Set(state.employees.map(employee =>
      `${employee.firstName} ${employee.lastName}`.trim().toLocaleLowerCase("it")
    ));
    const added = [];
    const conflicts = [];
    let skipped = 0;
    for (const employee of incoming.employees) {
      const existing = currentById.get(employee.id);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(employee)) skipped += 1;
        else conflicts.push(`${employee.firstName} ${employee.lastName}`);
        continue;
      }
      const name = `${employee.firstName} ${employee.lastName}`.trim().toLocaleLowerCase("it");
      if (names.has(name)) {
        conflicts.push(`${employee.firstName} ${employee.lastName}`);
        continue;
      }
      names.add(name);
      added.push(structuredClone(employee));
    }
    const next = structuredClone(state);
    next.employees.push(...added);
    next.imports.push({
      exportId: incoming.exportId, at: new Date().toISOString(),
      added: added.length, skipped, conflicts: conflicts.length
    });
    await store.save(next);
    state = next;
    get("importForm").reset();
    renderAdmin();
    refreshAdminTimeout();
    const summary = `${added.length} aggiunti · ${skipped} già presenti · ${conflicts.length} conflitti`;
    message("importMessage", conflicts.length
      ? `${summary}. Non modificati: ${conflicts.join(", ")}`
      : summary, conflicts.length ? "error" : "success");
  } catch (error) {
    message("importMessage", error.message, "error");
  } finally {
    setBusy(false);
    button.disabled = false;
  }
});

/* pulsante unico tema */
const colorPreference = matchMedia("(prefers-color-scheme: dark)");

function applyTheme(mode) {
  themeMode = themeModes.includes(mode) ? mode : "auto";
  document.documentElement.dataset.theme = themeMode === "auto" ? "" : themeMode;
  const button = get("themeToggle");
  button.textContent = themeSymbols[themeMode];
  button.setAttribute("aria-label", `Tema ${themeNames[themeMode]}. Tocca per cambiare`);
  button.title = `Tema ${themeNames[themeMode]}`;
  const dark = themeMode === "dark" ||
    (themeMode === "auto" && colorPreference.matches);
  document.querySelector('meta[name="theme-color"]').setAttribute(
    "content", dark ? "#111113" : "#f5f5f7"
  );
  try { localStorage.setItem("attendance-theme", themeMode); } catch { /* facoltativo */ }
}

let storedTheme = "auto";
try { storedTheme = localStorage.getItem("attendance-theme") || "auto"; }
catch { storedTheme = "auto"; }
applyTheme(storedTheme);

get("themeToggle").addEventListener("click", () => {
  const next = (themeModes.indexOf(themeMode) + 1) % themeModes.length;
  applyTheme(themeModes[next]);
});
colorPreference.addEventListener?.("change", () => {
  if (themeMode === "auto") applyTheme("auto");
});

/* offline: stato letto localmente, senza verifica di rete */
function setOfflineStatus(ready, value) {
  get("offlineStatus").classList.toggle("ready", ready);
  get("offlineText").textContent = value;
}

function withTimeout(promise, milliseconds, reason = "Operazione troppo lenta") {
  let timer;
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), milliseconds);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function refreshOfflineStatus() {
  if (!("serviceWorker" in navigator) || !("caches" in window)) {
    setOfflineStatus(false, "Offline non supportato");
    return;
  }
  try {
    const current = registration || await withTimeout(
      navigator.serviceWorker.getRegistration("./"), 6000
    );
    if (!current?.active) {
      setOfflineStatus(false, "Offline non pronto");
      return;
    }
    const info = await readWorkerInfo(current.active).catch(() => null);
    if (info && info.ready === true) {
      setOfflineStatus(true, "Disponibile offline");
      return;
    }
    // Controllo locale alternativo se il worker non risponde.
    const names = await withTimeout(caches.keys(), 5000);
    const name = info?.cacheName || names.find(item => item === cacheName);
    if (!name || !names.includes(name)) {
      setOfflineStatus(false, "Offline non pronto");
      return;
    }
    const cache = await caches.open(name);
    const urls = ["index.html", "app.js", "store.js", "manifest.json", "icon.svg", "../shared/core.js"]
      .map(path => new URL(path, import.meta.url).href);
    const matches = await withTimeout(Promise.all(urls.map(url => cache.match(url))), 5000);
    setOfflineStatus(matches.every(Boolean),
      matches.every(Boolean) ? "Disponibile offline" : "Offline non pronto");
  } catch {
    setOfflineStatus(false, "Verifica offline non riuscita");
  }
}

async function prepareOffline() {
  if (!("serviceWorker" in navigator)) {
    setOfflineStatus(false, "Offline non supportato");
    return;
  }
  try {
    registration = await withTimeout(navigator.serviceWorker.getRegistration("./"), 6000);
    // Solo la prima installazione richiede registrazione: nessun polling.
    if (!registration && navigator.onLine) {
      registration = await withTimeout(navigator.serviceWorker.register("./sw.js", {
        scope: "./", updateViaCache: "none"
      }), 15000);
    }
  } catch (error) {
    console.warn("Offline:", error);
  }
  await refreshOfflineStatus();
}

/* aggiornamenti: solo dal pulsante pubblico */
function readWorkerInfo(worker) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 3500);
    channel.port1.onmessage = event => finish(event.data);
    try {
      worker.postMessage({ type: "app-status" }, [channel.port2]);
    } catch { finish(null); }
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function canApplyUpdate() {
  return appReady && !busy && !pendingSetup && !adminPinSession &&
    get("adminScreen").hidden &&
    (!get("clockScreen").hidden ||
      (!get("setupScreen").hidden && !get("setupPin").value &&
        !get("deviceInput").value && !get("setupJson").files.length) ||
      !get("errorScreen").hidden) &&
    !clockPin.length && clockTimer === null &&
    !document.hidden && Date.now() - lastInteractionAt >= 2000;
}

function queueSafeUpdate(worker = null) {
  pendingUpdate = worker || "reload";
  message("updateMessage", "Aggiornamento pronto. Attendo la fine delle operazioni.");
  if (updateTimer !== null) clearInterval(updateTimer);
  updateTimer = setInterval(() => {
    if (!canApplyUpdate() || applyingUpdate) return;
    clearInterval(updateTimer);
    updateTimer = null;
    void applyUpdate();
  }, 500);
  if (canApplyUpdate()) void applyUpdate();
}

async function applyUpdate() {
  if (applyingUpdate || !pendingUpdate || !canApplyUpdate()) return;
  applyingUpdate = true;
  get("checkUpdateButton").disabled = true;
  message("updateMessage", "Installazione aggiornamento...");
  try {
    if (pendingUpdate !== "reload") {
      const worker = pendingUpdate;
      worker.postMessage({ type: "activate-update" });
      for (let i = 0; i < 70; i++) {
        if (registration?.active === worker && worker.state === "activated") break;
        await delay(300);
      }
      if (registration?.active !== worker || worker.state !== "activated") {
        throw new Error("Attivazione non riuscita");
      }
    }
    // Non cancella CacheStorage o IndexedDB: è solo un reload della pagina.
    location.reload();
  } catch (error) {
    applyingUpdate = false;
    pendingUpdate = null;
    get("checkUpdateButton").disabled = false;
    message("updateMessage", `${error.message}. Riprova il controllo.`, "error");
  }
}

async function remoteVersion() {
  const url = new URL("./index.html", location.href);
  url.searchParams.set("manual-update", String(Date.now()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url.href, {
      cache: "no-store", signal: controller.signal
    });
    if (!response.ok) throw new Error("Server aggiornamenti non disponibile");
    const html = await response.text();
    const match = html.match(/<meta\s+name="app-version"\s+content="([^"]+)"/);
    if (!match) throw new Error("Versione online non leggibile");
    return match[1];
  } finally {
    clearTimeout(timer);
  }
}

async function waitForWorker(current) {
  if (current.waiting) return current.waiting;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (current.waiting) return current.waiting;
    if (current.installing?.state === "redundant") {
      throw new Error("Download aggiornamento non riuscito");
    }
    await delay(400);
  }
  return current.waiting || null;
}

async function checkForUpdates() {
  if (checkingUpdates || applyingUpdate || pendingUpdate) return;
  checkingUpdates = true;
  const button = get("checkUpdateButton");
  button.disabled = true;
  message("updateMessage", "Controllo aggiornamenti...");
  try {
    if (!navigator.onLine) throw new Error("Connessione non disponibile");
    if (!("serviceWorker" in navigator)) throw new Error("Aggiornamenti non supportati");
    registration = await withTimeout(navigator.serviceWorker.getRegistration("./"), 8000);
    if (!registration) {
      registration = await withTimeout(navigator.serviceWorker.register("./sw.js", {
        scope: "./", updateViaCache: "none"
      }), 20000);
    }
    if (registration.waiting) {
      const info = await readWorkerInfo(registration.waiting);
      if (info?.ready && info.appVersion && info.appVersion !== appVersion) {
        queueSafeUpdate(registration.waiting);
        return;
      }
    }
    const version = await remoteVersion();
    if (version === appVersion) {
      message("updateMessage", "L'app è aggiornata", "success");
      return;
    }
    message("updateMessage", `Versione ${version} disponibile. Download...`);
    try {
      await withTimeout(registration.update(), 25000, "Verifica della nuova versione troppo lenta");
    } catch (error) {
      if (!registration.waiting && !registration.installing) throw error;
    }
    const worker = await waitForWorker(registration);
    if (worker) {
      const info = await readWorkerInfo(worker);
      if (!info?.ready || info.appVersion !== version) {
        throw new Error("File dell'aggiornamento non verificati");
      }
      queueSafeUpdate(worker);
      return;
    }
    const active = await readWorkerInfo(registration.active);
    if (active?.ready && active.appVersion === version) {
      queueSafeUpdate();
      return;
    }
    throw new Error("Aggiornamento non completato. Riprova.");
  } catch (error) {
    message("updateMessage", error.name === "AbortError"
      ? "Connessione troppo lenta. Riprova." : error.message, "error");
  } finally {
    checkingUpdates = false;
    if (!pendingUpdate && !applyingUpdate) button.disabled = false;
    void refreshOfflineStatus();
  }
}

get("checkUpdateButton").addEventListener("click", () => {
  lastInteractionAt = Date.now();
  void checkForUpdates();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    void refreshOfflineStatus();
  });
}

/* avvio */
async function start() {
  message("bootMessage");
  try {
    state = await store.load();
    if (state && !validState(state)) throw new Error("Archivio non compatibile");
    if (state) {
      screen("clockScreen");
      refreshClock();
    } else {
      screen("setupScreen");
      get("setupImport").hidden = false;
      get("setupDevice").hidden = true;
    }
  } catch (error) {
    get("bootMessage").textContent = error.message;
    screen("errorScreen");
  } finally {
    appReady = true;
  }
}

renderClockPin();
void start();
void prepareOffline();
