const net = require('net');

/**
 * Send raw data to network printer via TCP socket
 */
const sendToPrinter = (printerIP, printerPort, data) => {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let timeout;

    // Set connection timeout
    timeout = setTimeout(() => {
      client.destroy();
      reject(new Error('Connection timeout'));
    }, 5000);

    client.connect(printerPort, printerIP, () => {
      clearTimeout(timeout);
      console.log(`Connected to printer at ${printerIP}:${printerPort}`);
      
      // Send data to printer
      client.write(data, 'binary', (err) => {
        if (err) {
          client.destroy();
          reject(err);
        }
      });
    });

    client.on('data', (data) => {
      console.log('Printer response:', data.toString());
    });

    client.on('close', () => {
      clearTimeout(timeout);
      console.log('Connection closed');
      resolve({ success: true, message: 'Print job sent successfully' });
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      console.error('Printer connection error:', err);
      reject(err);
    });

    // Close connection after sending
    setTimeout(() => {
      client.end();
    }, 1000);
  });
};

/**
 * Print KOT to network printer
 */
exports.printKOT = async (req, res) => {
  try {
    const { printerIP, printerPort, data, orderId, kotIndex } = req.body;

    // Validate inputs
    if (!printerIP || !printerPort || !data) {
      return res.status(400).json({
        message: 'Missing required fields: printerIP, printerPort, data'
      });
    }

    // Validate IP address format
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(printerIP)) {
      return res.status(400).json({
        message: 'Invalid IP address format'
      });
    }

    // Validate port
    if (printerPort < 1 || printerPort > 65535) {
      return res.status(400).json({
        message: 'Invalid port number'
      });
    }

    console.log(`📡 Printing KOT to ${printerIP}:${printerPort}`);
    console.log(`Order ID: ${orderId}, KOT Index: ${kotIndex}`);

    // Send to printer
    const result = await sendToPrinter(printerIP, printerPort, data);

    return res.json({
      success: true,
      message: 'KOT printed successfully',
      printer: `${printerIP}:${printerPort}`,
      orderId,
      kotIndex,
      ...result
    });

  } catch (error) {
    console.error('Print error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to print KOT',
      error: error.message
    });
  }
};

/**
 * Test printer connection
 */
exports.testPrinter = async (req, res) => {
  try {
    const { printerIP, printerPort } = req.body;

    if (!printerIP || !printerPort) {
      return res.status(400).json({
        message: 'Missing printerIP or printerPort'
      });
    }

    // Send test print
    const testData = '\x1B@' + // Initialize
                     '\x1Ba\x01' + // Center align
                     '\x1B!\x30' + // Double size
                     'TEST PRINT\n' +
                     '\x1B!\x00' + // Normal
                     '\n' +
                     'Terra Cart Printer\n' +
                     'Connection Successful!\n' +
                     '\n\n\n' +
                     '\x1DV\x00'; // Cut paper

    const result = await sendToPrinter(printerIP, printerPort, testData);

    return res.json({
      success: true,
      message: 'Test print sent successfully',
      printer: `${printerIP}:${printerPort}`,
      ...result
    });

  } catch (error) {
    console.error('Test print error:', error);
    return res.status(500).json({
      success: false,
      message: 'Printer test failed',
      error: error.message
    });
  }
};
