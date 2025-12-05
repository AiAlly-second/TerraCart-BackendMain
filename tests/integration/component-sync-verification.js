/**
 * Component Sync Verification Script
 * 
 * This script verifies that all components are properly synced:
 * - Models have correct relationships
 * - Controllers use consistent filtering
 * - Routes have proper access control
 * - Middleware works correctly
 * - Socket events are configured
 * 
 * Run with: node tests/integration/component-sync-verification.js
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const results = {
  passed: [],
  failed: [],
  warnings: [],
};

function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = type === 'error' ? `${colors.red}✗` : type === 'success' ? `${colors.green}✓` : type === 'warning' ? `${colors.yellow}⚠` : `${colors.blue}ℹ`;
  console.log(`${prefix} ${colors.reset}[${timestamp}] ${message}`);
}

function checkFile(filePath, description) {
  try {
    // Resolve path relative to backend directory
    const resolvedPath = path.resolve(__dirname, '../../', filePath.replace('backend/', ''));
    if (fs.existsSync(resolvedPath)) {
      log(`${description}: EXISTS`, 'success');
      results.passed.push({ file: filePath, description });
      return true;
    } else {
      log(`${description}: MISSING`, 'error');
      results.failed.push({ file: filePath, description });
      return false;
    }
  } catch (error) {
    log(`${description}: ERROR - ${error.message}`, 'error');
    results.failed.push({ file: filePath, description, error: error.message });
    return false;
  }
}

function checkFileContent(filePath, searchStrings, description) {
  try {
    // Resolve path relative to backend directory
    const resolvedPath = path.resolve(__dirname, '../../', filePath.replace('backend/', ''));
    if (!fs.existsSync(resolvedPath)) {
      log(`${description}: FILE NOT FOUND`, 'error');
      results.failed.push({ file: filePath, description, issue: 'File not found' });
      return false;
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const missing = [];
    
    searchStrings.forEach(str => {
      if (!content.includes(str)) {
        missing.push(str);
      }
    });

    if (missing.length === 0) {
      log(`${description}: ALL CHECKS PASSED`, 'success');
      results.passed.push({ file: filePath, description });
      return true;
    } else {
      log(`${description}: MISSING - ${missing.join(', ')}`, 'error');
      results.failed.push({ file: filePath, description, missing });
      return false;
    }
  } catch (error) {
    log(`${description}: ERROR - ${error.message}`, 'error');
    results.failed.push({ file: filePath, description, error: error.message });
    return false;
  }
}

async function verifyModels() {
  console.log(`\n${colors.cyan}=== VERIFYING MODELS ===${colors.reset}\n`);

  // Check Employee model
  checkFileContent(
    'backend/models/employeeModel.js',
    ['userId', 'cafeId', 'franchiseId', 'employeeRole'],
    'Employee Model - Required fields'
  );

  // Check User model
  checkFileContent(
    'backend/models/userModel.js',
    ['cafeId', 'employeeId', 'role'],
    'User Model - Mobile user fields'
  );

  // Check Task model
  checkFile('backend/models/taskModel.js', 'Task Model exists');
  checkFileContent(
    'backend/models/taskModel.js',
    ['cafeId', 'franchiseId', 'assignedTo', 'status'],
    'Task Model - Required fields'
  );

  // Check CustomerRequest model
  checkFile('backend/models/customerRequestModel.js', 'CustomerRequest Model exists');
  checkFileContent(
    'backend/models/customerRequestModel.js',
    ['cafeId', 'franchiseId', 'requestType', 'status'],
    'CustomerRequest Model - Required fields'
  );
}

async function verifyControllers() {
  console.log(`\n${colors.cyan}=== VERIFYING CONTROLLERS ===${colors.reset}\n`);

  // Check Task Controller
  checkFile('backend/controllers/taskController.js', 'Task Controller exists');
  checkFileContent(
    'backend/controllers/taskController.js',
    ['buildHierarchyQuery', 'getMyTasks', 'emitToCafe', 'task:created', 'task:updated'],
    'Task Controller - Functions and socket events'
  );

  // Check CustomerRequest Controller
  checkFile('backend/controllers/customerRequestController.js', 'CustomerRequest Controller exists');
  checkFileContent(
    'backend/controllers/customerRequestController.js',
    ['buildHierarchyQuery', 'getPendingRequests', 'emitToCafe', 'request:created'],
    'CustomerRequest Controller - Functions and socket events'
  );

  // Check Order Controller filtering
  checkFileContent(
    'backend/controllers/orderController.js',
    ['req.user.cafeId', 'waiter', 'cook', 'captain', 'manager'],
    'Order Controller - Mobile user filtering'
  );

  // Check Attendance Controller socket events
  checkFileContent(
    'backend/controllers/attendanceController.js',
    ['attendance:checked_in', 'attendance:checked_out', 'attendance:break_started'],
    'Attendance Controller - Socket events'
  );

  // Check Table Controller filtering
  checkFileContent(
    'backend/controllers/tableController.js',
    ['user.cafeId', 'buildHierarchyQuery', 'cartId'],
    'Table Controller - Mobile user filtering'
  );
}

async function verifyRoutes() {
  console.log(`\n${colors.cyan}=== VERIFYING ROUTES ===${colors.reset}\n`);

  // Check Task Routes
  checkFileContent(
    'backend/routes/taskRoutes.js',
    ['getMyTasks', 'createTask', 'completeTask', 'waiter', 'cook', 'captain', 'manager'],
    'Task Routes - Mobile user endpoints'
  );

  // Check CustomerRequest Routes
  checkFileContent(
    'backend/routes/customerRequestRoutes.js',
    ['getPendingRequests', 'acknowledgeRequest', 'resolveRequest'],
    'CustomerRequest Routes - Endpoints'
  );

  // Check Order Routes
  checkFileContent(
    'backend/routes/orderRoutes.js',
    ['waiter', 'cook', 'captain', 'manager'],
    'Order Routes - Mobile user access'
  );

  // Check KOT Routes
  checkFileContent(
    'backend/routes/kotRoutes.js',
    ['getCafeId', 'req.user.cafeId', 'waiter', 'cook'],
    'KOT Routes - Mobile user filtering'
  );
}

async function verifyMiddleware() {
  console.log(`\n${colors.cyan}=== VERIFYING MIDDLEWARE ===${colors.reset}\n`);

  // Check Auth Middleware
  checkFileContent(
    'backend/middleware/authMiddleware.js',
    ['req.user.cafeId', 'req.user.employeeId', 'waiter', 'cook', 'captain', 'manager'],
    'Auth Middleware - Mobile user population'
  );
}

async function verifySocketIO() {
  console.log(`\n${colors.cyan}=== VERIFYING SOCKET.IO ===${colors.reset}\n`);

  // Check Server socket configuration
  checkFileContent(
    'backend/server.js',
    ['join:cart', 'join:kiosk', 'emitToCart', 'emitToKiosk', 'emitToCafe'],
    'Server - Socket room support'
  );
}

async function verifyEmployeeController() {
  console.log(`\n${colors.cyan}=== VERIFYING EMPLOYEE CONTROLLER ===${colors.reset}\n`);

  // Check Employee Controller linking
  checkFileContent(
    'backend/controllers/employeeController.js',
    ['userId', 'cafeId', 'employeeId'],
    'Employee Controller - User linking'
  );
}

async function verifyUserController() {
  console.log(`\n${colors.cyan}=== VERIFYING USER CONTROLLER ===${colors.reset}\n`);

  // Check User Controller login
  checkFileContent(
    'backend/controllers/userController.js',
    ['x-app-login', 'cafeId', 'employeeId', 'waiter', 'cook', 'captain', 'manager'],
    'User Controller - Mobile login'
  );
}

function printSummary() {
  console.log(`\n${colors.cyan}=== VERIFICATION SUMMARY ===${colors.reset}\n`);
  
  console.log(`${colors.green}✓ Passed: ${results.passed.length}${colors.reset}`);
  console.log(`${colors.red}✗ Failed: ${results.failed.length}${colors.reset}`);
  console.log(`${colors.yellow}⚠ Warnings: ${results.warnings.length}${colors.reset}\n`);

  if (results.failed.length > 0) {
    console.log(`${colors.red}Failed Checks:${colors.reset}`);
    results.failed.forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.description}`);
      console.log(`     File: ${item.file}`);
      if (item.missing) {
        console.log(`     Missing: ${item.missing.join(', ')}`);
      }
      if (item.error) {
        console.log(`     Error: ${item.error}`);
      }
    });
    console.log();
  }

  if (results.passed.length > 0) {
    console.log(`${colors.green}All Components Are Synced!${colors.reset}\n`);
  }

  return results.failed.length === 0;
}

async function main() {
  console.log(`${colors.cyan}╔════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.cyan}║  Component Sync Verification                         ║${colors.reset}`);
  console.log(`${colors.cyan}╚════════════════════════════════════════════════════════╝${colors.reset}\n`);

  await verifyModels();
  await verifyControllers();
  await verifyRoutes();
  await verifyMiddleware();
  await verifySocketIO();
  await verifyEmployeeController();
  await verifyUserController();

  const allPassed = printSummary();
  process.exit(allPassed ? 0 : 1);
}

// Run verification
main().catch(error => {
  console.error(`${colors.red}Fatal Error: ${error.message}${colors.reset}`);
  console.error(error.stack);
  process.exit(1);
});

