// Telegram notification. Fires only on events worth interrupting someone for:
// the loop needs a decision, the loop finished, or the loop stopped early.
//
// Progress pings are deliberately not an option — a bot that reports every
// round is a bot people mute, and then the one message that mattered is missed.
//
//   node notify.mjs --event needs_human --state <path> [--repo-root <p>] [--dry-run]

import { emit, parseArgs, readJson } from "./lib.mjs";
import { loadConfig } from "./config.mjs";

const TITLES = {
  merged: "🚀 pr-second-pilot: PR смержен",
  needs_human: "⏸ pr-second-pilot: нужно твоё решение",
  allowed: "✅ pr-second-pilot: мерж разрешён",
  allowed_with_advisory: "✅ pr-second-pilot: мерж разрешён",
  rate_limited: "⏳ pr-second-pilot: лимит подписки",
  oscillating: "⚠️ pr-second-pilot: цикл не сходится",
  stuck: "⚠️ pr-second-pilot: прогресса нет",
  regressed: "⚠️ pr-second-pilot: стало хуже",
  max_rounds: "⚠️ pr-second-pilot: бюджет раундов исчерпан",
  failed: "❌ pr-second-pilot: сбой",
  stopped: "⏹ pr-second-pilot: цикл остановлен",
};

// The loop emits fine-grained statuses; the config subscribes to groups.
// Without this mapping a default config silently drops every not-converged
// outcome, which is exactly the case worth being told about.
const GROUPS = {
  allowed: ["allowed", "allowed_with_advisory"],
  stopped: ["oscillating", "stuck", "regressed", "max_rounds"],
};

function isSubscribed(event, events) {
  if (!events?.length) return true;
  if (events.includes(event)) return true;
  return events.some((e) => GROUPS[e]?.includes(event));
}

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildMessage(event, state) {
  const t = state.target || {};
  const c = state.counts || {};
  const what = t.number ? `PR #${t.number}` : `ветка ${t.head_ref ?? state.target?.slug}`;

  const lines = [`<b>${esc(TITLES[event] ?? TITLES.stopped)}</b>`, ""];
  lines.push(`${esc(what)}${t.title ? ` — ${esc(t.title)}` : ""}`);
  lines.push(`Раунд ${state.round}, блокеров: ${c.blocking ?? 0}`);

  if (state.last_stop?.human_note) {
    lines.push("", `<blockquote>${esc(state.last_stop.human_note.slice(0, 700))}</blockquote>`);
  }

  if (event === "needs_human") {
    const disputes = (state.findings || []).filter((f) => f.status === "disputed" || (f.dispute_rounds || 0) > 0);
    if (disputes.length) {
      lines.push("", "<b>Спорные:</b>");
      for (const f of disputes.slice(0, 5)) lines.push(`• <code>${esc(f.id)}</code> ${esc(f.title)}`);
    }
  }

  if (event === "merged") {
    lines.push("", `Метод: ${esc(state.merge?.method ?? "—")}${state.merge?.branch_deleted ? ", ветка удалена" : ""}`);
    lines.push(`Коммит: <code>${esc((state.merge?.head_sha ?? "").slice(0, 12))}</code>`);
  }

  if (event === "allowed" || event === "allowed_with_advisory") {
    const closed = (state.findings || []).filter((f) => f.status === "verified").length;
    lines.push(`Закрыто замечаний: ${closed}`);
    if (c.advisory) lines.push(`Осталось необязательных: ${c.advisory}`);
  }

  if (event === "rate_limited" && state.last_stop?.reset_hint) {
    lines.push("", `Сброс лимита: ${esc(state.last_stop.reset_hint)}`);
  }

  if (t.url) lines.push("", `<a href="${esc(t.url)}">Открыть PR</a>`);
  lines.push("", `<code>${esc(state.paths?.report ?? "")}</code>`);
  return lines.join("\n");
}

async function send(token, chatId, text, silent) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      disable_notification: !!silent,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.ok !== false, status: res.status, description: body.description ?? null };
}

async function main() {
  const args = parseArgs();
  const event = args.event;
  if (!event) { emit({ ok: false, error: "arg_missing", missing: "--event" }); return; }

  const state = args.state ? readJson(args.state) : null;
  if (!state) { emit({ ok: false, error: "state_unreadable", path: args.state }); return; }

  const cfg = args["config-json"]
    ? JSON.parse(args["config-json"])
    : loadConfig(args["repo-root"] || state.repo_root).config;
  const tg = cfg.notify?.telegram ?? {};

  if (!tg.enabled) { emit({ ok: true, skipped: "telegram_disabled" }); return; }
  if (!isSubscribed(event, tg.events)) {
    emit({ ok: true, skipped: "event_not_subscribed", event, subscribed: tg.events });
    return;
  }

  const token = tg.bot_token || process.env[tg.bot_token_env];
  const chatId = tg.chat_id || process.env[tg.chat_id_env];
  if (!token || !chatId) {
    emit({ ok: false, error: "telegram_not_configured", missing: !token ? "bot_token" : "chat_id" });
    return;
  }

  const text = buildMessage(event, state);
  if (args["dry-run"]) { emit({ ok: true, dry_run: true, event, text }); return; }

  try {
    const r = await send(token, chatId, text, tg.silent);
    // A failed notification must never take the loop down with it.
    emit({ ok: r.ok, event, telegram: r });
  } catch (e) {
    emit({ ok: false, event, error: "telegram_request_failed", detail: String(e) });
  }
}

main();
