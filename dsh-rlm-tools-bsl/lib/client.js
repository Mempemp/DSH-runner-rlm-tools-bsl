// dsh-rlm-tools-bsl — клиентская половина.
//
// Вкладка «rlm-tools-bsl» в Settings: состояние сервера (запущен плагином / внешний /
// остановлен / ошибка), кнопки запуска, остановки и перезапуска, настройки запуска,
// готовый JSON для MCP-менеджера DSH и хвост лога.
window.__ModuleLoader__.load({
  id: "dsh-rlm-tools-bsl",
  factory: (require) => {
    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { useState, useEffect, useCallback } = React;

    const API = "/rlm";

    async function request(path, init) {
      const response = await fetch(API + path, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || response.statusText || "HTTP " + response.status);
      }
      return data;
    }

    const styles = {
      input: {
        boxSizing: "border-box",
        width: "100%",
        height: 30,
        padding: "0 8px",
        borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-base)",
        color: "inherit",
        font: "var(--dsw-font-s-14)",
      },
      textarea: {
        boxSizing: "border-box",
        width: "100%",
        minHeight: 54,
        padding: "6px 8px",
        borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-base)",
        color: "inherit",
        fontFamily: "monospace",
        fontSize: 12,
        resize: "vertical",
      },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: 12,
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 10,
        padding: 14,
      },
      cardTitle: { fontSize: 13, fontWeight: 600 },
      subtitle: { opacity: 0.6, fontSize: 12, marginTop: 3, lineHeight: 1.5 },
      fieldLabel: { marginBottom: 4, opacity: 0.7, fontSize: 12 },
      field: { display: "block", marginBottom: 12 },
      hint: { marginTop: 4, opacity: 0.55, fontSize: 11, lineHeight: 1.5 },
      path: { fontFamily: "monospace", fontSize: 11, opacity: 0.75, wordBreak: "break-all", userSelect: "text" },
      primaryButton: {
        flex: "0 0 auto",
        height: 30,
        padding: "0 14px",
        border: "none",
        borderRadius: 8,
        cursor: "pointer",
        background: "var(--dsw-alias-state-business-primary, #3964fe)",
        color: "#fff",
        font: "var(--dsw-font-s-14)",
      },
      secondaryButton: {
        flex: "0 0 auto",
        height: 30,
        padding: "0 12px",
        borderRadius: 8,
        cursor: "pointer",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "transparent",
        color: "inherit",
        font: "var(--dsw-font-s-14)",
      },
      dangerButton: {
        flex: "0 0 auto",
        height: 30,
        padding: "0 12px",
        borderRadius: 8,
        cursor: "pointer",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "transparent",
        color: "#e57373",
        font: "var(--dsw-font-s-14)",
      },
      log: {
        margin: 0,
        maxHeight: 260,
        overflow: "auto",
        padding: "8px 10px",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8,
        background: "rgba(127,127,127,0.08)",
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        userSelect: "text",
      },
      snippet: {
        margin: 0,
        padding: "8px 10px",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8,
        background: "rgba(127,127,127,0.08)",
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 1.5,
        userSelect: "text",
      },
    };

    function formatUptime(ms) {
      if (!ms || ms < 0) return "—";
      const total = Math.floor(ms / 1000);
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      const pad = (value) => String(value).padStart(2, "0");
      return (hours ? hours + ":" : "") + pad(minutes) + ":" + pad(seconds);
    }

    function statusBadge(server, hasError) {
      if (server.starting) return { dot: "◌", color: "#e0a030", text: "запускается…" };
      if (server.stopping) return { dot: "◌", color: "#e0a030", text: "останавливается…" };
      if (server.managed) return { dot: "●", color: "#4caf50", text: "работает — процесс плагина (pid " + server.pid + ")" };
      if (server.adopted) return { dot: "●", color: "#4caf50", text: "работает — внешний процесс (pid " + server.pid + "), подхвачен при старте" };
      if (server.portOwner) return { dot: "▲", color: "#e57373", text: "порт занят: " + (server.portOwner.image || "процесс") + " (pid " + server.portOwner.pid + ")" };
      if (hasError) return { dot: "▲", color: "#e57373", text: "ошибка" };
      return { dot: "○", color: "inherit", text: "остановлен" };
    }

    const FORM_EMPTY = {
      command: "",
      port: "",
      host: "",
      extraArgs: "",
      cwd: "",
      env: "",
      autoStart: true,
      takeover: true,
    };

    function envToText(env) {
      return Object.entries(env || {}).map(([key, value]) => key + "=" + value).join("\n");
    }

    function textToEnv(text) {
      const out = {};
      for (const line of String(text || "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const at = trimmed.indexOf("=");
        if (at <= 0) continue;
        out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
      }
      return out;
    }

    function Section() {
      const [state, setState] = useState(null);
      const [form, setForm] = useState(FORM_EMPTY);
      const [dirty, setDirty] = useState(false);
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState(false);

      const load = useCallback(async (quiet) => {
        try {
          const data = await request("/state");
          setState(data);
          if (!quiet) setStatus((current) => (current && current.kind === "error" ? null : current));
          return data;
        } catch (error) {
          if (!quiet) setStatus({ kind: "error", text: String((error && error.message) || error) });
          return null;
        }
      }, []);

      useEffect(() => {
        load();
        const timer = window.setInterval(() => load(true), 3000);
        return () => window.clearInterval(timer);
      }, [load]);

      // Форма синхронизируется с состоянием, пока пользователь её не правил:
      // иначе трёхсекундный поллинг затирал бы ввод.
      useEffect(() => {
        if (dirty || !state) return;
        setForm({
          command: state.config.command || "",
          port: String(state.config.port || ""),
          host: state.config.host || "",
          extraArgs: (state.config.extraArgs || []).join("\n"),
          cwd: state.config.cwd || "",
          env: envToText(state.config.env),
          autoStart: state.config.autoStart !== false,
          takeover: state.config.takeover !== false,
        });
      }, [state, dirty]);

      const update = (patch) => {
        setDirty(true);
        setForm((current) => ({ ...current, ...patch }));
      };

      const run = async (action, message) => {
        setBusy(true);
        try {
          const result = await action();
          if (message) setStatus({ kind: "ok", text: message });
          await load(true);
          return result;
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
          return null;
        } finally {
          setBusy(false);
        }
      };

      const start = () => run(() => request("/start", { method: "POST" }), "Сервер запущен");
      const stop = () => run(() => request("/stop", { method: "POST" }), "Сервер остановлен");
      const restart = () => run(() => request("/restart", { method: "POST" }), "Сервер перезапущен");

      const save = () =>
        run(async () => {
          const result = await request("/save", {
            method: "POST",
            body: JSON.stringify({
              settings: {
                command: form.command.trim(),
                port: Number(form.port) || undefined,
                host: form.host.trim(),
                extraArgs: form.extraArgs.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
                cwd: form.cwd.trim(),
                env: textToEnv(form.env),
                autoStart: form.autoStart,
                takeover: form.takeover,
              },
            }),
          });
          setDirty(false);
          return result;
        }, "Настройки сохранены").then((result) => {
          if (result && result.needsRestart) setStatus({ kind: "ok", text: "Настройки сохранены. Изменились параметры запуска — нажмите «Перезапустить»." });
          return result;
        });

      const detect = () =>
        run(async () => {
          const data = await request("/detect");
          if (data.detected) update({ command: data.detected });
          return data;
        }, "Путь найден");

      const freePort = () => {
        if (!state || !state.server.portOwner) return;
        const owner = state.server.portOwner;
        if (!window.confirm("Завершить процесс " + (owner.image || "?") + " (pid " + owner.pid + "), который держит порт " + state.config.port + "?")) return;
        run(() => request("/free-port", { method: "POST", body: JSON.stringify({ pid: owner.pid }) }), "Порт освобождён");
      };

      const copySnippet = () => {
        if (!state) return;
        const text = state.mcp.snippet;
        const done = () => setStatus({ kind: "ok", text: "JSON скопирован в буфер обмена" });
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, () => setStatus({ kind: "error", text: "Буфер обмена недоступен — скопируйте текст вручную" }));
        } else {
          setStatus({ kind: "error", text: "Буфер обмена недоступен — скопируйте текст вручную" });
        }
      };

      if (state === null) {
        return jsx("div", { style: { opacity: 0.7 }, children: status ? status.text : "Загрузка состояния сервера…" });
      }

      const server = state.server;
      const badge = statusBadge(server, Boolean(server.lastError));
      const patchKeys = Object.entries(state.config.sources || {})
        .filter(([, source]) => source === "patch")
        .map(([key]) => key);
      const statusLine = status
        ? jsx("div", {
            style: { fontSize: 12, color: status.kind === "ok" ? "#4caf50" : "#e57373" },
            children: status.text,
          })
        : null;

      return jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 16, maxWidth: 900 }, children: [
        jsxs("div", { children: [
          jsx("div", { style: { fontSize: 14, fontWeight: 600 }, children: "rlm-tools-bsl" }),
          jsx("div", { style: styles.subtitle, children: "MCP-сервер анализа кода 1С (BSL) поднимается вместе с DSH и гасится вместе с ним. Инструменты подключаются к DSH как MCP-сервер — блок с готовым JSON ниже." }),
        ]}),
        statusLine,
        jsxs("div", { style: styles.card, children: [
          jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }, children: [
            jsxs("div", { style: { minWidth: 0 }, children: [
              jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
                jsx("span", { style: { color: badge.color, fontSize: 14 }, children: badge.dot }),
                jsx("span", { style: { fontSize: 13, fontWeight: 600 }, children: badge.text }),
              ]}),
              jsx("div", { style: styles.path, children: server.url }),
            ]}),
            jsxs("div", { style: { display: "flex", gap: 8, flex: "0 0 auto" }, children: [
              jsx("button", { type: "button", style: styles.secondaryButton, disabled: busy, onClick: () => load(), children: "Обновить" }),
              server.running || server.starting
                ? jsx("button", { type: "button", style: styles.secondaryButton, disabled: busy, onClick: restart, children: "Перезапустить" })
                : jsx("button", { type: "button", style: styles.primaryButton, disabled: busy, onClick: start, children: "Запустить" }),
              server.running
                ? jsx("button", { type: "button", style: styles.dangerButton, disabled: busy, onClick: stop, children: "Остановить" })
                : null,
              server.portOwner
                ? jsx("button", { type: "button", style: styles.dangerButton, disabled: busy, onClick: freePort, children: "Освободить порт" })
                : null,
            ]}),
          ]}),
          jsxs("div", { style: { display: "flex", gap: 24, flexWrap: "wrap", fontSize: 12, opacity: 0.75 }, children: [
            jsx("span", { children: "версия: " + (server.version || "—") }),
            jsx("span", { children: "порт: " + state.config.port }),
            jsx("span", { children: "pid: " + (server.pid || "—") }),
            jsx("span", { children: "работает: " + formatUptime(server.uptimeMs) }),
            jsx("span", { children: "автозапуск: " + (state.config.autoStart ? "включён" : "выключен") }),
          ]}),
          server.lastError
            ? jsx("div", { style: { fontSize: 12, color: "#e57373", lineHeight: 1.5 }, children: server.lastError })
            : server.lastExit
              ? jsx("div", { style: { fontSize: 12, opacity: 0.6 }, children: "последний выход процесса: код " + (server.lastExit.code ?? "?") + " в " + server.lastExit.at })
              : null,
          jsx("div", { style: styles.hint, children: "Лог процесса: " + state.paths.log }),
        ]}),
        jsxs("div", { style: styles.card, children: [
          jsx("div", { style: styles.cardTitle, children: "Настройки запуска" }),
          jsxs("div", { style: styles.field, children: [
            jsx("div", { style: styles.fieldLabel, children: "Исполняемый файл" }),
            jsxs("div", { style: { display: "flex", gap: 8 }, children: [
              jsx("input", {
                style: styles.input,
                value: form.command,
                placeholder: state.config.detected || "C:\\Users\\user\\.local\\bin\\rlm-tools-bsl.exe",
                onChange: (event) => update({ command: event.target.value }),
              }),
              jsx("button", { type: "button", style: styles.secondaryButton, disabled: busy, onClick: detect, children: "Определить" }),
            ]}),
            jsx("div", { style: styles.hint, children: state.config.detected
              ? "Найдено: " + state.config.detected
              : "В PATH не найдено — установите пакет (uv tool install rlm-tools-bsl) или укажите путь руками." }),
          ]}),
          jsxs("div", { style: { display: "flex", gap: 12 }, children: [
            jsxs("div", { style: { flex: "0 0 140px", marginBottom: 12 }, children: [
              jsx("div", { style: styles.fieldLabel, children: "Порт" }),
              jsx("input", {
                style: styles.input,
                value: form.port,
                placeholder: "9330",
                onChange: (event) => update({ port: event.target.value }),
              }),
            ]}),
            jsxs("div", { style: { flex: "1 1 0", minWidth: 0, marginBottom: 12 }, children: [
              jsx("div", { style: styles.fieldLabel, children: "Хост" }),
              jsx("input", {
                style: styles.input,
                value: form.host,
                placeholder: "127.0.0.1",
                onChange: (event) => update({ host: event.target.value }),
              }),
            ]}),
          ]}),
          jsxs("div", { style: styles.field, children: [
            jsx("div", { style: styles.fieldLabel, children: "Дополнительные аргументы — по одному в строке" }),
            jsx("textarea", {
              style: styles.textarea,
              value: form.extraArgs,
              placeholder: "--log-level\ndebug",
              onChange: (event) => update({ extraArgs: event.target.value }),
            }),
          ]}),
          jsxs("div", { style: styles.field, children: [
            jsx("div", { style: styles.fieldLabel, children: "Переменные окружения — KEY=VALUE, по одной в строке" }),
            jsx("textarea", {
              style: styles.textarea,
              value: form.env,
              placeholder: "RLM_CONFIG_FILE=D:\\portable\\rlm\\config\\service.json\nRLM_INDEX_DIR=D:\\portable\\rlm\\index",
              onChange: (event) => update({ env: event.target.value }),
            }),
            jsx("div", { style: styles.hint, children: "Для «чистого portable» перенесите конфиги и индексы внутрь своей папки через RLM_CONFIG_FILE / RLM_INDEX_DIR." }),
          ]}),
          jsxs("div", { style: styles.field, children: [
            jsx("div", { style: styles.fieldLabel, children: "Рабочий каталог" }),
            jsx("input", {
              style: styles.input,
              value: form.cwd,
              placeholder: state.paths.dir,
              onChange: (event) => update({ cwd: event.target.value }),
            }),
            jsx("div", { style: styles.hint, children: "Из этого каталога сервер читает .env. Пусто — " + state.paths.dir }),
          ]}),
          jsxs("div", { style: { display: "flex", gap: 16, flexWrap: "wrap" }, children: [
            jsxs("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }, children: [
              jsx("input", { type: "checkbox", checked: form.autoStart, onChange: (event) => update({ autoStart: event.target.checked }) }),
              "поднимать при старте DSH",
            ]}),
            jsxs("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }, children: [
              jsx("input", { type: "checkbox", checked: form.takeover, onChange: (event) => update({ takeover: event.target.checked }) }),
              "гасить вместе с DSH даже подхваченный процесс",
            ]}),
          ]}),
          patchKeys.length
            ? jsx("div", { style: styles.hint, children: "Значения из cordis.patch.yml (действуют, пока поле не сохранено во вкладке): " + patchKeys.join(", ") })
            : null,
          jsxs("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 }, children: [
            jsx("button", { type: "button", style: styles.primaryButton, disabled: busy || !dirty, onClick: save, children: "Сохранить" }),
            jsx("button", { type: "button", style: styles.secondaryButton, disabled: busy || !dirty, onClick: () => { setDirty(false); load(true); }, children: "Отменить" }),
            jsx("span", { style: { opacity: 0.55, fontSize: 11 }, children: dirty ? "есть несохранённые изменения" : "файл: " + state.paths.settings }),
          ]}),
        ]}),
        jsxs("div", { style: styles.card, children: [
          jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }, children: [
            jsx("div", { style: styles.cardTitle, children: "Подключение к DSH" }),
            jsx("button", { type: "button", style: styles.secondaryButton, onClick: copySnippet, children: "Скопировать JSON" }),
          ]}),
          jsxs("div", { style: { fontSize: 12, lineHeight: 1.6, opacity: 0.8 }, children: [
            jsx("div", { children: "Инструменты сервера попадают в DSH как MCP-сервер. Добавьте его один раз — через Settings → MCP Server Manager (кнопка Add) или строкой в ~/.dsh/mcp-servers.json:" }),
          ]}),
          jsx("pre", { style: styles.snippet, children: state.mcp.snippet }),
          jsx("div", { style: styles.hint, children: "serverName «" + state.mcp.serverName + "» даёт инструменты mcp__" + state.mcp.serverName + "__rlm_start, mcp__" + state.mcp.serverName + "__rlm_execute и остальные. Подключение MCP-менеджер выполняет сам — плагин отвечает только за запуск и остановку сервера." }),
        ]}),
        jsxs("div", { style: styles.card, children: [
          jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }, children: [
            jsx("div", { style: styles.cardTitle, children: "Лог процесса (stdout и stderr)" }),
            jsx("a", { href: API + "/log?tail=500", target: "_blank", rel: "noreferrer", style: { fontSize: 12, opacity: 0.7, color: "inherit" }, children: "открыть полностью" }),
          ]}),
          jsx("pre", { style: styles.log, children: (state.logTail || []).join("\n") || "лог пуст" }),
          jsx("div", { style: styles.hint, children: "Обновляется вместе со статусом; у самого сервера есть свой лог — " + state.paths.dir + "\\logs и %USERPROFILE%\\.config\\rlm-tools-bsl\\logs\\server.log" }),
        ]}),
      ]});
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "rlm-tools-bsl",
            order: 56,
            label: () => "rlm-tools-bsl",
            registrant: "dsh-rlm-tools-bsl",
          },
          Section,
        ),
      );
    }

    return { apply, inject: ["slots"] };
  },
});
