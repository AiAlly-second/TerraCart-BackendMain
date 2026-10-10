const ExcelJS = require('exceljs');
const Order = require('../../models/orderModel');
const { getBusinessDateKey } = require('../../utils/businessTime');
const TIMEZONE = 'Asia/Kolkata';
const HEADERS = [
  'Order ID', 'Invoice ID', 'Created At', 'Updated At', 'Status', 'Service Type', 'Order Type',
  'Table / Counter', 'Token', 'Customer', 'Mobile', 'Items Count', 'Total Amount (Rs)',
];
const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function formatBusinessDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const dateLabel = new Intl.DateTimeFormat('en-IN', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: TIMEZONE,
  }).format(date);
  const timeLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(date);
  return `${dateLabel}, ${timeLabel}`;
}
function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}
function isOfficeOrder(order) {
  if (String(order?.sourceQrType || '').toUpperCase() === 'OFFICE') return true;
  const mode = String(order?.officePaymentMode || '').toUpperCase();
  if (mode === 'ONLINE' || mode === 'COD' || mode === 'BOTH') return true;
  if (Number(order?.officeDeliveryCharge || 0) > 0) return true;
  return String(order?.table?.qrContextType || '').toUpperCase() === 'OFFICE';
}
function hasDeliveryInfo(order) {
  const info = order?.deliveryInfo;
  if (!info) return false;
  return (present(info.distance) && !Number.isNaN(Number(info.distance)))
    || (present(info.estimatedTime) && !Number.isNaN(Number(info.estimatedTime)))
    || Number(info.deliveryCharge || 0) > 0;
}
// Same service/order labels as the Admin web Orders → Download Excel export.
function takeawayOrderType(order) {
  if (!order) return '';
  if (isOfficeOrder(order)) return 'DELIVERY';
  const explicit = String(order.orderType || '').toUpperCase();
  if (explicit === 'PICKUP' || explicit === 'DELIVERY') return explicit;
  const service = String(order.serviceType || '').toUpperCase();
  if (service === 'PICKUP' || service === 'DELIVERY') return service;
  if (service === 'TAKEAWAY' && hasDeliveryInfo(order) && !present(order?.pickupLocation?.address)) return 'DELIVERY';
  return '';
}
function invoiceId(order) {
  const date = new Date(order.createdAt || Date.now()).toISOString().slice(0, 10).replace(/-/g, '');
  return `INV-${date}-${String(order._id || '').slice(-6).toUpperCase()}`;
}
function lineSummary(order) {
  let count = 0;
  let total = 0;
  for (const kot of order.kotLines || []) {
    for (const item of kot?.items || []) {
      if (!item || item.returned) continue;
      count += 1;
      total += (Number(item.price || 0) / 100) * (Number(item.quantity) || 0);
    }
  }
  for (const addon of order.selectedAddons || []) {
    if (!addon) continue;
    count += 1;
    total += (Number(addon.price) || 0) * (Number(addon.quantity) || 1);
  }
  return { count, total: Number(total.toFixed(2)) };
}
function toRow(order) {
  const resolved = takeawayOrderType(order);
  const lines = lineSummary(order);
  return {
    'Order ID': order._id || '',
    'Invoice ID': invoiceId(order),
    'Created At': formatBusinessDateTime(order.createdAt),
    'Updated At': formatBusinessDateTime(order.updatedAt),
    Status: order.status || '',
    'Service Type': resolved || (String(order.serviceType || '').toUpperCase() === 'DINE_IN' ? 'Dine-In' : String(order.serviceType || '')),
    'Order Type': resolved,
    'Table / Counter': order.tableNumber || '',
    Token: order.takeawayToken ?? '',
    Customer: order.customerName || order.customer?.name || '',
    Mobile: order.customerMobile || order.customerPhone || order.customer?.phone || '',
    'Items Count': lines.count,
    'Total Amount (Rs)': lines.total,
  };
}
function style(cell, styleValue) {
  cell.font = styleValue.font;
  if (styleValue.fill) cell.fill = styleValue.fill;
  if (styleValue.alignment) cell.alignment = styleValue.alignment;
}
async function build({ cartId, franchiseId, start, end, generatedAt = new Date() }) {
  const orders = await Order.find({
    cartId, franchiseId, createdAt: { $gte: start, $lt: end },
  }).sort({ createdAt: 1, _id: 1 }).lean();
  const dateKey = getBusinessDateKey(start, TIMEZONE);
  const rows = orders.map(toRow);
  const total = Number(rows.reduce((sum, row) => sum + row['Total Amount (Rs)'], 0).toFixed(2));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TerraCart';
  const sheet = workbook.addWorksheet('Orders');
  const title = sheet.addRow(['Orders Report']);
  sheet.mergeCells(1, 1, 1, HEADERS.length);
  style(title.getCell(1), {
    font: { bold: true, size: 16, color: { argb: 'FF111827' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } },
    alignment: { horizontal: 'center' },
  });
  for (const [label, value] of [
    ['Date Range', dateKey], ['Status', 'All'], ['Order / Token Search', 'All'],
    ['Table Search', 'All'], ['Invoice Search', 'All'], ['Total Orders', rows.length],
    ['Generated At', formatBusinessDateTime(generatedAt)],
  ]) {
    const row = sheet.addRow([label, value]);
    style(row.getCell(1), { font: { bold: true, color: { argb: 'FF374151' } } });
  }
  sheet.addRow([]);
  const header = sheet.addRow(HEADERS);
  header.eachCell(cell => style(cell, {
    font: { bold: true, color: { argb: 'FF111827' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } },
    alignment: { horizontal: 'center' },
  }));
  for (const data of rows) {
    const row = sheet.addRow(HEADERS.map(key => data[key]));
    row.getCell(HEADERS.length).numFmt = '#,##0.00';
  }
  sheet.autoFilter = {
    from: { row: header.number, column: 1 },
    to: { row: rows.length ? header.number + rows.length : header.number, column: HEADERS.length },
  };
  sheet.addRow([]);
  const amountColumn = HEADERS.indexOf('Total Amount (Rs)') + 1;
  const totalValues = Array(HEADERS.length).fill('');
  totalValues[0] = `TOTAL AMOUNT FOR DATE RANGE (${dateKey})`;
  totalValues[amountColumn - 1] = total;
  const totalRow = sheet.addRow(totalValues);
  if (amountColumn > 2) sheet.mergeCells(totalRow.number, 1, totalRow.number, amountColumn - 1);
  for (let column = 1; column <= HEADERS.length; column += 1) {
    style(totalRow.getCell(column), {
      font: { bold: true, color: { argb: 'FF111827' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } },
    });
  }
  totalRow.getCell(amountColumn).numFmt = '#,##0.00';
  HEADERS.forEach((name, index) => {
    const longest = rows.reduce((max, row) => Math.max(max, String(row[name] ?? '').length), name.length);
    sheet.getColumn(index + 1).width = Math.min(44, Math.max(12, longest + 2));
  });
  return {
    filename: `orders-report-${dateKey}.xlsx`,
    content: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64'),
  };
}
function attach(content, file) {
  const note = `Orders spreadsheet attached: ${file.filename}. It uses the same columns as Orders → Download Excel.`;
  const safe = note.replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character]));
  return {
    ...content,
    text: `${content.text}\n${note}`,
    html: `${content.html}<p style="font-family:Arial,sans-serif;font-size:13px;color:#442F25">${safe}</p>`,
    attachments: [{ filename: file.filename, content: file.content, contentType: CONTENT_TYPE }],
  };
}
module.exports = { build, attach, HEADERS, toRow };
