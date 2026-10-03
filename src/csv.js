'use strict';

/*
 * 实测 CSV 批次解析（规则 18）：
 * 每行 3~4 列 —— 开始日期时间,结束日期时间,实际照度[,备注]；
 * 日期时间为墙上时间，形如 `2026-03-01 09:00`（分隔符可为空格或 T，秒仅允许 :00）。
 * 首行若为表头（首列不是日期时间且第三列不是数字）自动跳过，可用 hasHeader 显式指定。
 */

const { ValidationError, isValidYmd } = require('./validation');
const { wallToTs } = require('./dosing');

/** 单批最大数据行数（防御误传巨型文件）。 */
const MAX_BATCH_ROWS = 5000;

/**
 * 解析 CSV 文本为行数组 [{ line, fields }]。
 * 支持：UTF-8 BOM、CRLF/CR/LF、双引号包裹字段（"" 转义）、逗号分隔；
 * 完全为空的行（无内容或唯一字段为空白）跳过；line 为该行的文件行号（1 起）。
 */
function parseCsvText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new ValidationError('CSV 内容为空');
  }
  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // UTF-8 BOM

  const rows = [];
  let field = '';
  let fields = [];
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  let hasContent = false; // 当前行是否含任何非空白字符或引号/逗号结构

  const pushRow = () => {
    fields.push(field);
    field = '';
    const isEmpty = fields.length === 1 && fields[0].trim() === '' && !hasContent;
    if (!isEmpty) rows.push({ line: rowLine, fields });
    fields = [];
    hasContent = false;
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
        if (ch === '\n') line++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      hasContent = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
      hasContent = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      pushRow();
      line++;
      rowLine = line;
    } else {
      field += ch;
      if (ch.trim() !== '') hasContent = true;
    }
  }
  if (inQuotes) throw new ValidationError('CSV 引号未闭合');
  if (field !== '' || fields.length > 0 || hasContent) pushRow();
  return rows;
}

const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ]+(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * 解析 CSV 中的墙上日期时间：YYYY-MM-DD HH:MM（分隔符可为空格或 T，秒仅允许 :00）。
 * 返回 { ymd, minute } 或 { error }。
 */
function parseWallDateTime(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = DATETIME_RE.exec(s);
  if (!m) return { error: `日期时间无效：${s || '(空)'}（应为 YYYY-MM-DD HH:MM）` };
  const ymd = m[1];
  if (!isValidYmd(ymd)) return { error: `日期时间无效：${s}（日期不存在）` };
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (hh > 23 || mm > 59) return { error: `日期时间无效：${s}（时间超出范围）` };
  if (m[4] !== undefined && m[4] !== '00') {
    return { error: `日期时间无效：${s}（暂不支持秒级精度）` };
  }
  return { ymd, minute: hh * 60 + mm };
}

function isFiniteNumberString(s) {
  return typeof s === 'string' && s.trim() !== '' && Number.isFinite(Number(s.trim()));
}

/**
 * 把 CSV 文本解析为实测批次行。
 * 返回 { rows, headerDetected }；每行：
 *   { row, line, startMs, endMs, lux, note, errors: [] }
 * row 为数据行号（1 起，不含表头），line 为文件行号；
 * errors 为字符串数组（解析/取值类错误），时段有效的行 startMs/endMs 为毫秒。
 * 整批性错误（空 CSV、行数超限）直接抛 ValidationError。
 */
function parseMeasurementCsvRows(text, { hasHeader } = {}) {
  const csvRows = parseCsvText(text);
  if (csvRows.length === 0) throw new ValidationError('CSV 没有数据行');

  let startIdx = 0;
  let headerDetected = false;
  const first = csvRows[0];
  if (hasHeader === true) {
    headerDetected = true;
    startIdx = 1;
  } else if (
    hasHeader === undefined &&
    first.fields.length >= 3 &&
    parseWallDateTime(first.fields[0]).error !== undefined &&
    !isFiniteNumberString(first.fields[2])
  ) {
    // 首行首列不是日期时间且第三列不是数字 -> 视为表头自动跳过
    headerDetected = true;
    startIdx = 1;
  }

  const dataRows = csvRows.slice(startIdx);
  if (dataRows.length === 0) {
    throw new ValidationError('CSV 没有数据行（仅检测到表头）');
  }
  if (dataRows.length > MAX_BATCH_ROWS) {
    throw new ValidationError(`CSV 数据行过多：${dataRows.length} 行（单批最多 ${MAX_BATCH_ROWS} 行）`);
  }

  const rows = dataRows.map((cr, i) => {
    const row = {
      row: i + 1,
      line: cr.line,
      startMs: null,
      endMs: null,
      lux: null,
      note: null,
      errors: [],
    };
    const f = cr.fields.map((x) => (typeof x === 'string' ? x.trim() : x));
    if (f.length < 3 || f.length > 4) {
      row.errors.push(
        `列数不正确（${f.length} 列）：应为 开始日期时间,结束日期时间,实际照度[,备注]（3~4 列）`
      );
      return row;
    }
    const st = parseWallDateTime(f[0]);
    if (st.error) row.errors.push(`开始${st.error}`);
    const en = parseWallDateTime(f[1]);
    if (en.error) row.errors.push(`结束${en.error}`);

    const luxRaw = f[2];
    const lux = Number(luxRaw);
    if (!isFiniteNumberString(luxRaw)) {
      row.errors.push(`实际照度必须是数字：${luxRaw === '' ? '(空)' : luxRaw}`);
    } else if (lux <= 0) {
      row.errors.push('实际照度必须为正数');
    } else if (lux > 1000000) {
      row.errors.push('实际照度不能大于 1000000');
    } else {
      row.lux = lux;
    }

    if (!st.error && !en.error) {
      const startMs = wallToTs(st.ymd, st.minute);
      const endMs = wallToTs(en.ymd, en.minute);
      if (!(endMs > startMs)) {
        row.errors.push('实测时段结束必须晚于开始（须为正时长）');
      } else {
        row.startMs = startMs;
        row.endMs = endMs;
      }
    }

    if (f[3] !== undefined && f[3] !== '') row.note = f[3].slice(0, 1000);
    return row;
  });

  return { rows, headerDetected };
}

module.exports = {
  MAX_BATCH_ROWS,
  parseCsvText,
  parseWallDateTime,
  parseMeasurementCsvRows,
};
