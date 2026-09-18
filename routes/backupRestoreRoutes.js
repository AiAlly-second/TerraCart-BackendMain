const express = require("express");
const { protect, authorize } = require("../middleware/authMiddleware");
const controller = require("../controllers/backupRestoreController");

const router = express.Router();

router.use(protect, authorize(["super_admin"]));

router.post("/backups/manual", controller.createManualBackup);
router.get("/backups", controller.listBackups);
router.get("/backups/:backupId", controller.getBackupById);
router.get("/backups/:backupId/status", controller.getBackupStatus);
router.get("/backups/:backupId/download", controller.downloadBackup);
router.delete("/backups/:backupId", controller.deleteBackup);

router.post("/jobs", controller.createBackupJob);
router.get("/jobs", controller.listBackupJobs);
router.get("/jobs/scheduler/status", controller.getSchedulerStatus);
router.get("/jobs/:jobId", controller.getBackupJobById);
router.patch("/jobs/:jobId", controller.updateBackupJob);
router.delete("/jobs/:jobId", controller.deleteBackupJob);
router.post("/jobs/:jobId/run-now", controller.runBackupJobNow);

router.post("/restores/preview", controller.previewRestore);
router.post("/restores/execute", controller.executeRestore);
router.get("/restores/:restoreId/status", controller.getRestoreStatus);

router.get("/audit-logs", controller.listAuditLogs);

module.exports = router;
