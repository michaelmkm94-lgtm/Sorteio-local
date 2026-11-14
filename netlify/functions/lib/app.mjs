// Lógica da API do Sorteio (versão Netlify).
// Porta fiel do app.py: mesmas rotas, mesmas regras de negócio.
// O armazenamento é injetado (Netlify Blobs em produção, memória nos testes).
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

const DEFAULT_MESSAGE =
  "Cadastre seus dados uma única vez e acompanhe os prêmios preparados para este momento.";
const THEMES = new Set(["neon-night", "ocean-glass", "violet-event"]);
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_CHARS = 2 * 1024 * 1024; // data URL do prêmio (já reduzida no navegador)
const CAS_RETRIES = 15;
const LOCK_MAX_FAILS = 8;
const LOCK_WINDOW_MS = 10 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const nowIso = () => new Date().toISOString();
const sha = (v) => createHash("sha256").update(String(v)).digest();

function defaultSettings() {
  return {
    id: 1,
    draw_date: "",
    draw_time: "",
    draw_title: "Grande Sorteio",
    public_message: DEFAULT_MESSAGE,
    accent_color: "#77e5dc",
    visual_theme: "neon-night",
    draw_status: "idle",
    draw_phase: "idle",
    draw_phase_started_at: "",
    updated_at: nowIso(),
  };
}

function defaultCore() {
  return {
    v: 1,
    nextEntryId: 1,
    nextPrizeId: 1,
    settings: defaultSettings(),
    entries: [],
    prizes: [],
  };
}

function safeEqual(a, b) {
  return timingSafeEqual(sha(a), sha(b));
}

// ---------- validações (iguais ao app.py) ----------

function normalizeMobile(value, required = true) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (!digits && !required) return "";
  if (digits.length === 13 && digits.startsWith("55")) digits = digits.slice(2);
  if (digits.length !== 11 || digits[2] !== "9") {
    throw new HttpError(
      400,
      "Informe celulares brasileiros válidos com DDD e 11 dígitos. O Telefone 2 é opcional."
    );
  }
  return digits;
}

// Aceita "300,00", "1.300,00", "300.00". Com `allowEmpty`, vazio vira 0.
function parseAmount(raw, { allowEmpty = false, cents = true } = {}) {
  let v = String(raw ?? "").trim().replace(/R\$/gi, "").replace(/\s/g, "");
  if (!v) {
    if (allowEmpty) return 0;
    throw new HttpError(400, "Informe o valor no formato 000,00 (ex.: 300,00).");
  }
  const re = cents
    ? /^(?:\d{1,6}|\d{1,3}(?:\.\d{3})+)(?:,\d{2}|\.\d{2})$/
    : /^(?:\d{1,6}|\d{1,3}(?:\.\d{3})+)(?:,\d{2}|\.\d{2})?$/;
  if (!re.test(v)) {
    throw new HttpError(400, "Informe o valor no formato 000,00 (ex.: 300,00).");
  }
  const normalized = v.includes(",") ? v.replace(/\./g, "").replace(",", ".") : v;
  const amount = Math.round(Number(normalized) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 0 || amount > 999999.99) {
    throw new HttpError(400, "O valor deve estar entre R$ 0,00 e R$ 999.999,99.");
  }
  return amount;
}

const ticketsFor = (amount) => Math.max(1, Math.floor(amount / 50));

function validDeviceId(id) {
  return (
    typeof id === "string" &&
    id.length >= 16 &&
    id.length <= 100 &&
    /^[A-Za-z0-9_:-]+$/.test(id)
  );
}

const str = (v) => String(v ?? "").trim();

// ---------- fábrica do handler ----------

export function createApp({ store, adminPassword }) {
  // --- "banco": um documento com controle otimista (ETag) = equivalente ao BEGIN IMMEDIATE do SQLite
  async function readCore() {
    const hit = await store.getWithMetadata("core", { type: "json" });
    if (hit && hit.data) return hit;
    const fresh = defaultCore();
    const w = await store.setJSON("core", fresh, { onlyIfNew: true });
    if (w.modified) return { data: fresh, etag: w.etag };
    const again = await store.getWithMetadata("core", { type: "json" });
    if (!again) throw new Error("Falha ao inicializar o banco.");
    return again;
  }

  async function mutate(fn) {
    for (let i = 0; i < CAS_RETRIES; i++) {
      const { data, etag } = await readCore();
      const outcome = await fn(data);
      if (!outcome || outcome.write === false) return outcome?.result;
      const w = await store.setJSON("core", data, { onlyIfMatch: etag });
      if (w.modified) {
        if (outcome.after) await outcome.after();
        return outcome.result;
      }
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 80));
    }
    throw new HttpError(503, "Servidor ocupado. Tente novamente em instantes.");
  }

  const read = async () => (await readCore()).data;

  // --- autenticação com bloqueio por tentativas
  const lockKey = (ip) => "lock/" + createHash("sha256").update(String(ip || "?")).digest("hex");

  async function requireAdmin(req, body, ip) {
    if (!adminPassword) {
      throw new HttpError(
        503,
        "Senha do administrador não configurada. Defina a variável ADMIN_PASSWORD no Netlify e publique novamente."
      );
    }
    const key = lockKey(ip);
    const lock = (await store.get(key, { type: "json" })) || null;
    const t = Date.now();
    if (lock && lock.count >= LOCK_MAX_FAILS && t - lock.first < LOCK_WINDOW_MS) {
      throw new HttpError(429, "Muitas tentativas incorretas. Aguarde 10 minutos e tente novamente.");
    }
    const supplied = (body && body.pin !== undefined ? body.pin : req.headers.get("x-admin-pin")) ?? "";
    if (!safeEqual(supplied, adminPassword)) {
      const fresh = lock && t - lock.first < LOCK_WINDOW_MS ? lock : { count: 0, first: t };
      fresh.count += 1;
      await store.setJSON(key, fresh);
      throw new HttpError(401, "Senha inválida.");
    }
    if (lock) await store.delete(key);
  }

  // --- imagens dos prêmios ficam fora do documento principal
  const imageUrl = (p) => (p.has_image ? `/api/prize-image/${p.id}` : "");
  const prizeView = (p) => {
    const { has_image, ...rest } = p;
    return { ...rest, image: imageUrl(p) };
  };

  async function clearPrefix(prefix) {
    const { blobs } = await store.list({ prefix });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
  }

  // --- rotas
  async function publicData() {
    const d = await read();
    const s = d.settings;
    const entries = d.entries;
    const results = d.prizes
      .filter((p) => p.drawn && p.winner_entry_id != null)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
      .map((p) => {
        const e = entries.find((x) => x.id === p.winner_entry_id);
        return e ? { prize_name: p.name, full_name: e.full_name, nickname: e.nickname, drawn_at: e.drawn_at } : null;
      })
      .filter(Boolean);
    const settings = {
      draw_title: s.draw_title,
      draw_date: s.draw_date,
      draw_time: s.draw_time,
      public_message: s.public_message,
      draw_status: s.draw_status,
      draw_datetime: s.draw_date ? s.draw_date + (s.draw_time ? "T" + s.draw_time : "") : "",
    };
    return {
      settings,
      participant_count: entries.length,
      total_tickets: entries.reduce((n, e) => n + e.tickets_total, 0),
      available_tickets: entries.reduce((n, e) => n + Math.max(e.tickets_total - e.tickets_drawn, 0), 0),
      results,
    };
  }

  const routes = {};
  const route = (method, path, fn) => (routes[`${method} ${path}`] = fn);

  route("GET", "/api/public", async () => ({
    json: await publicData(),
    // O CDN do Netlify guarda 3 s: centenas de celulares consultando não viram centenas de execuções.
    headers: { "Netlify-CDN-Cache-Control": "public, s-maxage=3" },
  }));

  route("GET", "/api/entries/status", async ({ url }) => {
    const deviceId = str(url.searchParams.get("device_id"));
    if (!deviceId || deviceId.length > 100 || !/^[A-Za-z0-9_:-]+$/.test(deviceId)) {
      return { json: { registered: false, amount_pending: false } };
    }
    const d = await read();
    const entry = d.entries.find((e) => e.device_id === deviceId);
    const quote = await store.get("quote/" + deviceId, { type: "json" });
    return {
      json: {
        registered: !!entry,
        tickets_total: entry ? entry.tickets_total : quote ? quote.tickets_total : 0,
        tickets_remaining: entry ? Math.max(0, entry.tickets_total - entry.tickets_drawn) : 0,
        amount_pending: !!quote,
        purchase_amount: quote ? quote.purchase_amount : null,
      },
    };
  });

  route("GET", "/api/admin", async (ctx) => {
    await requireAdmin(ctx.req, null, ctx.ip);
    const d = await read();
    const entries = [...d.entries]
      .sort((a, b) => b.id - a.id)
      .map(({ purchase_image, ...e }) => e);
    const prizes = [...d.prizes]
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
      .map(prizeView);
    return { json: { settings: d.settings, entries, prizes } };
  });

  route("GET", "/api/prize-image", async ({ url }) => {
    const id = Number(url.pathname.split("/").pop());
    if (!Number.isInteger(id)) throw new HttpError(404, "Imagem não encontrada.");
    const dataUrl = await store.get("img/" + id, { type: "text" });
    const m = dataUrl && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) throw new HttpError(404, "Imagem não encontrada.");
    return {
      raw: Buffer.from(m[2], "base64"),
      type: m[1],
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    };
  });

  route("POST", "/api/auth", async ({ req, body, ip }) => {
    await requireAdmin(req, body, ip);
    return { json: { ok: true } };
  });

  route("POST", "/api/entries/amount", async ({ body }) => {
    const deviceId = str(body.device_id);
    if (!validDeviceId(deviceId) || deviceId.includes(":")) {
      throw new HttpError(400, "Não foi possível identificar este aparelho.");
    }
    const amount = parseAmount(body.purchase_amount);
    const d = await read();
    if (d.entries.some((e) => e.device_id === deviceId)) {
      throw new HttpError(409, "Este aparelho já possui uma ficha neste sorteio.", { already_registered: true });
    }
    const tickets = ticketsFor(amount);
    const w = await store.setJSON(
      "quote/" + deviceId,
      { purchase_amount: amount, tickets_total: tickets, created_at: nowIso() },
      { onlyIfNew: true }
    );
    if (!w.modified) {
      const existing = await store.get("quote/" + deviceId, { type: "json" });
      throw new HttpError(409, "Já existe um valor confirmado para este aparelho.", {
        amount_pending: true,
        purchase_amount: existing?.purchase_amount,
        tickets_total: existing?.tickets_total,
      });
    }
    return { json: { ok: true, purchase_amount: amount, tickets_total: tickets } };
  });

  route("POST", "/api/entries/amount/reset", async ({ req, body, ip }) => {
    await requireAdmin(req, body, ip);
    const deviceId = str(body.device_id);
    if (deviceId && deviceId.length <= 100 && /^[A-Za-z0-9_:-]+$/.test(deviceId)) {
      await store.delete("quote/" + deviceId);
    }
    return { json: { ok: true } };
  });

  route("POST", "/api/entries", async ({ body }) => {
    for (const k of ["full_name", "address", "phone", "purchase_amount"]) {
      if (!str(body[k])) {
        throw new HttpError(400, "Preencha nome, endereço, celular e informe o valor total da compra.");
      }
    }
    const deviceId = str(body.device_id);
    if (!validDeviceId(deviceId)) {
      throw new HttpError(400, "Não foi possível identificar este aparelho. Atualize a página e tente novamente.");
    }
    const phone = normalizeMobile(body.phone, true);
    const phone2 = normalizeMobile(body.phone2, false);
    if (phone2 && phone2 === phone) throw new HttpError(400, "Telefone 1 e Telefone 2 não podem ser iguais.");
    const amount = parseAmount(body.purchase_amount);
    const quote = await store.get("quote/" + deviceId, { type: "json" });
    if (!quote) throw new HttpError(409, "Confirme primeiro o valor da compra nesta sessão.");
    if (Math.abs(Number(quote.purchase_amount) - amount) > 0.001) {
      throw new HttpError(409, "O valor enviado não corresponde ao valor confirmado no caixa.");
    }
    const result = await mutate((d) => {
      if (d.entries.some((e) => e.device_id === deviceId)) {
        throw new HttpError(409, "Este aparelho já possui uma ficha neste sorteio. Boa sorte!", { already_registered: true });
      }
      const used = (n) => d.entries.some((e) => e.phone_key === n || e.phone2_key === n);
      if (used(phone)) {
        throw new HttpError(
          409,
          "Este celular já foi usado em uma ficha. Telefone 1 e Telefone 2 são verificados para impedir números repetidos.",
          { already_registered: true }
        );
      }
      if (phone2 && used(phone2)) {
        throw new HttpError(409, "Este Telefone 2 já foi usado em outra ficha. Cada número só pode ser cadastrado uma vez.", {
          already_registered: true,
        });
      }
      const id = d.nextEntryId++;
      d.entries.push({
        id,
        full_name: str(body.full_name),
        nickname: str(body.nickname),
        address: str(body.address),
        phone,
        phone_key: phone,
        phone2,
        phone2_key: phone2,
        device_id: deviceId,
        created_at: nowIso(),
        drawn: 0,
        drawn_at: null,
        tickets_total: Number(quote.tickets_total),
        tickets_drawn: 0,
        purchase_amount: amount,
        ocr_status: "customer-entered",
      });
      return {
        result: { ok: true, id, tickets_total: Number(quote.tickets_total), purchase_amount: amount, ocr_status: "customer-entered" },
        after: () => store.delete("quote/" + deviceId),
      };
    });
    return { json: result };
  });

  route("POST", "/api/admin/entries", async ({ req, body, ip }) => {
    await requireAdmin(req, body, ip);
    for (const k of ["full_name", "address", "phone"]) {
      if (!str(body[k])) throw new HttpError(400, "Preencha nome completo, endereço e celular principal.");
    }
    const phone = normalizeMobile(body.phone, true);
    const phone2 = normalizeMobile(body.phone2, false);
    if (phone2 && phone2 === phone) throw new HttpError(400, "Telefone 1 e Telefone 2 não podem ser iguais.");
    const amount = parseAmount(body.purchase_amount, { allowEmpty: true, cents: false });
    const result = await mutate((d) => {
      for (const n of [phone, phone2]) {
        if (n && d.entries.some((e) => e.phone_key === n || e.phone2_key === n)) {
          throw new HttpError(409, `O celular ${n} já está cadastrado. Não é permitido repetir números.`);
        }
      }
      const id = d.nextEntryId++;
      const tickets = ticketsFor(amount);
      d.entries.push({
        id,
        full_name: str(body.full_name),
        nickname: str(body.nickname),
        address: str(body.address),
        phone,
        phone_key: phone,
        phone2,
        phone2_key: phone2,
        device_id: "admin-" + id + "-" + Math.random().toString(16).slice(2),
        created_at: nowIso(),
        drawn: 0,
        drawn_at: null,
        tickets_total: tickets,
        tickets_drawn: 0,
        purchase_amount: amount,
        ocr_status: "admin-manual",
      });
      return { result: { ok: true, id, tickets_total: tickets } };
    });
    return { json: result };
  });

  route("POST", "/api/settings", async ({ req, body, ip }) => {
    await requireAdmin(req, body, ip);
    const drawDate = str(body.draw_date);
    const drawTime = str(body.draw_time);
    if (drawDate && !/^\d{4}-\d{2}-\d{2}$/.test(drawDate)) throw new HttpError(400, "Data do sorteio inválida.");
    if (drawTime && !/^\d{2}:\d{2}$/.test(drawTime)) throw new HttpError(400, "Horário do sorteio inválido.");
    const accent = /^#[0-9a-fA-F]{6}$/.test(str(body.accent_color)) ? str(body.accent_color) : "#77e5dc";
    const theme = THEMES.has(str(body.visual_theme)) ? str(body.visual_theme) : "neon-night";
    await mutate((d) => {
      Object.assign(d.settings, {
        draw_title: str(body.draw_title).slice(0, 120) || "Grande Sorteio",
        draw_date: drawDate,
        draw_time: drawTime,
        public_message: str(body.public_message).slice(0, 500),
        accent_color: accent,
        visual_theme: theme,
        updated_at: nowIso(),
      });
      return { result: true };
    });
    return { json: { ok: true } };
  });

  route("POST", "/api/prizes", async ({ req, body, ip }) => {
    await requireAdmin(req, body, ip);
    const name = str(body.name);
    if (!name) throw new HttpError(400, "Informe o nome do item.");
    const image = typeof body.image === "string" ? body.image : "";
    if (image) {
      if (image.length > MAX_IMAGE_CHARS) throw new HttpError(413, "Imagem muito grande. Use uma imagem menor.");
      if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image)) {
        throw new HttpError(400, "Formato de imagem inválido. Use JPG, PNG ou WebP.");
      }
    }
    let newId;
    await mutate((d) => {
      newId = d.nextPrizeId++;
      const max = d.prizes.reduce((m, p) => Math.max(m, p.sort_order), 0);
      d.prizes.push({
        id: newId,
        name: name.slice(0, 160),
        description: str(body.description).slice(0, 500),
        has_image: !!image,
        sort_order: max + 1,
        drawn: 0,
        winner_entry_id: null,
        created_at: nowIso(),
      });
      if (d.settings.draw_status === "finished") {
        Object.assign(d.settings, { draw_status: "running", draw_phase: "idle", draw_phase_started_at: "", updated_at: nowIso() });
      }
      return { result: true };
    });
    // A imagem é gravada depois do prêmio: se falhar, o prêmio existe sem foto (nunca o inverso).
    if (image) await store.set("img/" + newId, image);
    return { json: { ok: true, id: newId } };
  });

  route("POST", "/api/prizes/delete", async ({ req, body, ip }) => {
    await requireAdmin(req, body, ip);
    const id = Number(body.id);
    let removed = false;
    await mutate((d) => {
      const i = d.prizes.findIndex((p) => p.id === id && !p.drawn);
      if (i < 0) return { write: false };
      d.prizes.splice(i, 1);
      removed = true;
      return { result: true };
    });
    if (removed) await store.delete("img/" + id);
    return { json: { ok: true } };
  });

  route("POST", "/api/entries/release", async ({ req, body, ip }) => {
    await requireAdmin(req, body, ip);
    const entryId = Number(body.entry_id);
    const amount = Number(body.tickets);
    if (!Number.isInteger(entryId) || !Number.isInteger(amount) || amount < 1 || amount > 1000) {
      throw new HttpError(400, "A quantidade deve ficar entre 1 e 1000 fichas por liberação.");
    }
    await mutate((d) => {
      const e = d.entries.find((x) => x.id === entryId);
      if (!e) throw new HttpError(404, "Participante não encontrado.");
      e.tickets_total += amount;
      e.drawn = e.tickets_total > e.tickets_drawn ? 0 : 1;
      return { result: true };
    });
    return { json: { ok: true, added: amount } };
  });

  route("POST", "/api/draw/start", async ({ req, body, ip }) => {
    await requireAdmin(req, body, ip);
    const prizeId = Number(body.prize_id);
    if (!Number.isInteger(prizeId)) throw new HttpError(400, "Selecione um item válido para sortear.");
    await mutate((d) => {
      if (d.settings.draw_status === "finished") throw new HttpError(409, "O sorteio já foi finalizado.");
      if (!d.prizes.some((p) => p.id === prizeId && !p.drawn)) {
        throw new HttpError(409, "O item selecionado não existe ou já foi sorteado. Atualize a lista de prêmios.");
      }
      if (!d.entries.some((e) => e.tickets_drawn < e.tickets_total)) {
        throw new HttpError(
          409,
          "Não há participantes disponíveis. Atualize a lista de participantes e confirme se existe uma ficha não sorteada."
        );
      }
      Object.assign(d.settings, {
        draw_status: "running",
        draw_phase: "spinning",
        draw_phase_started_at: nowIso(),
        updated_at: nowIso(),
      });
      return { result: true };
    });
    return { json: { ok: true, phase: "spinning" } };
  });

  route("POST", "/api/draw", async ({ req, body, ip }) => {
    await requireAdmin(req, body, ip);
    const prizeId = Number(body.prize_id);
    const result = await mutate((d) => {
      const prize = d.prizes.find((p) => p.id === prizeId && !p.drawn);
      if (!prize) throw new HttpError(400, "Item inválido ou já sorteado.");
      const pool = d.entries.filter((e) => e.tickets_drawn < e.tickets_total);
      if (!pool.length) throw new HttpError(400, "Não há participantes disponíveis.");
      // Sorteio ponderado: cada ficha restante é um bilhete. Quem tem 10 fichas tem 10 chances;
      // ao ser sorteado, perde 1 ficha (passa a ter 9) e as chances dele diminuem na próxima rodada.
      const totalBilhetes = pool.reduce((n, e) => n + (e.tickets_total - e.tickets_drawn), 0);
      let alvo = randomInt(totalBilhetes);
      let entry = pool[pool.length - 1];
      for (const e of pool) {
        const restantes = e.tickets_total - e.tickets_drawn;
        if (alvo < restantes) { entry = e; break; }
        alvo -= restantes;
      }
      entry.tickets_drawn += 1;
      entry.drawn = entry.tickets_drawn >= entry.tickets_total ? 1 : 0;
      entry.drawn_at = nowIso();
      prize.drawn = 1;
      prize.winner_entry_id = entry.id;
      const remaining = d.prizes.filter((p) => !p.drawn).length;
      Object.assign(d.settings, {
        draw_status: remaining === 0 ? "finished" : "running",
        draw_phase: "winner",
        draw_phase_started_at: nowIso(),
        updated_at: nowIso(),
      });
      const { purchase_image, device_id, phone_key, phone2_key, ...winner } = entry;
      return { result: { ok: true, prize: prizeView(prize), winner } };
    });
    return { json: result };
  });

  route("POST", "/api/draw/finish", async ({ req, body, ip }) => {
    await requireAdmin(req, body, ip);
    await mutate((d) => {
      Object.assign(d.settings, { draw_status: "finished", draw_phase: "idle", draw_phase_started_at: "", updated_at: nowIso() });
      return { result: true };
    });
    return { json: { ok: true } };
  });

  route("POST", "/api/reset", async ({ req, body, ip }) => {
    await requireAdmin(req, body, ip);
    await mutate((d) => {
      d.entries = [];
      d.prizes = [];
      d.settings = defaultSettings(); // contadores de id são mantidos: URLs de imagem nunca se repetem
      return { result: true };
    });
    await clearPrefix("quote/");
    await clearPrefix("img/");
    return { json: { ok: true } };
  });

  // ---------- despacho ----------
  return async function handle(req, ip = "") {
    const url = new URL(req.url);
    let path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();
    const reply = (status, payload, headers = {}) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
      });
    try {
      let key = `${method} ${path}`;
      if (method === "GET" && path.startsWith("/api/prize-image/")) key = "GET /api/prize-image";
      const fn = routes[key];
      if (!fn) return reply(404, { error: "Rota não encontrada." });
      let body = {};
      if (method === "POST") {
        const text = await req.text();
        if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "Requisição grande demais.");
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          throw new HttpError(400, "JSON inválido.");
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) body = {};
      }
      const out = await fn({ req, url, body, ip });
      if (out.raw !== undefined) {
        return new Response(out.raw, { status: 200, headers: { "Content-Type": out.type, ...(out.headers || {}) } });
      }
      return reply(200, out.json, out.headers);
    } catch (err) {
      if (err instanceof HttpError) return reply(err.status, { error: err.message, ...err.extra });
      console.error("Erro interno:", err);
      return reply(500, { error: "Erro interno do servidor. Tente novamente." });
    }
  };
}
