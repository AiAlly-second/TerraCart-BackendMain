/**
 * Code Generator Utility
 * 
 * Generates unique IDs for Franchises and Carts
 * Format: {SHORTCUT}{SEQUENCE_NUMBER}
 * Example: MAH001, ABC042, XYZ003
 */

const User = require('../models/userModel');

/**
 * Generate a 3-letter shortcut from a name
 * - Removes special characters
 * - Takes first 3 uppercase letters
 * - Pads with 'X' if too short
 * 
 * @param {string} name - The name to generate shortcut from
 * @returns {string} - 3-letter uppercase shortcut
 * 
 * Examples:
 *   "Mahindra Industries" -> "MAH"
 *   "ABC Company" -> "ABC"
 *   "TechCorp Solutions" -> "TEC"
 *   "AB" -> "ABX"
 *   "A" -> "AXX"
 */
const generateShortcut = (name) => {
  if (!name) return 'XXX';
  
  // Remove special characters and get only letters/numbers
  let shortcut = name
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 3)
    .toUpperCase();
  
  // If name is too short, pad with 'X'
  while (shortcut.length < 3) {
    shortcut += 'X';
  }
  
  return shortcut;
};

/**
 * Format sequence number with leading zeros
 * @param {number} num - The sequence number
 * @param {number} digits - Number of digits (default 3)
 * @returns {string} - Zero-padded number string
 * 
 * Examples:
 *   formatSequence(1) -> "001"
 *   formatSequence(42) -> "042"
 *   formatSequence(100) -> "100"
 */
const formatSequence = (num, digits = 3) => {
  return String(num).padStart(digits, '0');
};

/**
 * Generate a unique Franchise Code
 * Format: {SHORTCUT}{SEQUENCE}
 * Example: MAH001, ABC002
 * 
 * @param {string} franchiseName - Name of the franchise
 * @param {number} retryCount - Internal retry counter (max 5)
 * @returns {Promise<object>} - { franchiseShortcut, franchiseSequence, franchiseCode }
 */
const generateFranchiseCode = async (franchiseName, retryCount = 0) => {
  if (retryCount > 5) {
    throw new Error('Failed to generate unique franchise code after 5 attempts');
  }
  
  if (!franchiseName || typeof franchiseName !== 'string') {
    throw new Error('Invalid franchise name provided');
  }
  
  const shortcut = generateShortcut(franchiseName);
  // console.log(`[CODE GEN] Generating franchise code for: "${franchiseName}" → shortcut: ${shortcut}`);
  
  // Find the highest sequence number for this shortcut
  const lastFranchise = await User.findOne({
    role: 'franchise_admin',
    franchiseShortcut: shortcut
  })
    .sort({ franchiseSequence: -1 })
    .select('franchiseSequence')
    .lean();
  
  // Start with the next sequence number after the last franchise
  // If retrying, increment by retryCount to skip already-tried sequences
  const sequence = (lastFranchise?.franchiseSequence || 0) + 1 + retryCount;
  const code = `${shortcut}${formatSequence(sequence)}`;
  
  // console.log(`[CODE GEN] Last sequence: ${lastFranchise?.franchiseSequence || 0}, New: ${sequence}, Code: ${code} (retry: ${retryCount})`);
  
  // Verify the code is unique across BOTH franchiseCode AND cartCode (in case of race conditions)
  const existingFranchise = await User.findOne({ franchiseCode: code }).lean();
  const existingCart = await User.findOne({ cartCode: code }).lean();
  if (existingFranchise || existingCart) {
    // console.log(`[CODE GEN] Code ${code} already exists (franchise: ${!!existingFranchise}, cart: ${!!existingCart}), retrying with next sequence... (attempt ${retryCount + 1})`);
    // If code exists, try the next sequence
    return generateFranchiseCode(franchiseName, retryCount + 1);
  }
  
  // console.log(`[CODE GEN] ✅ Successfully generated franchise code: ${code}`);
  
  return {
    franchiseShortcut: shortcut,
    franchiseSequence: sequence,
    franchiseCode: code
  };
};

/**
 * Generate a unique Cart Code for a franchise
 * Format: {FRANCHISE_SHORTCUT}{SEQUENCE}
 * Example: MAH001, MAH002 (all carts under MAH franchise)
 * 
 * @param {string} franchiseId - MongoDB ObjectId of the franchise
 * @param {number} retryCount - Internal retry counter (max 5)
 * @returns {Promise<object>} - { cartSequence, cartCode }
 */
const generateCartCode = async (franchiseId, retryCount = 0) => {
  if (retryCount > 5) {
    throw new Error('Failed to generate unique cart code after 5 attempts');
  }
  
  if (!franchiseId) {
    throw new Error('Franchise ID is required');
  }
  
  // Get the franchise to retrieve its shortcut
  const franchise = await User.findById(franchiseId)
    .select('franchiseShortcut franchiseCode name')
    .lean();
  
  if (!franchise) {
    throw new Error('Franchise not found');
  }
  
  // Use existing shortcut or generate from name
  let shortcut = franchise.franchiseShortcut;
  
  // If franchise doesn't have a shortcut, generate one and save it
  if (!shortcut) {
    shortcut = generateShortcut(franchise.name);
    // console.log(`[CODE GEN] Franchise ${franchiseId} missing shortcut, generating: ${shortcut}`);
    
    // Update the franchise with the shortcut
    await User.findByIdAndUpdate(franchiseId, { 
      franchiseShortcut: shortcut 
    });
  }
  
  // console.log(`[CODE GEN] Generating cart code for franchise: ${franchise.name} (${franchise.franchiseCode || franchiseId})`);
  
  // Find the highest sequence number for carts under this franchise
  const lastCart = await User.findOne({
    role: 'admin',
    franchiseId: franchiseId
  })
    .sort({ cartSequence: -1 })
    .select('cartSequence')
    .lean();
  
  // Start with the next sequence number after the last cart
  // If retrying, increment by retryCount to skip already-tried sequences
  const sequence = (lastCart?.cartSequence || 0) + 1 + retryCount;
  const code = `${shortcut}${formatSequence(sequence)}`;
  
  // console.log(`[CODE GEN] Last cart sequence: ${lastCart?.cartSequence || 0}, New: ${sequence}, Code: ${code} (retry: ${retryCount})`);
  
  // Verify the code is unique across BOTH cartCode AND franchiseCode
  const existingCart = await User.findOne({ cartCode: code }).lean();
  const existingFranchise = await User.findOne({ franchiseCode: code }).lean();
  if (existingCart || existingFranchise) {
    // console.log(`[CODE GEN] Cart code ${code} already exists (cart: ${!!existingCart}, franchise: ${!!existingFranchise}), retrying with next sequence... (attempt ${retryCount + 1})`);
    // If code exists, try the next sequence
    return generateCartCode(franchiseId, retryCount + 1);
  }
  
  // console.log(`[CODE GEN] ✅ Successfully generated cart code: ${code}`);
  
  return {
    cartSequence: sequence,
    cartCode: code
  };
};

/**
 * Generate codes for existing franchises and carts (migration utility)
 * Run this once to assign codes to existing records
 */
const migrateExistingCodes = async () => {
  // console.log('Starting code migration...');
  
  // Step 1: Generate codes for all franchises
  const franchises = await User.find({ 
    role: 'franchise_admin',
    franchiseCode: { $exists: false }
  }).sort({ createdAt: 1 });
  
  // console.log(`Found ${franchises.length} franchises without codes`);
  
  for (const franchise of franchises) {
    const { franchiseShortcut, franchiseSequence, franchiseCode } = await generateFranchiseCode(franchise.name);
    
    await User.findByIdAndUpdate(franchise._id, {
      franchiseShortcut,
      franchiseSequence,
      franchiseCode
    });
    
    // console.log(`  Franchise "${franchise.name}" -> ${franchiseCode}`);
  }
  
  // Step 2: Generate codes for all carts
  const carts = await User.find({
    role: 'admin',
    cartCode: { $exists: false },
    franchiseId: { $exists: true }
  }).sort({ createdAt: 1 });
  
  // console.log(`Found ${carts.length} carts without codes`);
  
  for (const cart of carts) {
    try {
      const { cartSequence, cartCode } = await generateCartCode(cart.franchiseId);
      
      await User.findByIdAndUpdate(cart._id, {
        cartSequence,
        cartCode
      });
      
      // console.log(`  Cart "${cart.cartName || cart.name}" -> ${cartCode}`);
    } catch (error) {
      console.log(`  Error processing cart ${cart._id}: ${error.message}`);
    }
  }
  
  // console.log('Migration complete!');
};

module.exports = {
  generateShortcut,
  formatSequence,
  generateFranchiseCode,
  generateCartCode,
  migrateExistingCodes
};




