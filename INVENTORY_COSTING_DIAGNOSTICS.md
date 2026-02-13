# Inventory Consumption & Food Cost Diagnostics

When inventory consumption or food cost is not working, run this pre-flight check before testing.

## Costing vs Costing-V2 (Important)

- **Finances panel** (`/costing-v2/*`) uses **costing-v2** only. Food cost, PnL, and inventory consumption all use:
  - `InventoryTransactionV2` (costing-v2 model)
  - `MenuItemV2`, `RecipeV2`, `IngredientV2`
- **Old costing** (`/admin/costing/*`) uses a different model (`InventoryTransaction` from `inventoryTransactionModel.js`) and does **not** receive order consumption.
- Order consumption **always** writes to costing-v2. Use **Finances** (costing-v2) to see food cost.

## Pre-flight Diagnostic

Run the BOM & Inventory diagnosis script:

```bash
# From project root
node backend/scripts/diagnose-bom-inventory.js [cartId]
```

If `cartId` is omitted, the script uses the first active cart admin.

### What to Check

1. **Cart items with no Finances entry**
   - If any cart menu items are missing from Finances (MenuItemV2), consumption will fail for those items.
   - **Action:** Run "Sync from Cart Menu" in Finances > Menu Items.

2. **Menu items without BOM**
   - MenuItemV2 entries without a linked recipe will not consume ingredients.
   - **Action:** Link recipes in Finances > Menu Items, or create matching BOMs in Finances > Recipes.

3. **Name mismatches**
   - Cart menu names must match Finances menu names (case-insensitive). The script reports potential mismatches.

## Verification Steps

1. Run `node backend/scripts/diagnose-bom-inventory.js` and fix any reported issues.
2. Create a test order with items that exist in Finances and have recipes linked.
3. Change status to Preparing (dine-in) or Being Prepared (takeaway) and check server logs for `[COSTING]` success/errors.
4. Or: Finalize order (dine-in) / Complete order (takeaway) and check logs.
5. Confirm payment and check Finances sidebar for food cost.
6. If food cost is still 0, inspect logs for "Menu item not found" or "no recipe" and sync/link in Finances.

## Consumption Triggers

Inventory consumption runs when:

- **updateOrderStatus** (PATCH `/orders/:id/status`): Preparing, Being Prepared, Ready, Served, Completed, Paid, or Exit
- **finalizeOrder** (POST `/orders/:id/finalize`): Served to Finalized
- **confirmPaymentByCustomer** (PATCH `/orders/:id/confirm-payment`): Customer confirms payment
- **markPaymentPaid** (payment controller): Admin marks payment as paid

## Related Scripts

- `backend/scripts/diagnose-bom-inventory.js` - BOM & inventory sync check
- `backend/scripts/diagnose-food-cost.js` - Food cost calculation check
