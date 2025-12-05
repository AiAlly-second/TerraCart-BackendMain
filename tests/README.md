# Costing Feature Tests

## Setup

To run the tests, you'll need to install the required testing dependencies:

```bash
npm install --save-dev jest mongodb-memory-server @types/jest
```

## Running Tests

```bash
# Run all tests
npm test

# Run only costing tests
npm test -- costingController.test.js

# Run with coverage
npm test -- --coverage
```

## Test Structure

- `costing/costingController.test.js` - Unit tests for costing controller endpoints
- Additional test files can be added for:
  - Model validation tests
  - Route integration tests
  - Business logic tests (plate cost calculation, ROI, etc.)

## Note

The tests use MongoDB Memory Server for isolated testing without requiring a real database connection.









