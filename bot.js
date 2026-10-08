// Telegram-бот учёта расходов на OpenAI (gpt-4o-mini). Без зависимостей, Node 18+.
// Текст "кофе 250" или фото чека -> запись в expenses.csv. /week /month /undo /help
const fs = require('fs');
const path = require('path');

// --- .env ---
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const TG = process.env.TELEGRAM_BOT_TOKEN;
const KEY = process.env.OPENAI_API_KEY;
const SHEETS_URL = process.env.SHEETS_URL || '';
const SHEETS_SECRET = process.env.SHEETS_SECRET || '';
const OWNER = process.env.ALLOWED_CHAT_ID ? Number(process.env.ALLOWED_CHAT_ID) : null;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
if (!TG || !KEY) {
  console.error('Заполни TELEGRAM_BOT_TOKEN и OPENAI_API_KEY в файле .env (см. README)');
  process.exit(1);
}

const CSV = path.join(__dirname, 'expenses.csv');
const CATEGORIES = ['Продукты', 'Кафе и рестораны', 'Транспорт', 'Жильё и коммуналка', 'Здоровье',
  'Одежда', 'Развлечения', 'Подписки и связь', 'Подарки', 'Прочее'];
if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, '﻿date;amount;category;description\n');

// --- Telegram ---
const tg = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return r.json();
};
const say = (chat_id, text) => tg('sendMessage', { chat_id, text });

// --- Claude: разбор трат ---
const SYSTEM = `Ты разбираешь траты пользователя. Верни ТОЛЬКО JSON без пояснений:
{"items":[{"amount":число,"category":"...","description":"кратко"}]}
Категории строго из списка: ${CATEGORIES.join(', ')}.
Сумма в рублях, число без символов. Для чека — одна позиция с итоговой суммой и названием магазина.
Если в сообщении нет траты, верни {"items":[]}.`;

async function parseExpense(content) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'Ошибка OpenAI API');
  const text = data.choices[0].message.content || '';
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) return [];
  return (JSON.parse(json[0]).items || []).filter((i) => Number(i.amount) > 0);
}

// --- Хранилище: Google Sheets (если задан SHEETS_URL), иначе локальный CSV ---
const today = () => new Date().toISOString().slice(0, 10);
const clean = (s) => String(s || '').replace(/[;\r\n]/g, ' ').trim();

async function sheets(action, data) {
  const r = await fetch(SHEETS_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ secret: SHEETS_SECRET, action, ...data }),
  });
  const res = await r.json();
  if (res.error) throw new Error('Google Sheets: ' + res.error);
  return res;
}

async function add(item) {
  const cat = CATEGORIES.includes(item.category) ? item.category : 'Прочее';
  const row = { date: today(), amount: Number(item.amount), category: cat, description: clean(item.description) };
  if (SHEETS_URL) await sheets('add', row);
  else fs.appendFileSync(CSV, `${row.date};${row.amount};${row.category};${row.description}\n`);
  return cat;
}

async function rows() {
  if (SHEETS_URL) {
    const res = await sheets('list');
    return res.rows.map(([date, amount, category, description]) => ({ date: String(date), amount: Number(amount), category, description }));
  }
  return fs.readFileSync(CSV, 'utf8').replace(/^\uFEFF/, '').trim().split('\n').slice(1)
    .filter(Boolean).map((l) => { const [date, amount, category, description] = l.split(';'); return { date, amount: Number(amount), category, description }; });
}

async function undo() {
  if (SHEETS_URL) {
    const res = await sheets('undo');
    return res.row; // [date, amount, category, description] или null
  }
  const lines = fs.readFileSync(CSV, 'utf8').trimEnd().split('\n');
  if (lines.length <= 1) return null;
  const last = lines.pop();
  fs.writeFileSync(CSV, lines.join('\n') + '\n');
  return last.split(';');
}

async function summary(days, title) {
  const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const list = (await rows()).filter((r) => r.date >= from);
  if (!list.length) return `${title}: трат нет.`;
  const by = {};
  let total = 0;
  for (const r of list) { by[r.category] = (by[r.category] || 0) + r.amount; total += r.amount; }
  const lines = Object.entries(by).sort((a, b) => b[1] - a[1])
    .map(([c, s]) => `• ${c}: ${s.toLocaleString('ru-RU')} ₽ (${Math.round((s / total) * 100)}%)`);
  return `${title}\nВсего: ${total.toLocaleString('ru-RU')} ₽ (${list.length} записей)\n${lines.join('\n')}`;
}

// --- Обработка сообщений ---
async function handle(msg) {
  const chat = msg.chat.id;
  if (!OWNER) {
    return say(chat, `Твой chat id: ${chat}\nВпиши в .env строку ALLOWED_CHAT_ID=${chat} и перезапусти бота — так им сможешь пользоваться только ты.`);
  }
  if (chat !== OWNER) return;
  const text = (msg.text || '').trim();

  if (text === '/start' || text === '/help') {
    return say(chat, 'Пиши траты как удобно: «кофе 250», «такси 480 и обед 650» — или присылай фото чека.\n/week — итоги за 7 дней\n/month — за 30 дней\n/undo — удалить последнюю запись');
  }
  if (text === '/week') return say(chat, await summary(7, 'Итоги за 7 дней'));
  if (text === '/month') return say(chat, await summary(30, 'Итоги за 30 дней'));
  if (text === '/undo') {
    const l = await undo();
    return say(chat, l ? `Удалено: ${l[1]} ₽ — ${l[3]}` : 'Записей нет.');
  }

  let content;
  if (msg.photo) {
    const file = await tg('getFile', { file_id: msg.photo[msg.photo.length - 1].file_id });
    const img = await fetch(`https://api.telegram.org/file/bot${TG}/${file.result.file_path}`);
    const b64 = Buffer.from(await img.arrayBuffer()).toString('base64');
    content = [
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
      { type: 'text', text: msg.caption || 'Это чек. Разбери его.' },
    ];
  } else if (text && !text.startsWith('/')) {
    content = text;
  } else return;

  const items = await parseExpense(content);
  if (!items.length) return say(chat, 'Не нашёл здесь трату. Напиши, например: «кофе 250».');
  const out = [];
  for (const i of items) out.push(`✅ ${Number(i.amount).toLocaleString('ru-RU')} ₽ — ${await add(i)} (${clean(i.description)})`);
  return say(chat, out.join('\n'));
}

// --- Воскресная сводка в 20:00 ---
let lastDigest = '';
setInterval(() => {
  const d = new Date();
  if (OWNER && d.getDay() === 0 && d.getHours() === 20 && lastDigest !== today()) {
    lastDigest = today();
    summary(7, '📊 Итоги недели').then((t) => say(OWNER, t)).catch(console.error);
  }
}, 60000);

// --- Long polling ---
(async () => {
  console.log('Бот запущен. Напиши ему в Telegram.');
  let offset = 0;
  for (;;) {
    try {
      const res = await tg('getUpdates', { offset, timeout: 30 });
      for (const u of res.result || []) {
        offset = u.update_id + 1;
        if (u.message) {
          handle(u.message).catch((e) => { console.error(e); say(u.message.chat.id, 'Ошибка: ' + e.message).catch(() => {}); });
        }
      }
    } catch (e) {
      console.error('Сеть:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
})();
