// E2E хост-половины без DSH: мок ctx (webServer.register записывается) + реальный http-сервер,
// поверх — настоящий rlm-tools-bsl. Проверяет запуск, подхват внешнего процесса, перезапуск,
// остановку и роуты. Настройки и логи пишутся в отдельный DSH_HOME во временном каталоге.
//
// Запуск: node tests/_http.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9331;
const DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-rlm-test-"));
process.env.DSH_HOME = DSH_HOME;

const checks = [];
function check(name, ok, details) {
  checks.push({ name, ok: Boolean(ok) });
  console.log((ok ? "PASS" : "FAIL") + " — " + name + (details ? "  [" + details + "]" : ""));
}

function binPath() {
  const probe = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(probe, ["rlm-tools-bsl"], { encoding: "utf8", windowsHide: true });
  if (found.status === 0) {
    const first = String(found.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  const portable = join(homedir(), ".local", "bin", process.platform === "win32" ? "rlm-tools-bsl.exe" : "rlm-tools-bsl");
  return existsSync(portable) ? portable : null;
}

async function reachable(url, timeoutMs = 1500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

const command = binPath();
if (!command) {
  console.log("SKIP — rlm-tools-bsl не найден (uv tool install rlm-tools-bsl)");
  process.exit(2);
}

// ── мок DSH-контекста ──────────────────────────────────────────────────────

const routes = [];
const disposers = [];
const ctx = {
  webServer: { register: (spec) => routes.push(spec) },
  effect: (factory) => {
    const dispose = factory();
    if (typeof dispose === "function") disposers.push(dispose);
  },
  on: () => {},
  logger: { info: (message) => console.log("  host: " + message) },
};

const plugin = await import(new URL("../lib/index.js", import.meta.url).href);
plugin.apply(ctx, { autoStart: false, port: PORT, command });

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = routes.find((item) => item.kind === "exact" && item.path === url.pathname);
  if (!route) {
    res.writeHead(404, { "content-type": "application/json" }).end('{"ok":false,"error":"no route"}');
    return;
  }
  await route.handler(req, res);
});
await new Promise((done) => httpServer.listen(0, "127.0.0.1", done));
const base = "http://127.0.0.1:" + httpServer.address().port;

async function api(path, init) {
  const response = await fetch(base + path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

let exitCode = 0;
try {
  // ── 1. состояние до запуска ──────────────────────────────────────────────
  const state0 = await api("/rlm/state");
  check("GET /rlm/state отвечает ok", state0.status === 200 && state0.data?.ok === true);
  check("до запуска сервер не работает", state0.data.server.running === false);
  check("порт свободен", state0.data.server.portOwner === null, JSON.stringify(state0.data.server.portOwner));
  check("команда определена в конфиге", state0.data.config.command === command, state0.data.config.command);
  check("порт из конфига строки плагина", state0.data.config.port === PORT);
  check("сниппет MCP содержит URL", state0.data.mcp.snippet.includes(`http://127.0.0.1:${PORT}/mcp`));

  // ── 2. запуск ────────────────────────────────────────────────────────────
  const started = await api("/rlm/start", { method: "POST" });
  check("POST /rlm/start запускает сервер", started.data?.server?.running === true && started.data.server.managed === true);
  check("pid получен", Number.isInteger(started.data.server.pid) && started.data.server.pid > 0, String(started.data.server.pid));
  check("версия прочитана из MCP initialize", /^\d+\.\d+/.test(String(started.data.server.version)), String(started.data.server.version));
  check("health сервера отвечает", await reachable(`http://127.0.0.1:${PORT}/health`));

  // повторный start идемпотентен
  const again = await api("/rlm/start", { method: "POST" });
  check("повторный start не поднимает второй процесс", again.data.server.managed === true && again.data.server.pid === started.data.server.pid);

  // ── 3. лог и настройки ───────────────────────────────────────────────────
  const log = await api("/rlm/log?tail=50");
  check("GET /rlm/log отдаёт строки", log.status === 200 && Array.isArray(log.data.lines) && log.data.lines.length > 0, "строк: " + (log.data?.lines?.length ?? 0));
  check("в логе есть заголовок запуска", (log.data.lines || []).some((line) => line.includes("запуск:")));

  const saved = await api("/rlm/save", { method: "POST", body: JSON.stringify({ settings: { port: PORT, host: "127.0.0.1", autoStart: false } }) });
  check("POST /rlm/save сохраняет без перезапуска", saved.status === 200 && saved.data.needsRestart === false);
  const settingsFile = join(DSH_HOME, "rlm-tools-bsl", "settings.json");
  check("settings.json записан", existsSync(settingsFile) && JSON.parse(readFileSync(settingsFile, "utf-8")).port === PORT, settingsFile);

  const badSave = await api("/rlm/save", { method: "POST", body: JSON.stringify({ settings: { port: "не-число" } }) });
  check("save с плохим портом отклоняется", badSave.status === 400);

  // ── 4. перезапуск ────────────────────────────────────────────────────────
  const restarted = await api("/rlm/restart", { method: "POST" });
  check("POST /rlm/restart поднимает сервер заново", restarted.data?.server?.running === true);
  check("pid после перезапуска другой", restarted.data.server.pid !== started.data.server.pid, `${started.data.server.pid} → ${restarted.data.server.pid}`);

  // ── 5. остановка ─────────────────────────────────────────────────────────
  const stopped = await api("/rlm/stop", { method: "POST" });
  check("POST /rlm/stop гасит сервер", stopped.data?.server?.running === false && stopped.data.server.lastError === null);
  check("порт освобождён", !(await reachable(`http://127.0.0.1:${PORT}/health`)));

  // ── 6. подхват внешнего процесса и takeover ──────────────────────────────
  const external = spawn(command, ["--transport", "streamable-http", "--host", "127.0.0.1", "--port", String(PORT)], {
    stdio: "ignore",
    windowsHide: true,
    detached: false,
  });
  const ready = Date.now() + 20000;
  while (Date.now() < ready && !(await reachable(`http://127.0.0.1:${PORT}/health`))) {
    await new Promise((done) => setTimeout(done, 400));
  }
  check("внешний процесс поднялся (подготовка сценария)", await reachable(`http://127.0.0.1:${PORT}/health`));

  const adopted = await api("/rlm/start", { method: "POST" });
  check("start подхватывает внешний процесс", adopted.data?.server?.adopted === true && adopted.data.server.managed === false);
  check("версия внешнего процесса прочитана", /^\d+\.\d+/.test(String(adopted.data.server.version)));

  const takenOver = await api("/rlm/stop", { method: "POST" });
  check("stop гасит и подхваченный процесс (takeover)", takenOver.data?.server?.running === false);
  check("порт внешнего процесса освобождён", !(await reachable(`http://127.0.0.1:${PORT}/health`)));
  try {
    external.kill();
  } catch {
    // уже убит через taskkill
  }

  // ── 7. остановка DSH гасит управляемый процесс ───────────────────────────
  const beforeDispose = await api("/rlm/start", { method: "POST" });
  check("сервер поднят для проверки dispose", beforeDispose.data?.server?.running === true && beforeDispose.data.server.managed === true);
  for (const dispose of disposers) await dispose();
  check("dispose гасит управляемый процесс", !(await reachable(`http://127.0.0.1:${PORT}/health`)));
} catch (error) {
  console.log("FAIL — исключение в сценарии: " + (error?.stack || error));
  exitCode = 1;
} finally {
  await new Promise((done) => httpServer.close(done));
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      console.log("disposer: " + error);
    }
  }
}

const failed = checks.filter((item) => !item.ok);
console.log("\n" + (checks.length - failed.length) + "/" + checks.length + " проверок пройдено");
if (failed.length) exitCode = 1;
console.log("DSH_HOME теста: " + DSH_HOME);
process.exit(exitCode);
