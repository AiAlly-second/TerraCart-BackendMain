# BACKEND DIAGNOSIS REPORT
## Terra Admin Backend - Mobile App & Real-Time Compatibility Analysis

**Date:** Generated during backend enhancement  
**Scope:** Full backend analysis for mobile app roles (Waiter, Cook, Captain, Manager) and real-time operations

---

## EXECUTIVE SUMMARY

The backend has a solid foundation for admin roles but requires significant enhancements to fully support mobile app roles and real-time operations. Key gaps include missing data models, incomplete socket event handling, and insufficient cart/kiosk-level filtering.

---

## 1. CRITICAL MISSING FEATURES

### 1.1 Employee-User Relationship
**Status:** ❌ INCOMPLETE  
**Issue:** Employee model lacks `userId` field to link to User model. Currently using email matching which is fragile and error-prone.

**Impact:**
- Mobile users cannot reliably link Employee records to User accounts
- Login flow depends on email matching which can fail
- No direct relationship between Employee and User

**Required Fix:**
- Add `userId` field to Employee model
- Update employee creation/update logic to link User accounts
- Update login flow to use userId instead of email matching

---

### 1.2 User Model Missing cafeId Field
**Status:** ❌ MISSING  
**Issue:** User model doesn't have `cafeId` field for mobile users. Currently relying on Employee lookup during each request.

**Impact:**
- Performance overhead (Employee lookup on every request)
- Inconsistent data access patterns
- Socket room joining requires Employee lookup

**Required Fix:**
- Add `cafeId` field to User model
- Populate cafeId during employee creation/login
- Use cafeId directly in queries instead of Employee lookup

---

### 1.3 Task System
**Status:** ❌ PLACEHOLDER ONLY  
**Issue:** Task routes exist but return empty arrays. No model, controller, or business logic.

**Impact:**
- Mobile app expects task functionality but backend doesn't support it
- No way to assign/manage tasks for waiters, cooks, captains, managers
- Missing real-time task updates

**Required Fix:**
- Create Task model with fields: title, description, assignedTo, status, priority, dueDate, cartId, franchiseId
- Implement full TaskController with CRUD operations
- Add socket events: `task:created`, `task:updated`, `task:completed`, `task:deleted`
- Filter tasks by cart/kiosk for mobile users

---

### 1.4 Customer Request System
**Status:** ❌ PLACEHOLDER ONLY  
**Issue:** Customer request routes exist but return empty arrays. No model, controller, or business logic.

**Impact:**
- Mobile app expects customer request functionality but backend doesn't support it
- No way to handle customer requests (water, bill, etc.)
- Missing real-time request notifications

**Required Fix:**
- Create CustomerRequest model with fields: tableId, orderId, requestType, status, assignedTo, notes, cartId, franchiseId
- Implement full CustomerRequestController with CRUD operations
- Add socket events: `request:created`, `request:acknowledged`, `request:resolved`
- Filter requests by cart/kiosk for mobile users

---

## 2. SOCKET.IO REAL-TIME ISSUES

### 2.1 Missing Socket Rooms
**Status:** ⚠️ PARTIAL  
**Issue:** Only `join:cafe`, `join:franchise`, `join:role` exist. No `join:cart` or `join:kiosk` rooms.

**Impact:**
- Mobile users cannot join specific cart/kiosk rooms
- Real-time updates may not reach correct users
- No granular room control for cart-level operations

**Required Fix:**
- Add `join:cart` socket handler
- Add `join:kiosk` socket handler
- Update socket connection logic to auto-join cart/kiosk room on mobile login
- Ensure all socket events emit to correct rooms

---

### 2.2 Missing Socket Events
**Status:** ❌ INCOMPLETE  
**Issue:** Mobile app expects these events but backend doesn't emit them:
- `task:created`, `task:updated`, `task:completed`, `task:deleted`
- `request:created`, `request:acknowledged`, `request:resolved`
- `attendance:checked_in`, `attendance:checked_out`, `attendance:break_started`, `attendance:break_ended`

**Impact:**
- Mobile app won't receive real-time updates for tasks, requests, attendance
- Users must manually refresh to see updates
- Poor user experience

**Required Fix:**
- Add socket event emissions in TaskController
- Add socket event emissions in CustomerRequestController
- Add socket event emissions in AttendanceController
- Ensure events are emitted to correct cart/kiosk rooms

---

### 2.3 Socket Room Assignment
**Status:** ⚠️ INCOMPLETE  
**Issue:** Mobile users don't automatically join cart/kiosk rooms on connection. Socket connection doesn't include cartId/kioskId.

**Impact:**
- Mobile users may not receive real-time updates for their cart/kiosk
- Socket events may not reach intended recipients

**Required Fix:**
- Update socket connection handler to accept cartId/kioskId
- Auto-join cart/kiosk room on mobile user connection
- Update socket service to include cartId in connection payload

---

## 3. DATA FILTERING & ACCESS CONTROL

### 3.1 Cart/Kiosk Filtering
**Status:** ⚠️ INCONSISTENT  
**Issue:** Some controllers filter by cartId correctly, others don't. Mobile users may see data from other carts.

**Impact:**
- Data leakage between carts/kiosks
- Mobile users may see incorrect data
- Security concern

**Required Fix:**
- Audit all controllers for cart/kiosk filtering
- Ensure mobile users only see their cart/kiosk data
- Add helper function for consistent cart/kiosk query building
- Update OrderController, TableController, MenuController, etc.

---

### 3.2 Middleware Enhancements
**Status:** ⚠️ NEEDS IMPROVEMENT  
**Issue:** Auth middleware doesn't populate `req.user.cafeId` for mobile users. Each controller must do Employee lookup.

**Impact:**
- Code duplication
- Performance overhead
- Inconsistent patterns

**Required Fix:**
- Enhance `protect` middleware to populate `req.user.cafeId` for mobile users
- Add `req.user.employeeId` for mobile users
- Remove Employee lookups from individual controllers

---

## 4. API ENDPOINT GAPS

### 4.1 Missing Mobile-Specific Endpoints
**Status:** ❌ MISSING  
**Issue:** Some mobile app features require endpoints that don't exist:
- Get my tasks (filtered by assignedTo)
- Get pending customer requests for my cart
- Get today's attendance for my cart
- Get active orders for my cart (real-time)

**Impact:**
- Mobile app cannot fetch role-specific data
- Missing dashboard data endpoints

**Required Fix:**
- Add `/api/tasks/my` - Get tasks assigned to current user
- Add `/api/customer-requests/pending` - Get pending requests for cart
- Add `/api/attendance/my` - Get current user's attendance
- Add `/api/orders/active` - Get active orders for cart

---

### 4.2 Order Status Update Permissions
**Status:** ⚠️ NEEDS VERIFICATION  
**Issue:** Order status updates may not have proper role-based permissions. Cooks should update to "Preparing", waiters to "Served", etc.

**Impact:**
- Incorrect role permissions
- Security concerns

**Required Fix:**
- Review order status update permissions
- Add role-based status transition rules
- Ensure cooks can only update to "Preparing"/"Ready"
- Ensure waiters can only update to "Served"

---

## 5. DATABASE SCHEMA ISSUES

### 5.1 Missing Indexes
**Status:** ⚠️ POTENTIAL ISSUE  
**Issue:** Some queries may be slow without proper indexes on:
- Employee.userId (if added)
- User.cafeId (if added)
- Task.assignedTo, Task.cartId
- CustomerRequest.cartId, CustomerRequest.status

**Impact:**
- Slow queries
- Poor performance

**Required Fix:**
- Add indexes for new fields
- Review existing indexes
- Ensure compound indexes where needed

---

### 5.2 Missing Fields
**Status:** ❌ MISSING  
**Issue:** Several models missing fields needed for mobile app:
- User: `cafeId`, `employeeId`
- Employee: `userId`
- Task: (entire model missing)
- CustomerRequest: (entire model missing)

**Required Fix:**
- Add missing fields to existing models
- Create new models for Task and CustomerRequest

---

## 6. WHAT'S WORKING WELL

### ✅ Strengths:
1. **Order System** - Well-implemented with socket events
2. **Table Management** - Good cart filtering and socket support
3. **Attendance System** - Complete with break tracking
4. **Socket Infrastructure** - Socket.IO is set up correctly
5. **Authentication** - JWT-based auth works for admin roles
6. **Role Enum** - User model has correct role enum values
7. **Employee Model** - Has correct role enum and hierarchy fields

---

## 7. IMPLEMENTATION PRIORITY

### Priority 1 (Critical - Blocks Mobile App):
1. Add userId to Employee model
2. Add cafeId to User model
3. Implement Task system (model, controller, routes, sockets)
4. Implement CustomerRequest system (model, controller, routes, sockets)
5. Add socket room support for cart/kiosk

### Priority 2 (Important - Real-Time Updates):
6. Add missing socket events (tasks, requests, attendance)
7. Enhance middleware to populate req.user.cafeId
8. Update all controllers for cart/kiosk filtering

### Priority 3 (Enhancement - Better UX):
9. Add mobile-specific API endpoints
10. Review and fix order status permissions
11. Add database indexes
12. Performance optimization

---

## 8. BREAKING CHANGES RISK

### Low Risk:
- Adding fields to models (backward compatible)
- Adding new endpoints (doesn't break existing)
- Adding socket events (doesn't break existing)

### Medium Risk:
- Updating middleware (may affect existing auth flows)
- Changing Employee-User relationship (requires data migration)

### High Risk:
- None identified (all changes are additive)

---

## 9. TESTING REQUIREMENTS

### Unit Tests Needed:
- Task CRUD operations
- CustomerRequest CRUD operations
- Socket event emissions
- Cart/kiosk filtering logic

### Integration Tests Needed:
- Mobile user login flow
- Socket room joining
- Real-time event delivery
- Role-based access control

### Manual Testing Required:
- Mobile app login with all roles
- Real-time updates in mobile app
- Task assignment and completion
- Customer request flow
- Attendance tracking

---

## 10. ESTIMATED EFFORT

- **Task System:** 4-6 hours
- **CustomerRequest System:** 4-6 hours
- **Employee-User Relationship:** 2-3 hours
- **Socket Enhancements:** 3-4 hours
- **Middleware & Filtering:** 2-3 hours
- **Testing & Bug Fixes:** 3-4 hours

**Total:** ~18-26 hours

---

## CONCLUSION

The backend requires significant enhancements to fully support mobile app roles and real-time operations. The core infrastructure is solid, but missing features (Task system, CustomerRequest system) and incomplete real-time support need to be addressed. All changes are additive and backward-compatible, minimizing risk to existing admin functionality.

**Next Steps:**
1. Review and approve this diagnosis
2. Implement Priority 1 items
3. Test with mobile app
4. Implement Priority 2 & 3 items
5. Final testing and deployment

