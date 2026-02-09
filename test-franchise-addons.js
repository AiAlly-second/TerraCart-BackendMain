require("dotenv").config();


const API_URL = process.env.NODE_API_URL || "http://localhost:5001";

async function testFranchiseAddons() {
  try {
    // The cart being accessed
    const cartId = "696ddefc0ce4e226390e21c2";
    
    console.log(`🧪 Testing franchise add-on sharing...`);
    console.log(`Cart ID: ${cartId}\n`);
    
    const url = `${API_URL}/api/addons/public?cartId=${cartId}`;
    console.log(`Fetching: ${url}\n`);
    
    const response = await fetch(url);
    const data = await response.json();
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📊 API RESPONSE`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    console.log(`Status: ${response.status}`);
    console.log(`Success: ${data.success}`);
    console.log(`Add-ons found: ${data.data ? data.data.length : 0}\n`);
    
    if (data.data && data.data.length > 0) {
      console.log(`✅ SUCCESS! Add-ons are now visible:\n`);
      data.data.forEach((addon, i) => {
        console.log(`  ${i + 1}. ${addon.name} - ₹${addon.price}`);
      });
      console.log(`\n🎉 Franchise-level add-on sharing is working!`);
    } else {
      console.log(`❌ No add-ons returned. Check backend logs for details.`);
    }
    
  } catch (err) {
    console.error("Error:", err.message);
  }
}

testFranchiseAddons();
