/**
 * Test script to verify customer request resolve endpoint
 * Run with: node tests/test_resolve_request.js
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:5001/api';

async function testResolveRequest() {
    console.log('=== Testing Customer Request Resolve Endpoint ===\n');
    
    try {
        // First, get pending requests to find a valid ID
        console.log('1. Fetching pending requests...');
        const pendingResponse = await axios.get(`${BASE_URL}/customer-requests/pending`, {
            headers: {
                'Authorization': 'Bearer YOUR_TOKEN_HERE' // You'll need to replace this
            }
        });
        
        console.log(`Found ${pendingResponse.data.length} pending requests`);
        
        if (pendingResponse.data.length === 0) {
            console.log('❌ No pending requests to test with');
            return;
        }
        
        const testRequest = pendingResponse.data[0];
        console.log(`\n2. Testing with request ID: ${testRequest._id}`);
        console.log(`   Table: ${testRequest.tableId?.number || testRequest.tableNumber}`);
        console.log(`   Type: ${testRequest.requestType}`);
        
        // Try to resolve it
        console.log('\n3. Attempting to resolve request...');
        const resolveResponse = await axios.post(
            `${BASE_URL}/customer-requests/${testRequest._id}/resolve`,
            {},
            {
                headers: {
                    'Authorization': 'Bearer YOUR_TOKEN_HERE' // You'll need to replace this
                }
            }
        );
        
        console.log('✅ Request resolved successfully!');
        console.log('Response:', resolveResponse.data);
        
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        console.error('Status:', error.response?.status);
    }
}

// Run the test
testResolveRequest();
