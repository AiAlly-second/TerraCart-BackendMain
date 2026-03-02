const express = require('express');

const {
  getTaskTemplates,
  createTaskTemplate,
  updateTaskTemplate,
  deleteTaskTemplate,
  triggerDailyTaskGeneration,
  getDailyTasks,
  createManualDailyTask,
  completeDailyTask,
  getManagerOverview,
} = require('../controllers/dailyTaskController');
const { protect, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

router.get(
  '/templates',
  authorize(['waiter', 'cook', 'captain', 'manager', 'admin', 'franchise_admin', 'super_admin']),
  getTaskTemplates
);
router.post(
  '/templates',
  authorize(['manager', 'admin', 'franchise_admin', 'super_admin']),
  createTaskTemplate
);
router.put(
  '/templates/:id',
  authorize(['manager', 'admin', 'franchise_admin', 'super_admin']),
  updateTaskTemplate
);
router.delete(
  '/templates/:id',
  authorize(['manager', 'admin', 'franchise_admin', 'super_admin']),
  deleteTaskTemplate
);

router.post(
  '/generate',
  authorize(['manager', 'admin', 'franchise_admin', 'super_admin']),
  triggerDailyTaskGeneration
);

router.get(
  '/overview',
  authorize(['manager', 'admin', 'franchise_admin', 'super_admin']),
  getManagerOverview
);

router.get(
  '/',
  authorize(['waiter', 'cook', 'captain', 'manager', 'admin', 'franchise_admin', 'super_admin']),
  getDailyTasks
);
router.post(
  '/assign',
  authorize(['manager', 'admin', 'franchise_admin', 'super_admin']),
  createManualDailyTask
);
router.patch(
  '/:id/complete',
  authorize(['waiter', 'cook', 'captain', 'manager', 'admin', 'franchise_admin', 'super_admin']),
  completeDailyTask
);

module.exports = router;
