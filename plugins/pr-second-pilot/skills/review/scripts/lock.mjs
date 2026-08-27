// Per-target lock with a lease. Two runs on the same PR must not interleave
// writes to the same state file.
//
// Захват, который не удался, завершается кодом 3 — а не нулём. Операционные
// отказы в этом плагине принято отдавать как `ok:false` с кодом 0, но для лока
// это ловушка: shell-обёртка с `set -e` спокойно едет дальше без лока, раунд
// отрабатывает, а запись состояния потом отказывается его принять. Ровно так
// один живой раунд ушёл в пустоту. Для acquire шелловая семантика важнее
// единообразия.
//
//   node lock.mjs --acquire --lock <path> --session <id> [--lease-min 30]
//   node lock.mjs --refresh --lock <path> --session <id>
//   node lock.mjs --release --lock <path> --session <id>
//   node lock.mjs --status  --lock <path>

import { emit, bail, parseArgs, readJson, writeJsonAtomic, rm, nowIso } from "./lib.mjs";

function isStale(lock, leaseMin) {
  const age = (Date.now() - new Date(lock.refreshed_at || lock.acquired_at).getTime()) / 60000;
  return age > leaseMin;
}

function main() {
  const args = parseArgs();
  const lockPath = args.lock;
  if (!lockPath) bail("lock_path_missing");
  const leaseMin = Number(args["lease-min"] || 30);
  const session = args.session;
  const existing = readJson(lockPath);

  if (args.status) {
    emit({
      ok: true,
      held: !!existing,
      stale: existing ? isStale(existing, leaseMin) : false,
      lock: existing,
    });
    return;
  }

  if (!session) bail("session_missing");

  if (args.acquire) {
    if (existing && existing.session !== session && !isStale(existing, leaseMin)) {
      emit({
        ok: false,
        error: "locked",
        detail: `Цель уже обрабатывается сессией ${existing.session} с ${existing.acquired_at}. ` +
                `Лиз истечёт через ${Math.max(0, Math.ceil(leaseMin - (Date.now() - new Date(existing.refreshed_at || existing.acquired_at).getTime()) / 60000))} мин.`,
        lock: existing,
      });
      process.exit(3);
    }
    const took_over = !!(existing && existing.session !== session);
    const lock = {
      session,
      pid: process.pid,
      acquired_at: existing?.session === session ? existing.acquired_at : nowIso(),
      refreshed_at: nowIso(),
      lease_minutes: leaseMin,
    };
    writeJsonAtomic(lockPath, lock);
    emit({ ok: true, acquired: true, took_over_stale: took_over, lock });
    return;
  }

  if (args.refresh) {
    if (!existing) { emit({ ok: false, error: "lock_missing" }); return; }
    if (existing.session !== session) {
      emit({ ok: false, error: "lock_session_mismatch", detail: `лок принадлежит ${existing.session}`, lock: existing });
      return;
    }
    writeJsonAtomic(lockPath, { ...existing, refreshed_at: nowIso(), pid: process.pid });
    emit({ ok: true, refreshed: true });
    return;
  }

  if (args.release) {
    if (existing && existing.session !== session) {
      // Чужой лок не снимаем — но и молчать нельзя: вызывающий, проверяющий
      // только код выхода, решит, что снял. Код 3, как у неудачного захвата.
      emit({
        ok: false, error: "lock_session_mismatch", lock: existing,
        detail: `Лок принадлежит сессии ${existing.session}, а снять просят от ${session}.`,
      });
      process.exit(3);
    }
    emit({ ok: true, released: rm(lockPath) });
    return;
  }

  bail("no_action", { detail: "нужен один из --acquire --refresh --release --status" });
}

main();
