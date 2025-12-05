# Data Isolation Guide for Multi-Cart System

## Overview

This document explains how data isolation is maintained between different carts (kiosks) in the system. Each cart has completely separate operational data, while sharing configuration (menu structure) from the franchise level.

## Hierarchy

```
Super Admin
  └── Franchise Admin (has franchiseId)
      └── Cart Admin (has cartId + franchiseId)
          └── Operational Data (orders, tables, dashboard, etc.)
```

## Data Isolation Rules

### 1. **Configuration Data (SHARED)**
- **Menu Structure**: Copied from franchise to cart (not shared, but cloned)
- **Menu Items**: Each cart gets a copy of franchise menu items with new IDs
- **Purpose**: Ensures consistency in menu offerings across franchise

### 2. **Operational Data (ISOLATED)**
- **Orders**: Each cart has separate orders (filtered by `cartId`)
- **Tables**: Each cart has separate tables (filtered by `cartId`)
- **Customers**: Each cart has separate customer records (filtered by `cartId`)
- **Dashboard Stats**: Each cart has separate stats (calculated from cart's own data)
- **Employees**: Each cart has separate employee records (filtered by `cartId`)
- **Attendance**: Each cart has separate attendance records (filtered by `cartId`)
- **Inventory Transactions**: Each cart has separate inventory records (filtered by `outletId` = `cartId`)
- **Feedback**: Each cart has separate feedback records (filtered by `cartId`)
- **Payments**: Linked to orders, which are filtered by `cartId`

## Database Schema

### Models with `cartId` Field

All operational data models include a `cartId` field for filtering:

1. **Order Model** (`orderModel.js`)
   ```javascript
   cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }
   ```

2. **Table Model** (`tableModel.js`)
   ```javascript
   cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }
   ```

3. **Customer Model** (`customerModel.js`)
   ```javascript
   cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }
   ```

4. **Feedback Model** (`feedbackModel.js`)
   ```javascript
   cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }
   ```

5. **Employee Model** (`employeeModel.js`)
   ```javascript
   cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }
   ```

6. **Employee Attendance Model** (`employeeAttendanceModel.js`)
   ```javascript
   cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }
   ```

### Models with `outletId` Field (Costing Module)

For costing-related models, `outletId` is used instead of `cartId`:

1. **Inventory Transaction Model** (`inventoryTransactionModel.js`)
   ```javascript
   outletId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }
   ```

## Query Filtering Requirements

### CRITICAL: All queries MUST filter by cartId

When querying operational data, ALWAYS include `cartId` in the filter:

```javascript
// ✅ CORRECT - Filters by cartId
const orders = await Order.find({ cartId: req.user._id });

// ❌ WRONG - No cartId filter (will return data from all carts)
const orders = await Order.find({});
```

### Example: Proper Query Filtering

```javascript
// Get orders for current cart admin
exports.getOrders = async (req, res) => {
  try {
    const cartId = req.user._id; // Cart admin's user ID
    
    // CRITICAL: Always filter by cartId
    const orders = await Order.find({ cartId })
      .populate("table")
      .sort({ createdAt: -1 });
    
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
```

## New Cart Initialization

When a new cart is created:

1. **Menu Structure**: Copied from franchise (configuration only)
2. **Operational Data**: Starts EMPTY (no orders, tables, dashboard data)
3. **Data Isolation**: Verified to ensure no data leakage from other carts

See `backend/utils/initializeNewCart.js` for implementation.

## Data Isolation Verification

The `initializeNewCart` function:
1. Verifies no existing operational data exists for the new cart
2. Cleans up any accidentally created data
3. Verifies data isolation from other carts in the same franchise
4. Logs initialization status

## Best Practices

1. **Always Filter by cartId**: Every query for operational data must include `cartId`
2. **Use Indexes**: `cartId` fields are indexed for performance
3. **Verify Isolation**: Test that carts cannot see each other's data
4. **Dashboard Calculations**: Always calculate from cart's own data
5. **No Data Copying**: Never copy operational data when creating new carts

## Common Mistakes to Avoid

1. ❌ **Querying without cartId filter**
   ```javascript
   // WRONG
   const orders = await Order.find({ status: "Pending" });
   ```

2. ❌ **Copying data from another cart**
   ```javascript
   // WRONG - Don't do this
   const sourceOrders = await Order.find({ cartId: sourceCartId });
   await Order.insertMany(sourceOrders.map(o => ({ ...o, cartId: newCartId })));
   ```

3. ❌ **Using franchiseId instead of cartId**
   ```javascript
   // WRONG - This would return data from all carts in franchise
   const orders = await Order.find({ franchiseId: req.user.franchiseId });
   ```

## Testing Data Isolation

To verify data isolation:

1. Create two carts under the same franchise
2. Create orders/tables in Cart A
3. Verify Cart B cannot see Cart A's data
4. Verify Cart A cannot see Cart B's data
5. Verify franchise admin can see both carts' data (aggregated)

## Summary

- **Configuration (Menu)**: Copied from franchise → cart (cloned, not shared)
- **Operational Data**: Completely isolated per cart (filtered by `cartId`)
- **New Carts**: Start with empty operational data (0 orders, 0 tables, null dashboard)
- **Queries**: Always filter by `cartId` for operational data
- **Isolation**: Verified during cart initialization


