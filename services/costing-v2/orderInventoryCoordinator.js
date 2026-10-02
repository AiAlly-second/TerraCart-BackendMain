/**
 * Order Inventory Coordinator
 *
 * Single place that decides, for any Order/KOT/Payment trigger, whether an
 * Inventory side effect should run, and records the outcome on the order in a
 * way that is safe to re-check later. No controller should re-implement this
 * decision (see docs/inventory-disable/03-BACKEND-INVENTORY-ENFORCEMENT.md).
 *
 * Core rule: Inventory is always an optional side effect of a business
 * operation. This module never blocks or fails the calling Order/KOT/Payment
 * flow - callers already saved the real business change before calling this.
 */

const Order = require("../../models/orderModel");
const featureService = require("../featureService");
const { resolveCartScope } = require("../../utils/costing-v2/inventoryScope");
// Accessed via the module object (not destructured) so tests can stub
// consumeIngredientsForOrder to exercise the thrown-error path deterministically.
const orderConsumptionService = require("./orderConsumptionService");

const TERMINAL_NO_RETRY_STATES = new Set(["skipped_feature_disabled"]);
const NOT_CLAIMABLE_STATES = new Set(["processing", "skipped_feature_disabled"]);

const logEvent = (event, details = {}) => {
  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === null) continue;
    safe[key] = typeof value === "object" && value.toString ? value.toString() : value;
  }
  console.warn(`[${event}]`, JSON.stringify(safe));
};

/**
 * Resolve whether Inventory is enabled for the order's own cart/franchise.
 * Never trusts order.franchiseId blindly - re-derives it from the cart, the
 * same way Phase 01's consumeIngredientsForOrder already does. Any
 * resolution failure fails closed (Inventory treated as disabled) - it never
 * fails the calling Order/KOT/Payment operation.
 */
const resolveOrderInventoryEnabled = async (order, trigger) => {
  try {
    const scope = await resolveCartScope(order.cartId, {
      orderId: order._id,
      operation: `inventory-coordinator:${trigger}`,
    });
    const enabled = await featureService.isFeatureEnabled({
      featureKey: featureService.INVENTORY,
      franchiseAdminId: scope.franchiseId,
    });
    return { enabled, franchiseId: scope.franchiseId };
  } catch (error) {
    logEvent("INVENTORY_FEATURE_RESOLUTION_FAILED", {
      orderId: order._id,
      cartId: order.cartId,
      trigger,
      message: error.message,
    });
    return { enabled: false, franchiseId: null };
  }
};

const inventoryStateForNewOrder = async (orderData) => {
  const { enabled, franchiseId } = await resolveOrderInventoryEnabled(orderData, "order_created");
  if (enabled && String(franchiseId) === String(orderData.franchiseId)) return {};
  const addons = new Map();
  for (const raw of orderData.selectedAddons || []) {
    const addon = orderConsumptionService.normalizeAddonForConsumption(raw);
    const key = orderConsumptionService.buildAddonConsumptionKey(addon);
    if (key) addons.set(key, Math.max(addons.get(key) || 0, addon.quantity));
  }
  logEvent("INVENTORY_FEATURE_DISABLED_SKIP", { orderId: orderData._id,
    cartId: orderData.cartId, franchiseId, trigger: "order_created" });
  return { inventoryProcessingState: "skipped_feature_disabled",
    inventorySkippedAt: new Date(),
    inventorySkippedKotIndexes: (orderData.kotLines || []).map((_, index) => index),
    inventorySkippedAddonQuantities: [...addons].map(([key, qty]) => ({ key, qty })) };
};

const markSkippedFeatureDisabled = async (orderId) => {
  const current = await Order.findById(orderId).select(
    "kotLines selectedAddons inventorySkippedKotIndexes inventorySkippedAddonQuantities inventoryProcessingState"
  ).lean();
  if (!current || current.inventoryProcessingState === "processing") return;
  const skippedKotIndexes = [...new Set([
    ...(current.inventorySkippedKotIndexes || []),
    ...(current.kotLines || []).map((_, index) => index),
  ])];
  const addons = new Map((current.inventorySkippedAddonQuantities || [])
    .map(entry => [entry.key, entry.qty]));
  for (const raw of current.selectedAddons || []) {
    const addon = orderConsumptionService.normalizeAddonForConsumption(raw);
    const key = orderConsumptionService.buildAddonConsumptionKey(addon);
    if (key) addons.set(key, Math.max(addons.get(key) || 0, addon.quantity));
  }
  await Order.updateOne(
    { _id: orderId, inventoryProcessingState: { $ne: "processing" } },
    { $set: { inventoryProcessingState: "skipped_feature_disabled", inventorySkippedAt: new Date(),
      inventorySkippedKotIndexes: skippedKotIndexes,
      inventorySkippedAddonQuantities: [...addons].map(([key, qty]) => ({ key, qty })) } },
  );
};

/** Atomically claim the order for processing. Returns false if another
 * request already claimed it, it is already permanently skipped, or Mongo
 * doesn't report a match (treated as "someone else has it"). */
const claimForProcessing = async (orderId) => {
  const result = await Order.updateOne(
    { _id: orderId, inventoryProcessingState: { $nin: [...NOT_CLAIMABLE_STATES] } },
    { $set: { inventoryProcessingState: "processing" } },
  );
  return (result.modifiedCount ?? result.nModified ?? 0) > 0;
};

const classifyConsumptionResult = (result) => {
  if (!result) return { outcome: "failed", consumed: false };
  if (result.success === true) return { outcome: "deducted", consumed: true };
  const consumedCount = Array.isArray(result.summary?.ingredientsConsumed)
    ? result.summary.ingredientsConsumed.length
    : 0;
  const processedCount = Number(result.summary?.itemsProcessed || 0);
  if (consumedCount > 0 || processedCount > 0) {
    return { outcome: "partial", consumed: true };
  }
  return { outcome: "failed", consumed: false };
};

const recordOutcome = async (orderId, outcome) => {
  const set = { inventoryProcessingState: outcome };
  if (outcome !== "failed") {
    set.inventoryDeducted = true;
    set.inventoryDeductedAt = new Date();
  }
  await Order.updateOne({ _id: orderId }, { $set: set });
};

/**
 * Actually calls consumeIngredientsForOrder and records the real outcome.
 * Never throws - callers can fire-and-forget or await it.
 */
const runConsumptionAndRecord = async ({ order, userId, trigger }) => {
  let result;
  try {
    // Re-read skip markers written by earlier OFF-period KOT/add-on operations.
    const current = await Order.findById(order._id);
    result = await orderConsumptionService.consumeIngredientsForOrder(current || order, userId);
  } catch (error) {
    await recordOutcome(order._id, "failed");
    logEvent("INVENTORY_PROCESSING_FAILED", {
      orderId: order._id, trigger, message: error.message, mode: "thrown",
    });
    return { processed: false, outcome: "failed", reason: "threw", error: error.message };
  }

  const { outcome } = classifyConsumptionResult(result);
  await recordOutcome(order._id, outcome);

  const event = outcome === "deducted" ? "INVENTORY_PROCESSING_COMPLETED"
    : outcome === "partial" ? "INVENTORY_PROCESSING_PARTIAL"
      : "INVENTORY_PROCESSING_FAILED";
  logEvent(event, {
    orderId: order._id,
    trigger,
    itemsProcessed: result?.summary?.itemsProcessed,
    ingredientsConsumed: result?.summary?.ingredientsConsumed?.length,
    errors: result?.summary?.errors?.length,
  });

  return { processed: outcome !== "failed", outcome, result };
};

/**
 * Call for any trigger that represents the order's FIRST Inventory attempt:
 * PREPARING, the READY/COMPLETED fallback, finalizeOrder,
 * confirmPaymentByCustomer, and the payment-controller fallback.
 *
 * Eligible only when the order has never been deducted and has not
 * permanently opted out via a disabled-feature skip. Safe to call
 * unconditionally from those triggers - it is a no-op otherwise.
 *
 * Two near-simultaneous initial attempts on the same order (e.g. a
 * duplicate status-update request) are serialized by claimForProcessing's
 * atomic pending/failed -> processing transition: only one caller can win
 * the claim, so only one logical consumption runs.
 */
const maybeProcessInitialInventory = async ({ order, userId, trigger }) => {
  if (!order?.cartId) return { processed: false, reason: "no_cart" };
  if (order.inventoryDeducted === true) return { processed: false, reason: "already_deducted" };
  if (TERMINAL_NO_RETRY_STATES.has(order.inventoryProcessingState)) {
    return { processed: false, reason: "skipped_feature_disabled" };
  }
  if (!userId) return { processed: false, reason: "no_user" };

  const { enabled, franchiseId } = await resolveOrderInventoryEnabled(order, trigger);
  if (!enabled) {
    await markSkippedFeatureDisabled(order._id);
    logEvent("INVENTORY_FEATURE_DISABLED_SKIP", {
      orderId: order._id, cartId: order.cartId, franchiseId, trigger,
    });
    return { processed: false, reason: "feature_disabled" };
  }

  const claimed = await claimForProcessing(order._id);
  if (!claimed) {
    return { processed: false, reason: "claim_unavailable" };
  }
  logEvent("INVENTORY_PROCESSING_STARTED", {
    orderId: order._id, cartId: order.cartId, franchiseId, trigger,
  });
  return runConsumptionAndRecord({ order, userId, trigger });
};

/**
 * Call for any trigger that represents an INCREMENTAL Inventory delta on an
 * order that already began its Inventory lifecycle: addKot, updateOrderAddons.
 *
 * Eligible once the order has been deducted, is mid-processing, or
 * previously failed/partially processed - not only once fully "deducted" -
 * so a KOT/add-on added while the order's initial consumption is still
 * finishing is not silently dropped. Not permanently opted out via a
 * disabled-feature skip.
 *
 * Deliberately does not take the same exclusive claim as the initial
 * trigger: it must still be able to run while an initial attempt for the
 * same order is mid-flight. Protection against double-counting the same
 * KOT/add-on line is delegated to consumeIngredientsForOrder's own
 * per-KOT-index / per-addon-event idempotency (existing since Phase 01),
 * exactly as it was before Phase 03.
 */
const maybeProcessIncrementalInventory = async ({ order, userId, trigger }) => {
  if (!order?.cartId) return { processed: false, reason: "no_cart" };
  const state = order.inventoryProcessingState;
  const hasBegunProcessing = order.inventoryDeducted === true ||
    ["processing", "deducted", "partial", "failed", "skipped_feature_disabled"].includes(state);
  if (!hasBegunProcessing) return { processed: false, reason: "not_yet_deducted" };
  // A previously deducted order may receive a NEW KOT after reconciliation.
  // The consumption service excludes every KOT/add-on recorded as skipped.
  if (!userId) return { processed: false, reason: "no_user" };

  const { enabled, franchiseId } = await resolveOrderInventoryEnabled(order, trigger);
  if (!enabled) {
    await markSkippedFeatureDisabled(order._id);
    logEvent("INVENTORY_FEATURE_DISABLED_SKIP", {
      orderId: order._id, cartId: order.cartId, franchiseId, trigger,
    });
    return { processed: false, reason: "feature_disabled" };
  }
  logEvent("INVENTORY_PROCESSING_STARTED", {
    orderId: order._id, cartId: order.cartId, franchiseId, trigger,
  });
  return runConsumptionAndRecord({ order, userId, trigger });
};

module.exports = {
  inventoryStateForNewOrder,
  maybeProcessInitialInventory,
  maybeProcessIncrementalInventory,
};
