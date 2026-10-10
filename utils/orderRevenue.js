// Unchanged dashboard calculation: item prices are paise; KOT/add-ons are INR.
const toFiniteNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const toRupeesFromPaise = value => Number((toFiniteNumber(value) / 100).toFixed(2));
const calculateOrderRevenue = (order) => {
  const kotLines = Array.isArray(order?.kotLines) ? order.kotLines : [];
  const selectedAddons = Array.isArray(order?.selectedAddons)
    ? order.selectedAddons
    : [];

  let kotTotal = kotLines.reduce((sum, kotLine) => {
    return sum + toFiniteNumber(kotLine?.totalAmount);
  }, 0);

  // Fallback for legacy/incomplete KOT totals.
  if (kotTotal <= 0) {
    const kotTotalInPaise = kotLines.reduce((sum, kotLine) => {
      const items = Array.isArray(kotLine?.items) ? kotLine.items : [];
      return (
        sum +
        items.reduce((itemSum, item) => {
          if (!item || item.returned) return itemSum;
          const quantity = Math.max(0, Math.floor(toFiniteNumber(item?.quantity) || 0));
          const priceInPaise = toFiniteNumber(item?.price);
          return itemSum + quantity * priceInPaise;
        }, 0)
      );
    }, 0);
    kotTotal = toRupeesFromPaise(kotTotalInPaise);
  }

  const addonTotal = selectedAddons.reduce((sum, addon) => {
    const quantity = Math.max(0, Math.floor(toFiniteNumber(addon?.quantity) || 1));
    return sum + toFiniteNumber(addon?.price) * quantity;
  }, 0);

  const officeChargeRaw = toFiniteNumber(order?.officeDeliveryCharge);
  const officeDeliveryCharge = officeChargeRaw > 0 ? officeChargeRaw : 0;

  return kotTotal + addonTotal + officeDeliveryCharge;
};
module.exports = { calculateOrderRevenue };
