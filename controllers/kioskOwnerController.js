const KioskOwner = require("../models/kioskOwnerModel");
const User = require("../models/userModel");

// Helper function to build query based on user role
const buildHierarchyQuery = (user) => {
  const query = {};
  if (user.role === "admin") {
    // Cafe admin - only see kiosk owners from their cafe's franchise
    if (user.franchiseId) {
      query.franchiseId = user.franchiseId;
    } else {
      // No franchise assigned - return empty
      query._id = null; // This will return no results
    }
  } else if (user.role === "franchise_admin") {
    query.franchiseId = user._id;
  }
  return query;
};

// Get all kiosk owners
exports.getAllKioskOwners = async (req, res) => {
  try {
    const query = buildHierarchyQuery(req.user);
    const kioskOwners = await KioskOwner.find(query)
      .populate("franchiseId", "name email")
      .sort({ createdAt: -1 });
    return res.json(kioskOwners);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get single kiosk owner
exports.getKioskOwner = async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id, ...buildHierarchyQuery(req.user) };
    const kioskOwner = await KioskOwner.findOne(query).populate("franchiseId", "name email");
    
    if (!kioskOwner) {
      return res.status(404).json({ message: "Kiosk owner not found" });
    }
    return res.json(kioskOwner);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Create kiosk owner
exports.createKioskOwner = async (req, res) => {
  try {
    const kioskOwnerData = { ...req.body };
    
    // Set hierarchy relationships based on user role
    if (req.user.role === "admin") {
      if (req.user.franchiseId) {
        kioskOwnerData.franchiseId = req.user.franchiseId;
      } else {
        return res.status(400).json({ message: "Cafe admin must be assigned to a franchise" });
      }
    } else if (req.user.role === "franchise_admin") {
      kioskOwnerData.franchiseId = req.user._id;
    }
    
    const kioskOwner = await KioskOwner.create(kioskOwnerData);
    return res.status(201).json(kioskOwner);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Update kiosk owner
exports.updateKioskOwner = async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id, ...buildHierarchyQuery(req.user) };
    
    const kioskOwner = await KioskOwner.findOne(query);
    if (!kioskOwner) {
      return res.status(404).json({ message: "Kiosk owner not found" });
    }
    
    // Prevent changing hierarchy if not super admin
    if (req.user.role !== "super_admin") {
      delete req.body.franchiseId;
    }
    
    Object.assign(kioskOwner, req.body);
    await kioskOwner.save();
    return res.json(kioskOwner);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Delete kiosk owner
exports.deleteKioskOwner = async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id, ...buildHierarchyQuery(req.user) };
    
    const kioskOwner = await KioskOwner.findOneAndDelete(query);
    if (!kioskOwner) {
      return res.status(404).json({ message: "Kiosk owner not found" });
    }
    return res.json({ message: "Kiosk owner deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};













