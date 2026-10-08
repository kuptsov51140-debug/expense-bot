// Google Apps Script: принимает записи от бота и пишет их в первый лист таблицы.
// Вставляется в Расширения -> Apps Script. Секрет замени на свой (тот же, что в .env на сервере).
const SECRET = 'ЗАМЕНИ_НА_СВОЙ_СЕКРЕТ';

function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  if (d.secret !== SECRET) return out_({ error: 'forbidden' });

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sh.getLastRow() === 0) sh.appendRow(['date', 'amount', 'category', 'description']);
  const tz = Session.getScriptTimeZone();
  const fmt = (v) => (v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v));

  if (d.action === 'add') {
    sh.appendRow([d.date, d.amount, d.category, d.description]);
    return out_({ ok: true });
  }
  if (d.action === 'list') {
    const n = sh.getLastRow();
    const rows = n > 1 ? sh.getRange(2, 1, n - 1, 4).getValues() : [];
    return out_({ rows: rows.map((r) => [fmt(r[0]), r[1], r[2], r[3]]) });
  }
  if (d.action === 'undo') {
    const n = sh.getLastRow();
    if (n <= 1) return out_({ row: null });
    const r = sh.getRange(n, 1, 1, 4).getValues()[0];
    sh.deleteRow(n);
    return out_({ row: [fmt(r[0]), r[1], r[2], r[3]] });
  }
  return out_({ error: 'unknown action' });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
