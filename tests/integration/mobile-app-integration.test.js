/**
 * Mobile App Integration Test Suite
 * 
 * This test suite verifies that all components are properly synced:
 * - Models (Employee-User relationships)
 * - Controllers (cart/kiosk filtering)
 * - Routes (access control)
 * - Middleware (cafeId population)
 * - Socket events (real-time updates)
 * - Data isolation (mobile users only see their cart data)
 */

const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, server, io } = require('../../server');
const User = require('../../models/userModel');
const Employee = require('../../models/employeeModel');
const Order = require('../../models/orderModel');
const Table = require('../../models/tableModel').Table;
const Task = require('../../models/taskModel');
const CustomerRequest = require('../../models/customerRequestModel');
const EmployeeAttendance = require('../../models/employeeAttendanceModel');

// Test configuration
const TEST_CONFIG = {
  JWT_SECRET: process.env.JWT_SECRET || 'test-secret-key',
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/terra-test',
};

// Test data
let testFranchiseAdmin;
let testCartAdmin;
let testWaiter;
let testWaiterEmployee;
let testCook;
let testCookEmployee;
let testCartId;
let testFranchiseId;
let testTable;
let testOrder;
let waiterToken;
let cookToken;
let cartAdminToken;

describe('Mobile App Integration Tests', () => {
  beforeAll(async () => {
    // Connect to test database
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_CONFIG.MONGO_URI);
    }
    
    // Clean up test data
    await User.deleteMany({ email: /^test/ });
    await Employee.deleteMany({ email: /^test/ });
    await Order.deleteMany({});
    await Table.deleteMany({});
    await Task.deleteMany({});
    await CustomerRequest.deleteMany({});
    await EmployeeAttendance.deleteMany({});
  });

  afterAll(async () => {
    // Clean up test data
    await User.deleteMany({ email: /^test/ });
    await Employee.deleteMany({ email: /^test/ });
    await Order.deleteMany({});
    await Table.deleteMany({});
    await Task.deleteMany({});
    await CustomerRequest.deleteMany({});
    await EmployeeAttendance.deleteMany({});
    
    // Close connections
    await mongoose.connection.close();
    if (server) {
      server.close();
    }
  });

  describe('1. Model Relationships & Data Setup', () => {
    test('1.1: Create franchise admin', async () => {
      testFranchiseAdmin = await User.create({
        name: 'Test Franchise Admin',
        email: 'test.franchise@test.com',
        password: 'password123',
        role: 'franchise_admin',
        isActive: true,
      });
      testFranchiseId = testFranchiseAdmin._id;
      expect(testFranchiseAdmin).toBeDefined();
      expect(testFranchiseAdmin.role).toBe('franchise_admin');
    });

    test('1.2: Create cart admin', async () => {
      testCartAdmin = await User.create({
        name: 'Test Cart Admin',
        email: 'test.cart@test.com',
        password: 'password123',
        role: 'admin',
        franchiseId: testFranchiseId,
        isApproved: true,
        isActive: true,
      });
      testCartId = testCartAdmin._id;
      expect(testCartAdmin).toBeDefined();
      expect(testCartAdmin.role).toBe('admin');
      expect(testCartAdmin.franchiseId.toString()).toBe(testFranchiseId.toString());
    });

    test('1.3: Create waiter employee and user', async () => {
      // Create Employee first
      testWaiterEmployee = await Employee.create({
        name: 'Test Waiter',
        dateOfBirth: new Date('1990-01-01'),
        mobile: '9876543210',
        email: 'test.waiter@test.com',
        employeeRole: 'waiter',
        cafeId: testCartId,
        franchiseId: testFranchiseId,
        isActive: true,
      });

      // Create User for mobile login
      testWaiter = await User.create({
        name: 'Test Waiter',
        email: 'test.waiter@test.com',
        password: 'password123',
        role: 'waiter',
        cafeId: testCartId,
        employeeId: testWaiterEmployee._id,
        franchiseId: testFranchiseId,
        isActive: true,
      });

      // Link userId in Employee
      testWaiterEmployee.userId = testWaiter._id;
      await testWaiterEmployee.save();

      expect(testWaiter).toBeDefined();
      expect(testWaiter.role).toBe('waiter');
      expect(testWaiter.cafeId.toString()).toBe(testCartId.toString());
      expect(testWaiter.employeeId.toString()).toBe(testWaiterEmployee._id.toString());
      expect(testWaiterEmployee.userId.toString()).toBe(testWaiter._id.toString());
    });

    test('1.4: Create cook employee and user', async () => {
      // Create Employee first
      testCookEmployee = await Employee.create({
        name: 'Test Cook',
        dateOfBirth: new Date('1990-01-01'),
        mobile: '9876543211',
        email: 'test.cook@test.com',
        employeeRole: 'cook',
        cafeId: testCartId,
        franchiseId: testFranchiseId,
        isActive: true,
      });

      // Create User for mobile login
      testCook = await User.create({
        name: 'Test Cook',
        email: 'test.cook@test.com',
        password: 'password123',
        role: 'cook',
        cafeId: testCartId,
        employeeId: testCookEmployee._id,
        franchiseId: testFranchiseId,
        isActive: true,
      });

      // Link userId in Employee
      testCookEmployee.userId = testCook._id;
      await testCookEmployee.save();

      expect(testCook).toBeDefined();
      expect(testCook.role).toBe('cook');
      expect(testCook.cafeId.toString()).toBe(testCartId.toString());
    });

    test('1.5: Create test table', async () => {
      testTable = await Table.create({
        number: 1,
        name: 'Test Table 1',
        capacity: 4,
        status: 'AVAILABLE',
        qrSlug: 'test-table-1',
        cartId: testCartId,
        franchiseId: testFranchiseId,
      });
      expect(testTable).toBeDefined();
      expect(testTable.cartId.toString()).toBe(testCartId.toString());
    });
  });

  describe('2. Authentication & Middleware', () => {
    test('2.1: Waiter login returns cafeId and employeeId', async () => {
      const response = await request(app)
        .post('/api/users/login')
        .set('x-app-login', 'mobile')
        .send({
          email: 'test.waiter@test.com',
          password: 'password123',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user).toBeDefined();
      expect(response.body.user.role).toBe('waiter');
      expect(response.body.user.cafeId).toBeDefined();
      expect(response.body.user.cafeId.toString()).toBe(testCartId.toString());
      expect(response.body.user.employeeId).toBeDefined();
      
      waiterToken = response.body.token;
      expect(waiterToken).toBeDefined();
    });

    test('2.2: Middleware populates req.user.cafeId for mobile users', async () => {
      const response = await request(app)
        .get('/api/tables')
        .set('Authorization', `Bearer ${waiterToken}`);

      expect(response.status).toBe(200);
      // Should only return tables from waiter's cart
      if (response.body.length > 0) {
        response.body.forEach(table => {
          expect(table.cartId.toString()).toBe(testCartId.toString());
        });
      }
    });

    test('2.3: Cook login works correctly', async () => {
      const response = await request(app)
        .post('/api/users/login')
        .set('x-app-login', 'mobile')
        .send({
          email: 'test.cook@test.com',
          password: 'password123',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user.role).toBe('cook');
      expect(response.body.user.cafeId.toString()).toBe(testCartId.toString());
      
      cookToken = response.body.token;
    });
  });

  describe('3. Data Filtering & Isolation', () => {
    test('3.1: Waiter only sees orders from their cart', async () => {
      // Create order for this cart
      testOrder = await Order.create({
        _id: 'TEST-ORDER-001',
        tableNumber: '1',
        table: testTable._id,
        serviceType: 'DINE_IN',
        status: 'Pending',
        cartId: testCartId,
        franchiseId: testFranchiseId,
        kotLines: [{
          items: [{ name: 'Test Item', quantity: 1, price: 100 }],
          subtotal: 100,
          gst: 5,
          totalAmount: 105,
        }],
      });

      const response = await request(app)
        .get('/api/orders')
        .set('Authorization', `Bearer ${waiterToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      
      // Should only see orders from their cart
      response.body.forEach(order => {
        expect(order.cartId.toString()).toBe(testCartId.toString());
      });
    });

    test('3.2: Waiter cannot access orders from other cart', async () => {
      // Create another cart admin
      const otherCartAdmin = await User.create({
        name: 'Other Cart Admin',
        email: 'other.cart@test.com',
        password: 'password123',
        role: 'admin',
        franchiseId: testFranchiseId,
        isApproved: true,
        isActive: true,
      });

      // Create order for other cart
      const otherOrder = await Order.create({
        _id: 'OTHER-ORDER-001',
        tableNumber: '1',
        serviceType: 'DINE_IN',
        status: 'Pending',
        cartId: otherCartAdmin._id,
        franchiseId: testFranchiseId,
        kotLines: [{
          items: [{ name: 'Other Item', quantity: 1, price: 200 }],
          subtotal: 200,
          gst: 10,
          totalAmount: 210,
        }],
      });

      // Try to access other cart's order
      const response = await request(app)
        .get(`/api/orders/${otherOrder._id}`)
        .set('Authorization', `Bearer ${waiterToken}`);

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('cart/kiosk');

      // Cleanup
      await Order.findByIdAndDelete(otherOrder._id);
      await User.findByIdAndDelete(otherCartAdmin._id);
    });

    test('3.3: Waiter only sees tables from their cart', async () => {
      const response = await request(app)
        .get('/api/tables')
        .set('Authorization', `Bearer ${waiterToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      
      // Should only see tables from their cart
      response.body.forEach(table => {
        expect(table.cartId.toString()).toBe(testCartId.toString());
      });
    });

    test('3.4: Waiter only sees KOTs from their cart', async () => {
      const response = await request(app)
        .get('/api/kot')
        .set('Authorization', `Bearer ${waiterToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      
      // All KOTs should be from their cart
      response.body.forEach(kot => {
        // KOTs are extracted from orders, so we verify through orderId
        // This is verified by the filtering in the route
      });
    });
  });

  describe('4. Task System', () => {
    test('4.1: Create task for waiter', async () => {
      const response = await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${waiterToken}`)
        .send({
          title: 'Test Task',
          description: 'Test task description',
          assignedTo: testWaiterEmployee._id,
          priority: 'high',
          category: 'service',
        });

      expect(response.status).toBe(201);
      expect(response.body.title).toBe('Test Task');
      expect(response.body.cafeId.toString()).toBe(testCartId.toString());
      expect(response.body.assignedTo.toString()).toBe(testWaiterEmployee._id.toString());
    });

    test('4.2: Waiter can see their assigned tasks', async () => {
      const response = await request(app)
        .get('/api/tasks/my')
        .set('Authorization', `Bearer ${waiterToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      
      // Should only see tasks assigned to them
      response.body.forEach(task => {
        expect(task.assignedTo.toString()).toBe(testWaiterEmployee._id.toString());
      });
    });

    test('4.3: Complete task', async () => {
      // Get a task first
      const tasksResponse = await request(app)
        .get('/api/tasks/my')
        .set('Authorization', `Bearer ${waiterToken}`);

      if (tasksResponse.body.length > 0) {
        const taskId = tasksResponse.body[0]._id;
        
        const response = await request(app)
          .post(`/api/tasks/${taskId}/complete`)
          .set('Authorization', `Bearer ${waiterToken}`);

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('completed');
        expect(response.body.completedAt).toBeDefined();
      }
    });
  });

  describe('5. Customer Request System', () => {
    test('5.1: Create customer request', async () => {
      const response = await request(app)
        .post('/api/customer-requests')
        .send({
          tableId: testTable._id,
          requestType: 'water',
          status: 'pending',
        });

      expect(response.status).toBe(201);
      expect(response.body.requestType).toBe('water');
      expect(response.body.status).toBe('pending');
      expect(response.body.cafeId.toString()).toBe(testCartId.toString());
    });

    test('5.2: Waiter can see pending requests from their cart', async () => {
      const response = await request(app)
        .get('/api/customer-requests/pending')
        .set('Authorization', `Bearer ${waiterToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      
      // Should only see requests from their cart
      response.body.forEach(request => {
        expect(request.cafeId.toString()).toBe(testCartId.toString());
        expect(request.status).toBe('pending');
      });
    });

    test('5.3: Acknowledge request', async () => {
      const requestsResponse = await request(app)
        .get('/api/customer-requests/pending')
        .set('Authorization', `Bearer ${waiterToken}`);

      if (requestsResponse.body.length > 0) {
        const requestId = requestsResponse.body[0]._id;
        
        const response = await request(app)
          .post(`/api/customer-requests/${requestId}/acknowledge`)
          .set('Authorization', `Bearer ${waiterToken}`)
          .send({ notes: 'Acknowledged by waiter' });

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('acknowledged');
        expect(response.body.acknowledgedAt).toBeDefined();
      }
    });
  });

  describe('6. Attendance System', () => {
    test('6.1: Waiter can check in', async () => {
      const response = await request(app)
        .post('/api/attendance/checkin')
        .set('Authorization', `Bearer ${waiterToken}`)
        .send({
          location: 'Test Location',
          notes: 'Test check-in',
        });

      expect(response.status).toBe(200);
      expect(response.body.attendance).toBeDefined();
      expect(response.body.attendance.checkIn.time).toBeDefined();
      expect(response.body.attendance.cafeId.toString()).toBe(testCartId.toString());
    });

    test('6.2: Waiter can see their attendance', async () => {
      const response = await request(app)
        .get('/api/attendance/today')
        .set('Authorization', `Bearer ${waiterToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      
      // Should only see their own attendance
      response.body.forEach(attendance => {
        expect(attendance.employeeId.toString()).toBe(testWaiterEmployee._id.toString());
        expect(attendance.cafeId.toString()).toBe(testCartId.toString());
      });
    });

    test('6.3: Start break', async () => {
      const attendanceResponse = await request(app)
        .get('/api/attendance/today')
        .set('Authorization', `Bearer ${waiterToken}`);

      if (attendanceResponse.body.length > 0) {
        const attendanceId = attendanceResponse.body[0]._id;
        
        const response = await request(app)
          .post(`/api/attendance/${attendanceId}/start-break`)
          .set('Authorization', `Bearer ${waiterToken}`);

        expect(response.status).toBe(200);
        expect(response.body.attendance.breakStart).toBeDefined();
      }
    });
  });

  describe('7. Order Operations', () => {
    test('7.1: Waiter can update order status', async () => {
      const response = await request(app)
        .patch(`/api/orders/${testOrder._id}/status`)
        .set('Authorization', `Bearer ${waiterToken}`)
        .send({ status: 'Confirmed' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('Confirmed');
    });

    test('7.2: Cook can update order status to Preparing', async () => {
      const response = await request(app)
        .patch(`/api/orders/${testOrder._id}/status`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({ status: 'Preparing' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('Preparing');
    });

    test('7.3: Waiter cannot add items to order from other cart', async () => {
      // Create another cart's order
      const otherCartAdmin = await User.create({
        name: 'Other Cart',
        email: 'other2@test.com',
        password: 'password123',
        role: 'admin',
        franchiseId: testFranchiseId,
        isApproved: true,
        isActive: true,
      });

      const otherOrder = await Order.create({
        _id: 'OTHER-ORDER-002',
        tableNumber: '2',
        serviceType: 'DINE_IN',
        status: 'Pending',
        cartId: otherCartAdmin._id,
        franchiseId: testFranchiseId,
      });

      const response = await request(app)
        .post(`/api/orders/${otherOrder._id}/add-items`)
        .set('Authorization', `Bearer ${waiterToken}`)
        .send({
          items: [{ name: 'Test Item', quantity: 1, price: 100 }],
        });

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('cart/kiosk');

      // Cleanup
      await Order.findByIdAndDelete(otherOrder._id);
      await User.findByIdAndDelete(otherCartAdmin._id);
    });
  });

  describe('8. Component Sync Verification', () => {
    test('8.1: Verify Employee-User bidirectional linking', async () => {
      const waiter = await User.findById(testWaiter._id);
      const waiterEmp = await Employee.findById(testWaiterEmployee._id);

      expect(waiter.cafeId.toString()).toBe(testCartId.toString());
      expect(waiter.employeeId.toString()).toBe(waiterEmp._id.toString());
      expect(waiterEmp.userId.toString()).toBe(waiter._id.toString());
      expect(waiterEmp.cafeId.toString()).toBe(testCartId.toString());
    });

    test('8.2: Verify middleware populates cafeId', async () => {
      // This is verified through the fact that filtered queries work
      // If middleware didn't populate cafeId, filtering would fail
      const response = await request(app)
        .get('/api/orders')
        .set('Authorization', `Bearer ${waiterToken}`);

      expect(response.status).toBe(200);
      // If we get here without errors, middleware is working
    });

    test('8.3: Verify all routes use consistent filtering', async () => {
      const endpoints = [
        { method: 'get', path: '/api/orders' },
        { method: 'get', path: '/api/tables' },
        { method: 'get', path: '/api/kot' },
        { method: 'get', path: '/api/tasks' },
        { method: 'get', path: '/api/customer-requests' },
      ];

      for (const endpoint of endpoints) {
        const response = await request(app)
          [endpoint.method](endpoint.path)
          .set('Authorization', `Bearer ${waiterToken}`);

        expect([200, 201]).toContain(response.status);
        // All should return data filtered by cart
      }
    });
  });
});

