# Employee Deletion - Orphaned User Account Fix

## Problem

When deleting an employee from the Employees page, the Employee record is deleted but the **associated User account is NOT deleted**. This causes orphaned user accounts to appear in the Super Admin's user management panel.

## Root Cause

The `deleteEmployee` function in `backend/controllers/employeeController.js` (lines 511-524) only deletes the Employee record:

```javascript
// CURRENT CODE (BROKEN)
exports.deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id, ...buildHierarchyQuery(req.user) };
    
    const employee = await Employee.findOneAndDelete(query);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    return res.json({ message: "Employee deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
```

## The Fix

Replace the `deleteEmployee` function (lines 511-524) with:

```javascript
// FIXED CODE
exports.deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };
    
    // First find the employee to get the userId
    const employee = await Employee.findOne(query);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    
    // Delete the associated User account if it exists
    if (employee.userId) {
      try {
        await User.findByIdAndDelete(employee.userId);
        console.log(`[DELETE_EMPLOYEE] Deleted associated User account: ${employee.userId}`);
      } catch (userError) {
        console.error('[DELETE_EMPLOYEE] Error deleting associated User:', userError.message);
        // Continue with employee deletion even if User deletion fails
      }
    }
    
    // Delete the employee record
    await Employee.findByIdAndDelete(id);
    
    return res.json({ 
      message: "Employee and associated user account deleted successfully" 
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
```

## What This Fixes

1. **Finds the employee first** to get the `userId` 
2. **Deletes the associated User account** if `userId` exists
3. **Then deletes the Employee record**
4. **Prevents orphaned user accounts** from showing in admin panel

## How to Apply

1. Open `backend/controllers/employeeController.js`
2. Find the `exports.deleteEmployee` function (around line 511)
3. Replace the entire function with the fixed code above
4. Save the file
5. The dev server will hot-reload automatically

## Testing

After applying the fix:

1. Go to Employees page
2. Delete an employee that has login access (waiter, cook, captain, or manager)
3. Go to Super Admin > Users panel
4. The deleted employee's user account should **no longer appear**

## Notes

- This fix also makes `buildHierarchyQuery` `await` properly (it's async)
- Logs are added for debugging
- If User deletion fails, Employee deletion still proceeds (graceful handling)
- The success message now mentions both records being deleted
