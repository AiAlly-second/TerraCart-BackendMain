const { TIMEZONE, readableTime } = require('./time');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = value => value == null ? 'Not available' : new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 2,
}).format(value);
function render(report, options = ['orders', 'sales', 'payments', 'profit']) {
  let logo = '';
  try {
    const url = new URL(process.env.DAILY_REPORT_LOGO_URL || '');
    if (url.protocol === 'https:' && !url.username && !url.password) {
      logo = `<img src="${escape(url.href)}" alt="TerraCart" width="80" style="max-width:80px;height:auto;border:0">`;
    }
  } catch { /* Branding text remains readable when remote images are unavailable. */ }
  const date = new Intl.DateTimeFormat('en-IN', { timeZone: TIMEZONE, day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(report.periodEnd));
  const heading = `Today's Business Snapshot — As of ${readableTime(report.periodEnd)} IST`;
  const summary = [];
  if (options.includes('orders')) summary.push(['Total orders', report.orders.total]);
  if (options.includes('sales')) summary.push(['Gross sales before discounts', inr(report.grossSales)],
    ['Recognized sales', inr(report.sales)], ['Retained net revenue', inr(report.netRevenue)]);
  if (options.includes('profit')) summary.push(['Gross profit', inr(report.grossProfit)],
    ['Profit margin', report.profitMargin == null ? 'Not available' : `${report.profitMargin}%`]);
  const sections = summary.length ? [['Summary', summary]] : [];
  if (options.includes('orders')) sections.push(['Order summary', [
    ['Total orders placed', report.orders.total], ['Completed', report.orders.completed],
    ['Pending', report.orders.pending], ['Cancelled', report.orders.cancelled],
    ['Returned orders (not confirmed refunds)', report.orders.returned], ['Average paid order value', inr(report.averageOrderValue)],
  ]]);
  if (options.includes('sales')) sections.push(['Financial details', [
    ['Recognized sales (including tax)', inr(report.sales)], ['Gross sales before discounts', inr(report.grossSales)],
    ['Discounts', inr(report.discounts)], ['Taxes', inr(report.taxes)],
    ['Collected revenue', inr(report.collected)], ['Confirmed refunds', inr(report.refunds)],
    ['Retained net revenue', inr(report.netRevenue)],
  ]]);
  if (options.includes('payments')) sections.push(['Payment breakdown (collected)', Object.entries(report.payments).map(([key, value]) => [key, inr(value)])]);
  if (options.includes('profit')) sections.push(['Gross profit', [
    ['Revenue basis (excluding tax)', inr(report.profitRevenue)], ['Cost of goods sold', inr(report.cogs)],
    ['Recorded ingredient costs (coverage not guaranteed)', inr(report.recordedIngredientCost)],
    ['Gross profit', inr(report.grossProfit)], ['Gross profit margin', report.profitMargin == null ? 'Not available' : `${report.profitMargin}%`],
    ['Cost data', report.profitNote],
  ]]);
  const generated = new Intl.DateTimeFormat('en-IN', { timeZone: TIMEZONE, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.generatedAt));
  const footer = `Generated ${generated} IST | ${report.cartName}${report.franchiseName ? ` | ${report.franchiseName}` : ''} | Automated report from TerraCart. Confidential business information for authorized recipients only.`;
  const text = [`TerraCart | ${report.cartName} | ${date}`, heading,
    `Period: ${date}, 00:00 IST to ${readableTime(report.periodEnd)} IST (end exclusive).`,
    ...sections.flatMap(([title, rows]) => [title, ...rows.map(([label, value]) => `${label}: ${value ?? 'Not available'}`)]),
    ...report.notes, footer].join('\n');
  // Table layout and inline styles work without CSS/grid support in Outlook.
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#FFF8EE;color:#442F25;font-family:Arial,sans-serif"><table role="presentation" width="100%"><tr><td align="center"><table role="presentation" width="100%" style="max-width:620px;background:white"><tr><td style="padding:24px;background:#825E4A;color:white">${logo}<h1 style="margin:0;font-size:24px">TerraCart</h1><p>${escape(report.cartName)} · ${escape(date)}</p><h2 style="font-size:18px">${escape(heading)}</h2><p>00:00 IST – ${escape(readableTime(report.periodEnd))} IST (end exclusive)</p></td></tr>${sections.map(([title, rows]) => `<tr><td style="padding:20px"><h2 style="font-size:18px">${escape(title)}</h2><table width="100%">${rows.map(([label, value]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #F7ECDA">${escape(label)}</td><td align="right" style="padding:8px 0;border-bottom:1px solid #F7ECDA">${escape(value ?? 'Not available')}</td></tr>`).join('')}</table></td></tr>`).join('')}<tr><td style="padding:20px;font-size:13px">${report.notes.map(note => `<p>${escape(note)}</p>`).join('')}<p>${escape(footer)}</p></td></tr></table></td></tr></table></body></html>`;
  return { subject: `TerraCart | Daily Sales & Profit Report | ${String(report.cartName).replace(/[\r\n]/g, ' ')} | ${date}`, html, text };
}
module.exports = { render, escape, inr };
