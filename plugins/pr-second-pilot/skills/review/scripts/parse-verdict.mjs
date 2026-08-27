// Parse a reviewer's text into structured findings.
//
// The contract lives in references/verdict-contract.md. This parser is the
// implementation of it, and is deliberately lenient about decoration (bold,
// backticks, bullet markers) while strict about the things the loop depends
// on: the verdict word, the severity, and the presence of a failure mechanism.
//
//   node parse-verdict.mjs --source tech-lead [--files-json '<json>'] < text
//   node parse-verdict.mjs --self-test

import { emit, bail, parseArgs, readStdin, sha1 } from "./lib.mjs";

const VERDICTS = ["ALLOW", "BLOCK", "NEEDS_HUMAN"];
const SEVERITIES = ["critical", "major", "minor", "nit"];

// The two reviewer skills speak different severity dialects. Everything
// downstream — blocking counts, stop conditions, the report — assumes one.
const SEVERITY_ALIASES = {
  critical: "critical", blocker: "critical", p0: "critical",
  high: "major", major: "major", p1: "major",
  medium: "minor", moderate: "minor", minor: "minor", p2: "minor",
  low: "nit", info: "nit", nit: "nit", nitpick: "nit", style: "nit", p3: "nit",
};

const FIELD_ALIASES = {
  file: "file", "file/section": "file", location: "file", where: "file", файл: "file",
  trigger: "trigger", триггер: "trigger",
  mechanism: "mechanism", problem: "mechanism", механизм: "mechanism", проблема: "mechanism",
  consequence: "consequence", impact: "consequence", последствие: "consequence",
  required: "required", "suggested fix": "required", fix: "required", "required fix": "required", требуется: "required",
  proof: "proof", test: "proof", тест: "proof",
};

const strip = (s) => String(s ?? "")
  .replace(/\*\*/g, "")
  .replace(/`/g, "")
  .replace(/^\s*[-*•]\s*/, "")
  .trim();

// Слова, означающие «это опять то же самое». Ревьюер добавляет их во втором
// раунде («отказ ВСЁ ЕЩЁ подтверждается как успех»), заголовок меняется, хеш
// расходится — и то же самое замечание приезжает с новым id. Дедупликация по
// стабильным id рассчитана ровно на этот случай, поэтому признак повторности
// из идентичности вычищается: он про историю, а не про суть дефекта.
// Границы заданы явно: `\b` в JS определён через [A-Za-z0-9_], поэтому перед
// кириллической буквой границы слова не существует и \b там не срабатывает.
const RECURRENCE = /(?<=^|\s)(по-прежнему|по прежнему|всё ещё|все ещё|всё также|снова|опять|вновь|как и прежде|still|again|yet|once again)(?=$|[\s.,;:!?])/gi;

const normalizeForId = (s) => String(s ?? "")
  .toLowerCase()
  .replace(/[`*_"'()\[\]]/g, "")
  .replace(RECURRENCE, " ")
  .replace(/\d+/g, "#")          // line numbers drift between rounds
  .replace(/\s+/g, " ")
  .trim();

/** Stable across rephrasings of the same defect — required for oscillation detection. */
export function findingId(file, title) {
  const filePart = normalizeForId(String(file ?? "").split(":")[0]);
  return sha1(`${filePart}::${normalizeForId(title)}`).slice(0, 8);
}

function parseVerdictLine(lines) {
  for (const line of lines.slice(0, 8)) {
    const clean = strip(line);
    if (!clean) continue;
    const m = clean.match(/^(ALLOW|BLOCK|NEEDS[_ ]HUMAN)\s*[::]\s*(.+)$/i);
    if (m) return { verdict: m[1].toUpperCase().replace(/ /g, "_"), summary: m[2].trim() };
    const bare = clean.match(/^(ALLOW|BLOCK|NEEDS[_ ]HUMAN)\s*$/i);
    if (bare) return { verdict: bare[1].toUpperCase().replace(/ /g, "_"), summary: "" };
  }
  return null;
}

function splitFindings(text) {
  const lines = text.split(/\r?\n/);
  const headerRe = /^\s*(?:[-*•]\s*)?(\d+)[.)]\s*\*{0,2}\[?\s*(?:SEVERITY\s*[::]\s*)?([A-Za-z0-9]+)\s*\]?\*{0,2}\s*[-–—:]?\s*(.*)$/;
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(headerRe);
    // A header must name a severity we recognise; otherwise it is just a
    // numbered sentence inside a prose paragraph.
    if (m && SEVERITY_ALIASES[m[2].toLowerCase()]) {
      if (cur) blocks.push(cur);
      cur = { n: Number(m[1]), rawSeverity: m[2], title: strip(m[3]), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

function parseFields(bodyLines) {
  const fields = {};
  let active = null;
  for (const raw of bodyLines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { active = null; continue; }
    const m = line.match(/^\s*\*{0,2}([A-Za-zА-Яа-я/ ]{3,20})\*{0,2}\s*[::]\s*(.*)$/);
    const key = m ? FIELD_ALIASES[m[1].trim().toLowerCase()] : null;
    if (key) {
      fields[key] = strip(m[2]);
      active = key;
    } else if (active) {
      fields[active] = `${fields[active]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

export function parse(text, { source = "reviewer", changedFiles = null } = {}) {
  const warnings = [];
  const lines = text.split(/\r?\n/);
  const head = parseVerdictLine(lines);

  if (!head) {
    return {
      verdict: "MALFORMED", reason: "no_verdict_line", source,
      summary: "", findings: [], warnings,
      raw_head: lines.filter((l) => l.trim()).slice(0, 5).join("\n"),
    };
  }

  if (head.verdict === "NEEDS_HUMAN") {
    return {
      verdict: "NEEDS_HUMAN", source,
      summary: head.summary,
      question: head.summary,
      findings: [], warnings,
    };
  }

  const blocks = splitFindings(text);
  const findings = [];
  for (const b of blocks) {
    const severity = SEVERITY_ALIASES[b.rawSeverity.toLowerCase()];
    if (!severity) { warnings.push(`finding #${b.n}: неизвестный severity "${b.rawSeverity}" — пропущен`); continue; }
    if (!b.title) { warnings.push(`finding #${b.n}: пустой заголовок — пропущен`); continue; }

    const f = parseFields(b.body);
    const file = f.file || "";
    let finalSeverity = severity;
    let unproven = false;

    // The evidence standard, enforced rather than requested: a blocking finding
    // must name a mechanism. Without one it stays in the report but stops
    // being a merge blocker, instead of being silently dropped.
    if (!f.mechanism && !f.trigger && SEVERITIES.indexOf(severity) <= 1) {
      finalSeverity = "minor";
      unproven = true;
      warnings.push(`finding #${b.n} "${b.title}": ${severity} без механизма отказа — понижен до minor`);
    }

    findings.push({
      id: findingId(file, b.title),
      n: b.n,
      source,
      severity: finalSeverity,
      declared_severity: severity,
      unproven,
      title: b.title,
      file,
      trigger: f.trigger || "",
      mechanism: f.mechanism || "",
      consequence: f.consequence || "",
      required: f.required || "",
      proof: f.proof || "",
      out_of_scope: false,
    });
  }

  if (changedFiles && Array.isArray(changedFiles) && changedFiles.length) {
    const touched = new Set(changedFiles.map((p) => String(p).toLowerCase()));
    for (const f of findings) {
      const bare = f.file.split(":")[0].replace(/^[.\/]+/, "").toLowerCase();
      if (!bare) continue;
      const inDiff = [...touched].some((t) => t.endsWith(bare) || bare.endsWith(t));
      if (!inDiff) {
        f.out_of_scope = true;
        warnings.push(`finding "${f.title}" указывает на ${f.file} — вне диффа, не блокирует`);
      }
    }
  }

  if (head.verdict === "ALLOW" && findings.length) {
    return {
      verdict: "MALFORMED", reason: "allow_with_findings", source,
      summary: head.summary, findings, warnings,
    };
  }
  if (head.verdict === "BLOCK" && findings.length === 0) {
    return {
      verdict: "MALFORMED", reason: "block_without_findings", source,
      summary: head.summary, findings: [], warnings,
      raw_head: lines.filter((l) => l.trim()).slice(0, 12).join("\n"),
    };
  }

  return { verdict: head.verdict, source, summary: head.summary, findings, warnings };
}

// ------------------------------------------------------------- self-test ---

const SAMPLE = `BLOCK: Одна утечка изоляции арендаторов и один незакрытый ретрай.

1. [SEVERITY: critical] Запрос заказов не фильтрует по tenant_id
   File: src/lib/queries/orders.ts:44-58
   Trigger: пользователь арендатора A открывает /orders?id= с чужим uuid
   Mechanism: getOrder строит .eq('id', id) без .eq('tenant_id', ctx.tenant),
     а RLS для этой таблицы отключён миграцией 0142.
   Consequence: чтение чужих заказов вместе с телефонами клиентов.
   Required: добавить фильтр по tenant_id в запрос и вернуть RLS-политику.
   Proof: тест, который читает заказ арендатора B из-под сессии A и ждёт 404.

2. [SEVERITY: HIGH] Ретрай воркера не идемпотентен
   File: api/workers/charge.py:88
   Mechanism: при таймауте платёжного шлюза задача перезапускается, а
     idempotency_key генерируется заново внутри тела задачи.
   Consequence: двойное списание.
   Required: генерировать ключ на стороне продюсера.

3. [SEVERITY: minor] Непонятное имя переменной tmp
   File: src/lib/queries/orders.ts:71
`;

function selfTest() {
  const r = parse(SAMPLE, { source: "tech-lead", changedFiles: ["src/lib/queries/orders.ts", "api/workers/charge.py"] });
  const checks = [
    ["verdict=BLOCK", r.verdict === "BLOCK"],
    ["3 findings", r.findings.length === 3],
    ["HIGH → major", r.findings[1].severity === "major"],
    ["ids stable", findingId("src/lib/queries/orders.ts:44-58", "Запрос заказов не фильтрует по tenant_id")
      === findingId("src/lib/queries/orders.ts:99", "запрос заказов не фильтрует по tenant_id")],
    ["ids distinct", new Set(r.findings.map((f) => f.id)).size === 3],
    ["minor без механизма не понижается", r.findings[2].severity === "minor" && !r.findings[2].unproven],
    ["fields parsed", r.findings[0].proof.startsWith("тест")],
    ["multiline mechanism joined", r.findings[0].mechanism.includes("RLS")],
    ["in scope", r.findings.every((f) => !f.out_of_scope)],
  ];
  const allow = parse("ALLOW: Замечаний нет.");
  checks.push(["ALLOW чистый", allow.verdict === "ALLOW" && allow.findings.length === 0]);
  checks.push(["ALLOW+findings = MALFORMED", parse(SAMPLE.replace("BLOCK:", "ALLOW:")).reason === "allow_with_findings"]);
  checks.push(["BLOCK без findings = MALFORMED", parse("BLOCK: плохо").reason === "block_without_findings"]);
  checks.push(["NEEDS_HUMAN", parse("NEEDS_HUMAN: Ломать ли обратную совместимость v1 API?").verdict === "NEEDS_HUMAN"]);
  checks.push(["мусор = MALFORMED", parse("Привет, вот мои мысли").reason === "no_verdict_line"]);
  checks.push(["**ALLOW**: терпимо", parse("**ALLOW**: всё чисто").verdict === "ALLOW"]);
  const unproven = parse("BLOCK: x\n\n1. [SEVERITY: critical] Плохо пахнет\n   File: a.ts:1\n");
  checks.push(["critical без механизма → minor", unproven.findings[0].severity === "minor" && unproven.findings[0].unproven]);
  const scoped = parse(SAMPLE, { changedFiles: ["src/lib/queries/orders.ts"] });
  checks.push(["out_of_scope помечен", scoped.findings[1].out_of_scope === true]);

  // Повторность не меняет идентичность — иначе второй раунд заводит дубликат
  // вместо того, чтобы переоткрыть уже известное замечание.
  const same = (a, b) => findingId("api/x.py:10", a) === findingId("api/x.py:88", b);
  checks.push(["«всё ещё» не меняет id",
    same("Отказ подтверждается как успех", "Отказ всё ещё подтверждается как успех")]);
  checks.push(["«по-прежнему» не меняет id",
    same("Повторная доставка обходит stop-intent", "Повторная доставка по-прежнему обходит stop-intent")]);
  checks.push(["«still» не меняет id",
    same("Deferred stop failure is reported as success", "Deferred stop failure is still reported as success")]);
  checks.push(["разные дефекты остаются разными",
    !same("Отказ подтверждается как успех", "Гонка при создании бота")]);

  const failed = checks.filter(([, ok]) => !ok);
  emit({ ok: failed.length === 0, total: checks.length, failed: failed.map(([n]) => n) });
  process.exit(failed.length ? 1 : 0);
}

async function main() {
  const args = parseArgs();
  if (args["self-test"]) return selfTest();
  const text = await readStdin();
  if (!text.trim()) bail("empty_input");
  const changedFiles = args["files-json"] ? JSON.parse(args["files-json"]) : null;
  emit(parse(text, { source: args.source || "reviewer", changedFiles }));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
