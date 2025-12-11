/**
 * Unit tests for Costing Controller
 * Run with: npm test -- costingController.test.js
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Investment = require('../../models/investmentModel');
const Expense = require('../../models/expenseModel');
const ExpenseCategory = require('../../models/expenseCategoryModel');
const Ingredient = require('../../models/ingredientModel');
const Recipe = require('../../models/recipeModel');
const RecipeIngredient = require('../../models/recipeIngredientModel');
const InventoryTransaction = require('../../models/inventoryTransactionModel');
const User = require('../../models/userModel');

// Mock auth middleware
const mockUser = {
  _id: new mongoose.Types.ObjectId(),
  role: 'super_admin',
};

const mockReq = {
  user: mockUser,
  body: {},
  query: {},
  params: {},
  file: null,
};

const mockRes = {
  json: jest.fn(),
  status: jest.fn().mockReturnThis(),
};

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  // Clear all collections
  await Investment.deleteMany({});
  await Expense.deleteMany({});
  await ExpenseCategory.deleteMany({});
  await Ingredient.deleteMany({});
  await Recipe.deleteMany({});
  await RecipeIngredient.deleteMany({});
  await InventoryTransaction.deleteMany({});
  await User.deleteMany({});

  // Create test user
  const testUser = new User({
    _id: mockUser._id,
    name: 'Test Super Admin',
    email: 'test@example.com',
    password: 'hashedpassword',
    role: 'super_admin',
  });
  await testUser.save();
});

describe('Costing Controller - Investments', () => {
  test('should create an investment', async () => {
    const { createInvestment } = require('../../controllers/costingController');
    
    mockReq.body = {
      title: 'Test Investment',
      amount: 10000,
      category: 'Equipment',
      purchaseDate: new Date().toISOString(),
      vendor: 'Test Vendor',
    };

    await createInvestment(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          title: 'Test Investment',
          amount: 10000,
        }),
      })
    );
  });

  test('should get all investments', async () => {
    // Create test investment
    const investment = new Investment({
      title: 'Test Investment',
      amount: 10000,
      category: 'Equipment',
      purchaseDate: new Date(),
      createdBy: mockUser._id,
    });
    await investment.save();

    const { getInvestments } = require('../../controllers/costingController');
    mockReq.query = {};

    await getInvestments(mockReq, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.arrayContaining([
          expect.objectContaining({
            title: 'Test Investment',
          }),
        ]),
      })
    );
  });

  test('should delete an investment', async () => {
    const investment = new Investment({
      title: 'Test Investment',
      amount: 10000,
      category: 'Equipment',
      purchaseDate: new Date(),
      createdBy: mockUser._id,
    });
    await investment.save();

    const { deleteInvestment } = require('../../controllers/costingController');
    mockReq.params.id = investment._id.toString();

    await deleteInvestment(mockReq, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        message: 'Investment deleted successfully',
      })
    );
  });
});

describe('Costing Controller - Expenses', () => {
  test('should create an expense', async () => {
    // Create expense category first
    const category = new ExpenseCategory({
      name: 'Test Category',
      createdBy: mockUser._id,
    });
    await category.save();

    const { createExpense } = require('../../controllers/costingController');
    
    mockReq.body = {
      expenseCategoryId: category._id.toString(),
      amount: 500,
      expenseDate: new Date().toISOString(),
      paymentMode: 'Cash',
      description: 'Test expense',
    };

    await createExpense(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          amount: 500,
        }),
      })
    );
  });

  test('should bulk import expenses', async () => {
    const category = new ExpenseCategory({
      name: 'Test Category',
      createdBy: mockUser._id,
    });
    await category.save();

    const { bulkImportExpenses } = require('../../controllers/costingController');
    
    mockReq.body = {
      expenses: [
        {
          expenseCategoryId: category._id.toString(),
          amount: 100,
          expenseDate: new Date().toISOString(),
          paymentMode: 'Cash',
        },
        {
          expenseCategoryId: category._id.toString(),
          amount: 200,
          expenseDate: new Date().toISOString(),
          paymentMode: 'UPI',
        },
      ],
    };

    await bulkImportExpenses(mockReq, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          total: 2,
          successful: 2,
        }),
      })
    );
  });
});

describe('Costing Controller - Recipes', () => {
  test('should calculate plate cost correctly', async () => {
    // Create ingredients
    const ingredient1 = new Ingredient({
      name: 'Flour',
      unit: 'kg',
      costPerUnit: 50,
      lastUpdatedBy: mockUser._id,
    });
    await ingredient1.save();

    const ingredient2 = new Ingredient({
      name: 'Sugar',
      unit: 'kg',
      costPerUnit: 40,
      lastUpdatedBy: mockUser._id,
    });
    await ingredient2.save();

    const { createRecipe } = require('../../controllers/costingController');
    
    mockReq.body = {
      name: 'Test Recipe',
      sku: 'TEST-001',
      sellingPrice: 100,
      overheadPerPlate: 5,
      ingredients: [
        {
          ingredientId: ingredient1._id.toString(),
          quantity: 0.5,
          unit: 'kg',
        },
        {
          ingredientId: ingredient2._id.toString(),
          quantity: 0.2,
          unit: 'kg',
        },
      ],
    };

    await createRecipe(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(201);
    const responseData = mockRes.json.mock.calls[0][0];
    expect(responseData.data.plateCost).toBeGreaterThan(0);
    // Plate cost should be: (0.5 * 50) + (0.2 * 40) + 5 = 25 + 8 + 5 = 38
    expect(responseData.data.plateCost).toBeCloseTo(38, 1);
  });
});

describe('Costing Controller - Dashboard', () => {
  test('should calculate dashboard KPIs', async () => {
    // Create test data
    const investment = new Investment({
      title: 'Test Investment',
      amount: 10000,
      category: 'Equipment',
      purchaseDate: new Date(),
      createdBy: mockUser._id,
    });
    await investment.save();

    const category = new ExpenseCategory({
      name: 'Test Category',
      createdBy: mockUser._id,
    });
    await category.save();

    const expense = new Expense({
      expenseCategoryId: category._id,
      amount: 500,
      expenseDate: new Date(),
      createdBy: mockUser._id,
    });
    await expense.save();

    const { getDashboard } = require('../../controllers/costingController');
    mockReq.query = {
      startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      endDate: new Date().toISOString(),
    };

    await getDashboard(mockReq, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          totalInvestment: expect.any(Number),
          monthlyExpenses: expect.any(Number),
        }),
      })
    );
  });
});

// Note: These are basic unit tests. For production, add more comprehensive tests including:
// - Error handling scenarios
// - Validation tests
// - Permission checks
// - File upload tests
// - Edge cases

















