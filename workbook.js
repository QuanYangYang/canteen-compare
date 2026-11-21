/* 询价比价 B1：解析电脑端下发的比价信息表，回传时只写「询价结果」。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vendor/xlsx.bundle.js'));
  } else {
    root.CanteenCompareWorkbook = factory(root.XLSX);
  }
})(typeof self !== 'undefined' ? self : this, function (XLSX) {
  'use strict';

  const TABLE_SHEET = '比价信息表';
  const META_SHEET = '比价信息';
  const INQUIRY = '询价结果';

  function text(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\u00a0/g, ' ').trim();
  }
  function num(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number') return Number.isFinite(value) ? value : '';
    const n = Number(String(value).replace(/[,，￥¥\s元]/g, ''));
    return Number.isFinite(n) ? n : '';
  }

  function parseCompareWorkbook(input) {
    let wb;
    try {
      wb = XLSX.read(input, { type: typeof input === 'string' ? 'binary' : 'array', cellDates: false, raw: true });
    } catch (err) {
      const e = new Error('无法读取比价信息表，请确认是电脑端导出的 XLSX。');
      e.code = 'BAD_WORKBOOK';
      throw e;
    }
    const table = wb.Sheets[TABLE_SHEET] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(table, { header: 1, defval: '', raw: true });
    let headerIndex = -1;
    let headers = null;
    for (let i = 0; i < rows.length; i++) {
      const cells = (rows[i] || []).map(text);
      if (cells.includes('序号') && cells.some((v) => v.startsWith('品名'))) {
        headerIndex = i;
        headers = cells;
        break;
      }
    }
    if (headerIndex < 0) {
      const e = new Error('比价信息表缺少表头（序号 / 品名及规格）。');
      e.code = 'BAD_TABLE';
      throw e;
    }
    const col = {
      seq: headers.indexOf('序号'),
      name: headers.findIndex((v) => v.startsWith('品名')),
      unit: headers.indexOf('单位'),
      qty: headers.indexOf('实送数'),
      base: headers.findIndex((v) => v.includes('报单价') || v.includes('四季缘')),
      inquiry: headers.indexOf(INQUIRY),
    };
    if (col.inquiry < 0) {
      const e = new Error('比价信息表缺少「询价结果」列，请在电脑端重新导出。');
      e.code = 'NO_INQUIRY_COL';
      throw e;
    }
    const items = [];
    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const seqText = text(row[col.seq]);
      if (!/^\d+$/.test(seqText)) continue;
      const name = text(row[col.name]);
      if (!name) continue;
      items.push({
        seq: Number(seqText),
        name,
        unit: col.unit >= 0 ? text(row[col.unit]) : '',
        qty: col.qty >= 0 ? num(row[col.qty]) : '',
        basePrice: col.base >= 0 ? num(row[col.base]) : '',
        inquiry: text(row[col.inquiry]) === '' ? null : num(row[col.inquiry]),
      });
    }
    if (!items.length) {
      const e = new Error('比价信息表里没有商品行。');
      e.code = 'NO_ITEMS';
      throw e;
    }
    const metaRows = wb.Sheets[META_SHEET]
      ? XLSX.utils.sheet_to_json(wb.Sheets[META_SHEET], { header: 1, defval: '', raw: true })
      : [];
    const meta = {};
    for (const row of metaRows) {
      const key = text(row && row[0]);
      if (!key || key === '字段' || key === '值') continue;
      meta[key] = text(row[1]);
    }
    if (!meta['比价单号']) {
      const e = new Error('比价信息表缺少「比价单号」，请在电脑端重新导出。');
      e.code = 'NO_SHEET_NO';
      throw e;
    }
    return {
      sheet: {
        sheetNo: meta['比价单号'],
        period: meta['时间段'] || '',
        discount: num(meta['折扣率']),
        title: text((rows[0] || [])[0]),
        headers,
        headerIndex,
        rawRows: rows,
      },
      items,
    };
  }

  function buildCompareWorkbook(sheet, items, nowText) {
    const headers = sheet.headers.slice();
    const inquiryCol = headers.indexOf(INQUIRY);
    const seqCol = headers.indexOf('序号');
    const bySeq = {};
    for (const item of items) bySeq[item.seq] = item;
    const aoa = sheet.rawRows.map((row) => (row || []).slice());
    for (let r = sheet.headerIndex + 1; r < aoa.length; r++) {
      const row = aoa[r] || (aoa[r] = []);
      const seqText = text(row[seqCol]);
      if (!/^\d+$/.test(seqText)) continue;
      const item = bySeq[Number(seqText)];
      if (!item) continue;
      row[inquiryCol] = item.inquiry === null || item.inquiry === '' ? '' : num(item.inquiry);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = headers.map((h) => ({ wch: h.startsWith('品名') ? 34 : Math.max(9, h.length * 2 + 4) }));
    if (headers.length > 1) {
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];
    }
    XLSX.utils.book_append_sheet(wb, ws, TABLE_SHEET);
    const meta = XLSX.utils.aoa_to_sheet([
      ['字段', '值'],
      ['比价单号', sheet.sheetNo],
      ['时间段', sheet.period],
      ['折扣率', num(sheet.discount)],
      ['行数', items.length],
      ['导出时间', nowText],
      ['说明', '手机端只填写「询价结果」，其余列未改动'],
    ]);
    meta['!cols'] = [{ wch: 14 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(wb, meta, META_SHEET);
    return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  }

  return { TABLE_SHEET, META_SHEET, INQUIRY, parseCompareWorkbook, buildCompareWorkbook };
});
