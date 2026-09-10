// dsh-rlm-tools-bsl — клиентская половина.
//
// Компактная вкладка «rlm-tools-bsl» в Settings: статус сервера, кнопка перезапуска,
// порт и готовый JSON для MCP-менеджера DSH. Больше ничего — настройка сервера
// живёт в его собственных конфигах.
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
        width: 110,
        height: 30,
        padding: "0 8px",
        borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-base)",
        color: "inherit",
        font: "var(--dsw-font-s-14)",
      },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: 10,
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 10,
        padding: 14,
      },
      row: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      subtitle: { opacity: 0.6, fontSize: 12, marginTop: 3, lineHeight: 1.5 },
      hint: { opacity: 0.55, fontSize: 11, lineHeight: 1.5 },
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
      log: {
        margin: "4px 0 0",
        maxHeight: 150,
        overflow: "auto",
        padding: "6px 8px",
        borderRadius: 8,
        background: "rgba(127,127,127,0.08)",
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        userSelect: "text",
      },
    };

    function badge(server) {
      if (server.starting) return { dot: "◌", color: "#e0a030", text: "запускается…" };
      if (server.stopping) return { dot: "◌", color: "#e0a030", text: "останавливается…" };
      if (server.managed) return { dot: "●", color: "#4caf50", text: "работает (pid " + server.pid + (server.version ? ", v" + server.version : "") + ")" };
      if (server.adopted) return { dot: "●", color: "#4caf50", text: "работает — внешний процесс (pid " + server.pid + "), подхвачен при старте" };
      if (server.portOwner) return { dot: "▲", color: "#e57373", text: "порт " + server.portOwner.pid + " занят: " + (server.portOwner.image || "процесс") };
      return { dot: "○", color: "inherit", text: "остановлен" };
    }

    function Section() {
      const [state, setState] = useState(null);
      const [port, setPort] = useState("");
      const [dirty, setDirty] = useState(false);
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState(false);

      const load = useCallback(async () => {
        try {
          const data = await request("/state");
          setState(data);
          return data;
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
          return null;
        }
      }, []);

      useEffect(() => {
        load();
        const timer = window.setInterval(load, 3000);
        return () => window.clearInterval(timer);
      }, [load]);

      useEffect(() => {
        if (!state || dirty) return;
        setPort(String(state.config.port || ""));
      }, [state, dirty]);

      const run = async (action, message) => {
        setBusy(true);
        try {
          const result = await action();
          if (message) setStatus({ kind: "ok", text: message });
          return result;
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
          return null;
        } finally {
          setBusy(false);
          await load();
        }
      };

      const restart = () => run(() => request("/restart", { method: "POST" }), "Сервер перезапущен");

      const savePort = () =>
        run(async () => {
          const result = await request("/save", { method: "POST", body: JSON.stringify({ settings: { port: Number(port) } }) });
          setDirty(false);
          return result;
        }, "Порт сохранён").then((result) => {
          if (result && result.needsRestart) setStatus({ kind: "ok", text: "Порт сохранён — нажмите «Перезапустить», затем обновите URL в MCP-менеджере." });
          return result;
        });

      const copySnippet = () => {
        if (!state) return;
        const done = () => setStatus({ kind: "ok", text: "JSON скопирован" });
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(state.mcp.snippet).then(done, () => setStatus({ kind: "error", text: "Буфер обмена недоступен" }));
        } else {
          setStatus({ kind: "error", text: "Буфер обмена недоступен — скопируйте текст вручную" });
        }
      };

      if (state === null) {
        return jsx("div", { style: { opacity: 0.7 }, children: status ? status.text : "Загрузка состояния сервера…" });
      }

      const server = state.server;
      const info = badge(server);
      const logLines = (state.logTail || []).filter((line) => line.trim()).slice(-10).join("\n");
      const statusLine = status
        ? jsx("div", { style: { fontSize: 12, color: status.kind === "ok" ? "#4caf50" : "#e57373" }, children: status.text })
        : null;

      return jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 }, children: [
        jsxs("div", { children: [
          jsx("div", { style: { fontSize: 14, fontWeight: 600 }, children: "rlm-tools-bsl" }),
          jsx("div", { style: styles.subtitle, children: "Сервер анализа кода 1С (MCP) поднимается вместе с DSH и гасится вместе с ним." }),
        ]}),
        statusLine,
        jsxs("div", { style: styles.card, children: [
          jsxs("div", { style: styles.row, children: [
            jsx("span", { style: { color: info.color, fontSize: 14 }, children: info.dot }),
            jsx("span", { style: { fontSize: 13, fontWeight: 600 }, children: info.text }),
            jsx("div", { style: { flex: "1 1 auto" } }),
            jsx("button", { type: "button", style: styles.secondaryButton, disabled: busy, onClick: restart, children: "Перезапустить" }),
          ]}),
          jsx("div", { style: styles.path, children: server.url }),
          server.lastError
            ? jsxs("div", { children: [
                jsx("div", { style: { fontSize: 12, color: "#e57373", lineHeight: 1.5 }, children: server.lastError }),
                logLines ? jsx("pre", { style: styles.log, children: logLines }) : null,
              ]})
            : null,
        ]}),
        jsxs("div", { style: styles.card, children: [
          jsxs("div", { style: styles.row, children: [
            jsx("span", { style: { fontSize: 13, fontWeight: 600 }, children: "Порт" }),
            jsx("input", {
              style: styles.input,
              value: port,
              onChange: (event) => {
                setDirty(true);
                setPort(event.target.value);
              },
            }),
            jsx("button", { type: "button", style: styles.primaryButton, disabled: busy || !dirty, onClick: savePort, children: "Сохранить" }),
          ]}),
          jsx("div", { style: styles.hint, children: "Порт попадает в URL сервера — после смены перезапустите сервер и обновите его в MCP-менеджере." }),
        ]}),
        jsxs("div", { style: styles.card, children: [
          jsxs("div", { style: styles.row, children: [
            jsx("span", { style: { fontSize: 13, fontWeight: 600 }, children: "Подключение к DSH" }),
            jsx("span", { style: styles.hint, children: "Settings → MCP Server Manager → Add" }),
            jsx("div", { style: { flex: "1 1 auto" } }),
            jsx("button", { type: "button", style: styles.secondaryButton, onClick: copySnippet, children: "Скопировать JSON" }),
          ]}),
          jsx("pre", { style: styles.snippet, children: state.mcp.snippet }),
          jsx("div", { style: styles.hint, children: "Инструменты появятся как mcp__" + state.mcp.serverName + "__rlm_start, mcp__" + state.mcp.serverName + "__rlm_execute и т. д." }),
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
