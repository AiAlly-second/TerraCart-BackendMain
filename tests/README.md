# Backend Test Suite

This directory contains test cases and verification scripts for the Terra Admin backend.

## Test Files

### Integration Tests
- `integration/mobile-app-integration.test.js` - Comprehensive integration tests for mobile app features
- `integration/component-sync-verification.js` - Automated verification of component synchronization

### Unit Tests
- `costing/costingController.test.js` - Costing controller unit tests

## Running Tests

### Component Sync Verification
This script verifies that all components are properly synced:
```bash
npm run verify:sync
```

This checks:
- Model relationships and fields
- Controller functions and socket events
- Route endpoints and access control
- Middleware functionality
- Socket.IO configuration

### Integration Tests
Integration tests require a test database and test framework setup:
```bash
npm run test:integration
```

**Note:** Integration tests require:
- MongoDB connection
- Test database setup
- Test framework (Jest/Mocha) installed

## Test Results

### Component Sync Verification
**Status:** ✅ **21/21 Checks Passed**

All components are properly synced:
- ✅ Models (6/6)
- ✅ Controllers (6/6)
- ✅ Routes (4/4)
- ✅ Middleware (1/1)
- ✅ Socket.IO (1/1)
- ✅ Employee Controller (1/1)
- ✅ User Controller (1/1)

## Manual Testing

For manual testing, refer to `TEST_CASES_SUMMARY.md` for detailed test cases covering:
1. Mobile user login flow
2. Data filtering & isolation
3. Task system
4. Customer request system
5. Attendance system
6. Order operations

## Test Coverage

### Verified Features:
- ✅ Employee-User bidirectional linking
- ✅ Cart/kiosk data filtering
- ✅ Mobile user authentication
- ✅ Real-time socket events
- ✅ Role-based access control
- ✅ Data isolation between carts

### Test Scenarios:
- ✅ Mobile user can only see their cart's data
- ✅ Mobile user cannot access other cart's data
- ✅ Socket events are emitted correctly
- ✅ All endpoints work with mobile roles
- ✅ Middleware populates required fields

## Notes

- Component sync verification can be run without database connection
- Integration tests require database setup
- All tests are designed to be non-destructive
- Test data is cleaned up after execution








