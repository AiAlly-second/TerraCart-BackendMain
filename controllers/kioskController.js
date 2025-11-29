const Kiosk = require("../models/kioskModel");
const KioskOwner = require("../models/kioskOwnerModel");
const User = require("../models/userModel");

// Helper function to build query based on user role
const buildHierarchyQuery = (user) => {
  const query = {};
  if (user.role === "admin") {
    query.cafeId = user._id;
  } else if (user.role === "franchise_admin") {
    query.franchiseId = user._id;
  }
  return query;
};

// Get all kiosks
exports.getAllKiosks = async (req, res) => {
  try {
    const query = buildHierarchyQuery(req.user);
    const kiosks = await Kiosk.find(query)
      .populate("kioskOwnerId", "companyName ownerName")
      .populate("cafeId", "name cafeName email")
      .populate("franchiseId", "name email")
      .sort({ createdAt: -1 });
    return res.json(kiosks);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get single kiosk
exports.getKiosk = async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id, ...buildHierarchyQuery(req.user) };
    const kiosk = await Kiosk.findOne(query)
      .populate("kioskOwnerId")
      .populate("cafeId", "name cafeName email")
      .populate("franchiseId", "name email");
    
    if (!kiosk) {
      return res.status(404).json({ message: "Kiosk not found" });
    }
    return res.json(kiosk);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Create kiosk
exports.createKiosk = async (req, res) => {
  try {
    const kioskData = { ...req.body };
    
    // Verify kiosk owner belongs to user's hierarchy
    const kioskOwner = await KioskOwner.findById(kioskData.kioskOwnerId);
    if (!kioskOwner) {
      return res.status(404).json({ message: "Kiosk owner not found" });
    }
    
    // Check hierarchy access
    if (req.user.role === "admin") {
      if (kioskOwner.franchiseId?.toString() !== req.user.franchiseId?.toString()) {
        return res.status(403).json({ message: "Access denied to this kiosk owner" });
      }
      kioskData.cafeId = req.user._id;
      kioskData.franchiseId = req.user.franchiseId;
    } else if (req.user.role === "franchise_admin") {
      if (kioskOwner.franchiseId?.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied to this kiosk owner" });
      }
      kioskData.franchiseId = req.user._id;
      // If cafeId is provided, validate it belongs to this franchise
      if (kioskData.cafeId) {
        const cafe = await User.findById(kioskData.cafeId);
        if (!cafe || cafe.franchiseId?.toString() !== req.user._id.toString()) {
          return res.status(403).json({ message: "Invalid cafe selection" });
        }
      }
    }
    
    const kiosk = await Kiosk.create(kioskData);
    await kiosk.populate("kioskOwnerId", "companyName ownerName");
    return res.status(201).json(kiosk);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Update kiosk
exports.updateKiosk = async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id, ...buildHierarchyQuery(req.user) };
    
    const kiosk = await Kiosk.findOne(query);
    if (!kiosk) {
      return res.status(404).json({ message: "Kiosk not found" });
    }
    
    // Prevent changing hierarchy if not super admin
    if (req.user.role !== "super_admin") {
      delete req.body.cafeId;
      delete req.body.franchiseId;
    }
    
    Object.assign(kiosk, req.body);
    await kiosk.save();
    await kiosk.populate("kioskOwnerId", "companyName ownerName");
    return res.json(kiosk);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Delete kiosk
exports.deleteKiosk = async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id, ...buildHierarchyQuery(req.user) };
    
    const kiosk = await Kiosk.findOneAndDelete(query);
    if (!kiosk) {
      return res.status(404).json({ message: "Kiosk not found" });
    }
    return res.json({ message: "Kiosk deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};













