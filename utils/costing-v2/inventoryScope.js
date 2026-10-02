const mongoose = require("mongoose");
const User = require("../../models/userModel");
const Employee = require("../../models/employeeModel");

const id = (value) => value?._id?.toString?.() || value?.toString?.() || "";

class InventoryScopeError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "InventoryScopeError";
    this.code = code;
    this.statusCode = code === "INVENTORY_SCOPE_UNRESOLVED" ? 400 : 403;
    this.details = details;
  }
}

const logInventoryScope = (code, details = {}) => {
  const safeKeys = [
    "userId", "role", "cartId", "franchiseId", "orderId", "operation",
    "ingredientId", "ingredientFranchiseId",
  ];
  const safe = Object.fromEntries(
    safeKeys.filter((key) => details[key] != null).map((key) => [key, id(details[key])])
  );
  console.warn(`[${code}] ${JSON.stringify(safe)}`);
};

const fail = (code, details) => {
  logInventoryScope(code, details);
  throw new InventoryScopeError(code, details);
};

const resolveCartScope = async (cartId, details = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id(cartId))) {
    fail("INVENTORY_SCOPE_UNRESOLVED", { ...details, cartId });
  }
  const cart = await User.findById(cartId).select("_id role franchiseId").lean();
  if (cart?.role !== "admin" || !cart.franchiseId) {
    fail("INVENTORY_SCOPE_UNRESOLVED", { ...details, cartId });
  }
  const franchise = await User.findById(cart.franchiseId).select("_id role").lean();
  if (franchise?.role !== "franchise_admin") {
    fail("INVENTORY_SCOPE_UNRESOLVED", {
      ...details, cartId, franchiseId: cart.franchiseId,
    });
  }
  return { cartId: cart._id, franchiseId: cart.franchiseId };
};

const resolveStaffCartId = async (user) => {
  let employee = null;
  if (user?.employeeId) {
    employee = await Employee.findById(user.employeeId).select("cartId cafeId").lean();
  }
  if (!employee && user?._id) {
    employee = await Employee.findOne({ userId: user._id })
      .select("cartId cafeId").lean();
  }
  return employee?.cartId || employee?.cafeId || user?.cartId || user?.cafeId || null;
};

const resolveOperationalScope = async (user, { cartId = null, operation = "read", requireCart = true } = {}) => {
  const details = { userId: user?._id, role: user?.role, cartId, operation };
  if (!user?._id) fail("INVENTORY_SCOPE_UNRESOLVED", details);

  let effectiveCartId = cartId;
  if (user.role === "admin") {
    if (cartId && id(cartId) !== id(user._id)) fail("INVENTORY_SCOPE_MISMATCH", details);
    effectiveCartId = user._id;
  } else if (["manager", "cook", "waiter", "captain", "employee"].includes(user.role)) {
    effectiveCartId = await resolveStaffCartId(user);
    if (cartId && id(cartId) !== id(effectiveCartId)) fail("INVENTORY_SCOPE_MISMATCH", details);
  } else if (!["franchise_admin", "super_admin"].includes(user.role)) {
    fail("INVENTORY_SCOPE_UNRESOLVED", details);
  }

  if (!effectiveCartId) {
    if (requireCart) fail("INVENTORY_SCOPE_UNRESOLVED", details);
    return {
      cartId: null,
      franchiseId: user.role === "franchise_admin" ? user._id : null,
      role: user.role,
      userId: user._id,
    };
  }

  const scope = await resolveCartScope(effectiveCartId, details);
  if (user.role === "franchise_admin" && id(scope.franchiseId) !== id(user._id)) {
    fail("INVENTORY_SCOPE_MISMATCH", { ...details, franchiseId: scope.franchiseId });
  }
  return { ...scope, role: user.role, userId: user._id };
};

const isGlobalTemplate = (ingredient) => !!ingredient && !ingredient.cartId && !ingredient.franchiseId;

const isIngredientAccessible = ({ ingredient, scope, mutation = false }) => {
  if (!ingredient || !scope) return false;
  if (isGlobalTemplate(ingredient)) return !mutation && scope.allowTemplates === true;
  if (!scope.franchiseId || id(ingredient.franchiseId) !== id(scope.franchiseId)) return false;
  if (ingredient.cartId) {
    if (!scope.cartId && scope.role === "franchise_admin") return true;
    return id(ingredient.cartId) === id(scope.cartId);
  }
  return true;
};

const assertIngredientReadable = (ingredient, scope, operation = "read") => {
  if (!isIngredientAccessible({ ingredient, scope })) {
    fail("INVENTORY_SCOPE_MISMATCH", {
      userId: scope?.userId, role: scope?.role, cartId: scope?.cartId,
      franchiseId: scope?.franchiseId, ingredientId: ingredient?._id,
      ingredientFranchiseId: ingredient?.franchiseId, operation,
    });
  }
};

const assertIngredientMutable = (ingredient, scope, operation = "mutate") => {
  const details = {
    userId: scope?.userId, role: scope?.role, cartId: scope?.cartId,
    franchiseId: scope?.franchiseId, ingredientId: ingredient?._id,
    ingredientFranchiseId: ingredient?.franchiseId, operation,
  };
  if (!ingredient) fail("INVENTORY_SCOPE_UNRESOLVED", details);
  if (isGlobalTemplate(ingredient)) fail("GLOBAL_INVENTORY_TEMPLATE_MUTATION_BLOCKED", details);
  if (!isIngredientAccessible({ ingredient, scope, mutation: true })) {
    fail("INVENTORY_SCOPE_MISMATCH", details);
  }
};

const assertLegacyItemScope = (item, scope, operation = "legacy-inventory") => {
  const itemCartId = item?.cartId || item?.cafeId;
  if (!itemCartId || !scope?.cartId || id(itemCartId) !== id(scope.cartId) ||
      (item.franchiseId && id(item.franchiseId) !== id(scope.franchiseId))) {
    fail("INVENTORY_SCOPE_MISMATCH", {
      userId: scope?.userId, role: scope?.role, cartId: scope?.cartId,
      franchiseId: scope?.franchiseId, operation,
    });
  }
};

const buildIngredientScopeQuery = (scope, { includeTemplates = false } = {}) => {
  if (!scope?.franchiseId && scope?.role !== "super_admin") return { _id: { $exists: false } };
  if (!scope?.cartId) {
    if (scope.role === "super_admin") {
      return includeTemplates ? {} : { franchiseId: { $ne: null } };
    }
    const clauses = [{ franchiseId: scope.franchiseId }];
    if (includeTemplates) clauses.push({ cartId: null, franchiseId: null });
    return { $or: clauses };
  }
  const clauses = [
    { cartId: scope.cartId, franchiseId: scope.franchiseId },
    { cartId: null, franchiseId: scope.franchiseId },
  ];
  if (includeTemplates) clauses.push({ cartId: null, franchiseId: null });
  return { $or: clauses };
};

module.exports = {
  InventoryScopeError, id, logInventoryScope, resolveCartScope,
  resolveOperationalScope, isGlobalTemplate, isIngredientAccessible,
  assertIngredientReadable, assertIngredientMutable, buildIngredientScopeQuery,
  assertLegacyItemScope,
};
