const Preparation = require("../../models/costing-v2/preparationModel");
const Ingredient = require("../../models/costing-v2/ingredientModel");
const InventoryTransaction = require("../../models/costing-v2/inventoryTransactionModel");
const WeightedAverageService = require("../../services/costing-v2/weightedAverageService");
const { validateOutletAccess, setOutletContext } = require("../../utils/costing-v2/accessControl");

/**
 * @route   GET /api/costing-v2/preparations
 * @desc    Get all preparations
 */
exports.getPreparations = async (req, res) => {
  try {
    const { status, cartId } = req.query;
    const filter = {};

    if (status) filter.status = status;

    // Apply role-based filtering
    if (req.user.role === "admin") {
      // Cart admin - only their own preparations
      filter.cartId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      if (cartId) {
        // Validate outlet belongs to franchise
        if (!(await validateOutletAccess(req.user, cartId))) {
          return res.status(403).json({
            success: false,
            message: "Access denied to this outlet",
          });
        }
        filter.cartId = cartId;
      } else {
        // Get all outlets in franchise
        const User = require("../../models/userModel");
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        filter.cartId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      if (cartId) {
        filter.cartId = cartId;
      }
    }

    const preparations = await Preparation.find(filter)
      .populate("issuedIngredients.ingredientId", "name uom category")
      .populate("returnedIngredients.ingredientId", "name uom category")
      .populate("createdBy", "name email")
      .sort({ startedAt: -1 });

    res.json({ success: true, data: preparations });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/preparations
 * @desc    Create a new preparation
 */
exports.createPreparation = async (req, res) => {
  try {
    const { name, description, notes } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Preparation name is required",
      });
    }

    const data = await setOutletContext(req.user, {
      name,
      description: description || "",
      notes: notes || "",
      status: "active",
      issuedIngredients: [],
      returnedIngredients: [],
    });

    const preparation = new Preparation(data);
    await preparation.save();

    await preparation.populate("createdBy", "name email");

    res.status(201).json({ success: true, data: preparation });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/preparations/:id/issue
 * @desc    Issue ingredients for preparation (consume from inventory)
 */
exports.issueIngredient = async (req, res) => {
  try {
    const { ingredientId, qty, uom, notes } = req.body;
    const preparationId = req.params.id;

    if (!ingredientId || !qty || !uom) {
      return res.status(400).json({
        success: false,
        message: "ingredientId, qty, and uom are required",
      });
    }

    const preparation = await Preparation.findById(preparationId);
    if (!preparation) {
      return res.status(404).json({
        success: false,
        message: "Preparation not found",
      });
    }

    // Validate access
    if (req.user.role === "admin" && preparation.cartId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Access denied to this preparation",
      });
    }

    if (preparation.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Can only issue ingredients to active preparations",
      });
    }

    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      return res.status(404).json({
        success: false,
        message: "Ingredient not found",
      });
    }

    // Convert to base unit
    let qtyInBaseUnit;
    try {
      qtyInBaseUnit = ingredient.convertToBaseUnit(qty, uom);
    } catch (conversionError) {
      return res.status(400).json({
        success: false,
        message: `Unit conversion error: ${conversionError.message}`,
      });
    }

    if (qtyInBaseUnit <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be greater than 0",
      });
    }

    // Consume from inventory using weighted average
    const consumeResult = await WeightedAverageService.consume(
      ingredientId,
      qtyInBaseUnit,
      "preparation",
      preparationId,
      req.user._id,
      preparation.cartId
    );

    // Create inventory transaction
    const transaction = new InventoryTransaction({
      ingredientId: ingredientId,
      type: "OUT",
      qty: qty,
      uom: uom,
      qtyInBaseUnit: qtyInBaseUnit,
      refType: "preparation",
      refId: preparationId,
      date: new Date(),
      costAllocated: consumeResult.costAllocated,
      notes: notes || `Issued for preparation: ${preparation.name}`,
      recordedBy: req.user._id,
      cartId: preparation.cartId,
    });
    await transaction.save();

    // Add to preparation's issued ingredients
    preparation.issuedIngredients.push({
      ingredientId: ingredientId,
      qty: qty,
      uom: uom,
      qtyInBaseUnit: qtyInBaseUnit,
      transactionId: transaction._id,
      costAllocated: consumeResult.costAllocated,
    });

    await preparation.save();

    res.json({
      success: true,
      data: {
        preparation,
        transaction: transaction,
        costAllocated: consumeResult.costAllocated,
      },
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/preparations/:id/return
 * @desc    Return unused ingredient from preparation back to inventory
 */
exports.returnIngredient = async (req, res) => {
  try {
    const { ingredientId, qty, uom, notes } = req.body;
    const preparationId = req.params.id;

    if (!ingredientId || !qty || !uom) {
      return res.status(400).json({
        success: false,
        message: "ingredientId, qty, and uom are required",
      });
    }

    const preparation = await Preparation.findById(preparationId);
    if (!preparation) {
      return res.status(404).json({
        success: false,
        message: "Preparation not found",
      });
    }

    // Validate access
    if (req.user.role === "admin" && preparation.cartId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Access denied to this preparation",
      });
    }

    if (preparation.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Can only return ingredients from active preparations",
      });
    }

    // Find the issued ingredient
    const issuedIngredient = preparation.issuedIngredients.find(
      (ing) => ing.ingredientId.toString() === ingredientId.toString()
    );

    if (!issuedIngredient) {
      return res.status(400).json({
        success: false,
        message: "This ingredient was not issued for this preparation",
      });
    }

    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      return res.status(404).json({
        success: false,
        message: "Ingredient not found",
      });
    }

    // Convert to base unit
    let qtyInBaseUnit;
    try {
      qtyInBaseUnit = ingredient.convertToBaseUnit(qty, uom);
    } catch (conversionError) {
      return res.status(400).json({
        success: false,
        message: `Unit conversion error: ${conversionError.message}`,
      });
    }

    if (qtyInBaseUnit <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be greater than 0",
      });
    }

    // Validate return quantity doesn't exceed issued quantity
    const totalReturned = preparation.returnedIngredients
      .filter((ing) => ing.ingredientId.toString() === ingredientId.toString())
      .reduce((sum, ing) => sum + ing.qtyInBaseUnit, 0);

    if (totalReturned + qtyInBaseUnit > issuedIngredient.qtyInBaseUnit) {
      return res.status(400).json({
        success: false,
        message: `Return quantity exceeds issued quantity. Issued: ${issuedIngredient.qty} ${issuedIngredient.uom}, Already returned: ${totalReturned} ${ingredient.baseUnit}, Trying to return: ${qty} ${uom}`,
      });
    }

    // Return to inventory using weighted average
    const returnResult = await WeightedAverageService.returnToInventory(
      ingredientId,
      qtyInBaseUnit,
      "preparation",
      preparationId,
      req.user._id,
      preparation.cartId
    );

    // Create inventory transaction
    const returnTransaction = new InventoryTransaction({
      ingredientId: ingredientId,
      type: "RETURN",
      qty: qty,
      uom: uom,
      qtyInBaseUnit: qtyInBaseUnit,
      originalTransactionId: issuedIngredient.transactionId,
      refType: "preparation",
      refId: preparationId,
      date: new Date(),
      costAllocated: returnResult.costAllocated,
      notes: notes || `Returned unused from preparation: ${preparation.name}`,
      recordedBy: req.user._id,
      cartId: preparation.cartId,
    });
    await returnTransaction.save();

    // Add to preparation's returned ingredients
    preparation.returnedIngredients.push({
      ingredientId: ingredientId,
      qty: qty,
      uom: uom,
      qtyInBaseUnit: qtyInBaseUnit,
      transactionId: returnTransaction._id,
      originalTransactionId: issuedIngredient.transactionId,
      costAllocated: returnResult.costAllocated,
      notes: notes || "",
    });

    await preparation.save();

    res.json({
      success: true,
      data: {
        preparation,
        transaction: returnTransaction,
        costAllocated: returnResult.costAllocated,
      },
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/costing-v2/preparations/:id
 * @desc    Update preparation (complete, cancel, etc.)
 */
exports.updatePreparation = async (req, res) => {
  try {
    const { status, notes } = req.body;
    const preparation = await Preparation.findById(req.params.id);

    if (!preparation) {
      return res.status(404).json({
        success: false,
        message: "Preparation not found",
      });
    }

    // Validate access
    if (req.user.role === "admin" && preparation.cartId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Access denied to this preparation",
      });
    }

    if (status) {
      if (status === "completed" && preparation.status === "active") {
        preparation.completedAt = new Date();
      }
      preparation.status = status;
    }

    if (notes !== undefined) {
      preparation.notes = notes;
    }

    await preparation.save();
    await preparation.populate("issuedIngredients.ingredientId", "name uom category");
    await preparation.populate("returnedIngredients.ingredientId", "name uom category");

    res.json({ success: true, data: preparation });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/costing-v2/preparations/:id
 * @desc    Delete preparation (only if cancelled or no ingredients issued)
 */
exports.deletePreparation = async (req, res) => {
  try {
    const preparation = await Preparation.findById(req.params.id);

    if (!preparation) {
      return res.status(404).json({
        success: false,
        message: "Preparation not found",
      });
    }

    // Validate access
    if (req.user.role === "admin" && preparation.cartId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Access denied to this preparation",
      });
    }

    // Can only delete if cancelled or no ingredients issued
    if (preparation.status === "active" && preparation.issuedIngredients.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete active preparation with issued ingredients. Please cancel it first.",
      });
    }

    await Preparation.findByIdAndDelete(req.params.id);

    res.json({ success: true, message: "Preparation deleted" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};



