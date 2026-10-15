// Nekit Games: сервер мини-приложения. Node 18+, без зависимостей.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
try { // простой .env
  for (const l of fs.readFileSync(path.join(dir, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !l.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}
const E = process.env;
const BOT_TOKEN = E.BOT_TOKEN || '', CP_TOKEN = E.CRYPTO_PAY_TOKEN || '';
const CP = E.CRYPTO_PAY_API || 'https://pay.crypt.bot/api';
const MIN = Number(E.MIN_DEPOSIT || 1), MAX = Number(E.MAX_DEPOSIT || 1000);
const DEV = E.DEV === '1';
const DB_FILE = E.DB_FILE || path.join(dir, 'data.json');

// ---- хранилище (JSON-файл; для большого трафика заменить на PostgreSQL/SQLite)
let db = { users: {}, invoices: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
const save = () => { const t = DB_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(db)); fs.renameSync(t, DB_FILE); };
const user = id => (db.users[id] ??= { cents: 0, created: Date.now() }); // баланс в центах USDT

// ---- проверка, что запрос пришёл из Telegram (initData)
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function auth(req) {
  if (DEV && req.headers['x-dev-user']) return { id: String(req.headers['x-dev-user']).slice(0, 20) };
  const init = req.headers['x-init-data'];
  if (!init || !BOT_TOKEN) return null;
  const p = new URLSearchParams(init), hash = p.get('hash');
  p.delete('hash');
  const str = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (!hash || !eq(calc, hash)) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return { id: String(JSON.parse(p.get('user')).id) }; } catch { return null; }
}

// ---- Crypto Pay API
async function cp(method, params = {}) {
  const r = await fetch(`${CP}/${method}`, {
    method: 'POST',
    headers: { 'Crypto-Pay-API-Token': CP_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error?.name || 'crypto_pay_error');
  return j.result;
}
// зачисление строго один раз на счёт и только если сумма/валюта совпадают с нашей записью
function creditIfPaid(inv) {
  const rec = db.invoices[inv.invoice_id];
  if (!rec || rec.status === 'paid') return false;
  if (inv.status !== 'paid' || inv.asset !== 'USDT' || Math.round(Number(inv.amount) * 100) !== rec.cents) return false;
  rec.status = 'paid'; rec.paidAt = Date.now();
  user(rec.user).cents += rec.cents;
  save();
  return true;
}

// ---- HTTP
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) { no(new Error('big')); req.destroy(); } });
  req.on('end', () => ok(b)); req.on('error', no);
});
const TG = E.TG_API || 'https://api.telegram.org';
const TYPES = { '.tgs': 'application/gzip', '.webm': 'video/webm', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };


// ---- стикеры для карточек игр: файлы public/stickers/g<N>.(tgs|webm|webp) + автозагрузка из наборов Telegram (stickers.json)
const tgApi = async (m, q) => {
  const j = await (await fetch(`${TG}/bot${BOT_TOKEN}/${m}?${new URLSearchParams(q)}`)).json();
  if (!j.ok) throw new Error(j.description || m);
  return j.result;
};
async function syncStickers() {
  let cfg; try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'stickers.json'), 'utf8')); } catch { return; }
  if (!BOT_TOKEN) return console.log('stickers: нужен BOT_TOKEN');
  const out = path.join(dir, 'public', 'stickers'); fs.mkdirSync(out, { recursive: true });
  const sets = {};
  for (const [g, c] of Object.entries(cfg)) {
    try {
      const set = (sets[c.set] ??= await tgApi('getStickerSet', { name: c.set }));
      const st = c.index != null ? set.stickers[c.index] : set.stickers.find(x => x.emoji === c.emoji);
      if (!st) throw new Error('стикер не найден');
      const f = await tgApi('getFile', { file_id: st.file_id });
      const buf = Buffer.from(await (await fetch(`${TG}/file/bot${BOT_TOKEN}/${f.file_path}`)).arrayBuffer());
      for (const e of ['.tgs', '.webm', '.webp']) try { fs.unlinkSync(path.join(out, `g${g}${e}`)); } catch {}
      fs.writeFileSync(path.join(out, `g${g}${path.extname(f.file_path) || '.webp'}`), buf);
      console.log('sticker g' + g, 'ok');
    } catch (e) { console.log('sticker g' + g, 'ошибка:', e.message); }
  }
}
const listStickers = () => {
  const m = {};
  try { for (const f of fs.readdirSync(path.join(dir, 'public', 'stickers'))) { const k = f.match(/^g(\d+)\.(tgs|webm|webp)$/); if (k) m[k[1]] = 'stickers/' + f; } } catch {}
  return m;
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/crypto-webhook' && req.method === 'POST') {
      const raw = await readBody(req);
      const key = crypto.createHash('sha256').update(CP_TOKEN).digest();
      const sig = crypto.createHmac('sha256', key).update(raw).digest('hex');
      if (!CP_TOKEN || !eq(sig, String(req.headers['crypto-pay-api-signature'] || ''))) return json(res, 401, { error: 'bad_signature' });
      const u = JSON.parse(raw);
      if (u.update_type === 'invoice_paid') creditIfPaid(u.payload);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/stickers') return json(res, 200, listStickers());
    if (url.pathname.startsWith('/api/')) {
      const me = auth(req);
      if (!me) return json(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/api/me') {
        const mine = Object.entries(db.invoices).filter(([, i]) => i.user === me.id).slice(-10).reverse()
          .map(([id, i]) => ({ id, amount: i.cents / 100, status: i.status }));
        return json(res, 200, { balance: user(me.id).cents / 100, deposits: mine, min: MIN, max: MAX });
      }
      if (url.pathname === '/api/deposit' && req.method === 'POST') {
        const amount = Number(JSON.parse(await readBody(req) || '{}').amount);
        if (!(amount >= MIN && amount <= MAX)) return json(res, 400, { error: `Сумма от ${MIN} до ${MAX} USDT` });
        const cents = Math.round(amount * 100);
        const inv = await cp('createInvoice', {
          currency_type: 'crypto', asset: 'USDT', amount: (cents / 100).toFixed(2),
          description: 'Пополнение Nekit Games', payload: me.id, expires_in: 3600,
          ...(E.BOT_LINK ? { paid_btn_name: 'openBot', paid_btn_url: E.BOT_LINK } : {}),
        });
        db.invoices[inv.invoice_id] = { user: me.id, cents, status: 'active', created: Date.now() };
        save();
        return json(res, 200, { invoiceId: inv.invoice_id, url: inv.mini_app_invoice_url || inv.bot_invoice_url });
      }
      if (url.pathname === '/api/deposit/check' && req.method === 'POST') {
        const id = Number(JSON.parse(await readBody(req) || '{}').invoiceId);
        const rec = db.invoices[id];
        if (!rec || rec.user !== me.id) return json(res, 404, { error: 'not_found' });
        if (rec.status !== 'paid') {
          const r = await cp('getInvoices', { invoice_ids: String(id) });
          if (r.items?.[0]) creditIfPaid(r.items[0]);
        }
        return json(res, 200, { status: db.invoices[id].status, balance: user(me.id).cents / 100 });
      }
      return json(res, 404, { error: 'not_found' });
    }
    // статика из public/
    let f = path.normalize(path.join(dir, 'public', url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(path.join(dir, 'public'))) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'server_error' });
  }
}).listen(E.PORT || 3000, () => { console.log('Nekit Games: http://localhost:' + (E.PORT || 3000)); syncStickers(); });
