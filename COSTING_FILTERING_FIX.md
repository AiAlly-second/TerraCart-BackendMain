# Costing Data Filtering Fix - Cart/Kiosk/Cafe Isolation

## Problem
The costing sidebar (Ingredients, Suppliers, Purchases, Recipes, Menu Items, Inventory, Waste, Labour & Overhead, Expenses) was showing data from ALL carts/kiosks/cafes instead of filtering by the specific cart/kiosk/cafe the user belongs to.

## Solution
Implemented role-based filtering for all costing endpoints to ensure cart admins only see data from their own cart/kiosk/cafe.

## Backend Changes

### 1. **getSuppliers** (`/api/costing-v2/suppliers`)
- **Issue**: Was returning ALL suppliers regardless of cart
- **Fix**: For cart admins, only returns suppliers that are:
  - Referenced by their cart's ingredients (preferredSupplierId)
  - Used in their cart's purchases (supplierId)
- **Implementation**: Queries ingredients and purchases filtered by `outletId = req.user._id`, then returns only those suppliers

### 2. **getIngredients** (`/api/costing-v2/ingredients`)
- **Issue**: Was using `skipOutletFilter: true` which allowed cart admins to see shared/global ingredients
- **Fix**: For cart admins, always filters by `outletId = req.user._id` (no shared ingredients)
- **Implementation**: Changed `skipOutletFilter` logic to only skip for franchise/super admins when no outletId is specified

### 3. **getLowStock** (`/api/costing-v2/low-stock`)
- **Issue**: Was using `skipOutletFilter: true` which showed low stock from all carts
- **Fix**: For cart admins, only shows low stock items from their cart
- **Implementation**: Changed to filter by `outletId` for cart admins

### 4. **All Other Endpoints** (Already Filtering Correctly)
- ✅ **getPurchases**: Uses `buildCostingQuery` - filters by `outletId` for cart admins
- ✅ **getRecipes**: Uses `buildCostingQuery` - filters by `outletId` for cart admins
- ✅ **getMenuItems**: Uses `buildCostingQuery` - filters by `outletId` for cart admins
- ✅ **getWaste**: Has explicit filtering - `filter.outletId = req.user._id` for cart admins
- ✅ **getExpenses**: Uses `buildCostingQuery` - filters by `outletId` for cart admins
- ✅ **getLabourCosts**: Uses `buildCostingQuery` - filters by `outletId` for cart admins
- ✅ **getOverheads**: Uses `buildCostingQuery` - filters by `outletId` for cart admins
- ✅ **getFoodCostReport**: Filters transactions and orders by `outletId`/`cartId` for cart admins
- ✅ **getPnLReport**: Filters all data sources (transactions, orders, labour, overhead, expenses) by `outletId`/`cartId` for cart admins

## Frontend Status
- ✅ Frontend components correctly do NOT pass `outletId` for cart admins (OutletFilter returns null)
- ✅ Backend automatically filters by `req.user._id` for cart admins
- ✅ No frontend changes needed - backend handles all filtering automatically

## How It Works

### For Cart Admins (role: "admin")
1. Backend automatically sets `filter.outletId = req.user._id` for all queries
2. Only data belonging to their cart/kiosk is returned
3. No need to pass `outletId` in API calls - backend handles it automatically

### For Franchise Admins (role: "franchise_admin")
1. Can see data from all carts under their franchise
2. Can optionally filter by specific `outletId` via query parameter
3. If no `outletId` specified, sees aggregated data from all franchise carts

### For Super Admins (role: "super_admin")
1. Can see all data across all franchises and carts
2. Can optionally filter by specific `outletId` via query parameter
3. If no `outletId` specified, sees all data

## Testing
1. Login as a cart admin
2. Navigate to Costing sidebar
3. Check each section (Ingredients, Suppliers, Purchases, Recipes, Menu Items, Inventory, Waste, Labour & Overhead, Expenses)
4. Verify only data from that specific cart is shown
5. Login as a different cart admin and verify different data is shown

## Debug Logging
Added console.log statements to help debug filtering:
- `[GET_INGREDIENTS] Cart admin filter`
- `[GET_LOW_STOCK] Cart admin filter`
- `[FOOD_COST_REPORT] Cart admin filter`
- `[PNL_REPORT] Cart admin filter`

These logs show the `outletId` being used for filtering and can help identify any issues.

