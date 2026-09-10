// dsh-rlm-tools-bsl — хост-половина плагина.
//
// Раннер: поднимает сервер rlm-tools-bsl (MCP для анализа кода 1С по HTTP) при старте DSH
// и гасит его вместе с DSH. Настройки — $DSH_HOME/rlm-tools-bsl/settings.json,
// stdout сервера — $DSH_HOME/rlm-tools-bsl/logs/server.out.log.
// Все роуты живут под префиксом /rlm и отдают JSON.
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const name = "dsh-rlm-tools-bsl";

// webServer — HTTP-роуты плагина.
export const inject = ["webServer"];

const ROUTE = "/rlm";
const SERVER_NAME = "rlm-tools-bsl";
const MCP_SERVER_NAME = "rlm";
const HOST = "127.0.0.1";
const PLUGIN_VERSION = "0.1.3";
const SCHEMA = "dsh-rlm-tools-bsl/v1";
const DEFAULT_PORT = 9330;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 2_000;
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const UV_INSTALL_SCRIPT = "irm https://astral.sh/uv/install.ps1 | iex";

// Дополнительные ключи (command, env, takeover, autoInstall) задаются только строкой плагина в cordis.patch.yml.
const DEFAULTS = {
  command: "",
  port: DEFAULT_PORT,
  env: {},
  takeover: true,
  autoInstall: true,
  mcpAutoRegister: true,
};
const FIELD_KEYS = Object.keys(DEFAULTS);

let detectedCache = null;
const portOwnerCache = new Map();

// $DSH_HOME: та же приоритетность, что у ядра — переменная окружения, иначе ~/.dsh.
const DSH_HOME = (() => {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? resolve(env.trim()) : join(homedir(), ".dsh");
})();
const DIR = join(DSH_HOME, SERVER_NAME);
const SETTINGS_FILE = join(DIR, "settings.json");
const LOG_FILE = join(DIR, "logs", "server.out.log");
// Автоустановка: окружение инструмента, его исполняемые файлы и Python — внутри папки плагина.
const TOOL_DIR = join(DIR, "tool");
const TOOL_BIN_DIR = join(DIR, "bin");
const PYTHON_DIR = join(DIR, "python");

// Известные менеджеры MCP и их хранилища: файл и поле с именем сервера.
const PROFILES_DIR = join(DSH_HOME, "profiles");
const MANAGER_STORES = [
  { manager: "dsh-mcp-manager", pkg: "dsh-mcp-manager", file: join(DSH_HOME, "mcp-servers.json"), nameField: "serverName" },
  { manager: "@wingsky-1/dsh-mcp-manager", pkg: "@wingsky-1/dsh-mcp-manager", file: join(DSH_HOME, "dsh-mcp.json"), nameField: "name" },
];

// ── утилиты ────────────────────────────────────────────────────────────────

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("тело запроса слишком большое"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Запись через временный файл: падение процесса не оставит обрезанный JSON.
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmp, file);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Явно заданное значение: пустая строка и пустой объект считаются «не задано».
function isSet(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function tailLines(file, lines) {
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return [];
    const handle = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      readSync(handle, buffer, 0, length, start);
      return buffer.toString("utf8").split(/\r?\n/).slice(-lines);
    } finally {
      closeSync(handle);
    }
  } catch {
    return [];
  }
}

function readSettings() {
  const raw = readJson(SETTINGS_FILE) ?? {};
  const out = {};
  for (const key of FIELD_KEYS) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

// Каталог логов сервера обязателен для записи: под файловой песочницей DSH сервер
// падает с кодом 1 и PermissionError. Подсказка полезнее кода выхода — показываем её.
function writeHint() {
  const tail = tailLines(LOG_FILE, 60).join("\n");
  if (!/PermissionError|Access is denied|WinError 5\b/i.test(tail)) return "";
  return " — каталог .config\\rlm-tools-bsl недоступен для записи: добавьте его в разрешённые пути DSH или задайте RLM_CONFIG_FILE и RLM_INDEX_DIR в переменных окружения плагина";
}

// ── конфигурация запуска ───────────────────────────────────────────────────

function pickConfig(config) {
  const out = {};
  for (const key of FIELD_KEYS) {
    if (config && config[key] !== undefined) out[key] = config[key];
  }
  return out;
}

function detectCommand(fresh = false) {
  const now = Date.now();
  if (!fresh && detectedCache && now - detectedCache.at < 15000) return detectedCache.value;
  const probe = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(probe, [SERVER_NAME], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  let value = "";
  if (found.status === 0) {
    value = String(found.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
  }
  if (!value) {
    const exe = process.platform === "win32" ? SERVER_NAME + ".exe" : SERVER_NAME;
    for (const dir of [join(homedir(), ".local", "bin"), TOOL_BIN_DIR]) {
      const candidate = join(dir, exe);
      if (existsSync(candidate)) {
        value = candidate;
        break;
      }
    }
  }
  detectedCache = { at: now, value };
  return value;
}

// uv ищется в PATH, затем в %USERPROFILE%\.local\bin и в bin самого плагина (куда его кладёт автоустановка).
function detectUv() {
  const probe = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(probe, ["uv"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (found.status === 0) {
    const first = String(found.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  const exe = process.platform === "win32" ? "uv.exe" : "uv";
  for (const candidate of [join(homedir(), ".local", "bin", exe), join(TOOL_BIN_DIR, exe)]) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

// Приоритет: значения из settings.json → значения строки плагина в cordis.patch.yml → встроенные.
function effectiveConfig(rt, fresh = false) {
  const sources = {};
  const out = {};
  for (const key of FIELD_KEYS) {
    const fromSettings = rt.settings[key];
    const fromPatch = rt.patchConfig[key];
    if (isSet(fromSettings)) {
      out[key] = fromSettings;
      sources[key] = "settings";
    } else if (isSet(fromPatch)) {
      out[key] = fromPatch;
      sources[key] = "patch";
    } else {
      out[key] = DEFAULTS[key];
      sources[key] = "default";
    }
  }
  out.port = Number(out.port) || DEFAULT_PORT;
  out.env = out.env && typeof out.env === "object" && !Array.isArray(out.env) ? out.env : {};
  out.takeover = out.takeover !== false;
  out.autoInstall = out.autoInstall !== false;
  out.mcpAutoRegister = out.mcpAutoRegister !== false;
  if (!isSet(out.command)) {
    const detected = detectCommand(fresh);
    if (detected) {
      out.command = detected;
      sources.command = "detected";
    }
  }
  return { config: out, sources, detected: detectCommand(fresh) };
}

function launchArgs(cfg) {
  return ["--transport", "streamable-http", "--host", HOST, "--port", String(cfg.port)];
}

// ── менеджеры MCP ──────────────────────────────────────────────────────────

// Менеджер установлен хотя бы в одном профиле?
function managerInstalled(pkg) {
  const candidates = [join(PROFILES_DIR, "node_modules", pkg)];
  try {
    for (const entry of readdirSync(PROFILES_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(PROFILES_DIR, entry.name, "node_modules", pkg));
    }
  } catch {
    // профилей ещё нет
  }
  return candidates.some((dir) => existsSync(dir));
}

function storeEntry(target, url) {
  const entry = { transport: "streamable-http", url, enabled: true };
  entry[target.nameField] = MCP_SERVER_NAME;
  return entry;
}

// Прописывает сервер в хранилища менеджеров MCP: существующий файл либо файл менеджера,
// найденного в профилях. Запись с нашим именем обновляется, остальные не трогаются.
function registerInManagers(url) {
  const results = [];
  for (const target of MANAGER_STORES) {
    try {
      const exists = existsSync(target.file);
      if (!exists && !managerInstalled(target.pkg)) {
        results.push({ manager: target.manager, file: target.file, skipped: true });
        continue;
      }
      const parsed = exists ? readJson(target.file) : null;
      if (exists && (!parsed || !Array.isArray(parsed.servers))) {
        results.push({ manager: target.manager, file: target.file, error: "файл не разобран как { version, servers }" });
        continue;
      }
      const data = parsed ?? { version: 1, servers: [] };
      if (!Array.isArray(data.servers)) data.servers = [];
      if (!data.version) data.version = 1;
      const entry = storeEntry(target, url);
      const index = data.servers.findIndex((item) => item && item[target.nameField] === MCP_SERVER_NAME);
      const next = index >= 0 ? { ...data.servers[index], ...entry } : entry;
      if (index >= 0 && JSON.stringify(next) === JSON.stringify(data.servers[index])) {
        results.push({ manager: target.manager, file: target.file, action: "unchanged" });
        continue;
      }
      if (index >= 0) data.servers[index] = next;
      else data.servers.push(next);
      writeJson(target.file, data);
      results.push({ manager: target.manager, file: target.file, action: index >= 0 ? "updated" : "added" });
    } catch (error) {
      results.push({ manager: target.manager, file: target.file, error: error?.message || String(error) });
    }
  }
  return results;
}

// ── внешние процессы ───────────────────────────────────────────────────────

// Чужой процесс, слушающий порт: PID по netstat и имя по tasklist.
// Кэш — только для частых опросов состояния из UI; в путях запуска и остановки
// нужна свежая проверка (fresh), иначе перезапуск ловит устаревшее «порт свободен».
function portOwner(port, fresh = false) {
  const now = Date.now();
  if (!fresh) {
    const cached = portOwnerCache.get(port);
    if (cached && now - cached.at < 2000) return cached.value;
  }
  const value = portOwnerUncached(port);
  portOwnerCache.set(port, { at: now, value });
  return value;
}

function portOwnerUncached(port) {
  try {
    const net = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
    let pid = null;
    for (const line of String(net.stdout ?? "").split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      if (!(parts[1] ?? "").endsWith(":" + port)) continue;
      const candidate = Number(parts[parts.length - 1]);
      if (Number.isInteger(candidate) && candidate > 0) pid = candidate;
    }
    if (!pid) return null;
    let image = null;
    if (process.platform === "win32") {
      const list = spawnSync("tasklist", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
      const match = String(list.stdout ?? "").match(/^"([^"]+)"/m);
      if (match) image = match[1];
    }
    return { pid, image };
  } catch {
    return null;
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      // rlm-tools-bsl.exe — трамплин: python-сервер живёт в дочерних процессах, нужен /T.
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15000 });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
  } catch {
    // процесс уже мёртв — это и есть цель
  }
}

function isRlmProcess(proc) {
  const image = String(proc?.Name ?? "").toLowerCase();
  if (image === SERVER_NAME + ".exe" || image === SERVER_NAME) return true;
  if (image.startsWith("python")) return /rlm[_-]?tools[_-]?bsl|rlm_tools_bsl/i.test(String(proc?.CommandLine ?? ""));
  return false;
}

// Верхний процесс семейства rlm, владеющий портом: трамплин-exe запускает python-цепочку,
// убивать надо её начало, иначе остаются сироты с занятым портом.
function rlmProcessTop(pid) {
  if (process.platform !== "win32") return pid;
  try {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const run = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    if (run.status !== 0) return pid;
    const parsed = JSON.parse(String(run.stdout ?? "").trim() || "[]");
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const byPid = new Map(list.map((proc) => [Number(proc.ProcessId), proc]));
    let current = Number(pid);
    for (let guard = 0; guard < 16; guard += 1) {
      const parentId = Number(byPid.get(current)?.ParentProcessId);
      const parent = byPid.get(parentId);
      if (!parent || !isRlmProcess(parent)) break;
      current = parentId;
    }
    return current;
  } catch {
    return pid;
  }
}

// ── пробы сервера ──────────────────────────────────────────────────────────

function sseJson(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      return JSON.parse(line.slice(5).trim());
    } catch {
      // не финальная строка — пропускаем
    }
  }
  return null;
}

// Личность сервера: /health отдаёт generic {"status":"ok"}, имя и версию знает только MCP initialize.
async function probeIdentity(port, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(`http://${HOST}:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: name, version: PLUGIN_VERSION } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: "HTTP " + response.status };
    const payload = sseJson(await response.text());
    const info = payload?.result?.serverInfo;
    if (!info?.name) return { ok: false, error: "ответ initialize без serverInfo" };
    return { ok: info.name === SERVER_NAME, serverName: info.name, version: info.version ?? null };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!portOwner(port, true)) return true;
    await sleep(250);
  }
  return !portOwner(port, true);
}

// ── состояние плагина ──────────────────────────────────────────────────────

function createRuntime(ctx, config) {
  return {
    ctx,
    patchConfig: pickConfig(config),
    settings: readSettings(),
    child: null,
    childPid: null,
    adopted: null,
    version: null,
    startedAt: null,
    starting: false,
    stopping: false,
    installing: false,
    mcpRegistration: [],
    lastError: null,
    lastExit: null,
  };
}

function logInfo(rt, message) {
  try {
    rt.ctx?.logger?.info?.("rlm-tools-bsl: " + message);
  } catch {
    // логгер недоступен — состояние всё равно видно во вкладке
  }
}

function snapshot(rt) {
  const { config, sources, detected } = effectiveConfig(rt);
  const running = Boolean(rt.child) || Boolean(rt.adopted);
  const url = `http://${HOST}:${config.port}/mcp`;
  const snippet = JSON.stringify({ serverName: MCP_SERVER_NAME, transport: "streamable-http", url, enabled: true }, null, 2);
  return {
    ok: true,
    server: {
      name: SERVER_NAME,
      url,
      running,
      starting: rt.starting,
      stopping: rt.stopping,
      installing: rt.installing,
      managed: Boolean(rt.child),
      adopted: Boolean(rt.adopted),
      pid: rt.childPid ?? rt.adopted?.pid ?? null,
      version: rt.version,
      startedAt: rt.startedAt,
      uptimeMs: rt.startedAt ? Date.now() - rt.startedAt : null,
      lastError: rt.lastError,
      portOwner: running ? null : portOwner(config.port),
    },
    config: { command: config.command, port: config.port, env: config.env, takeover: config.takeover, detected, sources },
    mcp: { serverName: MCP_SERVER_NAME, transport: "streamable-http", url, enabled: true, snippet, registration: rt.mcpRegistration },
    paths: { dir: DIR, settings: SETTINGS_FILE, log: LOG_FILE, dshHome: DSH_HOME },
    logTail: tailLines(LOG_FILE, 30),
  };
}

// ── жизненный цикл сервера ─────────────────────────────────────────────────

// Запуск внешней команды с выводом в лог: цикл событий не блокируем, установка идёт минутами.
function runToLog(command, args, options = {}) {
  return new Promise((done) => {
    let output = "";
    try {
      writeFileSync(LOG_FILE, `\n===== ${new Date().toISOString()} ${command} ${args.join(" ")}\n`, { encoding: "utf8", flag: "a" });
    } catch {
      // лог недоступен — не повод не запускать
    }
    const child = spawn(command, args, { env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk) => {
      output += chunk.toString("utf8");
    };
    const finish = (code) => {
      try {
        writeFileSync(LOG_FILE, output, { encoding: "utf8", flag: "a" });
      } catch {
        // см. выше
      }
      done({ code, output });
    };
    const timer = setTimeout(() => {
      output += "\n[таймаут выполнения команды]\n";
      try {
        child.kill();
      } catch {
        // уже мёртв
      }
    }, INSTALL_TIMEOUT_MS);
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => {
      clearTimeout(timer);
      output += "\n" + (error?.message || String(error));
      finish(-1);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish(code ?? -1);
    });
  });
}

// Автоустановка rlm-tools-bsl в папку плагина: uv берётся из PATH, при отсутствии — ставится
// официальным скриптом внутрь bin/, затем инструмент ставится с каталогами внутри DIR.
async function autoInstall(rt) {
  rt.installing = true;
  try {
    mkdirSync(DIR, { recursive: true });
    let uv = detectUv();
    if (!uv) {
      logInfo(rt, "uv не найден — ставлю его в " + TOOL_BIN_DIR);
      const boot = await runToLog("powershell", ["-NoProfile", "-ExecutionPolicy", "ByPass", "-Command", UV_INSTALL_SCRIPT], {
        env: { ...process.env, UV_INSTALL_DIR: TOOL_BIN_DIR, UV_NO_MODIFY_PATH: "1", UV_DISABLE_UPDATE: "1" },
      });
      if (boot.code !== 0) {
        rt.lastError = `uv не найден, а установить его не удалось (код ${boot.code}); вывод — в хвосте лога. Поставьте uv вручную: powershell -ExecutionPolicy ByPass -c "${UV_INSTALL_SCRIPT}"`;
        return "";
      }
      uv = detectUv();
    }
    if (!uv) {
      rt.lastError = "uv не найден и после установки; укажите его в PATH или поставьте вручную";
      return "";
    }
    logInfo(rt, `устанавливаю ${SERVER_NAME} через uv в ${DIR}`);
    const result = await runToLog(uv, ["tool", "install", SERVER_NAME], {
      env: {
        ...process.env,
        UV_TOOL_DIR: TOOL_DIR,
        UV_TOOL_BIN_DIR: TOOL_BIN_DIR,
        UV_PYTHON_INSTALL_DIR: PYTHON_DIR,
        UV_NO_MODIFY_PATH: "1",
      },
    });
    if (result.code !== 0) {
      rt.lastError = `установка ${SERVER_NAME} не удалась (код ${result.code}); вывод — в хвосте лога (если включена файловая песочница DSH — разрешите запись в ${DIR})`;
      return "";
    }
    const installed = detectCommand(true);
    if (!installed) rt.lastError = `установка прошла, но исполняемый файл не найден в ${TOOL_BIN_DIR}`;
    return installed;
  } finally {
    rt.installing = false;
  }
}

async function startServer(rt) {
  if (rt.child || rt.adopted || rt.starting) return snapshot(rt);
  rt.starting = true;
  rt.lastError = null;
  rt.lastExit = null;
  rt.version = null;
  try {
    const { config } = effectiveConfig(rt, true);

    const existing = await probeIdentity(config.port, 1500);
    if (existing.ok) {
      // Сервер уже поднят (остался от прошлой сессии) — второй не запускаем.
      const owner = portOwner(config.port, true);
      rt.adopted = { pid: rlmProcessTop(owner?.pid), listener: owner?.pid ?? null };
      rt.version = existing.version;
      rt.startedAt = Date.now();
      if (config.mcpAutoRegister) rt.mcpRegistration = registerInManagers(`http://${HOST}:${config.port}/mcp`);
      logInfo(rt, `сервер уже работает (pid ${rt.adopted.pid ?? "?"}), подключаюсь как внешний`);
      return snapshot(rt);
    }
    if (existing.serverName) {
      rt.lastError = `порт ${config.port} занят другим MCP-сервером: ${existing.serverName}`;
      return snapshot(rt);
    }
    if (!config.command && config.autoInstall) {
      const installed = await autoInstall(rt);
      if (!installed) return snapshot(rt);
      config.command = installed;
      logInfo(rt, `установлен ${SERVER_NAME}: ${installed}`);
    }
    if (!config.command) {
      rt.lastError = `не найдена команда ${SERVER_NAME}: установите пакет (uv tool install ${SERVER_NAME}) или задайте путь ключом command в строке плагина`;
      return snapshot(rt);
    }

    mkdirSync(dirname(LOG_FILE), { recursive: true });
    try {
      if (statSync(LOG_FILE).size > LOG_ROTATE_BYTES) renameSync(LOG_FILE, LOG_FILE + ".1");
    } catch {
      // лога ещё нет
    }
    const header = `\n===== ${new Date().toISOString()} запуск: ${config.command} ${launchArgs(config).join(" ")}\n`;
    const handle = openSync(LOG_FILE, "a");
    try {
      writeFileSync(LOG_FILE, header, { encoding: "utf8", flag: "a" });
      const child = spawn(config.command, launchArgs(config), {
        cwd: DIR,
        env: { ...process.env, ...config.env },
        stdio: ["ignore", handle, handle],
        windowsHide: true,
        detached: false,
      });
      rt.child = child;
      rt.childPid = child.pid ?? null;
      rt.startedAt = Date.now();
      child.on("exit", (code, signal) => {
        if (rt.child !== child) return;
        rt.child = null;
        rt.childPid = null;
        rt.startedAt = null;
        rt.version = null;
        rt.lastExit = { code, signal: signal ?? null, at: new Date().toISOString() };
        if (!rt.stopping) rt.lastError = `процесс завершился сам (код ${code ?? signal ?? "?"}); хвост лога — ниже`;
      });
      child.on("error", (error) => {
        rt.lastError = "не удалось запустить процесс: " + (error?.message || String(error));
        // Процесс не запустился (нет pid) — состоянием не управляем, иначе статус «работает» врёт.
        if (!child.pid && rt.child === child) {
          rt.child = null;
          rt.childPid = null;
          rt.startedAt = null;
          rt.version = null;
        }
      });
    } finally {
      closeSync(handle);
    }

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!rt.child) break;
      // spawn не удался (нет файла/прав): pid нет, ждать 30 секунд незачем
      if (!rt.childPid && rt.lastError) break;
      const probe = await probeIdentity(config.port, 1500);
      if (probe.ok) {
        rt.version = probe.version;
        logInfo(rt, `сервер поднят на ${HOST}:${config.port} (v${probe.version ?? "?"})`);
        break;
      }
      await sleep(400);
    }
    if (rt.version && config.mcpAutoRegister) {
      rt.mcpRegistration = registerInManagers(`http://${HOST}:${config.port}/mcp`);
      const touched = rt.mcpRegistration.filter((item) => item.action && item.action !== "unchanged").map((item) => item.manager);
      if (touched.length) logInfo(rt, "MCP-запись обновлена: " + touched.join(", "));
    }
    if (!rt.version) {
      if (!rt.lastError) {
        const owner = portOwner(config.port, true);
        rt.lastError = owner && owner.pid !== rt.childPid
          ? `порт ${config.port} занят процессом ${owner.image ?? "?"} (pid ${owner.pid})`
          : `сервер не ответил за ${Math.round(START_TIMEOUT_MS / 1000)} с; хвост лога — ниже`;
      }
      rt.lastError += writeHint();
    }
    return snapshot(rt);
  } finally {
    rt.starting = false;
  }
}

async function stopServer(rt) {
  const { config } = effectiveConfig(rt);
  const owned = rt.childPid;
  const adopted = rt.adopted?.pid ?? null;
  rt.stopping = true;
  try {
    if (owned) {
      killTree(owned);
    } else if (adopted && config.takeover) {
      // Сервер поднят не нами (остался от прошлой сессии): раз он на нашем порту — гасим вместе с DSH.
      killTree(adopted);
    }
    const freed = await waitPortFree(config.port, STOP_TIMEOUT_MS);
    rt.child = null;
    rt.childPid = null;
    rt.adopted = null;
    rt.version = null;
    rt.startedAt = null;
    rt.lastError = freed ? null : `порт ${config.port} всё ещё занят после остановки`;
    return snapshot(rt);
  } finally {
    rt.stopping = false;
  }
}

async function restartServer(rt) {
  const { config } = effectiveConfig(rt);
  await stopServer(rt);
  await waitPortFree(config.port, STOP_TIMEOUT_MS);
  return startServer(rt);
}
function saveSettings(rt, patch) {
  const next = { ...rt.settings };
  if (patch?.port !== undefined) {
    const port = Number(patch.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("порт должен быть целым числом 1..65535");
    next.port = port;
  }
  next.$schema = SCHEMA;
  writeJson(SETTINGS_FILE, next);
  rt.settings = readSettings();
  return next;
}

// ── плагин ─────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const rt = createRuntime(ctx, config);

  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => stopServer(rt));
  } else if (typeof ctx.on === "function") {
    ctx.on("dispose", () => stopServer(rt));
  }

  // Аварийный путь: синхронное убийство при обычном завершении процесса DSH.
  process.once("exit", () => {
    const known = rt.childPid ?? rt.adopted?.pid ?? null;
    if (known) killTree(known);
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/state",
    handler: (_req, res) => {
      try {
        json(res, 200, snapshot(rt));
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/log",
    handler: (req, res) => {
      try {
        const tail = Number(new URL(req.url, "http://127.0.0.1").searchParams.get("tail")) || 200;
        json(res, 200, { ok: true, file: LOG_FILE, lines: tailLines(LOG_FILE, Math.min(Math.max(tail, 1), 500)) });
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/start",
    handler: async (_req, res) => {
      try {
        json(res, 200, await startServer(rt));
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/stop",
    handler: async (_req, res) => {
      try {
        json(res, 200, await stopServer(rt));
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/restart",
    handler: async (_req, res) => {
      try {
        json(res, 200, await restartServer(rt));
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/save",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const before = effectiveConfig(rt).config.port;
        saveSettings(rt, body?.settings ?? {});
        const after = effectiveConfig(rt).config.port;
        json(res, 200, { ...snapshot(rt), needsRestart: before !== after && Boolean(rt.child || rt.adopted) });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  startServer(rt).catch((error) => {
    rt.lastError = "автозапуск не удался: " + (error?.message || String(error));
  });
}
