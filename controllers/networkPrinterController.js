const net = require("net");
const Order = require("../models/orderModel");

const RETRY_DELAY_MS = 3000;
const MAX_RETRIES = 1;

// Simple in-memory FIFO queue for print jobs (single worker).
const printJobQueue = [];
const activeKotPrintJobs = new Set();
let isPrintWorkerRunning = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;

const createHandledError = (message, statusCode = 500) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const toKotJobKey = (orderId, kotIndex) => {
  if (!orderId || kotIndex === undefined || kotIndex === null) return null;
  return `${String(orderId).trim()}:${Number(kotIndex)}`;
};

const parseKotIndex = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
};

const loadKotLine = async (orderId, kotIndex) => {
  const order = await Order.findById(orderId);
  if (!order) return { error: "Order not found" };

  if (!Array.isArray(order.kotLines) || !order.kotLines[kotIndex]) {
    return { error: "KOT not found for provided kotIndex" };
  }

  return {
    order,
    kotLine: order.kotLines[kotIndex],
  };
};

const markKotQueuedBeforePrint = async ({ orderId, kotIndex }) => {
  const loaded = await loadKotLine(orderId, kotIndex);
  if (loaded.error) {
    return loaded;
  }

  const { order, kotLine } = loaded;
  kotLine.lastPrintStatus = "queued";
  kotLine.lastPrintMessage = "Queued for printing";
  kotLine.lastPrintRequestedAt = new Date();
  order.markModified("kotLines");
  await order.save(); // DB commit before printer call

  return { order, kotLine };
};

const persistKotPrintResult = async ({
  orderId,
  kotIndex,
  success,
  attempts,
  message,
  printerResponse,
}) => {
  const loaded = await loadKotLine(orderId, kotIndex);
  if (loaded.error) {
    console.error(
      `[PRINT] Unable to persist print result for ${orderId}:${kotIndex} - ${loaded.error}`
    );
    return;
  }

  const { order, kotLine } = loaded;
  const safeAttempts =
    Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1;
  const now = new Date();

  kotLine.printAttemptCount = Number(kotLine.printAttemptCount || 0) + safeAttempts;
  kotLine.lastPrintStatus = success ? "success" : "failed";
  kotLine.lastPrintMessage = String(message || "").trim();
  kotLine.lastPrinterResponse = String(printerResponse || "").trim();

  if (success) {
    kotLine.isPrinted = true;
    kotLine.lastPrintedAt = now;
    kotLine.printStatus = "printed";
    kotLine.printedAt = now;
    kotLine.lastPrintError = "";
  } else {
    kotLine.isPrinted = false;
    kotLine.printStatus = "failed";
    kotLine.lastPrintError = String(message || "").trim();
  }

  order.markModified("kotLines");
  await order.save();
};

/**
 * Send raw data to network printer via TCP socket
 */
const sendToPrinter = (printerIP, printerPort, data) => {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    const responseChunks = [];
    let timeout;
    let settled = false;

    const finish = (callback, payload) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callback(payload);
    };

    timeout = setTimeout(() => {
      client.destroy();
      finish(reject, new Error("Connection timeout"));
    }, 5000);

    client.connect(printerPort, printerIP, () => {
      if (timeout) clearTimeout(timeout);
      console.log(`[PRINT] Connected to printer at ${printerIP}:${printerPort}`);

      client.write(data, "binary", (err) => {
        if (err) {
          client.destroy();
          finish(reject, err);
          return;
        }

        // Close connection shortly after write flush.
        setTimeout(() => {
          if (!settled) {
            client.end();
          }
        }, 1000);
      });
    });

    client.on("data", (chunk) => {
      const responseText = chunk?.toString?.() || "";
      console.log("[PRINT] Printer response:", responseText);
      responseChunks.push(Buffer.from(chunk));
    });

    client.on("close", (hadError) => {
      if (hadError || settled) return;

      const printerResponse = responseChunks.length
        ? Buffer.concat(responseChunks).toString("utf8")
        : "";

      finish(resolve, {
        success: true,
        message: "Print job sent successfully",
        printerResponse,
      });
    });

    client.on("error", (err) => {
      console.error("[PRINT] Printer connection error:", err);
      finish(reject, err);
    });
  });
};

const executeWithRetry = async ({ printerIP, printerPort, data }) => {
  let attempt = 0;
  let lastError = null;

  while (attempt <= MAX_RETRIES) {
    attempt += 1;
    try {
      const result = await sendToPrinter(printerIP, printerPort, data);
      return {
        ...result,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt <= MAX_RETRIES) {
        console.warn(
          `[PRINT] Attempt ${attempt} failed for ${printerIP}:${printerPort}. Retrying in ${RETRY_DELAY_MS}ms`
        );
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  const wrapped = new Error(lastError?.message || "Failed to send print job");
  wrapped.attempts = attempt;
  throw wrapped;
};

const runPrintJob = async (job) => {
  const {
    orderId,
    kotIndex,
    printerIP,
    printerPort,
    data,
    jobKey,
  } = job;

  try {
    const result = await executeWithRetry({ printerIP, printerPort, data });

    if (orderId && kotIndex !== null) {
      await persistKotPrintResult({
        orderId,
        kotIndex,
        success: true,
        attempts: result.attempts,
        message: result.message,
        printerResponse: result.printerResponse,
      });
    }

    return {
      success: true,
      message: "KOT printed successfully",
      attempts: result.attempts,
      printerResponse: result.printerResponse || "",
      printer: `${printerIP}:${printerPort}`,
      orderId,
      kotIndex,
      queueSize: printJobQueue.length,
      jobKey,
    };
  } catch (error) {
    const attempts =
      Number.isFinite(error?.attempts) && error.attempts > 0
        ? error.attempts
        : MAX_RETRIES + 1;

    if (orderId && kotIndex !== null) {
      await persistKotPrintResult({
        orderId,
        kotIndex,
        success: false,
        attempts,
        message: error.message || "Failed to print KOT",
        printerResponse: error.message || "",
      });
    }

    throw Object.assign(new Error(error.message || "Failed to print KOT"), {
      attempts,
    });
  }
};

const processPrintQueue = async () => {
  if (isPrintWorkerRunning) return;
  isPrintWorkerRunning = true;

  while (printJobQueue.length > 0) {
    const job = printJobQueue.shift();
    if (!job) continue;

    try {
      const result = await runPrintJob(job);
      job.resolve(result);
    } catch (error) {
      job.reject(error);
    } finally {
      if (job.jobKey) {
        activeKotPrintJobs.delete(job.jobKey);
      }
    }
  }

  isPrintWorkerRunning = false;
};

const enqueuePrintJob = (job) =>
  new Promise((resolve, reject) => {
    printJobQueue.push({ ...job, resolve, reject });
    processPrintQueue().catch((error) => {
      console.error("[PRINT] Queue processor error:", error);
    });
  });

const triggerKotPrintJob = async ({
  orderId,
  kotIndex,
  printerIP,
  printerPort,
  data,
}) => {
  let jobKey = null;
  const parsedKotIndex = parseKotIndex(kotIndex);
  const parsedPort = Number(printerPort);

  if (!printerIP || !printerPort || !data) {
    throw createHandledError(
      "Missing required fields: printerIP, printerPort, data",
      400
    );
  }

  if (!orderId || parsedKotIndex === null) {
    throw createHandledError(
      "orderId and valid kotIndex are required for KOT print tracking",
      400
    );
  }

  if (!ipRegex.test(String(printerIP))) {
    throw createHandledError("Invalid IP address format", 400);
  }

  if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw createHandledError("Invalid port number", 400);
  }

  const loaded = await loadKotLine(orderId, parsedKotIndex);
  if (loaded.error) {
    throw createHandledError(loaded.error, 404);
  }

  const { kotLine } = loaded;
  if (kotLine.isPrinted === true) {
    return {
      success: true,
      skipped: true,
      message: "KOT already printed. Duplicate print skipped.",
      orderId,
      kotIndex: parsedKotIndex,
      printer: `${printerIP}:${parsedPort}`,
    };
  }

  jobKey = toKotJobKey(orderId, parsedKotIndex);
  if (jobKey && activeKotPrintJobs.has(jobKey)) {
    return {
      success: true,
      queued: true,
      skipped: true,
      message: "Print already queued/in progress for this KOT",
      orderId,
      kotIndex: parsedKotIndex,
      queueSize: printJobQueue.length,
    };
  }

  if (jobKey) {
    activeKotPrintJobs.add(jobKey);
  }

  const queueMarked = await markKotQueuedBeforePrint({
    orderId,
    kotIndex: parsedKotIndex,
  });
  if (queueMarked.error) {
    if (jobKey) activeKotPrintJobs.delete(jobKey);
    throw createHandledError(queueMarked.error, 404);
  }

  console.log(
    `[PRINT] Queued KOT print for ${orderId}:${parsedKotIndex} -> ${printerIP}:${parsedPort}`
  );

  return enqueuePrintJob({
    orderId,
    kotIndex: parsedKotIndex,
    printerIP,
    printerPort: parsedPort,
    data,
    jobKey,
  });
};

/**
 * Print KOT to network printer
 */
exports.printKOT = async (req, res) => {
  try {
    const { printerIP, printerPort, data, orderId } = req.body;
    const result = await triggerKotPrintJob({
      orderId,
      kotIndex: req.body?.kotIndex,
      printerIP,
      printerPort,
      data,
    });

    const statusCode = result?.queued ? 202 : 200;
    return res.status(statusCode).json(result);
  } catch (error) {
    console.error("[PRINT] Print error:", error);
    const statusCode =
      Number.isFinite(error?.statusCode) && error.statusCode >= 400
        ? error.statusCode
        : 500;
    return res.status(statusCode).json({
      success: false,
      message: "Failed to print KOT",
      error: error.message,
      attempts:
        Number.isFinite(error?.attempts) && error.attempts > 0
          ? error.attempts
          : undefined,
    });
  }
};

exports.triggerKotPrintJob = triggerKotPrintJob;

/**
 * Test printer connection
 */
exports.testPrinter = async (req, res) => {
  try {
    const { printerIP, printerPort } = req.body;
    const parsedPort = Number(printerPort);

    if (!printerIP || !printerPort) {
      return res.status(400).json({
        message: "Missing printerIP or printerPort",
      });
    }

    if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      return res.status(400).json({
        message: "Invalid port number",
      });
    }

    // Send test print
    const testData =
      "\x1B@" + // Initialize
      "\x1Ba\x01" + // Center align
      "\x1B!\x30" + // Double size
      "TEST PRINT\n" +
      "\x1B!\x00" + // Normal
      "\n" +
      "Terra Cart Printer\n" +
      "Connection Successful!\n" +
      "\n\n\n" +
      "\x1DV\x00"; // Cut paper

    const result = await sendToPrinter(printerIP, parsedPort, testData);

    return res.json({
      success: true,
      message: "Test print sent successfully",
      printer: `${printerIP}:${parsedPort}`,
      ...result,
    });
  } catch (error) {
    console.error("[PRINT] Test print error:", error);
    return res.status(500).json({
      success: false,
      message: "Printer test failed",
      error: error.message,
    });
  }
};
